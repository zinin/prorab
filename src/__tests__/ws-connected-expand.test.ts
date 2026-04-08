/**
 * Tests for the WebSocket connected message with expandSession and expandOutcome fields,
 * and expand event replay on reconnect.
 *
 * Exercises the contract between ws.ts (connected message) and ExpandManager
 * (ExpandStateProvider interface). Pure unit-level — does not start a real server.
 *
 * Modeled on ws-connected-parse-prd.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsBroadcaster } from "../server/session/ws-broadcaster.js";
import type { ExpandStateProvider } from "../server/ws.js";
import type { ExpandManagerOutcome } from "../types.js";

/** Minimal mock socket compatible with BroadcastSocket interface. */
function mockSocket(readyState = 1) {
  return { readyState, send: vi.fn() };
}

/**
 * Build a connected message payload in the same shape ws.ts produces.
 * Mirrors the logic in ws.ts WebSocket handler for expand fields.
 */
function buildConnectedMessage(
  expandProvider: ExpandStateProvider | null,
  executionState = "idle",
  currentUnit: { type: string; taskId: string; subtaskId: string; title: string } | null = null,
  iterationCurrent = 0,
  iterationTotal = 0,
) {
  const expandSession = expandProvider?.getSession() ?? null;
  const expandOutcome = expandProvider?.getOutcome() ?? null;
  return {
    type: "connected",
    state: executionState,
    currentUnit,
    iterationCurrent,
    iterationTotal,
    expandSession: expandSession
      ? {
          sessionId: expandSession.id,
          taskId: expandSession.taskId,
          agent: expandSession.agent,
          model: expandSession.model,
          variant: expandSession.variant,
          state: expandSession.state,
        }
      : null,
    expandOutcome,
  };
}

describe("connected message with expandSession", () => {
  it("includes expandSession=null when no expand provider is set", () => {
    const msg = buildConnectedMessage(null);

    expect(msg.type).toBe("connected");
    expect(msg.expandSession).toBeNull();
    expect(msg.expandOutcome).toBeNull();
  });

  it("includes expandSession=null when provider returns null session", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession).toBeNull();
    expect(msg.expandOutcome).toBeNull();
  });

  it("includes expandSession with sessionId, taskId, agent, model, variant, state when active", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "exp-abc-123",
        taskId: "7",
        agent: "claude",
        model: "claude-sonnet-4-20250514",
        variant: "high",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession).not.toBeNull();
    expect(msg.expandSession).toEqual({
      sessionId: "exp-abc-123",
      taskId: "7",
      agent: "claude",
      model: "claude-sonnet-4-20250514",
      variant: "high",
      state: "active",
    });
    // No outcome while session is still active
    expect(msg.expandOutcome).toBeNull();
  });

  it("maps session.id to sessionId in connected message", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "uuid-12345",
        taskId: "3",
        agent: "opencode",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    // sessionId in connected message, not id
    expect(msg.expandSession!.sessionId).toBe("uuid-12345");
    expect((msg.expandSession as any).id).toBeUndefined();
  });

  it("always includes taskId in expandSession", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "s-taskid",
        taskId: "42",
        agent: "claude",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession!.taskId).toBe("42");
  });

  it("handles optional model being undefined", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "s1",
        taskId: "5",
        agent: "opencode",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession!.agent).toBe("opencode");
    expect(msg.expandSession!.model).toBeUndefined();
  });

  it("includes variant when session has variant set", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "s-variant",
        taskId: "8",
        agent: "claude",
        model: "sonnet",
        variant: "high",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession!.variant).toBe("high");
  });

  it("handles optional variant being undefined", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "s-no-variant",
        taskId: "9",
        agent: "claude",
        model: "sonnet",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession!.variant).toBeUndefined();
  });

  it("includes state=stopping when session is being stopped", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "s2",
        taskId: "10",
        agent: "claude",
        model: "opus",
        state: "stopping",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession!.state).toBe("stopping");
  });

  it("coexists with execution state fields", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "s3",
        taskId: "11",
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

    // Expand session
    expect(msg.expandSession!.sessionId).toBe("s3");
    expect(msg.expandSession!.taskId).toBe("11");
    expect(msg.expandSession!.state).toBe("active");
  });
});

