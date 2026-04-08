import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PRD_PATH, TASKS_PATH } from "../prompts/parse-prd.js";
import { TasksFileSchema } from "./tasks-json-types.js";
import { nullsToUndefined } from "./tasks-json.js";

/**
 * Aggregated project state — the public contract for UI and precondition checks.
 *
 * Three boolean flags cover every meaningful combination:
 *
 * | hasPrd | hasTasksFile | hasValidTasks | Meaning                              |
 * |--------|--------------|---------------|--------------------------------------|
 * | false  | false        | false         | Fresh project — nothing set up       |
 * | false  | true         | false         | tasks.json exists but is invalid     |
 * | false  | true         | true          | Valid tasks, no PRD                  |
 * | true   | false        | false         | PRD written, parse-prd not run yet   |
 * | true   | true         | false         | PRD exists, tasks.json is invalid    |
 * | true   | true         | true          | Fully initialised project            |
 *
 * Note: `hasValidTasks: true` with `hasTasksFile: false` is structurally impossible.
 */
export interface ProjectState {
  /** PRD file exists and contains non-whitespace text. */
  hasPrd: boolean;
  /** `.taskmaster/tasks/tasks.json` exists on disk. */
  hasTasksFile: boolean;
  /** The file is valid JSON conforming to the TasksFile schema. */
  hasValidTasks: boolean;
}

/**
 * Return the aggregated project state in a single call.
 *
 * Combines {@link hasPrd} and {@link checkTasksFile} into a flat
 * three-flag object suitable for `GET /api/status` and parse-prd
 * precondition checks.
 */
export function getProjectState(cwd: string): ProjectState {
  const prd = hasPrd(cwd);
  const { hasTasksFile, hasValidTasks } = checkTasksFile(cwd);
  return { hasPrd: prd, hasTasksFile, hasValidTasks };
}

/**
 * Check whether the PRD file exists and contains meaningful (non-whitespace) text.
 *
 * A file that is missing, empty, or contains only whitespace characters
 * is treated as "no PRD" — it should not open the parse-prd flow in the
 * UI or API.
 */
export function hasPrd(cwd: string): boolean {
  try {
    const content = readFileSync(join(cwd, PRD_PATH), "utf-8");
    return content.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Result of checking the tasks.json file.
 *
 * Three possible states:
 * - File absent:  `{ hasTasksFile: false, hasValidTasks: false }`
 * - File present but invalid (bad JSON or schema mismatch):
 *                 `{ hasTasksFile: true, hasValidTasks: false }`
 * - File present and valid:
 *                 `{ hasTasksFile: true, hasValidTasks: true }`
 */
export interface TasksFileCheck {
  /** Whether `.taskmaster/tasks/tasks.json` exists on disk. */
  hasTasksFile: boolean;
  /** Whether the file is valid JSON conforming to the TasksFile schema. */
  hasValidTasks: boolean;
}

/**
 * Check the state of `.taskmaster/tasks/tasks.json`.
 *
 * Distinguishes three outcomes: file missing, file present but
 * invalid (malformed JSON or schema violation), and file present
 * and valid.  Reuses the `TasksFileSchema` for validation so that
 * the definition of "valid" stays in sync with `readTasksFile()`.
 *
 * Both standard (`{ tasks, metadata }`) and multi-tag
 * (`{ "tag": { tasks, metadata } }`) formats are accepted.
 */
export function checkTasksFile(cwd: string): TasksFileCheck {
  const fullPath = join(cwd, TASKS_PATH);
  if (!existsSync(fullPath)) {
    return { hasTasksFile: false, hasValidTasks: false };
  }

  try {
    const raw = readFileSync(fullPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { hasTasksFile: true, hasValidTasks: false };
    }

    // Apply null → undefined normalization to match readTasksFile() semantics.
    // TaskMaster commonly writes `"field": null` for optional fields;
    // without normalization Zod `.optional()` rejects them.
    const obj = nullsToUndefined(parsed) as Record<string, unknown>;

    // Standard format: top-level "tasks" array
    if (Array.isArray(obj.tasks)) {
      TasksFileSchema.parse(obj);
      return { hasTasksFile: true, hasValidTasks: true };
    }

    // Multi-tag format: at least one key whose value has a "tasks" array
    const tagNames = Object.keys(obj).filter((k) => {
      const v = obj[k];
      return v != null && typeof v === "object" && Array.isArray((v as Record<string, unknown>).tasks);
    });

    if (tagNames.length === 0) {
      return { hasTasksFile: true, hasValidTasks: false };
    }

    // Validate only the first tag — matches readTasksFile() which reads tagNames[0]
    const valid = TasksFileSchema.safeParse(obj[tagNames[0]]).success;
    return { hasTasksFile: true, hasValidTasks: valid };
  } catch {
    return { hasTasksFile: true, hasValidTasks: false };
  }
}
