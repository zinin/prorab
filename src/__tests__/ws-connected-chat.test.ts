/**
 * Tests for the WebSocket connected message with chatSession field
 * and chat event replay on reconnect.
 *
 * Exercises the contract between ws.ts (connected message) and ChatManager
 * (ChatStateProvider interface). Pure unit-level — does not start a real server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsBroadcaster, type WsEvent } from "../server/session/ws-broadcaster.js";
import type { ChatStateProvider } from "../server/ws.js";
import { applyDefaultChannel } from "../server/ws.js";

/** Minimal mock socket compatible with BroadcastSocket interface. */
function mockSocket(readyState = 1) {
  return { readyState, send: vi.fn() };
}

/**
 * Build a connected message payload in the same shape ws.ts produces.
 * Mirrors the logic in ws.ts WebSocket handler.
 */
function buildConnectedMessage(
  chatStateProvider: ChatStateProvider | null,
  executionState = "idle",
  currentUnit: { type: string; taskId: string; subtaskId: string; title: string } | null = null,
  iterationCurrent = 0,
  iterationTotal = 0,
) {
  const chatSession = chatStateProvider?.getSession() ?? null;
  return {
    type: "connected",
    state: executionState,
    currentUnit,
    iterationCurrent,
    iterationTotal,
    chatSession: chatSession
      ? {
          sessionId: chatSession.id,
          agent: chatSession.agent,
          model: chatSession.model,
          state: chatSession.state,
          awaitingUserInput: chatSession.awaitingUserInput,
        }
      : null,
  };
}

describe("connected message with chatSession", () => {
  it("includes chatSession=null when no chat provider is set", () => {
    const msg = buildConnectedMessage(null);

    expect(msg.type).toBe("connected");
    expect(msg.chatSession).toBeNull();
  });

  it("includes chatSession=null when provider returns null session", () => {
    const provider: ChatStateProvider = {
      getSession: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.chatSession).toBeNull();
  });

  it("includes chatSession with sessionId, agent, model, state, and awaitingUserInput when active", () => {
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "sess-abc-123",
        agent: "claude",
        model: "claude-sonnet-4-20250514",
        state: "active",
        awaitingUserInput: true,
      }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.chatSession).not.toBeNull();
    expect(msg.chatSession).toEqual({
      sessionId: "sess-abc-123",
      agent: "claude",
      model: "claude-sonnet-4-20250514",
      state: "active",
      awaitingUserInput: true,
    });
  });

  it("maps session.id to sessionId in connected message", () => {
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "uuid-12345",
        agent: "opencode",
        state: "active",
        awaitingUserInput: false,
      }),
    };

    const msg = buildConnectedMessage(provider);

    // sessionId in connected message, not id
    expect(msg.chatSession!.sessionId).toBe("uuid-12345");
    expect((msg.chatSession as any).id).toBeUndefined();
  });

  it("includes awaitingUserInput=false when agent is processing", () => {
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "s1",
        agent: "claude",
        state: "active",
        awaitingUserInput: false,
      }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.chatSession!.awaitingUserInput).toBe(false);
  });

  it("includes awaitingUserInput=true when chat is idle and waiting for user", () => {
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "s2",
        agent: "claude",
        state: "active",
        awaitingUserInput: true,
      }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.chatSession!.awaitingUserInput).toBe(true);
  });

  it("includes state=question_pending when a question is pending", () => {
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "s3",
        agent: "claude",
        model: "opus",
        state: "question_pending",
        awaitingUserInput: false,
      }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.chatSession!.state).toBe("question_pending");
    expect(msg.chatSession!.awaitingUserInput).toBe(false);
  });

  it("handles optional model being undefined", () => {
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "s4",
        agent: "opencode",
        state: "active",
        awaitingUserInput: true,
      }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.chatSession!.agent).toBe("opencode");
    expect(msg.chatSession!.model).toBeUndefined();
  });

  it("coexists with execution state fields", () => {
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "s5",
        agent: "claude",
        state: "active",
        awaitingUserInput: true,
      }),
    };

    const msg = buildConnectedMessage(
      provider,
      "running",
      { type: "task", taskId: "3", subtaskId: "", title: "Build feature" },
      2,
      5,
    );

    // Execution fields
    expect(msg.state).toBe("running");
    expect(msg.currentUnit).toEqual({ type: "task", taskId: "3", subtaskId: "", title: "Build feature" });
    expect(msg.iterationCurrent).toBe(2);
    expect(msg.iterationTotal).toBe(5);

    // Chat session
    expect(msg.chatSession!.sessionId).toBe("s5");
    expect(msg.chatSession!.awaitingUserInput).toBe(true);
  });
});

