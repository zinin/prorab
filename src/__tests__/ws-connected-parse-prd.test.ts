/**
 * Tests for the WebSocket connected message with parsePrdSession and parsePrdOutcome fields,
 * and parse-prd event replay on reconnect.
 *
 * Exercises the contract between ws.ts (connected message) and ParsePrdManager
 * (ParsePrdStateProvider interface). Pure unit-level — does not start a real server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsBroadcaster } from "../server/session/ws-broadcaster.js";
import type { ParsePrdStateProvider } from "../server/ws.js";

/** Minimal mock socket compatible with BroadcastSocket interface. */
function mockSocket(readyState = 1) {
  return { readyState, send: vi.fn() };
}

/**
 * Build a connected message payload in the same shape ws.ts produces.
 * Mirrors the logic in ws.ts WebSocket handler for parse-prd fields.
 */
function buildConnectedMessage(
  parsePrdProvider: ParsePrdStateProvider | null,
  executionState = "idle",
  currentUnit: { type: string; taskId: string; subtaskId: string; title: string } | null = null,
  iterationCurrent = 0,
  iterationTotal = 0,
) {
  const parsePrdSession = parsePrdProvider?.getSession() ?? null;
  const parsePrdOutcome = parsePrdProvider?.getOutcome() ?? null;
  return {
    type: "connected",
    state: executionState,
    currentUnit,
    iterationCurrent,
    iterationTotal,
    parsePrdSession: parsePrdSession
      ? {
          sessionId: parsePrdSession.id,
          agent: parsePrdSession.agent,
          model: parsePrdSession.model,
          variant: parsePrdSession.variant,
          state: parsePrdSession.state,
        }
      : null,
    parsePrdOutcome,
  };
}

describe("connected message with parsePrdSession", () => {
  it("includes parsePrdSession=null when no parse-prd provider is set", () => {
    const msg = buildConnectedMessage(null);

    expect(msg.type).toBe("connected");
    expect(msg.parsePrdSession).toBeNull();
    expect(msg.parsePrdOutcome).toBeNull();
  });

  it("includes parsePrdSession=null when provider returns null session", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession).toBeNull();
    expect(msg.parsePrdOutcome).toBeNull();
  });

  it("includes parsePrdSession with sessionId, agent, model, variant, state when active", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "pprd-abc-123",
        agent: "claude",
        model: "claude-sonnet-4-20250514",
        variant: "high",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession).not.toBeNull();
    expect(msg.parsePrdSession).toEqual({
      sessionId: "pprd-abc-123",
      agent: "claude",
      model: "claude-sonnet-4-20250514",
      variant: "high",
      state: "active",
    });
    // No outcome while session is still active
    expect(msg.parsePrdOutcome).toBeNull();
  });

  it("maps session.id to sessionId in connected message", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "uuid-12345",
        agent: "opencode",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    // sessionId in connected message, not id
    expect(msg.parsePrdSession!.sessionId).toBe("uuid-12345");
    expect((msg.parsePrdSession as any).id).toBeUndefined();
  });

  it("handles optional model being undefined", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "s1",
        agent: "opencode",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession!.agent).toBe("opencode");
    expect(msg.parsePrdSession!.model).toBeUndefined();
  });

  it("includes variant when session has variant set", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "s-variant",
        agent: "claude",
        model: "sonnet",
        variant: "high",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession!.variant).toBe("high");
  });

  it("handles optional variant being undefined", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "s-no-variant",
        agent: "claude",
        model: "sonnet",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession!.variant).toBeUndefined();
  });

  it("includes state=stopping when session is being stopped", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "s2",
        agent: "claude",
        model: "opus",
        state: "stopping",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession!.state).toBe("stopping");
  });

  it("coexists with execution state fields", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "s3",
        agent: "claude",
        state: "active",
      }),
      getOutcome: () => null,
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

    // Parse-prd session
    expect(msg.parsePrdSession!.sessionId).toBe("s3");
    expect(msg.parsePrdSession!.state).toBe("active");
  });
});

describe("connected message with parsePrdOutcome (terminal)", () => {
  it("includes success outcome after completed session", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => null, // session cleaned up after completion
      getOutcome: () => ({ status: "success" }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession).toBeNull();
    expect(msg.parsePrdOutcome).toEqual({ status: "success" });
  });

  it("includes failure outcome with errors after failed session", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => ({
        status: "failure",
        errors: ["Agent signalled blocked: PRD file not found", "Missing tasks"],
      }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession).toBeNull();
    expect(msg.parsePrdOutcome).toEqual({
      status: "failure",
      errors: ["Agent signalled blocked: PRD file not found", "Missing tasks"],
    });
  });

  it("includes cancelled outcome after user-stopped session", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "cancelled" }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession).toBeNull();
    expect(msg.parsePrdOutcome).toEqual({ status: "cancelled" });
  });

  it("outcome is null when no session has ever run", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession).toBeNull();
    expect(msg.parsePrdOutcome).toBeNull();
  });

  it("active session with null outcome (session still running)", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "running-session",
        agent: "claude",
        model: "sonnet",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.parsePrdSession).not.toBeNull();
    expect(msg.parsePrdSession!.sessionId).toBe("running-session");
    expect(msg.parsePrdOutcome).toBeNull();
  });
});

