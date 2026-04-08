/**
 * Post-validation for parse-prd results.
 *
 * Validates that `.taskmaster/tasks/tasks.json` produced by the parse-prd agent
 * conforms to the stricter parse-prd success criteria — standard top-level
 * format only, all tasks pending, empty subtasks, valid dependency references.
 *
 * This is intentionally separate from the general reader (`tasks-json.ts`)
 * which accepts multi-tag and other historical formats.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TasksFileSchema } from "./tasks-json-types.js";
import { nullsToUndefined } from "./tasks-json.js";
import { TASKS_PATH } from "../prompts/parse-prd.js";

export interface ParsePrdValidationResult {
  /** Whether the file passes all parse-prd success criteria. */
  valid: boolean;
  /** Human-readable list of validation errors (empty when valid). */
  errors: string[];
}

/**
 * Outcome for the parse-prd operation, suitable for the execution manager.
 *
 * Two states only — `cancelled` is not returned here; the calling code
 * (manager) assigns it on user-stop / abort.
 */
export type ParsePrdOutcome =
  | { status: "success" }
  | { status: "failure"; errors: string[] };

/**
 * Validate raw parsed JSON (already parsed from the file) against parse-prd
 * success criteria.
 *
 * This is the pure logic — no file I/O. Useful for testing.
 */
export function validateParsePrdResult(parsed: unknown): ParsePrdValidationResult {
  const errors: string[] = [];

  // --- Must be a non-null, non-array object ---
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { valid: false, errors: ["Expected a JSON object at the top level"] };
  }

  const obj = parsed as Record<string, unknown>;

  // --- Reject multi-tag format ---
  // Standard format has a top-level `tasks` array. If it doesn't, check whether
  // this looks like multi-tag (keys whose values contain { tasks }) and reject
  // explicitly. Any other shape is also rejected.
  if (!Array.isArray(obj.tasks)) {
    // Detect multi-tag shape for a clearer error message
    const tagKeys = Object.keys(obj).filter((k) => {
      const v = obj[k];
      return v != null && typeof v === "object" && Array.isArray((v as Record<string, unknown>).tasks);
    });
    if (tagKeys.length > 0) {
      errors.push(
        `Multi-tag format detected (tags: ${tagKeys.join(", ")}). ` +
        "parse-prd must produce standard top-level { tasks, metadata } format",
      );
    } else {
      errors.push("Missing top-level `tasks` array — expected standard { tasks, metadata } format");
    }
    return { valid: false, errors };
  }

  // --- Apply nullsToUndefined for Zod compatibility (TaskMaster writes null) ---
  const cleaned = nullsToUndefined(parsed);

  // --- Validate against TasksFileSchema ---
  const schemaResult = TasksFileSchema.safeParse(cleaned);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues) {
      errors.push(`Schema: ${issue.path.join(".")} — ${issue.message}`);
    }
    return { valid: false, errors };
  }

  const { tasks } = schemaResult.data;

  // --- At least one task ---
  if (tasks.length === 0) {
    errors.push("tasks array must contain at least one task");
    return { valid: false, errors };
  }

  // --- Collect all top-level IDs for dependency validation ---
  const allIds = new Set<number | string>();

  for (const task of tasks) {
    // Store raw id (number | string) for dependency lookups
    allIds.add(task.id);
  }

  // --- Per-task checks ---
  for (const task of tasks) {
    const label = typeof task.id === "string" && task.id.trim().length === 0
      ? "task (empty id)"
      : `task ${task.id}`;

    // Non-empty id (string IDs must not be empty or whitespace-only)
    if (typeof task.id === "string" && task.id.trim().length === 0) {
      errors.push(`${label}: id must be non-empty`);
    }

    // Non-empty title
    if (!task.title || task.title.trim().length === 0) {
      errors.push(`${label}: title must be non-empty`);
    }

    // Status must be "pending"
    if (task.status !== "pending") {
      errors.push(`${label}: status must be "pending", got "${task.status}"`);
    }

    // Subtasks must be empty array
    if (task.subtasks.length !== 0) {
      errors.push(`${label}: subtasks must be empty [], got ${task.subtasks.length} subtask(s)`);
    }

    // Dependencies must reference existing top-level IDs
    for (const dep of task.dependencies) {
      if (!allIds.has(dep)) {
        // Also check numeric/string coercion — id could be number or string
        const numDep = typeof dep === "string" ? Number(dep) : dep;
        const strDep = String(dep);
        if (!allIds.has(numDep) && !allIds.has(strDep)) {
          errors.push(`${label}: dependency ${dep} does not reference an existing task ID`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Read `.taskmaster/tasks/tasks.json` from disk and validate it against
 * parse-prd success criteria.
 *
 * Returns `{ valid: false, errors: [...] }` if the file is missing, unreadable,
 * not valid JSON, or fails any parse-prd constraint.
 */
export function validateParsePrdFile(cwd: string): ParsePrdValidationResult {
  const filePath = join(cwd, TASKS_PATH);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return { valid: false, errors: [`Cannot read ${TASKS_PATH}: file does not exist or is unreadable`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { valid: false, errors: [`${TASKS_PATH} is not valid JSON: ${(e as Error).message}`] };
  }

  return validateParsePrdResult(parsed);
}

/**
 * Determine the parse-prd outcome by validating the resulting tasks.json file.
 *
 * Returns `{ status: "success" }` when the file passes all parse-prd criteria,
 * or `{ status: "failure", errors: [...] }` with log/UI-friendly messages when
 * it does not.
 *
 * Note: `cancelled` is NOT returned by this helper — the execution manager
 * assigns that status on user-stop or abort.
 */
export function getParsePrdOutcome(cwd: string): ParsePrdOutcome {
  const result = validateParsePrdFile(cwd);
  if (result.valid) {
    return { status: "success" };
  }
  return { status: "failure", errors: result.errors };
}