describe("connected message with expandOutcome (terminal)", () => {
  it("includes success outcome with taskId and subtaskCount after completed session", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null, // session cleaned up after completion
      getOutcome: () => ({ status: "success", taskId: "7", subtaskCount: 5 }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession).toBeNull();
    expect(msg.expandOutcome).toEqual({ status: "success", taskId: "7", subtaskCount: 5 });
  });

  it("includes failure outcome with taskId, reason, errors, and message after failed session", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({
        status: "failure",
        taskId: "7",
        reason: "hash_conflict",
        errors: ["tasks.json was modified during expand session"],
        message: "tasks.json was modified during expand session",
        subtaskCount: 0,
      }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession).toBeNull();
    expect(msg.expandOutcome).toEqual({
      status: "failure",
      taskId: "7",
      reason: "hash_conflict",
      errors: ["tasks.json was modified during expand session"],
      message: "tasks.json was modified during expand session",
      subtaskCount: 0,
    });
  });

  it("includes cancelled outcome with taskId after user-stopped session", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "cancelled", taskId: "7", subtaskCount: 0 }),
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession).toBeNull();
    expect(msg.expandOutcome).toEqual({ status: "cancelled", taskId: "7", subtaskCount: 0 });
  });

  it("outcome is null when no session has ever run", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession).toBeNull();
    expect(msg.expandOutcome).toBeNull();
  });

  it("active session with null outcome (session still running)", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "running-session",
        taskId: "15",
        agent: "claude",
        model: "sonnet",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const msg = buildConnectedMessage(provider);

    expect(msg.expandSession).not.toBeNull();
    expect(msg.expandSession!.sessionId).toBe("running-session");
    expect(msg.expandSession!.taskId).toBe("15");
    expect(msg.expandOutcome).toBeNull();
  });

  it("all terminal outcome variants carry taskId", () => {
    const outcomes: ExpandManagerOutcome[] = [
      { status: "success", taskId: "1", subtaskCount: 3 },
      { status: "failure", taskId: "2", reason: "agent_failed", errors: ["err"], message: "err", subtaskCount: 0 },
      { status: "cancelled", taskId: "3", subtaskCount: 0 },
    ];

    for (const outcome of outcomes) {
      const provider: ExpandStateProvider = {
        getSession: () => null,
        getOutcome: () => outcome,
      };
      const msg = buildConnectedMessage(provider);
      expect(msg.expandOutcome).not.toBeNull();
      expect(msg.expandOutcome!.taskId).toBeDefined();
      expect(typeof msg.expandOutcome!.taskId).toBe("string");
    }
  });
});

