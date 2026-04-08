import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { TasksFileSchema, TaskPrioritySchema, FullTaskStatusSchema, SubtaskStatusSchema } from "./tasks-json-types.js";
import type { TasksFile, FullTask, FullSubtask } from "./tasks-json-types.js";

/**
 * In-process mutex for tasks.json write operations (C3).
 * Serialises all mutating calls so that concurrent API requests
 * cannot clobber each other's changes.
 */
let mutexTail = Promise.resolve();

export async function withTasksMutex<T>(fn: () => T | Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = mutexTail;
  mutexTail = new Promise<void>((r) => { release = r; });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

type TaskPriority = z.infer<typeof TaskPrioritySchema>;
type TaskStatus = z.infer<typeof FullTaskStatusSchema>;

export function getTasksPath(cwd: string): string {
  return join(cwd, ".taskmaster", "tasks", "tasks.json");
}

/**
 * Detect tasks.json format: standard ({ tasks, metadata }) or multi-tag
 * ({ "master": { tasks, metadata }, ... }). Returns the tag-scoped data
 * validated by zod plus the tag name (null for standard format).
 */
// Valid status sets for pre-validation (typed as Set<string> to allow .has() with arbitrary strings)
const VALID_TASK_STATUSES: Set<string> = new Set(FullTaskStatusSchema.options);
const VALID_SUBTASK_STATUSES: Set<string> = new Set(SubtaskStatusSchema.options);

/**
 * Pre-validate task/subtask statuses before Zod parsing.
 * Throws a human-readable error pointing at the exact task/subtask with an invalid status,
 * rather than letting Zod produce a cryptic "invalid_value" error.
 */
function validateStatuses(tasks: unknown[]): void {
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const t = task as Record<string, unknown>;
    const taskLabel = `task ${t.id ?? "?"}`;

    if (typeof t.status === "string" && !VALID_TASK_STATUSES.has(t.status)) {
      throw new Error(
        `tasks.json: ${taskLabel} has invalid status "${t.status}". ` +
        `Valid task statuses: ${[...VALID_TASK_STATUSES].join(", ")}. ` +
        `This is likely caused by the agent editing .taskmaster/tasks/tasks.json directly — ` +
        `fix the status manually or restore the file from a previous commit.`,
      );
    }

    if (Array.isArray(t.subtasks)) {
      for (const sub of t.subtasks) {
        if (typeof sub !== "object" || sub === null) continue;
        const s = sub as Record<string, unknown>;
        if (typeof s.status === "string" && !VALID_SUBTASK_STATUSES.has(s.status)) {
          throw new Error(
            `tasks.json: subtask ${t.id ?? "?"}.${s.id ?? "?"} has invalid status "${s.status}". ` +
            `Valid subtask statuses: ${[...VALID_SUBTASK_STATUSES].join(", ")}. ` +
            `This is likely caused by the agent editing .taskmaster/tasks/tasks.json directly — ` +
            `fix the status manually or restore the file from a previous commit.`,
          );
        }
      }
    }
  }
}

/**
 * Recursively convert JSON null values to undefined so that Zod `.optional()`
 * fields accept them.  TaskMaster commonly writes `"field": null` for empty
 * optional fields — JSON.parse preserves null but Zod `.optional()` only
 * accepts `string | undefined`, not `null`.
 */
export function nullsToUndefined(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(nullsToUndefined);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = nullsToUndefined(v);
    }
    return out;
  }
  return value;
}