describe("parse-prd event replay on reconnect", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("replays parse-prd:started from ring buffer for state recovery", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate ParsePrdManager broadcasting events
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-1", agent: "claude", model: "sonnet" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Reading PRD..." },
      "parse-prd",
    );

    // New client connects and receives replay
    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    expect(sock2.send).toHaveBeenCalledTimes(2);

    const replayedEvents = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // Client can find the parse-prd:started event in replay
    const startedEvent = replayedEvents.find((e: any) => e.type === "parse-prd:started");
    expect(startedEvent).toBeDefined();
    expect(startedEvent.sessionId).toBe("pprd-1");
    expect(startedEvent.channel).toBe("parse-prd");
  });

  it("replays parse-prd:finished from ring buffer for terminal outcome recovery", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-2", agent: "claude" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Writing tasks.json..." },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:finished", outcome: { status: "success" } },
      "parse-prd",
    );

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    const finishedEvent = events.find((e: any) => e.type === "parse-prd:finished");
    expect(finishedEvent).toBeDefined();
    expect(finishedEvent.outcome).toEqual({ status: "success" });
    expect(finishedEvent.channel).toBe("parse-prd");
  });

  it("replay sends parse-prd events alongside other channels — client routes by channel", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Mixed events in the buffer
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
    broadcaster.broadcastWithChannel({ type: "parse-prd:started", sessionId: "pprd-3", agent: "claude" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "exec work" }, "execute");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "prd work" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "parse-prd:finished", outcome: { status: "failure", errors: ["no tasks"] } }, "parse-prd");

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // All events are sent — no server-side filtering by channel
    expect(events).toHaveLength(5);

    // Client can filter by channel
    const parsePrdEvents = events.filter((e: any) => e.channel === "parse-prd");
    const execEvents = events.filter((e: any) => e.channel === "execute");

    expect(parsePrdEvents).toHaveLength(3);
    expect(execEvents).toHaveLength(2);
  });

  it("connected message + replay together provide full parse-prd state recovery", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate an active parse-prd session with some history
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-4", agent: "claude", model: "sonnet" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Analyzing PRD file..." },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:tool", name: "Read", summary: "Reading prd.md" },
      "parse-prd",
    );

    // Build connected message (like ws.ts does for a new connection)
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "pprd-4",
        agent: "claude",
        model: "sonnet",
        state: "active",
      }),
      getOutcome: () => null,
    };
    const connected = buildConnectedMessage(provider);

    // Simulate new client connecting: receives connected message + replay
    const sock2 = mockSocket(1);
    sock2.send(JSON.stringify(connected));
    broadcaster.replay(sock2);

    // Connected message provides current state snapshot
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.parsePrdSession).toEqual({
      sessionId: "pprd-4",
      agent: "claude",
      model: "sonnet",
      state: "active",
    });
    expect(connectedMsg.parsePrdOutcome).toBeNull();

    // Replay provides event history (3 events)
    expect(sock2.send).toHaveBeenCalledTimes(4); // 1 connected + 3 replay
    const replayedEvents = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayedEvents.map((e: any) => e.type)).toEqual([
      "parse-prd:started",
      "agent:text",
      "agent:tool",
    ]);
  });

  it("connected message with terminal outcome after session finished", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate a completed parse-prd session
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-5", agent: "claude" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Done!" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:finished", outcome: { status: "success" } },
      "parse-prd",
    );

    // Session cleaned up, but outcome remains
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "success" }),
    };
    const connected = buildConnectedMessage(provider);

    // Connected message carries the terminal outcome
    expect(connected.parsePrdSession).toBeNull();
    expect(connected.parsePrdOutcome).toEqual({ status: "success" });
  });
});

/**
 * Comprehensive reconnect scenarios — verifies that connected snapshot + ring-buffer
 * replay together restore the correct parse-prd state for all terminal states.
 *
 * Each scenario simulates: session lifecycle → client disconnect → new client
 * connects → receives connected message + full replay → verifies state recovery.
 */
