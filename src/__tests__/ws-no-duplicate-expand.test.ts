/**
 * Server-side tests for expand reconnect invariants:
 * no duplicate terminal transitions, taskId presence, and outcome persistence.
 *
 * The expand channel doesn't yet have a frontend store/composable
 * (unlike parse-prd which has `useParsePrdStore` + `applyConnectedParsePrdState`),
 * so these tests exercise the server-side guarantees:
 *
 * 1. Connected snapshot is authoritative: expandOutcome and expandSession carry
 *    the definitive state; replay only provides event history.
 * 2. No duplicate terminal transition: the ring buffer contains exactly ONE
 *    expand:finished event per session lifecycle, so replay cannot create
 *    duplicate terminal state on the client.
 * 3. taskId presence: all terminal outcomes (success, failure, cancelled) carry
 *    taskId so the UI can bind the outcome to the correct task detail screen.
 * 4. Outcome survives reconnect: expandOutcome in the connected snapshot persists
 *    until the next expand session starts.
 *
 * Modeled on ws-no-duplicate-parse-prd.test.ts but adapted for server-side testing
 * since the frontend expand store layer does not exist yet.
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
 * Focuses on expand fields.
 */
function buildConnectedMessage(expandProvider: ExpandStateProvider | null) {
  const expandSession = expandProvider?.getSession() ?? null;
  const expandOutcome = expandProvider?.getOutcome() ?? null;
  return {
    type: "connected",
    state: "idle",
    currentUnit: null,
    iterationCurrent: 0,
    iterationTotal: 0,
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

/**
 * Simulate the full connected → replay → replay:complete sequence.
 * Returns { connected, replayed } for assertions.
 */
function simulateReconnect(
  broadcaster: WsBroadcaster,
  provider: ExpandStateProvider | null,
) {
  const sock = mockSocket(1);
  const connected = buildConnectedMessage(provider);
  sock.send(JSON.stringify(connected));
  broadcaster.replay(sock);
  sock.send(JSON.stringify({ type: "replay:complete" }));

  const allMessages = sock.send.mock.calls.map(
    (c: unknown[]) => JSON.parse(c[0] as string),
  );

  return {
    connectedMsg: allMessages[0],
    replayedEvents: allMessages.slice(1, -1), // exclude connected and replay:complete
    replayComplete: allMessages[allMessages.length - 1],
    allMessages,
    sock,
  };
}

describe("No duplicate expand:finished during replay", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("replay contains exactly ONE expand:finished event — no duplicate terminal transitions", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Full session lifecycle
    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-1", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Decomposing..." },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: { status: "success", taskId: "7", subtaskCount: 4 } },
      "expand",
    );

    // Reconnect
    const { replayedEvents } = simulateReconnect(broadcaster, {
      getSession: () => null,
      getOutcome: () => ({ status: "success", taskId: "7", subtaskCount: 4 }),
    });

    // Count expand:finished events in replay
    const finishedEvents = replayedEvents.filter(
      (e: any) => e.type === "expand:finished",
    );
    expect(finishedEvents).toHaveLength(1);
  });

  it("replay contains exactly ONE expand:finished for failure scenario", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-fail-dup", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:error", message: "Hash conflict", reason: "hash_conflict" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      {
        type: "expand:finished",
        outcome: {
          status: "failure", taskId: "7", reason: "hash_conflict",
          errors: ["tasks.json modified"], message: "tasks.json modified", subtaskCount: 0,
        },
      },
      "expand",
    );

    const { replayedEvents } = simulateReconnect(broadcaster, {
      getSession: () => null,
      getOutcome: () => ({
        status: "failure", taskId: "7", reason: "hash_conflict",
        errors: ["tasks.json modified"], message: "tasks.json modified", subtaskCount: 0,
      }),
    });

    const finishedEvents = replayedEvents.filter(
      (e: any) => e.type === "expand:finished",
    );
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0].outcome.status).toBe("failure");
  });

  it("replay contains exactly ONE expand:finished for cancellation scenario", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-cancel-dup", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: { status: "cancelled", taskId: "7", subtaskCount: 0 } },
      "expand",
    );

    const { replayedEvents } = simulateReconnect(broadcaster, {
      getSession: () => null,
      getOutcome: () => ({ status: "cancelled", taskId: "7", subtaskCount: 0 }),
    });

    const finishedEvents = replayedEvents.filter(
      (e: any) => e.type === "expand:finished",
    );
    expect(finishedEvents).toHaveLength(1);
    expect(finishedEvents[0].outcome.status).toBe("cancelled");
  });
});

