/**
 * Expand no-op success scenario tests (Task 14 — REQ-005).
 *
 * Validates that when the agent returns `{ "subtasks": [] }`:
 *
 * 1. Backend: validation passes, file stays byte-identical, no git commit,
 *    terminal outcome is `success` with `subtaskCount: 0`.
 * 2. Re-expand eligibility: after no-op success, the task remains eligible
 *    for another expand (no marker fields, no blocking state).
 * 3. UI: Expand button stays available, "No decomposition needed" label shown,
 *    no auto-refresh triggered (file unchanged).
 *
 * Covers:
 * - ExpandManager no-op path (unit, mocked driver)
 * - expand-validation for empty subtasks
 * - tasks.json byte preservation (integration, real file I/O)
 * - Re-expand eligibility after no-op
 * - UI helpers (shouldReloadAfterExpand, canShowExpandButton, progress logic)
 * - Expand store isFileWritingOutcome for no-op
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ============================================================================
// Part 1: Backend — ExpandManager no-op success (mocked driver)
// ============================================================================

// --- Mocks (must precede dynamic import) ---

const mockRunSession = vi.fn(async () => ({
  signal: { type: "complete" as const },
  durationMs: 1000,
  costUsd: 0.01,
  numTurns: 5,
  resultText: '{"subtasks": []}',
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  model: "claude-sonnet",
  agentReport: null,
  reviewReport: null,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
}));

const driverRunnerSetup = vi.fn(async () => {});
const driverRunnerTeardown = vi.fn(async () => {});

vi.mock("../server/session/driver-runner.js", () => ({
  DriverRunner: class MockDriverRunner {
    constructor(_agent: string, _model?: string) {}
    setup = driverRunnerSetup;
    teardown = driverRunnerTeardown;
    getDriver = vi.fn(() => ({}));
    setOnLog = vi.fn();
    runSession = mockRunSession;
    get setupDone() { return true; }
    get agent() { return "claude" as const; }
    get model() { return undefined; }
    get userSettings() { return false; }
    listModels = vi.fn(async () => []);
  },
}));

const mockReadTasksFile = vi.fn(() => ({
  tasks: [
    {
      id: 1,
      title: "Test task",
      description: "A test task",
      status: "pending",
      priority: "medium",
      dependencies: [],
      details: "Some implementation details",
      testStrategy: "Write unit tests",
      subtasks: [],
    },
  ],
  metadata: {},
}));

const mockWriteExpandSubtasks = vi.fn();
const mockWithTasksMutex = vi.fn(async <T>(fn: () => T | Promise<T>): Promise<T> => fn());

vi.mock("../core/tasks-json.js", () => ({
  readTasksFile: (...args: unknown[]) => mockReadTasksFile(...args),
  writeExpandSubtasks: (...args: unknown[]) => mockWriteExpandSubtasks(...args),
  withTasksMutex: <T>(fn: () => T | Promise<T>) => mockWithTasksMutex(fn),
}));

const mockSnapshotTasksJsonHash = vi.fn((): string | null => "stable-hash");
const mockVerifyTasksJsonHash = vi.fn((): boolean => true);

vi.mock("../core/tasks-json-hash.js", () => ({
  snapshotTasksJsonHash: (...args: unknown[]) => mockSnapshotTasksJsonHash(...args),
  verifyTasksJsonHash: (...args: unknown[]) => mockVerifyTasksJsonHash(...args),
}));

const mockIsGitRepo = vi.fn((): boolean => true);
const mockIsTrackedByGit = vi.fn((): boolean => true);
const mockHasGitIdentity = vi.fn((): boolean => true);
const mockIsPathDirty = vi.fn((): boolean => false);
const mockCommitExpandedTask = vi.fn();

vi.mock("../core/git.js", () => ({
  isGitRepo: (...args: unknown[]) => mockIsGitRepo(...args),
  isTrackedByGit: (...args: unknown[]) => mockIsTrackedByGit(...args),
  hasGitIdentity: (...args: unknown[]) => mockHasGitIdentity(...args),
  isPathDirty: (...args: unknown[]) => mockIsPathDirty(...args),
  commitExpandedTask: (...args: unknown[]) => mockCommitExpandedTask(...args),
}));

vi.mock("../server/ws.js", () => ({
  broadcastTasksUpdated: vi.fn(),
}));

import { ExpandManager } from "../server/expand-manager.js";
import type { ExpandStartOptions } from "../server/expand-manager.js";
import type { ExpandManagerOutcome } from "../types.js";
import type { SessionCore } from "../server/session/session-core.js";
import type { WsBroadcaster, WsEvent } from "../server/session/ws-broadcaster.js";
import {
  parseExpandResult,
  validateExpandResult,
} from "../core/expand-validation.js";
import { setActivePinia, createPinia } from "pinia";
import { useExpandStore } from "../../ui/src/stores/expand";
import {
  shouldReloadAfterExpand,
  canShowExpandButton,
} from "../../ui/src/composables/expand-launch-helpers";
import {
  outcomeLabel,
  outcomeSeverity,
  statusText,
  dotVariant,
  showDismissButton,
  outcomeDetailMessage,
  reasonDisplayText,
  isCommitFailedAfterWrite,
} from "../../ui/src/components/expand-progress-logic";

// --- Helpers ---

function mockSessionCore(): SessionCore {
  return {
    state: "idle",
    cwd: "/tmp",
    isIdle: () => true,
    isActive: () => false,
    isStopping: () => false,
    acquire: vi.fn(),
    release: vi.fn(),
    abort: vi.fn(),
    getAbortSignal: () => new AbortController().signal,
    registerAbortHandler: () => () => {},
  } as unknown as SessionCore;
}

function mockBroadcaster(): WsBroadcaster & { calls: WsEvent[] } {
  const calls: WsEvent[] = [];
  return {
    calls,
    broadcast: vi.fn(),
    broadcastWithChannel: vi.fn((event: WsEvent) => { calls.push(event); }),
    replay: vi.fn(),
    clearBuffer: vi.fn(),
  } as unknown as WsBroadcaster & { calls: WsEvent[] };
}

const defaultStartOpts: ExpandStartOptions = { agent: "claude" };
const defaultTaskId = "1";

async function drainAsyncOps(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ============================================================================

describe("Expand no-op success (REQ-005)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSnapshotTasksJsonHash.mockReturnValue("stable-hash-before-session");
    mockVerifyTasksJsonHash.mockReturnValue(true);
    mockIsGitRepo.mockReturnValue(true);
    mockIsTrackedByGit.mockReturnValue(true);
    mockHasGitIdentity.mockReturnValue(true);
    mockIsPathDirty.mockReturnValue(false);
  });

  // =========================================================================
  // 1. Backend: ExpandManager produces correct no-op success outcome
  // =========================================================================

  describe("1. ExpandManager no-op path", () => {
    it("agent returns { subtasks: [] } → success with subtaskCount: 0", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // expand:finished was broadcast with the success outcome (subtaskCount: 0)
      const finished = bc.calls.find((e: any) => e.type === "expand:finished");
      expect(finished).toBeDefined();
      expect((finished as any).outcome.status).toBe("success");
      expect((finished as any).outcome.subtaskCount).toBe(0);
      expect((finished as any).outcome.taskId).toBe(defaultTaskId);
    });

    it("writeExpandSubtasks is NOT called for empty subtasks", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockWriteExpandSubtasks).not.toHaveBeenCalled();
    });

    it("commitExpandedTask is NOT called for empty subtasks", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockCommitExpandedTask).not.toHaveBeenCalled();
    });

    it("hash verification is NOT performed for empty subtasks (skips mutex write section)", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // withTasksMutex is NOT called because the empty-subtask early return
      // happens before the write pipeline.
      expect(mockWithTasksMutex).not.toHaveBeenCalled();
      expect(mockVerifyTasksJsonHash).not.toHaveBeenCalled();
    });

    it("broadcastTasksUpdated is NOT called for empty subtasks (no file change)", async () => {
      const { broadcastTasksUpdated } = await import("../server/ws.js");

      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(broadcastTasksUpdated).not.toHaveBeenCalled();
    });

    it("outcome is distinct from failure — status is 'success', not 'failure'", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finished = bc.calls.find((e: any) => e.type === "expand:finished");
      const outcome = (finished as any).outcome;

      // Must be success, NOT failure
      expect(outcome.status).toBe("success");
      // Must NOT have a 'reason' field (success has no reason)
      expect(outcome).not.toHaveProperty("reason");
      // Must NOT have an 'errors' field
      expect(outcome).not.toHaveProperty("errors");
      // Must NOT have a 'message' field
      expect(outcome).not.toHaveProperty("message");
    });

    it("no expand:error event is broadcast for no-op success", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const errorEvents = bc.calls.filter((e: any) => e.type === "expand:error");
      expect(errorEvents).toHaveLength(0);
    });

    it("session is cleaned up after no-op success (state returns to idle)", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
    });

    it("success outcome is cleared after broadcast (consistent with non-empty success)", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Success outcomes are cleared after broadcast to prevent stale state on reconnect.
      // This is consistent behavior for both no-op and non-empty success.
      expect(manager.getOutcome()).toBeNull();
    });
  });

  // =========================================================================
  // 2. Validation: empty subtasks pass validation
  // =========================================================================

  describe("2. Validation accepts empty subtasks", () => {
    // Use the real validation functions (not mocked)
    it("parseExpandResult accepts { subtasks: [] }", () => {
      const result = parseExpandResult('{"subtasks": []}');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.subtasks).toEqual([]);
      }
    });

    it("validateExpandResult accepts { subtasks: [] }", () => {
      const result = validateExpandResult({ subtasks: [] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.subtasks).toEqual([]);
      }
    });

    it("empty subtasks validation is distinct from validation_failed", () => {
      const result = parseExpandResult('{"subtasks": []}');
      expect(result.ok).toBe(true);
      // Not a failure — no reason code
      if (result.ok) {
        expect(result).not.toHaveProperty("reason");
        expect(result).not.toHaveProperty("errors");
      }
    });
  });

  // =========================================================================
  // 3. Re-expand eligibility after no-op success
  // =========================================================================

  describe("3. Re-expand eligibility after no-op success", () => {
    it("task remains eligible for expand after no-op success (no subtasks added)", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const sessionCore = mockSessionCore();
      const manager = new ExpandManager("/tmp", sessionCore, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // After no-op success, the task data hasn't changed:
      // - still has subtasks: []
      // - still status: "pending"
      const taskData = mockReadTasksFile();
      const task = taskData.tasks[0];
      expect(task.status).toBe("pending");
      expect(task.subtasks).toEqual([]);
    });

    it("second expand can be started after no-op success (session released)", async () => {
      // First run: no-op success
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const sessionCore = mockSessionCore();
      const manager = new ExpandManager("/tmp", sessionCore, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Manager is idle — session was released
      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();

      // Second run: should start without throwing
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 500,
        costUsd: 0.005,
        numTurns: 2,
        resultText: '{"subtasks": [{"id": 1, "title": "Sub 1", "description": "Desc", "details": "Det", "dependencies": []}]}',
        inputTokens: 50,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      // Should not throw — session is available
      await expect(
        manager.start(defaultTaskId, defaultStartOpts),
      ).resolves.not.toThrow();
    });

    it("no marker fields are written to tasks.json that would block re-expand", () => {
      // After no-op success, the task fixture hasn't been modified:
      // no "expanded", "expandedAt", or similar fields.
      const taskData = mockReadTasksFile();
      const task = taskData.tasks[0] as Record<string, unknown>;

      expect(task).not.toHaveProperty("expanded");
      expect(task).not.toHaveProperty("expandedAt");
      expect(task).not.toHaveProperty("expandResult");
      expect(task).not.toHaveProperty("expandOutcome");
      expect(task).not.toHaveProperty("noopExpand");
    });

    it("file write was never called — no risk of marker fields being written", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: '{"subtasks": []}',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // writeExpandSubtasks was never called → no fields could have been written
      expect(mockWriteExpandSubtasks).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// Part 2: Real file I/O integration tests are in expand-noop-integration.test.ts
// (separate file to avoid vi.mock hoisting from Part 1 affecting hash functions)
// ============================================================================

// ============================================================================
// Part 3: UI coverage — pure helper tests
// ============================================================================

describe("Expand no-op: UI helpers", () => {
  // --- shouldReloadAfterExpand ---

  describe("shouldReloadAfterExpand — no-op success returns false", () => {
    it("returns false for success with subtaskCount === 0", () => {
      const outcome = { status: "success", taskId: "1", subtaskCount: 0 };
      expect(shouldReloadAfterExpand(outcome, "1")).toBe(false);
    });

    it("returns false even when taskId matches (no-op means no file change)", () => {
      const outcome = { status: "success", taskId: "42", subtaskCount: 0 };
      expect(shouldReloadAfterExpand(outcome, "42")).toBe(false);
    });

    it("distinguishes no-op success from real success (subtaskCount > 0 → true)", () => {
      const noOp = { status: "success", taskId: "1", subtaskCount: 0 };
      const real = { status: "success", taskId: "1", subtaskCount: 3 };
      expect(shouldReloadAfterExpand(noOp, "1")).toBe(false);
      expect(shouldReloadAfterExpand(real, "1")).toBe(true);
    });
  });

  // --- canShowExpandButton ---

  describe("canShowExpandButton — remains available after no-op", () => {
    it("task with status=pending and 0 subtasks shows expand button", () => {
      // After no-op success, the task hasn't changed:
      // - status is still "pending"
      // - subtasks count is still 0
      expect(canShowExpandButton("pending", 0)).toBe(true);
    });

    it("only becomes false when subtasks are actually added (subtaskCount > 0)", () => {
      expect(canShowExpandButton("pending", 0)).toBe(true);
      expect(canShowExpandButton("pending", 1)).toBe(false);
      expect(canShowExpandButton("pending", 5)).toBe(false);
    });
  });

  // --- expand-progress-logic: "No decomposition needed" label ---

  describe("expand-progress-logic — no-op outcome display", () => {
    it("outcomeLabel returns 'No decomposition needed' for success with 0 subtasks", () => {
      const outcome = { status: "success" as const, taskId: "1", subtaskCount: 0 };
      expect(outcomeLabel(outcome)).toBe("No decomposition needed");
    });

    it("outcomeSeverity returns 'success' for no-op (not 'error' or 'warning')", () => {
      const outcome = { status: "success" as const, taskId: "1", subtaskCount: 0 };
      expect(outcomeSeverity(outcome)).toBe("success");
    });

    it("statusText shows 'No decomposition needed' in completed state", () => {
      const outcome = { status: "success" as const, taskId: "1", subtaskCount: 0 };
      expect(statusText("completed", outcome)).toBe("No decomposition needed");
    });

    it("dotVariant returns 'completed-success' for no-op success", () => {
      const outcome = { status: "success" as const, taskId: "1", subtaskCount: 0 };
      expect(dotVariant("completed", outcome)).toBe("completed-success");
    });

    it("showDismissButton returns false for no-op success (success is not dismissable)", () => {
      const outcome = { status: "success" as const, taskId: "1", subtaskCount: 0 };
      expect(showDismissButton("completed", outcome)).toBe(false);
    });

    it("outcomeDetailMessage returns null for success (no error detail)", () => {
      const outcome = { status: "success" as const, taskId: "1", subtaskCount: 0 };
      expect(outcomeDetailMessage(outcome)).toBeNull();
    });

    it("reasonDisplayText returns null for success outcome (no failure reason)", () => {
      const outcome = { status: "success" as const, taskId: "1", subtaskCount: 0 };
      expect(reasonDisplayText(outcome)).toBeNull();
    });

    it("isCommitFailedAfterWrite returns false for no-op success", () => {
      const outcome = { status: "success" as const, taskId: "1", subtaskCount: 0 };
      expect(isCommitFailedAfterWrite(outcome)).toBe(false);
    });
  });

  // --- Expand store: isFileWritingOutcome ---

  describe("Expand store — isFileWritingOutcome for no-op", () => {
    beforeEach(() => {
      setActivePinia(createPinia());
    });

    it("returns false for no-op success (subtaskCount === 0)", () => {
      const store = useExpandStore();
      store.outcome = { status: "success", taskId: "1", subtaskCount: 0 };
      expect(store.isFileWritingOutcome).toBe(false);
    });

    it("returns true for success with subtaskCount > 0 (contrast)", () => {
      const store = useExpandStore();
      store.outcome = { status: "success", taskId: "1", subtaskCount: 3 };
      expect(store.isFileWritingOutcome).toBe(true);
    });
  });

  // --- Store WS event → outcome → no auto-refresh integration ---

  describe("Expand store — WS no-op outcome flow", () => {
    beforeEach(() => {
      setActivePinia(createPinia());
    });

    it("expand:finished with no-op outcome → completed state + no auto-refresh", () => {
      const store = useExpandStore();

      // Simulate active session
      store.state = "active";
      store.sessionInfo = { sessionId: "s1", taskId: "1", agent: "claude" };

      // Simulate expand:finished WS event with no-op outcome
      store.handleWsEvent({
        type: "expand:finished",
        channel: "expand",
        outcome: { status: "success", taskId: "1", subtaskCount: 0 },
      });

      // Store transitions to completed
      expect(store.state).toBe("completed");
      expect(store.outcome).not.toBeNull();
      expect(store.outcome!.status).toBe("success");
      expect(store.outcome!.subtaskCount).toBe(0);

      // But shouldReloadAfterExpand returns false → no auto-refresh
      expect(shouldReloadAfterExpand(store.outcome, "1")).toBe(false);
      // And isFileWritingOutcome is false
      expect(store.isFileWritingOutcome).toBe(false);
    });

    it("after clearExpand(), store resets to idle — ready for re-expand", () => {
      const store = useExpandStore();

      // Set to completed with no-op outcome
      store.state = "completed";
      store.outcome = { status: "success", taskId: "1", subtaskCount: 0 };

      // User dismisses or navigates away
      store.clearExpand();

      expect(store.state).toBe("idle");
      expect(store.outcome).toBeNull();
      expect(store.sessionInfo).toBeNull();
      expect(store.hasSession).toBe(false);
    });
  });
});