describe("expand event replay on reconnect", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("replays expand:started from ring buffer for state recovery", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate ExpandManager broadcasting events
    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-1", taskId: "7", agent: "claude", model: "sonnet" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Analyzing task for decomposition..." },
      "expand",
    );

    // New client connects and receives replay
    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    expect(sock2.send).toHaveBeenCalledTimes(2);

    const replayedEvents = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // Client can find the expand:started event in replay
    const startedEvent = replayedEvents.find((e: any) => e.type === "expand:started");
    expect(startedEvent).toBeDefined();
    expect(startedEvent.sessionId).toBe("exp-1");
    expect(startedEvent.taskId).toBe("7");
    expect(startedEvent.channel).toBe("expand");
  });

  it("replays expand:finished from ring buffer for terminal outcome recovery", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-2", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Generating subtasks..." },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: { status: "success", taskId: "7", subtaskCount: 4 } },
      "expand",
    );

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    const finishedEvent = events.find((e: any) => e.type === "expand:finished");
    expect(finishedEvent).toBeDefined();
    expect(finishedEvent.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
    expect(finishedEvent.channel).toBe("expand");
  });

  it("replays expand:error before expand:finished for failure scenario", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-err", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:error", message: "Agent signalled blocked", reason: "agent_failed" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      {
        type: "expand:finished",
        outcome: {
          status: "failure",
          taskId: "7",
          reason: "agent_failed",
          errors: ["Agent signalled blocked"],
          message: "Agent signalled blocked",
          subtaskCount: 0,
        },
      },
      "expand",
    );

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    const errorEvent = events.find((e: any) => e.type === "expand:error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.reason).toBe("agent_failed");

    const finishedEvent = events.find((e: any) => e.type === "expand:finished");
    expect(finishedEvent).toBeDefined();
    expect(finishedEvent.outcome.status).toBe("failure");
    expect(finishedEvent.outcome.taskId).toBe("7");
  });

  it("replay sends expand events alongside other channels — client routes by channel", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Mixed events in the buffer
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
    broadcaster.broadcastWithChannel({ type: "expand:started", sessionId: "exp-3", taskId: "7", agent: "claude" }, "expand");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "exec work" }, "execute");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "expand work" }, "expand");
    broadcaster.broadcastWithChannel({ type: "expand:finished", outcome: { status: "success", taskId: "7", subtaskCount: 3 } }, "expand");

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // All events are sent — no server-side filtering by channel
    expect(events).toHaveLength(5);

    // Client can filter by channel
    const expandEvents = events.filter((e: any) => e.channel === "expand");
    const execEvents = events.filter((e: any) => e.channel === "execute");

    expect(expandEvents).toHaveLength(3);
    expect(execEvents).toHaveLength(2);
  });

  it("connected message + replay together provide full expand state recovery", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate an active expand session with some history
    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-4", taskId: "12", agent: "claude", model: "sonnet" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Analyzing task structure..." },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:tool", name: "Read", summary: "Reading tasks.json" },
      "expand",
    );

    // Build connected message (like ws.ts does for a new connection)
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "exp-4",
        taskId: "12",
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
    expect(connectedMsg.expandSession).toEqual({
      sessionId: "exp-4",
      taskId: "12",
      agent: "claude",
      model: "sonnet",
      state: "active",
    });
    expect(connectedMsg.expandOutcome).toBeNull();

    // Replay provides event history (3 events)
    expect(sock2.send).toHaveBeenCalledTimes(4); // 1 connected + 3 replay
    const replayedEvents = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayedEvents.map((e: any) => e.type)).toEqual([
      "expand:started",
      "agent:text",
      "agent:tool",
    ]);
  });

  it("connected message with terminal outcome after session finished", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate a completed expand session
    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-5", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Done!" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: { status: "success", taskId: "7", subtaskCount: 5 } },
      "expand",
    );

    // Session cleaned up, but outcome remains
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "success", taskId: "7", subtaskCount: 5 }),
    };
    const connected = buildConnectedMessage(provider);

    // Connected message carries the terminal outcome
    expect(connected.expandSession).toBeNull();
    expect(connected.expandOutcome).toEqual({ status: "success", taskId: "7", subtaskCount: 5 });
  });
});

/**
 * Comprehensive reconnect scenarios — verifies that connected snapshot + ring-buffer
 * replay together restore the correct expand state for all terminal states.
 *
 * Each scenario simulates: session lifecycle → client disconnect → new client
 * connects → receives connected message + full replay → verifies state recovery.
 */
describe("reconnect scenario: active expand session in progress", () => {
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
      { type: "expand:started", sessionId: "exp-active-1", taskId: "7", agent: "claude", model: "sonnet" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Reading task details..." },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:tool", name: "Read", summary: "Read .taskmaster/tasks/tasks.json" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:tool_result", summary: "Tasks content (4096 chars)" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Now decomposing into subtasks..." },
      "expand",
    );

    // Client 1 disconnects, client 2 reconnects
    clients.delete(sock1);
    const sock2 = mockSocket(1);

    // Build connected message from active provider
    const provider: ExpandStateProvider = {
      getSession: () => ({ id: "exp-active-1", taskId: "7", agent: "claude", model: "sonnet", state: "active" }),
      getOutcome: () => null,
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));

    // Replay ring buffer
    broadcaster.replay(sock2);

    // Verify connected message
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.expandSession).toEqual({
      sessionId: "exp-active-1",
      taskId: "7",
      agent: "claude",
      model: "sonnet",
      state: "active",
    });
    expect(connectedMsg.expandOutcome).toBeNull();

    // Verify replay: 5 events
    expect(sock2.send).toHaveBeenCalledTimes(6); // 1 connected + 5 replay
    const replayed = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // All events have channel="expand"
    expect(replayed.every((e: any) => e.channel === "expand")).toBe(true);

    // Event types in order
    expect(replayed.map((e: any) => e.type)).toEqual([
      "expand:started",
      "agent:text",
      "agent:tool",
      "agent:tool_result",
      "agent:text",
    ]);

    // No expand:finished in replay (session still active)
    expect(replayed.find((e: any) => e.type === "expand:finished")).toBeUndefined();
  });
});

