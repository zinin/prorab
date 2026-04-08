/**
 * Unit tests for expand-progress-logic.ts — pure helper functions
 * used by the ExpandProgress component.
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
  outcomeErrors,
  showDismissButton,
  isCommitFailedAfterWrite,
  outcomeDetailMessage,
  reasonDisplayText,
} from "../../ui/src/components/expand-progress-logic";
import type { ExpandStoreState, ExpandOutcome } from "../../ui/src/stores/expand";

// --- Fixtures ---

const successWithSubtasks: ExpandOutcome = { status: "success", taskId: "1", subtaskCount: 5 };
const successNoSubtasks: ExpandOutcome = { status: "success", taskId: "1", subtaskCount: 0 };
const successOneSubtask: ExpandOutcome = { status: "success", taskId: "1", subtaskCount: 1 };
const failure: ExpandOutcome = { status: "failure", taskId: "1", reason: "agent_failed", errors: ["err1", "err2"], message: "Agent crashed", subtaskCount: 0 };
const failureEmpty: ExpandOutcome = { status: "failure", taskId: "1", reason: "validation_failed", errors: [], message: "", subtaskCount: 0 };
const commitFailed: ExpandOutcome = { status: "failure", taskId: "1", reason: "commit_failed_after_write", errors: ["git commit failed"], message: "Subtasks written but commit failed", subtaskCount: 3 };
const cancelled: ExpandOutcome = { status: "cancelled", taskId: "1", subtaskCount: 0 };

describe("expand-progress-logic", () => {
  // --- statusText ---
  describe("statusText", () => {
    it('returns "Expanding task…" for active state', () => {
      expect(statusText("active", null)).toBe("Expanding task\u2026");
    });

    it('returns "Stopping…" for stopping state', () => {
      expect(statusText("stopping", null)).toBe("Stopping\u2026");
    });

    it("returns success label with subtask count for completed/success with subtasks", () => {
      expect(statusText("completed", successWithSubtasks)).toBe("Task expanded into 5 subtasks");
    });

    it("returns singular subtask label for completed/success with 1 subtask", () => {
      expect(statusText("completed", successOneSubtask)).toBe("Task expanded into 1 subtask");
    });

    it("returns no-decomposition label for completed/success with 0 subtasks", () => {
      expect(statusText("completed", successNoSubtasks)).toBe("No decomposition needed");
    });

    it("returns failure label for completed/failure", () => {
      expect(statusText("completed", failure)).toBe("Task expansion failed");
    });

    it("returns cancelled label for completed/cancelled", () => {
      expect(statusText("completed", cancelled)).toBe("Task expansion cancelled");
    });

    it('returns "Completed" for completed with null outcome', () => {
      expect(statusText("completed", null)).toBe("Completed");
    });

    it('returns "Idle" for idle state (defensive)', () => {
      expect(statusText("idle", null)).toBe("Idle");
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
      expect(dotVariant("completed", successWithSubtasks)).toBe("completed-success");
    });

    it('returns "completed-failure" for completed/failure', () => {
      expect(dotVariant("completed", failure)).toBe("completed-failure");
    });

    it('returns "completed-cancelled" for completed/cancelled', () => {
      expect(dotVariant("completed", cancelled)).toBe("completed-cancelled");
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
    it("returns success label with subtask count", () => {
      expect(outcomeLabel(successWithSubtasks)).toBe("Task expanded into 5 subtasks");
    });

    it("returns singular subtask label", () => {
      expect(outcomeLabel(successOneSubtask)).toBe("Task expanded into 1 subtask");
    });

    it("returns no-decomposition label for 0 subtasks", () => {
      expect(outcomeLabel(successNoSubtasks)).toBe("No decomposition needed");
    });

    it("returns failure label", () => {
      expect(outcomeLabel(failure)).toBe("Task expansion failed");
    });

    it("returns cancelled label", () => {
      expect(outcomeLabel(cancelled)).toBe("Task expansion cancelled");
    });

    it("returns generic label for null", () => {
      expect(outcomeLabel(null)).toBe("Completed");
    });
  });

  // --- outcomeSeverity ---
  describe("outcomeSeverity", () => {
    it('returns "success" for success outcome', () => {
      expect(outcomeSeverity(successWithSubtasks)).toBe("success");
    });

    it('returns "error" for failure outcome', () => {
      expect(outcomeSeverity(failure)).toBe("error");
    });

    it('returns "warning" for cancelled outcome', () => {
      expect(outcomeSeverity(cancelled)).toBe("warning");
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

  // --- outcomeErrors ---
  describe("outcomeErrors", () => {
    it("returns errors for failure outcome", () => {
      expect(outcomeErrors(failure)).toEqual(["err1", "err2"]);
    });

    it("returns empty array for failure with empty errors", () => {
      expect(outcomeErrors(failureEmpty)).toEqual([]);
    });

    it("returns empty array for success outcome", () => {
      expect(outcomeErrors(successWithSubtasks)).toEqual([]);
    });

    it("returns empty array for cancelled outcome", () => {
      expect(outcomeErrors(cancelled)).toEqual([]);
    });

    it("returns empty array for null outcome", () => {
      expect(outcomeErrors(null)).toEqual([]);
    });
  });

  // --- showDismissButton ---
  describe("showDismissButton", () => {
    it("returns true for completed/failure", () => {
      expect(showDismissButton("completed", failure)).toBe(true);
    });

    it("returns true for completed/cancelled", () => {
      expect(showDismissButton("completed", cancelled)).toBe(true);
    });

    it("returns false for completed/success", () => {
      expect(showDismissButton("completed", successWithSubtasks)).toBe(false);
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
      expect(showDismissButton("active", failure)).toBe(false);
    });
  });

  // --- isCommitFailedAfterWrite ---
  describe("isCommitFailedAfterWrite", () => {
    it("returns true for commit_failed_after_write failure", () => {
      expect(isCommitFailedAfterWrite(commitFailed)).toBe(true);
    });

    it("returns false for other failure reasons", () => {
      expect(isCommitFailedAfterWrite(failure)).toBe(false);
    });

    it("returns false for success outcome", () => {
      expect(isCommitFailedAfterWrite(successWithSubtasks)).toBe(false);
    });

    it("returns false for cancelled outcome", () => {
      expect(isCommitFailedAfterWrite(cancelled)).toBe(false);
    });

    it("returns false for null outcome", () => {
      expect(isCommitFailedAfterWrite(null)).toBe(false);
    });
  });

  // --- outcomeDetailMessage ---
  describe("outcomeDetailMessage", () => {
    it("returns message for failure outcome", () => {
      expect(outcomeDetailMessage(failure)).toBe("Agent crashed");
    });

    it("returns message for commit_failed_after_write failure", () => {
      expect(outcomeDetailMessage(commitFailed)).toBe("Subtasks written but commit failed");
    });

    it("returns null for failure with empty message", () => {
      expect(outcomeDetailMessage(failureEmpty)).toBeNull();
    });

    it("returns null for success outcome", () => {
      expect(outcomeDetailMessage(successWithSubtasks)).toBeNull();
    });

    it("returns null for cancelled outcome", () => {
      expect(outcomeDetailMessage(cancelled)).toBeNull();
    });

    it("returns null for null outcome", () => {
      expect(outcomeDetailMessage(null)).toBeNull();
    });
  });

  // --- reasonDisplayText ---
  describe("reasonDisplayText", () => {
    it("returns human-readable text for known reason codes", () => {
      expect(reasonDisplayText(failure)).toBe("Agent error"); // agent_failed
      expect(reasonDisplayText(failureEmpty)).toBe("Subtask validation failed"); // validation_failed
      expect(reasonDisplayText(commitFailed)).toBe("Git commit failed after write"); // commit_failed_after_write
    });

    it("returns human-readable text for hash_conflict", () => {
      const hashConflict: ExpandOutcome = { status: "failure", taskId: "1", reason: "hash_conflict", errors: [], message: "", subtaskCount: 0 };
      expect(reasonDisplayText(hashConflict)).toBe("File changed during expansion");
    });

    it("returns human-readable text for result_parse_failed", () => {
      const parseFailed: ExpandOutcome = { status: "failure", taskId: "1", reason: "result_parse_failed", errors: [], message: "", subtaskCount: 0 };
      expect(reasonDisplayText(parseFailed)).toBe("Failed to parse agent output");
    });

    it("humanises unknown reason codes by replacing underscores and capitalising", () => {
      const unknown: ExpandOutcome = { status: "failure", taskId: "1", reason: "some_new_code", errors: [], message: "", subtaskCount: 0 };
      expect(reasonDisplayText(unknown)).toBe("Some new code");
    });

    it("returns null for success outcome", () => {
      expect(reasonDisplayText(successWithSubtasks)).toBeNull();
    });

    it("returns null for cancelled outcome", () => {
      expect(reasonDisplayText(cancelled)).toBeNull();
    });

    it("returns null for null outcome", () => {
      expect(reasonDisplayText(null)).toBeNull();
    });
  });
});
