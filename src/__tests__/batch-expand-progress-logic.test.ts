/**
 * Unit tests for batch-expand-progress-logic.ts — pure logic helpers
 * for the BatchExpandProgress component.
 */
import { describe, it, expect } from "vitest";
import {
  hasTaskErrors,
  outcomeBannerClass,
  outcomeLabel,
  dotVariant,
  showStopButton,
  isStopDisabled,
  showDoneButton,
  fmtTokens,
  contextPercent,
  contextLabel,
  contextColor,
  slotInfoLabel,
} from "../../ui/src/components/batch-expand-progress-logic";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const successOutcome = {
  status: "success" as const,
  tasks: [
    { taskId: 1, subtaskCount: 3, skipped: false },
    { taskId: 2, subtaskCount: 5, skipped: false },
  ],
};

const errorOutcome = {
  status: "success" as const,
  tasks: [
    { taskId: 1, subtaskCount: 3, skipped: false },
    { taskId: 2, subtaskCount: 0, skipped: false, error: "agent failed" },
  ],
};

const cancelledOutcome = {
  status: "cancelled" as const,
  tasks: [
    { taskId: 1, subtaskCount: 3, skipped: false },
  ],
};

// ---------------------------------------------------------------------------
// hasTaskErrors
// ---------------------------------------------------------------------------