describe("reconnect scenario: expand completed with success", () => {
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
      { type: "expand:started", sessionId: "exp-success", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Subtasks generated" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:tool", name: "Write", summary: "Write tasks.json" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: { status: "success", taskId: "7", subtaskCount: 4 } },
      "expand",
    );

    // New client connects after session completed
    clients.delete(sock1);
    const sock2 = mockSocket(1);

    // Connected message: session cleaned up, outcome persists
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "success", taskId: "7", subtaskCount: 4 }),
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));
    broadcaster.replay(sock2);

    // Connected carries the terminal outcome
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.expandSession).toBeNull();
    expect(connectedMsg.expandOutcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });

    // Replay includes the expand:finished event too
    const replayed = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    const finishedInReplay = replayed.find((e: any) => e.type === "expand:finished");
    expect(finishedInReplay).toBeDefined();
    expect(finishedInReplay.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });

    // Client can verify consistency: connected.expandOutcome matches replay's finished.outcome
    expect(connectedMsg.expandOutcome.status).toBe(finishedInReplay.outcome.status);
    expect(connectedMsg.expandOutcome.taskId).toBe(finishedInReplay.outcome.taskId);
    expect(connectedMsg.expandOutcome.subtaskCount).toBe(finishedInReplay.outcome.subtaskCount);
  });
});

describe("reconnect scenario: expand completed with failure", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("recovers failure outcome with error details and reason", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-fail", taskId: "7", agent: "opencode" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Cannot decompose task" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:error", message: "Agent signalled blocked", reason: "agent_failed" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      {
        type: "expand:finished",
        outcome: {
          status: "failure",
          taskId: "7",
          reason: "agent_failed",
          errors: ["Agent signalled blocked: task too vague", "Post-validation failed"],
          message: "Agent signalled blocked: task too vague",
          subtaskCount: 0,
        },
      },
      "expand",
    );

    const sock2 = mockSocket(1);
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({
        status: "failure",
        taskId: "7",
        reason: "agent_failed",
        errors: ["Agent signalled blocked: task too vague", "Post-validation failed"],
        message: "Agent signalled blocked: task too vague",
        subtaskCount: 0,
      }),
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));
    broadcaster.replay(sock2);

    // Connected carries failure outcome with errors and reason
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.expandOutcome).toEqual({
      status: "failure",
      taskId: "7",
      reason: "agent_failed",
      errors: ["Agent signalled blocked: task too vague", "Post-validation failed"],
      message: "Agent signalled blocked: task too vague",
      subtaskCount: 0,
    });

    // Replay has the error and finished events
    const replayed = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    const errorEvent = replayed.find((e: any) => e.type === "expand:error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toBe("Agent signalled blocked");
    expect(errorEvent.reason).toBe("agent_failed");

    const finishedEvent = replayed.find((e: any) => e.type === "expand:finished");
    expect(finishedEvent).toBeDefined();
    expect(finishedEvent.outcome.status).toBe("failure");
    expect(finishedEvent.outcome.taskId).toBe("7");
    expect(finishedEvent.outcome.errors).toHaveLength(2);
  });

  it("recovers hash_conflict failure outcome", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-hash", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      {
        type: "expand:finished",
        outcome: {
          status: "failure",
          taskId: "7",
          reason: "hash_conflict",
          errors: ["tasks.json was modified during the expand session"],
          message: "tasks.json was modified during the expand session",
          subtaskCount: 0,
        },
      },
      "expand",
    );

    const sock2 = mockSocket(1);
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({
        status: "failure",
        taskId: "7",
        reason: "hash_conflict",
        errors: ["tasks.json was modified during the expand session"],
        message: "tasks.json was modified during the expand session",
        subtaskCount: 0,
      }),
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));

    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.expandOutcome!.reason).toBe("hash_conflict");
    expect(connectedMsg.expandOutcome!.taskId).toBe("7");
  });
});