describe("reconnect scenario: active session in progress", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("recovers active session with partial event history", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Session in progress — agent is actively working
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-active-1", agent: "claude", model: "sonnet" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Reading PRD document..." },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:tool", name: "Read", summary: "Read .taskmaster/docs/prd.md" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:tool_result", summary: "PRD content (2048 chars)" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Now generating tasks..." },
      "parse-prd",
    );

    // Client 1 disconnects, client 2 reconnects
    clients.delete(sock1);
    const sock2 = mockSocket(1);

    // Build connected message from active provider
    const provider: ParsePrdStateProvider = {
      getSession: () => ({ id: "pprd-active-1", agent: "claude", model: "sonnet", state: "active" }),
      getOutcome: () => null,
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));

    // Replay ring buffer
    broadcaster.replay(sock2);

    // Verify connected message
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.parsePrdSession).toEqual({
      sessionId: "pprd-active-1",
      agent: "claude",
      model: "sonnet",
      state: "active",
    });
    expect(connectedMsg.parsePrdOutcome).toBeNull();

    // Verify replay: 5 events
    expect(sock2.send).toHaveBeenCalledTimes(6); // 1 connected + 5 replay
    const replayed = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // All events have channel="parse-prd"
    expect(replayed.every((e: any) => e.channel === "parse-prd")).toBe(true);

    // Event types in order
    expect(replayed.map((e: any) => e.type)).toEqual([
      "parse-prd:started",
      "agent:text",
      "agent:tool",
      "agent:tool_result",
      "agent:text",
    ]);

    // No parse-prd:finished in replay (session still active)
    expect(replayed.find((e: any) => e.type === "parse-prd:finished")).toBeUndefined();
  });
});

describe("reconnect scenario: completed with success", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("recovers success outcome from connected + finished event in replay", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Complete session lifecycle
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-success", agent: "claude" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Tasks generated" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:tool", name: "Write", summary: "Write tasks.json" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:finished", outcome: { status: "success" } },
      "parse-prd",
    );

    // New client connects after session completed
    clients.delete(sock1);
    const sock2 = mockSocket(1);

    // Connected message: session cleaned up, outcome persists
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "success" }),
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));
    broadcaster.replay(sock2);

    // Connected carries the terminal outcome
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.parsePrdSession).toBeNull();
    expect(connectedMsg.parsePrdOutcome).toEqual({ status: "success" });

    // Replay includes the parse-prd:finished event too
    const replayed = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    const finishedInReplay = replayed.find((e: any) => e.type === "parse-prd:finished");
    expect(finishedInReplay).toBeDefined();
    expect(finishedInReplay.outcome).toEqual({ status: "success" });

    // Client can verify consistency: connected.parsePrdOutcome matches replay's finished.outcome
    expect(connectedMsg.parsePrdOutcome.status).toBe(finishedInReplay.outcome.status);
  });
});

describe("reconnect scenario: completed with failure", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("recovers failure outcome with error details", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-fail", agent: "opencode" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Cannot find PRD" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:error", message: "Agent signalled blocked" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:finished", outcome: { status: "failure", errors: ["Agent signalled blocked: PRD not found", "Post-validation failed"] } },
      "parse-prd",
    );

    const sock2 = mockSocket(1);
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "failure", errors: ["Agent signalled blocked: PRD not found", "Post-validation failed"] }),
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));
    broadcaster.replay(sock2);

    // Connected carries failure outcome with errors
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.parsePrdOutcome).toEqual({
      status: "failure",
      errors: ["Agent signalled blocked: PRD not found", "Post-validation failed"],
    });

    // Replay has the error and finished events
    const replayed = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    const errorEvent = replayed.find((e: any) => e.type === "parse-prd:error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toBe("Agent signalled blocked");

    const finishedEvent = replayed.find((e: any) => e.type === "parse-prd:finished");
    expect(finishedEvent).toBeDefined();
    expect(finishedEvent.outcome.status).toBe("failure");
    expect(finishedEvent.outcome.errors).toHaveLength(2);
  });
});

describe("reconnect scenario: completed with cancellation", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("recovers cancelled outcome after user-stop", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-cancel", agent: "claude", model: "opus" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Starting analysis..." },
      "parse-prd",
    );
    // User stopped the session mid-flight
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:finished", outcome: { status: "cancelled" } },
      "parse-prd",
    );

    const sock2 = mockSocket(1);
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "cancelled" }),
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));
    broadcaster.replay(sock2);

    // Connected message carries cancelled outcome
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.parsePrdSession).toBeNull();
    expect(connectedMsg.parsePrdOutcome).toEqual({ status: "cancelled" });

    // Replay confirms the session started and was cancelled
    const replayed = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayed[0].type).toBe("parse-prd:started");
    expect(replayed[replayed.length - 1].type).toBe("parse-prd:finished");
    expect(replayed[replayed.length - 1].outcome.status).toBe("cancelled");
  });
});

