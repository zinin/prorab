/**
 * Edge-case tests for chat: WS reconnect, abort during pending question,
 * concurrent chat+execute access, and browser refresh recovery.
 *
 * Tests cover:
 * 1. WS reconnect during chat — replay from ring buffer, pending question restoration
 * 2. Abort during pending AskUserQuestion — reject, cleanup, no broken state
 * 3. Concurrent chat + execute — 409 Conflict in both directions
 * 4. Browser refresh during chat — recovery from WS connected state
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatManager, ChatSessionActiveError } from "../server/chat-manager.js";
import type { ChatStartOptions } from "../server/chat-manager.js";
import type { SessionCore } from "../server/session/session-core.js";
import {
  WsBroadcaster,
  type WsEvent,
} from "../server/session/ws-broadcaster.js";
import { SessionCore as RealSessionCore } from "../server/session/session-core.js";
import type { ChatEvent } from "../core/drivers/types.js";
import Fastify from "fastify";
import { chatRoutes } from "../server/routes/chat.js";
import { executionRoutes } from "../server/routes/execution.js";

// --- Mock DriverRunner ---

const mockDriver = {
  startChat: vi.fn((): AsyncIterable<ChatEvent> => (async function* () {})()),
  sendMessage: vi.fn(),
  replyQuestion: vi.fn(),
  abortChat: vi.fn(),
  runSession: vi.fn(),
};

const driverRunnerSetup = vi.fn(async () => {});
const driverRunnerTeardown = vi.fn(async () => {});
const driverRunnerGetDriver = vi.fn(() => mockDriver);

vi.mock("../server/session/driver-runner.js", () => {
  return {
    DriverRunner: class MockDriverRunner {
      constructor(_agent: string, _model?: string) {}
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
    get bufferSize() { return 0; },
    get buffer() { return []; },
  } as unknown as WsBroadcaster & { calls: WsEvent[] };
}

const defaultStartOpts: ChatStartOptions = {
  agent: "claude",
  systemPrompt: "You are a helpful assistant.",
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ====================================================================
// 1. WS Reconnect during chat — ring buffer replay
// ====================================================================

describe("Edge case: WS reconnect during chat", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("WsBroadcaster ring buffer replay", () => {
    it("replays chat events including pending question to reconnecting client", () => {
      // Use real WsBroadcaster for this test
      // Using imported WsBroadcaster (real, not mocked)
      const clients = new Set<{ readyState: number; send(data: string): void }>();
      const bc = new WsBroadcaster(clients);

      const sock1 = { readyState: 1, send: vi.fn() };
      clients.add(sock1);

      // Simulate chat lifecycle events
      bc.broadcastWithChannel({ type: "chat:started", sessionId: "s1", agent: "claude" }, "chat");
      bc.broadcastWithChannel({ type: "agent:text", text: "Hello!" }, "chat");
      bc.broadcastWithChannel({ type: "chat:idle" }, "chat");
      bc.broadcastWithChannel({ type: "agent:text", text: "Processing..." }, "chat");
      bc.broadcastWithChannel({
        type: "chat:question",
        questionId: "q-42",
        questions: [{ question: "Pick one", header: "Choice", options: [{ label: "A" }], multiSelect: false }],
        source: "claude",
      }, "chat");

      // sock1 disconnects
      clients.delete(sock1);

      // New socket reconnects
      const sock2 = { readyState: 1, send: vi.fn() };
      clients.add(sock2);
      bc.replay(sock2);

      // Verify all events are replayed in order
      expect(sock2.send).toHaveBeenCalledTimes(5);
      const replayed = sock2.send.mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string),
      );

      expect(replayed[0].type).toBe("chat:started");
      expect(replayed[1].type).toBe("agent:text");
      expect(replayed[2].type).toBe("chat:idle");
      expect(replayed[3].type).toBe("agent:text");
      expect(replayed[4].type).toBe("chat:question");
      expect(replayed[4].questionId).toBe("q-42");

      // All replayed events should have channel='chat'
      for (const event of replayed) {
        expect(event.channel).toBe("chat");
      }
    });

    it("replays events with correct timestamps (timestamps from original broadcast)", () => {
      // Using imported WsBroadcaster (real, not mocked)
      const clients = new Set<{ readyState: number; send(data: string): void }>();
      const bc = new WsBroadcaster(clients);

      const beforeBroadcast = Date.now();
      bc.broadcastWithChannel({ type: "chat:started", sessionId: "s1" }, "chat");
      bc.broadcastWithChannel({ type: "agent:text", text: "Hello" }, "chat");

      const sock = { readyState: 1, send: vi.fn() };
      bc.replay(sock);

      const events = sock.send.mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string),
      );

      // Timestamps should be from the original broadcast time
      for (const event of events) {
        expect(event.timestamp).toBeGreaterThanOrEqual(beforeBroadcast);
        expect(event.timestamp).toBeLessThanOrEqual(Date.now());
      }
    });

    it("replay stops if socket closes mid-replay (graceful handling)", () => {
      // Using imported WsBroadcaster (real, not mocked)
      const clients = new Set<{ readyState: number; send(data: string): void }>();
      const bc = new WsBroadcaster(clients);

      // Buffer several events
      for (let i = 0; i < 10; i++) {
        bc.broadcastWithChannel({ type: "agent:text", text: `msg-${i}` }, "chat");
      }

      // Socket that closes after first send
      const flakySock = { readyState: 1, send: vi.fn(() => { flakySock.readyState = 3; }) };
      bc.replay(flakySock);

      // Only the first event should be sent
      expect(flakySock.send).toHaveBeenCalledTimes(1);
    });

    it("chat and execution events coexist in replay buffer", () => {
      // Using imported WsBroadcaster (real, not mocked)
      const clients = new Set<{ readyState: number; send(data: string): void }>();
      const bc = new WsBroadcaster(clients);

      // Mix of chat and execution events
      bc.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
      bc.broadcastWithChannel({ type: "chat:started", sessionId: "c1" }, "chat");
      bc.broadcastWithChannel({ type: "agent:text", text: "exec output" }, "execute");
      bc.broadcastWithChannel({ type: "agent:text", text: "chat output" }, "chat");

      const sock = { readyState: 1, send: vi.fn() };
      bc.replay(sock);

      const events = sock.send.mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string),
      );

      expect(events).toHaveLength(4);
      expect(events[0].channel).toBe("execute");
      expect(events[1].channel).toBe("chat");
      expect(events[2].channel).toBe("execute");
      expect(events[3].channel).toBe("chat");
    });
  });

  describe("ChatManager state during reconnect", () => {
    it("chat session remains active during client disconnect/reconnect", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
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

      // Simulate time passing (client disconnected then reconnected)
      // ChatManager state should be unchanged
      expect(manager.getState()).toBe("active");
      expect(manager.getSession()!.awaitingUserInput).toBe(true);

      // Can still send messages after reconnect
      await manager.sendMessage("Hello after reconnect");
      expect(mockDriver.sendMessage).toHaveBeenCalledWith("Hello after reconnect");

      hangResolve?.();
    });

    it("pending question survives client disconnect and is retrievable via getSession()", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      const questionEvent: ChatEvent = {
        type: "question",
        questionId: "q-reconnect-42",
        questions: [{
          question: "Which framework?",
          header: "Framework",
          options: [
            { label: "React", description: "Popular UI lib" },
            { label: "Vue", description: "Progressive framework" },
          ],
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

      // Simulate client disconnect + reconnect (server state is unaffected)
      const session = manager.getSession();
      expect(session).not.toBeNull();
      expect(session!.state).toBe("question_pending");
      expect(session!.pendingQuestionId).toBe("q-reconnect-42");

      // Can still reply to the question after reconnect
      await manager.replyQuestion("q-reconnect-42", { "Which framework?": "React" });
      expect(mockDriver.replyQuestion).toHaveBeenCalledWith("q-reconnect-42", { "Which framework?": "React" });
      expect(manager.getState()).toBe("active");

      hangResolve?.();
    });
  });
});

// ====================================================================
// 2. Abort during pending AskUserQuestion
// ====================================================================

describe("Edge case: abort during pending AskUserQuestion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stop() during question_pending cleans up and transitions to idle", async () => {
    const sc = mockSessionCore();
    const bc = mockBroadcaster();
    const manager = new ChatManager("/tmp", sc, bc);

    const questionEvent: ChatEvent = {
      type: "question",
      questionId: "q-abort-me",
      questions: [{
        question: "Pick a database",
        header: "DB",
        options: [
          { label: "PostgreSQL", description: "Relational" },
          { label: "MongoDB", description: "Document" },
        ],
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

    // Wait for question to be processed
    await vi.waitFor(() => {
      expect(manager.getState()).toBe("question_pending");
    });

    // Verify question is pending
    expect(manager.getSession()!.pendingQuestionId).toBe("q-abort-me");
    expect(manager.getSession()!.awaitingUserInput).toBe(false);

    // Stop while question is pending
    await manager.stop();

    // Verify cleanup
    expect(mockDriver.abortChat).toHaveBeenCalledOnce();
    expect(sc.abort).toHaveBeenCalledOnce();
    expect(driverRunnerTeardown).toHaveBeenCalledOnce();
    expect(sc.release).toHaveBeenCalledOnce();

    // State should be fully cleaned up
    expect(manager.getSession()).toBeNull();
    expect(manager.getState()).toBe("idle");

    // chat:finished should have been broadcast
    const finishedCalls = bc.calls.filter(e => e.type === "chat:finished");
    expect(finishedCalls.length).toBe(1);
  });

  it("stop() during question_pending does not broadcast spurious chat:error", async () => {
    const sc = mockSessionCore();
    const bc = mockBroadcaster();
    const manager = new ChatManager("/tmp", sc, bc);

    const questionEvent: ChatEvent = {
      type: "question",
      questionId: "q-abort-clean",
      questions: [{
        question: "Pick",
        header: "H",
        options: [{ label: "A", description: "A" }],
        multiSelect: false,
      }],
      source: "claude",
    };

    let rejectStream: ((err: Error) => void) | undefined;
    mockDriver.startChat.mockReturnValueOnce(
      (async function* () {
        yield questionEvent;
        await new Promise<void>((_resolve, reject) => { rejectStream = reject; });
      })(),
    );

    // Make abortChat trigger stream rejection (simulating real abort behavior)
    mockDriver.abortChat.mockImplementation(() => {
      rejectStream?.(new Error("AbortError: The operation was aborted"));
    });

    await manager.start(defaultStartOpts);

    await vi.waitFor(() => {
      expect(manager.getState()).toBe("question_pending");
    });

    await manager.stop();

    // Wait for any stale stream processing
    await new Promise((r) => setTimeout(r, 50));

    // No chat:error should be broadcast — only chat:finished
    const errorCalls = bc.calls.filter(e => e.type === "chat:error");
    expect(errorCalls).toHaveLength(0);

    const finishedCalls = bc.calls.filter(e => e.type === "chat:finished");
    expect(finishedCalls.length).toBe(1);
  });

  it("cannot reply to question after stop() — session is null", async () => {
    const sc = mockSessionCore();
    const bc = mockBroadcaster();
    const manager = new ChatManager("/tmp", sc, bc);

    const questionEvent: ChatEvent = {
      type: "question",
      questionId: "q-post-abort",
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

    await manager.stop();

    // Attempting to reply after stop should throw
    await expect(
      manager.replyQuestion("q-post-abort", { Pick: "A" }),
    ).rejects.toThrow("Cannot reply: no pending question");
  });

  it("cannot send message after stop() — session is null", async () => {
    const sc = mockSessionCore();
    const bc = mockBroadcaster();
    const manager = new ChatManager("/tmp", sc, bc);

    let hangResolve: (() => void) | undefined;
    mockDriver.startChat.mockReturnValueOnce(
      (async function* () {
        yield { type: "idle" as const };
        await new Promise<void>((r) => { hangResolve = r; });
      })(),
    );

    await manager.start(defaultStartOpts);

    await vi.waitFor(() => {
      expect(manager.getSession()!.awaitingUserInput).toBe(true);
    });

    await manager.stop();

    // Attempting to send message after stop should throw
    await expect(manager.sendMessage("hello")).rejects.toThrow(
      "Cannot send message: chat is not waiting for user input",
    );
  });

  it("can start a new session after abort during question", async () => {
    const sc = mockSessionCore();
    const bc = mockBroadcaster();
    const manager = new ChatManager("/tmp", sc, bc);

    const questionEvent: ChatEvent = {
      type: "question",
      questionId: "q-restart",
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

    await manager.stop();
    expect(manager.getState()).toBe("idle");

    // Reset mocks for the new session — replace isIdle with a new function
    (sc as any).isIdle = () => true;
    (sc as any).state = "idle";

    // Start a new session — should work fine
    mockDriver.startChat.mockReturnValueOnce(
      (async function* () {
        yield { type: "idle" as const };
        await new Promise<void>((r) => { hangResolve = r; });
      })(),
    );

    await manager.start(defaultStartOpts);

    expect(manager.getState()).toBe("active");
    expect(manager.getSession()).not.toBeNull();

    hangResolve?.();
  });

  it("stop() sets stopping state before aborting driver", async () => {
    const sc = mockSessionCore();
    const bc = mockBroadcaster();
    const manager = new ChatManager("/tmp", sc, bc);

    const questionEvent: ChatEvent = {
      type: "question",
      questionId: "q-state-check",
      questions: [{
        question: "Pick",
        header: "H",
        options: [{ label: "A", description: "A" }],
        multiSelect: false,
      }],
      source: "claude",
    };

    // Capture state at time of abortChat
    let stateAtAbort: string | undefined;
    let awaitingAtAbort: boolean | undefined;
    mockDriver.abortChat.mockImplementation(() => {
      stateAtAbort = manager.getSession()?.state;
      awaitingAtAbort = manager.getSession()?.awaitingUserInput;
    });

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

    await manager.stop();

    // At the time abortChat was called, state should have been 'stopping'
    expect(stateAtAbort).toBe("stopping");
    expect(awaitingAtAbort).toBe(false);
  });
});

// ====================================================================
// 3. Concurrent chat + execute → 409 Conflict
// ====================================================================

describe("Edge case: concurrent chat + execute access", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("ChatManager prevents double-start", () => {
    it("second start() throws ChatSessionActiveError when session is active", async () => {
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

      // Make sessionCore report it's not idle for the second start
      (sc as any).isIdle = () => false;
      (sc as any).state = "active";

      await expect(manager.start(defaultStartOpts)).rejects.toThrow(
        /Cannot start chat/,
      );

      // Original session should be unaffected
      expect(manager.getSession()).not.toBeNull();
      expect(manager.getState()).toBe("active");

      hangResolve?.();
    });
  });

  describe("SessionCore prevents concurrent chat + execute lock acquisition", () => {
    it("SessionCore.acquire() throws when state is active (simulates chat holding lock)", () => {
      // Use real SessionCore for this test
      // Using imported RealSessionCore

      const sc = new RealSessionCore("/tmp");

      // Skip file lock for the test by manually setting state
      // This tests the state machine guard, not the file lock
      (sc as any)._state = "active";

      expect(() => sc.acquire({ skipLock: true })).toThrow("Cannot acquire: session is active");
    });

    it("two separate SessionCore instances can acquire independently (different cwds)", () => {
      // This tests that the lock is per-directory, not global
      // Using imported RealSessionCore

      const sc1 = new RealSessionCore("/tmp/project1");
      const sc2 = new RealSessionCore("/tmp/project2");

      sc1.acquire({ skipLock: true });
      sc2.acquire({ skipLock: true });

      expect(sc1.isActive()).toBe(true);
      expect(sc2.isActive()).toBe(true);

      sc1.release();
      sc2.release();
    });
  });

  describe("Route-level conflict detection (409 responses)", () => {
    it("POST /api/chat/start returns 409 when ChatSessionActiveError is thrown", async () => {
      const cm = {
        start: vi.fn(async () => {
          throw new ChatSessionActiveError("Cannot start chat: session is active");
        }),
        sendMessage: vi.fn(),
        replyQuestion: vi.fn(),
        stop: vi.fn(),
        getState: vi.fn(() => "active"),
        getSession: vi.fn(() => null),
      } as any;

      const app = Fastify();
      await app.register(chatRoutes(cm, "/fake"));

      const res = await app.inject({
        method: "POST",
        url: "/api/chat/start",
        payload: { agent: "claude" },
      });

      expect(res.statusCode).toBe(409);
      const chatBody = res.json();
      expect(chatBody.error).toBe("Another session is active");
      expect(chatBody.reason).toBe("active_session");
    });

    it("POST /api/execute returns 409 when execution already running", async () => {
      const em = {
        state: "running",
        currentUnit: null,
      } as any;

      const app = Fastify();
      await app.register(executionRoutes(em, "/fake"));

      const res = await app.inject({
        method: "POST",
        url: "/api/execute",
        payload: { agent: "claude" },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe("Another session is active");
      expect(body.reason).toBe("active_session");
      expect(typeof body.message).toBe("string");
    });
  });

  describe("Lock exclusion between chat and execution (shared SessionCore)", () => {
    it("ChatManager.start() rejects when SessionCore is already active (simulates execution holding lock)", async () => {
      // Simulate execution already holding the session
      const sc = mockSessionCore({
        isIdle: () => false,
        state: "active" as any,
      });
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      await expect(manager.start(defaultStartOpts)).rejects.toThrow(
        /Cannot start chat: session is active/,
      );

      // acquire should never have been called
      expect(sc.acquire).not.toHaveBeenCalled();
    });

    it("ChatManager.start() rejects when SessionCore is stopping", async () => {
      const sc = mockSessionCore({
        isIdle: () => false,
        state: "stopping" as any,
      });
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      await expect(manager.start(defaultStartOpts)).rejects.toThrow(
        /Cannot start chat: session is stopping/,
      );
    });

    it("ChatManager.start() throws ChatSessionActiveError when acquire() fails (file lock contention)", async () => {
      // Simulate file lock contention: SessionCore is idle but acquire() throws
      // because another process (or the execution manager in the same process)
      // already holds the file lock.
      const sc = mockSessionCore({
        acquire: vi.fn(() => {
          throw new Error("Another prorab instance is already running (PID 12345, started 2026-01-01T00:00:00.000Z).");
        }),
      });
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      // Should throw ChatSessionActiveError (not a generic Error)
      // so the chat route maps it to 409
      await expect(manager.start(defaultStartOpts)).rejects.toThrow(ChatSessionActiveError);
      await expect(manager.start(defaultStartOpts)).rejects.toThrow(/Cannot start chat/);

      // Session should remain null — cleanup ran
      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });

    it("POST /api/chat/start returns 409 when lock contention occurs (not 500)", async () => {
      // Simulate the full HTTP path: ChatManager.start() throws ChatSessionActiveError
      // due to lock contention, and the route correctly maps it to 409.
      const cm = {
        start: vi.fn(async () => {
          throw new ChatSessionActiveError("Cannot start chat: Another prorab instance is already running");
        }),
        sendMessage: vi.fn(),
        replyQuestion: vi.fn(),
        stop: vi.fn(),
        getState: vi.fn(() => "idle"),
        getSession: vi.fn(() => null),
      } as any;

      const app = Fastify();
      await app.register(chatRoutes(cm, "/fake"));

      const res = await app.inject({
        method: "POST",
        url: "/api/chat/start",
        payload: { agent: "claude" },
      });

      expect(res.statusCode).toBe(409);
      const lockBody = res.json();
      expect(lockBody.error).toBe("Another session is active");
      expect(lockBody.reason).toBe("active_session");
    });
  });
});

// ====================================================================
// 4. Browser refresh during chat — recovery from connected state
// ====================================================================

describe("Edge case: browser refresh during active chat", () => {
  beforeEach(() => vi.clearAllMocks());

  describe("ChatManager provides session state for connected message", () => {
    it("getSession() returns full session info while active (for WS connected payload)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "idle" as const };
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start({
        agent: "claude",
        model: "sonnet",
        variant: "high",
        systemPrompt: "Test prompt",
      });

      await vi.waitFor(() => {
        expect(manager.getSession()!.awaitingUserInput).toBe(true);
      });

      const session = manager.getSession();
      expect(session).not.toBeNull();
      expect(session!.id).toMatch(/^[0-9a-f]{8}-/);
      expect(session!.agent).toBe("claude");
      expect(session!.model).toBe("sonnet");
      expect(session!.state).toBe("active");
      expect(session!.awaitingUserInput).toBe(true);

      hangResolve?.();
    });

    it("getSession() returns question_pending state with questionId while question is pending", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      const questionEvent: ChatEvent = {
        type: "question",
        questionId: "q-refresh-test",
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

      const session = manager.getSession();
      expect(session!.state).toBe("question_pending");
      expect(session!.pendingQuestionId).toBe("q-refresh-test");
      expect(session!.awaitingUserInput).toBe(false);

      hangResolve?.();
    });

    it("getSession() returns null after session ends (browser refresh sees idle)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "text" as const, content: "done" };
          yield { type: "finished" as const };
        })(),
      );

      await manager.start(defaultStartOpts);

      // Wait for stream to finish
      await vi.waitFor(() => {
        expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
          expect.objectContaining({ type: "chat:finished" }),
          "chat",
        );
      });

      expect(manager.getSession()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });
  });

  describe("Connected message shape (ChatStateProvider interface)", () => {
    it("ChatManager conforms to ChatStateProvider interface", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      let hangResolve: (() => void) | undefined;
      mockDriver.startChat.mockReturnValueOnce(
        (async function* () {
          yield { type: "idle" as const };
          await new Promise<void>((r) => { hangResolve = r; });
        })(),
      );

      await manager.start({ agent: "claude", model: "sonnet" });

      await vi.waitFor(() => {
        expect(manager.getSession()!.awaitingUserInput).toBe(true);
      });

      // Verify the shape matches what ws.ts expects for the connected message
      const session = manager.getSession();
      expect(session).toHaveProperty("id");
      expect(session).toHaveProperty("agent");
      expect(session).toHaveProperty("model");
      expect(session).toHaveProperty("state");
      expect(session).toHaveProperty("awaitingUserInput");

      hangResolve?.();
    });

    it("ChatManager returns null when idle (ChatStateProvider returns null)", () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const manager = new ChatManager("/tmp", sc, bc);

      // No session started
      expect(manager.getSession()).toBeNull();
    });
  });

  describe("Replay + connected message interaction", () => {
    it("ring buffer contains question event that can restore pending question on reconnect", () => {
      // Using imported WsBroadcaster (real, not mocked)
      const clients = new Set<{ readyState: number; send(data: string): void }>();
      const bc = new WsBroadcaster(clients);

      // Simulate chat events including a question
      bc.broadcastWithChannel({ type: "chat:started", sessionId: "s-refresh" }, "chat");
      bc.broadcastWithChannel({ type: "agent:text", text: "Working..." }, "chat");
      bc.broadcastWithChannel({
        type: "chat:question",
        questionId: "q-refresh-restore",
        questions: [{
          question: "Choose framework",
          header: "FW",
          options: [{ label: "React", description: "React" }],
          multiSelect: false,
        }],
        source: "claude",
      }, "chat");

      // New client connects after browser refresh
      const sock = { readyState: 1, send: vi.fn() };
      bc.replay(sock);

      // Verify question event is in replay and has all necessary data
      const events = sock.send.mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string),
      );

      const questionEvent = events.find((e: any) => e.type === "chat:question");
      expect(questionEvent).toBeDefined();
      expect(questionEvent.questionId).toBe("q-refresh-restore");
      expect(questionEvent.questions).toHaveLength(1);
      expect(questionEvent.questions[0].question).toBe("Choose framework");
    });

    it("after replay, most recent state-changing event determines frontend state", () => {
      // Using imported WsBroadcaster (real, not mocked)
      const clients = new Set<{ readyState: number; send(data: string): void }>();
      const bc = new WsBroadcaster(clients);

      // Simulate: question asked, then answered (idle), then new question
      bc.broadcastWithChannel({ type: "chat:started" }, "chat");
      bc.broadcastWithChannel({
        type: "chat:question",
        questionId: "q-old",
        questions: [{ question: "First?", header: "H", options: [], multiSelect: false }],
        source: "claude",
      }, "chat");
      bc.broadcastWithChannel({ type: "chat:idle" }, "chat"); // first question answered
      bc.broadcastWithChannel({
        type: "chat:question",
        questionId: "q-new",
        questions: [{ question: "Second?", header: "H", options: [], multiSelect: false }],
        source: "claude",
      }, "chat");

      const sock = { readyState: 1, send: vi.fn() };
      bc.replay(sock);

      const events = sock.send.mock.calls.map(
        (c: unknown[]) => JSON.parse(c[0] as string),
      );

      // The last question event is for "q-new", which should be the active one
      const questionEvents = events.filter((e: any) => e.type === "chat:question");
      expect(questionEvents).toHaveLength(2);
      expect(questionEvents[questionEvents.length - 1].questionId).toBe("q-new");

      // The last state-changing event (chat:question) should override the idle
      const types = events.map((e: any) => e.type);
      const lastQuestionIdx = types.lastIndexOf("chat:question");
      const lastIdleIdx = types.lastIndexOf("chat:idle");
      expect(lastQuestionIdx).toBeGreaterThan(lastIdleIdx);
    });
  });
});

// ====================================================================
// 5. Additional edge cases — rapid operations and state transitions
// ====================================================================

describe("Edge case: rapid state transitions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stop() during active stream emitting text events", async () => {
    const sc = mockSessionCore();
    const bc = mockBroadcaster();
    const manager = new ChatManager("/tmp", sc, bc);

    let rejectStream: ((err: Error) => void) | undefined;
    mockDriver.startChat.mockReturnValueOnce(
      (async function* () {
        yield { type: "text" as const, content: "Working..." };
        yield { type: "text" as const, content: "Still working..." };
        await new Promise<void>((_resolve, reject) => { rejectStream = reject; });
      })(),
    );

    mockDriver.abortChat.mockImplementation(() => {
      rejectStream?.(new Error("AbortError"));
    });

    await manager.start(defaultStartOpts);

    // Wait for at least one text event
    await vi.waitFor(() => {
      expect(bc.broadcastWithChannel).toHaveBeenCalledWith(
        expect.objectContaining({ type: "agent:text" }),
        "chat",
      );
    });

    await manager.stop();

    // Wait for async cleanup
    await new Promise((r) => setTimeout(r, 50));

    // No error, just finished
    const errorCalls = bc.calls.filter(e => e.type === "chat:error");
    expect(errorCalls).toHaveLength(0);

    const finishedCalls = bc.calls.filter(e => e.type === "chat:finished");
    expect(finishedCalls).toHaveLength(1);

    expect(manager.getState()).toBe("idle");
    expect(manager.getSession()).toBeNull();
  });

  it("stop() is idempotent — calling twice does not throw or double-cleanup", async () => {
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
    // Second stop should be a no-op (session is null)
    await manager.stop();

    expect(manager.getState()).toBe("idle");
    // abortChat called only once (second stop is no-op since session is null)
    expect(mockDriver.abortChat).toHaveBeenCalledTimes(1);
  });

  it("multiple question events — only last one is active", async () => {
    const sc = mockSessionCore();
    const bc = mockBroadcaster();
    const manager = new ChatManager("/tmp", sc, bc);

    let hangResolve: (() => void) | undefined;
    mockDriver.startChat.mockReturnValueOnce(
      (async function* () {
        yield {
          type: "question" as const,
          questionId: "q-first",
          questions: [{ question: "First?", header: "H", options: [], multiSelect: false }],
          source: "claude" as const,
        };
        yield { type: "idle" as const }; // answered
        yield {
          type: "question" as const,
          questionId: "q-second",
          questions: [{ question: "Second?", header: "H", options: [], multiSelect: false }],
          source: "claude" as const,
        };
        await new Promise<void>((r) => { hangResolve = r; });
      })(),
    );

    await manager.start(defaultStartOpts);

    await vi.waitFor(() => {
      expect(manager.getSession()?.pendingQuestionId).toBe("q-second");
    });

    // Only q-second should be answerable
    expect(manager.getState()).toBe("question_pending");
    expect(manager.getSession()!.pendingQuestionId).toBe("q-second");

    // Trying to answer q-first should throw mismatch
    await expect(
      manager.replyQuestion("q-first", { "First?": "yes" }),
    ).rejects.toThrow("Question ID mismatch");

    hangResolve?.();
  });
});