describe("reconnect scenario: expand completed with cancellation", () => {
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
      { type: "expand:started", sessionId: "exp-cancel", taskId: "7", agent: "claude", model: "opus" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Starting decomposition..." },
      "expand",
    );
    // User stopped the session mid-flight
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: { status: "cancelled", taskId: "7", subtaskCount: 0 } },
      "expand",
    );

    const sock2 = mockSocket(1);
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "cancelled", taskId: "7", subtaskCount: 0 }),
    };
    const connected = buildConnectedMessage(provider);
    sock2.send(JSON.stringify(connected));
    broadcaster.replay(sock2);

    // Connected message carries cancelled outcome
    const connectedMsg = JSON.parse(sock2.send.mock.calls[0][0] as string);
    expect(connectedMsg.expandSession).toBeNull();
    expect(connectedMsg.expandOutcome).toEqual({ status: "cancelled", taskId: "7", subtaskCount: 0 });

    // Replay confirms the session started and was cancelled
    const replayed = sock2.send.mock.calls.slice(1).map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayed[0].type).toBe("expand:started");
    expect(replayed[replayed.length - 1].type).toBe("expand:finished");
    expect(replayed[replayed.length - 1].outcome.status).toBe("cancelled");
    expect(replayed[replayed.length - 1].outcome.taskId).toBe("7");
  });
});

describe("reconnect scenario: no expand session ever ran", () => {
  it("connected message has null session and null outcome when no expand ran", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => null,
    };
    const connected = buildConnectedMessage(provider);

    expect(connected.expandSession).toBeNull();
    expect(connected.expandOutcome).toBeNull();
  });

  it("replay is empty when no expand events were broadcast", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );

    const sock = mockSocket(1);
    broadcaster.replay(sock);

    expect(sock.send).not.toHaveBeenCalled();
  });
});

describe("reconnect: expand events isolated from other channels in replay", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("client can separate expand from execution events by channel in replay", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Execution events
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Running task 1..." }, "execute");
    broadcaster.broadcastWithChannel({ type: "execution:finished" }, "execute");

    // Expand events
    broadcaster.broadcastWithChannel({ type: "expand:started", sessionId: "exp-iso", taskId: "7", agent: "claude" }, "expand");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Decomposing task..." }, "expand");
    broadcaster.broadcastWithChannel({ type: "expand:finished", outcome: { status: "success", taskId: "7", subtaskCount: 3 } }, "expand");

    // New client replays
    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const replayed = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayed).toHaveLength(6);

    // Filter by channel
    const execEvents = replayed.filter((e: any) => e.channel === "execute");
    const expandEvents = replayed.filter((e: any) => e.channel === "expand");

    expect(execEvents).toHaveLength(3);
    expect(expandEvents).toHaveLength(3);

    // Each group has the correct events
    expect(execEvents.map((e: any) => e.type)).toEqual([
      "execution:state",
      "agent:text",
      "execution:finished",
    ]);
    expect(expandEvents.map((e: any) => e.type)).toEqual([
      "expand:started",
      "agent:text",
      "expand:finished",
    ]);
  });

  it("client can separate expand from parse-prd events by channel in replay", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Parse-prd events
    broadcaster.broadcastWithChannel({ type: "parse-prd:started", sessionId: "pprd-1", agent: "claude" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "PRD analysis" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "parse-prd:finished", outcome: { status: "success" } }, "parse-prd");

    // Expand events
    broadcaster.broadcastWithChannel({ type: "expand:started", sessionId: "exp-prd-iso", taskId: "7", agent: "opencode" }, "expand");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Task decomposition" }, "expand");

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const replayed = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    const parsePrdEvents = replayed.filter((e: any) => e.channel === "parse-prd");
    const expandEvents = replayed.filter((e: any) => e.channel === "expand");

    expect(parsePrdEvents).toHaveLength(3);
    expect(expandEvents).toHaveLength(2);

    // No cross-contamination
    expect(parsePrdEvents.every((e: any) => e.channel === "parse-prd")).toBe(true);
    expect(expandEvents.every((e: any) => e.channel === "expand")).toBe(true);
  });

  it("client can separate expand from chat events by channel in replay", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Chat events
    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "chat-1", agent: "claude" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Chat response" }, "chat");
    broadcaster.broadcastWithChannel({ type: "chat:idle" }, "chat");

    // Expand events
    broadcaster.broadcastWithChannel({ type: "expand:started", sessionId: "exp-chat-iso", taskId: "7", agent: "opencode" }, "expand");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Expand analysis" }, "expand");

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const replayed = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    const chatEvents = replayed.filter((e: any) => e.channel === "chat");
    const expandEvents = replayed.filter((e: any) => e.channel === "expand");

    expect(chatEvents).toHaveLength(3);
    expect(expandEvents).toHaveLength(2);

    expect(chatEvents.every((e: any) => e.channel === "chat")).toBe(true);
    expect(expandEvents.every((e: any) => e.channel === "expand")).toBe(true);
  });

  it("all four channels coexist in replay without interference", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Interleave events from all four channels
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
    broadcaster.broadcastWithChannel({ type: "parse-prd:started", sessionId: "pprd-4ch", agent: "claude" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "expand:started", sessionId: "exp-4ch", taskId: "7", agent: "claude" }, "expand");
    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "chat-4ch", agent: "opencode" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "exec" }, "execute");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "prd" }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "expand" }, "expand");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "chat" }, "chat");
    broadcaster.broadcastWithChannel({ type: "parse-prd:finished", outcome: { status: "success" } }, "parse-prd");
    broadcaster.broadcastWithChannel({ type: "expand:finished", outcome: { status: "success", taskId: "7", subtaskCount: 3 } }, "expand");
    broadcaster.broadcastWithChannel({ type: "chat:finished" }, "chat");
    broadcaster.broadcastWithChannel({ type: "execution:finished" }, "execute");

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const replayed = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(replayed).toHaveLength(12);

    const byChannel = {
      execute: replayed.filter((e: any) => e.channel === "execute"),
      "parse-prd": replayed.filter((e: any) => e.channel === "parse-prd"),
      expand: replayed.filter((e: any) => e.channel === "expand"),
      chat: replayed.filter((e: any) => e.channel === "chat"),
    };

    expect(byChannel.execute).toHaveLength(3);
    expect(byChannel["parse-prd"]).toHaveLength(3);
    expect(byChannel.expand).toHaveLength(3);
    expect(byChannel.chat).toHaveLength(3);

    // Verify ordering is preserved within the expand channel
    expect(byChannel.expand.map((e: any) => e.type)).toEqual([
      "expand:started",
      "agent:text",
      "expand:finished",
    ]);
  });
});

