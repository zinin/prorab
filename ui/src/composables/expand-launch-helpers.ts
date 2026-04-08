/**
 * Pure helpers for the expand launch dialog in TaskDetailView.
 *
 * Extracted into a separate module so they can be unit-tested without
 * DOM rendering or @vue/test-utils — same pattern as
 * expand-progress-logic.ts and agent-wizard-logic.ts.
 */

// --- Expand launch gating ---

/**
 * Whether the Expand button should be visible for a given task.
 *
 * Visible only for top-level tasks that are pending and have no subtasks.
 * TaskDetailView already shows only top-level tasks, so we only check
 * status and subtask count here.
 */
export function canShowExpandButton(
  status: string | undefined,
  subtaskCount: number,
): boolean {
  return status === "pending" && subtaskCount === 0;
}

/**
 * Whether the Expand button should be disabled even when visible.
 *
 * Disabled when:
 * - The form has unsaved local changes (dirty state)
 * - A save operation is in progress
 * - Another session type is active (execution, chat, parse-prd, or expand for another task)
 */
export function isExpandDisabled(opts: {
  isDirty: boolean;
  isSaving: boolean;
  hasConflictingSession: boolean;
}): boolean {
  return opts.isDirty || opts.isSaving || opts.hasConflictingSession;
}

/**
 * Check if any other session type is currently active.
 *
 * Uses the global single-session model: execution, chat, parse-prd, and expand
 * share a single file lock via SessionCore. If any is active, expand cannot start.
 */
export function hasConflictingSession(opts: {
  executionState: string;
  chatHasSession: boolean;
  parsePrdHasSession: boolean;
  expandIsRunning: boolean;
  expandBelongsToTask: boolean;
  batchExpandIsRunning?: boolean;
}): boolean {
  // Execution is active (running or stopping)
  if (opts.executionState !== "idle") return true;
  // Chat is active
  if (opts.chatHasSession) return true;
  // Parse-prd is active
  if (opts.parsePrdHasSession) return true;
  // Expand is actively running for a DIFFERENT task (same-task expand is handled
  // by showing ExpandProgress). Terminal (completed) expand sessions are not
  // conflicts — they don't hold the session lock.
  if (opts.expandIsRunning && !opts.expandBelongsToTask) return true;
  // Batch expand is active
  if (opts.batchExpandIsRunning) return true;
  return false;
}

/**
 * Human-readable tooltip for the disabled Expand button.
 *
 * Returns a user-friendly explanation of why expand is disabled,
 * or null when the button is enabled.
 */
export function expandDisabledTooltip(opts: {
  isDirty: boolean;
  isSaving: boolean;
  hasConflictingSession: boolean;
}): string | null {
  if (opts.isSaving) return "Save in progress";
  if (opts.isDirty) return "Save your changes first";
  if (opts.hasConflictingSession) return "Another session is active";
  return null;
}

// --- Start error reason codes → user-facing text ---

/**
 * Map of known expand start error reason codes to user-friendly descriptions.
 *
 * These are reason codes returned by POST /api/tasks/:id/expand (409 responses).
 * Distinct from the outcome reason codes in expand-progress-logic.ts, which
 * describe post-session failures.
 */
const START_REASON_DISPLAY: Record<string, string> = {
  // Route-level checks
  tasks_file_missing: "Tasks file not found",
  tasks_file_invalid: "Tasks file is invalid",
  task_not_found: "Task not found",
  task_not_pending: "Task is not in pending status",
  task_has_subtasks: "Task already has subtasks",
  // Git preflight
  git_not_repo: "Not a git repository",
  tasks_file_untracked: "Tasks file is not tracked by git",
  git_identity_missing: "Git user identity not configured (set user.name and user.email)",
  tasks_file_dirty: "Tasks file has uncommitted changes",
  // Session conflicts
  active_session: "Another session is already active",
  task_mismatch: "Expand session is active for a different task",
};

/**
 * Human-readable label for an expand start error reason code.
 *
 * Returns a descriptive string for known reason codes, or formats
 * unrecognised codes by replacing underscores with spaces and capitalising.
 * Returns null when reason is null/undefined.
 */
// --- Post-expand auto-refresh ---

/**
 * Determines whether TaskDetailView should reload the task after an expand outcome.
 *
 * Returns true for file-writing outcomes that target the given task:
 * - `success` with `subtaskCount > 0` — subtasks were written and committed.
 * - `failure` with `reason === "commit_failed_after_write"` — subtasks were
 *   written to disk but the git commit failed; the user should still see the
 *   new subtasks (along with a commit-failure warning).
 *
 * Returns false for:
 * - null outcome
 * - outcome targeting a different task
 * - no-op success (`subtaskCount === 0`) — file is byte-identical
 * - other failure reasons (no file write happened)
 * - cancelled outcomes
 */
export function shouldReloadAfterExpand(
  outcome: { status: string; taskId: string; subtaskCount: number; reason?: string } | null,
  currentTaskId: string,
): boolean {
  if (!outcome) return false;
  if (outcome.taskId !== currentTaskId) return false;

  // Success with subtasks written to disk
  if (outcome.status === "success" && outcome.subtaskCount > 0) return true;

  // Failure where subtasks were written but commit failed
  if (outcome.status === "failure" && outcome.reason === "commit_failed_after_write") return true;

  return false;
}

export function startReasonDisplayText(reason: string | null | undefined): string | null {
  if (!reason) return null;
  const known = START_REASON_DISPLAY[reason];
  if (known) return known;
  // Fallback: humanise the raw code (e.g. "some_new_code" → "Some new code")
  const raw = reason.replace(/_/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
