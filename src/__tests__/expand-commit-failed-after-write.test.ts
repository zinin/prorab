/**
 * Post-write failure tests for `commit_failed_after_write` scenario.
 *
 * This is an important edge case: the file has already been written with new
 * subtasks, but the git commit (stage + commit) failed. From the file's
 * perspective the task is already expanded, but the operation is reported as a
 * failure so the user knows the commit didn't happen.
 *
 * Coverage:
 *   1. Backend unit tests — ExpandManager produces correct outcome when
 *      commitExpandedTask throws (git add or git commit failure).
 *   2. No rollback — writeExpandSubtasks was called (write happened).
 *   3. Broadcast events — `expand:error` + `expand:finished` carry the correct
 *      reason/message with human-readable detail.
 *   4. Post-failure state — manager returns to idle, failure outcome persists,
 *      can restart cleanly.
 *   5. Varied git failure types — staging failures, pre-commit hooks, I/O errors.
 *   6. Post-failure re-expand blocking: writeExpandSubtasks mutates the
 *      readTasksFile mock so it returns subtasks, then the route-level
 *      `task_has_subtasks` condition (task.subtasks.length > 0) is asserted.
 *      Full route-level blocking is covered by routes-expand.test.ts.
 *   7. UI coverage — expand store, isFileWritingOutcome, shouldReloadAfterExpand,
 *      ExpandProgress helpers, store→composable pipeline test (watcher decision
 *      path), TaskDetailView source-level structural checks.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===========================================================================
// Mock DriverRunner
// ===========================================================================

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

const driverRunnerSetup = vi.fn(async (_opts: any, _onLog?: (event: any) => void) => {});
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

// ===========================================================================
// Mock tasks-json
// ===========================================================================

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

// ===========================================================================
// Mock tasks-json-hash
// ===========================================================================

const mockSnapshotTasksJsonHash = vi.fn((): string | null => "abc123hash");
const mockVerifyTasksJsonHash = vi.fn((): boolean => true);

vi.mock("../core/tasks-json-hash.js", () => ({
  snapshotTasksJsonHash: (...args: unknown[]) => mockSnapshotTasksJsonHash(...args),
  verifyTasksJsonHash: (...args: unknown[]) => mockVerifyTasksJsonHash(...args),
}));

// ===========================================================================
// Mock git
// ===========================================================================

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

// ===========================================================================
// Imports (after mocks)
// ===========================================================================

import { ExpandManager } from "../server/expand-manager.js";
import type { ExpandStartOptions } from "../server/expand-manager.js";
import type { ExpandManagerOutcome } from "../types.js";
import type { SessionCore } from "../server/session/session-core.js";
import type { WsBroadcaster, WsEvent } from "../server/session/ws-broadcaster.js";

/** Failure variant of the discriminated ExpandManagerOutcome union. */
type ExpandFailure = Extract<ExpandManagerOutcome, { status: "failure" }>;

// ===========================================================================
// Helpers
// ===========================================================================