function resolveTasksData(parsed: unknown): { tagData: TasksFile; tag: string | null } {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("tasks.json: expected a JSON object");
  }
  const obj = nullsToUndefined(parsed) as Record<string, unknown>;

  // Standard format: top-level "tasks" array
  if (Array.isArray(obj.tasks)) {
    validateStatuses(obj.tasks);
    return { tagData: TasksFileSchema.parse(obj), tag: null };
  }

  // Multi-tag format: keys are tag names, values are { tasks, metadata }
  const tagNames = Object.keys(obj).filter((k) => {
    const v = obj[k];
    return v != null && typeof v === "object" && Array.isArray((v as Record<string, unknown>).tasks);
  });

  if (tagNames.length === 0) {
    throw new Error(
      "tasks.json: unexpected format — expected { tasks, metadata } or multi-tag format " +
      "(e.g. { \"master\": { tasks: [...], metadata: {...} } })",
    );
  }

  // Use the first (or only) tag
  const tag = tagNames[0];
  const tagObj = obj[tag] as Record<string, unknown>;
  if (Array.isArray(tagObj.tasks)) {
    validateStatuses(tagObj.tasks);
  }
  return { tagData: TasksFileSchema.parse(tagObj), tag };
}

export function readTasksFile(cwd: string): TasksFile {
  const raw = readFileSync(getTasksPath(cwd), "utf-8");
  return resolveTasksData(JSON.parse(raw)).tagData;
}