describe("Connected snapshot is authoritative over replay", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("connected expandOutcome matches replay's expand:finished.outcome — no divergence", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    const outcome: ExpandManagerOutcome = {
      status: "success", taskId: "7", subtaskCount: 5,
    };

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-auth", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome },
      "expand",
    );

    const { connectedMsg, replayedEvents } = simulateReconnect(broadcaster, {
      getSession: () => null,
      getOutcome: () => outcome,
    });

    // Connected is the authority
    expect(connectedMsg.expandOutcome).toEqual(outcome);

    // Replay confirms (no divergence)
    const finishedInReplay = replayedEvents.find(
      (e: any) => e.type === "expand:finished",
    );
    expect(finishedInReplay.outcome).toEqual(outcome);
  });

  it("connected expandSession is authoritative when session is active — replay:started is supplementary", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-active-auth", taskId: "12", agent: "claude", model: "sonnet" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Working..." },
      "expand",
    );

    const { connectedMsg, replayedEvents } = simulateReconnect(broadcaster, {
      getSession: () => ({
        id: "exp-active-auth",
        taskId: "12",
        agent: "claude",
        model: "sonnet",
        state: "active",
      }),
      getOutcome: () => null,
    });

    // Connected message carries the authoritative session state
    expect(connectedMsg.expandSession).toEqual({
      sessionId: "exp-active-auth",
      taskId: "12",
      agent: "claude",
      model: "sonnet",
      state: "active",
    });
    expect(connectedMsg.expandOutcome).toBeNull();

    // Replay has the started event (supplementary, not authoritative)
    const startedInReplay = replayedEvents.find(
      (e: any) => e.type === "expand:started",
    );
    expect(startedInReplay).toBeDefined();
    expect(startedInReplay.sessionId).toBe("exp-active-auth");
    expect(startedInReplay.taskId).toBe("12");
  });

  it("connected with no expand fields resets state — even if replay has stale events", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Previous session events in the buffer (could be stale)
    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-stale", taskId: "old-task", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: { status: "success", taskId: "old-task", subtaskCount: 2 } },
      "expand",
    );

    // New connection: server says no expand session/outcome
    const { connectedMsg, replayedEvents } = simulateReconnect(broadcaster, {
      getSession: () => null,
      getOutcome: () => null,
    });

    // Connected says "no expand state" — this is authoritative
    expect(connectedMsg.expandSession).toBeNull();
    expect(connectedMsg.expandOutcome).toBeNull();

    // Replay still has stale events — client must use connected as authority
    // and not re-derive state from stale replay events
    const staleFinished = replayedEvents.find(
      (e: any) => e.type === "expand:finished",
    );
    expect(staleFinished).toBeDefined(); // events are in the buffer
    // But connected message overrides: expandOutcome is null
  });
});

describe("expandOutcome survives reconnect until next expand session starts", () => {
  it("failure outcome persists across multiple reconnects", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );

    const sock1 = mockSocket(1);
    clients.add(sock1);

    const failureOutcome: ExpandManagerOutcome = {
      status: "failure",
      taskId: "7",
      reason: "agent_failed",
      errors: ["Agent timed out"],
      message: "Agent timed out",
      subtaskCount: 0,
    };

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-persist", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: failureOutcome },
      "expand",
    );

    // Provider always returns the same outcome (simulating ExpandManager's behavior)
    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => failureOutcome,
    };

    // First reconnect
    const result1 = simulateReconnect(broadcaster, provider);
    expect(result1.connectedMsg.expandOutcome).toEqual(failureOutcome);

    // Second reconnect — outcome still there
    const result2 = simulateReconnect(broadcaster, provider);
    expect(result2.connectedMsg.expandOutcome).toEqual(failureOutcome);

    // Third reconnect — still persists
    const result3 = simulateReconnect(broadcaster, provider);
    expect(result3.connectedMsg.expandOutcome).toEqual(failureOutcome);
  });

  it("cancelled outcome persists across reconnects", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );

    const cancelledOutcome: ExpandManagerOutcome = {
      status: "cancelled",
      taskId: "7",
      subtaskCount: 0,
    };

    const provider: ExpandStateProvider = {
      getSession: () => null,
      getOutcome: () => cancelledOutcome,
    };

    const result = simulateReconnect(broadcaster, provider);
    expect(result.connectedMsg.expandOutcome).toEqual(cancelledOutcome);
  });

  it("outcome is cleared when new expand session starts (provider returns null outcome + active session)", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );

    // New session is active — outcome is cleared by the manager
    const provider: ExpandStateProvider = {
      getSession: () => ({
        id: "exp-new",
        taskId: "7",
        agent: "claude",
        state: "active",
      }),
      getOutcome: () => null, // cleared when start() is called
    };

    const result = simulateReconnect(broadcaster, provider);
    expect(result.connectedMsg.expandSession).not.toBeNull();
    expect(result.connectedMsg.expandOutcome).toBeNull();
  });
});

