/**
 * Pure logic for the ExpandProgress component.
 *
 * Extracted into a separate module so it can be unit-tested without
 * DOM rendering or @vue/test-utils.
 */
import type { ExpandStoreState, ExpandOutcome } from "../stores/expand";

// --- Status helpers ---

/**
 * Human-readable status text for the header bar.
 *
 * Maps the combined lifecycle state + outcome into a single label.
 */
export function statusText(
  state: ExpandStoreState,
  outcome: ExpandOutcome | null,
): string {
  switch (state) {
    case "active":
      return "Expanding task…";
    case "stopping":
      return "Stopping…";
    case "completed":
      return outcomeLabel(outcome);
    default:
      // idle — the component shouldn't render in this state, but handle defensively
      return "Idle";
  }
}

/**
 * Pulsing-dot CSS class variant based on state.
 *
 * Returns a modifier suffix: `active` (green pulse), `stopping` (amber pulse),
 * or `completed` (static, coloured by outcome).
 */
export function dotVariant(
  state: ExpandStoreState,
  outcome: ExpandOutcome | null,
): string {
  if (state === "stopping") return "stopping";
  if (state === "completed") {
    if (!outcome) return "completed";
    return `completed-${outcome.status}`;
  }
  return "active";
}

// --- Outcome helpers ---

/**
 * Short label for the terminal outcome — used in the header and the banner.
 *
 * For success outcomes, distinguishes between decomposition with subtasks
 * and decomposition where no subtasks were needed.
 */
export function outcomeLabel(outcome: ExpandOutcome | null): string {
  if (!outcome) return "Completed";
  switch (outcome.status) {
    case "success":
      if (outcome.subtaskCount > 0) {
        return `Task expanded into ${outcome.subtaskCount} subtask${outcome.subtaskCount === 1 ? "" : "s"}`;
      }
      return "No decomposition needed";
    case "failure":
      return "Task expansion failed";
    case "cancelled":
      return "Task expansion cancelled";
  }
}

/**
 * Severity class for the outcome banner (maps to semantic colours).
 */
export function outcomeSeverity(outcome: ExpandOutcome | null): string {
  if (!outcome) return "info";
  switch (outcome.status) {
    case "success":
      return "success";
    case "failure":
      return "error";
    case "cancelled":
      return "warning";
  }
}

/**
 * Whether the stop button should be visible (only in active/stopping states).
 */
export function showStopButton(state: ExpandStoreState): boolean {
  return state === "active" || state === "stopping";
}

/**
 * Whether the stop button should be disabled (only when already stopping).
 */
export function isStopDisabled(state: ExpandStoreState): boolean {
  return state === "stopping";
}

/**
 * Whether the outcome banner should be visible (completed state only).
 */
export function showOutcomeBanner(state: ExpandStoreState): boolean {
  return state === "completed";
}

/**
 * Extract error list from a failure outcome (empty array for non-failure).
 */
export function outcomeErrors(outcome: ExpandOutcome | null): string[] {
  if (outcome && outcome.status === "failure" && "errors" in outcome) {
    return outcome.errors;
  }
  return [];
}

/**
 * Whether the dismiss / "Try Again" button should be visible.
 *
 * Shown only in `completed` state with a non-success outcome
 * (`failure` or `cancelled`), so the user can return to the wizard.
 */
export function showDismissButton(
  state: ExpandStoreState,
  outcome: ExpandOutcome | null,
): boolean {
  return state === "completed" && outcome != null && outcome.status !== "success";
}

/**
 * Whether the failure outcome has a `commit_failed_after_write` reason,
 * which requires a special warning message.
 *
 * This reason means subtasks were written to tasks.json but the git commit
 * failed — the file is in a partially committed state.
 */
export function isCommitFailedAfterWrite(outcome: ExpandOutcome | null): boolean {
  return (
    outcome != null &&
    outcome.status === "failure" &&
    outcome.reason === "commit_failed_after_write"
  );
}

/**
 * Human-readable detail message for the outcome banner.
 *
 * For failure outcomes, returns the server-provided message.
 * For `commit_failed_after_write`, appends a special warning.
 */
export function outcomeDetailMessage(outcome: ExpandOutcome | null): string | null {
  if (!outcome) return null;
  if (outcome.status === "failure") {
    return outcome.message || null;
  }
  return null;
}

// --- Reason code mapping ---

/**
 * Map of known expand failure reason codes to human-readable descriptions.
 *
 * Keys MUST match `EXPAND_FAILURE_REASON_CODES` in `src/prompts/expand.ts`.
 * The Section 1 contract test verifies bidirectional sync.
 */
export const REASON_DISPLAY: Record<string, string> = {
  agent_failed: "Agent error",
  result_parse_failed: "Failed to parse agent output",
  validation_failed: "Subtask validation failed",
  hash_conflict: "File changed during expansion",
  commit_failed_after_write: "Git commit failed after write",
};

/**
 * Human-readable label for a failure reason code.
 *
 * Returns a descriptive string for known reason codes, or formats
 * unrecognised codes by replacing underscores with spaces and capitalising.
 * Returns `null` for non-failure outcomes.
 */
export function reasonDisplayText(outcome: ExpandOutcome | null): string | null {
  if (!outcome || outcome.status !== "failure") return null;
  const known = REASON_DISPLAY[outcome.reason];
  if (known) return known;
  // Fallback: humanise the raw code (e.g. "some_new_code" → "Some new code")
  const raw = outcome.reason.replace(/_/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}