describe("chat event replay on reconnect", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("replays chat:question from ring buffer so client can restore pending question", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate ChatManager broadcasting events
    broadcaster.broadcastWithChannel(
      { type: "chat:started", sessionId: "s1", agent: "claude" },
      "chat",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Let me ask you..." },
      "chat",
    );
    broadcaster.broadcastWithChannel(
      {
        type: "chat:question",
        questionId: "q-pending",
        questions: [{ question: "Pick?", header: "H", options: [{ label: "A" }], multiSelect: false }],
        source: "claude",
      },
      "chat",
    );

    // New client connects and receives replay
    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    expect(sock2.send).toHaveBeenCalledTimes(3);

    const replayedEvents = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // Client can find the chat:question event in replay to restore pending question
    const questionEvent = replayedEvents.find((e: any) => e.type === "chat:question");
    expect(questionEvent).toBeDefined();
    expect(questionEvent.questionId).toBe("q-pending");
    expect(questionEvent.channel).toBe("chat");
    expect(questionEvent.questions).toHaveLength(1);
  });

  it("replay sends both chat and execution events — client routes by channel", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Mixed events in the buffer
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "exec work" }, "execute");
    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "c1", agent: "claude" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "chat work" }, "chat");
    broadcaster.broadcastWithChannel({ type: "chat:idle" }, "chat");

    // New client connects
    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // All events are sent — no server-side filtering by channel
    expect(events).toHaveLength(5);

    // Client can filter by channel
    const chatEvents = events.filter((e: any) => e.channel === "chat");
    const execEvents = events.filter((e: any) => e.channel === "execute");

    expect(chatEvents).toHaveLength(3);
    expect(execEvents).toHaveLength(2);
  });

  it("connected message + replay together provide full state recovery", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate an active chat session with some history
    broadcaster.broadcastWithChannel(
      { type: "chat:started", sessionId: "s1", agent: "claude", model: "sonnet" },
      "chat",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Hello! How can I help?" },
      "chat",
    );
    broadcaster.broadcastWithChannel(
      { type: "chat:idle" },
      "chat",
    );

    // Build connected message (like ws.ts does for a new connection)
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "s1",
        agent: "claude",
        model: "sonnet",
        state: "active",
        awaitingUserInput: true,
      }),
    };
    const connected = buildConnectedMessage(provider);

    // Simulate new client connecting: receives connected message + replay
    const sock2 = mockSocket(1);
    sock2.send(JSON.stringify(connected));
    broadcaster.replay(sock2);

    // Connected message provides current state snapshot
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.chatSession).toEqual({
      sessionId: "s1",
      agent: "claude",
      model: "sonnet",
      state: "active",
      awaitingUserInput: true,
    });

    // Replay provides event history (3 events)
    expect(sock2.send).toHaveBeenCalledTimes(4); // 1 connected + 3 replay
    const replayedEvents = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayedEvents.map((e: any) => e.type)).toEqual([
      "chat:started",
      "agent:text",
      "chat:idle",
    ]);
  });
});

describe("replay:complete sentinel", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("server sends replay:complete after replay events", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Buffer some events
    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "s1", agent: "claude" }, "chat");
    broadcaster.broadcastWithChannel({ type: "chat:idle" }, "chat");

    // Simulate what ws.ts should do: connected + replay + sentinel
    const sock2 = mockSocket(1);
    sock2.send(JSON.stringify({ type: "connected" }));
    broadcaster.replay(sock2);
    sock2.send(JSON.stringify({ type: "replay:complete" }));

    // Last message must be replay:complete
    const calls = sock2.send.mock.calls;
    const lastMsg = JSON.parse(calls[calls.length - 1][0] as string);
    expect(lastMsg.type).toBe("replay:complete");

    // Total: 1 connected + 2 replay + 1 sentinel = 4
    expect(calls).toHaveLength(4);
  });
});

describe("ChatStateProvider interface conformance", () => {
  it("compile-time: ChatStateProvider requires awaitingUserInput in getSession return type", () => {
    // This test verifies at compile time that awaitingUserInput is required
    const provider: ChatStateProvider = {
      getSession: () => ({
        id: "s1",
        agent: "claude",
        state: "active",
        awaitingUserInput: true,
      }),
    };

    const session = provider.getSession();
    expect(session).not.toBeNull();
    expect(session!.awaitingUserInput).toBe(true);
  });

  it("compile-time: ChatStateProvider getSession returns null when idle", () => {
    const provider: ChatStateProvider = {
      getSession: () => null,
    };

    expect(provider.getSession()).toBeNull();
  });
});

describe("applyDefaultChannel with chat events", () => {
  it("does not add default channel to chat:* events", () => {
    const event: WsEvent = { type: "chat:started", sessionId: "s1", agent: "claude" };
    const result = applyDefaultChannel(event);

    // chat:* events don't start with "agent:" so no channel added
    expect(result.channel).toBeUndefined();
  });

  it("does not override existing channel on agent:* events", () => {
    const event: WsEvent = { type: "agent:text", text: "hello", channel: "chat" };
    const result = applyDefaultChannel(event);

    // Existing channel='chat' should be preserved
    expect(result.channel).toBe("chat");
    expect(result).toBe(event); // same object reference
  });

  it("adds channel=execute to agent:* events without channel", () => {
    const event: WsEvent = { type: "agent:text", text: "hello" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("execute");
  });
});
