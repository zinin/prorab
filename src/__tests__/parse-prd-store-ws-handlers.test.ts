/**
 * Tests for parse-prd store WS handlers: outcome persistence, replay, and rehydration.
 *
 * Covers the contract between useWebSocket.ts connected-message handling
 * and parsePrdStore — exercises success/failure/cancelled outcomes surviving
 * reconnect and replay, and the _rehydrating guard behavior.
 *
 * Pure unit-level — uses real Pinia stores, no server or WebSocket.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useParsePrdStore } from "../../ui/src/stores/parse-prd";
import { applyConnectedParsePrdState } from "../../ui/src/composables/parse-prd-state-mapping";

// ---------------------------------------------------------------------------
// Helpers — simulate connected message handling from useWebSocket.ts
// ---------------------------------------------------------------------------

/**
 * Simulates the connected message handling for parsePrdStore
 * from useWebSocket.ts, using the shared helper + clearMessages.
 */
function handleConnectedParsePrd(
  data: Record<string, unknown>,
  store: ReturnType<typeof useParsePrdStore>,
) {
  store.clearMessages();
  applyConnectedParsePrdState(store, data);
}

/**
 * Simulates replay:complete — clears the rehydrating flag.
 */
function handleReplayComplete(store: ReturnType<typeof useParsePrdStore>) {
  store.setRehydrating(false);
}

// ---------------------------------------------------------------------------
// Outcome persistence tests
// ---------------------------------------------------------------------------

describe("parse-prd outcome persistence", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("success outcome persists after parse-prd:finished", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "success" },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success" });
    expect(store.isTerminal).toBe(true);
  });

  it("failure outcome with errors persists after parse-prd:finished", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "failure", errors: ["No tasks generated", "Post-validation failed"] },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({
      status: "failure",
      errors: ["No tasks generated", "Post-validation failed"],
    });
    expect(store.isTerminal).toBe(true);
  });

  it("cancelled outcome persists after parse-prd:finished", () => {
    const store = useParsePrdStore();
    store.state = "stopping";

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "cancelled" },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled" });
    expect(store.isTerminal).toBe(true);
  });

  it("outcome is NOT auto-cleared after parse-prd:finished", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "success" },
    });

    // Outcome must survive — page-level state machine needs it for transitions
    expect(store.outcome).toEqual({ status: "success" });
    expect(store.state).toBe("completed");

    // Only explicit $reset or clearParsePrd should clear it
    expect(store.outcome).not.toBeNull();
  });

  it("outcome survives multiple subsequent events (not auto-cleared)", () => {
    const store = useParsePrdStore();

    // Full lifecycle
    store.handleWsEvent({
      type: "parse-prd:started",
      channel: "parse-prd",
      agent: "claude",
      model: "sonnet",
      sessionId: "s1",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "Processing...",
    });
    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "success" },
    });

    // Outcome persists — store stays in completed state
    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success" });

    // Simulate time passing — outcome still there
    expect(store.isTerminal).toBe(true);
    expect(store.outcome).toEqual({ status: "success" });
  });

  it("outcome is only cleared by explicit $reset", () => {
    const store = useParsePrdStore();
    store.state = "completed";
    store.outcome = { status: "failure", errors: ["bad"] };

    // $reset clears everything
    store.$reset();
    expect(store.outcome).toBeNull();
    expect(store.state).toBe("idle");
  });

  it("outcome is only cleared by clearParsePrd", () => {
    const store = useParsePrdStore();
    store.state = "completed";
    store.outcome = { status: "cancelled" };

    store.clearParsePrd();
    expect(store.outcome).toBeNull();
    expect(store.state).toBe("idle");
  });

  it("clearMessages does NOT clear outcome", () => {
    const store = useParsePrdStore();
    store.state = "completed";
    store.outcome = { status: "success" };
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });

    store.clearMessages();
    expect(store.messages).toEqual([]);
    // Outcome survives clearMessages
    expect(store.outcome).toEqual({ status: "success" });
    expect(store.state).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Connected message rehydration tests
// ---------------------------------------------------------------------------

