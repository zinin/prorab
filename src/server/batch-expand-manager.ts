// src/server/batch-expand-manager.ts
/**
 * BatchExpandManager — orchestrates parallel complexity analysis + task expansion.
 *
 * Lifecycle: idle → active → (stopping) → finished.
 * Uses SlotPool for max-10 concurrent agent sessions.
 * Each task pipeline: complexity agent → write fields → expand agent → write subtasks → commit.
 */

import { randomUUID } from "node:crypto";
import type { AgentType, Verbosity, BatchExpandOutcome } from "../types.js";
import type { WsBroadcaster } from "./session/ws-broadcaster.js";
import { DriverRunner } from "./session/driver-runner.js";
import { SlotPool } from "../core/slot-pool.js";
import { extractJsonFromResult } from "../core/json-extract.js";
import { buildComplexitySystemPrompt, buildComplexityTaskPrompt } from "../prompts/complexity.js";
import { buildExpandSystemPrompt, buildExpandTaskPrompt, type ExpandTaskContext } from "../prompts/expand.js";
import { parseComplexityResult } from "../core/complexity-validation.js";
import { parseExpandResult } from "../core/expand-validation.js";
import { readTasksFile, writeExpandSubtasks, writeComplexityFields, withTasksMutex } from "../core/tasks-json.js";
import { isGitRepo, isTrackedByGit, hasGitIdentity, isPathDirty, commitExpandedTask, commitComplexityFields } from "../core/git.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { broadcastTasksUpdated } from "./ws.js";
import type { FullTask } from "../core/tasks-json-types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BatchExpandState = "idle" | "active" | "stopping" | "finished";

export interface BatchExpandOptions {
  agent: AgentType;
  model?: string;
  variant?: string;
  verbosity?: Verbosity;
  userSettings?: boolean;
  applyHooks?: boolean;
}

export interface SlotState {
  slotIndex: number;
  taskId: number | null;
  phase: "complexity" | "expand" | "idle";
}

export interface TaskSummary {
  taskId: number;
  taskTitle: string;
  complexityScore: number | null;
  recommendedSubtasks: number | null;
  subtaskCount: number | null;
  skipped: boolean;
  error: string | null;
  status: "queued" | "complexity" | "expand" | "done" | "skipped" | "error";
}

export interface BatchExpandFullState {
  state: BatchExpandState;
  slots: SlotState[];
  summary: TaskSummary[];
  progress: { completed: number; total: number; errors: number; skipped: number };
  outcome: BatchExpandOutcome | null;
  /** Maps taskId → slotIndex for UI tab navigation after completion (slots have taskId: null when idle). */
  taskSlotMap: Record<number, number>;
}

export class BatchExpandSessionActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchExpandSessionActiveError";
  }
}

