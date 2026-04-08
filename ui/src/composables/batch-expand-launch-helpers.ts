// ui/src/composables/batch-expand-launch-helpers.ts

/**
 * Whether to show the "Expand All" button.
 * Visible when there are pending tasks eligible for batch expand
 * (pending, no subtasks, not already assessed as atomic).
 */
export function canShowExpandAllButton(
  tasks: Array<{ status: string; subtasks?: unknown[]; recommendedSubtasks?: number | null }>,
): boolean {
  return tasks.some(
    (t) => t.status === "pending"
      && (!t.subtasks || t.subtasks.length === 0)
      && t.recommendedSubtasks !== 0,
  );
}

/**
 * Whether the "Expand All" button should be disabled.
 */
export function isExpandAllDisabled(hasConflictingSession: boolean): boolean {
  return hasConflictingSession;
}

/**
 * Summary status label for the batch expand panel header.
 */
export function batchStatusText(
  state: string,
  progress: { completed: number; total: number },
  outcome?: { status: string } | null,
): string {
  switch (state) {
    case "active":
      return `Expanding tasks... ${progress.completed}/${progress.total}`;
    case "stopping":
      return "Stopping...";
    case "completed":
      if (outcome?.status === "cancelled") {
        return `Batch expand cancelled: ${progress.completed}/${progress.total}`;
      }
      return `Batch expand complete: ${progress.completed}/${progress.total}`;
    default:
      return "";
  }
}

/**
 * Progress bar percentage.
 */
export function progressPercent(progress: { completed: number; total: number }): number {
  if (progress.total === 0) return 0;
  return Math.round((progress.completed / progress.total) * 100);
}

/**
 * CSS class for a task card in the fullscreen batch expand view.
 */
export function taskCardClass(status: string, isFocused: boolean): string {
  let cls: string;
  switch (status) {
    case "done": cls = "bexp-card--done"; break;
    case "skipped": cls = "bexp-card--skipped"; break;
    case "error": cls = "bexp-card--error"; break;
    case "complexity":
    case "expand": cls = "bexp-card--active"; break;
    default: cls = "bexp-card--queued"; break;
  }
  if (isFocused) {
    cls += " bexp-card--focused";
  }
  return cls;
}

/**
 * Label text for a task card in the fullscreen batch expand view.
 */
export function taskCardLabel(item: {
  complexityScore: number | null;
  subtaskCount: number | null;
  skipped: boolean;
  error: string | null;
  status: string;
}): string {
  if (item.status === "queued") return "";
  if (item.complexityScore == null) {
    return item.status === "complexity" ? "…" : "";
  }
  const prefix = `score ${item.complexityScore}`;
  if (item.status === "done" && item.subtaskCount != null) return `${prefix} → ${item.subtaskCount} subtasks`;
  if (item.skipped) return `${prefix} → skip`;
  if (item.error) return `${prefix} → error`;
  return prefix;
}

/**
 * Outcome summary banner text for the fullscreen batch expand view.
 */
export function outcomeSummaryText(outcome: {
  tasks: Array<{ subtaskCount: number | null; skipped: boolean; error?: string }>;
}): string {
  const expanded = outcome.tasks.filter((t) => !t.skipped && !t.error && t.subtaskCount != null).length;
  const skipped = outcome.tasks.filter((t) => t.skipped).length;
  const errors = outcome.tasks.filter((t) => t.error).length;
  const totalSubtasks = outcome.tasks.reduce((sum, t) => sum + (t.subtaskCount ?? 0), 0);

  const parts: string[] = [];
  if (expanded > 0) parts.push(`${expanded} expanded`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (errors > 0) parts.push(`${errors} error`);
  if (totalSubtasks > 0) parts.push(`${totalSubtasks} subtasks created`);
  return parts.join(" · ");
}
