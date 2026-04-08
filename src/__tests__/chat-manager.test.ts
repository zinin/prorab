import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatManager } from "../server/chat-manager.js";
import type { ChatStartOptions, ChatSession } from "../server/chat-manager.js";
import type { SessionCore } from "../server/session/session-core.js";
import type { WsBroadcaster, WsEvent } from "../server/session/ws-broadcaster.js";
import type { ChatEvent } from "../core/drivers/types.js";

// --- Mock DriverRunner ---
// We mock the module so ChatManager's `new DriverRunner(...)` creates our mock.

const mockDriver = {
  startChat: vi.fn((): AsyncIterable<ChatEvent> => (async function* () {})()),
  sendMessage: vi.fn(),
  replyQuestion: vi.fn(),
  abortChat: vi.fn(),
  runSession: vi.fn(),
};

// Track constructor calls and hold per-instance mocks
const driverRunnerConstructorCalls: Array<[string, string | undefined]> = [];
const driverRunnerSetup = vi.fn(async () => {});
const driverRunnerTeardown = vi.fn(async () => {});
const driverRunnerGetDriver = vi.fn(() => mockDriver);

vi.mock("../server/session/driver-runner.js", () => {
  return {
    DriverRunner: class MockDriverRunner {
      constructor(agent: string, model?: string) {
        driverRunnerConstructorCalls.push([agent, model]);
      }
      setup = driverRunnerSetup;
      teardown = driverRunnerTeardown;
      getDriver = driverRunnerGetDriver;
      setOnLog = vi.fn();
      runSession = vi.fn();
      get setupDone() { return true; }
      get agent() { return "claude" as const; }
      get model() { return undefined; }
      get userSettings() { return false; }
      listModels = vi.fn(async () => []);
    },
  };
});

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

const defaultStartOpts: ChatStartOptions = {
  agent: "claude",
  systemPrompt: "You are a helpful assistant.",
};