function mockSessionCore(overrides: Partial<SessionCore> = {}): SessionCore {
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
    ...overrides,
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
  // Multiple ticks to ensure all microtasks and promise continuations resolve
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function sessionResult(
  signal: { type: string; reason?: string; message?: string },
  resultText = '{"subtasks": []}',
) {
  return {
    signal,
    durationMs: 1000,
    costUsd: 0.01,
    numTurns: 5,
    resultText,
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
  };
}

const VALID_SUBTASKS_JSON = JSON.stringify({
  subtasks: [
    { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
    { id: 2, title: "Sub 2", description: "Desc 2", details: "Details 2", dependencies: [1] },
    { id: 3, title: "Sub 3", description: "Desc 3", details: "Details 3", dependencies: [1, 2] },
  ],
});

/** Reset all mocks to consistent defaults for each test. */
function resetAllMockDefaults(): void {
  vi.clearAllMocks();
  mockSnapshotTasksJsonHash.mockReturnValue("stable-hash");
  mockVerifyTasksJsonHash.mockReturnValue(true);
  mockIsGitRepo.mockReturnValue(true);
  mockIsTrackedByGit.mockReturnValue(true);
  mockHasGitIdentity.mockReturnValue(true);
  mockIsPathDirty.mockReturnValue(false);
  mockCommitExpandedTask.mockReset();
}

// ===========================================================================
// Part 1: Backend unit tests — ExpandManager with mocked dependencies
// ===========================================================================

describe("commit_failed_after_write — backend unit tests", () => {
  beforeEach(resetAllMockDefaults);

  // =========================================================================
  // 1. Core scenario: commit throws after successful write
  // =========================================================================

  describe("1. Outcome correctness", () => {
    it("outcome.status === 'failure' when commitExpandedTask throws", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("git commit failed: permission denied");
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome).not.toBeNull();
      expect(outcome!.status).toBe("failure");
    });

    it("outcome.reason === 'commit_failed_after_write'", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("fatal: could not write commit object");
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome()!;
      expect(outcome.status).toBe("failure");
      expect((outcome as ExpandFailure).reason).toBe("commit_failed_after_write");
    });

    it("outcome.message includes the git error detail", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("git commit failed: exit code 128");
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome()!;
      expect(outcome.status).toBe("failure");
      expect((outcome as ExpandFailure).message).toContain("exit code 128");
    });

    it("outcome.message includes 'not committed to git' disclaimer", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("fatal: unable to auto-detect email address");
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome()!;
      expect(outcome.status).toBe("failure");
      expect((outcome as ExpandFailure).message).toContain("not committed to git");
    });

    it("outcome.taskId matches the requested task", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getOutcome()!.taskId).toBe("1");
    });

    it("handles non-Error throw (string) in commitExpandedTask", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw "unexpected string error from git";
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome()!;
      expect(outcome.status).toBe("failure");
      const failure = outcome as ExpandFailure;
      expect(failure.reason).toBe("commit_failed_after_write");
      expect(failure.message).toContain("unexpected string error from git");
    });

    it("git add failure (staging) → commit_failed_after_write", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("fatal: pathspec 'tasks.json' did not match any files");
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome()!;
      expect(outcome.status).toBe("failure");
      const failure = outcome as ExpandFailure;
      expect(failure.reason).toBe("commit_failed_after_write");
      expect(failure.message).toContain("pathspec");
    });

    it("pre-commit hook failure → commit_failed_after_write", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("pre-commit hook exited with status 1");
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome()!;
      expect(outcome.status).toBe("failure");
      const failure = outcome as ExpandFailure;
      expect(failure.reason).toBe("commit_failed_after_write");
      expect(failure.message).toContain("pre-commit hook");
    });

    it("disk full / I/O error → commit_failed_after_write", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("error: insufficient permission for adding an object to repository database");
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome()!;
      expect(outcome.status).toBe("failure");
      const failure = outcome as ExpandFailure;
      expect(failure.reason).toBe("commit_failed_after_write");
      expect(failure.message).toContain("insufficient permission");
    });
  });

  // =========================================================================
  // 2. No rollback — write DID happen before commit attempt
  // =========================================================================

  describe("2. No rollback guarantee", () => {
    it("writeExpandSubtasks was called before commit failed", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockWriteExpandSubtasks).toHaveBeenCalledOnce();
      expect(mockWriteExpandSubtasks).toHaveBeenCalledWith(
        "/tmp",
        "1",
        expect.arrayContaining([
          expect.objectContaining({ id: 1, title: "Sub 1" }),
          expect.objectContaining({ id: 2, title: "Sub 2" }),
          expect.objectContaining({ id: 3, title: "Sub 3" }),
        ]),
      );
    });

    it("commitExpandedTask was called (but threw)", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockCommitExpandedTask).toHaveBeenCalledOnce();
      expect(mockCommitExpandedTask).toHaveBeenCalledWith("/tmp", "1", 3);
    });

    it("write happens before commit — call order verified", async () => {
      const callOrder: string[] = [];
      mockWriteExpandSubtasks.mockImplementation(() => {
        callOrder.push("write");
      });
      mockCommitExpandedTask.mockImplementation(() => {
        callOrder.push("commit");
        throw new Error("fail");
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(callOrder).toEqual(["write", "commit"]);
    });
  });

  // =========================================================================
  // 3. Broadcast events
  // =========================================================================

  describe("3. Broadcast events", () => {
    it("expand:finished carries correct reason in outcome", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("git failed"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finishedEvt = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finishedEvt).toBeDefined();
      expect(finishedEvt!.outcome).toBeDefined();
      expect(finishedEvt!.outcome.status).toBe("failure");
      expect(finishedEvt!.outcome.reason).toBe("commit_failed_after_write");
    });

    it("expand:error is broadcast with human-readable message before expand:finished", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("permission denied"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const errorIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:error");
      const finishedIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:finished");
      expect(errorIdx).toBeGreaterThanOrEqual(0);
      expect(finishedIdx).toBeGreaterThan(errorIdx);

      // Error event carries the reason
      const errorEvt = bc.calls[errorIdx]!;
      expect(errorEvt.reason).toBe("commit_failed_after_write");
    });

    it("expand:finished outcome includes message with git error detail", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("hook failed: pre-commit"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finishedEvt = bc.calls.find((e: WsEvent) => e.type === "expand:finished")!;
      expect(finishedEvt.outcome.message).toContain("hook failed: pre-commit");
      expect(finishedEvt.outcome.message).toContain("not committed to git");
    });

    it("exactly one expand:finished event is broadcast", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finishedEvents = bc.calls.filter((e: WsEvent) => e.type === "expand:finished");
      expect(finishedEvents).toHaveLength(1);
    });

    it("expand:started precedes expand:error and expand:finished", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const startedIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:started");
      const errorIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:error");
      const finishedIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:finished");

      expect(startedIdx).toBeGreaterThanOrEqual(0);
      expect(errorIdx).toBeGreaterThan(startedIdx);
      expect(finishedIdx).toBeGreaterThan(errorIdx);
    });
  });

  // =========================================================================
  // 4. Post-failure state and cleanup
  // =========================================================================

  describe("4. Post-failure state and cleanup", () => {
    it("manager state returns to idle after commit failure", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
      expect(sc.release).toHaveBeenCalled();
    });

    it("driver is torn down after commit failure", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(driverRunnerTeardown).toHaveBeenCalled();
    });

    it("failure outcome persists after session cleanup (not cleared like success)", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Failure outcomes persist (unlike success which is cleared)
      expect(manager.getOutcome()).not.toBeNull();
      expect(manager.getOutcome()!.status).toBe("failure");
      expect((manager.getOutcome() as ExpandFailure).reason).toBe("commit_failed_after_write");
    });

    it("can restart after commit_failed_after_write without stale state", async () => {
      // First session: commit failure
      mockCommitExpandedTask.mockImplementationOnce(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getOutcome()!.status).toBe("failure");

      // Second session: successful (empty subtasks)
      mockCommitExpandedTask.mockReset();
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": []}'),
      );

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // New session completed — previous failure gone
      expect(manager.getState()).toBe("idle");
    });
  });

  // =========================================================================
  // 5. Post-failure re-expand blocking
  // =========================================================================

  describe("5. Post-failure re-expand blocking", () => {
    it("after commit_failed_after_write, task now has subtasks in the file", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Write WAS called — the file has subtasks now
      expect(mockWriteExpandSubtasks).toHaveBeenCalledOnce();

      // Outcome confirms failure, not success
      const outcome = manager.getOutcome()!;
      expect(outcome.status).toBe("failure");
      expect((outcome as ExpandFailure).reason).toBe("commit_failed_after_write");

      // Write was called — the file has subtasks on disk now.
      // Route-level re-expand blocking (task_has_subtasks) is covered by
      // routes-expand.test.ts; the test below ("re-expand is blocked…")
      // verifies the condition that the route checks.
    });

    it("writeExpandSubtasks receives all 3 subtasks — file is fully modified", async () => {
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Verify the exact subtasks that were written
      const writtenSubtasks = mockWriteExpandSubtasks.mock.calls[0]![2] as any[];
      expect(writtenSubtasks).toHaveLength(3);
      expect(writtenSubtasks[0]).toMatchObject({ id: 1, title: "Sub 1" });
      expect(writtenSubtasks[1]).toMatchObject({ id: 2, title: "Sub 2", dependencies: [1] });
      expect(writtenSubtasks[2]).toMatchObject({ id: 3, title: "Sub 3", dependencies: [1, 2] });
    });

    it("re-expand is blocked: readTasksFile returns subtasks after write, satisfying route-level task_has_subtasks check", async () => {
      // Simulate writeExpandSubtasks mutating the file: after write, readTasksFile
      // should return the task WITH subtasks. This directly exercises the condition
      // that the route checks: `task.subtasks && task.subtasks.length > 0`.
      mockWriteExpandSubtasks.mockImplementation(() => {
        // After write, readTasksFile reflects the new subtasks on disk
        mockReadTasksFile.mockReturnValue({
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
              subtasks: [
                { id: 1, title: "Sub 1", description: "Desc 1", status: "pending", dependencies: [] },
                { id: 2, title: "Sub 2", description: "Desc 2", status: "pending", dependencies: [1] },
                { id: 3, title: "Sub 3", description: "Desc 3", status: "pending", dependencies: [1, 2] },
              ],
            },
          ],
          metadata: {},
        });
      });
      mockCommitExpandedTask.mockImplementation(() => { throw new Error("fail"); });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, VALID_SUBTASKS_JSON),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getOutcome()!.status).toBe("failure");

      // After commit_failed_after_write, readTasksFile now returns the task with
      // subtasks — exactly as the route-level check would see it.
      const data = mockReadTasksFile("/tmp");
      const task = data.tasks.find((t: any) => String(t.id) === "1");
      expect(task).toBeDefined();
      expect(task!.subtasks).toBeDefined();
      expect(task!.subtasks.length).toBeGreaterThan(0);

      // This is the exact condition from routes/expand.ts line 110:
      //   if (task.subtasks && task.subtasks.length > 0) → 409 task_has_subtasks
      // Route-level test coverage is in routes-expand.test.ts.
    });
  });
});

