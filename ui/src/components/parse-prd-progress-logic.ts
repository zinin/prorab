/**
 * Pure logic for the ParsePrdProgress component.
 *
 * Extracted into a separate module so it can be unit-tested without
 * DOM rendering or @vue/test-utils.
 */
import type { ParsePrdStoreState, ParsePrdOutcome } from "../stores/parse-prd";

// --- Status helpers ---

/**
 * Human-readable status text for the header bar.
 *
 * Maps the combined lifecycle state + outcome into a single label.
 */
export function statusText(
  state: ParsePrdStoreState,
  outcome: ParsePrdOutcome | null,
): string {
  switch (state) {
    case "active":
      return "Generating tasks from PRD\u2026";
    case "stopping":
      return "Stopping\u2026";
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
  state: ParsePrdStoreState,
  outcome: ParsePrdOutcome | null,
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
 */
export function outcomeLabel(outcome: ParsePrdOutcome | null): string {
  if (!outcome) return "Completed";
  switch (outcome.status) {
    case "success":
      return "Tasks generated successfully";
    case "failure":
      return "Task generation failed";
    case "cancelled":
      return "Task generation cancelled";
  }
}

/**
 * Severity class for the outcome banner (maps to semantic colours).
 */
export function outcomeSeverity(outcome: ParsePrdOutcome | null): string {
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
export function showStopButton(state: ParsePrdStoreState): boolean {
  return state === "active" || state === "stopping";
}

/**
 * Whether the stop button should be disabled (only when already stopping).
 */
export function isStopDisabled(state: ParsePrdStoreState): boolean {
  return state === "stopping";
}

/**
 * Whether the outcome banner should be visible (completed state only).
 */
export function showOutcomeBanner(state: ParsePrdStoreState): boolean {
  return state === "completed";
}

/**
 * Extract error list from a failure outcome (empty array for non-failure).
 */
export function outcomeErrors(outcome: ParsePrdOutcome | null): string[] {
  if (outcome && outcome.status === "failure" && "errors" in outcome) {
    return outcome.errors;
  }
  return [];
}

/**
 * Whether the dismiss / "Done" button should be visible.
 *
 * Shown in `completed` state for all outcomes (success, failure, cancelled),
 * so the user can return to the wizard.
 */
export function showDismissButton(
  state: ParsePrdStoreState,
  outcome: ParsePrdOutcome | null,
): boolean {
  return state === "completed" && outcome != null;
}