export class BatchExpandPreflightError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "BatchExpandPreflightError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_CONCURRENCY = 10;
const COMPLEXITY_MAX_TURNS = 50;
const EXPAND_MAX_TURNS = 100;

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class BatchExpandManager {
  private _state: BatchExpandState = "idle";
  private _slots: SlotState[] = [];
  private _summary: TaskSummary[] = [];
  private _outcome: BatchExpandOutcome | null = null;
  private _pool: SlotPool<FullTask> | null = null;
  private _completedCount = 0;
  private _errorCount = 0;
  private _skippedCount = 0;
  private _totalCount = 0;
  private _taskSlotMap = new Map<number, number>();
  private _finishedPromise: Promise<void> | null = null;
  private _finishedResolve: (() => void) | null = null;

  constructor(
    private readonly cwd: string,
    private readonly broadcaster: WsBroadcaster,
  ) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  getState(): BatchExpandFullState {
    return {
      state: this._state,
      slots: [...this._slots],
      summary: [...this._summary],
      progress: {
        completed: this._completedCount,
        total: this._totalCount,
        errors: this._errorCount,
        skipped: this._skippedCount,
      },
      outcome: this._outcome,
      taskSlotMap: Object.fromEntries(this._taskSlotMap),
    };
  }

  start(opts: BatchExpandOptions): { taskIds: number[]; slotCount: number } | null {
    if (this._state !== "idle" && this._state !== "finished") {
      throw new BatchExpandSessionActiveError(
        `Cannot start batch expand: state is ${this._state}`,
      );
    }

    // Git preflight
    this.runGitPreflight();

    // Read eligible tasks
    const data = readTasksFile(this.cwd);
    const eligible = data.tasks.filter(
      (t) => t.status === "pending"
        && (!t.subtasks || t.subtasks.length === 0)
        && t.recommendedSubtasks !== 0, // skip tasks already assessed as atomic
    );

    if (eligible.length === 0) return null;

    // Acquire process-level lock BEFORE mutating state.
    acquireLock(this.cwd);

    try {
      // Reset state — only after lock acquired
      this._state = "active";
      this._outcome = null;
      this._completedCount = 0;
      this._errorCount = 0;
      this._skippedCount = 0;
      this._totalCount = eligible.length;
      this._taskSlotMap = new Map();

      const slotCount = Math.min(eligible.length, MAX_CONCURRENCY);
      this._slots = Array.from({ length: slotCount }, (_, i) => ({
        slotIndex: i,
        taskId: null,
        phase: "idle" as const,
      }));

      this._summary = eligible.map((t) => ({
        taskId: Number(t.id),
        taskTitle: t.title,
        complexityScore: null,
        recommendedSubtasks: null,
        subtaskCount: null,
        skipped: false,
        error: null,
        status: "queued" as const,
      }));

      const taskIds = eligible.map((t) => Number(t.id));
      const taskTitles: Record<number, string> = {};
      for (const t of eligible) taskTitles[Number(t.id)] = t.title;

      // Clear ring buffer
      this.broadcaster.clearBuffer();

      // Broadcast started
      this.broadcaster.broadcastWithChannel(
        { type: "batch_expand:started", taskIds, slotCount, taskTitles },
        "batch-expand",
      );

      // Create deferred for waitForFinished()
      this._finishedPromise = new Promise<void>((resolve) => {
        this._finishedResolve = resolve;
      });

      // Launch pool (fire-and-forget with .catch)
      void this.runPool(eligible, opts).catch((err) => {
        // Defensive: reset state if pool promise itself rejects (extremely unlikely —
        // only possible if runPool's finally block itself throws)
        this._state = "finished";
        this._pool = null;
        try { releaseLock(this.cwd); } catch { /* ignore */ }
        this._finishedResolve?.();
        const message = err instanceof Error ? err.message : String(err);
        this.broadcaster.broadcastWithChannel(
          { type: "batch_expand:error", message, reason: "pool_crash" },
          "batch-expand",
        );
      });

      return { taskIds, slotCount };
    } catch (err) {
      // Rollback on any failure between lock acquisition and pool launch
      this._state = "idle";
      try { releaseLock(this.cwd); } catch { /* ignore */ }
      throw err;
    }
  }

  stop(): boolean {
    if (this._state !== "active") return false;
    this._state = "stopping";
    this._pool?.abort();
    return true;
  }

  /** Reset finished state so reconnect no longer restores the completed view. */
  dismiss(): boolean {
    if (this._state !== "finished") return false;
    this._state = "idle";
    this._slots = [];
    this._summary = [];
    this._outcome = null;
    this._taskSlotMap = new Map();
    this._completedCount = 0;
    this._errorCount = 0;
    this._skippedCount = 0;
    this._totalCount = 0;
    this.broadcaster.clearBuffer();
    return true;
  }

  /**
   * Wait for the batch to finish (or resolve immediately if not active).
   * Used by SIGINT handler to ensure driver teardown completes before exit.
   */
  async waitForFinished(): Promise<void> {
    if (this._state === "idle" || this._state === "finished") return;
    if (this._finishedPromise) await this._finishedPromise;
  }

  // -----------------------------------------------------------------------
  // Private: pool execution
  // -----------------------------------------------------------------------

  private async runPool(tasks: FullTask[], opts: BatchExpandOptions): Promise<void> {
    try {
      this._pool = new SlotPool<FullTask>({
        items: tasks,
        concurrency: Math.min(tasks.length, MAX_CONCURRENCY),
        worker: (task, slotIndex, signal) =>
          this.runTaskPipeline(task, slotIndex, signal, opts),
      });

      await this._pool.run();
    } finally {
      try { releaseLock(this.cwd); } catch { /* ignore */ }

      const outcome: BatchExpandOutcome = {
        status: this._state === "stopping" ? "cancelled" : "success",
        tasks: this._summary.map((s) => ({
          taskId: s.taskId,
          complexityScore: s.complexityScore,
          recommendedSubtasks: s.recommendedSubtasks,
          subtaskCount: s.subtaskCount,
          skipped: s.skipped,
          ...(s.error ? { error: s.error } : {}),
        })),
      };
      this._outcome = outcome;
      this._state = "finished";
      this._pool = null;

      this.broadcaster.broadcastWithChannel(
        { type: "batch_expand:finished", outcome },
        "batch-expand",
      );

      this._finishedResolve?.();
    }
  }

  private async runTaskPipeline(
    task: FullTask,
    slotIndex: number,
    signal: AbortSignal,
    opts: BatchExpandOptions,
  ): Promise<void> {
    const taskId = Number(task.id);
    const taskIdStr = String(task.id);
    const summaryEntry = this._summary.find((s) => s.taskId === taskId);

    try {
      // --- Phase 1: Complexity ---
      this._taskSlotMap.set(taskId, slotIndex);
      this.updateSlot(slotIndex, taskId, "complexity");
      if (summaryEntry) summaryEntry.status = "complexity";

      this.broadcaster.broadcastWithChannel(
        { type: "batch_expand:slot_started", slotIndex, taskId, phase: "complexity" },
        "batch-expand",
      );

      const complexityResult = await this.runComplexityAgent(task, slotIndex, signal, opts);

      if (signal.aborted) return;

      // Write complexity fields + commit inside mutex
      await withTasksMutex(() => {
        writeComplexityFields(this.cwd, taskIdStr, complexityResult);
        commitComplexityFields(this.cwd, taskIdStr);
        broadcastTasksUpdated();
      });

      if (summaryEntry) {
        summaryEntry.complexityScore = complexityResult.complexityScore;
        summaryEntry.recommendedSubtasks = complexityResult.recommendedSubtasks;
      }

      this.broadcaster.broadcastWithChannel(
        {
          type: "batch_expand:complexity_done",
          slotIndex,
          taskId,
          score: complexityResult.complexityScore,
          recommendedSubtasks: complexityResult.recommendedSubtasks,
        },
        "batch-expand",
      );

      // Check if expand is needed
      if (complexityResult.recommendedSubtasks === 0) {
        if (summaryEntry) {
          summaryEntry.skipped = true;
          summaryEntry.status = "skipped";
          summaryEntry.subtaskCount = 0;
        }
        this._skippedCount++;
        this._completedCount++;
        this.updateSlot(slotIndex, null, "idle");
        this.broadcaster.broadcastWithChannel(
          { type: "batch_expand:slot_finished", slotIndex, taskId, subtaskCount: 0, skipped: true },
          "batch-expand",
        );
        this.broadcastProgress(this._totalCount);
        return;
      }

      // --- Phase 2: Expand ---
      this.updateSlot(slotIndex, taskId, "expand");
      if (summaryEntry) summaryEntry.status = "expand";

      this.broadcaster.broadcastWithChannel(
        { type: "batch_expand:slot_started", slotIndex, taskId, phase: "expand" },
        "batch-expand",
      );

      // Re-read task to get updated complexity fields
      const updatedData = readTasksFile(this.cwd);
      const updatedTask = updatedData.tasks.find((t) => String(t.id) === taskIdStr);
      if (!updatedTask) throw new Error(`Task ${taskId} disappeared from tasks.json`);

      const subtaskCount = await this.runExpandAgent(updatedTask, slotIndex, signal, opts);

      if (summaryEntry) {
        summaryEntry.subtaskCount = subtaskCount;
        summaryEntry.status = "done";
      }
      this._completedCount++;
      this.updateSlot(slotIndex, null, "idle");

      this.broadcaster.broadcastWithChannel(
        { type: "batch_expand:slot_finished", slotIndex, taskId, subtaskCount, skipped: false },
        "batch-expand",
      );
      this.broadcastProgress(this._totalCount);
    } catch (err) {
      // Aborted tasks should NOT count as errors
      if (signal.aborted) return;

      const message = err instanceof Error ? err.message : String(err);
      if (summaryEntry) {
        summaryEntry.error = message;
        summaryEntry.status = "error";
      }
      this._errorCount++;
      this._completedCount++;
      this.updateSlot(slotIndex, null, "idle");

      this.broadcaster.broadcastWithChannel(
        { type: "batch_expand:error", slotIndex, taskId, message, reason: "pipeline_error" },
        "batch-expand",
      );
      this.broadcastProgress(this._totalCount);
    }
  }

  // -----------------------------------------------------------------------
  // Agent runners
  // -----------------------------------------------------------------------

  private async runComplexityAgent(
    task: FullTask,
    slotIndex: number,
    signal: AbortSignal,
    opts: BatchExpandOptions,
  ): Promise<{ complexityScore: number; recommendedSubtasks: number; expansionPrompt: string; reasoning: string }> {
    const driver = new DriverRunner(opts.agent, opts.model, opts.userSettings ?? false, opts.applyHooks ?? false);
    const ac = new AbortController();
    const abortHandler = () => ac.abort();
    signal.addEventListener("abort", abortHandler);
    // Guard: if signal was already aborted before listener registration,
    // the "abort" event has already fired and won't trigger the handler.
    if (signal.aborted) ac.abort();

    try {
      await driver.setup(
        { verbosity: opts.verbosity ?? "trace", abortSignal: signal },
        (event) => {
          this.broadcaster.broadcastWithChannel(
            { ...event, slotIndex, taskId: Number(task.id), phase: "complexity" } as typeof event & { slotIndex: number; taskId: number; phase: string },
            "batch-expand",
          );
        },
      );

      const systemPrompt = buildComplexitySystemPrompt(this.cwd);
      const taskPrompt = buildComplexityTaskPrompt({
        id: task.id,
        title: task.title,
        description: task.description,
        details: task.details,
        dependencies: task.dependencies,
        testStrategy: task.testStrategy,
      });

      // Broadcast prompts for UI
      this.broadcaster.broadcastWithChannel(
        { type: "agent:system_prompt", text: systemPrompt, slotIndex, taskId: Number(task.id), phase: "complexity" },
        "batch-expand",
      );
      this.broadcaster.broadcastWithChannel(
        { type: "agent:task_prompt", text: taskPrompt, slotIndex, taskId: Number(task.id), phase: "complexity" },
        "batch-expand",
      );

      const result = await driver.runSession({
        prompt: taskPrompt,
        systemPrompt,
        cwd: this.cwd,
        maxTurns: COMPLEXITY_MAX_TURNS,
        abortController: ac,
        verbosity: opts.verbosity ?? "trace",
        variant: opts.variant,
        unitId: `complexity-${task.id}-${randomUUID()}`,
      });

      if (result.signal.type === "blocked" || result.signal.type === "error") {
        const msg = result.signal.type === "blocked"
          ? `Agent blocked: ${result.signal.reason}`
          : `Agent error: ${result.signal.message}`;
        throw new Error(msg);
      }

      // Extract and validate
      const jsonText = extractJsonFromResult(result.resultText);
      if (!jsonText) throw new Error("No JSON found in complexity agent output");

      const validation = parseComplexityResult(jsonText);
      if (!validation.ok) {
        throw new Error(`Complexity validation failed: ${validation.errors[0]}`);
      }

      return validation.data;
    } finally {
      signal.removeEventListener("abort", abortHandler);
      try { await driver.teardown(); } catch { /* teardown failure must not override primary result */ }
    }
  }

  private async runExpandAgent(
    task: FullTask,
    slotIndex: number,
    signal: AbortSignal,
    opts: BatchExpandOptions,
  ): Promise<number> {
    const driver = new DriverRunner(opts.agent, opts.model, opts.userSettings ?? false, opts.applyHooks ?? false);
    const ac = new AbortController();
    const abortHandler = () => ac.abort();
    signal.addEventListener("abort", abortHandler);
    // Guard: if signal was already aborted before listener registration,
    // the "abort" event has already fired and won't trigger the handler.
    if (signal.aborted) ac.abort();

    try {
      await driver.setup(
        { verbosity: opts.verbosity ?? "trace", abortSignal: signal },
        (event) => {
          this.broadcaster.broadcastWithChannel(
            { ...event, slotIndex, taskId: Number(task.id), phase: "expand" } as typeof event & { slotIndex: number; taskId: number; phase: string },
            "batch-expand",
          );
        },
      );

      const taskContext: ExpandTaskContext = {
        id: task.id,
        title: task.title,
        description: task.description,
        details: task.details,
        dependencies: task.dependencies,
        testStrategy: task.testStrategy,
        expansionPrompt: task.expansionPrompt,
        complexityReasoning: task.complexityReasoning,
        recommendedSubtasks: typeof task.recommendedSubtasks === "number" ? task.recommendedSubtasks : undefined,
      };

      const systemPrompt = buildExpandSystemPrompt(this.cwd);
      const taskPrompt = buildExpandTaskPrompt(taskContext);

      this.broadcaster.broadcastWithChannel(
        { type: "agent:system_prompt", text: systemPrompt, slotIndex, taskId: Number(task.id), phase: "expand" },
        "batch-expand",
      );
      this.broadcaster.broadcastWithChannel(
        { type: "agent:task_prompt", text: taskPrompt, slotIndex, taskId: Number(task.id), phase: "expand" },
        "batch-expand",
      );

      const result = await driver.runSession({
        prompt: taskPrompt,
        systemPrompt,
        cwd: this.cwd,
        maxTurns: EXPAND_MAX_TURNS,
        abortController: ac,
        verbosity: opts.verbosity ?? "trace",
        variant: opts.variant,
        unitId: `batch-expand-${task.id}-${randomUUID()}`,
      });

      if (result.signal.type === "blocked" || result.signal.type === "error") {
        const msg = result.signal.type === "blocked"
          ? `Agent blocked: ${result.signal.reason}`
          : `Agent error: ${result.signal.message}`;
        throw new Error(msg);
      }

      const jsonText = extractJsonFromResult(result.resultText);
      if (!jsonText) throw new Error("No JSON found in expand agent output");

      const validation = parseExpandResult(jsonText);
      if (!validation.ok) {
        throw new Error(`Expand validation failed: ${validation.errors[0]}`);
      }

      const { subtasks } = validation.data;

      if (subtasks.length === 0) return 0;

      const taskIdStr = String(task.id);

      const writeResult = await withTasksMutex(() => {
        // Re-verify task is still eligible
        const freshData = readTasksFile(this.cwd);
        const freshTask = freshData.tasks.find((t) => String(t.id) === taskIdStr);
        if (!freshTask || freshTask.status !== "pending" || (freshTask.subtasks && freshTask.subtasks.length > 0)) {
          return { status: "stale" as const, count: 0 };
        }

        writeExpandSubtasks(this.cwd, taskIdStr, subtasks);
        commitExpandedTask(this.cwd, taskIdStr, subtasks.length);
        broadcastTasksUpdated();
        return { status: "written" as const, count: subtasks.length };
      });

      if (writeResult.status === "stale") {
        throw new Error("Task is no longer eligible (status changed or subtasks added externally)");
      }

      return writeResult.count;
    } finally {
      signal.removeEventListener("abort", abortHandler);
      try { await driver.teardown(); } catch { /* teardown failure must not override primary result */ }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private runGitPreflight(): void {
    if (!isGitRepo(this.cwd)) {
      throw new BatchExpandPreflightError("git_not_repo", "Not a git repository");
    }
    const tasksJsonPath = ".taskmaster/tasks/tasks.json";
    if (!isTrackedByGit(tasksJsonPath, this.cwd)) {
      throw new BatchExpandPreflightError("tasks_file_untracked", "tasks.json is not tracked by git");
    }
    if (!hasGitIdentity(this.cwd)) {
      throw new BatchExpandPreflightError("git_identity_missing", "Git user.name or user.email not configured");
    }
    if (isPathDirty(tasksJsonPath, this.cwd)) {
      throw new BatchExpandPreflightError("tasks_file_dirty", "tasks.json has uncommitted changes");
    }
  }

  private updateSlot(slotIndex: number, taskId: number | null, phase: SlotState["phase"]): void {
    if (this._slots[slotIndex]) {
      this._slots[slotIndex].taskId = taskId;
      this._slots[slotIndex].phase = phase;
    }
  }

  private broadcastProgress(total: number): void {
    this.broadcaster.broadcastWithChannel(
      {
        type: "batch_expand:progress",
        completed: this._completedCount,
        total,
        errors: this._errorCount,
        skipped: this._skippedCount,
      },
      "batch-expand",
    );
  }
}