describe("hasTaskErrors", () => {
  it("returns false for null outcome", () => {
    expect(hasTaskErrors(null)).toBe(false);
  });

  it("returns false when no tasks have errors", () => {
    expect(hasTaskErrors(successOutcome as any)).toBe(false);
  });

  it("returns true when any task has an error", () => {
    expect(hasTaskErrors(errorOutcome as any)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// outcomeBannerClass
// ---------------------------------------------------------------------------

describe("outcomeBannerClass", () => {
  it("returns empty string for null outcome", () => {
    expect(outcomeBannerClass(null)).toBe("");
  });

  it("returns success class for clean outcome", () => {
    expect(outcomeBannerClass(successOutcome as any)).toBe("bexp-banner--success");
  });

  it("returns error class when tasks have errors", () => {
    expect(outcomeBannerClass(errorOutcome as any)).toBe("bexp-banner--error");
  });

  it("returns warning class for cancelled outcome", () => {
    expect(outcomeBannerClass(cancelledOutcome as any)).toBe("bexp-banner--warning");
  });
});

// ---------------------------------------------------------------------------
// outcomeLabel
// ---------------------------------------------------------------------------

describe("outcomeLabel", () => {
  it("returns empty string for null", () => {
    expect(outcomeLabel(null)).toBe("");
  });

  it('returns "Completed successfully" for clean outcome', () => {
    expect(outcomeLabel(successOutcome as any)).toBe("Completed successfully");
  });

  it('returns "Completed with errors" when tasks have errors', () => {
    expect(outcomeLabel(errorOutcome as any)).toBe("Completed with errors");
  });

  it('returns "Cancelled" for cancelled outcome', () => {
    expect(outcomeLabel(cancelledOutcome as any)).toBe("Cancelled");
  });
});

// ---------------------------------------------------------------------------
// dotVariant
// ---------------------------------------------------------------------------

describe("dotVariant", () => {
  it("returns active dot for active state", () => {
    expect(dotVariant("active", null)).toBe("bexp-dot--active");
  });

  it("returns stopping dot for stopping state", () => {
    expect(dotVariant("stopping", null)).toBe("bexp-dot--stopping");
  });

  it("returns completed-success for clean completed", () => {
    expect(dotVariant("completed", successOutcome as any)).toBe("bexp-dot--completed-success");
  });

  it("returns completed-failure when tasks have errors", () => {
    expect(dotVariant("completed", errorOutcome as any)).toBe("bexp-dot--completed-failure");
  });

  it("returns completed-cancelled for cancelled", () => {
    expect(dotVariant("completed", cancelledOutcome as any)).toBe("bexp-dot--completed-cancelled");
  });

  it("returns generic completed for completed without outcome", () => {
    expect(dotVariant("completed", null)).toBe("bexp-dot--completed");
  });

  it("returns generic completed for idle state", () => {
    expect(dotVariant("idle", null)).toBe("bexp-dot--completed");
  });
});

// ---------------------------------------------------------------------------
// Button visibility
// ---------------------------------------------------------------------------

describe("showStopButton", () => {
  it("returns true for active", () => {
    expect(showStopButton("active")).toBe(true);
  });

  it("returns true for stopping", () => {
    expect(showStopButton("stopping")).toBe(true);
  });

  it("returns false for completed", () => {
    expect(showStopButton("completed")).toBe(false);
  });

  it("returns false for idle", () => {
    expect(showStopButton("idle")).toBe(false);
  });
});

describe("isStopDisabled", () => {
  it("returns true for stopping", () => {
    expect(isStopDisabled("stopping")).toBe(true);
  });

  it("returns false for active", () => {
    expect(isStopDisabled("active")).toBe(false);
  });
});

describe("showDoneButton", () => {
  it("returns true for completed", () => {
    expect(showDoneButton("completed")).toBe(true);
  });

  it("returns false for active", () => {
    expect(showDoneButton("active")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context usage formatting
// ---------------------------------------------------------------------------

describe("fmtTokens", () => {
  it("formats small numbers as-is", () => {
    expect(fmtTokens(500)).toBe("500");
  });

  it("formats thousands with K suffix", () => {
    expect(fmtTokens(45000)).toBe("45K");
  });

  it("rounds to nearest K", () => {
    expect(fmtTokens(1500)).toBe("2K");
  });

  it("handles exactly 1000", () => {
    expect(fmtTokens(1000)).toBe("1K");
  });
});

describe("contextPercent", () => {
  it("returns 0 for null", () => {
    expect(contextPercent(null)).toBe(0);
  });

  it("returns 0 when contextWindow is 0", () => {
    expect(contextPercent({ contextTokens: 100, contextWindow: 0 })).toBe(0);
  });

  it("computes percentage correctly", () => {
    expect(contextPercent({ contextTokens: 45000, contextWindow: 200000 })).toBe(23);
  });
});

describe("contextLabel", () => {
  it("returns empty string for null", () => {
    expect(contextLabel(null)).toBe("");
  });

  it("formats label with K suffix and percentage", () => {
    const result = contextLabel({ contextTokens: 45000, contextWindow: 200000 });
    expect(result).toBe("Context: 45K / 200K (23%)");
  });
});

describe("contextColor", () => {
  it("returns green for low usage", () => {
    expect(contextColor({ contextTokens: 10000, contextWindow: 200000 })).toBe("#22c55e");
  });

  it("returns yellow for medium usage", () => {
    expect(contextColor({ contextTokens: 80000, contextWindow: 200000 })).toBe("#f59e0b");
  });

  it("returns red for high usage", () => {
    expect(contextColor({ contextTokens: 130000, contextWindow: 200000 })).toBe("#f44747");
  });

  it("returns green for null", () => {
    expect(contextColor(null)).toBe("#22c55e");
  });
});

// ---------------------------------------------------------------------------
// slotInfoLabel
// ---------------------------------------------------------------------------

describe("slotInfoLabel", () => {
  it("returns empty string for undefined slot", () => {
    expect(slotInfoLabel(undefined, false)).toBe("");
  });

  it("formats label for active slot with auto-focus", () => {
    const slot = { slotIndex: 0, taskId: 6, phase: "expand" };
    expect(slotInfoLabel(slot, false)).toBe("Slot 1 — #6 expand (auto)");
  });

  it("formats label for pinned slot", () => {
    const slot = { slotIndex: 2, taskId: 9, phase: "complexity" };
    expect(slotInfoLabel(slot, true)).toBe("Slot 3 — #9 complexity (pinned)");
  });

  it("formats label for idle slot", () => {
    const slot = { slotIndex: 0, taskId: null, phase: "idle" };
    expect(slotInfoLabel(slot, false)).toBe("Slot 1 — idle (auto)");
  });
});
