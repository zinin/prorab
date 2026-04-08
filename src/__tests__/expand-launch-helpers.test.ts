import { describe, it, expect } from "vitest";
import {
  canShowExpandButton,
  isExpandDisabled,
  hasConflictingSession,
  expandDisabledTooltip,
  startReasonDisplayText,
} from "../../ui/src/composables/expand-launch-helpers";

// ---------------------------------------------------------------------------
// canShowExpandButton
// ---------------------------------------------------------------------------
describe("canShowExpandButton", () => {
  it("returns true for pending task with no subtasks", () => {
    expect(canShowExpandButton("pending", 0)).toBe(true);
  });

  it("returns false for non-pending status", () => {
    expect(canShowExpandButton("in-progress", 0)).toBe(false);
    expect(canShowExpandButton("done", 0)).toBe(false);
    expect(canShowExpandButton("blocked", 0)).toBe(false);
    expect(canShowExpandButton("review", 0)).toBe(false);
    expect(canShowExpandButton("rework", 0)).toBe(false);
    expect(canShowExpandButton("closed", 0)).toBe(false);
  });

  it("returns false for pending task with subtasks", () => {
    expect(canShowExpandButton("pending", 1)).toBe(false);
    expect(canShowExpandButton("pending", 5)).toBe(false);
  });

  it("returns false for non-pending task with subtasks", () => {
    expect(canShowExpandButton("done", 3)).toBe(false);
  });

  it("returns false for undefined status", () => {
    expect(canShowExpandButton(undefined, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isExpandDisabled
// ---------------------------------------------------------------------------
describe("isExpandDisabled", () => {
  const defaults = { isDirty: false, isSaving: false, hasConflictingSession: false };

  it("returns false when no conditions are met", () => {
    expect(isExpandDisabled(defaults)).toBe(false);
  });

  it("returns true when form is dirty", () => {
    expect(isExpandDisabled({ ...defaults, isDirty: true })).toBe(true);
  });

  it("returns true when saving", () => {
    expect(isExpandDisabled({ ...defaults, isSaving: true })).toBe(true);
  });

  it("returns true when conflicting session is active", () => {
    expect(isExpandDisabled({ ...defaults, hasConflictingSession: true })).toBe(true);
  });

  it("returns true when multiple conditions are met", () => {
    expect(isExpandDisabled({ isDirty: true, isSaving: true, hasConflictingSession: true })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasConflictingSession
// ---------------------------------------------------------------------------
describe("hasConflictingSession", () => {
  const defaults = {
    executionState: "idle",
    chatHasSession: false,
    parsePrdHasSession: false,
    expandIsRunning: false,
    expandBelongsToTask: false,
  };

  it("returns false when no sessions are active", () => {
    expect(hasConflictingSession(defaults)).toBe(false);
  });

  it("returns true when execution is running", () => {
    expect(hasConflictingSession({ ...defaults, executionState: "running" })).toBe(true);
  });

  it("returns true when execution is stopping", () => {
    expect(hasConflictingSession({ ...defaults, executionState: "stopping" })).toBe(true);
  });

  it("returns true when chat has active session", () => {
    expect(hasConflictingSession({ ...defaults, chatHasSession: true })).toBe(true);
  });

  it("returns true when parse-prd has active session", () => {
    expect(hasConflictingSession({ ...defaults, parsePrdHasSession: true })).toBe(true);
  });

  it("returns true when expand is active for a different task", () => {
    expect(hasConflictingSession({
      ...defaults,
      expandIsRunning: true,
      expandBelongsToTask: false,
    })).toBe(true);
  });

  it("returns false when expand is active for the SAME task", () => {
    expect(hasConflictingSession({
      ...defaults,
      expandIsRunning: true,
      expandBelongsToTask: true,
    })).toBe(false);
  });

  it("returns false when expand has no session (expandBelongsToTask irrelevant)", () => {
    expect(hasConflictingSession({
      ...defaults,
      expandIsRunning: false,
      expandBelongsToTask: true,
    })).toBe(false);
  });

  it("returns true when batch expand is running", () => {
    expect(hasConflictingSession({
      ...defaults,
      batchExpandIsRunning: true,
    })).toBe(true);
  });

  it("returns false when batchExpandIsRunning is false", () => {
    expect(hasConflictingSession({
      ...defaults,
      batchExpandIsRunning: false,
    })).toBe(false);
  });

  it("returns false when batchExpandIsRunning is omitted (backward compat)", () => {
    // Existing callers that don't pass batchExpandIsRunning should not break
    expect(hasConflictingSession(defaults)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// expandDisabledTooltip
// ---------------------------------------------------------------------------
describe("expandDisabledTooltip", () => {
  const defaults = { isDirty: false, isSaving: false, hasConflictingSession: false };

  it("returns null when button is enabled", () => {
    expect(expandDisabledTooltip(defaults)).toBeNull();
  });

  it("returns save message when saving", () => {
    expect(expandDisabledTooltip({ ...defaults, isSaving: true })).toBe("Save in progress");
  });

  it("returns dirty message when form is dirty", () => {
    expect(expandDisabledTooltip({ ...defaults, isDirty: true })).toBe("Save your changes first");
  });

  it("returns session message when conflicting session", () => {
    expect(expandDisabledTooltip({ ...defaults, hasConflictingSession: true })).toBe("Another session is active");
  });

  it("prioritizes isSaving over isDirty", () => {
    expect(expandDisabledTooltip({ isDirty: true, isSaving: true, hasConflictingSession: false })).toBe("Save in progress");
  });

  it("prioritizes isDirty over hasConflictingSession", () => {
    expect(expandDisabledTooltip({ isDirty: true, isSaving: false, hasConflictingSession: true })).toBe("Save your changes first");
  });
});

// ---------------------------------------------------------------------------
// startReasonDisplayText
// ---------------------------------------------------------------------------
describe("startReasonDisplayText", () => {
  it("returns null for null reason", () => {
    expect(startReasonDisplayText(null)).toBeNull();
  });

  it("returns null for undefined reason", () => {
    expect(startReasonDisplayText(undefined)).toBeNull();
  });

  it("maps tasks_file_missing to user-friendly text", () => {
    expect(startReasonDisplayText("tasks_file_missing")).toBe("Tasks file not found");
  });

  it("maps tasks_file_invalid to user-friendly text", () => {
    expect(startReasonDisplayText("tasks_file_invalid")).toBe("Tasks file is invalid");
  });

  it("maps task_not_found to user-friendly text", () => {
    expect(startReasonDisplayText("task_not_found")).toBe("Task not found");
  });

  it("maps task_not_pending to user-friendly text", () => {
    expect(startReasonDisplayText("task_not_pending")).toBe("Task is not in pending status");
  });

  it("maps task_has_subtasks to user-friendly text", () => {
    expect(startReasonDisplayText("task_has_subtasks")).toBe("Task already has subtasks");
  });

  it("maps git_not_repo to user-friendly text", () => {
    expect(startReasonDisplayText("git_not_repo")).toBe("Not a git repository");
  });

  it("maps tasks_file_untracked to user-friendly text", () => {
    expect(startReasonDisplayText("tasks_file_untracked")).toBe("Tasks file is not tracked by git");
  });

  it("maps git_identity_missing to user-friendly text", () => {
    expect(startReasonDisplayText("git_identity_missing")).toBe("Git user identity not configured (set user.name and user.email)");
  });

  it("maps tasks_file_dirty to user-friendly text", () => {
    expect(startReasonDisplayText("tasks_file_dirty")).toBe("Tasks file has uncommitted changes");
  });

  it("maps active_session to user-friendly text", () => {
    expect(startReasonDisplayText("active_session")).toBe("Another session is already active");
  });

  it("maps task_mismatch to user-friendly text", () => {
    expect(startReasonDisplayText("task_mismatch")).toBe("Expand session is active for a different task");
  });

  it("humanises unknown reason codes", () => {
    expect(startReasonDisplayText("some_new_code")).toBe("Some new code");
  });

  it("capitalises first letter of unknown codes", () => {
    expect(startReasonDisplayText("custom_reason")).toBe("Custom reason");
  });

  it("returns null for empty string reason", () => {
    expect(startReasonDisplayText("")).toBeNull();
  });
});