describe("parse-prd connected message rehydration", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("restores active session from connected message with parsePrdSession", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-1",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: undefined });
    expect(store.outcome).toBeNull();
  });

  it("restores active session with variant from connected message", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-1v",
          agent: "claude",
          model: "sonnet",
          variant: "high",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: "high" });
    expect(store.outcome).toBeNull();
  });

  it("restores stopping session from connected message", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-2",
          agent: "opencode",
          state: "stopping",
        },
      },
      store,
    );

    expect(store.state).toBe("stopping");
    expect(store.sessionInfo).toEqual({ agent: "opencode", model: undefined, variant: undefined });
  });

  it("restores success outcome from connected message with parsePrdOutcome", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: { status: "success" },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.sessionInfo).toBeNull();
    expect(store.outcome).toEqual({ status: "success" });
  });

  it("restores failure outcome from connected message with parsePrdOutcome", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: {
          status: "failure",
          errors: ["Agent signalled blocked: PRD not found"],
        },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({
      status: "failure",
      errors: ["Agent signalled blocked: PRD not found"],
    });
  });

  it("restores cancelled outcome from connected message with parsePrdOutcome", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: { status: "cancelled" },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled" });
  });

  it("resets to idle when no parsePrdSession or parsePrdOutcome in connected message", () => {
    const store = useParsePrdStore();
    // Simulate previous state
    store.state = "completed";
    store.outcome = { status: "success" };
    store.sessionInfo = { agent: "claude" };

    handleConnectedParsePrd(
      {
        type: "connected",
        // No parsePrdSession or parsePrdOutcome
      },
      store,
    );

    expect(store.state).toBe("idle");
    expect(store.sessionInfo).toBeNull();
    expect(store.outcome).toBeNull();
  });

  it("parsePrdSession takes priority over parsePrdOutcome (session still active)", () => {
    const store = useParsePrdStore();

    // When both are present, parsePrdSession wins (session is active)
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-active",
          agent: "claude",
          state: "active",
        },
        parsePrdOutcome: { status: "success" }, // This is from a previous session
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.outcome).toBeNull(); // Active session, no outcome yet
  });

  it("clears messages before restoring state (prevents duplicates on reconnect)", () => {
    const store = useParsePrdStore();
    store.messages.push({ id: "old-1", type: "text", content: "stale", timestamp: 1 });
    store.messages.push({ id: "old-2", type: "tool", content: "stale", timestamp: 2, toolName: "Read" });

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-reconnect",
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

describe("parse-prd rehydrating guard during replay", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("rehydrating flag prevents parse-prd:started from overwriting state on replay", () => {
    const store = useParsePrdStore();

    // Step 1: connected message sets authoritative state
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-rehydrate",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");

    // Step 2: replay sends parse-prd:started — should NOT overwrite state
    // because _rehydrating is true
    store.handleWsEvent({
      type: "parse-prd:started",
      channel: "parse-prd",
      agent: "claude",
      model: "sonnet",
      sessionId: "pprd-rehydrate",
    });

    // State still "active" (not re-set by the replayed started event)
    expect(store.state).toBe("active");
    // But sessionInfo IS updated (needed for UI display)
    // variant is undefined because connected message had no variant and started event has none
    expect(store.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: undefined });
  });

  it("rehydrating flag is cleared on replay:complete", () => {
    const store = useParsePrdStore();

    // Setup: connected message + rehydrating
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-replay",
          agent: "claude",
          state: "active",
        },
      },
      store,
    );

    // Replay events with rehydrating on
    store.handleWsEvent({
      type: "parse-prd:started",
      agent: "claude",
      sessionId: "pprd-replay",
    });

    // replay:complete clears the flag
    handleReplayComplete(store);

    // Now new events should work normally
    store.handleWsEvent({
      type: "parse-prd:started",
      agent: "opencode",
      sessionId: "pprd-new",
    });

    // State IS updated now (rehydrating is off)
    expect(store.state).toBe("active");
    expect(store.sessionInfo?.agent).toBe("opencode");
  });

  it("replayed agent:text events ARE added to messages even during rehydration", () => {
    const store = useParsePrdStore();

    // Setup: connected + rehydrating
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-msg-replay",
          agent: "claude",
          state: "active",
        },
      },
      store,
    );

    // Replay agent events — messages should still be added
    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "Replayed text 1",
    });
    store.handleWsEvent({
      type: "agent:tool",
      channel: "parse-prd",
      name: "Read",
      summary: "Read prd.md",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
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

  it("replayed parse-prd:error events add error messages during rehydration", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: { status: "failure", errors: ["validation failed"] },
      },
      store,
    );

    // Replay: error event adds message
    store.handleWsEvent({
      type: "parse-prd:error",
      channel: "parse-prd",
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

describe("parse-prd full reconnect scenarios", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("reconnect during active session: connected → replay → replay:complete", () => {
    const store = useParsePrdStore();

    // Step 1: connected message
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-active-reconnect",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: undefined });
    expect(store.outcome).toBeNull();

    // Step 2: replay events (rehydrating is on)
    store.handleWsEvent({
      type: "parse-prd:started",
      channel: "parse-prd",
      agent: "claude",
      model: "sonnet",
      sessionId: "pprd-active-reconnect",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "Reading PRD document...",
    });
    store.handleWsEvent({
      type: "agent:tool",
      channel: "parse-prd",
      name: "Read",
      summary: "Read .taskmaster/docs/prd.md",
    });

    // State NOT overwritten by parse-prd:started replay
    expect(store.state).toBe("active");
    // Messages restored
    expect(store.messages.length).toBe(2); // text + tool (started doesn't add a message)

    // Step 3: replay:complete
    handleReplayComplete(store);

    // State still active, rehydrating cleared
    expect(store.state).toBe("active");
  });

  it("reconnect after success: connected → replay → replay:complete", () => {
    const store = useParsePrdStore();

    // Step 1: connected message with terminal outcome
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: { status: "success" },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success" });

    // Step 2: replay events (rehydrating is on)
    store.handleWsEvent({
      type: "parse-prd:started",
      channel: "parse-prd",
      agent: "claude",
      sessionId: "pprd-success-replay",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "Tasks generated",
    });
    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "success" },
    });

    // parse-prd:started did NOT overwrite state (rehydrating)
    // But parse-prd:finished DOES set state=completed (which is already correct)
    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success" });
    // Messages restored
    expect(store.messages.length).toBe(1); // only agent:text

    // Step 3: replay:complete
    handleReplayComplete(store);

    // Outcome persists after replay:complete
    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success" });
  });

  it("reconnect after failure: connected → replay → replay:complete", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: {
          status: "failure",
          errors: ["Agent signalled blocked", "Post-validation failed"],
        },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({
      status: "failure",
      errors: ["Agent signalled blocked", "Post-validation failed"],
    });

    // Replay
    store.handleWsEvent({
      type: "parse-prd:started",
      channel: "parse-prd",
      agent: "opencode",
      sessionId: "pprd-fail-replay",
    });
    store.handleWsEvent({
      type: "parse-prd:error",
      channel: "parse-prd",
      message: "Agent signalled blocked",
    });
    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "failure", errors: ["Agent signalled blocked", "Post-validation failed"] },
    });

    // replay:complete
    handleReplayComplete(store);

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({
      status: "failure",
      errors: ["Agent signalled blocked", "Post-validation failed"],
    });
    expect(store.error).toBe("Agent signalled blocked");
  });

  it("reconnect after cancellation: connected → replay → replay:complete", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: { status: "cancelled" },
      },
      store,
    );

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled" });

    // Replay
    store.handleWsEvent({
      type: "parse-prd:started",
      channel: "parse-prd",
      agent: "claude",
      sessionId: "pprd-cancel-replay",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "Starting...",
    });
    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "cancelled" },
    });

    handleReplayComplete(store);

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled" });
  });

  it("reconnect with no prior session: connected → no parsePrd fields → idle", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
      },
      store,
    );

    expect(store.state).toBe("idle");
    expect(store.sessionInfo).toBeNull();
    expect(store.outcome).toBeNull();

    // replay:complete is still sent (no-op for parsePrd)
    handleReplayComplete(store);

    expect(store.state).toBe("idle");
  });

  it("consecutive reconnects preserve outcome across multiple connected messages", () => {
    const store = useParsePrdStore();

    // First connect: success outcome
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: { status: "success" },
      },
      store,
    );
    handleReplayComplete(store);
    expect(store.outcome).toEqual({ status: "success" });

    // Second connect: same outcome still from server
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: { status: "success" },
      },
      store,
    );
    handleReplayComplete(store);
    expect(store.outcome).toEqual({ status: "success" });
    expect(store.state).toBe("completed");
  });

  it("new session after completed: connected with parsePrdSession replaces outcome", () => {
    const store = useParsePrdStore();

    // Previous session outcome
    store.state = "completed";
    store.outcome = { status: "failure", errors: ["old error"] };

    // New connect: new session is active (outcome cleared)
    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-new-after-fail",
          agent: "claude",
          state: "active",
        },
      },
      store,
    );

    expect(store.state).toBe("active");
    expect(store.outcome).toBeNull(); // Old outcome cleared
    expect(store.sessionInfo?.agent).toBe("claude");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("parse-prd WS handler edge cases", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("parse-prd:finished with null outcome stores null", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: null as unknown as ParsePrdOutcome,
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toBeNull();
  });

  it("parse-prd:finished clears sessionInfo", () => {
    const store = useParsePrdStore();
    store.state = "active";
    store.sessionInfo = { agent: "claude", model: "opus" };

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "success" },
    });

    expect(store.sessionInfo).toBeNull();
  });

  it("multiple parse-prd:finished events — last outcome wins", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "success" },
    });

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "failure", errors: ["overwritten"] },
    });

    expect(store.outcome).toEqual({ status: "failure", errors: ["overwritten"] });
  });

  it("error persists across parse-prd:finished (not cleared)", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "parse-prd:error",
      channel: "parse-prd",
      message: "Something broke before finish",
    });

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "failure", errors: ["post-validation error"] },
    });

    // Error from parse-prd:error is preserved
    expect(store.error).toBe("Something broke before finish");
    expect(store.outcome).toEqual({ status: "failure", errors: ["post-validation error"] });
  });

  it("connected message with parsePrdOutcome defaults state to completed", () => {
    const store = useParsePrdStore();
    store.state = "idle";

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdOutcome: { status: "success" },
      },
      store,
    );

    // Even starting from idle, outcome forces completed
    expect(store.state).toBe("completed");
  });

  it("connected message with parsePrdSession.state uses server value", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-custom-state",
          agent: "claude",
          state: "stopping",
        },
      },
      store,
    );

    expect(store.state).toBe("stopping");
  });

  it("connected message with parsePrdSession without state defaults to active", () => {
    const store = useParsePrdStore();

    handleConnectedParsePrd(
      {
        type: "connected",
        parsePrdSession: {
          sessionId: "pprd-no-state",
          agent: "claude",
        },
      },
      store,
    );

    // Defaults to "active" via the ?? "active" fallback
    expect(store.state).toBe("active");
  });
});