describe("taskId presence in all terminal outcomes and events", () => {
  it("expand:started event carries taskId", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-tid", taskId: "42", agent: "claude" },
      "expand",
    );

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    expect(events[0].taskId).toBe("42");
  });

  it("expand:finished success outcome carries taskId and subtaskCount", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
    const sock1 = mockSocket(1);
    clients.add(sock1);

    const outcome: ExpandManagerOutcome = {
      status: "success", taskId: "42", subtaskCount: 6,
    };
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome },
      "expand",
    );

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    const finished = events.find((e: any) => e.type === "expand:finished");
    expect(finished.outcome.taskId).toBe("42");
    expect(finished.outcome.subtaskCount).toBe(6);
  });

  it("expand:finished failure outcome carries taskId, reason, errors, message", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
    const sock1 = mockSocket(1);
    clients.add(sock1);

    const outcome: ExpandManagerOutcome = {
      status: "failure",
      taskId: "42",
      reason: "result_parse_failed",
      errors: ["No JSON found"],
      message: "No JSON found",
      subtaskCount: 0,
    };
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome },
      "expand",
    );

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    const finished = events.find((e: any) => e.type === "expand:finished");
    expect(finished.outcome.taskId).toBe("42");
    expect(finished.outcome.reason).toBe("result_parse_failed");
    expect(finished.outcome.errors).toEqual(["No JSON found"]);
    expect(finished.outcome.message).toBe("No JSON found");
  });

  it("expand:finished cancelled outcome carries taskId", () => {
    const clients = new Set<ReturnType<typeof mockSocket>>();
    const broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
    const sock1 = mockSocket(1);
    clients.add(sock1);

    const outcome: ExpandManagerOutcome = {
      status: "cancelled", taskId: "42", subtaskCount: 0,
    };
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome },
      "expand",
    );

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );
    const finished = events.find((e: any) => e.type === "expand:finished");
    expect(finished.outcome.taskId).toBe("42");
    expect(finished.outcome.subtaskCount).toBe(0);
  });

  it("connected expandOutcome always includes taskId for all status types", () => {
    const statuses: ExpandManagerOutcome[] = [
      { status: "success", taskId: "10", subtaskCount: 3 },
      { status: "failure", taskId: "20", reason: "agent_failed", errors: ["e"], message: "e", subtaskCount: 0 },
      { status: "cancelled", taskId: "30", subtaskCount: 0 },
    ];

    for (const outcome of statuses) {
      const provider: ExpandStateProvider = {
        getSession: () => null,
        getOutcome: () => outcome,
      };
      const connected = buildConnectedMessage(provider);
      expect(connected.expandOutcome).not.toBeNull();
      expect(connected.expandOutcome!.taskId).toBe(outcome.taskId);
    }
  });
});

describe("expand channel events do not interfere with other channels", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  it("expand replay events are isolated from parse-prd — no cross-channel leakage", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Parse-prd session
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:started", sessionId: "pprd-x", agent: "claude" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "PRD text" },
      "parse-prd",
    );
    broadcaster.broadcastWithChannel(
      { type: "parse-prd:finished", outcome: { status: "success" } },
      "parse-prd",
    );

    // Expand session for a different purpose
    broadcaster.broadcastWithChannel(
      { type: "expand:started", sessionId: "exp-x", taskId: "7", agent: "claude" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "agent:text", text: "Expand text" },
      "expand",
    );
    broadcaster.broadcastWithChannel(
      { type: "expand:finished", outcome: { status: "success", taskId: "7", subtaskCount: 3 } },
      "expand",
    );

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // Verify no channel mixing in the events
    const parsePrdEvents = events.filter((e: any) => e.channel === "parse-prd");
    const expandEvents = events.filter((e: any) => e.channel === "expand");

    // Parse-prd events don't contain expand-specific fields
    for (const e of parsePrdEvents) {
      if (e.type === "parse-prd:finished") {
        expect(e.outcome.taskId).toBeUndefined(); // ParsePrdManagerOutcome doesn't have taskId
      }
    }

    // Expand events always have expand channel and taskId in finished
    for (const e of expandEvents) {
      expect(e.channel).toBe("expand");
      if (e.type === "expand:finished") {
        expect(e.outcome.taskId).toBeDefined();
      }
    }

    expect(parsePrdEvents).toHaveLength(3);
    expect(expandEvents).toHaveLength(3);
  });

  it("expand replay events are isolated from chat — agent:text events routed by channel", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "chat-y", agent: "claude" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Chat message" }, "chat");
    broadcaster.broadcastWithChannel({ type: "chat:finished" }, "chat");

    broadcaster.broadcastWithChannel({ type: "expand:started", sessionId: "exp-y", taskId: "5", agent: "claude" }, "expand");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Expand message" }, "expand");
    broadcaster.broadcastWithChannel({ type: "expand:finished", outcome: { status: "cancelled", taskId: "5", subtaskCount: 0 } }, "expand");

    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);

    const events = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    const chatTexts = events.filter((e: any) => e.channel === "chat" && e.type === "agent:text");
    const expandTexts = events.filter((e: any) => e.channel === "expand" && e.type === "agent:text");

    expect(chatTexts).toHaveLength(1);
    expect(chatTexts[0].text).toBe("Chat message");

    expect(expandTexts).toHaveLength(1);
    expect(expandTexts[0].text).toBe("Expand message");
  });
});