describe("reconnect scenario: no session ever ran", () => {
  it("connected message has null session and null outcome when no parse-prd ran", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => null,
    };
    const connected = buildConnectedMessage(provider);

    expect(connected.parsePrdSession).toBeNull();
    expect(connected.parsePrdOutcome).toBeNull();
  });

  it("replay is empty when no parse-prd events were broadcast", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );

    const sock = mockSocket(1);
    broadcaster.replay(sock);

    expect(sock.send).not.toHaveBeenCalled();
  });
});

describe("reconnect: parse-prd events isolated from execution events in replay", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("client can separate parse-prd from execution events by channel in replay", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Execution events (channel="execute" or default)
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Running task 1..." }, "execute");
    broadcaster.broadcastWithChannel({ type: "execution:finished" }, "execute");

    // Parse-prd events
    broadcaster.broadcastWithChannel({ type: "parse-prd:started", sessionId: "pprd-iso", agent: "claude" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Parsing PRD..." }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "parse-prd:finished", outcome: { status: "success" } }, "parse-prd");

    // New client replays
    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const replayed = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayed).toHaveLength(6);

    // Filter by channel
    const execEvents = replayed.filter((e: any) => e.channel === "execute");
    const prdEvents = replayed.filter((e: any) => e.channel === "parse-prd");

    expect(execEvents).toHaveLength(3);
    expect(prdEvents).toHaveLength(3);

    // Each group has the correct events
    expect(execEvents.map((e: any) => e.type)).toEqual([
      "execution:state",
      "agent:text",
      "execution:finished",
    ]);
    expect(prdEvents.map((e: any) => e.type)).toEqual([
      "parse-prd:started",
      "agent:text",
      "parse-prd:finished",
    ]);
  });

  it("client can separate parse-prd from chat events by channel in replay", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Chat events
    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "chat-1", agent: "claude" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Chat response" }, "chat");
    broadcaster.broadcastWithChannel({ type: "chat:idle" }, "chat");

    // Parse-prd events
    broadcaster.broadcastWithChannel({ type: "parse-prd:started", sessionId: "pprd-chat-iso", agent: "opencode" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "PRD analysis" }, "parse-prd");

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const replayed = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    const chatEvents = replayed.filter((e: any) => e.channel === "chat");
    const prdEvents = replayed.filter((e: any) => e.channel === "parse-prd");

    expect(chatEvents).toHaveLength(3);
    expect(prdEvents).toHaveLength(2);

    // No cross-contamination: chat events don't have parse-prd content
    expect(chatEvents.every((e: any) => e.channel === "chat")).toBe(true);
    expect(prdEvents.every((e: any) => e.channel === "parse-prd")).toBe(true);
  });

  it("all three channels coexist in replay without interference", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Interleave events from all three channels
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
    broadcaster.broadcastWithChannel({ type: "parse-prd:started", sessionId: "pprd-3ch", agent: "claude" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "chat-3ch", agent: "opencode" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "exec" }, "execute");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "prd" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "chat" }, "chat");
    broadcaster.broadcastWithChannel({ type: "parse-prd:finished", outcome: { status: "success" } }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "chat:finished" }, "chat");
    broadcaster.broadcastWithChannel({ type: "execution:finished" }, "execute");

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const replayed = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayed).toHaveLength(9);

    const byChannel = {
      execute: replayed.filter((e: any) => e.channel === "execute"),
      "parse-prd": replayed.filter((e: any) => e.channel === "parse-prd"),
      chat: replayed.filter((e: any) => e.channel === "chat"),
    };

    expect(byChannel.execute).toHaveLength(3);
    expect(byChannel["parse-prd"]).toHaveLength(3);
    expect(byChannel.chat).toHaveLength(3);

    // Verify ordering is preserved within each channel
    expect(byChannel["parse-prd"].map((e: any) => e.type)).toEqual([
      "parse-prd:started",
      "agent:text",
      "parse-prd:finished",
    ]);
  });
});

describe("ParsePrdStateProvider interface conformance", () => {
  it("compile-time: ParsePrdStateProvider requires getSession and getOutcome", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => ({
        id: "s1",
        agent: "claude",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const session = provider.getSession();
    expect(session).not.toBeNull();
    expect(session!.id).toBe("s1");
    expect(session!.state).toBe("active");
    expect(provider.getOutcome()).toBeNull();
  });

  it("compile-time: ParsePrdStateProvider getSession returns null when idle", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => null,
    };

    expect(provider.getSession()).toBeNull();
    expect(provider.getOutcome()).toBeNull();
  });

  it("compile-time: ParsePrdStateProvider getOutcome returns outcome with errors", () => {
    const provider: ParsePrdStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "failure", errors: ["validation error"] }),
    };

    const outcome = provider.getOutcome();
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("failure");
    expect(outcome!.errors).toEqual(["validation error"]);
  });
});
