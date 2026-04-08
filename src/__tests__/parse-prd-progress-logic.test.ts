/**
 * Unit tests for parse-prd-progress-logic.ts — pure helper functions
 * used by the ParsePrdProgress component.
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
} from "../../ui/src/components/parse-prd-progress-logic";
import type { ParsePrdStoreState, ParsePrdOutcome } from "../../ui/src/stores/parse-prd";

describe("parse-prd-progress-logic", () => {
  // --- statusText ---
  describe("statusText", () => {
    it('returns "Generating tasks from PRD…" for active state', () => {
      expect(statusText("active", null)).toBe("Generating tasks from PRD\u2026");
    });

    it('returns "Stopping…" for stopping state', () => {
      expect(statusText("stopping", null)).toBe("Stopping\u2026");
    });

    it("returns outcome label for completed/success", () => {
      expect(statusText("completed", { status: "success" })).toBe("Tasks generated successfully");
    });

    it("returns outcome label for completed/failure", () => {
      expect(statusText("completed", { status: "failure", errors: ["err1"] })).toBe("Task generation failed");
    });

    it("returns outcome label for completed/cancelled", () => {
      expect(statusText("completed", { status: "cancelled" })).toBe("Task generation cancelled");
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
      expect(dotVariant("completed", { status: "success" })).toBe("completed-success");
    });

    it('returns "completed-failure" for completed/failure', () => {
      expect(dotVariant("completed", { status: "failure", errors: [] })).toBe("completed-failure");
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
    it("returns success label", () => {
      expect(outcomeLabel({ status: "success" })).toBe("Tasks generated successfully");
    });

    it("returns failure label", () => {
      expect(outcomeLabel({ status: "failure", errors: ["e1"] })).toBe("Task generation failed");
    });

    it("returns cancelled label", () => {
      expect(outcomeLabel({ status: "cancelled" })).toBe("Task generation cancelled");
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
      expect(outcomeSeverity({ status: "failure", errors: [] })).toBe("error");
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

  // --- outcomeErrors ---
  describe("outcomeErrors", () => {
    it("returns errors for failure outcome", () => {
      const errors = ["Missing tasks", "Invalid format"];
      expect(outcomeErrors({ status: "failure", errors })).toEqual(errors);
    });

    it("returns empty array for failure with empty errors", () => {
      expect(outcomeErrors({ status: "failure", errors: [] })).toEqual([]);
    });

    it("returns empty array for success outcome", () => {
      expect(outcomeErrors({ status: "success" })).toEqual([]);
    });

    it("returns empty array for cancelled outcome", () => {
      expect(outcomeErrors({ status: "cancelled" })).toEqual([]);
    });

    it("returns empty array for null outcome", () => {
      expect(outcomeErrors(null)).toEqual([]);
    });
  });

  // --- showDismissButton ---
  describe("showDismissButton", () => {
    it("returns true for completed/failure", () => {
      expect(showDismissButton("completed", { status: "failure", errors: ["err1"] })).toBe(true);
    });

    it("returns true for completed/cancelled", () => {
      expect(showDismissButton("completed", { status: "cancelled" })).toBe(true);
    });

    it("returns false for completed/success", () => {
      expect(showDismissButton("completed", { status: "success" })).toBe(false);
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
      expect(showDismissButton("active", { status: "failure", errors: [] })).toBe(false);
    });
  });
});
