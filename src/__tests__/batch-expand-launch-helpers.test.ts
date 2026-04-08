import { describe, it, expect } from "vitest";
import {
  canShowExpandAllButton,
  isExpandAllDisabled,
  batchStatusText,
  progressPercent,
  taskCardClass,
  taskCardLabel,
  outcomeSummaryText,
} from "../../ui/src/composables/batch-expand-launch-helpers";

// ---------------------------------------------------------------------------
// canShowExpandAllButton
// ---------------------------------------------------------------------------
describe("canShowExpandAllButton", () => {
  it("returns true when there is a pending task without subtasks", () => {
    expect(canShowExpandAllButton([{ status: "pending" }])).toBe(true);
  });

  it("returns true when subtasks array is empty", () => {
    expect(canShowExpandAllButton([{ status: "pending", subtasks: [] }])).toBe(true);
  });

  it("returns false when all pending tasks have subtasks", () => {
    expect(canShowExpandAllButton([{ status: "pending", subtasks: [{}] }])).toBe(false);
  });

  it("returns false when no tasks are pending", () => {
    expect(canShowExpandAllButton([
      { status: "done" },
      { status: "in-progress" },
    ])).toBe(false);
  });

  it("returns false for empty task list", () => {
    expect(canShowExpandAllButton([])).toBe(false);
  });

  it("returns true when at least one pending task has no subtasks among many", () => {
    expect(canShowExpandAllButton([
      { status: "done", subtasks: [{}] },
      { status: "pending", subtasks: [{}] },
      { status: "pending" },
    ])).toBe(true);
  });

  it("returns false when all pending tasks have recommendedSubtasks === 0 (atomic)", () => {
    expect(canShowExpandAllButton([
      { status: "pending", recommendedSubtasks: 0 },
    ])).toBe(false);
  });

  it("returns true when pending task has recommendedSubtasks > 0", () => {
    expect(canShowExpandAllButton([
      { status: "pending", recommendedSubtasks: 3 },
    ])).toBe(true);
  });

  it("returns true when pending task has recommendedSubtasks undefined (never assessed)", () => {
    expect(canShowExpandAllButton([
      { status: "pending", recommendedSubtasks: undefined },
    ])).toBe(true);
  });

  it("returns true when pending task has recommendedSubtasks null (never assessed)", () => {
    expect(canShowExpandAllButton([
      { status: "pending", recommendedSubtasks: null },
    ])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isExpandAllDisabled
// ---------------------------------------------------------------------------
describe("isExpandAllDisabled", () => {
  it("returns true when there is a conflicting session", () => {
    expect(isExpandAllDisabled(true)).toBe(true);
  });

  it("returns false when there is no conflicting session", () => {
    expect(isExpandAllDisabled(false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// batchStatusText
// ---------------------------------------------------------------------------
describe("batchStatusText", () => {
  it("returns expanding message for active state", () => {
    expect(batchStatusText("active", { completed: 2, total: 5 })).toBe("Expanding tasks... 2/5");
  });

  it("returns stopping message for stopping state", () => {
    expect(batchStatusText("stopping", { completed: 3, total: 5 })).toBe("Stopping...");
  });

  it("returns complete message for completed state", () => {
    expect(batchStatusText("completed", { completed: 5, total: 5 })).toBe("Batch expand complete: 5/5");
  });

  it("returns cancelled message when outcome is cancelled", () => {
    expect(batchStatusText("completed", { completed: 3, total: 5 }, { status: "cancelled" })).toBe("Batch expand cancelled: 3/5");
  });

  it("returns complete message when outcome is success", () => {
    expect(batchStatusText("completed", { completed: 5, total: 5 }, { status: "success" })).toBe("Batch expand complete: 5/5");
  });

  it("returns complete message when outcome is null", () => {
    expect(batchStatusText("completed", { completed: 5, total: 5 }, null)).toBe("Batch expand complete: 5/5");
  });

  it("returns empty string for unknown state", () => {
    expect(batchStatusText("idle", { completed: 0, total: 0 })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// progressPercent
// ---------------------------------------------------------------------------
describe("progressPercent", () => {
  it("returns 0 when total is 0", () => {
    expect(progressPercent({ completed: 0, total: 0 })).toBe(0);
  });

  it("returns correct percentage", () => {
    expect(progressPercent({ completed: 3, total: 10 })).toBe(30);
  });

  it("returns 100 when all complete", () => {
    expect(progressPercent({ completed: 5, total: 5 })).toBe(100);
  });

  it("rounds to nearest integer", () => {
    expect(progressPercent({ completed: 1, total: 3 })).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// taskCardClass
// ---------------------------------------------------------------------------
describe("taskCardClass", () => {
  it("returns done class for done status", () => {
    expect(taskCardClass("done", false)).toBe("bexp-card--done");
  });

  it("returns active class with glow for active + isActive", () => {
    expect(taskCardClass("complexity", true)).toBe("bexp-card--active bexp-card--focused");
  });

  it("returns active class without glow when not isActive", () => {
    expect(taskCardClass("expand", false)).toBe("bexp-card--active");
  });

  it("returns skipped class", () => {
    expect(taskCardClass("skipped", false)).toBe("bexp-card--skipped");
  });

  it("returns error class", () => {
    expect(taskCardClass("error", false)).toBe("bexp-card--error");
  });

  it("returns queued class for unknown/queued status", () => {
    expect(taskCardClass("queued", false)).toBe("bexp-card--queued");
  });
});

// ---------------------------------------------------------------------------
// taskCardLabel
// ---------------------------------------------------------------------------
describe("taskCardLabel", () => {
  it("returns score and subtask count for done task", () => {
    expect(taskCardLabel({ complexityScore: 7, subtaskCount: 4, skipped: false, error: null, status: "done" }))
      .toBe("score 7 → 4 subtasks");
  });

  it("returns skip label for skipped task", () => {
    expect(taskCardLabel({ complexityScore: 3, subtaskCount: null, skipped: true, error: null, status: "skipped" }))
      .toBe("score 3 → skip");
  });

  it("returns error label", () => {
    expect(taskCardLabel({ complexityScore: 5, subtaskCount: null, skipped: false, error: "timeout", status: "error" }))
      .toBe("score 5 → error");
  });

  it("returns score only for in-progress task", () => {
    expect(taskCardLabel({ complexityScore: 8, subtaskCount: null, skipped: false, error: null, status: "expand" }))
      .toBe("score 8");
  });

  it("returns ellipsis when no score yet", () => {
    expect(taskCardLabel({ complexityScore: null, subtaskCount: null, skipped: false, error: null, status: "complexity" }))
      .toBe("…");
  });

  it("returns empty for queued task", () => {
    expect(taskCardLabel({ complexityScore: null, subtaskCount: null, skipped: false, error: null, status: "queued" }))
      .toBe("");
  });
});

// ---------------------------------------------------------------------------
// outcomeSummaryText
// ---------------------------------------------------------------------------
describe("outcomeSummaryText", () => {
  it("returns summary for mixed outcome", () => {
    expect(outcomeSummaryText({
      status: "success",
      tasks: [
        { taskId: 1, complexityScore: 7, recommendedSubtasks: 4, subtaskCount: 4, skipped: false },
        { taskId: 2, complexityScore: 5, recommendedSubtasks: 3, subtaskCount: 3, skipped: false },
        { taskId: 3, complexityScore: 8, recommendedSubtasks: 5, subtaskCount: 5, skipped: false },
        { taskId: 4, complexityScore: 3, recommendedSubtasks: 0, subtaskCount: null, skipped: true },
        { taskId: 5, complexityScore: 5, recommendedSubtasks: 4, subtaskCount: null, skipped: false, error: "timeout" },
      ],
    })).toBe("3 expanded · 1 skipped · 1 error · 12 subtasks created");
  });

  it("omits zero categories", () => {
    expect(outcomeSummaryText({
      status: "success",
      tasks: [
        { taskId: 1, complexityScore: 7, recommendedSubtasks: 4, subtaskCount: 10, skipped: false },
        { taskId: 2, complexityScore: 5, recommendedSubtasks: 5, subtaskCount: 10, skipped: false },
      ],
    })).toBe("2 expanded · 20 subtasks created");
  });

  it("handles cancelled outcome", () => {
    expect(outcomeSummaryText({
      status: "cancelled",
      tasks: [
        { taskId: 1, complexityScore: 7, recommendedSubtasks: 4, subtaskCount: 8, skipped: false },
      ],
    })).toBe("1 expanded · 8 subtasks created");
  });
});
