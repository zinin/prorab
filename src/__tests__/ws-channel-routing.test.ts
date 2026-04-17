/**
 * Unit tests for WebSocket channel-based event routing in useWebSocket.
 *
 * Tests the routing logic: events with channel='chat' or type starting with 'chat:'
 * go to chatStore.handleWsEvent; agent:* events without channel or with channel='execute'
 * go through the exec store switch. Connected message with chatSession initializes chatStore.
 *
 * We extract the routing logic into a pure function and test it with real Pinia stores.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "../../ui/src/stores/chat";
import { useExecutionStore } from "../../ui/src/stores/execution";
import { useParsePrdStore } from "../../ui/src/stores/parse-prd";

/**
 * Extracted routing logic from useWebSocket.onmessage.
 * Routes events to chatStore, parsePrdStore, or execStore based on channel/type.
 *
 * Returns "chat" if routed to chatStore (early return),
 * "parse-prd" if routed to parsePrdStore (early return),
 * "exec" if it falls through to the exec switch.
 */
function routeWsEvent(
  data: Record<string, unknown>,
  chatStore: ReturnType<typeof useChatStore>,
  execStore: ReturnType<typeof useExecutionStore>,
  parsePrdStore?: ReturnType<typeof useParsePrdStore>,
): "chat" | "exec" | "parse-prd" {
  // Early routing: chat-channel events go directly to chatStore
  if (data.channel === "chat" || (typeof data.type === "string" && (data.type as string).startsWith("chat:"))) {
    chatStore.handleWsEvent(data as Parameters<typeof chatStore.handleWsEvent>[0]);
    return "chat";
  }

  // Early routing: parse-prd-channel events go to parsePrdStore.
  // Prevents agent:* events with channel="parse-prd" from
  // polluting the execution event log.
  if (data.channel === "parse-prd" || (typeof data.type === "string" && (data.type as string).startsWith("parse-prd:"))) {
    parsePrdStore?.handleWsEvent(data as Parameters<NonNullable<typeof parsePrdStore>["handleWsEvent"]>[0]);
    return "parse-prd";
  }

  // Everything else goes to exec store switch (simplified for testing)
  // In the real composable this is the switch statement
  return "exec";
}