// ===========================================================================
// Part 2: UI coverage — store, composable, ExpandProgress logic
// ===========================================================================

describe("commit_failed_after_write — UI coverage", () => {
  // =========================================================================
  // 2a. Expand store: WS event handling and isFileWritingOutcome
  // =========================================================================

  describe("expand store integration", () => {
    beforeEach(async () => {
      const { setActivePinia, createPinia } = await import("pinia");
      setActivePinia(createPinia());
    });

    it("store transitions to completed with commit_failed_after_write outcome via WS", async () => {
      const { useExpandStore } = await import("../../ui/src/stores/expand");
      const store = useExpandStore();

      // Simulate active session
      store.handleWsEvent({
        type: "expand:started",
        channel: "expand",
        sessionId: "test-sess",
        taskId: "1",
        agent: "claude",
      });
      expect(store.state).toBe("active");

      // Simulate expand:error (server sends this before expand:finished)
      store.handleWsEvent({
        type: "expand:error",
        channel: "expand",
        message: "Subtasks written to disk but git commit failed",
        reason: "commit_failed_after_write",
      });

      // Error is captured
      expect(store.error).toContain("git commit failed");

      // Simulate expand:finished with commit_failed_after_write
      store.handleWsEvent({
        type: "expand:finished",
        channel: "expand",
        outcome: {
          status: "failure",
          taskId: "1",
          reason: "commit_failed_after_write",
          errors: ["simulated git commit failure"],
          message: "Subtasks written to disk but git commit failed: simulated git commit failure. The subtasks are saved in .taskmaster/tasks/tasks.json but not committed to git.",
          subtaskCount: 0,
        },
      });

      expect(store.state).toBe("completed");
      expect(store.isCompleted).toBe(true);
      expect(store.outcome).not.toBeNull();
      expect(store.outcome!.status).toBe("failure");
      expect((store.outcome as ExpandFailure).reason).toBe("commit_failed_after_write");
      expect(store.sessionInfo).toBeNull(); // Cleared after finished
    });

    it("isFileWritingOutcome is true for commit_failed_after_write", async () => {
      const { useExpandStore } = await import("../../ui/src/stores/expand");
      const store = useExpandStore();

      store.handleWsEvent({
        type: "expand:finished",
        channel: "expand",
        outcome: {
          status: "failure",
          taskId: "1",
          reason: "commit_failed_after_write",
          errors: ["git error"],
          message: "git error",
          subtaskCount: 0,
        },
      });

      expect(store.isFileWritingOutcome).toBe(true);
    });

    it("belongsToTask matches for commit_failed_after_write outcome", async () => {
      const { useExpandStore } = await import("../../ui/src/stores/expand");
      const store = useExpandStore();

      store.handleWsEvent({
        type: "expand:finished",
        channel: "expand",
        outcome: {
          status: "failure",
          taskId: "7",
          reason: "commit_failed_after_write",
          errors: ["err"],
          message: "err",
          subtaskCount: 0,
        },
      });

      expect(store.belongsToTask("7")).toBe(true);
      expect(store.belongsToTask("99")).toBe(false);
    });

    it("store rehydrates commit_failed_after_write from WS connected message", async () => {
      const { useExpandStore } = await import("../../ui/src/stores/expand");
      const store = useExpandStore();

      store.rehydrateFromConnected({
        type: "connected",
        expandSession: null,
        expandOutcome: {
          status: "failure",
          taskId: "1",
          reason: "commit_failed_after_write",
          errors: ["git commit failed"],
          message: "Subtasks written but commit failed",
          subtaskCount: 0,
        },
      });

      expect(store.state).toBe("completed");
      expect(store.outcome).not.toBeNull();
      expect(store.outcome!.status).toBe("failure");
      expect((store.outcome as ExpandFailure).reason).toBe("commit_failed_after_write");
      expect(store.isFileWritingOutcome).toBe(true);
    });
  });

  // =========================================================================
  // 2a′. Full store → composable pipeline: simulates the watcher's decision
  //
  // The TaskDetailView watcher calls shouldReloadAfterExpand(store.outcome, taskId)
  // to decide whether to auto-reload. This test drives the store through the
  // complete WS event sequence, then feeds store.outcome to shouldReloadAfterExpand
  // to prove the watcher would trigger a reload + toast path for commit_failed_after_write.
  //
  // Note: @vue/test-utils is not a project dependency, so we cannot mount the
  // component and observe the actual Vue watcher firing. Source-level checks
  // in section 2e verify the watcher code structure exists.
  // =========================================================================

  describe("store → composable pipeline (watcher decision path)", () => {
    beforeEach(async () => {
      const { setActivePinia, createPinia } = await import("pinia");
      setActivePinia(createPinia());
    });

    it("full WS event sequence produces store state that triggers shouldReloadAfterExpand", async () => {
      const { useExpandStore } = await import("../../ui/src/stores/expand");
      const { shouldReloadAfterExpand } = await import(
        "../../ui/src/composables/expand-launch-helpers"
      );
      const store = useExpandStore();
      const currentTaskId = "1";

      // 1. expand:started — session begins
      store.handleWsEvent({
        type: "expand:started",
        channel: "expand",
        sessionId: "sess-cfaw",
        taskId: currentTaskId,
        agent: "claude",
      });
      expect(store.state).toBe("active");
      expect(shouldReloadAfterExpand(store.outcome, currentTaskId)).toBe(false);

      // 2. expand:error — server sends commit failure notification
      store.handleWsEvent({
        type: "expand:error",
        channel: "expand",
        message: "Subtasks written to disk but git commit failed: permission denied",
        reason: "commit_failed_after_write",
      });

      // 3. expand:finished — session ends with commit_failed_after_write
      store.handleWsEvent({
        type: "expand:finished",
        channel: "expand",
        outcome: {
          status: "failure",
          taskId: currentTaskId,
          reason: "commit_failed_after_write",
          errors: ["permission denied"],
          message: "Subtasks written to disk but git commit failed: permission denied. The subtasks are saved in .taskmaster/tasks/tasks.json but not committed to git.",
          subtaskCount: 3,
        },
      });

      // Store reached completed state
      expect(store.state).toBe("completed");
      expect(store.isFileWritingOutcome).toBe(true);

      // This is the exact check the TaskDetailView watcher performs:
      // shouldReloadAfterExpand(expandStore.outcome, currentTaskId.value)
      expect(shouldReloadAfterExpand(store.outcome, currentTaskId)).toBe(true);

      // The watcher then checks `o.reason === "commit_failed_after_write"` to
      // show a warning toast — verify the outcome has the correct reason.
      const outcome = store.outcome!;
      expect(outcome.status).toBe("failure");
      expect((outcome as ExpandFailure).reason).toBe("commit_failed_after_write");
      expect((outcome as ExpandFailure).message).toContain("not committed to git");
    });

    it("watcher would NOT reload for non-file-writing failures (negative case)", async () => {
      const { useExpandStore } = await import("../../ui/src/stores/expand");
      const { shouldReloadAfterExpand } = await import(
        "../../ui/src/composables/expand-launch-helpers"
      );
      const store = useExpandStore();

      store.handleWsEvent({
        type: "expand:finished",
        channel: "expand",
        outcome: {
          status: "failure",
          taskId: "1",
          reason: "hash_conflict",
          errors: ["file changed"],
          message: "Hash conflict",
          subtaskCount: 0,
        },
      });

      expect(store.state).toBe("completed");
      expect(store.isFileWritingOutcome).toBe(false);
      expect(shouldReloadAfterExpand(store.outcome, "1")).toBe(false);
    });
  });

  // =========================================================================
  // 2b. shouldReloadAfterExpand — commit_failed_after_write triggers reload
  // =========================================================================

  describe("shouldReloadAfterExpand for commit_failed_after_write", () => {
    it("returns true for commit_failed_after_write targeting current task", async () => {
      const { shouldReloadAfterExpand } = await import(
        "../../ui/src/composables/expand-launch-helpers"
      );

      expect(
        shouldReloadAfterExpand(
          {
            status: "failure",
            taskId: "1",
            reason: "commit_failed_after_write",
            subtaskCount: 3,
          },
          "1",
        ),
      ).toBe(true);
    });

    it("returns false for commit_failed_after_write targeting different task", async () => {
      const { shouldReloadAfterExpand } = await import(
        "../../ui/src/composables/expand-launch-helpers"
      );

      expect(
        shouldReloadAfterExpand(
          {
            status: "failure",
            taskId: "5",
            reason: "commit_failed_after_write",
            subtaskCount: 3,
          },
          "1",
        ),
      ).toBe(false);
    });

    it("distinguished from other failure reasons (no reload for those)", async () => {
      const { shouldReloadAfterExpand } = await import(
        "../../ui/src/composables/expand-launch-helpers"
      );

      // commit_failed_after_write → reload
      expect(
        shouldReloadAfterExpand(
          { status: "failure", taskId: "1", reason: "commit_failed_after_write", subtaskCount: 0 },
          "1",
        ),
      ).toBe(true);

      // agent_failed → no reload
      expect(
        shouldReloadAfterExpand(
          { status: "failure", taskId: "1", reason: "agent_failed", subtaskCount: 0 },
          "1",
        ),
      ).toBe(false);

      // hash_conflict → no reload
      expect(
        shouldReloadAfterExpand(
          { status: "failure", taskId: "1", reason: "hash_conflict", subtaskCount: 0 },
          "1",
        ),
      ).toBe(false);

      // validation_failed → no reload
      expect(
        shouldReloadAfterExpand(
          { status: "failure", taskId: "1", reason: "validation_failed", subtaskCount: 0 },
          "1",
        ),
      ).toBe(false);
    });
  });

  // =========================================================================
  // 2c. ExpandProgress logic — commit_failed_after_write specific display
  // =========================================================================

  describe("ExpandProgress logic for commit_failed_after_write", () => {
    it("isCommitFailedAfterWrite returns true for this reason code", async () => {
      const { isCommitFailedAfterWrite } = await import(
        "../../ui/src/components/expand-progress-logic"
      );
      const outcome = {
        status: "failure" as const,
        taskId: "1",
        reason: "commit_failed_after_write",
        errors: ["git commit failed"],
        message: "git commit failed",
        subtaskCount: 0,
      };
      expect(isCommitFailedAfterWrite(outcome)).toBe(true);
    });

    it("isCommitFailedAfterWrite returns false for other failures", async () => {
      const { isCommitFailedAfterWrite } = await import(
        "../../ui/src/components/expand-progress-logic"
      );
      expect(isCommitFailedAfterWrite({
        status: "failure", taskId: "1", reason: "agent_failed",
        errors: [], message: "", subtaskCount: 0,
      })).toBe(false);
      expect(isCommitFailedAfterWrite({
        status: "failure", taskId: "1", reason: "hash_conflict",
        errors: [], message: "", subtaskCount: 0,
      })).toBe(false);
    });

    it("reasonDisplayText returns 'Git commit failed after write' for this reason", async () => {
      const { reasonDisplayText } = await import(
        "../../ui/src/components/expand-progress-logic"
      );
      const outcome = {
        status: "failure" as const,
        taskId: "1",
        reason: "commit_failed_after_write",
        errors: [], message: "", subtaskCount: 0,
      };
      expect(reasonDisplayText(outcome)).toBe("Git commit failed after write");
    });

    it("outcomeDetailMessage returns the server message for commit failures", async () => {
      const { outcomeDetailMessage } = await import(
        "../../ui/src/components/expand-progress-logic"
      );
      const outcome = {
        status: "failure" as const,
        taskId: "1",
        reason: "commit_failed_after_write",
        errors: ["err"],
        message: "Subtasks written to disk but git commit failed: permission denied",
        subtaskCount: 0,
      };
      expect(outcomeDetailMessage(outcome)).toBe(
        "Subtasks written to disk but git commit failed: permission denied",
      );
    });

    it("statusText shows failure label for completed state with commit failure", async () => {
      const { statusText } = await import(
        "../../ui/src/components/expand-progress-logic"
      );
      const outcome = {
        status: "failure" as const,
        taskId: "1",
        reason: "commit_failed_after_write",
        errors: [], message: "", subtaskCount: 0,
      };
      expect(statusText("completed", outcome)).toBe("Task expansion failed");
    });

    it("dotVariant shows completed-failure for commit failure", async () => {
      const { dotVariant } = await import(
        "../../ui/src/components/expand-progress-logic"
      );
      const outcome = {
        status: "failure" as const,
        taskId: "1",
        reason: "commit_failed_after_write",
        errors: [], message: "", subtaskCount: 0,
      };
      expect(dotVariant("completed", outcome)).toBe("completed-failure");
    });

    it("showDismissButton is true for commit failure", async () => {
      const { showDismissButton } = await import(
        "../../ui/src/components/expand-progress-logic"
      );
      const outcome = {
        status: "failure" as const,
        taskId: "1",
        reason: "commit_failed_after_write",
        errors: [], message: "", subtaskCount: 0,
      };
      expect(showDismissButton("completed", outcome)).toBe(true);
    });

    it("outcomeSeverity returns 'error' for commit failure", async () => {
      const { outcomeSeverity } = await import(
        "../../ui/src/components/expand-progress-logic"
      );
      const outcome = {
        status: "failure" as const,
        taskId: "1",
        reason: "commit_failed_after_write",
        errors: [], message: "", subtaskCount: 0,
      };
      expect(outcomeSeverity(outcome)).toBe("error");
    });
  });

  // =========================================================================
  // 2d. ExpandProgress component source — commit-warning banner
  // =========================================================================

  describe("ExpandProgress component source checks", () => {
    let componentSource: string;

    beforeEach(async () => {
      const { readFileSync } = await import("node:fs");
      componentSource = readFileSync(
        new URL("../../ui/src/components/ExpandProgress.vue", import.meta.url),
        "utf-8",
      );
    });

    it("renders commit-warning banner for commit_failed_after_write", () => {
      expect(componentSource).toContain("commitFailedWarning");
      expect(componentSource).toContain("exp-banner__commit-warning");
    });

    it("commit-warning banner has meaningful text about manual commit", () => {
      expect(componentSource).toContain("git commit failed");
      expect(componentSource).toContain("manual commit");
    });

    it("uses isCommitFailedAfterWrite from expand-progress-logic", () => {
      expect(componentSource).toContain("isCommitFailedAfterWrite");
    });

    it("displays reasonText and detailMessage from expand-progress-logic", () => {
      expect(componentSource).toContain("reasonText");
      expect(componentSource).toContain("detailMessage");
      expect(componentSource).toContain("reasonDisplayText");
      expect(componentSource).toContain("outcomeDetailMessage");
    });
  });

  // =========================================================================
  // 2e. TaskDetailView — auto-refresh watcher (source-level structural checks)
  //
  // @vue/test-utils is not a project dependency, so we verify the watcher's
  // code structure via source assertions. The watcher's decision logic is
  // tested behaviorally in section 2a′ (store → composable pipeline) and
  // section 2b (shouldReloadAfterExpand). Together these sections prove:
  //   - The store produces the right outcome from WS events (2a, 2a′)
  //   - shouldReloadAfterExpand returns true for commit_failed_after_write (2a′, 2b)
  //   - The watcher code path exists and is wired correctly (2e, below)
  // =========================================================================

  describe("TaskDetailView watcher source checks for commit_failed_after_write", () => {
    let viewSource: string;

    beforeEach(async () => {
      const { readFileSync } = await import("node:fs");
      viewSource = readFileSync(
        new URL("../../ui/src/views/TaskDetailView.vue", import.meta.url),
        "utf-8",
      );
    });

    it("watcher handles commit_failed_after_write specifically", () => {
      expect(viewSource).toContain("commit_failed_after_write");
    });

    it("shows warning toast for commit failure", () => {
      expect(viewSource).toMatch(/commit_failed_after_write[\s\S]*?toast\.add/);
    });

    it("toast severity is 'warn' for commit failure", () => {
      // The toast must use warning severity (not error) since the file write
      // succeeded — only the commit failed.
      expect(viewSource).toMatch(/commit_failed_after_write[\s\S]*?severity:\s*["']warn["']/);
    });

    it("toast includes information about manual commit", () => {
      expect(viewSource).toContain("manual commit");
    });

    it("uses shouldReloadAfterExpand which handles commit_failed_after_write", () => {
      expect(viewSource).toContain("shouldReloadAfterExpand");
    });

    it("auto-reloads task (loadTask) before showing toast for commit failure", () => {
      // The watcher must call loadTask() first (to refresh subtasks), then
      // check for commit_failed_after_write to show the toast. Verify ordering.
      const loadTaskIdx = viewSource.indexOf("loadTask()");
      const commitFailedIdx = viewSource.indexOf("commit_failed_after_write");
      expect(loadTaskIdx).toBeGreaterThan(-1);
      expect(commitFailedIdx).toBeGreaterThan(-1);

      // Both should be inside the same watcher block (after shouldReloadAfterExpand)
      expect(viewSource).toMatch(/shouldReloadAfterExpand[\s\S]*?loadTask\(\)/);
      expect(viewSource).toMatch(/shouldReloadAfterExpand[\s\S]*?commit_failed_after_write/);
    });

    it("has dedup guard to prevent multiple reloads from same outcome", () => {
      expect(viewSource).toContain("lastReloadedOutcomeRef");
      expect(viewSource).toMatch(/fingerprint[\s\S]*?reason/);
    });
  });
});