/** Atomic write: tmp file + renameSync. Cleans up tmp on failure. */
function atomicWrite(filePath: string, content: string): void {
  const tmpPath = join(
    dirname(filePath),
    `.tasks.json.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmpPath, content, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

export function writeTasksFile(cwd: string, data: TasksFile): void {
  atomicWrite(getTasksPath(cwd), JSON.stringify(data, null, 2) + "\n");
}

/**
 * Replace subtasks on a specific top-level task with expand result data.
 *
 * Only writes the prescribed fields (id, title, description, details,
 * dependencies, testStrategy?, status: "pending") — no parentId, priority,
 * or other auto-populated fields.
 *
 * Dependencies are kept as numeric local subtask IDs (1..N) matching the
 * expand result schema.
 *
 * Preserves multi-tag wrapper and all other tasks/subtasks unchanged.
 * Uses mutateTasksFile internally for atomic read-modify-write.
 */
/**
 * Fields written per subtask by writeExpandSubtasks.
 * Tied to FullSubtask via Pick so the compiler catches field type drift.
 */
type ExpandSubtaskWrite = Pick<
  FullSubtask,
  "id" | "title" | "description" | "details" | "dependencies" | "status" | "testStrategy"
>;

export function writeExpandSubtasks(
  cwd: string,
  taskId: string,
  subtasks: ReadonlyArray<{
    id: number;
    title: string;
    description: string;
    details: string;
    dependencies: number[];
    testStrategy?: string;
  }>,
): void {
  mutateTasksFile(cwd, (data) => {
    const task = findTask(data, taskId);
    task.subtasks = subtasks.map((s): ExpandSubtaskWrite => ({
      id: s.id,
      title: s.title,
      description: s.description,
      details: s.details,
      dependencies: s.dependencies,
      status: "pending" as const,
      ...(s.testStrategy != null ? { testStrategy: s.testStrategy } : {}),
    })) as FullSubtask[];
  });
}

/**
 * Fields written by writeComplexityFields.
 * Tied to FullTask via Pick so the compiler catches field type drift.
 */
type ComplexityFieldsWrite = Pick<
  FullTask,
  "complexity" | "recommendedSubtasks" | "expansionPrompt" | "complexityReasoning"
>;

/**
 * Write complexity analysis fields to a task.
 * Uses mutateTasksFile() internally for atomic multi-tag-safe read-modify-write.
 * Should be called inside withTasksMutex() by the batch pipeline worker.
 */
export function writeComplexityFields(
  cwd: string,
  taskId: string,
  result: {
    complexityScore: number;
    recommendedSubtasks: number;
    expansionPrompt: string;
    reasoning: string;
  },
): void {
  mutateTasksFile(cwd, (data) => {
    const task = findTask(data, taskId);
    const fields: ComplexityFieldsWrite = {
      complexity: result.complexityScore,
      recommendedSubtasks: result.recommendedSubtasks,
      expansionPrompt: result.expansionPrompt,
      complexityReasoning: result.reasoning,
    };
    Object.assign(task, fields);
  });
}

/** Parse "3" -> { taskId: "3" } or "3.2" -> { taskId: "3", subtaskId: "2" }. */
function parseUnitId(unitId: string): { taskId: string; subtaskId?: string } {
  if (!unitId || unitId.trim() === "") {
    throw new Error(`Invalid unitId: empty string`);
  }
  const parts = unitId.split(".");
  if (parts.length === 1) return { taskId: parts[0] };
  if (parts.length === 2) return { taskId: parts[0], subtaskId: parts[1] };
  throw new Error(
    `Invalid unitId format: "${unitId}" (expected "N" or "N.M")`,
  );
}

export class TaskNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotFoundError";
  }
}

function findTask(data: TasksFile, taskId: string): FullTask {
  const task = data.tasks.find((t) => String(t.id) === taskId);
  if (!task) throw new TaskNotFoundError(`Task ${taskId} not found in tasks.json`);
  return task;
}

function findSubtask(task: FullTask, subtaskId: string): FullSubtask {
  const sub = task.subtasks.find((s) => String(s.id) === subtaskId);
  if (!sub)
    throw new TaskNotFoundError(
      `Subtask ${task.id}.${subtaskId} not found in tasks.json`,
    );
  return sub;
}

/** Look up a task by ID. Throws TaskNotFoundError if not found. */
export function showTaskById(id: string, cwd: string): FullTask {
  const data = readTasksFile(cwd);
  return findTask(data, id);
}

/** Final statuses for tasks — only "closed" is terminal for tasks. */
export const TASK_FINAL_STATUSES = new Set(["closed"]);

/** Final statuses for subtasks — "done" is terminal for subtasks. */
export const SUBTASK_FINAL_STATUSES = new Set(["done"]);

// --- Allowed transition maps ---

const ALLOWED_TASK_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["in-progress"]),
  "in-progress": new Set(["done", "blocked", "pending", "in-progress"]),  // pending for retry, self-transition for resume
  done: new Set(["review", "closed", "done"]),  // self-transition: outer loop may re-set after reverse cascade
  review: new Set(["rework", "blocked", "review"]),  // self-transition for resume
  rework: new Set(["closed", "blocked", "rework", "review"]),  // self-transition for resume; review for iterative review rounds
  blocked: new Set(["pending"]),  // manual unblock via UI or tasks.json edit
  closed: new Set([]),  // terminal
};

const ALLOWED_SUBTASK_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["in-progress"]),
  "in-progress": new Set(["done", "blocked", "pending", "in-progress"]),  // pending for retry, self-transition for resume
  done: new Set([]),  // terminal
  blocked: new Set(["pending"]),  // manual unblock
};

export interface SetStatusOptions {
  reviewEnabled?: boolean; // for reverse cascade: done → closed when false
}

/**
 * Set status for a task or subtask with cascade logic and transition validation:
 * - Forward cascade: setting task to "closed" → all non-final subtasks become "done"
 * - Reverse cascade: setting subtask to "done" → if all siblings are final →
 *   parent becomes "done" (review enabled) or "closed" (--no-review)
 * - Blocked cascade: setting subtask to "blocked" → parent also becomes "blocked"
 *
 * Cascades bypass ALLOWED_*_TRANSITIONS validation — they are internal state
 * changes forced by the cascade, not user-initiated transitions.
 */
export function setStatusDirect(id: string, status: TaskStatus, cwd: string, opts?: SetStatusOptions): void {
  const { taskId, subtaskId } = parseUnitId(id);

  mutateTasksFile(cwd, (data) => {
    const task = findTask(data, taskId);

    if (subtaskId) {
      const subtask = findSubtask(task, subtaskId);

      // Idempotent: if already at target status, skip (agent may have changed tasks.json directly)
      if (subtask.status === status) return;

      // Validate subtask transition
      const allowed = ALLOWED_SUBTASK_TRANSITIONS[subtask.status];
      if (allowed && !allowed.has(status)) {
        throw new Error(`Invalid subtask transition: ${subtask.status} → ${status}`);
      }
      // Safe cast: ALLOWED_SUBTASK_TRANSITIONS rejects any status not in SubtaskStatus
      subtask.status = status as typeof subtask.status;

      // Reverse cascade: subtask blocked → parent blocked (bypasses task transition validation)
      if (status === "blocked") {
        task.status = "blocked";
      }

      // Reverse cascade: if subtask set to done, check if all siblings are done
      if (status === "done") {
        const allDone = task.subtasks.every((s) => SUBTASK_FINAL_STATUSES.has(s.status));
        if (allDone && !TASK_FINAL_STATUSES.has(task.status)) {
          if (opts?.reviewEnabled === false) {
            task.status = "closed"; // --no-review: skip review pipeline
          } else {
            task.status = "done";
          }
        }
      }
    } else {
      // Idempotent: if already at target status, skip (agent may have changed tasks.json directly)
      if (task.status === status) return;

      // Validate task transition
      const allowed = ALLOWED_TASK_TRANSITIONS[task.status];
      if (allowed && !allowed.has(status)) {
        throw new Error(`Invalid task transition: ${task.status} → ${status}`);
      }
      task.status = status;

      // Forward cascade: if task set to closed, cascade subtasks to done
      if (status === "closed") {
        for (const st of task.subtasks) {
          if (!SUBTASK_FINAL_STATUSES.has(st.status)) {
            st.status = "done";
          }
        }
      }
    }
  });
}

function getRunAttempts(entity: {
  metadata?: Record<string, unknown>;
}): number {
  const val = entity.metadata?.runAttempts;
  return typeof val === "number" && Number.isFinite(val) && val >= 0 ? val : 0;
}

/**
 * Read-modify-write cycle preserving multi-tag format (C7).
 * The mutate callback receives the active tag's TasksFile to modify in-place.
 */
function mutateTasksFile(cwd: string, mutate: (data: TasksFile) => void): TasksFile {
  const filePath = getTasksPath(cwd);
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const { tagData, tag } = resolveTasksData(parsed);
  mutate(tagData);
  const toWrite = tag !== null ? { ...parsed, [tag]: tagData } : tagData;
  atomicWrite(filePath, JSON.stringify(toWrite, null, 2) + "\n");
  return tagData;
}

/** Update specific fields on a task. Returns updated tasks file. */
export function updateTask(
  cwd: string,
  taskId: string,
  updates: Partial<Pick<FullTask, "title" | "description" | "status" | "details" | "testStrategy" | "priority" | "dependencies" | "metadata">>,
): TasksFile {
  return mutateTasksFile(cwd, (data) => {
    const task = findTask(data, taskId);
    const normalized = updates.dependencies
      ? { ...updates, dependencies: updates.dependencies.map(String) }
      : updates;
    Object.assign(task, normalized);
  });
}

/** Create a new task. Returns the created task. */
export function createTask(
  cwd: string,
  taskData: { title: string; description?: string; details?: string; testStrategy?: string; priority?: TaskPriority; dependencies?: (string | number)[] },
): FullTask {
  let created!: FullTask;
  mutateTasksFile(cwd, (data) => {
    const maxId = data.tasks.reduce((max, t) => {
      const n = typeof t.id === "number" ? t.id : parseInt(String(t.id), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 0);
    const newTask = {
      id: maxId + 1,
      title: taskData.title,
      description: taskData.description ?? "",
      status: "pending" as const,
      dependencies: (taskData.dependencies ?? []).map(String),
      details: taskData.details ?? "",
      testStrategy: taskData.testStrategy ?? "",
      priority: taskData.priority,
      subtasks: [],
    } as FullTask;
    data.tasks.push(newTask);
    if (data.metadata.taskCount != null) data.metadata.taskCount = data.tasks.length;
    created = newTask;
  });
  return created;
}

/** Delete a task by ID. */
export function deleteTask(cwd: string, taskId: string): void {
  mutateTasksFile(cwd, (data) => {
    const idx = data.tasks.findIndex((t) => String(t.id) === taskId);
    if (idx === -1) throw new TaskNotFoundError(`Task ${taskId} not found`);
    data.tasks.splice(idx, 1);
    if (data.metadata.taskCount != null) data.metadata.taskCount = data.tasks.length;
  });
}

/** Update specific fields on a subtask. Returns updated tasks file. */
export function updateSubtask(
  cwd: string,
  taskId: string,
  subtaskId: string,
  updates: Partial<Pick<FullSubtask, "title" | "description" | "status" | "details" | "testStrategy" | "priority" | "dependencies" | "metadata">>,
): TasksFile {
  return mutateTasksFile(cwd, (data) => {
    const task = findTask(data, taskId);
    const subtask = findSubtask(task, subtaskId);
    const normalized = updates.dependencies
      ? { ...updates, dependencies: updates.dependencies.map(String) }
      : updates;
    Object.assign(subtask, normalized);
  });
}

/** Delete a subtask by ID. */
export function deleteSubtask(cwd: string, taskId: string, subtaskId: string): void {
  mutateTasksFile(cwd, (data) => {
    const task = findTask(data, taskId);
    const idx = task.subtasks.findIndex((s) => String(s.id) === subtaskId);
    if (idx === -1) throw new TaskNotFoundError(`Subtask ${taskId}.${subtaskId} not found`);
    task.subtasks.splice(idx, 1);
  });
}

export function getAttemptCount(cwd: string, unitId: string): number {
  const data = readTasksFile(cwd);
  const { taskId, subtaskId } = parseUnitId(unitId);
  const task = findTask(data, taskId);
  if (subtaskId) {
    return getRunAttempts(findSubtask(task, subtaskId));
  }
  return getRunAttempts(task);
}

/**
 * Increment the persistent attempt counter for a task or subtask.
 *
 * Handles both standard and multi-tag tasks.json formats. For multi-tag,
 * only the active tag's data is modified; other tags are preserved.
 *
 * The read-modify-write cycle is synchronous. prorab is the only writer of
 * `metadata.runAttempts`; prorab writes both `status` and metadata.
 * Concurrent prorab instances in the same directory are not supported
 * (enforced by lock file in the run command).
 */
export function incrementAttemptCount(
  cwd: string,
  unitId: string,
): number {
  const filePath = getTasksPath(cwd);
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const { tagData, tag } = resolveTasksData(parsed);

  const { taskId, subtaskId } = parseUnitId(unitId);
  const task = findTask(tagData, taskId);

  let entity: { metadata?: Record<string, unknown> };
  if (subtaskId) {
    entity = findSubtask(task, subtaskId);
  } else {
    entity = task;
  }

  if (!entity.metadata) {
    entity.metadata = {};
  }
  const current = getRunAttempts(entity);
  const next = current + 1;
  entity.metadata.runAttempts = next;

  // Write back: for multi-tag, replace only the active tag; for standard, write tagData directly
  const toWrite = tag !== null ? { ...parsed, [tag]: tagData } : tagData;
  atomicWrite(filePath, JSON.stringify(toWrite, null, 2) + "\n");
  return next;
}

// --- Metadata & revision tracking ---

/**
 * Merge key-value pairs into the metadata of a task or subtask.
 * Creates the metadata object if it does not exist.
 */
export function setMetadata(cwd: string, unitId: string, values: Record<string, unknown>): void {
  const { taskId, subtaskId } = parseUnitId(unitId);
  mutateTasksFile(cwd, (data) => {
    const task = findTask(data, taskId);
    let entity: { metadata?: Record<string, unknown> };
    if (subtaskId) {
      entity = findSubtask(task, subtaskId);
    } else {
      entity = task;
    }
    if (!entity.metadata) entity.metadata = {};
    Object.assign(entity.metadata, values);
  });
}

export interface Revisions {
  startRev: string;
  endRev: string;
}

/**
 * Store startRev and endRev in entity metadata.
 * Preserves any other metadata keys already present.
 */
export function setRevisions(cwd: string, unitId: string, startRev: string, endRev: string): void {
  setMetadata(cwd, unitId, { startRev, endRev });
}

/**
 * Read startRev/endRev from entity metadata.
 * Returns null if either value is missing or not a string.
 */
export function getRevisions(cwd: string, unitId: string): Revisions | null {
  const data = readTasksFile(cwd);
  const { taskId, subtaskId } = parseUnitId(unitId);
  const task = findTask(data, taskId);
  let entity: { metadata?: Record<string, unknown> };
  if (subtaskId) {
    entity = findSubtask(task, subtaskId);
  } else {
    entity = task;
  }
  const start = entity.metadata?.startRev;
  const end = entity.metadata?.endRev;
  if (typeof start === "string" && typeof end === "string") {
    return { startRev: start, endRev: end };
  }
  return null;
}

/**
 * Get revisions for a top-level task by its ID.
 * Convenience wrapper — delegates to getRevisions.
 */
export function getTaskRevisions(cwd: string, taskId: string): Revisions | null {
  return getRevisions(cwd, taskId);
}

// --- NextAction: central decision function for the main loop ---

export type NextAction =
  | { type: "execute"; task: FullTask; subtask?: FullSubtask }
  | { type: "review"; task: FullTask }
  | { type: "rework"; task: FullTask }
  | { type: "blocked"; task: FullTask }
  | null;

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function priorityWeight(p?: string | null): number {
  return (p && PRIORITY_WEIGHT[p]) || 0;
}

/** Compare IDs that may be numeric strings or plain strings. */
function compareIds(a: string | number, b: string | number): number {
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

/**
 * Determine the next action for the main execution loop.
 *
 * Priority order: blocked (0) > rework (1) > review (2) > execute (3).
 *
 * - **blocked**: any task or subtask with status "blocked" stops the process.
 * - **rework**: a task that failed review and needs fixes (resumable).
 * - **review**: a "done" or "review" task that needs code review (when reviewEnabled).
 *   Review BLOCKS execute — you cannot pick up a new task while a done task awaits review.
 * - **execute**: next pending/in-progress task or subtask with satisfied dependencies.
 *   Pass 1 checks subtasks of pending/in-progress parents. Sorting prefers:
 *   in-progress parents > higher priority > lower parent ID > fewer deps > lower subtask ID.
 *   This ensures we finish one task's subtasks before starting another.
 *   Pass 2 only considers top-level tasks WITHOUT subtasks.
 *
 * When reviewEnabled is false, "done" tasks are treated as completed (added to completedIds)
 * and skipped entirely.
 */

/**
 * Reads review round metadata from a task.
 * Returns reviewRoundsTotal (defaults to 1), reviewRound (current round or undefined),
 * and roundSuffix (round number when total > 1, used for report file naming).
 */
export function getReviewRoundInfo(taskId: string, cwd: string): {
  reviewRoundsTotal: number;
  reviewRound: number | undefined;
  roundSuffix: number | undefined;
} {
  const task = showTaskById(taskId, cwd);
  const total = typeof task.metadata?.reviewRoundsTotal === "number"
    ? task.metadata.reviewRoundsTotal : 1;
  const round = typeof task.metadata?.reviewRound === "number"
    ? task.metadata.reviewRound : undefined;
  const suffix = total > 1 ? round : undefined;
  return { reviewRoundsTotal: total, reviewRound: round, roundSuffix: suffix };
}

export function findNextAction(cwd: string, reviewEnabled: boolean): NextAction {
  const data = readTasksFile(cwd);
  const { tasks } = data;

  // Priority 0: blocked — any blocked task/subtask stops the process
  const blockedTask = tasks.find((t) =>
    t.status === "blocked" ||
    t.subtasks.some((s) => s.status === "blocked"),
  );
  if (blockedTask) return { type: "blocked", task: blockedTask };

  // Priority 1: rework — task awaiting fix after review (resumable)
  const reworkTask = tasks
    .filter((t) => t.status === "rework")
    .sort((a, b) => {
      const pa = priorityWeight(a.priority);
      const pb = priorityWeight(b.priority);
      if (pb !== pa) return pb - pa;
      return compareIds(a.id, b.id);
    })[0];
  if (reworkTask) return { type: "rework", task: reworkTask };

  // Priority 2: review — task done or in review status (resumable), needs code review
  if (reviewEnabled) {
    const reviewTask = tasks
      .filter((t) => t.status === "done" || t.status === "review")
      .sort((a, b) => {
        const pa = priorityWeight(a.priority);
        const pb = priorityWeight(b.priority);
        if (pb !== pa) return pb - pa;
        return compareIds(a.id, b.id);
      })[0];
    if (reviewTask) return { type: "review", task: reviewTask };
  }

  // Priority 3: execute — find next pending/in-progress task or subtask

  const completedIds = new Set<string>();
  for (const t of tasks) {
    if (TASK_FINAL_STATUSES.has(t.status) || (!reviewEnabled && t.status === "done")) {
      completedIds.add(String(t.id));
    }
    for (const st of t.subtasks) {
      if (SUBTASK_FINAL_STATUSES.has(st.status)) {
        completedIds.add(`${t.id}.${st.id}`);
      }
    }
  }

  const toFullSubId = (parentId: string | number, depId: string | number): string => {
    const s = String(depId);
    return s.includes(".") ? s : `${parentId}.${s}`;
  };

  // Pass 1: subtasks of pending OR in-progress parents
  const candidateSubtasks: Array<{
    parentTask: FullTask;
    subtask: FullSubtask;
    priority: number;
    depCount: number;
    parentInProgress: boolean;
  }> = [];

  for (const parent of tasks) {
    if (parent.subtasks.length === 0) continue;
    if (parent.status !== "pending" && parent.status !== "in-progress") continue;
    // Check parent task-level dependencies before considering its subtasks
    const parentDepsMet = (parent.dependencies ?? []).every((depId) => completedIds.has(String(depId)));
    if (!parentDepsMet) continue;
    for (const st of parent.subtasks) {
      if (st.status !== "pending" && st.status !== "in-progress") continue;
      const fullDeps = (st.dependencies ?? []).map((d) => toFullSubId(parent.id, d));
      if (fullDeps.every((depId) => completedIds.has(String(depId)))) {
        candidateSubtasks.push({
          parentTask: parent,
          subtask: st,
          priority: priorityWeight(st.priority ?? parent.priority),
          depCount: fullDeps.length,
          parentInProgress: parent.status === "in-progress",
        });
      }
    }
  }

  if (candidateSubtasks.length > 0) {
    // Hard filter: if any in-progress parent has eligible subtasks,
    // exclude candidates from pending parents entirely.
    // This prevents starting a new task while another is still in progress.
    const hasInProgressParent = candidateSubtasks.some((c) => c.parentInProgress);
    const filtered = hasInProgressParent
      ? candidateSubtasks.filter((c) => c.parentInProgress)
      : candidateSubtasks;

    filtered.sort((a, b) => {
      // 1. Higher priority first
      if (b.priority !== a.priority) return b.priority - a.priority;
      // 2. Lower parent ID first (sequential task order)
      const cmpParent = compareIds(a.parentTask.id, b.parentTask.id);
      if (cmpParent !== 0) return cmpParent;
      // 3. Fewer deps first (within same parent)
      if (a.depCount !== b.depCount) return a.depCount - b.depCount;
      // 4. Lower subtask ID first
      return compareIds(a.subtask.id, b.subtask.id);
    });
    const best = filtered[0];
    return { type: "execute", task: best.parentTask, subtask: best.subtask };
  }

  // Pass 2: top-level tasks WITHOUT subtasks only
  const eligible = tasks.filter((t) => {
    if (t.subtasks.length > 0) return false; // tasks with subtasks handled in Pass 1
    if (t.status !== "pending" && t.status !== "in-progress") return false;
    return (t.dependencies ?? []).every((depId) => completedIds.has(String(depId)));
  });

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const pa = priorityWeight(a.priority);
    const pb = priorityWeight(b.priority);
    if (pb !== pa) return pb - pa;
    const da = (a.dependencies ?? []).length;
    const db = (b.dependencies ?? []).length;
    if (da !== db) return da - db;
    return compareIds(a.id, b.id);
  });

  return { type: "execute", task: eligible[0] };
}