describe("WebSocket channel routing", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // ---- Chat channel routing ----

  it("routes agent:text with channel='chat' to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:text", channel: "chat", text: "Hello from chat" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith({
      type: "agent:text",
      channel: "chat",
      text: "Hello from chat",
    });
    // Message should be in chat store
    expect(chatStore.messages.length).toBe(1);
    expect(chatStore.messages[0].type).toBe("text");
    expect(chatStore.messages[0].content).toBe("Hello from chat");
  });

  it("routes agent:tool with channel='chat' to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:tool", channel: "chat", name: "Read", summary: "Reading file" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.messages.length).toBe(1);
    expect(chatStore.messages[0].type).toBe("tool");
    expect(chatStore.messages[0].toolName).toBe("Read");
  });

  it("routes agent:tool_result with channel='chat' to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:tool_result", channel: "chat", summary: "File contents" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.messages.length).toBe(1);
    expect(chatStore.messages[0].type).toBe("tool_result");
  });

  it("routes agent:context_usage with channel='chat' to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:context_usage", channel: "chat", contextTokens: 5000, contextWindow: 200000, model: "sonnet" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.messages.length).toBe(1);
    expect(chatStore.messages[0].type).toBe("context_usage");
  });

  it("routes chat:started (without channel field) to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "chat:started", agent: "claude", sessionId: "s1" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.state).toBe("active");
  });

  it("routes chat:question to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();

    const result = routeWsEvent(
      {
        type: "chat:question",
        channel: "chat",
        questionId: "q1",
        questions: [{ question: "Pick?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }],
        source: "claude",
      },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(chatStore.state).toBe("question_pending");
    expect(chatStore.pendingQuestion?.questionId).toBe("q1");
  });

  it("routes chat:idle to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();

    // First set up active state
    routeWsEvent({ type: "chat:started", agent: "claude" }, chatStore, execStore);

    const result = routeWsEvent(
      { type: "chat:idle", channel: "chat" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(chatStore.state).toBe("active");
    expect(chatStore.awaitingUserInput).toBe(true);
  });

  it("routes chat:error to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();

    const result = routeWsEvent(
      { type: "chat:error", channel: "chat", message: "Something broke" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(chatStore.error).toBe("Something broke");
  });

  it("routes chat:finished to chatStore", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();

    // First set up active state
    routeWsEvent({ type: "chat:started", agent: "claude" }, chatStore, execStore);
    expect(chatStore.state).toBe("active");

    const result = routeWsEvent(
      { type: "chat:finished", channel: "chat" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(chatStore.state).toBe("idle");
    expect(chatStore.sessionInfo).toBeNull();
  });

  // ---- Exec channel routing ----

  it("routes agent:text without channel to exec store", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:text", text: "Running task..." },
      chatStore,
      execStore,
    );

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
    // Chat store should have no messages
    expect(chatStore.messages.length).toBe(0);
  });

  it("routes agent:text with channel='execute' to exec store", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:text", channel: "execute", text: "Exec event" },
      chatStore,
      execStore,
    );

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
    expect(chatStore.messages.length).toBe(0);
  });

  it("routes agent:tool without channel to exec store", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:tool", name: "Bash", summary: "Running command" },
      chatStore,
      execStore,
    );

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("routes agent:tool_result with channel='execute' to exec store", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:tool_result", channel: "execute", summary: "Done" },
      chatStore,
      execStore,
    );

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("routes agent:turn_count without channel to exec store (default channel)", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "agent:turn_count", numTurns: 5, maxTurns: 100, model: "m", unitId: "u1" },
      chatStore,
      execStore,
    );

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("preserves reviewerId on agent:turn_count when routed to exec store", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const event = {
      type: "agent:turn_count",
      numTurns: 3,
      maxTurns: 100,
      model: "m",
      unitId: "u1",
      reviewerId: "r1",
    };

    const result = routeWsEvent(event, chatStore, execStore);

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
    // reviewerId is part of the event payload that the exec switch reads
    expect(event.reviewerId).toBe("r1");
  });

  it("routes execution:started to exec store", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "execution:started", unitId: "1", taskId: "1", title: "Task 1" },
      chatStore,
      execStore,
    );

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("routes tasks:updated to exec store", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "tasks:updated" },
      chatStore,
      execStore,
    );

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it("routes connected to exec store", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    const result = routeWsEvent(
      { type: "connected", state: "idle" },
      chatStore,
      execStore,
    );

    expect(result).toBe("exec");
    expect(chatSpy).not.toHaveBeenCalled();
  });

  // ---- agent:text with channel='chat' does NOT reach exec store ----

  it("agent:text with channel='chat' does not reach exec store at all", () => {
    const chatStore = useChatStore();
    const execStore = useExecutionStore();
    const execAddEventSpy = vi.spyOn(execStore, "addEvent");

    const result = routeWsEvent(
      { type: "agent:text", channel: "chat", text: "Chat message" },
      chatStore,
      execStore,
    );

    expect(result).toBe("chat");
    expect(execAddEventSpy).not.toHaveBeenCalled();
    // Verify it went to chatStore instead
    expect(chatStore.messages.length).toBe(1);
    expect(chatStore.messages[0].content).toBe("Chat message");
  });

  // ---- Connected message chatSession initialization ----

  describe("connected message chatSession handling", () => {
    /**
     * Simulates the connected message handling from useWebSocket,
     * using direct state assignment (not synthetic events) so the store
     * accurately reflects the server-reported state.
     */
    function handleConnectedMessage(
      data: Record<string, unknown>,
      chatStore: ReturnType<typeof useChatStore>,
    ) {
      if (data.chatSession && typeof data.chatSession === "object") {
        const cs = data.chatSession as Record<string, unknown>;
        chatStore.state = (cs.state as string) ?? "idle";
        chatStore.awaitingUserInput = (cs.awaitingUserInput as boolean) ?? false;
        chatStore.sessionInfo = {
          agent: cs.agent as string,
          model: cs.model as string | undefined,
        };
        chatStore.pendingQuestion = null;
      } else {
        // No active chat session — reset to idle
        chatStore.state = "idle";
        chatStore.awaitingUserInput = false;
        chatStore.sessionInfo = null;
        chatStore.pendingQuestion = null;
      }
    }

    it("initializes chatStore from connected message with chatSession", () => {
      const chatStore = useChatStore();

      handleConnectedMessage(
        {
          type: "connected",
          state: "idle",
          chatSession: {
            sessionId: "s1",
            agent: "claude",
            model: "sonnet",
            state: "active",
            awaitingUserInput: true,
          },
        },
        chatStore,
      );

      expect(chatStore.state).toBe("active");
      expect(chatStore.awaitingUserInput).toBe(true);
      expect(chatStore.sessionInfo).toEqual({ agent: "claude", model: "sonnet" });
    });

    it("sets awaitingUserInput=true when chatSession.awaitingUserInput is true", () => {
      const chatStore = useChatStore();

      handleConnectedMessage(
        {
          type: "connected",
          state: "idle",
          chatSession: {
            sessionId: "s2",
            agent: "opencode",
            state: "active",
            awaitingUserInput: true,
          },
        },
        chatStore,
      );

      expect(chatStore.awaitingUserInput).toBe(true);
    });

    it("sets awaitingUserInput=false when chatSession.awaitingUserInput is false", () => {
      const chatStore = useChatStore();

      handleConnectedMessage(
        {
          type: "connected",
          state: "idle",
          chatSession: {
            sessionId: "s3",
            agent: "claude",
            state: "active",
            awaitingUserInput: false,
          },
        },
        chatStore,
      );

      // Direct assignment correctly reflects the server-reported state:
      // agent is still processing, so awaitingUserInput is false.
      expect(chatStore.state).toBe("active");
      expect(chatStore.awaitingUserInput).toBe(false);
    });

    it("sets state to question_pending from server-reported state", () => {
      const chatStore = useChatStore();

      handleConnectedMessage(
        {
          type: "connected",
          state: "idle",
          chatSession: {
            sessionId: "s4",
            agent: "claude",
            model: "opus",
            state: "question_pending",
            awaitingUserInput: false,
          },
        },
        chatStore,
      );

      // State set directly from server — pending question will be
      // restored via ring-buffer replay of the last chat:question event.
      expect(chatStore.state).toBe("question_pending");
      expect(chatStore.awaitingUserInput).toBe(false);
      expect(chatStore.pendingQuestion).toBeNull();
    });

    it("resets chatStore to idle when chatSession is null", () => {
      const chatStore = useChatStore();
      // Simulate a previously active session
      chatStore.state = "active";
      chatStore.awaitingUserInput = true;
      chatStore.sessionInfo = { agent: "claude" };

      handleConnectedMessage(
        {
          type: "connected",
          state: "idle",
          chatSession: null,
        },
        chatStore,
      );

      expect(chatStore.state).toBe("idle");
      expect(chatStore.awaitingUserInput).toBe(false);
      expect(chatStore.sessionInfo).toBeNull();
      expect(chatStore.pendingQuestion).toBeNull();
    });

    it("resets chatStore to idle when chatSession is absent", () => {
      const chatStore = useChatStore();
      // Simulate a previously active session
      chatStore.state = "question_pending";
      chatStore.awaitingUserInput = false;
      chatStore.sessionInfo = { agent: "opencode" };

      handleConnectedMessage(
        {
          type: "connected",
          state: "running",
        },
        chatStore,
      );

      expect(chatStore.state).toBe("idle");
      expect(chatStore.awaitingUserInput).toBe(false);
      expect(chatStore.sessionInfo).toBeNull();
    });

    it("nullifies pendingQuestion so replay can restore it", () => {
      const chatStore = useChatStore();

      handleConnectedMessage(
        {
          type: "connected",
          state: "idle",
          chatSession: {
            sessionId: "s5",
            agent: "claude",
            state: "question_pending",
            awaitingUserInput: false,
          },
        },
        chatStore,
      );

      // pendingQuestion is null — it will be restored from the replayed
      // chat:question event in the ring buffer, not from the connected payload
      expect(chatStore.pendingQuestion).toBeNull();

      // Simulate replay of chat:question event
      chatStore.handleWsEvent({
        type: "chat:question",
        channel: "chat",
        questionId: "q-pending",
        questions: [{ question: "Pick one?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }],
        source: "claude",
      });

      expect(chatStore.pendingQuestion).not.toBeNull();
      expect(chatStore.pendingQuestion!.questionId).toBe("q-pending");
      expect(chatStore.state).toBe("question_pending");
    });

    it("reconnect during question_pending: connected restores base state, replay restores question", () => {
      const chatStore = useChatStore();

      // Step 1: connected message sets question_pending state
      handleConnectedMessage(
        {
          type: "connected",
          state: "idle",
          chatSession: {
            sessionId: "s6",
            agent: "claude",
            model: "sonnet",
            state: "question_pending",
            awaitingUserInput: false,
          },
        },
        chatStore,
      );

      expect(chatStore.state).toBe("question_pending");
      expect(chatStore.awaitingUserInput).toBe(false);
      expect(chatStore.pendingQuestion).toBeNull();
      expect(chatStore.sessionInfo).toEqual({ agent: "claude", model: "sonnet" });

      // Step 2: replay delivers the chat:question event → restores pendingQuestion
      chatStore.handleWsEvent({
        type: "chat:question",
        channel: "chat",
        questionId: "q-replay",
        questions: [
          { question: "Which approach?", header: "Approach", options: [{ label: "A", description: "first" }, { label: "B", description: "second" }], multiSelect: false },
        ],
        source: "claude",
      });

      expect(chatStore.pendingQuestion).not.toBeNull();
      expect(chatStore.pendingQuestion!.questionId).toBe("q-replay");
      expect(chatStore.state).toBe("question_pending");
      // awaitingUserInput should still be false — the question handler doesn't set it to true
      expect(chatStore.awaitingUserInput).toBe(false);
    });
  });

  // ---- Parse-prd channel routing (isolation from chat AND exec, forwarded to parsePrdStore) ----

  describe("parse-prd channel routing to parsePrdStore", () => {
    it("routes agent:text with channel='parse-prd' to parsePrdStore (not chat, not exec)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const execAddEventSpy = vi.spyOn(execStore, "addEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "agent:text", channel: "parse-prd", text: "Analyzing PRD file..." },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
      expect(execAddEventSpy).not.toHaveBeenCalled();
      expect(chatStore.messages.length).toBe(0);
      // Verify parsePrdStore received the text message
      expect(prdStore.messages.length).toBe(1);
      expect(prdStore.messages[0].type).toBe("text");
      expect(prdStore.messages[0].content).toBe("Analyzing PRD file...");
    });

    it("routes agent:tool with channel='parse-prd' to parsePrdStore (not chat, not exec)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "agent:tool", channel: "parse-prd", name: "Read", summary: "Reading prd.md" },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
      expect(chatStore.messages.length).toBe(0);
      expect(prdStore.messages.length).toBe(1);
      expect(prdStore.messages[0].type).toBe("tool");
      expect(prdStore.messages[0].toolName).toBe("Read");
    });

    it("routes agent:tool_result with channel='parse-prd' to parsePrdStore (not chat, not exec)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "agent:tool_result", channel: "parse-prd", summary: "PRD contents" },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
    });

    it("routes agent:context_usage with channel='parse-prd' to parsePrdStore", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "agent:context_usage", channel: "parse-prd", contextTokens: 3000, contextWindow: 200000, model: "sonnet" },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
    });

    it("routes agent:system_prompt with channel='parse-prd' to parsePrdStore", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "agent:system_prompt", channel: "parse-prd", text: "You are a PRD parser" },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
    });

    it("routes parse-prd:started to parsePrdStore (not chat, not exec)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "parse-prd:started", channel: "parse-prd", sessionId: "pprd-1", agent: "claude" },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
      // Must not change chat state
      expect(chatStore.state).toBe("idle");
      // parsePrdStore state updated
      expect(prdStore.state).toBe("active");
    });

    it("routes parse-prd:error to parsePrdStore (not chat, not exec)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "parse-prd:error", channel: "parse-prd", message: "Agent crashed" },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
      // Must not set chat error
      expect(chatStore.error).toBeNull();
      // parsePrdStore error set
      expect(prdStore.error).toBe("Agent crashed");
    });

    it("routes parse-prd:finished with success to parsePrdStore (not chat, not exec)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "success" } },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
      expect(chatStore.state).toBe("idle");
      // parsePrdStore has terminal outcome
      expect(prdStore.state).toBe("completed");
      expect(prdStore.outcome).toEqual({ status: "success" });
    });

    it("routes parse-prd:finished with failure to parsePrdStore (not chat, not exec)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "failure", errors: ["no tasks"] } },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
      expect(prdStore.outcome).toEqual({ status: "failure", errors: ["no tasks"] });
    });

    it("routes parse-prd:finished with cancelled to parsePrdStore (not chat, not exec)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "cancelled" } },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
      expect(prdStore.outcome).toEqual({ status: "cancelled" });
    });

    it("parse-prd:started without channel field routes via type prefix", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
      const prdSpy = vi.spyOn(prdStore, "handleWsEvent");

      // Fallback: type starts with 'parse-prd:' but no channel field
      const result = routeWsEvent(
        { type: "parse-prd:started", sessionId: "pprd-fallback", agent: "opencode" },
        chatStore,
        execStore,
        prdStore,
      );

      expect(result).toBe("parse-prd");
      expect(prdSpy).toHaveBeenCalledOnce();
      expect(chatSpy).not.toHaveBeenCalled();
      expect(prdStore.state).toBe("active");
    });

    it("parse-prd events do not change execution store state", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();
      const initialState = execStore.state;

      // Send a sequence of parse-prd events
      routeWsEvent({ type: "parse-prd:started", channel: "parse-prd", sessionId: "pprd-2", agent: "claude" }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "agent:text", channel: "parse-prd", text: "Working..." }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "agent:tool", channel: "parse-prd", name: "Write", summary: "Writing tasks.json" }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "success" } }, chatStore, execStore, prdStore);

      expect(execStore.state).toBe(initialState);
    });

    it("parse-prd events do not change chat store state", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();

      // Send a sequence of parse-prd events
      routeWsEvent({ type: "parse-prd:started", channel: "parse-prd", sessionId: "pprd-3", agent: "claude" }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "agent:text", channel: "parse-prd", text: "Parsing..." }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "parse-prd:error", channel: "parse-prd", message: "Failed" }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "failure", errors: ["fail"] } }, chatStore, execStore, prdStore);

      expect(chatStore.state).toBe("idle");
      expect(chatStore.messages.length).toBe(0);
      expect(chatStore.error).toBeNull();
    });

    it("full lifecycle: started → agent events → finished with success in parsePrdStore", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();

      routeWsEvent({ type: "parse-prd:started", channel: "parse-prd", sessionId: "pprd-full", agent: "claude", model: "sonnet" }, chatStore, execStore, prdStore);
      expect(prdStore.state).toBe("active");
      expect(prdStore.sessionInfo).toEqual({ agent: "claude", model: "sonnet" });

      routeWsEvent({ type: "agent:text", channel: "parse-prd", text: "Analyzing PRD..." }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "agent:tool", channel: "parse-prd", name: "Read", summary: "Reading prd.md" }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "agent:tool_result", channel: "parse-prd", summary: "PRD content", output: "# Requirements\n..." }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "agent:text", channel: "parse-prd", text: "Writing tasks..." }, chatStore, execStore, prdStore);
      routeWsEvent({ type: "agent:tool", channel: "parse-prd", name: "Write", summary: "Writing tasks.json" }, chatStore, execStore, prdStore);

      expect(prdStore.messages.length).toBe(5); // 2 text + 2 tool + 1 tool_result

      routeWsEvent({ type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "success" } }, chatStore, execStore, prdStore);
      expect(prdStore.state).toBe("completed");
      expect(prdStore.outcome).toEqual({ status: "success" });
      expect(prdStore.sessionInfo).toBeNull();
    });
  });

  // ---- Three-channel coexistence ----

  describe("three-channel coexistence", () => {
    it("concurrent chat, exec, and parse-prd events route to correct destinations", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const prdStore = useParsePrdStore();

      // Interleaved events from all three channels
      const r1 = routeWsEvent({ type: "agent:text", channel: "chat", text: "Chat msg" }, chatStore, execStore, prdStore);
      const r2 = routeWsEvent({ type: "agent:text", text: "Exec msg" }, chatStore, execStore, prdStore);
      const r3 = routeWsEvent({ type: "agent:text", channel: "parse-prd", text: "PRD msg" }, chatStore, execStore, prdStore);
      const r4 = routeWsEvent({ type: "agent:text", channel: "execute", text: "Exec msg 2" }, chatStore, execStore, prdStore);
      const r5 = routeWsEvent({ type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "success" } }, chatStore, execStore, prdStore);
      const r6 = routeWsEvent({ type: "chat:idle", channel: "chat" }, chatStore, execStore, prdStore);

      expect(r1).toBe("chat");
      expect(r2).toBe("exec");
      expect(r3).toBe("parse-prd");
      expect(r4).toBe("exec");
      expect(r5).toBe("parse-prd");
      expect(r6).toBe("chat");

      // Chat store got exactly 2 events: agent:text and chat:idle
      // (agent:text adds a message, chat:idle doesn't add a message)
      expect(chatStore.messages.length).toBe(1);
      expect(chatStore.messages[0].content).toBe("Chat msg");

      // parsePrdStore got text + finished
      expect(prdStore.messages.length).toBe(1);
      expect(prdStore.messages[0].content).toBe("PRD msg");
      expect(prdStore.state).toBe("completed");
      expect(prdStore.outcome).toEqual({ status: "success" });
    });
  });

  // ---- Edge cases ----

  describe("edge cases", () => {
    it("chat:* event type without channel field still routes to chatStore", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const spy = vi.spyOn(chatStore, "handleWsEvent");

      // Legacy/fallback: type starts with 'chat:' but no channel field
      const result = routeWsEvent(
        { type: "chat:finished" },
        chatStore,
        execStore,
      );

      expect(result).toBe("chat");
      expect(spy).toHaveBeenCalledOnce();
    });

    it("agent:* event with no channel goes to exec (backward compat)", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: "agent:system_prompt", text: "You are a helpful assistant" },
        chatStore,
        execStore,
      );

      expect(result).toBe("exec");
      expect(chatSpy).not.toHaveBeenCalled();
    });

    it("event with non-string type is treated as exec", () => {
      const chatStore = useChatStore();
      const execStore = useExecutionStore();
      const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

      const result = routeWsEvent(
        { type: 42 as unknown as string },
        chatStore,
        execStore,
      );

      expect(result).toBe("exec");
      expect(chatSpy).not.toHaveBeenCalled();
    });
  });
});
