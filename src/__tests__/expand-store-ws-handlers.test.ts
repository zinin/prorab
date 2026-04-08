/**
 * Tests for expand store WS handlers: outcome persistence, replay, and rehydration.
 *
 * Covers the contract between useWebSocket.ts connected-message handling
 * and expandStore — exercises success/failure/cancelled outcomes surviving
 * reconnect and replay, and the _rehydrating guard behavior.
 *
 * Pure unit-level — uses real Pinia stores, no server or WebSocket.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useExpandStore } from "../../ui/src/stores/expand";
import type { ExpandOutcome } from "../../ui/src/stores/expand";

// ---------------------------------------------------------------------------
// Helpers — simulate connected message handling from useWebSocket.ts
// ---------------------------------------------------------------------------

/**
 * Simulates the connected message handling for expandStore
 * from useWebSocket.ts, using clearMessages + rehydrateFromConnected.
 */
function handleConnectedExpand(
  data: Record<string, unknown>,
  store: ReturnType<typeof useExpandStore>,
) {
  store.clearMessages();
  store.rehydrateFromConnected(data);
}

/**
 * Simulates replay:complete — clears the rehydrating flag.
 */
function handleReplayComplete(store: ReturnType<typeof useExpandStore>) {
  store.setRehydrating(false);
}

// ---------------------------------------------------------------------------
// Outcome persistence tests
// ---------------------------------------------------------------------------

describe("expand outcome persistence", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("success outcome persists after expand:finished", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 4 },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
    expect(store.isTerminal).toBe(true);
  });

  it("failure outcome with errors persists after expand:finished", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "failure",
        taskId: "7",
        reason: "agent_failed",
        errors: ["Agent signalled blocked", "Post-validation failed"],
        message: "Agent signalled blocked",
        subtaskCount: 0,
      },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({
      status: "failure",
      taskId: "7",
      reason: "agent_failed",
      errors: ["Agent signalled blocked", "Post-validation failed"],
      message: "Agent signalled blocked",
      subtaskCount: 0,
    });
    expect(store.isTerminal).toBe(true);
  });

  it("cancelled outcome persists after expand:finished", () => {
    const store = useExpandStore();
    store.state = "stopping";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "cancelled", taskId: "7", subtaskCount: 0 },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled", taskId: "7", subtaskCount: 0 });
    expect(store.isTerminal).toBe(true);
  });

  it("outcome is NOT auto-cleared after expand:finished", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 4 },
    });

    // Outcome must survive — page-level state machine needs it for transitions
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
    expect(store.state).toBe("completed");

    // Only explicit $reset or clearExpand should clear it
    expect(store.outcome).not.toBeNull();
  });

  it("outcome survives multiple subsequent events (not auto-cleared)", () => {
    const store = useExpandStore();

    // Full lifecycle
    store.handleWsEvent({
      type: "expand:started",
      channel: "expand",
      agent: "claude",
      model: "sonnet",
      sessionId: "s1",
      taskId: "7",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Processing...",
    });
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 4 },
    });

    // Outcome persists — store stays in completed state
    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });

    // Simulate time passing — outcome still there
    expect(store.isTerminal).toBe(true);
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
  });

  it("outcome is only cleared by explicit $reset", () => {
    const store = useExpandStore();
    store.state = "completed";
    store.outcome = { status: "failure", taskId: "7", reason: "agent_failed", errors: ["bad"], message: "bad", subtaskCount: 0 };

    // $reset clears everything
    store.$reset();
    expect(store.outcome).toBeNull();
    expect(store.state).toBe("idle");
  });

  it("outcome is only cleared by clearExpand", () => {
    const store = useExpandStore();
    store.state = "completed";
    store.outcome = { status: "cancelled", taskId: "7", subtaskCount: 0 };

    store.clearExpand();
    expect(store.outcome).toBeNull();
    expect(store.state).toBe("idle");
  });

  it("clearMessages does NOT clear outcome", () => {
    const store = useExpandStore();
    store.state = "completed";
    store.outcome = { status: "success", taskId: "7", subtaskCount: 4 };
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });

    store.clearMessages();
    expect(store.messages).toEqual([]);
    // Outcome survives clearMessages
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
    expect(store.state).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Connected message rehydration tests
// ---------------------------------------------------------------------------

