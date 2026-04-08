/**
 * Explicit view-mode state machine for TaskListView.
 *
 * Replaces scattered boolean computed properties (showInlineChat, showParsePrdPanel,
 * showWizard) with a single deterministic function that maps project-state flags
 * and session states to exactly one ViewMode.
 *
 * Priority (highest first):
 *   loading > inline-chat > refine-prd-progress > parse-prd-progress > refine-tasks-progress > batch-expand-progress > error > task-list > wizard-*
 *
 * Guarantees:
 *   - Active parse-prd beats any wizard
 *   - Active batch-expand beats error and wizard
 *   - Invalid tasks.json beats parse-prd wizard
 *   - Valid tasks.json always produces task-list (no array-length heuristic)
 */

/**
 * All possible visual modes of the TaskListView page.
 *
 * - `loading`                — WS not yet connected, nothing to show
 * - `inline-chat`            — Chat session active (idea-to-PRD flow, no tasks file)
 * - `parse-prd-progress`     — Parse-PRD session active/stopping/completed
 * - `refine-tasks-progress`  — Refine-tasks session active/stopping/completed
 * - `batch-expand-progress`  — Batch-expand session active/stopping/completed
 * - `error`                  — tasks.json exists but is corrupted or invalid
 * - `task-list`              — Valid tasks.json (empty or populated — sub-variant of template)
 * - `wizard-chat`            — No tasks file, no PRD — chat wizard
 * - `wizard-parse-prd`       — No tasks file, has PRD — parse-prd wizard
 */
export type ViewMode =
  | "loading"
  | "inline-chat"
  | "refine-prd-progress"
  | "parse-prd-progress"
  | "refine-tasks-progress"
  | "batch-expand-progress"
  | "error"
  | "task-list"
  | "wizard-chat"
  | "wizard-parse-prd";

/**
 * Flat input flags for the view-mode decision function.
 *
 * Deliberately excludes task-array / task-count fields to prevent
 * indirect heuristics — mode is determined solely by explicit boolean
 * flags and session state strings.
 */
export interface ViewModeFlags {
  /** WebSocket connected message has been received */
  wsInitialized: boolean;
  /** tasks.json file is present on disk */
  hasTasksFile: boolean;
  /** tasks.json is structurally valid (Zod schema passes) */
  hasValidTasks: boolean;
  /** PRD file exists and has meaningful content */
  hasPrd: boolean;
  /** Tasks are currently being fetched from the server */
  loading: boolean;
  /** Chat store state: "idle" | "active" | "question_pending" | "stopping" */
  chatState: string;
  /** Parse-PRD store state: "idle" | "active" | "stopping" | "completed" */
  parsePrdState: string;
  /** Refine-PRD store state: "idle" | "active" | "stopping" | "completed" */
  refinePrdState: string;
  /** Refine-tasks store state: "idle" | "active" | "stopping" | "completed" */
  refineTasksState: string;
  /** Batch-expand store state: "idle" | "active" | "stopping" | "completed" */
  batchExpandState?: string;
}

/**
 * Compute the explicit view mode from project-state flags and session states.
 *
 * This is a pure function with no store or I/O dependencies — all inputs
 * are passed as a flat flags object. The if/else chain encodes the priority
 * order directly; re-ordering branches changes semantics.
 */
export function computeViewMode(f: ViewModeFlags): ViewMode {
  // 1. WS not yet connected — blank screen until state is known
  if (!f.wsInitialized) return "loading";

  // 2. Active chat session (idea-to-PRD flow) — only when no tasks file
  if (!f.hasTasksFile && f.chatState !== "idle") return "inline-chat";

  // 2.5. Refine-PRD session in any non-idle state
  if (f.refinePrdState !== "idle") return "refine-prd-progress";

  // 3. Parse-PRD session in any non-idle state — always takes priority
  //    over wizard & error (terminal outcome banners must be visible)
  if (f.parsePrdState !== "idle") return "parse-prd-progress";

  // 3.25. Refine-tasks session in any non-idle state
  if (f.refineTasksState !== "idle") return "refine-tasks-progress";

  // 3.5. Batch-expand session in any non-idle state
  if ((f.batchExpandState ?? "idle") !== "idle") return "batch-expand-progress";

  // 4. tasks.json exists but corrupted / invalid schema.
  //    No loading guard: once wsInitialized is true, the server has already
  //    provided authoritative hasValidTasks via the connected message.
  //    A concurrent fetchTasks() does not change file validity.
  if (f.hasTasksFile && !f.hasValidTasks) return "error";

  // 5. Valid tasks.json → task list (regardless of task count — no array-length heuristic)
  if (f.hasTasksFile && f.hasValidTasks) return "task-list";

  // 6. No tasks file, no active sessions → wizard
  //    Flavor depends on PRD presence
  if (!f.hasTasksFile) {
    return f.hasPrd ? "wizard-parse-prd" : "wizard-chat";
  }

  // 7. Fallback (unreachable with current branches — kept for defensive safety)
  return "task-list";
}
