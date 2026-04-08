/**
 * Pure logic for the BatchExpandProgress component.
 *
 * Extracted into a separate module so it can be unit-tested without
 * DOM rendering or @vue/test-utils.
 */
import type { BatchExpandOutcome } from "../../../src/types";

// --- Outcome helpers ---

/**
 * Whether any task in the outcome has an error.
 */
export function hasTaskErrors(outcome: BatchExpandOutcome | null): boolean {
  return outcome?.tasks?.some((t: { error?: string }) => t.error) ?? false;
}

/**
 * CSS class for the outcome banner (success / error / warning).
 */
export function outcomeBannerClass(outcome: BatchExpandOutcome | null): string {
  if (!outcome) return "";
  if (outcome.status === "cancelled") return "bexp-banner--warning";
  if (hasTaskErrors(outcome)) return "bexp-banner--error";
  return "bexp-banner--success";
}

/**
 * Human-readable outcome label for the banner.
 */
export function outcomeLabel(outcome: BatchExpandOutcome | null): string {
  if (!outcome) return "";
  if (outcome.status === "cancelled") return "Cancelled";
  if (hasTaskErrors(outcome)) return "Completed with errors";
  return "Completed successfully";
}

// --- Status dot ---

/**
 * CSS class modifier for the pulsing status dot.
 */
export function dotVariant(
  state: string,
  outcome: BatchExpandOutcome | null,
): string {
  if (state === "active") return "bexp-dot--active";
  if (state === "stopping") return "bexp-dot--stopping";
  if (state === "completed") {
    if (!outcome) return "bexp-dot--completed";
    if (outcome.status === "cancelled") return "bexp-dot--completed-cancelled";
    if (hasTaskErrors(outcome)) return "bexp-dot--completed-failure";
    return "bexp-dot--completed-success";
  }
  return "bexp-dot--completed";
}

// --- Button visibility ---

/**
 * Whether the stop button should be visible.
 */
export function showStopButton(state: string): boolean {
  return state === "active" || state === "stopping";
}

/**
 * Whether the stop button should be disabled (already stopping).
 */
export function isStopDisabled(state: string): boolean {
  return state === "stopping";
}

/**
 * Whether the done/dismiss button should be visible.
 */
export function showDoneButton(state: string): boolean {
  return state === "completed";
}

// --- Context usage formatting ---

/**
 * Format a number for context usage display (e.g., 45000 → "45K").
 */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

/**
 * Compute context usage percentage.
 */
export function contextPercent(contextUsage: { contextTokens: number; contextWindow: number } | null): number {
  if (!contextUsage || !contextUsage.contextWindow) return 0;
  return Math.round((contextUsage.contextTokens / contextUsage.contextWindow) * 100);
}

/**
 * Format context usage label string (e.g., "Context: 45K / 200K (22%)").
 */
export function contextLabel(contextUsage: { contextTokens: number; contextWindow: number } | null): string {
  if (!contextUsage) return "";
  const pct = contextPercent(contextUsage);
  return `Context: ${fmtTokens(contextUsage.contextTokens)} / ${fmtTokens(contextUsage.contextWindow)} (${pct}%)`;
}

/**
 * Color for context usage percentage (green / yellow / red).
 */
export function contextColor(contextUsage: { contextTokens: number; contextWindow: number } | null): string {
  const pct = contextPercent(contextUsage);
  if (pct >= 60) return "#f44747";
  if (pct >= 35) return "#f59e0b";
  return "#22c55e";
}

// --- Slot info ---

/**
 * Label for the current slot (e.g., "Slot 1 — #6 expand (pinned)").
 */
export function slotInfoLabel(
  slot: { slotIndex: number; taskId: number | null; phase: string } | undefined,
  pinned: boolean,
): string {
  if (!slot) return "";
  const taskPart = slot.taskId ? `#${slot.taskId} ${slot.phase}` : "idle";
  const focusMode = pinned ? "(pinned)" : "(auto)";
  return `Slot ${slot.slotIndex + 1} — ${taskPart} ${focusMode}`;
}