describe("expand connected message rehydration", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("restores active session from connected message with expandSession", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-1",
          taskId: "7",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.sessionInfo).toEqual({
      sessionId: "exp-1",
      taskId: "7",
      agent: "claude",
      model: "sonnet",
      variant: undefined,
    });
    expect(store.outcome).toBeNull();
  });

  it("restores active session with variant from connected message", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-1v",
          taskId: "7",
          agent: "claude",
          model: "sonnet",
          variant: "high",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.sessionInfo).toEqual({
      sessionId: "exp-1v",
      taskId: "7",
      agent: "claude",
      model: "sonnet",
      variant: "high",
    });
    expect(store.outcome).toBeNull();
  });

  it("restores stopping session from connected message", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-2",
          taskId: "7",
          agent: "opencode",
          state: "stopping",
        },
      },
      store,
    );

    expect(store.state).toBe("stopping");
    expect(store.sessionInfo).toEqual({
      sessionId: "exp-2",
      taskId: "7",
      agent: "opencode",
      model: undefined,
      variant: undefined,
    });
  });

  it("restores success outcome from connected message with expandOutcome", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 5 },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.sessionInfo).toBeNull();
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 5 });
  });

  it("restores failure outcome from connected message with expandOutcome", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: {
          status: "failure",
          taskId: "7",
          reason: "agent_failed",
          errors: ["Agent signalled blocked"],
          message: "Agent signalled blocked",
          subtaskCount: 0,
        },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({
      status: "failure",
      taskId: "7",
      reason: "agent_failed",
      errors: ["Agent signalled blocked"],
      message: "Agent signalled blocked",
      subtaskCount: 0,
    });
  });

  it("restores cancelled outcome from connected message with expandOutcome", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: { status: "cancelled", taskId: "7", subtaskCount: 0 },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled", taskId: "7", subtaskCount: 0 });
  });

  it("resets to idle when no expandSession or expandOutcome in connected message", () => {
    const store = useExpandStore();
    // Simulate previous state
    store.state = "completed";
    store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude" };

    handleConnectedExpand(
      {
        type: "connected",
        // No expandSession or expandOutcome
      },
      store,
    );

    expect(store.state).toBe("idle");
    expect(store.sessionInfo).toBeNull();
    expect(store.outcome).toBeNull();
  });

  it("expandSession takes priority over expandOutcome (session still active)", () => {
    const store = useExpandStore();

    // When both are present, expandSession wins (session is active)
    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-active",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 3 }, // This is from a previous session
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.outcome).toBeNull(); // Active session, no outcome yet
  });

  it("clears messages before restoring state (prevents duplicates on reconnect)", () => {
    const store = useExpandStore();
    store.messages.push({ id: "old-1", type: "text", content: "stale", timestamp: 1 });
    store.messages.push({ id: "old-2", type: "tool", content: "stale", timestamp: 2, toolName: "Read" });

    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-reconnect",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
      },
      store,
    );

    // Messages cleared — replay will repopulate
    expect(store.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rehydration guard (replay behavior)
// ---------------------------------------------------------------------------

describe("expand rehydrating guard during replay", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("rehydrating flag prevents expand:started from overwriting state on replay", () => {
    const store = useExpandStore();

    // Step 1: connected message sets authoritative state
    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-rehydrate",
          taskId: "7",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");

    // Step 2: replay sends expand:started — should NOT overwrite state
    // because _rehydrating is true
    store.handleWsEvent({
      type: "expand:started",
      channel: "expand",
      agent: "claude",
      model: "sonnet",
      sessionId: "exp-rehydrate",
      taskId: "7",
    });

    // State still "active" (not re-set by the replayed started event)
    expect(store.state).toBe("active");
    // sessionInfo preserved from connected snapshot — NOT overwritten by replay
    expect(store.sessionInfo?.agent).toBe("claude");
  });

  it("rehydrating flag prevents expand:finished from overwriting state on replay", () => {
    const store = useExpandStore();

    // Connected message sets authoritative state to completed
    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });

    // Replayed expand:finished should NOT overwrite
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 4 },
    });

    // Outcome preserved from authoritative snapshot
    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
  });

  it("rehydrating flag is cleared on replay:complete", () => {
    const store = useExpandStore();

    // Setup: connected message + rehydrating
    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-replay",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
      },
      store,
    );

    // Replay events with rehydrating on
    store.handleWsEvent({
      type: "expand:started",
      agent: "claude",
      sessionId: "exp-replay",
      taskId: "7",
    });

    // replay:complete clears the flag
    handleReplayComplete(store);

    // Now new events should work normally
    store.handleWsEvent({
      type: "expand:started",
      agent: "opencode",
      sessionId: "exp-new",
      taskId: "8",
    });

    // State IS updated now (rehydrating is off)
    expect(store.state).toBe("active");
    expect(store.sessionInfo?.agent).toBe("opencode");
  });

  it("replayed agent:text events ARE added to messages even during rehydration", () => {
    const store = useExpandStore();

    // Setup: connected + rehydrating
    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-msg-replay",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
      },
      store,
    );

    // Replay agent events — messages should still be added
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Replayed text 1",
    });
    store.handleWsEvent({
      type: "agent:tool",
      channel: "expand",
      name: "Read",
      summary: "Read tasks.json",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Replayed text 2",
    });

    // Messages are added (rehydrating only guards lifecycle events)
    expect(store.messages.length).toBe(3);
    expect(store.messages[0].type).toBe("text");
    expect(store.messages[0].content).toBe("Replayed text 1");
    expect(store.messages[1].type).toBe("tool");
    expect(store.messages[2].type).toBe("text");
    expect(store.messages[2].content).toBe("Replayed text 2");
  });

  it("replayed expand:error events add error messages during rehydration", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: {
          status: "failure",
          taskId: "7",
          reason: "agent_failed",
          errors: ["validation failed"],
          message: "validation failed",
          subtaskCount: 0,
        },
      },
      store,
    );

    // Replay: error event adds message
    store.handleWsEvent({
      type: "expand:error",
      channel: "expand",
      message: "Agent crashed",
    });

    expect(store.messages.length).toBe(1);
    expect(store.messages[0].type).toBe("error");
    expect(store.error).toBe("Agent crashed");
  });
});