describe("ExpandStateProvider interface conformance", () => {
  it("compile-time: ExpandStateProvider requires getSession and getOutcome", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "s1",
        taskId: "7",
        agent: "claude",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const session = provider.getSession();
    expect(session).not.toBeNull();
    expect(session!.id).toBe("s1");
    expect(session!.taskId).toBe("7");
    expect(session!.state).toBe("active");
    expect(provider.getOutcome()).toBeNull();
  });

  it("compile-time: ExpandStateProvider getSession returns null when idle", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => null,
    };

    expect(provider.getSession()).toBeNull();
    expect(provider.getOutcome()).toBeNull();
  });

  it("compile-time: ExpandStateProvider getSession includes taskId (unlike ParsePrdStateProvider)", () => {
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "s-taskid-check",
        taskId: "42",
        agent: "claude",
        state: "active",
      }),
      getOutcome: () => null,
    };

    const session = provider.getSession();
    expect(session).not.toBeNull();
    expect(session!.taskId).toBe("42");
  });

  it("compile-time: ExpandStateProvider getOutcome returns success outcome", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "success", taskId: "7", subtaskCount: 5 }),
    };

    const outcome = provider.getOutcome();
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("success");
    expect(outcome!.taskId).toBe("7");
    if (outcome!.status === "success") {
      expect(outcome!.subtaskCount).toBe(5);
    }
  });

  it("compile-time: ExpandStateProvider getOutcome returns failure outcome with reason and errors", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({
        status: "failure",
        taskId: "7",
        reason: "result_parse_failed",
        errors: ["No JSON object found in agent output"],
        message: "No JSON object found in agent output",
        subtaskCount: 0,
      }),
    };

    const outcome = provider.getOutcome();
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("failure");
    expect(outcome!.taskId).toBe("7");
    if (outcome!.status === "failure") {
      expect(outcome!.reason).toBe("result_parse_failed");
      expect(outcome!.errors).toEqual(["No JSON object found in agent output"]);
      expect(outcome!.message).toBe("No JSON object found in agent output");
    }
  });

  it("compile-time: ExpandStateProvider getOutcome returns cancelled outcome", () => {
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => ({ status: "cancelled", taskId: "7", subtaskCount: 0 }),
    };

    const outcome = provider.getOutcome();
    expect(outcome).not.toBeNull();
    expect(outcome!.status).toBe("cancelled");
    expect(outcome!.taskId).toBe("7");
    if (outcome!.status === "cancelled") {
      expect(outcome!.subtaskCount).toBe(0);
    }
  });
});
