import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ParsePrdManager,
  ParsePrdSessionActiveError,
} from "../server/parse-prd-manager.js";
import type {
  ParsePrdStartOptions,
  ParsePrdSession,
} from "../server/parse-prd-manager.js";
import type { SessionCore } from "../server/session/session-core.js";
import type { WsBroadcaster, WsEvent } from "../server/session/ws-broadcaster.js";

// --- Mock DriverRunner ---

const mockRunSession = vi.fn(async () => ({
  signal: { type: "complete" as const },
  durationMs: 1000,
  costUsd: 0.01,
  numTurns: 5,
  resultText: "<task-complete>DONE</task-complete>",
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

// --- Mock parse-prd outcome ---

const mockGetParsePrdOutcome = vi.fn(() => ({ status: "success" as const }));

vi.mock("../core/validate-parse-prd.js", () => ({
  getParsePrdOutcome: (...args: unknown[]) => mockGetParsePrdOutcome(...args),
}));

// --- Mock git commit ---

const mockCommitParsePrdResult = vi.fn(() => true);

vi.mock("../core/git.js", () => ({
  commitParsePrdResult: (...args: unknown[]) => mockCommitParsePrdResult(...args),
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

const defaultStartOpts: ParsePrdStartOptions = {
  agent: "claude",
};

describe("ParsePrdManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driverRunnerConstructorCalls.length = 0;
    capturedOnLog = undefined;
  });

  /**
   * Drain pending async operations (background session callbacks).
   */
  async function drainAsyncOps(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * Helper to build a mock session result with a given signal.
   * Avoids repeating boilerplate fields in each test.
   */
  function sessionResult(signal: { type: string; reason?: string; message?: string }) {
    return {
      signal,
      durationMs: 1000,
      costUsd: 0.01,
      numTurns: 5,
      resultText: "",
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
    const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager.getState()).toBe("idle");
  });

  it("should return null as initial session", () => {
    const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager.getSession()).toBeNull();
  });

  it("should return null as initial outcome", () => {
    const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager.getOutcome()).toBeNull();
  });

  // --- start() tests ---

  describe("start()", () => {
    it("should create session with state=active on idle sessionCore", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", sc, bc);

      await manager.start(defaultStartOpts);

      const session = manager.getSession();
      expect(session).not.toBeNull();
      expect(session!.state).toBe("active");
      expect(session!.agent).toBe("claude");
    });

    it("should generate a UUID for session id", async () => {
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultStartOpts);

      const session = manager.getSession();
      // UUID v4 format
      expect(session!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should store model and variant from options", async () => {
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start({ agent: "claude", model: "opus", variant: "high" });

      const session = manager.getSession();
      expect(session!.model).toBe("opus");
      expect(session!.variant).toBe("high");
    });

    it("should throw ParsePrdSessionActiveError when sessionCore is not idle", async () => {
      const sc = mockSessionCore({
        isIdle: () => false,
        state: "active" as any,
      });
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultStartOpts)).rejects.toThrow(ParsePrdSessionActiveError);
      await expect(manager.start(defaultStartOpts)).rejects.toThrow(/Cannot start parse-prd/);
    });

    it("should throw ParsePrdSessionActiveError when acquire fails (lock contention)", async () => {
      const sc = mockSessionCore({
        acquire: vi.fn(() => { throw new Error("Lock held by another process"); }),
      });
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultStartOpts)).rejects.toThrow(ParsePrdSessionActiveError);
      await expect(manager.start(defaultStartOpts)).rejects.toThrow(/Cannot start parse-prd/);
    });

    it("should call sessionCore.acquire()", async () => {
      const sc = mockSessionCore();
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);

      expect(sc.acquire).toHaveBeenCalledOnce();
    });

    it("should create DriverRunner with agent and model", async () => {
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start({ agent: "claude", model: "opus" });

      expect(driverRunnerConstructorCalls).toHaveLength(1);
      expect(driverRunnerConstructorCalls[0]).toEqual(["claude", "opus"]);
    });

    it("should call driverRunner.setup() with abortSignal", async () => {
      const abortSignal = new AbortController().signal;
      const sc = mockSessionCore({
        getAbortSignal: () => abortSignal,
      });
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);

      expect(driverRunnerSetup).toHaveBeenCalledOnce();
      expect(driverRunnerSetup).toHaveBeenCalledWith(
        expect.objectContaining({ verbosity: "trace", abortSignal }),
        expect.any(Function), // onLog callback
      );
    });

    it("should broadcast parse-prd:started event", async () => {
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);

      const startedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "parse-prd:started",
      );
      expect(startedEvent).toBeDefined();
      expect(startedEvent!.agent).toBe("claude");
      expect(startedEvent!.sessionId).toBeDefined();
    });

    it("should broadcast agent:system_prompt event", async () => {
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);

      const promptEvent = bc.calls.find(
        (e: WsEvent) => e.type === "agent:system_prompt",
      );
      expect(promptEvent).toBeDefined();
      expect(promptEvent!.text).toContain("task decomposition agent");
    });

    it("should clear broadcast buffer before started event", async () => {
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);

      expect(bc.clearBuffer).toHaveBeenCalledOnce();
    });

    it("should pass abortController to runSession for abort propagation", async () => {
      // Capture the runSession call args
      let capturedOpts: any;
      mockRunSession.mockImplementationOnce(async (opts: any) => {
        capturedOpts = opts;
        return sessionResult({ type: "complete" });
      });
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      expect(capturedOpts).toBeDefined();
      expect(capturedOpts.abortController).toBeDefined();
      expect(capturedOpts.abortController).toBeInstanceOf(AbortController);
    });

    it("should cleanup on driverRunner.setup() failure", async () => {
      const sc = mockSessionCore();
      driverRunnerSetup.mockRejectedValueOnce(new Error("Setup failed"));

      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultStartOpts)).rejects.toThrow("Setup failed");

      // Session should be cleaned up
      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
      // Lock should be released
      expect(sc.release).toHaveBeenCalledOnce();
    });

    it("should reset outcome on new start", async () => {
      // Use a failure outcome for the first session so it persists
      // (success outcomes are cleared after broadcast)
      mockGetParsePrdOutcome.mockReturnValueOnce({
        status: "failure",
        errors: ["test error"],
      });

      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", sc, bc);

      await manager.start(defaultStartOpts);
      // Wait for background session to complete
      await drainAsyncOps();

      // Failure outcome should persist
      expect(manager.getOutcome()).not.toBeNull();

      // Make the second runSession hang so we can inspect state before completion
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      // Start a new session on the same manager (sessionCore mock always returns idle)
      await manager.start(defaultStartOpts);

      // After start(), the previous outcome should be cleared via null reset.
      // Since the background session is hanging, outcome stays null.
      expect(manager.getOutcome()).toBeNull();
    });
  });

  // --- stop() tests ---

  describe("stop()", () => {
    it("should be no-op when no session is active", async () => {
      const sc = mockSessionCore();
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      // Should not throw
      await manager.stop();

      expect(sc.abort).not.toHaveBeenCalled();
    });

    it("should call sessionCore.abort()", async () => {
      // Make runSession hang to keep session active
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();

      expect(sc.abort).toHaveBeenCalledOnce();
    });

    it("should reset state to idle after stop", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();

      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
    });

    it("should broadcast parse-prd:finished with cancelled outcome", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await manager.stop();

      const finishedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "parse-prd:finished",
      );
      expect(finishedEvent).toBeDefined();
      expect(finishedEvent!.outcome).toEqual({ status: "cancelled" });
    });

    it("should set outcome to cancelled", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();

      expect(manager.getOutcome()).toEqual({ status: "cancelled" });
    });

    it("should release session lock", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();

      expect(sc.release).toHaveBeenCalled();
    });

    it("should teardown driver", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();

      expect(driverRunnerTeardown).toHaveBeenCalled();
    });
  });

  // --- Background session outcome tests ---

  describe("background session outcome", () => {
    it("should set outcome to success when post-validation passes", async () => {
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "complete" },
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 5,
        resultText: "",
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
      });

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      // Success outcome is cleared after broadcast (not persisted for reconnect)
      expect(manager.getOutcome()).toBeNull();
      // But the broadcast carried the success outcome
      const finished = bc.calls.find((e: WsEvent) => e.type === "parse-prd:finished");
      expect(finished?.outcome).toEqual({ status: "success" });
    });

    it("should set outcome to failure when post-validation fails", async () => {
      mockGetParsePrdOutcome.mockReturnValueOnce({
        status: "failure",
        errors: ["tasks array must contain at least one task"],
      });

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getOutcome()).toEqual({
        status: "failure",
        errors: ["tasks array must contain at least one task"],
      });
    });

    it("should set outcome to failure when agent signals blocked", async () => {
      mockRunSession.mockResolvedValueOnce({
        signal: { type: "blocked", reason: "tasks.json already exists" },
        durationMs: 500,
        costUsd: 0.005,
        numTurns: 2,
        resultText: "",
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

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).errors[0]).toContain("tasks.json already exists");
    });

    it("should set outcome to failure when runSession throws", async () => {
      mockRunSession.mockRejectedValueOnce(new Error("SDK error"));

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).errors[0]).toContain("SDK error");

      // Should broadcast parse-prd:error
      const errorEvent = bc.calls.find((e: WsEvent) => e.type === "parse-prd:error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.message).toContain("SDK error");
    });

    it("should broadcast parse-prd:finished with outcome", async () => {
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      const finishedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "parse-prd:finished",
      );
      expect(finishedEvent).toBeDefined();
      expect(finishedEvent!.outcome).toEqual({ status: "success" });
    });

    it("should cleanup after background session completes", async () => {
      const sc = mockSessionCore();
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      // After background completion, state should return to idle
      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
      expect(sc.release).toHaveBeenCalled();
      expect(driverRunnerTeardown).toHaveBeenCalled();
    });
  });

  // --- Auto-commit after success ---

  describe("auto-commit after success", () => {
    it("calls commitParsePrdResult on success", async () => {
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "complete" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });

      const cwd = "/home/user/project";
      const manager = new ParsePrdManager(cwd, mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      expect(mockCommitParsePrdResult).toHaveBeenCalledOnce();
      expect(mockCommitParsePrdResult).toHaveBeenCalledWith(cwd);
    });

    it("does not call commitParsePrdResult on failure", async () => {
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "complete" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({
        status: "failure",
        errors: ["invalid"],
      });

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      expect(mockCommitParsePrdResult).not.toHaveBeenCalled();
    });

    it("does not call commitParsePrdResult on blocked signal", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "blocked", reason: "conflict" }),
      );

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      expect(mockCommitParsePrdResult).not.toHaveBeenCalled();
    });

    it("commit failure does not affect success outcome", async () => {
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "complete" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });
      mockCommitParsePrdResult.mockReturnValueOnce(false);

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      const finished = bc.calls.find((e: WsEvent) => e.type === "parse-prd:finished");
      expect(finished?.outcome).toEqual({ status: "success" });
    });
  });

  // --- Duplicate start rejection ---

  describe("duplicate start rejection", () => {
    it("should reject second start while first session is active", async () => {
      // Make first session hang
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);

      // Second start should fail because sessionCore.isIdle() returns false
      // We need a new mock that reflects non-idle state
      const sc2 = mockSessionCore({ isIdle: () => false, state: "active" as any });
      const manager2 = new ParsePrdManager("/tmp", sc2, mockBroadcaster());

      await expect(manager2.start(defaultStartOpts)).rejects.toThrow(
        ParsePrdSessionActiveError,
      );
    });
  });

  // --- Agent event streaming via parse-prd channel ---

  describe("agent event streaming", () => {
    it("should pass onLog callback to driverRunner.setup()", async () => {
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultStartOpts);

      expect(capturedOnLog).toBeDefined();
      expect(typeof capturedOnLog).toBe("function");
    });

    it("should broadcast agent events through parse-prd channel via onLog", async () => {
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultStartOpts);

      // Simulate the driver emitting an agent:text event via onLog
      const agentEvent = { type: "agent:text", text: "Analyzing PRD..." };
      capturedOnLog!(agentEvent);

      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        agentEvent,
        "parse-prd",
      );
    });

    it("should broadcast agent:tool events through parse-prd channel via onLog", async () => {
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultStartOpts);

      const toolEvent = {
        type: "agent:tool",
        name: "Read",
        summary: "Reading .taskmaster/docs/prd.md",
      };
      capturedOnLog!(toolEvent);

      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        toolEvent,
        "parse-prd",
      );
    });

    it("should broadcast agent:tool_result events through parse-prd channel via onLog", async () => {
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultStartOpts);

      const resultEvent = {
        type: "agent:tool_result",
        summary: "File contents returned",
      };
      capturedOnLog!(resultEvent);

      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        resultEvent,
        "parse-prd",
      );
    });

    it("should broadcast multiple agent events in sequence", async () => {
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultStartOpts);

      const events = [
        { type: "agent:text", text: "Reading PRD..." },
        { type: "agent:tool", name: "Read", summary: "prd.md" },
        { type: "agent:tool_result", summary: "PRD contents" },
        { type: "agent:text", text: "Generating tasks..." },
      ];

      events.forEach((e) => capturedOnLog!(e));

      // All events should be broadcast with parse-prd channel
      for (const event of events) {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          event,
          "parse-prd",
        );
      }
    });
  });

  // --- Post-validation outcome: stream ends + file state ---

  describe("post-validation outcome", () => {
    it("stream ends with no signal + valid file → success", async () => {
      // Agent finishes without any signal tag (type: "none")
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "none" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      // Success outcome is cleared after broadcast (not persisted for reconnect)
      expect(manager.getOutcome()).toBeNull();

      // Finished event should carry success outcome
      const finishedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "parse-prd:finished",
      );
      expect(finishedEvent).toBeDefined();
      expect(finishedEvent!.outcome).toEqual({ status: "success" });
    });

    it("stream ends with no signal + missing file → failure", async () => {
      // Agent finishes without signal, but tasks.json doesn't exist
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "none" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({
        status: "failure",
        errors: ["tasks.json file not found or unreadable"],
      });

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome).toEqual({
        status: "failure",
        errors: ["tasks.json file not found or unreadable"],
      });
    });

    it("stream ends with no signal + invalid file → failure", async () => {
      // Agent writes an invalid tasks.json (e.g. empty tasks array)
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "none" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({
        status: "failure",
        errors: ["tasks array must contain at least one task"],
      });

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).errors).toContain(
        "tasks array must contain at least one task",
      );
    });

    it("complete signal + invalid file → failure (post-validation takes precedence)", async () => {
      // Agent says DONE, but the file it wrote is invalid.
      // Post-validation should override the agent's success signal.
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "complete" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({
        status: "failure",
        errors: ["all tasks must have status 'pending'", "subtasks must be empty"],
      });

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      // Even though agent signalled complete, outcome should be failure
      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).errors).toEqual([
        "all tasks must have status 'pending'",
        "subtasks must be empty",
      ]);

      // Finished event should carry failure, not success
      const finishedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "parse-prd:finished",
      );
      expect(finishedEvent!.outcome.status).toBe("failure");
    });

    it("blocked signal skips post-validation entirely", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "blocked", reason: "tasks.json already exists" }),
      );

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      // Post-validation should NOT be called for blocked signals
      expect(mockGetParsePrdOutcome).not.toHaveBeenCalled();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).errors[0]).toContain("Agent signalled blocked");
    });

    it("error signal + valid file → failure (error takes precedence over file state)", async () => {
      // Agent signals error, but tasks.json happens to be valid from a previous run.
      // Error signal should short-circuit to failure — post-validation must NOT be called.
      // Note: we intentionally do NOT mock getParsePrdOutcome here — the error path
      // should skip it entirely, and setting a mockReturnValueOnce that never gets
      // consumed would leak into subsequent tests.
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "error", message: "SDK context limit exceeded" }),
      );

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      // Post-validation should NOT be called for error signals
      expect(mockGetParsePrdOutcome).not.toHaveBeenCalled();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).errors[0]).toContain("SDK context limit exceeded");
    });

    it("error signal produces failure even without valid file", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "error", message: "Connection timeout" }),
      );

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expect(outcome!.status).toBe("failure");
      expect((outcome as any).errors[0]).toContain("Agent error: Connection timeout");

      // Finished event should carry failure
      const finishedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "parse-prd:finished",
      );
      expect(finishedEvent!.outcome.status).toBe("failure");
    });

    it("calls getParsePrdOutcome with the correct cwd", async () => {
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "complete" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });

      const cwd = "/home/user/project";
      const manager = new ParsePrdManager(cwd, mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      expect(mockGetParsePrdOutcome).toHaveBeenCalledWith(cwd);
    });

    it("parse-prd:finished event carries failure errors from post-validation", async () => {
      mockRunSession.mockResolvedValueOnce(sessionResult({ type: "none" }));
      mockGetParsePrdOutcome.mockReturnValueOnce({
        status: "failure",
        errors: ["invalid JSON syntax", "missing required field: title"],
      });

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      const finishedEvent = bc.calls.find(
        (e: WsEvent) => e.type === "parse-prd:finished",
      );
      expect(finishedEvent).toBeDefined();
      expect(finishedEvent!.outcome).toEqual({
        status: "failure",
        errors: ["invalid JSON syntax", "missing required field: title"],
      });
    });
  });

  // --- Stop / cancel / cleanup race tests (subtask 7.3) ---

  describe("double stop", () => {
    it("second stop() is a no-op and does not throw", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", sc, bc);

      await manager.start(defaultStartOpts);
      await manager.stop();
      // Second stop — should silently no-op
      await manager.stop();

      expect(manager.getState()).toBe("idle");
    });

    it("second stop() does not broadcast a duplicate parse-prd:finished", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);

      // Clear calls so we only count post-stop events
      vi.mocked(bc.broadcastWithChannel).mockClear();
      bc.calls.length = 0;

      await manager.stop();
      await manager.stop();

      const finishedCount = bc.calls.filter(
        (e: WsEvent) => e.type === "parse-prd:finished",
      ).length;
      expect(finishedCount).toBe(1);
    });

    it("double stop() does not produce false success — outcome stays cancelled", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();
      await manager.stop();

      expect(manager.getOutcome()).toEqual({ status: "cancelled" });
    });
  });

  describe("restart after cleanup", () => {
    it("start() succeeds after stop() has cleaned up the previous session", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);
      const firstSessionId = manager.getSession()!.id;
      await manager.stop();

      // Make second session also hang
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      await manager.start(defaultStartOpts);

      const secondSession = manager.getSession();
      expect(secondSession).not.toBeNull();
      expect(secondSession!.id).not.toBe(firstSessionId);
      expect(secondSession!.state).toBe("active");
    });

    it("restart resets outcome to null before new session runs", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();
      expect(manager.getOutcome()).toEqual({ status: "cancelled" });

      // Start a hanging session — outcome must be null while in progress
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      await manager.start(defaultStartOpts);

      expect(manager.getOutcome()).toBeNull();
    });

    it("restarted session can complete with its own outcome", async () => {
      // First session: stop immediately
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();

      // Second session: runs to completion with success
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });

      await manager.start(defaultStartOpts);
      await drainAsyncOps();

      // Success outcome is cleared after broadcast (not persisted for reconnect)
      expect(manager.getOutcome()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });

    it("lock is released after stop, allowing new acquire", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ParsePrdManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);
      await manager.stop();

      // Lock release count should match or exceed acquire count
      expect(sc.release).toHaveBeenCalled();

      // A fresh start should be able to acquire again
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      await manager.start(defaultStartOpts);

      expect(manager.getState()).toBe("active");
    });
  });

  describe("race: stop() vs background session finish", () => {
    it("finishedSent guard prevents duplicate parse-prd:finished when stop races with normal completion", async () => {
      // Background session resolves quickly, and stop() runs near-simultaneously
      let resolveSession: (() => void) | undefined;
      mockRunSession.mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveSession = () =>
            resolve({
              signal: { type: "complete" },
              durationMs: 100,
              costUsd: 0.001,
              numTurns: 1,
              resultText: "",
              inputTokens: 10,
              outputTokens: 20,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              model: "claude-sonnet",
              agentReport: null,
              reviewReport: null,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            });
        }),
      );
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });

      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);

      // Clear calls so we only count post-race events
      vi.mocked(bc.broadcastWithChannel).mockClear();
      bc.calls.length = 0;

      // Resolve the background session and immediately stop
      resolveSession!();
      await manager.stop();
      await drainAsyncOps();

      // Exactly one parse-prd:finished — not two
      const finishedEvents = bc.calls.filter(
        (e: WsEvent) => e.type === "parse-prd:finished",
      );
      expect(finishedEvents.length).toBe(1);
    });

    it("stop() before background completes yields cancelled, not success", async () => {
      // Background session hangs until we explicitly resolve it
      let resolveSession: (() => void) | undefined;
      mockRunSession.mockImplementationOnce(() =>
        new Promise((resolve) => {
          resolveSession = () =>
            resolve({
              signal: { type: "complete" },
              durationMs: 100,
              costUsd: 0.001,
              numTurns: 1,
              resultText: "",
              inputTokens: 10,
              outputTokens: 20,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              model: "claude-sonnet",
              agentReport: null,
              reviewReport: null,
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            });
        }),
      );
      mockGetParsePrdOutcome.mockReturnValueOnce({ status: "success" });

      const manager = new ParsePrdManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);
      // Stop before the session completes
      await manager.stop();

      // Now let the background session resolve (its finally block runs)
      resolveSession!();
      await drainAsyncOps();

      // Outcome must be cancelled (set by stop), not success
      expect(manager.getOutcome()).toEqual({ status: "cancelled" });
    });
  });

  describe("cleanup race: stale session does not destroy new session", () => {
    it("old background finally block does not cleanup a newly started session", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", sc, bc);

      // First session: hangs until we reject it
      let rejectSession1: ((err: Error) => void) | undefined;
      mockRunSession.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectSession1 = reject; }),
      );

      await manager.start(defaultStartOpts);
      const session1Id = manager.getSession()!.id;

      // Stop first session — cleanup runs eagerly, session becomes null
      await manager.stop();
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");

      // Reset mocks for tracking second session's cleanup
      vi.mocked(sc.release).mockClear();
      driverRunnerTeardown.mockClear();

      // Start a second session (hangs)
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));
      await manager.start(defaultStartOpts);
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

    it("stop() broadcasts exactly one parse-prd:finished (stale session does not duplicate)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ParsePrdManager("/tmp", sc, bc);

      // Session that hangs until rejected
      let rejectSession: ((err: Error) => void) | undefined;
      mockRunSession.mockImplementationOnce(
        () => new Promise((_resolve, reject) => { rejectSession = reject; }),
      );

      await manager.start(defaultStartOpts);

      // Clear to count only post-stop events
      vi.mocked(bc.broadcastWithChannel).mockClear();
      bc.calls.length = 0;

      await manager.stop();

      // Now let the stale session reject — its finally block runs
      rejectSession!(new Error("AbortError"));
      await drainAsyncOps();

      // Exactly one parse-prd:finished from stop(), not a second from the stale session
      const finishedCount = bc.calls.filter(
        (e: WsEvent) => e.type === "parse-prd:finished",
      ).length;
      expect(finishedCount).toBe(1);
    });
  });
});