// ---------------------------------------------------------------------------
// Full reconnect scenarios (connected + replay + replay:complete)
// ---------------------------------------------------------------------------

describe("expand full reconnect scenarios", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("reconnect during active session: connected → replay → replay:complete", () => {
    const store = useExpandStore();

    // Step 1: connected message
    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-active-reconnect",
          taskId: "7",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.sessionInfo?.taskId).toBe("7");
    expect(store.outcome).toBeNull();

    // Step 2: replay events (rehydrating is on)
    store.handleWsEvent({
      type: "expand:started",
      channel: "expand",
      agent: "claude",
      model: "sonnet",
      sessionId: "exp-active-reconnect",
      taskId: "7",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Reading task details...",
    });
    store.handleWsEvent({
      type: "agent:tool",
      channel: "expand",
      name: "Read",
      summary: "Read .taskmaster/tasks/tasks.json",
    });

    // State NOT overwritten by expand:started replay
    expect(store.state).toBe("active");
    // Messages restored
    expect(store.messages.length).toBe(2); // text + tool (started doesn't add a message)

    // Step 3: replay:complete
    handleReplayComplete(store);

    // State still active, rehydrating cleared
    expect(store.state).toBe("active");
  });

  it("reconnect after success: connected → replay → replay:complete", () => {
    const store = useExpandStore();

    // Step 1: connected message with terminal outcome
    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });

    // Step 2: replay events (rehydrating is on)
    store.handleWsEvent({
      type: "expand:started",
      channel: "expand",
      agent: "claude",
      sessionId: "exp-success-replay",
      taskId: "7",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Subtasks generated",
    });
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 4 },
    });

    // expand:started did NOT overwrite state (rehydrating)
    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
    // Messages restored
    expect(store.messages.length).toBe(1); // only agent:text

    // Step 3: replay:complete
    handleReplayComplete(store);

    // Outcome persists after replay:complete
    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
  });

  it("reconnect after failure: connected → replay → replay:complete", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: {
          status: "failure",
          taskId: "7",
          reason: "hash_conflict",
          errors: ["tasks.json modified"],
          message: "tasks.json modified",
          subtaskCount: 0,
        },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome?.status).toBe("failure");

    // Replay
    store.handleWsEvent({
      type: "expand:started",
      channel: "expand",
      agent: "opencode",
      sessionId: "exp-fail-replay",
      taskId: "7",
    });
    store.handleWsEvent({
      type: "expand:error",
      channel: "expand",
      message: "Hash conflict detected",
    });
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "failure",
        taskId: "7",
        reason: "hash_conflict",
        errors: ["tasks.json modified"],
        message: "tasks.json modified",
        subtaskCount: 0,
      },
    });

    // replay:complete
    handleReplayComplete(store);

    expect(store.state).toBe("completed");
    expect(store.outcome?.status).toBe("failure");
    expect(store.error).toBe("Hash conflict detected");
  });

  it("reconnect after cancellation: connected → replay → replay:complete", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: { status: "cancelled", taskId: "7", subtaskCount: 0 },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled", taskId: "7", subtaskCount: 0 });

    // Replay
    store.handleWsEvent({
      type: "expand:started",
      channel: "expand",
      agent: "claude",
      sessionId: "exp-cancel-replay",
      taskId: "7",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Starting...",
    });
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "cancelled", taskId: "7", subtaskCount: 0 },
    });

    handleReplayComplete(store);

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled", taskId: "7", subtaskCount: 0 });
  });

  it("reconnect with no prior session: connected → no expand fields → idle", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
      },
      store,
    );

    expect(store.state).toBe("idle");
    expect(store.sessionInfo).toBeNull();
    expect(store.outcome).toBeNull();

    // replay:complete is still sent (no-op for expand)
    handleReplayComplete(store);

    expect(store.state).toBe("idle");
  });

  it("consecutive reconnects preserve outcome across multiple connected messages", () => {
    const store = useExpandStore();

    // First connect: success outcome
    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      },
      store,
    );
    handleReplayComplete(store);
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });

    // Second connect: same outcome still from server
    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      },
      store,
    );
    handleReplayComplete(store);
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
    expect(store.state).toBe("completed");
  });

  it("new session after completed: connected with expandSession replaces outcome", () => {
    const store = useExpandStore();

    // Previous session outcome
    store.state = "completed";
    store.outcome = { status: "failure", taskId: "7", reason: "agent_failed", errors: ["old error"], message: "old error", subtaskCount: 0 };

    // New connect: new session is active (outcome cleared)
    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-new-after-fail",
          taskId: "8",
          agent: "claude",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.outcome).toBeNull(); // Old outcome cleared
    expect(store.sessionInfo?.agent).toBe("claude");
    expect(store.sessionInfo?.taskId).toBe("8");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("expand WS handler edge cases", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("expand:finished with null outcome stores null", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: null as unknown as ExpandOutcome,
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toBeNull();
  });

  it("expand:finished clears sessionInfo", () => {
    const store = useExpandStore();
    store.state = "active";
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude", model: "opus" };

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 4 },
    });

    expect(store.sessionInfo).toBeNull();
  });

  it("multiple expand:finished events — last outcome wins", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 4 },
    });

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "failure",
        taskId: "7",
        reason: "agent_failed",
        errors: ["overwritten"],
        message: "overwritten",
        subtaskCount: 0,
      },
    });

    expect(store.outcome?.status).toBe("failure");
  });

  it("error persists across expand:finished (not cleared)", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:error",
      channel: "expand",
      message: "Something broke before finish",
    });

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "failure",
        taskId: "7",
        reason: "agent_failed",
        errors: ["post-validation error"],
        message: "post-validation error",
        subtaskCount: 0,
      },
    });

    // Error from expand:error is preserved
    expect(store.error).toBe("Something broke before finish");
    expect(store.outcome?.status).toBe("failure");
  });

  it("connected message with expandOutcome defaults state to completed", () => {
    const store = useExpandStore();
    store.state = "idle";

    handleConnectedExpand(
      {
        type: "connected",
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      },
      store,
    );

    // Even starting from idle, outcome forces completed
    expect(store.state).toBe("completed");
  });

  it("connected message with expandSession.state uses server value", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-custom-state",
          taskId: "7",
          agent: "claude",
          state: "stopping",
        },
      },
      store,
    );

    expect(store.state).toBe("stopping");
  });

  it("connected message with expandSession without state defaults to active", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-no-state",
          taskId: "7",
          agent: "claude",
        },
      },
      store,
    );

    // Defaults to "active" via the ?? "active" fallback
    expect(store.state).toBe("active");
  });

  it("connected message with expandSession carries taskId", () => {
    const store = useExpandStore();

    handleConnectedExpand(
      {
        type: "connected",
        expandSession: {
          sessionId: "exp-tid",
          taskId: "42",
          agent: "claude",
          state: "active",
        },
      },
      store,
    );

    expect(store.sessionInfo?.taskId).toBe("42");
  });
});
