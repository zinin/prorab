/**
 * Pure logic for the RefinePrdProgress component.
 *
 * Extracted into a separate module so it can be unit-tested without
 * DOM rendering or @vue/test-utils.
 */
import type { RefinePrdStoreState, RefinePrdOutcome, RefinePrdSessionInfo } from "../stores/refinePrd";

// --- Status helpers ---

/**
 * Human-readable status text for the header bar.
 *
 * Maps the combined lifecycle state + outcome + session info into a single label.
 * When active with session info, shows the current step number.
 */
export function statusText(
  state: RefinePrdStoreState,
  outcome: RefinePrdOutcome | null,
  sessionInfo: RefinePrdSessionInfo | null,
): string {
  switch (state) {
    case "active":
      if (sessionInfo) {
        const step = sessionInfo.currentStepIndex + 1;
        const total = sessionInfo.steps.length;
        return `Refining PRD \u2014 Step ${step}/${total}`;
      }
      return "Refining PRD\u2026";
    case "stopping":
      return "Stopping\u2026";
    case "completed":
      return outcomeLabel(outcome);
    default:
      // idle — the component shouldn't render in this state, but handle defensively
      return "Refining PRD\u2026";
  }
}

/**
 * Pulsing-dot CSS class variant based on state.
 *
 * Returns a modifier suffix: `active` (green pulse), `stopping` (amber pulse),
 * or `completed` (static, coloured by outcome).
 */
export function dotVariant(
  state: RefinePrdStoreState,
  outcome: RefinePrdOutcome | null,
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
 * For success outcomes, includes the number of steps completed.
 * For failure, shows the step where it failed and the error.
 */
export function outcomeLabel(outcome: RefinePrdOutcome | null): string {
  if (!outcome) return "Completed";
  switch (outcome.status) {
    case "success": {
      const steps = outcome.stepsCompleted ?? 0;
      if (steps > 0) {
        return `PRD refined (${steps} step${steps === 1 ? "" : "s"} completed)`;
      }
      return "PRD refined successfully";
    }
    case "failure": {
      const parts: string[] = [];
      if (outcome.stepIndex != null) {
        parts.push(`Failed at step ${outcome.stepIndex + 1}`);
      } else {
        parts.push("Refinement failed");
      }
      if (outcome.error) {
        parts.push(outcome.error);
      }
      return parts.join(": ");
    }
    case "cancelled":
      return "Refinement cancelled";
  }
}

/**
 * Severity class for the outcome banner (maps to semantic colours).
 */
export function outcomeSeverity(outcome: RefinePrdOutcome | null): string {
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
export function showStopButton(state: RefinePrdStoreState): boolean {
  return state === "active" || state === "stopping";
}

/**
 * Whether the stop button should be disabled (only when already stopping).
 */
export function isStopDisabled(state: RefinePrdStoreState): boolean {
  return state === "stopping";
}

/**
 * Whether the outcome banner should be visible (completed state only).
 */
export function showOutcomeBanner(state: RefinePrdStoreState): boolean {
  return state === "completed";
}

/**
 * Whether the dismiss / "Done" button should be visible.
 *
 * Shown in `completed` state for all outcomes (success, failure, cancelled),
 * so the user can return to the wizard.
 */
export function showDismissButton(
  state: RefinePrdStoreState,
  outcome: RefinePrdOutcome | null,
): boolean {
  return state === "completed" && outcome != null;
}

/**
 * Label describing the current step's agent and model.
 *
 * Returns "agent + model" for display in the header bar during active sessions.
 */
export function stepLabel(sessionInfo: RefinePrdSessionInfo | null): string {
  if (!sessionInfo) return "";
  const step = sessionInfo.steps[sessionInfo.currentStepIndex];
  if (!step) return "";
  const parts = [step.agent];
  if (step.model) parts.push(step.model);
  return parts.join(" + ");
}

/**
 * Whether the current step has a pending question awaiting user reply.
 */
export function isQuestionPending(sessionInfo: RefinePrdSessionInfo | null): boolean {
  return sessionInfo?.stepState === "question_pending";
}
