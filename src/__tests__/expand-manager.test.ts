import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ExpandManager,
  ExpandSessionActiveError,
  ExpandPreflightError,
} from "../server/expand-manager.js";
import type {
  ExpandStartOptions,
  ExpandStopResult,
} from "../server/expand-manager.js";
import type { ExpandManagerOutcome } from "../types.js";
import type { SessionCore } from "../server/session/session-core.js";
import type { WsBroadcaster, WsEvent } from "../server/session/ws-broadcaster.js";

// --- Mock DriverRunner ---

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

const driverRunnerConstructorCalls: Array<[string, string | undefined]> = [];
let capturedOnLog: ((event: any) => void) | undefined;
const driverRunnerSetup = vi.fn(async (_opts: any, onLog?: (event: any) => void) => {
  capturedOnLog = onLog;
});
const driverRunnerTeardown = vi.fn(async () => {});

vi.mock("../server/session/driver-runner.js", () => {
  return {
    DriverRunner: class MockDriverRunner {
      constructor(agent: string, model?: string) {
        driverRunnerConstructorCalls.push([agent, model]);
      }
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
  };
});

// --- Mock tasks-json ---

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

// --- Mock tasks-json-hash ---

const mockSnapshotTasksJsonHash = vi.fn((): string | null => "abc123hash");
const mockVerifyTasksJsonHash = vi.fn((): boolean => true);

vi.mock("../core/tasks-json-hash.js", () => ({
  snapshotTasksJsonHash: (...args: unknown[]) => mockSnapshotTasksJsonHash(...args),
  verifyTasksJsonHash: (...args: unknown[]) => mockVerifyTasksJsonHash(...args),
}));

// --- Mock git ---

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

// --- Helpers ---

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

const defaultStartOpts: ExpandStartOptions = {
  agent: "claude",
};

const defaultTaskId = "1";

describe("ExpandManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driverRunnerConstructorCalls.length = 0;
    capturedOnLog = undefined;
    // Reset hash mocks to default behavior
    mockSnapshotTasksJsonHash.mockReturnValue("abc123hash");
    mockVerifyTasksJsonHash.mockReturnValue(true);
    // Reset git mocks to default (all preflight checks pass)
    mockIsGitRepo.mockReturnValue(true);
    mockIsTrackedByGit.mockReturnValue(true);
    mockHasGitIdentity.mockReturnValue(true);
    mockIsPathDirty.mockReturnValue(false);
    mockCommitExpandedTask.mockReset();
  });

  /**
   * Drain pending async operations (background session callbacks).
   */
  async function drainAsyncOps(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * Helper to build a mock session result with a given signal and resultText.
   */
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

  // --- Initial state tests ---

  it("should return 'idle' as initial state", () => {
    const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager.getState()).toBe("idle");
  });

  it("should return null as initial session", () => {
    const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager.getSession()).toBeNull();
  });

  it("should return null as initial outcome", () => {
    const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager.getOutcome()).toBeNull();
  });

  // --- start() tests ---

  describe("start()", () => {
    it("should create session with state=active on idle sessionCore", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", sc, bc);

      await manager.start(defaultTaskId, defaultStartOpts);

      const session = manager.getSession();
      expect(session).not.toBeNull();
      expect(session!.state).toBe("active");
      expect(session!.agent).toBe("claude");
      expect(session!.taskId).toBe("1");
    });

    it("should generate a UUID for session id", async () => {
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);

      const session = manager.getSession();
      // UUID v4 format
      expect(session!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should store taskId, model, and variant from options", async () => {
      mockReadTasksFile.mockReturnValueOnce({
        tasks: [{ id: 42, title: "Task 42", description: "Desc", status: "pending", priority: "medium", dependencies: [], details: "Details", subtasks: [] }],
        metadata: {},
      });
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start("42", { agent: "claude", model: "opus", variant: "high" });

      const session = manager.getSession();
      expect(session!.taskId).toBe("42");
      expect(session!.model).toBe("opus");
      expect(session!.variant).toBe("high");
    });

    it("should throw ExpandSessionActiveError when sessionCore is not idle", async () => {
      const sc = mockSessionCore({
        isIdle: () => false,
        state: "active" as any,
      });
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(ExpandSessionActiveError);
      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(/Cannot start expand/);
    });

    it("should throw ExpandSessionActiveError when acquire fails (lock contention)", async () => {
      const sc = mockSessionCore({
        acquire: vi.fn(() => { throw new Error("Lock held by another process"); }),
      });
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(ExpandSessionActiveError);
      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(/Cannot start expand/);
    });

    it("should call sessionCore.acquire()", async () => {
      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);

      expect(sc.acquire).toHaveBeenCalledOnce();
    });

    it("should create DriverRunner with agent and model", async () => {
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, { agent: "claude", model: "opus" });

      expect(driverRunnerConstructorCalls).toHaveLength(1);
      expect(driverRunnerConstructorCalls[0]).toEqual(["claude", "opus"]);
    });

    it("should call driverRunner.setup() with abortSignal", async () => {
      const abortSignal = new AbortController().signal;
      const sc = mockSessionCore({
        getAbortSignal: () => abortSignal,
      });
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);

      expect(driverRunnerSetup).toHaveBeenCalledOnce();
      expect(driverRunnerSetup).toHaveBeenCalledWith(
        expect.objectContaining({ verbosity: "trace", abortSignal }),
        expect.any(Function), // onLog callback
      );
    });

    it("should broadcast expand:started event with taskId", async () => {
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);

      const startedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "expand:started",
      );
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.agent).toBe("claude");
      expect(startedEvent!.sessionId).toBeDefined();
      expect(startedEvent!.taskId).toBe("1");
    });

    it("should broadcast agent:system_prompt event on expand channel", async () => {
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);

      const promptEvent = bc.calls.find(
        (e: WsEvent) => e.type === "agent:system_prompt",
      );
      expect(promptEvent).toBeDefined();
      expect(promptEvent!.text).toContain("task decomposition agent");
    });

    it("should broadcast agent:task_prompt event on expand channel", async () => {
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);

      const taskPromptEvent = bc.calls.find(
        (e: WsEvent) => e.type === "agent:task_prompt",
      );
      expect(taskPromptEvent).toBeDefined();
      expect(taskPromptEvent!.text).toContain("Test task");
    });

    it("should clear broadcast buffer before started event", async () => {
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);

      expect(bc.clearBuffer).toHaveBeenCalledOnce();
    });

    it("should pass abortController to runSession for abort propagation", async () => {
      let capturedOpts: any;
      mockRunSession.mockImplementationOnce(async (opts: any) => {
        capturedOpts = opts;
        return sessionResult({ type: "complete" });
      });

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(capturedOpts).toBeDefined();
      expect(capturedOpts.abortController).toBeDefined();
      expect(capturedOpts.abortController).toBeInstanceOf(AbortController);
    });

    it("should cleanup on driverRunner.setup() failure", async () => {
      const sc = mockSessionCore();
      driverRunnerSetup.mockRejectedValueOnce(new Error("Setup failed"));

      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow("Setup failed");

      // Session should be cleaned up
      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
      // Lock should be released
      expect(sc.release).toHaveBeenCalledOnce();
    });

    it("should reset outcome on new start", async () => {
      // Use a failure outcome for the first session so it persists
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "blocked", reason: "test error" }),
      );

      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", sc, bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Failure outcome should persist
      expect(manager.getOutcome()).not.toBeNull();

      // Make the second runSession hang so we can inspect state before completion
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      // Start a new session on the same manager (sessionCore mock always returns idle)
      await manager.start(defaultTaskId, defaultStartOpts);

      // After start(), the previous outcome should be cleared
      expect(manager.getOutcome()).toBeNull();
    });
  });

  // --- stop() tests ---

  describe("stop()", () => {
    it("should return no_active_session when no session is active", async () => {
      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      const result = await manager.stop(defaultTaskId);

      expect(result).toEqual({ status: "no_active_session" });
      expect(sc.abort).not.toHaveBeenCalled();
    });

    it("should return task_mismatch when taskId does not match active session", async () => {
      // Make runSession hang to keep session active
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      // Start with defaultTaskId "1" (which is in the mock data)
      await manager.start(defaultTaskId, defaultStartOpts);

      // Stop with a different taskId
      const result = await manager.stop("99");

      expect(result).toEqual({ status: "task_mismatch", activeTaskId: "1" });
    });

    it("should return stopped and call sessionCore.abort()", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      const result = await manager.stop(defaultTaskId);

      expect(result).toEqual({ status: "stopped" });
      expect(sc.abort).toHaveBeenCalledOnce();
    });

    it("should reset state to idle after stop", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
    });

    it("should broadcast expand:finished with cancelled outcome including taskId", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      const finishedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "expand:finished",
      );
      expect(finishedEvent).toBeDefined();
      expect(finishedEvent!.outcome).toEqual({
        status: "cancelled",
        taskId: "1",
        subtaskCount: 0,
      });
    });

    it("should set outcome to cancelled with taskId and subtaskCount", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      expect(manager.getOutcome()).toEqual({
        status: "cancelled",
        taskId: "1",
        subtaskCount: 0,
      });
    });

    it("should release session lock", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      expect(sc.release).toHaveBeenCalled();
    });

    it("should teardown driver", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      expect(driverRunnerTeardown).toHaveBeenCalled();
    });
  });

  // --- Background session outcome tests ---

  describe("background session outcome", () => {
    it("should set outcome to success with subtaskCount: 0 for empty subtasks", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": []}'),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Success outcome is cleared after broadcast (not persisted for reconnect)
      expect(manager.getOutcome()).toBeNull();
      // But the broadcast carried the success outcome
      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished?.outcome).toEqual({
        status: "success",
        taskId: "1",
        subtaskCount: 0,
      });
    });

    it("should set outcome to success for non-empty subtasks after hash check passes and write succeeds", async () => {
      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
          { id: 2, title: "Sub 2", description: "Desc 2", details: "Details 2", dependencies: [1] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      // Hash check passes (no conflict)
      mockVerifyTasksJsonHash.mockReturnValue(true);

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Success outcome is cleared after broadcast (not persisted for reconnect)
      expect(manager.getOutcome()).toBeNull();

      // Hash verification was called
      expect(mockVerifyTasksJsonHash).toHaveBeenCalledOnce();

      // writeExpandSubtasks was called with correct arguments
      expect(mockWriteExpandSubtasks).toHaveBeenCalledOnce();
      expect(mockWriteExpandSubtasks).toHaveBeenCalledWith(
        "/tmp",
        "1",
        subtasksPayload.subtasks,
      );

      // withTasksMutex was used to wrap the write
      expect(mockWithTasksMutex).toHaveBeenCalledOnce();

      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished?.outcome.status).toBe("success");
      expect(finished?.outcome.subtaskCount).toBe(2);
    });

    it("should set outcome to failure when agent signals blocked", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "blocked", reason: "task has subtasks" }),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect(outcome!.taskId).toBe("1");
      expect((outcome as any).reason).toBe("agent_failed");
      expect((outcome as any).errors[0]).toContain("Agent signalled blocked");
      expect((outcome as any).subtaskCount).toBe(0);
    });

    it("should set outcome to failure when agent signals error", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "error", message: "Context limit exceeded" }),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect(outcome!.taskId).toBe("1");
      expect((outcome as any).reason).toBe("agent_failed");
      expect((outcome as any).errors[0]).toContain("Agent error: Context limit exceeded");
    });

    it("should set outcome to failure when runSession throws", async () => {
      mockRunSession.mockRejectedValueOnce(new Error("SDK error"));

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect(outcome!.taskId).toBe("1");
      expect((outcome as any).reason).toBe("agent_failed");
      expect((outcome as any).errors[0]).toContain("SDK error");

      // Should broadcast exactly one expand:error (from finally block, not duplicated by catch)
      const errorEvents = bc.calls.filter((e: WsEvent) => e.type === "expand:error");
      expect(errorEvents.length).toBe(1);
      expect(errorEvents[0]!.message).toContain("SDK error");
    });

    it("should set outcome to failure when result is not valid JSON", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, "not json at all"),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).reason).toBe("result_parse_failed");
    });

    it("should set outcome to failure when result fails schema validation", async () => {
      // Missing required field "details"
      const invalidResult = JSON.stringify({
        subtasks: [{ id: 1, title: "Sub 1", description: "Desc 1", dependencies: [] }],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, invalidResult),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).reason).toBe("validation_failed");
      expect((outcome as any).errors.length).toBeGreaterThan(0);
    });

    it("should set outcome to failure when result is empty text", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, ""),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).reason).toBe("result_parse_failed");
    });

    it("should broadcast expand:finished with outcome", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": []}'),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finishedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "expand:finished",
      );
      expect(finishedEvent).toBeDefined();
      expect(finishedEvent!.outcome.status).toBe("success");
    });

    it("should cleanup after background session completes", async () => {
      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
      expect(sc.release).toHaveBeenCalled();
      expect(driverRunnerTeardown).toHaveBeenCalled();
    });
  });

  // --- Hash conflict detection ---

  describe("hash conflict detection", () => {
    it("should snapshot tasks.json hash on start", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue("initial-hash-value");
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);

      expect(mockSnapshotTasksJsonHash).toHaveBeenCalledWith("/tmp");
      expect(manager.getSession()!.tasksJsonHash).toBe("initial-hash-value");
    });

    it("should store null hash when tasks.json does not exist at session start", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue(null);
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);

      expect(manager.getSession()!.tasksJsonHash).toBeNull();
    });

    it("should call verifyTasksJsonHash before write when subtasks are non-empty", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue("snapshot-hash");
      mockVerifyTasksJsonHash.mockReturnValue(true);

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockVerifyTasksJsonHash).toHaveBeenCalledWith("/tmp", "snapshot-hash");
    });

    it("should NOT call verifyTasksJsonHash for empty subtasks (no write needed)", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": []}'),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockVerifyTasksJsonHash).not.toHaveBeenCalled();
    });

    it("should set hash_conflict failure when tasks.json changed during session", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue("original-hash");
      mockVerifyTasksJsonHash.mockReturnValue(false); // File changed!

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.status).toBe("failure");
      expect(outcome.reason).toBe("hash_conflict");
      expect(outcome.taskId).toBe("1");
      expect(outcome.message).toContain("modified during the expand session");
    });

    it("should broadcast expand:error with hash_conflict reason", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const errorEvent = bc.calls.find((e: WsEvent) => e.type === "expand:error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.reason).toBe("hash_conflict");
    });

    it("should broadcast expand:finished with hash_conflict failure outcome", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished).toBeDefined();
      expect(finished!.outcome.status).toBe("failure");
      expect((finished!.outcome as any).reason).toBe("hash_conflict");
    });

    it("should set hash_conflict when tasks.json was absent at session start", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue(null); // file didn't exist at start

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.status).toBe("failure");
      expect(outcome.reason).toBe("hash_conflict");
    });

    it("should proceed past hash check when file is unchanged", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue("stable-hash");
      mockVerifyTasksJsonHash.mockReturnValue(true); // File unchanged

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Should NOT be hash_conflict — should reach write pipeline and succeed
      // Success outcome is cleared after broadcast
      expect(manager.getOutcome()).toBeNull();

      // Write pipeline was called
      expect(mockWriteExpandSubtasks).toHaveBeenCalledOnce();
      expect(mockWithTasksMutex).toHaveBeenCalledOnce();

      // Broadcast shows success
      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished?.outcome.status).toBe("success");
    });

    it("should not write subtasks when hash conflict detected (no side effects)", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false); // Conflict!

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
          { id: 2, title: "Sub 2", description: "Desc 2", details: "Det 2", dependencies: [1] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.status).toBe("failure");
      expect(outcome.reason).toBe("hash_conflict");
      // subtaskCount should be 0 since nothing was written
      expect(outcome.subtaskCount).toBe(0);
    });

    it("should cleanup after hash conflict just like any other failure", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
      expect(sc.release).toHaveBeenCalled();
      expect(driverRunnerTeardown).toHaveBeenCalled();
    });

    it("should not call writeExpandSubtasks when hash conflict detected", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockWriteExpandSubtasks).not.toHaveBeenCalled();
      // withTasksMutex IS called — the hash check now happens inside the mutex
      // to eliminate the TOCTOU window
      expect(mockWithTasksMutex).toHaveBeenCalledOnce();
    });
  });

  // --- Write pipeline ---

  describe("write pipeline", () => {
    it("should call verifyTasksJsonHash and writeExpandSubtasks inside withTasksMutex", async () => {
      const callOrder: string[] = [];
      mockWithTasksMutex.mockImplementationOnce(async <T>(fn: () => T | Promise<T>): Promise<T> => {
        callOrder.push("mutex:enter");
        const result = await fn();
        callOrder.push("mutex:exit");
        return result;
      });
      mockVerifyTasksJsonHash.mockImplementation((..._args: unknown[]) => {
        callOrder.push("hash_check");
        return true;
      });
      mockWriteExpandSubtasks.mockImplementationOnce(() => {
        callOrder.push("write");
      });

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] as number[] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Hash check and write both happen inside the mutex (no TOCTOU gap)
      expect(callOrder).toEqual(["mutex:enter", "hash_check", "write", "mutex:exit"]);
    });

    it("should not call writeExpandSubtasks for empty subtasks", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": []}'),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockWriteExpandSubtasks).not.toHaveBeenCalled();
      expect(mockWithTasksMutex).not.toHaveBeenCalled();
    });

    it("should set failure outcome when writeExpandSubtasks throws", async () => {
      mockWriteExpandSubtasks.mockImplementationOnce(() => {
        throw new Error("Disk full — cannot write tasks.json");
      });

      const subtasks = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] as number[] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, subtasks),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.status).toBe("failure");
      expect(outcome.reason).toBe("agent_failed");
      expect(outcome.errors[0]).toContain("Disk full");
    });

    it("should pass validated subtasks with all fields to writeExpandSubtasks", async () => {
      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "First", description: "First desc", details: "First det", dependencies: [] as number[], testStrategy: "Test first" },
          { id: 2, title: "Second", description: "Second desc", details: "Second det", dependencies: [1] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockWriteExpandSubtasks).toHaveBeenCalledWith(
        "/tmp",
        "1",
        subtasksPayload.subtasks,
      );
    });
  });

  // --- Failure path: expand:error before expand:finished ---

  describe("failure path broadcasts", () => {
    it("failure outcome should broadcast expand:error before expand:finished", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "blocked", reason: "task has subtasks" }),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Find indices of error and finished events
      const errorIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:error");
      const finishedIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:finished");

      expect(errorIdx).toBeGreaterThanOrEqual(0);
      expect(finishedIdx).toBeGreaterThan(errorIdx);
    });

    it("expand:error should contain machine-readable reason and human-readable message", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "error", message: "Context limit exceeded" }),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const errorEvent = bc.calls.find((e: WsEvent) => e.type === "expand:error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.reason).toBe("agent_failed");
      expect(typeof errorEvent!.message).toBe("string");
      expect(errorEvent!.message.length).toBeGreaterThan(0);
    });

    it("terminal outcome always contains taskId and subtaskCount on failure", async () => {
      mockRunSession.mockRejectedValueOnce(new Error("Runtime error"));

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.taskId).toBe("1");
      expect(typeof outcome.subtaskCount).toBe("number");
      expect(outcome.subtaskCount).toBe(0);
    });
  });

  // --- Duplicate start rejection ---

  describe("duplicate start rejection", () => {
    it("should reject second start while first session is active", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);

      // Second start should fail because sessionCore.isIdle() returns false
      const sc2 = mockSessionCore({ isIdle: () => false, state: "active" as any });
      const manager2 = new ExpandManager("/tmp", sc2, mockBroadcaster());

      await expect(manager2.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(
        ExpandSessionActiveError,
      );
    });
  });

  // --- Agent event streaming via expand channel ---

  describe("agent event streaming", () => {
    it("should pass onLog callback to driverRunner.setup()", async () => {
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);

      expect(capturedOnLog).toBeDefined();
      expect(typeof capturedOnLog).toBe("function");
    });

    it("should broadcast agent events through expand channel via onLog", async () => {
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);

      const agentEvent = { type: "agent:text", text: "Exploring codebase..." };
      capturedOnLog!(agentEvent);

      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        agentEvent,
        "expand",
      );
    });

    it("should broadcast agent:tool events through expand channel via onLog", async () => {
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);

      const toolEvent = {
        type: "agent:tool",
        name: "Read",
        summary: "Reading src/index.ts",
      };
      capturedOnLog!(toolEvent);

      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        toolEvent,
        "expand",
      );
    });
  });

  // --- Stop / cancel / cleanup race tests ---

  describe("double stop", () => {
    it("second stop() returns no_active_session and does not throw", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", sc, bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      // Second stop — session is already gone
      const result = await manager.stop(defaultTaskId);
      expect(result).toEqual({ status: "no_active_session" });
      expect(manager.getState()).toBe("idle");
    });

    it("second stop() does not broadcast a duplicate expand:finished", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);

      vi.mocked(bc.broadcastWithChannel).mockClear();
      bc.calls.length = 0;

      await manager.stop(defaultTaskId);
      await manager.stop(defaultTaskId);

      const finishedCount = bc.calls.filter(
        (e: WsEvent) => e.type === "expand:finished",
      ).length;
      expect(finishedCount).toBe(1);
    });

    it("double stop() does not produce false success — outcome stays cancelled", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);
      await manager.stop(defaultTaskId);

      expect(manager.getOutcome()).toEqual({
        status: "cancelled",
        taskId: "1",
        subtaskCount: 0,
      });
    });
  });

  describe("restart after cleanup", () => {
    it("start() succeeds after stop() has cleaned up the previous session", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      const firstSessionId = manager.getSession()!.id;
      await manager.stop(defaultTaskId);

      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      await manager.start(defaultTaskId, defaultStartOpts);

      const secondSession = manager.getSession();
      expect(secondSession).not.toBeNull();
      expect(secondSession!.id).not.toBe(firstSessionId);
      expect(secondSession!.state).toBe("active");
    });

    it("restart resets outcome to null before new session runs", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);
      expect(manager.getOutcome()!.status).toBe("cancelled");

      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      await manager.start(defaultTaskId, defaultStartOpts);

      expect(manager.getOutcome()).toBeNull();
    });

    it("restarted session can complete with its own outcome", async () => {
      // First session: stop immediately
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      // Second session: runs to completion with success
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": []}'),
      );

      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Success outcome is cleared after broadcast
      expect(manager.getOutcome()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });

    it("lock is released after stop, allowing new acquire", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      expect(sc.release).toHaveBeenCalled();

      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      await manager.start(defaultTaskId, defaultStartOpts);

      expect(manager.getState()).toBe("active");
    });
  });

  describe("race: stop() vs background session finish", () => {
    it("finishedSent guard prevents duplicate expand:finished when stop races with normal completion", async () => {
      let resolveSession: (() => void) | undefined;
      mockRunSession.mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveSession = () =>
            resolve(sessionResult({ type: "complete" }, '{"subtasks": []}'));
        }),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);

      vi.mocked(bc.broadcastWithChannel).mockClear();
      bc.calls.length = 0;

      // Resolve the background session and immediately stop
      resolveSession!();
      await manager.stop(defaultTaskId);
      await drainAsyncOps();

      // Exactly one expand:finished — not two
      const finishedEvents = bc.calls.filter(
        (e: WsEvent) => e.type === "expand:finished",
      );
      expect(finishedEvents.length).toBe(1);
    });

    it("stop() before background completes yields cancelled, not success", async () => {
      let resolveSession: (() => void) | undefined;
      mockRunSession.mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveSession = () =>
            resolve(sessionResult({ type: "complete" }, '{"subtasks": []}'));
        }),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      // Stop before the session completes
      await manager.stop(defaultTaskId);

      // Now let the background session resolve (its finally block runs)
      resolveSession!();
      await drainAsyncOps();

      // Outcome must be cancelled (set by stop), not success
      expect(manager.getOutcome()).toEqual({
        status: "cancelled",
        taskId: "1",
        subtaskCount: 0,
      });
    });
  });

  describe("cleanup race: stale session does not destroy new session", () => {
    it("old background finally block does not cleanup a newly started session", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", sc, bc);

      // First session: hangs until we reject it
      let rejectSession1: ((err: Error) => void) | undefined;
      mockRunSession.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectSession1 = reject; }),
      );

      await manager.start(defaultTaskId, defaultStartOpts);
      const session1Id = manager.getSession()!.id;

      // Stop first session — cleanup runs eagerly, session becomes null
      await manager.stop(defaultTaskId);
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");

      // Reset mocks for tracking second session's cleanup
      vi.mocked(sc.release).mockClear();
      driverRunnerTeardown.mockClear();

      // Start a second session (hangs)
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      await manager.start(defaultTaskId, defaultStartOpts);
      const session2Id = manager.getSession()!.id;
      expect(session2Id).not.toBe(session1Id);

      // Now let the first session's runSession reject — its finally block runs
      rejectSession1!(new Error("AbortError"));
      await drainAsyncOps();

      // New session must still be alive — stale finally block must NOT destroy it
      expect(manager.getSession()).not.toBeNull();
      expect(manager.getSession()!.id).toBe(session2Id);
      expect(manager.getState()).toBe("active");

      // Teardown should NOT have been called by the stale stream
      expect(driverRunnerTeardown).not.toHaveBeenCalled();
      // Release should NOT have been called by the stale stream
      expect(sc.release).not.toHaveBeenCalled();
    });

    it("stop() broadcasts exactly one expand:finished (stale session does not duplicate)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", sc, bc);

      // Session that hangs until rejected
      let rejectSession: ((err: Error) => void) | undefined;
      mockRunSession.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectSession = reject; }),
      );

      await manager.start(defaultTaskId, defaultStartOpts);

      // Clear to count only post-stop events
      vi.mocked(bc.broadcastWithChannel).mockClear();
      bc.calls.length = 0;

      await manager.stop(defaultTaskId);

      // Now let the stale session reject — its finally block runs
      rejectSession!(new Error("AbortError"));
      await drainAsyncOps();

      // Exactly one expand:finished from stop(), not a second from the stale session
      const finishedCount = bc.calls.filter(
        (e: WsEvent) => e.type === "expand:finished",
      ).length;
      expect(finishedCount).toBe(1);
    });
  });

  // --- JSON extraction edge cases ---

  describe("JSON extraction from result text", () => {
    it("should extract JSON wrapped in prose text", async () => {
      const resultText = 'Here is the result:\n{"subtasks": []}\nDone!';
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, resultText),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished?.outcome.status).toBe("success");
    });

    it("should handle JSON with whitespace padding", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '  \n  {"subtasks": []}  \n  '),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished?.outcome.status).toBe("success");
    });

    it("should handle braces inside JSON string values without premature truncation", async () => {
      // Subtask title contains curly braces — the parser must not be confused
      const resultText = JSON.stringify({
        subtasks: [
          {
            id: 1,
            title: "Fix {config} handling",
            description: "Handle {braces} in config files",
            details: "Details with {nested} braces",
            dependencies: [],
          },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, resultText),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      // Should reach validation, not fail at JSON extraction.
      // The outcome may be "failure" due to write pipeline not implemented,
      // but the reason should NOT be "result_parse_failed".
      expect(finished).toBeDefined();
      const outcome = finished!.outcome;
      if (outcome.status === "failure") {
        expect(outcome.reason).not.toBe("result_parse_failed");
      }
    });

    it("should handle braces in strings when JSON is wrapped in prose", async () => {
      const json = '{"subtasks": [{"id": 1, "title": "Fix {x} issue", "description": "Desc", "details": "Det", "dependencies": []}]}';
      const resultText = `Here is the result:\n${json}\nDone.`;
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, resultText),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished).toBeDefined();
      const outcome = finished!.outcome;
      if (outcome.status === "failure") {
        expect(outcome.reason).not.toBe("result_parse_failed");
      }
    });

    it("should handle escaped quotes inside JSON strings", async () => {
      // JSON with escaped quotes that contain braces
      const resultText = '{"subtasks": [{"id": 1, "title": "Fix \\"config{}\\" bug", "description": "Desc", "details": "Det", "dependencies": []}]}';
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, resultText),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished).toBeDefined();
      const outcome = finished!.outcome;
      if (outcome.status === "failure") {
        expect(outcome.reason).not.toBe("result_parse_failed");
      }
    });
  });

  // --- Task context loading ---

  describe("task context loading", () => {
    it("should pass task context to prompts including all fields", async () => {
      mockReadTasksFile.mockReturnValueOnce({
        tasks: [
          {
            id: 7,
            title: "Special task",
            description: "A special description",
            status: "pending",
            priority: "high",
            dependencies: [1, 3],
            details: "Implementation details here",
            testStrategy: "Write integration tests",
            subtasks: [],
          },
        ],
        metadata: {},
      });

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start("7", defaultStartOpts);

      const taskPromptEvent = bc.calls.find(
        (e: WsEvent) => e.type === "agent:task_prompt",
      );
      expect(taskPromptEvent).toBeDefined();
      expect(taskPromptEvent!.text).toContain("Special task");
      expect(taskPromptEvent!.text).toContain("A special description");
      expect(taskPromptEvent!.text).toContain("Implementation details here");
    });

    it("should throw when taskId is not found in tasks.json", async () => {
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      // Task "999" doesn't exist in the mock
      await expect(manager.start("999", defaultStartOpts)).rejects.toThrow(
        /Task 999 not found/,
      );
    });

    it("should NOT broadcast expand:started when loadTaskContext throws (task not found)", async () => {
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      // Task "999" doesn't exist — loadTaskContext runs before WS broadcasts
      await expect(manager.start("999", defaultStartOpts)).rejects.toThrow(
        /Task 999 not found/,
      );

      // No expand:started event should have been sent
      const startedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "expand:started",
      );
      expect(startedEvent).toBeUndefined();

      // No agent prompts should have been sent either
      const promptEvents = bc.calls.filter(
        (e: WsEvent) =>
          e.type === "agent:system_prompt" || e.type === "agent:task_prompt",
      );
      expect(promptEvents).toHaveLength(0);
    });
  });

  // --- Git preflight checks ---

  describe("git preflight checks", () => {
    it("should throw ExpandPreflightError with reason 'git_not_repo' when not a git repo", async () => {
      mockIsGitRepo.mockReturnValue(false);
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(ExpandPreflightError);
      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(/not a git repository/);
      mockIsGitRepo.mockReturnValue(false);
      try {
        await manager.start(defaultTaskId, defaultStartOpts);
      } catch (err) {
        expect(err).toBeInstanceOf(ExpandPreflightError);
        expect((err as ExpandPreflightError).reason).toBe("git_not_repo");
      }
    });

    it("should throw ExpandPreflightError with reason 'tasks_file_untracked' when tasks.json is not tracked", async () => {
      mockIsTrackedByGit.mockReturnValue(false);
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      try {
        await manager.start(defaultTaskId, defaultStartOpts);
        expect.unreachable("Expected ExpandPreflightError");
      } catch (err) {
        expect(err).toBeInstanceOf(ExpandPreflightError);
        expect((err as ExpandPreflightError).reason).toBe("tasks_file_untracked");
      }
    });

    it("should throw ExpandPreflightError with reason 'git_identity_missing' when git identity not set", async () => {
      mockHasGitIdentity.mockReturnValue(false);
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      try {
        await manager.start(defaultTaskId, defaultStartOpts);
        expect.unreachable("Expected ExpandPreflightError");
      } catch (err) {
        expect(err).toBeInstanceOf(ExpandPreflightError);
        expect((err as ExpandPreflightError).reason).toBe("git_identity_missing");
      }
    });

    it("should throw ExpandPreflightError with reason 'tasks_file_dirty' when tasks.json has changes", async () => {
      mockIsPathDirty.mockReturnValue(true);
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      try {
        await manager.start(defaultTaskId, defaultStartOpts);
        expect.unreachable("Expected ExpandPreflightError");
      } catch (err) {
        expect(err).toBeInstanceOf(ExpandPreflightError);
        expect((err as ExpandPreflightError).reason).toBe("tasks_file_dirty");
      }
    });

    it("should NOT acquire session lock when preflight fails", async () => {
      mockIsGitRepo.mockReturnValue(false);
      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(ExpandPreflightError);

      expect(sc.acquire).not.toHaveBeenCalled();
    });

    it("should NOT broadcast expand:started when preflight fails", async () => {
      mockHasGitIdentity.mockReturnValue(false);
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(ExpandPreflightError);

      const startedEvent = bc.calls.find((e: WsEvent) => e.type === "expand:started");
      expect(startedEvent).toBeUndefined();
    });

    it("should pass preflight when all git checks succeed", async () => {
      // All defaults pass — should not throw ExpandPreflightError
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      expect(manager.getSession()).not.toBeNull();
    });

    it("should check isGitRepo with the correct cwd", async () => {
      mockIsGitRepo.mockReturnValue(false);
      const manager = new ExpandManager("/my/project", mockSessionCore(), mockBroadcaster());
      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(ExpandPreflightError);
      expect(mockIsGitRepo).toHaveBeenCalledWith("/my/project");
    });

    it("should check isTrackedByGit with correct path and cwd", async () => {
      mockIsTrackedByGit.mockReturnValue(false);
      const manager = new ExpandManager("/my/project", mockSessionCore(), mockBroadcaster());
      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(ExpandPreflightError);
      expect(mockIsTrackedByGit).toHaveBeenCalledWith(".taskmaster/tasks/tasks.json", "/my/project");
    });

    it("should check isPathDirty with correct path and cwd", async () => {
      mockIsPathDirty.mockReturnValue(true);
      const manager = new ExpandManager("/my/project", mockSessionCore(), mockBroadcaster());
      await expect(manager.start(defaultTaskId, defaultStartOpts)).rejects.toThrow(ExpandPreflightError);
      expect(mockIsPathDirty).toHaveBeenCalledWith(".taskmaster/tasks/tasks.json", "/my/project");
    });

    it("dirty other files should NOT block expand", async () => {
      // isPathDirty for tasks.json returns false — other files being dirty doesn't matter
      mockIsPathDirty.mockReturnValue(false);
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      expect(manager.getSession()).not.toBeNull();
    });

    it("should run preflight checks in order: git_not_repo first", async () => {
      // If both isGitRepo and hasGitIdentity fail, git_not_repo should be reported
      mockIsGitRepo.mockReturnValue(false);
      mockHasGitIdentity.mockReturnValue(false);
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());

      try {
        await manager.start(defaultTaskId, defaultStartOpts);
        expect.unreachable("Expected ExpandPreflightError");
      } catch (err) {
        expect((err as ExpandPreflightError).reason).toBe("git_not_repo");
      }
    });
  });

  // --- Post-write commit semantics ---

  describe("post-write commit", () => {
    it("should call commitExpandedTask after successful write", async () => {
      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
          { id: 2, title: "Sub 2", description: "Desc 2", details: "Details 2", dependencies: [1] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockCommitExpandedTask).toHaveBeenCalledOnce();
      expect(mockCommitExpandedTask).toHaveBeenCalledWith("/tmp", "1", 2);
    });

    it("should NOT call commitExpandedTask for empty subtasks", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": []}'),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockCommitExpandedTask).not.toHaveBeenCalled();
    });

    it("should set commit_failed_after_write when commit throws", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("git commit failed: permission denied");
      });

      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.status).toBe("failure");
      expect(outcome.reason).toBe("commit_failed_after_write");
      expect(outcome.message).toContain("git commit failed: permission denied");
      expect(outcome.message).toContain("not committed to git");
    });

    it("should broadcast expand:error with commit_failed_after_write reason", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("git error");
      });

      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const errorEvent = bc.calls.find((e: WsEvent) => e.type === "expand:error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.reason).toBe("commit_failed_after_write");
    });

    it("should NOT rollback write when commit fails", async () => {
      // writeExpandSubtasks should have been called before the commit
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("git error");
      });

      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Write was called (subtasks were saved to disk)
      expect(mockWriteExpandSubtasks).toHaveBeenCalledOnce();
      // Failure outcome — but no rollback of the write
      expect(manager.getOutcome()!.status).toBe("failure");
    });

    it("should report success when commit succeeds", async () => {
      mockCommitExpandedTask.mockImplementation(() => {});

      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Success outcome is cleared after broadcast
      expect(manager.getOutcome()).toBeNull();
      const finished = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finished?.outcome.status).toBe("success");
      expect(finished?.outcome.subtaskCount).toBe(1);
    });

    it("commit should happen after write and inside the same success flow", async () => {
      const callOrder: string[] = [];
      mockWriteExpandSubtasks.mockImplementationOnce(() => {
        callOrder.push("write");
      });
      mockCommitExpandedTask.mockImplementationOnce(() => {
        callOrder.push("commit");
      });

      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(callOrder).toEqual(["write", "commit"]);
    });

    it("should NOT call commitExpandedTask when hash conflict detected", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(mockCommitExpandedTask).not.toHaveBeenCalled();
    });

    it("commit_failed_after_write message includes human-readable guidance", async () => {
      mockCommitExpandedTask.mockImplementation(() => {
        throw new Error("fatal: unable to create tree");
      });

      const subtasksPayload = {
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Details 1", dependencies: [] as number[] },
        ],
      };
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, JSON.stringify(subtasksPayload)),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.message).toContain("Subtasks written to disk");
      expect(outcome.message).toContain("saved in .taskmaster/tasks/tasks.json");
    });
  });
});
