/**
 * Unit tests for refine-tasks-progress-logic.ts — pure helper functions
 * used by the RefineTasksProgress component.
 */
import { describe, it, expect } from "vitest";
import {
  statusText,
  dotVariant,
  outcomeLabel,
  outcomeSeverity,
  showStopButton,
  isStopDisabled,
  showOutcomeBanner,
  showDismissButton,
  stepLabel,
  isQuestionPending,
} from "../../ui/src/components/refine-tasks-progress-logic";
import type {
  RefineTasksStoreState,
  RefineTasksOutcome,
  RefineTasksSessionInfo,
} from "../../ui/src/stores/refineTasks";

// --- Helpers ---

/** Creates a minimal RefineTasksSessionInfo for testing. */
function mkSession(overrides: Partial<RefineTasksSessionInfo> = {}): RefineTasksSessionInfo {
  return {
    steps: [
      { agent: "claude", model: "opus" },
      { agent: "opencode", model: "sonnet" },
    ],
    currentStepIndex: 0,
    stepState: "running",
    ...overrides,
  };
}

describe("refine-tasks-progress-logic", () => {
  // --- statusText ---
  describe("statusText", () => {
    it('returns "Refining Tasks — Step X/Y" when active with session info', () => {
      const session = mkSession();
      expect(statusText("active", null, session)).toBe("Refining Tasks \u2014 Step 1/2");
    });

    it("increments step number based on currentStepIndex", () => {
      const session = mkSession({ currentStepIndex: 1 });
      expect(statusText("active", null, session)).toBe("Refining Tasks \u2014 Step 2/2");
    });

    it('returns "Refining Tasks…" when active without session info', () => {
      expect(statusText("active", null, null)).toBe("Refining Tasks\u2026");
    });

    it('returns "Stopping…" for stopping state', () => {
      expect(statusText("stopping", null, null)).toBe("Stopping\u2026");
    });

    it("returns outcome label for completed/success with steps count", () => {
      expect(statusText("completed", { status: "success", stepsCompleted: 3 }, null)).toBe(
        "Tasks refined (3 steps completed)",
      );
    });

    it("returns outcome label for completed/success with 1 step", () => {
      expect(statusText("completed", { status: "success", stepsCompleted: 1 }, null)).toBe(
        "Tasks refined (1 step completed)",
      );
    });

    it("returns outcome label for completed/success without steps count", () => {
      expect(statusText("completed", { status: "success" }, null)).toBe(
        "Tasks refined successfully",
      );
    });

    it("returns outcome label for completed/failure", () => {
      expect(
        statusText("completed", { status: "failure", error: "something broke" }, null),
      ).toBe("Refinement failed: something broke");
    });

    it("returns outcome label for completed/failure with stepIndex", () => {
      expect(
        statusText("completed", { status: "failure", stepIndex: 0, error: "timeout" }, null),
      ).toBe("Failed at step 1: timeout");
    });

    it("returns outcome label for completed/cancelled", () => {
      expect(statusText("completed", { status: "cancelled" }, null)).toBe(
        "Refinement cancelled",
      );
    });

    it('returns "Completed" for completed with null outcome', () => {
      expect(statusText("completed", null, null)).toBe("Completed");
    });

    it('returns "Refining Tasks…" for idle state (defensive)', () => {
      expect(statusText("idle", null, null)).toBe("Refining Tasks\u2026");
    });
  });

  // --- dotVariant ---
  describe("dotVariant", () => {
    it('returns "active" for active state', () => {
      expect(dotVariant("active", null)).toBe("active");
    });

    it('returns "stopping" for stopping state', () => {
      expect(dotVariant("stopping", null)).toBe("stopping");
    });

    it('returns "completed-success" for completed/success', () => {
      expect(dotVariant("completed", { status: "success" })).toBe("completed-success");
    });

    it('returns "completed-failure" for completed/failure', () => {
      expect(dotVariant("completed", { status: "failure" })).toBe("completed-failure");
    });

    it('returns "completed-cancelled" for completed/cancelled', () => {
      expect(dotVariant("completed", { status: "cancelled" })).toBe("completed-cancelled");
    });

    it('returns "completed" for completed with null outcome', () => {
      expect(dotVariant("completed", null)).toBe("completed");
    });

    it('returns "active" for idle state (defensive)', () => {
      expect(dotVariant("idle", null)).toBe("active");
    });
  });

  // --- outcomeLabel ---
  describe("outcomeLabel", () => {
    it("returns success label with step count", () => {
      expect(outcomeLabel({ status: "success", stepsCompleted: 2 })).toBe(
        "Tasks refined (2 steps completed)",
      );
    });

    it("returns singular step label for 1 step", () => {
      expect(outcomeLabel({ status: "success", stepsCompleted: 1 })).toBe(
        "Tasks refined (1 step completed)",
      );
    });

    it("returns generic success label when stepsCompleted is 0", () => {
      expect(outcomeLabel({ status: "success", stepsCompleted: 0 })).toBe(
        "Tasks refined successfully",
      );
    });

    it("returns generic success label when stepsCompleted is undefined", () => {
      expect(outcomeLabel({ status: "success" })).toBe("Tasks refined successfully");
    });

    it("returns failure label with stepIndex and error", () => {
      expect(outcomeLabel({ status: "failure", stepIndex: 2, error: "agent crashed" })).toBe(
        "Failed at step 3: agent crashed",
      );
    });

    it("returns failure label with stepIndex only", () => {
      expect(outcomeLabel({ status: "failure", stepIndex: 0 })).toBe("Failed at step 1");
    });

    it("returns failure label with error only", () => {
      expect(outcomeLabel({ status: "failure", error: "unknown error" })).toBe(
        "Refinement failed: unknown error",
      );
    });

    it("returns failure label with neither stepIndex nor error", () => {
      expect(outcomeLabel({ status: "failure" })).toBe("Refinement failed");
    });

    it("returns cancelled label", () => {
      expect(outcomeLabel({ status: "cancelled" })).toBe("Refinement cancelled");
    });

    it("returns generic label for null", () => {
      expect(outcomeLabel(null)).toBe("Completed");
    });
  });

  // --- outcomeSeverity ---
  describe("outcomeSeverity", () => {
    it('returns "success" for success outcome', () => {
      expect(outcomeSeverity({ status: "success" })).toBe("success");
    });

    it('returns "error" for failure outcome', () => {
      expect(outcomeSeverity({ status: "failure" })).toBe("error");
    });

    it('returns "warning" for cancelled outcome', () => {
      expect(outcomeSeverity({ status: "cancelled" })).toBe("warning");
    });

    it('returns "info" for null outcome', () => {
      expect(outcomeSeverity(null)).toBe("info");
    });
  });

  // --- showStopButton ---
  describe("showStopButton", () => {
    it("returns true for active state", () => {
      expect(showStopButton("active")).toBe(true);
    });

    it("returns true for stopping state", () => {
      expect(showStopButton("stopping")).toBe(true);
    });

    it("returns false for completed state", () => {
      expect(showStopButton("completed")).toBe(false);
    });

    it("returns false for idle state", () => {
      expect(showStopButton("idle")).toBe(false);
    });
  });

  // --- isStopDisabled ---
  describe("isStopDisabled", () => {
    it("returns false for active state", () => {
      expect(isStopDisabled("active")).toBe(false);
    });

    it("returns true for stopping state", () => {
      expect(isStopDisabled("stopping")).toBe(true);
    });

    it("returns false for completed state", () => {
      expect(isStopDisabled("completed")).toBe(false);
    });
  });

  // --- showOutcomeBanner ---
  describe("showOutcomeBanner", () => {
    it("returns true for completed state", () => {
      expect(showOutcomeBanner("completed")).toBe(true);
    });

    it("returns false for active state", () => {
      expect(showOutcomeBanner("active")).toBe(false);
    });

    it("returns false for stopping state", () => {
      expect(showOutcomeBanner("stopping")).toBe(false);
    });

    it("returns false for idle state", () => {
      expect(showOutcomeBanner("idle")).toBe(false);
    });
  });

  // --- showDismissButton ---
  describe("showDismissButton", () => {
    it("returns true for completed/success", () => {
      expect(showDismissButton("completed", { status: "success" })).toBe(true);
    });

    it("returns true for completed/failure", () => {
      expect(showDismissButton("completed", { status: "failure" })).toBe(true);
    });

    it("returns true for completed/cancelled", () => {
      expect(showDismissButton("completed", { status: "cancelled" })).toBe(true);
    });

    it("returns false for completed with null outcome", () => {
      expect(showDismissButton("completed", null)).toBe(false);
    });

    it("returns false for active state", () => {
      expect(showDismissButton("active", null)).toBe(false);
    });

    it("returns false for stopping state", () => {
      expect(showDismissButton("stopping", null)).toBe(false);
    });

    it("returns false for idle state", () => {
      expect(showDismissButton("idle", null)).toBe(false);
    });

    it("returns false for active with failure outcome (state takes precedence)", () => {
      expect(showDismissButton("active", { status: "failure" })).toBe(false);
    });
  });

  // --- stepLabel ---
  describe("stepLabel", () => {
    it("returns empty string for null session info", () => {
      expect(stepLabel(null)).toBe("");
    });

    it('returns "agent + model" when both are present', () => {
      const session = mkSession({ currentStepIndex: 0 });
      expect(stepLabel(session)).toBe("claude + opus");
    });

    it("returns agent only when model is absent", () => {
      const session = mkSession({
        steps: [{ agent: "codex" }],
        currentStepIndex: 0,
      });
      expect(stepLabel(session)).toBe("codex");
    });

    it("returns correct label for a later step", () => {
      const session = mkSession({ currentStepIndex: 1 });
      expect(stepLabel(session)).toBe("opencode + sonnet");
    });

    it("returns empty string when currentStepIndex is out of bounds", () => {
      const session = mkSession({ currentStepIndex: 99 });
      expect(stepLabel(session)).toBe("");
    });
  });

  // --- isQuestionPending ---
  describe("isQuestionPending", () => {
    it("returns true when stepState is question_pending", () => {
      const session = mkSession({ stepState: "question_pending" });
      expect(isQuestionPending(session)).toBe(true);
    });

    it("returns false when stepState is running", () => {
      const session = mkSession({ stepState: "running" });
      expect(isQuestionPending(session)).toBe(false);
    });

    it("returns false for null session info", () => {
      expect(isQuestionPending(null)).toBe(false);
    });
  });
});
