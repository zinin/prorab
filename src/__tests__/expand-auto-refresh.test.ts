/**
 * Tests for expand auto-refresh after file-writing outcomes.
 *
 * Covers:
 * - Pure helper `shouldReloadAfterExpand()` — unit tests for all outcome permutations
 * - Expand store `isFileWritingOutcome` — covers both success+subtasks and commit_failed_after_write
 * - TaskDetailView watcher behaviour — source-level checks via store/composable integration
 *   (no DOM rendering needed; we exercise the watcher logic through the expand store)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useExpandStore } from "../../ui/src/stores/expand";
import type { ExpandOutcome } from "../../ui/src/stores/expand";
import { shouldReloadAfterExpand } from "../../ui/src/composables/expand-launch-helpers";

// ---------------------------------------------------------------------------
// shouldReloadAfterExpand — pure helper unit tests
// ---------------------------------------------------------------------------

describe("shouldReloadAfterExpand", () => {
  const TASK_ID = "7";

  // --- Success outcomes ---

  it("returns true for success with subtaskCount > 0 targeting current task", () => {
    const outcome: ExpandOutcome = { status: "success", taskId: TASK_ID, subtaskCount: 4 };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(true);
  });

  it("returns false for success with subtaskCount === 0 (no-op, file byte-identical)", () => {
    const outcome: ExpandOutcome = { status: "success", taskId: TASK_ID, subtaskCount: 0 };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(false);
  });

  it("returns false for success targeting a DIFFERENT task", () => {
    const outcome: ExpandOutcome = { status: "success", taskId: "99", subtaskCount: 5 };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(false);
  });

  // --- Failure: commit_failed_after_write ---

  it("returns true for commit_failed_after_write targeting current task", () => {
    const outcome: ExpandOutcome = {
      status: "failure",
      taskId: TASK_ID,
      reason: "commit_failed_after_write",
      errors: ["git commit failed"],
      message: "git commit failed",
      subtaskCount: 0,
    };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(true);
  });

  it("returns false for commit_failed_after_write targeting a DIFFERENT task", () => {
    const outcome: ExpandOutcome = {
      status: "failure",
      taskId: "99",
      reason: "commit_failed_after_write",
      errors: ["git commit failed"],
      message: "git commit failed",
      subtaskCount: 0,
    };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(false);
  });

  // --- Other failure reasons (no file write) ---

  it("returns false for agent_failed failure", () => {
    const outcome: ExpandOutcome = {
      status: "failure",
      taskId: TASK_ID,
      reason: "agent_failed",
      errors: ["Agent crashed"],
      message: "Agent crashed",
      subtaskCount: 0,
    };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(false);
  });

  it("returns false for hash_conflict failure", () => {
    const outcome: ExpandOutcome = {
      status: "failure",
      taskId: TASK_ID,
      reason: "hash_conflict",
      errors: ["tasks.json changed"],
      message: "tasks.json changed",
      subtaskCount: 0,
    };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(false);
  });

  it("returns false for result_parse_failed failure", () => {
    const outcome: ExpandOutcome = {
      status: "failure",
      taskId: TASK_ID,
      reason: "result_parse_failed",
      errors: ["No JSON found"],
      message: "No JSON found",
      subtaskCount: 0,
    };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(false);
  });

  // --- Cancelled outcomes ---

  it("returns false for cancelled outcome", () => {
    const outcome: ExpandOutcome = { status: "cancelled", taskId: TASK_ID, subtaskCount: 0 };
    expect(shouldReloadAfterExpand(outcome, TASK_ID)).toBe(false);
  });

  // --- null outcome ---

  it("returns false for null outcome", () => {
    expect(shouldReloadAfterExpand(null, TASK_ID)).toBe(false);
  });

  // --- Edge: empty taskId ---

  it("returns false when currentTaskId is empty", () => {
    const outcome: ExpandOutcome = { status: "success", taskId: "7", subtaskCount: 3 };
    expect(shouldReloadAfterExpand(outcome, "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Expand store: isFileWritingOutcome computed
// ---------------------------------------------------------------------------

describe("isFileWritingOutcome (expanded coverage)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("returns true for success with subtaskCount > 0", () => {
    const store = useExpandStore();
    store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };
    expect(store.isFileWritingOutcome).toBe(true);
  });

  it("returns false for success with subtaskCount === 0", () => {
    const store = useExpandStore();
    store.outcome = { status: "success", taskId: "7", subtaskCount: 0 };
    expect(store.isFileWritingOutcome).toBe(false);
  });

  it("returns true for failure with commit_failed_after_write reason", () => {
    const store = useExpandStore();
    store.outcome = {
      status: "failure",
      taskId: "7",
      reason: "commit_failed_after_write",
      errors: ["git commit failed"],
      message: "git commit failed",
      subtaskCount: 0,
    };
    expect(store.isFileWritingOutcome).toBe(true);
  });

  it("returns false for failure with agent_failed reason", () => {
    const store = useExpandStore();
    store.outcome = {
      status: "failure",
      taskId: "7",
      reason: "agent_failed",
      errors: ["err"],
      message: "err",
      subtaskCount: 0,
    };
    expect(store.isFileWritingOutcome).toBe(false);
  });

  it("returns false for failure with hash_conflict reason", () => {
    const store = useExpandStore();
    store.outcome = {
      status: "failure",
      taskId: "7",
      reason: "hash_conflict",
      errors: ["conflict"],
      message: "conflict",
      subtaskCount: 0,
    };
    expect(store.isFileWritingOutcome).toBe(false);
  });

  it("returns false for cancelled outcome", () => {
    const store = useExpandStore();
    store.outcome = { status: "cancelled", taskId: "7", subtaskCount: 0 };
    expect(store.isFileWritingOutcome).toBe(false);
  });

  it("returns false when outcome is null", () => {
    const store = useExpandStore();
    expect(store.isFileWritingOutcome).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Store/composable integration: expand:finished event → outcome → shouldReloadAfterExpand
//
// This suite simulates the WS event → store update → watcher evaluation chain
// that TaskDetailView uses for auto-refresh. Instead of mounting the component,
// we exercise the same sequence programmatically.
// ---------------------------------------------------------------------------

describe("expand auto-refresh integration (store + helper)", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("success with subtasks → shouldReloadAfterExpand returns true for same task", () => {
    const store = useExpandStore();
    store.state = "active";
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude" };

    // Simulate expand:finished via WS
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 5 },
    });

    expect(store.outcome).not.toBeNull();
    expect(shouldReloadAfterExpand(store.outcome, "7")).toBe(true);
  });

  it("success with subtasks → shouldReloadAfterExpand returns false for different task", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 5 },
    });

    // Viewing task 8, expand finished for task 7
    expect(shouldReloadAfterExpand(store.outcome, "8")).toBe(false);
  });

  it("no-op success (subtaskCount=0) → no reload", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 0 },
    });

    expect(shouldReloadAfterExpand(store.outcome, "7")).toBe(false);
  });

  it("commit_failed_after_write → reload for same task", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "failure",
        taskId: "7",
        reason: "commit_failed_after_write",
        errors: ["git commit failed: exit 1"],
        message: "Subtasks written to disk but git commit failed",
        subtaskCount: 0,
      },
    });

    expect(store.outcome).not.toBeNull();
    expect(shouldReloadAfterExpand(store.outcome, "7")).toBe(true);
    // isFileWritingOutcome should also be true
    expect(store.isFileWritingOutcome).toBe(true);
  });

  it("commit_failed_after_write → no reload for different task", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "failure",
        taskId: "7",
        reason: "commit_failed_after_write",
        errors: ["git commit failed"],
        message: "git commit failed",
        subtaskCount: 0,
      },
    });

    expect(shouldReloadAfterExpand(store.outcome, "99")).toBe(false);
  });

  it("agent_failed failure → no reload", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "failure",
        taskId: "7",
        reason: "agent_failed",
        errors: ["Agent crashed"],
        message: "Agent crashed",
        subtaskCount: 0,
      },
    });

    expect(shouldReloadAfterExpand(store.outcome, "7")).toBe(false);
    expect(store.isFileWritingOutcome).toBe(false);
  });

  it("cancelled → no reload", () => {
    const store = useExpandStore();
    store.state = "stopping";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "cancelled", taskId: "7", subtaskCount: 0 },
    });

    expect(shouldReloadAfterExpand(store.outcome, "7")).toBe(false);
    expect(store.isFileWritingOutcome).toBe(false);
  });

  // --- Dedup: same outcome twice should not require new fingerprint ---

  it("shouldReloadAfterExpand is idempotent — same outcome returns same result", () => {
    const outcome: ExpandOutcome = { status: "success", taskId: "7", subtaskCount: 3 };
    // Call twice — should return the same result
    expect(shouldReloadAfterExpand(outcome, "7")).toBe(true);
    expect(shouldReloadAfterExpand(outcome, "7")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Source-level checks for TaskDetailView watcher logic
// ---------------------------------------------------------------------------

describe("TaskDetailView watcher (source-level checks)", () => {
  /**
   * These tests read TaskDetailView.vue source code to verify the watcher
   * is correctly wired. They serve as regression guards: if someone removes
   * the shouldReloadAfterExpand call or the dedup guard, these fail.
   */

  let viewSource: string;

  beforeEach(async () => {
    // Read the source file for structural assertions
    const { readFileSync } = await import("node:fs");
    viewSource = readFileSync(
      new URL("../../ui/src/views/TaskDetailView.vue", import.meta.url),
      "utf-8",
    );
  });

  it("imports shouldReloadAfterExpand from expand-launch-helpers", () => {
    expect(viewSource).toContain("shouldReloadAfterExpand");
    expect(viewSource).toContain("expand-launch-helpers");
  });

  it("outcome watcher uses shouldReloadAfterExpand with currentTaskId", () => {
    expect(viewSource).toContain("shouldReloadAfterExpand(outcome, currentTaskId.value)");
  });

  it("has dedup guard via lastReloadedOutcomeRef", () => {
    expect(viewSource).toContain("lastReloadedOutcomeRef");
  });

  it("calls loadTask() on file-writing outcome", () => {
    // The watcher should call loadTask() after the shouldReloadAfterExpand check
    expect(viewSource).toMatch(/shouldReloadAfterExpand[\s\S]*?loadTask\(\)/);
  });

  it("shows toast warning for commit_failed_after_write", () => {
    expect(viewSource).toContain("commit_failed_after_write");
    expect(viewSource).toContain("Git commit failed");
  });

  it("does NOT have the old bare success check (migrated to shouldReloadAfterExpand)", () => {
    // The old watcher: `if (outcome?.status === "success" && outcome.subtaskCount > 0)`
    // should no longer exist as a standalone condition in the watcher.
    // shouldReloadAfterExpand encapsulates this logic.
    expect(viewSource).not.toMatch(
      /watch\(\(\) => expandStore\.outcome[\s\S]*?outcome\?\.status === "success" && outcome\.subtaskCount > 0[\s\S]*?loadTask/,
    );
  });
});