describe("ChatManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    driverRunnerConstructorCalls.length = 0;
  });

  // --- Shared helpers ---

  /**
   * Helper: start a ChatManager whose mock driver emits given events
   * then hangs indefinitely (to allow mid-stream state inspection).
   * Returns a `release` callback to unblock the stream.
   */
  async function startWithHangingStream(
    events: ChatEvent[],
    overrides?: { bc?: ReturnType<typeof mockBroadcaster>; sc?: SessionCore },
  ) {
    const bc = overrides?.bc ?? mockBroadcaster();
    const sc = overrides?.sc ?? mockSessionCore();
    const manager = new ChatManager("/tmp", sc, bc);

    let hangResolve: (() => void) | undefined;
    mockDriver.startChat.mockReturnValueOnce(
      (async function* () {
        for (const e of events) yield e;
        await new Promise<void>((r) => { hangResolve = r; });
      })(),
    );

    await manager.start(defaultStartOpts);
    // Wrap in closure: hangResolve is assigned by the generator
    // only when it reaches the hanging await (after all events are yielded).
    return { manager, bc, sc, release: () => hangResolve?.() };
  }

  /**
   * Drain pending async operations (microtasks, stale stream callbacks).
   * Used in tests that assert absence of duplicate events after stream cleanup.
   */
  async function drainAsyncOps(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  // --- Basic construction tests (from subtask 8.1) ---

  it("should create an instance with mock dependencies", () => {
    const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager).toBeInstanceOf(ChatManager);
  });

  it("should return 'idle' as initial state", () => {
    const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager.getState()).toBe("idle");
  });

  it("should return null as initial session", () => {
    const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());
    expect(manager.getSession()).toBeNull();
  });

  // --- start() tests ---

  describe("start()", () => {
    it("should create session with awaitingUserInput=true on idle sessionCore", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      await manager.start(defaultStartOpts);

      const session = manager.getSession();
      expect(session).not.toBeNull();
      expect(session!.awaitingUserInput).toBe(true);
      expect(session!.state).toBe("active");
      expect(session!.agent).toBe("claude");
      expect(session!.systemPrompt).toBe("You are a helpful assistant.");
      expect(session!.pendingQuestionId).toBeNull();
    });

    it("should generate a UUID for session id", async () => {
      const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultStartOpts);

      const session = manager.getSession();
      // UUID v4 format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(session!.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("should throw when sessionCore is not idle", async () => {
      const sc = mockSessionCore({
        isIdle: () => false,
        state: "active" as any,
      });
      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultStartOpts)).rejects.toThrow(
        /Cannot start chat/,
      );
    });

    it("should call sessionCore.acquire()", async () => {
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);

      expect(sc.acquire).toHaveBeenCalledOnce();
    });

    it("should create DriverRunner with agent and model", async () => {
      const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start({ ...defaultStartOpts, agent: "claude", model: "opus" });

      expect(driverRunnerConstructorCalls).toHaveLength(1);
      expect(driverRunnerConstructorCalls[0]).toEqual(["claude", "opus"]);
    });

    it("should call driverRunner.setup() with abortSignal", async () => {
      const abortSignal = new AbortController().signal;
      const sc = mockSessionCore({
        getAbortSignal: () => abortSignal,
      });
      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultStartOpts);

      expect(driverRunnerSetup).toHaveBeenCalledOnce();
      expect(driverRunnerSetup).toHaveBeenCalledWith(
        expect.objectContaining({ verbosity: "info", abortSignal }),
      );
    });

    it("should call driver.startChat() with correct options", async () => {
      const manager = new ChatManager("/tmp/test", mockSessionCore(), mockBroadcaster());

      await manager.start({
        agent: "claude",
        systemPrompt: "Test prompt",
        variant: "high",
      });

      expect(mockDriver.startChat).toHaveBeenCalledOnce();
      expect(mockDriver.startChat).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: "Test prompt",
          cwd: "/tmp/test",
          variant: "high",
          verbosity: "info",
        }),
      );
    });

    it("should broadcast chat:started with session id, agent, and model", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);

      // start() broadcasts chat:started + agent:system_prompt (when systemPrompt is provided)
      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chat:started",
          sessionId: manager.getSession()!.id,
          agent: "claude",
        }),
        "chat",
      );
    });

    it("should broadcast agent:system_prompt when systemPrompt is provided", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);

      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "agent:system_prompt",
          text: "You are a helpful assistant.",
        }),
        "chat",
      );
    });

    it("should not broadcast agent:system_prompt when systemPrompt is not provided", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      await manager.start({ agent: "claude" });

      const systemPromptCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls
        .filter(([event]: [WsEvent]) => event.type === "agent:system_prompt");
      expect(systemPromptCalls).toHaveLength(0);
    });

    it("should clear ring buffer before broadcasting chat:started", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultStartOpts);

      expect(bc.clearBuffer).toHaveBeenCalledOnce();
    });

    it("should set state to 'active' after start", async () => {
      const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start(defaultStartOpts);

      expect(manager.getState()).toBe("active");
    });

    it("should pass optional model and variant to session", async () => {
      const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());

      await manager.start({
        agent: "opencode",
        model: "gpt-4",
        variant: "high",
        systemPrompt: "Test",
      });

      const session = manager.getSession();
      expect(session!.agent).toBe("opencode");
      expect(session!.model).toBe("gpt-4");
      expect(session!.variant).toBe("high");
    });

    // --- Error handling ---

    it("should release session and clean up if driverRunner.setup() fails", async () => {
      const sc = mockSessionCore();
      driverRunnerSetup.mockRejectedValueOnce(new Error("setup boom"));

      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultStartOpts)).rejects.toThrow("setup boom");

      // Session should be cleaned up
      expect(sc.release).toHaveBeenCalledOnce();
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
      // teardown should be attempted
      expect(driverRunnerTeardown).toHaveBeenCalledOnce();
    });

    it("should release session if startChat() throws", async () => {
      const sc = mockSessionCore();
      mockDriver.startChat.mockImplementationOnce(() => {
        throw new Error("startChat boom");
      });

      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultStartOpts)).rejects.toThrow("startChat boom");

      expect(sc.release).toHaveBeenCalledOnce();
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });

    it("should not broadcast chat:started if setup fails", async () => {
      const bc = mockBroadcaster();
      driverRunnerSetup.mockRejectedValueOnce(new Error("fail"));

      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      await expect(manager.start(defaultStartOpts)).rejects.toThrow("fail");

      expect(bc.broadcastWithChannel).not.toHaveBeenCalled();
    });

    it("should not call acquire if sessionCore is not idle", async () => {
      const sc = mockSessionCore({
        isIdle: () => false,
        state: "active" as any,
      });
      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultStartOpts)).rejects.toThrow();

      expect(sc.acquire).not.toHaveBeenCalled();
    });
  });

  // --- Event translation tests (subtask 8.3) ---

  describe("event translation (ChatEvent → WsEvent)", () => {
    /**
     * Helper: start a ChatManager whose mock driver emits the given ChatEvent array.
     * Returns the manager, broadcaster, and session core for assertions.
     */
    async function startWithEvents(
      events: ChatEvent[],
      overrides?: { bc?: ReturnType<typeof mockBroadcaster>; sc?: SessionCore },
    ) {
      const bc = overrides?.bc ?? mockBroadcaster();
      const sc = overrides?.sc ?? mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          for (const e of events) yield e;
        })(),
      );

      await manager.start(defaultStartOpts);
      return { manager, bc, sc };
    }

    it("translates 'text' ChatEvent to 'agent:text' WsEvent with channel='chat'", async () => {
      const { bc } = await startWithEvents([
        { type: "text", content: "Hello world" },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "agent:text", text: "Hello world" }),
          "chat",
        );
      });
    });

    it("translates 'tool' ChatEvent to 'agent:tool' WsEvent with name, summary, input", async () => {
      const { bc } = await startWithEvents([
        { type: "tool", name: "Read", input: { file_path: "/foo.ts" } },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "agent:tool",
            name: "Read",
            summary: "Read",
            input: { file_path: "/foo.ts" },
          }),
          "chat",
        );
      });
    });

    it("translates 'tool_result' ChatEvent to 'agent:tool_result' WsEvent with summary, output", async () => {
      const { bc } = await startWithEvents([
        { type: "tool_result", name: "Read", output: "file contents here" },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "agent:tool_result",
            summary: "Read",
            output: "file contents here",
          }),
          "chat",
        );
      });
    });

    it("translates 'context_usage' ChatEvent to 'agent:context_usage' WsEvent with usage fields spread at top level", async () => {
      const { bc } = await startWithEvents([
        { type: "context_usage", usage: { totalTokens: 1000, maxTokens: 200000 } },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "agent:context_usage",
            totalTokens: 1000,
            maxTokens: 200000,
          }),
          "chat",
        );
      });
    });

    it("translates 'question' ChatEvent to 'chat:question' WsEvent and sets state to question_pending", async () => {
      const questionEvent: ChatEvent = {
        type: "question",
        questionId: "q-abc",
        questions: [{
          question: "Pick one",
          header: "Choice",
          options: [{ label: "A", description: "Option A" }],
          multiSelect: false,
        }],
        source: "claude",
      };

      const { manager, bc, release } = await startWithHangingStream([questionEvent]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "chat:question",
            questionId: "q-abc",
            questions: questionEvent.questions,
            source: "claude",
          }),
          "chat",
        );
      });

      // State checks while stream is still active (not yet cleaned up)
      expect(manager.getState()).toBe("question_pending");
      expect(manager.getSession()!.pendingQuestionId).toBe("q-abc");
      expect(manager.getSession()!.awaitingUserInput).toBe(false);

      release(); // unblock the hanging stream
    });

    it("translates 'idle' ChatEvent to 'chat:idle' WsEvent, keeps state=active, sets awaitingUserInput=true", async () => {
      const { manager, bc, release } = await startWithHangingStream([
        { type: "idle" as const },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // idle does NOT change lifecycle state to "idle" — it stays "active"
      expect(manager.getState()).toBe("active");
      expect(manager.getSession()!.awaitingUserInput).toBe(true);
      expect(manager.getSession()!.pendingQuestionId).toBeNull();

      release();
    });

    it("does not broadcast 'question_answer' event (local storage only)", async () => {
      const { bc } = await startWithEvents([
        { type: "question_answer", questionId: "q1", answers: { "Pick one": "A" } },
      ]);

      // Wait for stream to finish (chat:finished is always the terminal event)
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Verify question_answer was never broadcast
      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);
      expect(types).not.toContain("chat:question_answer");
      expect(types).not.toContain("question_answer");
    });

    it("broadcasts 'chat:error' then 'chat:finished' on error ChatEvent (error always precedes finished)", async () => {
      const { bc } = await startWithEvents([
        { type: "error", message: "Something went wrong" },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Verify order: chat:error comes BEFORE chat:finished
      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);

      const errorIdx = types.indexOf("chat:error");
      const finishedIdx = types.indexOf("chat:finished");

      expect(errorIdx).toBeGreaterThan(-1);
      expect(finishedIdx).toBeGreaterThan(errorIdx); // error always precedes finished

      // Verify error message is passed through
      expect((allCalls[errorIdx][0] as WsEvent).message).toBe("Something went wrong");
    });

    it("broadcasts 'chat:finished' after normal stream end (finished ChatEvent)", async () => {
      const { bc } = await startWithEvents([
        { type: "text", content: "done" },
        { type: "finished" },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);

      expect(types).toContain("chat:started");
      expect(types).toContain("agent:text");
      expect(types).toContain("chat:finished");
    });

    it("broadcasts chat:error + chat:finished when stream throws an exception", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "hello" };
          throw new Error("Stream exploded");
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);

      const errorIdx = types.indexOf("chat:error");
      const finishedIdx = types.indexOf("chat:finished");

      expect(errorIdx).toBeGreaterThan(-1);
      expect(finishedIdx).toBeGreaterThan(errorIdx); // error always precedes finished
      expect((allCalls[errorIdx][0] as WsEvent).message).toContain("Stream exploded");
    });

    it("cleans up session after stream ends (teardown, release, null state)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const { manager } = await startWithEvents(
        [{ type: "text", content: "hello" }],
        { bc, sc },
      );

      // Wait for stream to complete
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // After cleanup, session should be null, state idle
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
      expect(sc.release).toHaveBeenCalled();
      expect(driverRunnerTeardown).toHaveBeenCalled();
    });

    it("question → idle transition restores awaitingUserInput and clears pendingQuestionId", async () => {
      const { manager, bc, release } = await startWithHangingStream([
        {
          type: "question" as const,
          questionId: "q1",
          questions: [{ question: "?", header: "H", options: [], multiSelect: false }],
          source: "claude" as const,
        },
        { type: "idle" as const },
      ]);

      // Wait for idle event to be processed
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // After idle, state should be back to active with awaitingUserInput
      expect(manager.getState()).toBe("active");
      expect(manager.getSession()!.awaitingUserInput).toBe(true);
      expect(manager.getSession()!.pendingQuestionId).toBeNull();

      release();
    });

    it("all WsEvents are broadcast with channel='chat'", async () => {
      const { bc } = await startWithEvents([
        { type: "text", content: "hi" },
        { type: "tool", name: "Bash", input: { command: "ls" } },
        { type: "tool_result", name: "Bash", output: "file1.ts" },
        { type: "context_usage", usage: { tokens: 50 } },
        { type: "idle" },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Every call to broadcastWithChannel should use "chat" channel
      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of allCalls) {
        expect(call[1]).toBe("chat");
      }
    });

    it("multiple text events are each broadcast separately", async () => {
      const { bc } = await startWithEvents([
        { type: "text", content: "first" },
        { type: "text", content: "second" },
        { type: "text", content: "third" },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const textEvents = allCalls
        .map((c: unknown[]) => c[0] as WsEvent)
        .filter((e: WsEvent) => e.type === "agent:text");

      expect(textEvents).toHaveLength(3);
      expect(textEvents[0].text).toBe("first");
      expect(textEvents[1].text).toBe("second");
      expect(textEvents[2].text).toBe("third");
    });
  });

  // --- sendMessage() tests (subtask 8.4) ---

  describe("sendMessage()", () => {
    /**
     * Helper: start a ChatManager with a hanging stream that emits given events,
     * then waits for user input.
     */
    async function startAndWaitForIdle(
      events: ChatEvent[] = [],
      overrides?: { bc?: ReturnType<typeof mockBroadcaster>; sc?: SessionCore },
    ) {
      const bc = overrides?.bc ?? mockBroadcaster();
      const sc = overrides?.sc ?? mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          for (const e of events) yield e;
          // Hang to keep the stream alive
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);
      return { manager, bc, sc, release: () => hangResolve?.() };
    }

    it("should throw when no session exists", async () => {
      const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());

      await expect(manager.sendMessage("hello")).rejects.toThrow(
        "Cannot send message: chat is not waiting for user input",
      );
    });

    it("should throw when state is not 'active'", async () => {
      // Start session and set state to question_pending via a question event
      const questionEvent: ChatEvent = {
        type: "question",
        questionId: "q1",
        questions: [{ question: "?", header: "H", options: [], multiSelect: false }],
        source: "claude",
      };
      const { manager, release } = await startAndWaitForIdle([questionEvent]);

      // Wait for question event to be processed
      await vi.waitFor(() => {
        expect(manager.getState()).toBe("question_pending");
      });

      await expect(manager.sendMessage("hello")).rejects.toThrow(
        "Cannot send message: chat is not waiting for user input",
      );

      release();
    });

    it("should throw when awaitingUserInput is false (before first idle)", async () => {
      // Start session — awaitingUserInput starts as true right after start().
      // But if we set it to false manually, sendMessage should reject.
      const { manager, release } = await startAndWaitForIdle();

      // awaitingUserInput is true right after start() — sendMessage should succeed.
      // First call: driver.sendMessage gets called, awaitingUserInput becomes false.
      await manager.sendMessage("first message");
      expect(mockDriver.sendMessage).toHaveBeenCalledWith("first message");

      // Second call: awaitingUserInput is now false, should throw
      await expect(manager.sendMessage("second message")).rejects.toThrow(
        "Cannot send message: chat is not waiting for user input",
      );

      release();
    });

    it("should call driver.sendMessage and set awaitingUserInput=false on success", async () => {
      const { manager, release } = await startAndWaitForIdle();

      // Session is active and awaitingUserInput=true after start()
      expect(manager.getSession()!.awaitingUserInput).toBe(true);

      await manager.sendMessage("Hello agent");

      expect(mockDriver.sendMessage).toHaveBeenCalledOnce();
      expect(mockDriver.sendMessage).toHaveBeenCalledWith("Hello agent");
      expect(manager.getSession()!.awaitingUserInput).toBe(false);

      release();
    });

    it("should succeed after idle event restores awaitingUserInput", async () => {
      const { manager, release } = await startAndWaitForIdle([
        { type: "idle" as const },
      ]);

      // Wait for idle event to be processed
      await vi.waitFor(() => {
        expect(manager.getSession()!.awaitingUserInput).toBe(true);
      });

      await manager.sendMessage("after idle");

      expect(mockDriver.sendMessage).toHaveBeenCalledWith("after idle");
      expect(manager.getSession()!.awaitingUserInput).toBe(false);

      release();
    });
  });

  // --- replyQuestion() tests (subtask 8.4) ---

  describe("replyQuestion()", () => {
    async function startWithQuestion() {
      const bc = mockBroadcaster();
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      const questionEvent: ChatEvent = {
        type: "question",
        questionId: "q-abc",
        questions: [{
          question: "Pick a color",
          header: "Color",
          options: [{ label: "Red", description: "Red color" }],
          multiSelect: false,
        }],
        source: "claude",
      };

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield questionEvent;
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for question event to be processed
      await vi.waitFor(() => {
        expect(manager.getState()).toBe("question_pending");
      });

      return { manager, bc, sc, release: () => hangResolve?.() };
    }

    it("should throw when no session exists", async () => {
      const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());

      await expect(
        manager.replyQuestion("q1", { "Pick one": "A" }),
      ).rejects.toThrow("Cannot reply: no pending question");
    });

    it("should throw when state is not question_pending", async () => {
      const bc = mockBroadcaster();
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );
      await manager.start(defaultStartOpts);

      // State is 'active', not 'question_pending'
      await expect(
        manager.replyQuestion("q1", { "Pick one": "A" }),
      ).rejects.toThrow("Cannot reply: no pending question");

      hangResolve?.();
    });

    it("should throw on question ID mismatch", async () => {
      const { manager, release } = await startWithQuestion();

      await expect(
        manager.replyQuestion("wrong-id", { "Pick a color": "Red" }),
      ).rejects.toThrow("Question ID mismatch");

      release();
    });

    it("should call driver.replyQuestion and reset state on valid reply", async () => {
      const { manager, release } = await startWithQuestion();

      const answers = { "Pick a color": "Red" };
      await manager.replyQuestion("q-abc", answers);

      expect(mockDriver.replyQuestion).toHaveBeenCalledOnce();
      expect(mockDriver.replyQuestion).toHaveBeenCalledWith("q-abc", answers);

      // State should be reset
      expect(manager.getSession()!.pendingQuestionId).toBeNull();
      expect(manager.getSession()!.state).toBe("active");
      expect(manager.getSession()!.awaitingUserInput).toBe(false);

      release();
    });
  });

  // --- stop() tests (subtask 8.4) ---

  describe("stop()", () => {
    it("should be a no-op when no session exists", async () => {
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      // Should not throw
      await manager.stop();

      expect(mockDriver.abortChat).not.toHaveBeenCalled();
      expect(sc.abort).not.toHaveBeenCalled();
    });

    it("should abort driver, abort sessionCore, and cleanup", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);
      expect(manager.getState()).toBe("active");

      await manager.stop();

      // Verify abort was called
      expect(mockDriver.abortChat).toHaveBeenCalledOnce();
      expect(sc.abort).toHaveBeenCalledOnce();

      // Verify cleanup happened
      expect(driverRunnerTeardown).toHaveBeenCalled();
      expect(sc.release).toHaveBeenCalled();

      // Session should be null after cleanup
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });

    it("should set state to 'stopping' and awaitingUserInput=false before cleanup", async () => {
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      // Track state changes during stop by hooking into abortChat
      let stateAtAbort: string | undefined;
      let awaitingAtAbort: boolean | undefined;
      mockDriver.abortChat.mockImplementation(() => {
        const session = manager.getSession();
        stateAtAbort = session?.state;
        awaitingAtAbort = session?.awaitingUserInput;
      });

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);
      await manager.stop();

      // At the time abortChat was called, state should have been 'stopping'
      expect(stateAtAbort).toBe("stopping");
      expect(awaitingAtAbort).toBe(false);
    });
  });

  // --- Cleanup and questionId ownership tests (subtask 8.5) ---

  describe("cleanup logic", () => {
    it("cleanup() calls teardown and release", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "hello" };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for stream to finish and cleanup to happen
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Verify teardown and release were called
      expect(driverRunnerTeardown).toHaveBeenCalled();
      expect(sc.release).toHaveBeenCalled();
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });

    it("cleanup() is called automatically when start() fails", async () => {
      const sc = mockSessionCore();
      driverRunnerSetup.mockRejectedValueOnce(new Error("driver setup failed"));

      const manager = new ChatManager("/tmp", sc, mockBroadcaster());

      await expect(manager.start(defaultStartOpts)).rejects.toThrow("driver setup failed");

      // Cleanup should have been invoked
      expect(driverRunnerTeardown).toHaveBeenCalledOnce();
      expect(sc.release).toHaveBeenCalledOnce();
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });

    it("cleanup() is called after error ChatEvent", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "error" as const, message: "agent crashed" };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // After cleanup
      expect(driverRunnerTeardown).toHaveBeenCalled();
      expect(sc.release).toHaveBeenCalled();
      expect(manager.getSession()).toBeNull();
    });

    it("cleanup() is called after stop()", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);
      await manager.stop();

      expect(driverRunnerTeardown).toHaveBeenCalled();
      expect(sc.release).toHaveBeenCalled();
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });
  });

  describe("questionId ownership", () => {
    it("questionId from driver passes through unchanged to chat:question broadcast", async () => {
      const bc = mockBroadcaster();
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      const driverQuestionId = "driver-generated-q-id-42";
      const questionEvent: ChatEvent = {
        type: "question",
        questionId: driverQuestionId,
        questions: [{
          question: "Pick a color",
          header: "Color",
          options: [{ label: "Red", description: "Red" }],
          multiSelect: false,
        }],
        source: "claude",
      };

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield questionEvent;
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(manager.getState()).toBe("question_pending");
      });

      // Verify the exact questionId from driver is in the broadcast
      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "chat:question",
          questionId: driverQuestionId,
        }),
        "chat",
      );

      // Verify pendingQuestionId matches the driver's questionId
      expect(manager.getSession()!.pendingQuestionId).toBe(driverQuestionId);

      hangResolve?.();
    });

    it("questionId from driver reaches replyQuestion() unchanged", async () => {
      const bc = mockBroadcaster();
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      const driverQuestionId = "driver-q-unchanged-99";
      const questionEvent: ChatEvent = {
        type: "question",
        questionId: driverQuestionId,
        questions: [{
          question: "Choose",
          header: "Choice",
          options: [{ label: "A", description: "Option A" }],
          multiSelect: false,
        }],
        source: "claude",
      };

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield questionEvent;
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(manager.getState()).toBe("question_pending");
      });

      const answers = { Choose: "A" };
      await manager.replyQuestion(driverQuestionId, answers);

      // Verify driver.replyQuestion was called with the exact same questionId
      expect(mockDriver.replyQuestion).toHaveBeenCalledWith(driverQuestionId, answers);

      hangResolve?.();
    });
  });

  describe("chat:ended / chat:finished guarantees", () => {
    it("chat:ended is never broadcast in any scenario", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "hello" };
          yield { type: "error" as const, message: "oops" };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);

      expect(types).not.toContain("chat:ended");
    });

    it("chat:error is broadcast exactly once before chat:finished on error", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "error" as const, message: "something broke" };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);

      // Exactly one chat:error
      const errorCount = types.filter((t: string) => t === "chat:error").length;
      expect(errorCount).toBe(1);

      // Exactly one chat:finished
      const finishedCount = types.filter((t: string) => t === "chat:finished").length;
      expect(finishedCount).toBe(1);

      // chat:error comes before chat:finished
      const errorIdx = types.indexOf("chat:error");
      const finishedIdx = types.indexOf("chat:finished");
      expect(errorIdx).toBeLessThan(finishedIdx);
    });

    it("chat:finished is broadcast exactly once on normal completion", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "done" };
          yield { type: "finished" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);

      const finishedCount = types.filter((t: string) => t === "chat:finished").length;
      expect(finishedCount).toBe(1);

      // No error should be present on normal completion
      expect(types).not.toContain("chat:error");
    });

    it("chat:ended never appears on stream exception", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          throw new Error("Unexpected failure");
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);

      expect(types).not.toContain("chat:ended");
      expect(types).toContain("chat:error");
      expect(types).toContain("chat:finished");
    });
  });

  // --- Regression tests for code review fixes ---

  describe("driver null safety (sendMessage / replyQuestion)", () => {
    it("sendMessage throws descriptive error when driver is null (no non-null assertion crash)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      // Simulate driver becoming unavailable (race with stop/cleanup)
      driverRunnerGetDriver.mockReturnValueOnce(undefined as any);

      await expect(manager.sendMessage("hello")).rejects.toThrow(
        "Cannot send message: driver not available",
      );

      // awaitingUserInput should be restored so user can retry
      expect(manager.getSession()!.awaitingUserInput).toBe(true);

      hangResolve?.();
    });

    it("replyQuestion throws descriptive error when driver is null", async () => {
      const bc = mockBroadcaster();
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      const questionEvent: ChatEvent = {
        type: "question",
        questionId: "q-null-driver",
        questions: [{
          question: "Pick",
          header: "H",
          options: [{ label: "A", description: "A" }],
          multiSelect: false,
        }],
        source: "claude",
      };

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield questionEvent;
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(manager.getState()).toBe("question_pending");
      });

      // Simulate driver becoming unavailable
      driverRunnerGetDriver.mockReturnValueOnce(undefined as any);

      await expect(
        manager.replyQuestion("q-null-driver", { Pick: "A" }),
      ).rejects.toThrow("Cannot reply: driver not available");

      hangResolve?.();
    });
  });

  describe("awaitingUserInput recovery on driver error", () => {
    it("restores awaitingUserInput=true when driver.sendMessage throws", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);
      expect(manager.getSession()!.awaitingUserInput).toBe(true);

      // Make driver.sendMessage throw synchronously
      mockDriver.sendMessage.mockImplementationOnce(() => {
        throw new Error("No active chat session");
      });

      await expect(manager.sendMessage("boom")).rejects.toThrow("No active chat session");

      // awaitingUserInput should be restored so the user can retry
      expect(manager.getSession()!.awaitingUserInput).toBe(true);

      // Subsequent sendMessage should work (driver no longer throws)
      mockDriver.sendMessage.mockImplementationOnce(() => {});
      await manager.sendMessage("retry after error");
      expect(mockDriver.sendMessage).toHaveBeenCalledWith("retry after error");

      hangResolve?.();
    });
  });

  describe("intentional stop() does not broadcast spurious chat:error", () => {
    it("stop() during active stream does not produce chat:error when stream throws AbortError", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let rejectStream: ((err: Error) => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "hello" };
          // Simulate a stream that throws when aborted
          await new Promise<void>((_resolve, reject) => { rejectStream = reject; });
        })(),
      );

      // Make abortChat trigger the stream rejection (simulating real abort behavior)
      mockDriver.abortChat.mockImplementation(() => {
        rejectStream?.(new Error("AbortError: The operation was aborted"));
      });

      await manager.start(defaultStartOpts);

      // Wait for text event to confirm stream is running
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "agent:text" }),
          "chat",
        );
      });

      await manager.stop();

      // Wait for chat:finished to ensure stream processing is complete
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Verify no chat:error was broadcast (the AbortError should be suppressed)
      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const types = allCalls.map((c: unknown[]) => (c[0] as WsEvent).type);
      expect(types).not.toContain("chat:error");
    });
  });

  describe("cleanup race: stale stream does not destroy new session", () => {
    it("old stream's finally block does not cleanup a newly started session", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      // First session: stream hangs until we reject it
      let rejectStream1: ((err: Error) => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "session1" };
          await new Promise<void>((_resolve, reject) => { rejectStream1 = reject; });
        })(),
      );

      // Override abortChat to trigger stream rejection
      mockDriver.abortChat.mockImplementation(() => {
        rejectStream1?.(new Error("AbortError"));
      });

      await manager.start(defaultStartOpts);
      const session1Id = manager.getSession()!.id;

      // Stop the first session — cleanup runs eagerly, session becomes null
      await manager.stop();
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");

      // Reset mocks for second session
      vi.mocked(sc.release).mockClear();
      vi.mocked(sc.acquire).mockClear();
      (sc as any).state = "idle";
      driverRunnerTeardown.mockClear();

      // Start a second session — old stream's finally hasn't run yet
      let hangResolve2: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "session2" };
          await new Promise<void>((r) => { hangResolve2 = r; });
        })(),
      );

      await manager.start(defaultStartOpts);
      const session2Id = manager.getSession()!.id;
      expect(session2Id).not.toBe(session1Id);

      // Drain pending async operations (old stream's AbortError propagation)
      await drainAsyncOps();

      // The new session should still be alive — the old stream's finally block
      // should NOT have destroyed it (ownership token mismatch)
      expect(manager.getSession()).not.toBeNull();
      expect(manager.getSession()!.id).toBe(session2Id);
      expect(manager.getState()).toBe("active");

      // Teardown should NOT have been called again by the stale stream
      expect(driverRunnerTeardown).not.toHaveBeenCalled();
      // Release should NOT have been called again by the stale stream
      expect(sc.release).not.toHaveBeenCalled();

      hangResolve2?.();
    });

    it("stop() broadcasts exactly one chat:finished (stale stream does not duplicate)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let rejectStream: ((err: Error) => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "hello" };
          await new Promise<void>((_resolve, reject) => { rejectStream = reject; });
        })(),
      );

      mockDriver.abortChat.mockImplementation(() => {
        rejectStream?.(new Error("AbortError"));
      });

      await manager.start(defaultStartOpts);

      // Wait for text event
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "agent:text" }),
          "chat",
        );
      });

      // Clear broadcast calls to count only post-stop events
      vi.mocked(bc.broadcastWithChannel).mockClear();

      await manager.stop();

      // Drain pending async operations (stale stream processing)
      await drainAsyncOps();

      // Exactly one chat:finished from stop(), not a second from the stale stream
      const allCalls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
      const finishedCount = allCalls
        .map((c: unknown[]) => (c[0] as WsEvent).type)
        .filter((t: string) => t === "chat:finished").length;
      expect(finishedCount).toBe(1);
    });
  });

  describe("replyQuestion error recovery", () => {
    it("restores question_pending state when driver.replyQuestion throws", async () => {
      const bc = mockBroadcaster();
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      const questionEvent: ChatEvent = {
        type: "question",
        questionId: "q-recover",
        questions: [{
          question: "Pick",
          header: "H",
          options: [{ label: "A", description: "A" }],
          multiSelect: false,
        }],
        source: "claude",
      };

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield questionEvent;
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(manager.getState()).toBe("question_pending");
      });

      // Make driver.replyQuestion throw
      mockDriver.replyQuestion.mockImplementationOnce(() => {
        throw new Error("Driver reply failed");
      });

      await expect(
        manager.replyQuestion("q-recover", { Pick: "A" }),
      ).rejects.toThrow("Driver reply failed");

      // State should remain question_pending with the original questionId
      expect(manager.getState()).toBe("question_pending");
      expect(manager.getSession()!.pendingQuestionId).toBe("q-recover");

      // Retry should work with a working driver
      mockDriver.replyQuestion.mockImplementationOnce(() => {});
      await manager.replyQuestion("q-recover", { Pick: "A" });

      expect(manager.getState()).toBe("active");
      expect(manager.getSession()!.pendingQuestionId).toBeNull();

      hangResolve?.();
    });
  });

  // --- Per-turn buffer and auto-finish guard tests (subtask 3.1) ---

  describe("per-turn buffer accumulation", () => {
    it("accumulates text events into the turn buffer", async () => {
      const { manager, bc, release } = await startWithHangingStream([
        { type: "text", content: "Hello " },
        { type: "text", content: "world" },
        { type: "text", content: "!" },
      ]);

      // Wait for last text event to be processed
      await vi.waitFor(() => {
        const calls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
        const textEvents = calls.filter(
          (c: unknown[]) => (c[0] as any).type === "agent:text",
        );
        expect(textEvents).toHaveLength(3);
      });

      expect(manager._getTurnBuffer()).toBe("Hello world!");

      release();
    });

    it("buffer starts empty on new session", async () => {
      const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());

      // Before start — no session yet
      expect(manager._getTurnBuffer()).toBe("");

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          // empty stream
        })(),
      );

      await manager.start(defaultStartOpts);

      // After start, before any text events — buffer is still empty
      expect(manager._getTurnBuffer()).toBe("");
    });

    it("buffer resets after idle event (turn boundary)", async () => {
      const { manager, bc, release } = await startWithHangingStream([
        { type: "text", content: "first turn text" },
        { type: "idle" },
      ]);

      // Wait for idle event to be processed
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // Buffer should be cleared after idle
      expect(manager._getTurnBuffer()).toBe("");

      release();
    });

    it("buffer accumulates fresh text after idle reset", async () => {
      const { manager, bc, release } = await startWithHangingStream([
        { type: "text", content: "turn-1" },
        { type: "idle" },
        { type: "text", content: "turn-2" },
      ]);

      // Wait for second text event to be processed
      await vi.waitFor(() => {
        const calls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
        const textEvents = calls.filter(
          (c: unknown[]) => (c[0] as any).type === "agent:text",
        );
        expect(textEvents).toHaveLength(2);
      });

      // Buffer should contain only second turn's text
      expect(manager._getTurnBuffer()).toBe("turn-2");

      release();
    });

    it("tool and tool_result events do not affect the turn buffer", async () => {
      const { manager, bc, release } = await startWithHangingStream([
        { type: "text", content: "before-tool" },
        { type: "tool", name: "Read", input: { file_path: "/foo" } },
        { type: "tool_result", name: "Read", output: "contents" },
        { type: "text", content: "-after-tool" },
      ]);

      // Wait for all events to be processed
      await vi.waitFor(() => {
        const calls = (bc.broadcastWithChannel as ReturnType<typeof vi.fn>).mock.calls;
        const textEvents = calls.filter(
          (c: unknown[]) => (c[0] as any).type === "agent:text",
        );
        expect(textEvents).toHaveLength(2);
      });

      // Only text events go into the buffer
      expect(manager._getTurnBuffer()).toBe("before-tool-after-tool");

      release();
    });

    it("buffer resets on start() even after prior session had content", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      // First session: stream with text that ends
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "old-session-text" };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for stream to finish (cleanup resets buffer)
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // After cleanup, buffer should be empty
      expect(manager._getTurnBuffer()).toBe("");

      // Reset mocks for second session
      vi.mocked(sc.release).mockClear();
      vi.mocked(sc.acquire).mockClear();
      (sc as any).state = "idle";
      (sc as any).isIdle = () => true;
      vi.mocked(bc.broadcastWithChannel).mockClear();

      // Second session
      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "new-session" };
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "agent:text", text: "new-session" }),
          "chat",
        );
      });

      // Buffer should only contain new session text
      expect(manager._getTurnBuffer()).toBe("new-session");

      hangResolve?.();
    });
  });

  describe("auto-finish guard", () => {
    it("autoFinishFired is false on new session", async () => {
      const manager = new ChatManager("/tmp", mockSessionCore(), mockBroadcaster());

      expect(manager._isAutoFinishFired()).toBe(false);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);
      expect(manager._isAutoFinishFired()).toBe(false);

      hangResolve?.();
    });

    it("auto-finish terminates stream when turn buffer contains terminal <prd-ready>", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "Here is your PRD.\n" };
          yield { type: "text" as const, content: "<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
          // Events after auto-finish should NOT be processed
          yield { type: "text" as const, content: "unreachable" };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Auto-finish terminates the stream: chat:idle then chat:finished
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Verify event order: chat:idle comes before chat:finished, no chat:error
      const types = bc.calls.map((e: WsEvent) => e.type);
      expect(types.indexOf("chat:idle")).toBeGreaterThan(-1);
      expect(types.indexOf("chat:finished")).toBeGreaterThan(types.indexOf("chat:idle"));
      expect(types).not.toContain("chat:error");

      // "unreachable" text should NOT have been broadcast
      const textEvents = bc.calls.filter((e: WsEvent) => e.type === "agent:text");
      expect(textEvents.every((e: any) => e.text !== "unreachable")).toBe(true);

      // After cleanup: session null, guard and buffer reset
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
      expect(manager._isAutoFinishFired()).toBe(false);
      expect(manager._getTurnBuffer()).toBe("");
      expect(sc.release).toHaveBeenCalled();
      expect(driverRunnerTeardown).toHaveBeenCalled();
    });

    it("autoFinishFired remains false when turn buffer has no <prd-ready>", async () => {
      const { manager, bc, release } = await startWithHangingStream([
        { type: "text", content: "Just a regular response" },
        { type: "idle" },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      expect(manager._isAutoFinishFired()).toBe(false);

      release();
    });

    it("autoFinishFired remains false when <prd-ready> is not terminal (mid-text)", async () => {
      const { manager, bc, release } = await startWithHangingStream([
        { type: "text", content: "Use <prd-ready>true</prd-ready> when ready. More text follows." },
        { type: "idle" },
      ]);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // Non-terminal occurrence — should NOT fire auto-finish
      expect(manager._isAutoFinishFired()).toBe(false);

      release();
    });

    it("stream terminates after first auto-finish — second turn is never processed", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "PRD complete\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
          // Second turn should never be reached (stream terminates above)
          yield { type: "text" as const, content: "Another turn\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Only one chat:idle should be broadcast (stream stopped after first auto-finish)
      const types = bc.calls.map((e: WsEvent) => e.type);
      const idleCount = types.filter((t: string) => t === "chat:idle").length;
      expect(idleCount).toBe(1);

      // Exactly one chat:finished
      const finishedCount = types.filter((t: string) => t === "chat:finished").length;
      expect(finishedCount).toBe(1);

      // Second turn's text should not have been broadcast
      const textContents = bc.calls
        .filter((e: WsEvent) => e.type === "agent:text")
        .map((e: any) => e.text);
      expect(textContents).not.toContain("Another turn\n<prd-ready>true</prd-ready>");
    });

    it("autoFinishFired resets on start() for a new session", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      // First session: trigger auto-finish
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "PRD\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for stream to complete
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // After cleanup, autoFinishFired should be reset
      expect(manager._isAutoFinishFired()).toBe(false);

      // Reset mocks for second session
      vi.mocked(sc.release).mockClear();
      vi.mocked(sc.acquire).mockClear();
      (sc as any).state = "idle";
      (sc as any).isIdle = () => true;
      vi.mocked(bc.broadcastWithChannel).mockClear();

      // Second session
      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "new session" };
          yield { type: "idle" as const };
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // No <prd-ready> in second session → guard not fired
      expect(manager._isAutoFinishFired()).toBe(false);

      hangResolve?.();
    });

    it("auto-finish cleanup resets guard and buffer", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "PRD\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for auto-finish to complete
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // After auto-finish cleanup, guard and buffer are reset
      expect(manager._isAutoFinishFired()).toBe(false);
      expect(manager._getTurnBuffer()).toBe("");
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });

    it("auto-finish works with <prd-ready> split across multiple text chunks", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "Here is the PRD\n<prd-" };
          yield { type: "text" as const, content: "ready>true</" };
          yield { type: "text" as const, content: "prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Auto-finish should trigger: chat:idle followed by chat:finished
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // The concatenated buffer was correctly parsed — stream terminated
      const types = bc.calls.map((e: WsEvent) => e.type);
      expect(types.indexOf("chat:idle")).toBeLessThan(types.indexOf("chat:finished"));
      expect(types).not.toContain("chat:error");

      // Session cleaned up
      expect(manager.getSession()).toBeNull();
      expect(sc.release).toHaveBeenCalled();
    });
  });

  // --- Auto-finish graceful stop tests (subtask 3.2) ---

  describe("auto-finish graceful stop", () => {
    it("auto-finish does not call driver.abortChat()", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "Done.\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      // Clear any prior abortChat calls from beforeEach
      mockDriver.abortChat.mockClear();

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Auto-finish should NOT invoke abort — it's a graceful stream termination
      expect(mockDriver.abortChat).not.toHaveBeenCalled();
    });

    it("sendMessage() is rejected during auto-finish teardown window", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      // Use a slow-teardown so we can test the window between auto-finish
      // detection and cleanup completion
      let teardownResolve: (() => void) | undefined;
      driverRunnerTeardown.mockImplementationOnce(
        () => new Promise<void>((r) => { teardownResolve = r; }),
      );

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "PRD\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for idle to be broadcast (auto-finish detected)
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // Wait for cleanup to start (teardown is called but blocked)
      await vi.waitFor(() => {
        expect(driverRunnerTeardown).toHaveBeenCalled();
      });

      // During the teardown window, sendMessage() should be rejected
      // because state was set to "stopping" before cleanup began
      await expect(manager.sendMessage("should fail")).rejects.toThrow(
        "Cannot send message: chat is not waiting for user input",
      );

      // Unblock teardown to let cleanup finish
      teardownResolve?.();

      await drainAsyncOps();
    });

    it("no auto-stop when <prd-ready> appears as inline instruction (not terminal)", async () => {
      const bc = mockBroadcaster();
      const sc = mockSessionCore();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "When done, output <prd-ready>true</prd-ready> to finish." };
          yield { type: "idle" as const };
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for idle to be processed
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // Stream should continue — no auto-finish on inline/quoted tag
      expect(manager.getState()).toBe("active");
      expect(manager.getSession()).not.toBeNull();
      expect(manager._isAutoFinishFired()).toBe(false);

      // No chat:finished should have been broadcast yet
      const types = bc.calls.map((e: WsEvent) => e.type);
      expect(types).not.toContain("chat:finished");

      hangResolve?.();
    });

    it("auto-finish produces exactly one chat:finished", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "PRD output\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Drain pending async operations (ensure no stale duplicates)
      await drainAsyncOps();

      const types = bc.calls.map((e: WsEvent) => e.type);
      const finishedCount = types.filter((t: string) => t === "chat:finished").length;
      expect(finishedCount).toBe(1);

      // No error on clean auto-finish
      expect(types).not.toContain("chat:error");
    });

    it("all text events are broadcast before auto-finish terminates the stream", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "Here " };
          yield { type: "text" as const, content: "is " };
          yield { type: "text" as const, content: "the PRD.\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // All three text events should have been broadcast before auto-finish
      const textEvents = bc.calls
        .filter((e: WsEvent) => e.type === "agent:text")
        .map((e: any) => e.text);
      expect(textEvents).toEqual(["Here ", "is ", "the PRD.\n<prd-ready>true</prd-ready>"]);

      // chat:idle comes after all text events, before chat:finished
      const types = bc.calls.map((e: WsEvent) => e.type);
      const lastTextIdx = types.lastIndexOf("agent:text");
      const idleIdx = types.indexOf("chat:idle");
      const finishedIdx = types.indexOf("chat:finished");
      expect(lastTextIdx).toBeLessThan(idleIdx);
      expect(idleIdx).toBeLessThan(finishedIdx);
    });

    it("manual stop still works after normal idle (no <prd-ready>)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "Regular response" };
          yield { type: "idle" as const };
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      mockDriver.abortChat.mockImplementation(() => {
        hangResolve?.();
      });

      await manager.start(defaultStartOpts);

      // Wait for idle
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // Session is active, no auto-finish
      expect(manager.getState()).toBe("active");
      expect(manager._isAutoFinishFired()).toBe(false);

      // Manual stop should work as before
      await manager.stop();

      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");

      // chat:finished should be broadcast (from stop())
      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        expect.objectContaining({ type: "chat:finished" }),
        "chat",
      );
    });
  });

  // --- Integration tests: event ordering and auto-stop / manual-stop race (subtask 3.3) ---

  describe("integration: client-facing event ordering", () => {
    it("complete auto-finish event sequence: started → system_prompt → text(s) → idle → finished (no error)", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "# Product Requirements\n" };
          yield { type: "text" as const, content: "## Overview\nGreat product.\n" };
          yield { type: "text" as const, content: "<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Verify the COMPLETE ordered event sequence a WS client would receive
      const types = bc.calls.map((e: WsEvent) => e.type);
      expect(types).toEqual([
        "chat:started",
        "agent:system_prompt",
        "agent:text",       // "# Product Requirements\n"
        "agent:text",       // "## Overview\nGreat product.\n"
        "agent:text",       // "<prd-ready>true</prd-ready>"
        "chat:idle",
        "chat:finished",
      ]);

      // No error events in auto-finish flow
      expect(types).not.toContain("chat:error");
    });

    it("multi-turn auto-finish: regular turn → idle → PRD turn with marker → auto-finish", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          // Turn 1: regular response (no marker)
          yield { type: "text" as const, content: "Let me clarify the requirements." };
          yield { type: "idle" as const };
          // Turn 2: PRD with terminal marker
          yield { type: "text" as const, content: "# Final PRD\n" };
          yield { type: "text" as const, content: "Here it is.\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
          // Turn 3: should never be reached
          yield { type: "text" as const, content: "UNREACHABLE" };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const types = bc.calls.map((e: WsEvent) => e.type);

      // Verify complete multi-turn sequence
      expect(types).toEqual([
        "chat:started",
        "agent:system_prompt",
        // Turn 1
        "agent:text",       // "Let me clarify the requirements."
        "chat:idle",        // turn boundary (no auto-finish — no marker)
        // Turn 2
        "agent:text",       // "# Final PRD\n"
        "agent:text",       // "Here it is.\n<prd-ready>true</prd-ready>"
        "chat:idle",        // turn boundary (auto-finish triggers)
        "chat:finished",
      ]);

      // "UNREACHABLE" text should NOT appear
      const textContents = bc.calls
        .filter((e: WsEvent) => e.type === "agent:text")
        .map((e: any) => e.text);
      expect(textContents).not.toContain("UNREACHABLE");

      // Two idle events: first from turn 1 (pass-through), second from turn 2 (auto-finish)
      const idleCount = types.filter((t: string) => t === "chat:idle").length;
      expect(idleCount).toBe(2);

      // Exactly one chat:finished
      expect(types.filter((t: string) => t === "chat:finished")).toHaveLength(1);
    });

    it("auto-finish with interleaved tool events: text → tool → tool_result → text(marker) → idle → finished", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "Let me read the spec.\n" };
          yield { type: "tool" as const, name: "Read", input: { file_path: "/spec.md" } };
          yield { type: "tool_result" as const, name: "Read", output: "Spec contents..." };
          yield { type: "text" as const, content: "# PRD\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      const types = bc.calls.map((e: WsEvent) => e.type);
      expect(types).toEqual([
        "chat:started",
        "agent:system_prompt",
        "agent:text",         // "Let me read the spec.\n"
        "agent:tool",         // Read tool invocation
        "agent:tool_result",  // Read result
        "agent:text",         // "# PRD\n<prd-ready>true</prd-ready>"
        "chat:idle",
        "chat:finished",
      ]);

      // Tool events should not pollute the turn buffer — only text matters for <prd-ready>
      expect(types).not.toContain("chat:error");
    });

    it("final text with marker is broadcast to UI BEFORE chat:finished", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      const markerText = "Here's the PRD.\n<prd-ready>true</prd-ready>";
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: markerText };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Find the agent:text event that contains the marker
      const textIdx = bc.calls.findIndex(
        (e: WsEvent) => e.type === "agent:text" && (e as any).text === markerText,
      );
      const idleIdx = bc.calls.findIndex((e: WsEvent) => e.type === "chat:idle");
      const finishedIdx = bc.calls.findIndex((e: WsEvent) => e.type === "chat:finished");

      // Client must see: text(marker) → idle → finished
      expect(textIdx).toBeGreaterThan(-1);
      expect(textIdx).toBeLessThan(idleIdx);
      expect(idleIdx).toBeLessThan(finishedIdx);
    });

    it("manual stop is fallback when no <prd-ready> — complete sequence ends with stop-initiated finished", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();

      let hangResolve: (() => void) | undefined;
      const { manager, release } = await startWithHangingStream(
        [
          { type: "text", content: "Regular answer without PRD signal." },
          { type: "idle" },
        ],
        { bc, sc },
      );

      // abortChat unblocks the hanging stream
      mockDriver.abortChat.mockImplementation(() => {
        release();
      });

      // Wait for idle
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // No auto-finish should have triggered
      expect(manager._isAutoFinishFired()).toBe(false);
      expect(manager.getState()).toBe("active");

      // Manual stop serves as fallback
      await manager.stop();

      const types = bc.calls.map((e: WsEvent) => e.type);

      // Verify manual stop sequence: started → prompt → text → idle → finished
      expect(types).toEqual([
        "chat:started",
        "agent:system_prompt",
        "agent:text",
        "chat:idle",
        "chat:finished",    // from manual stop()
      ]);

      expect(types).not.toContain("chat:error");
    });
  });

  describe("integration: no double chat:finished on auto-stop + manual-stop race", () => {
    it("stop() called immediately after auto-finish produces exactly one chat:finished", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "PRD done.\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for auto-finish to complete
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Now call stop() — should be a no-op since session is already cleaned up
      await manager.stop();

      // Drain pending async operations (ensure no stale duplicates)
      await drainAsyncOps();

      const types = bc.calls.map((e: WsEvent) => e.type);
      const finishedCount = types.filter((t: string) => t === "chat:finished").length;
      expect(finishedCount).toBe(1);
      expect(types).not.toContain("chat:error");
    });

    it("stop() called while auto-finish is processing (during cleanup) still produces exactly one chat:finished", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      // Use a slow-teardown to simulate the window where auto-finish cleanup
      // is in progress and stop() is called
      let teardownResolve: (() => void) | undefined;
      driverRunnerTeardown.mockImplementationOnce(
        () => new Promise<void>((r) => { teardownResolve = r; }),
      );

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "Final PRD.\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for idle to be broadcast (auto-finish detected, cleanup starting)
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // Wait for the for-await-of loop to break and cleanup to start
      // (teardown is called when cleanup begins)
      await vi.waitFor(() => {
        expect(driverRunnerTeardown).toHaveBeenCalled();
      });

      // Try stop() while cleanup is in progress (teardown is blocked)
      const stopPromise = manager.stop();

      // Unblock the teardown so cleanup finishes
      teardownResolve?.();

      await stopPromise;

      // Drain pending async operations (ensure no stale duplicates)
      await drainAsyncOps();

      const types = bc.calls.map((e: WsEvent) => e.type);
      const finishedCount = types.filter((t: string) => t === "chat:finished").length;

      // Must have exactly one chat:finished — no duplicates from the race
      expect(finishedCount).toBe(1);
      expect(types).not.toContain("chat:error");
    });

    it("stop() during active session (no auto-finish) produces exactly one chat:finished and no error", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "Working on it..." };
          yield { type: "idle" as const };
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      mockDriver.abortChat.mockImplementation(() => {
        hangResolve?.();
      });

      await manager.start(defaultStartOpts);

      // Wait for idle
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      await manager.stop();

      // Drain pending async operations (ensure no stale duplicates)
      await drainAsyncOps();

      const types = bc.calls.map((e: WsEvent) => e.type);
      const finishedCount = types.filter((t: string) => t === "chat:finished").length;
      expect(finishedCount).toBe(1);
      expect(types).not.toContain("chat:error");

      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
    });

    it("rapid stop-then-start does not leak stale auto-finish into new session", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      // Session 1: auto-finishes with <prd-ready>
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "PRD\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for auto-finish
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Reset mocks and state for new session
      vi.mocked(sc.release).mockClear();
      vi.mocked(sc.acquire).mockClear();
      (sc as any).state = "idle";
      (sc as any).isIdle = () => true;
      vi.mocked(bc.broadcastWithChannel).mockClear();
      bc.calls.length = 0;

      // Session 2: regular conversation, no auto-finish
      let hangResolve2: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "New chat conversation." };
          yield { type: "idle" as const };
          await new Promise<void>((r) => { hangResolve2 = r; });
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for idle in new session
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:idle" }),
          "chat",
        );
      });

      // The new session should be active (no stale auto-finish leaking)
      expect(manager.getState()).toBe("active");
      expect(manager._isAutoFinishFired()).toBe(false);
      expect(manager.getSession()).not.toBeNull();

      // No chat:finished in session 2 yet
      const types2 = bc.calls.map((e: WsEvent) => e.type);
      expect(types2).not.toContain("chat:finished");
      expect(types2).not.toContain("chat:error");

      hangResolve2?.();
    });

    it("auto-finish race: two idle events in quick succession produce only one chat:finished", async () => {
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", mockSessionCore(), bc);

      // Scenario: driver yields text with marker, then two idle events back-to-back
      // (edge case: protocol quirk or driver bug)
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "PRD content\n<prd-ready>true</prd-ready>" };
          yield { type: "idle" as const };
          // Second idle should be unreachable (stream terminated by first)
          yield { type: "idle" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      // Drain pending async operations (ensure no stale duplicates from second idle)
      await drainAsyncOps();

      const types = bc.calls.map((e: WsEvent) => e.type);
      const finishedCount = types.filter((t: string) => t === "chat:finished").length;
      const idleCount = types.filter((t: string) => t === "chat:idle").length;

      // Only one idle (stream breaks on first), exactly one finished
      expect(idleCount).toBe(1);
      expect(finishedCount).toBe(1);
      expect(types).not.toContain("chat:error");
    });
  });
});
