/**
 * Edge-case tests for the frontend chat store:
 * - WS reconnect: replay restores pending question from ring buffer events
 * - Abort during question: state cleanup after stop
 * - Browser refresh: connected message + replay restores state correctly
 * - Deferred snapshot re-application guards against stale replay overwrite
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "../../ui/src/stores/chat";
import type { ChatWsEvent } from "../../ui/src/stores/chat";

describe("chat store edge cases — WS reconnect replay", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("replaying ring buffer events restores chat:question as pending question", () => {
    const store = useChatStore();

    // Simulate replay of ring buffer events after reconnect
    store.handleWsEvent({
      type: "chat:started",
      channel: "chat",
      sessionId: "s-replay",
      agent: "claude",
      model: "sonnet",
    });

    store.handleWsEvent({
      type: "agent:text",
      channel: "chat",
      text: "Let me help you with that.",
    });

    store.handleWsEvent({
      type: "chat:idle",
      channel: "chat",
    });

    store.handleWsEvent({
      type: "agent:text",
      channel: "chat",
      text: "I need some more information.",
    });

    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-replay-restore",
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
    });

    // After replay, state should be question_pending with the question available
    expect(store.state).toBe("question_pending");
    expect(store.awaitingUserInput).toBe(false);
    expect(store.pendingQuestion).not.toBeNull();
    expect(store.pendingQuestion!.questionId).toBe("q-replay-restore");
    expect(store.pendingQuestion!.questions).toHaveLength(1);
    expect(store.pendingQuestion!.questions[0].question).toBe("Which framework?");
    expect(store.pendingQuestion!.source).toBe("claude");

    // Messages should be populated from replay (text + text + question = 3)
    // chat:started and chat:idle are lifecycle events that don't add messages
    expect(store.messages.length).toBe(3);
    const questionMsg = store.messages.find(m => m.type === "question");
    expect(questionMsg).toBeDefined();
    expect(questionMsg!.questionId).toBe("q-replay-restore");
  });

  it("replayed idle after answered question restores active + awaitingUserInput", () => {
    const store = useChatStore();

    // Simulate: question → answered → idle replay
    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-old",
      questions: [{ question: "?", header: "H", options: [], multiSelect: false }],
      source: "claude",
    });
    store.handleWsEvent({ type: "chat:idle", channel: "chat" });

    // After idle, question should be cleared
    expect(store.state).toBe("active");
    expect(store.awaitingUserInput).toBe(true);
    expect(store.pendingQuestion).toBeNull();
  });

  it("replaying multiple question/idle cycles restores only the last pending question", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });

    // First question + answer
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-1",
      questions: [{ question: "First?", header: "H", options: [], multiSelect: false }],
      source: "claude",
    });
    store.handleWsEvent({ type: "chat:idle", channel: "chat" }); // answered

    // Second question (still pending)
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-2",
      questions: [{ question: "Second?", header: "H2", options: [], multiSelect: false }],
      source: "claude",
    });

    expect(store.state).toBe("question_pending");
    expect(store.pendingQuestion!.questionId).toBe("q-2");
    expect(store.pendingQuestion!.questions[0].question).toBe("Second?");
  });

  it("clearMessages resets message buffer but not session state", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({ type: "agent:text", channel: "chat", text: "Hello!" });
    // Use a tool event to break text aggregation, creating a second message
    store.handleWsEvent({ type: "agent:tool", channel: "chat", name: "Read", summary: "Read" });

    expect(store.messages).toHaveLength(2);

    store.clearMessages();
    expect(store.messages).toHaveLength(0);

    // State should remain
    expect(store.state).toBe("active");
    expect(store.awaitingUserInput).toBe(true);
  });
});

describe("chat store edge cases — abort during question", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("chat:finished during question_pending resets everything to idle", () => {
    const store = useChatStore();

    // Set up an active chat session with a pending question
    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-abort",
      questions: [{ question: "Pick?", header: "H", options: [], multiSelect: false }],
      source: "claude",
    });

    expect(store.state).toBe("question_pending");
    expect(store.pendingQuestion).not.toBeNull();

    // Server sends chat:finished (abort)
    store.handleWsEvent({ type: "chat:finished", channel: "chat" });

    // Everything should be cleaned up
    expect(store.state).toBe("idle");
    expect(store.awaitingUserInput).toBe(false);
    expect(store.pendingQuestion).toBeNull();
    expect(store.sessionInfo).toBeNull();
  });

  it("chat:error followed by chat:finished during question_pending cleans up correctly", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-error-abort",
      questions: [{ question: "Pick?", header: "H", options: [], multiSelect: false }],
      source: "claude",
    });

    expect(store.state).toBe("question_pending");

    // Error + finished (abort with error)
    store.handleWsEvent({
      type: "chat:error",
      channel: "chat",
      message: "Agent crashed during question",
    });
    // Error is set by chat:error
    expect(store.error).toBe("Agent crashed during question");

    store.handleWsEvent({ type: "chat:finished", channel: "chat" });

    expect(store.state).toBe("idle");
    expect(store.pendingQuestion).toBeNull();
    // Error is preserved after chat:finished so user can see what went wrong
    // (error is also in the message buffer as a message of type "error")
    expect(store.error).toBe("Agent crashed during question");

    // Error message should be in the message buffer
    const errorMsg = store.messages.find(m => m.type === "error");
    expect(errorMsg).toBeDefined();
    expect(errorMsg!.content).toBe("Agent crashed during question");
  });

  it("chat:finished without prior error does not set error state", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({ type: "agent:text", channel: "chat", text: "Working..." });

    // Clean stop — only finished, no error
    store.handleWsEvent({ type: "chat:finished", channel: "chat" });

    expect(store.state).toBe("idle");
    expect(store.error).toBeNull();
  });

  it("canReplyQuestion is false after abort", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-check",
      questions: [{ question: "?", header: "H", options: [], multiSelect: false }],
      source: "claude",
    });

    expect(store.canReplyQuestion).toBe(true);

    store.handleWsEvent({ type: "chat:finished", channel: "chat" });

    expect(store.canReplyQuestion).toBe(false);
  });

  it("canSendMessage is false after abort", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({ type: "chat:idle", channel: "chat" });

    expect(store.canSendMessage).toBe(true);

    store.handleWsEvent({ type: "chat:finished", channel: "chat" });

    expect(store.canSendMessage).toBe(false);
  });
});

describe("chat store edge cases — browser refresh recovery", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("direct state assignment (connected message) + replay restores question_pending", () => {
    const store = useChatStore();

    // Simulate what useWebSocket does on 'connected' message with chatSession
    store.clearMessages();
    store.state = "question_pending";
    store.awaitingUserInput = false;
    store.sessionInfo = { agent: "claude", model: "sonnet" };
    store.pendingQuestion = null; // Will be restored from replay

    // Simulate ring buffer replay
    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude", model: "sonnet" });
    store.handleWsEvent({ type: "agent:text", channel: "chat", text: "Hello!" });
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-refreshed",
      questions: [{ question: "Framework?", header: "FW", options: [], multiSelect: false }],
      source: "claude",
    });

    // After replay, pending question should be restored
    expect(store.pendingQuestion).not.toBeNull();
    expect(store.pendingQuestion!.questionId).toBe("q-refreshed");
    expect(store.state).toBe("question_pending");
  });

  it("without rehydrating flag, replay chat:idle overrides awaitingUserInput", () => {
    const store = useChatStore();

    // Simulate connected message setting state (no rehydrating flag)
    store.state = "active";
    store.awaitingUserInput = false; // Server says driver is busy
    store.sessionInfo = { agent: "claude" };

    // Without rehydrating flag, replay idle overwrites the state.
    // This is why useWebSocket sets rehydrating=true and waits for
    // replay:complete sentinel from the server before clearing it.
    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({ type: "chat:idle", channel: "chat" });

    expect(store.state).toBe("active");
    expect(store.awaitingUserInput).toBe(true); // Overwritten by replay idle
  });

  it("$reset clears all state back to initial (full cleanup after broken state)", () => {
    const store = useChatStore();

    // Simulate a broken state
    store.state = "question_pending";
    store.awaitingUserInput = false;
    store.sessionInfo = { agent: "claude" };
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-stale",
      questions: [{ question: "?", header: "H", options: [], multiSelect: false }],
      source: "claude",
    });

    // Reset everything
    store.$reset();

    expect(store.state).toBe("idle");
    expect(store.awaitingUserInput).toBe(false);
    expect(store.messages).toHaveLength(0);
    expect(store.pendingQuestion).toBeNull();
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
    expect(store.hasSession).toBe(false);
    expect(store.canSendMessage).toBe(false);
    expect(store.canReplyQuestion).toBe(false);
  });

  it("connected message with no chatSession resets store to idle", () => {
    const store = useChatStore();

    // Simulate an active chat state before reconnect
    store.state = "active";
    store.awaitingUserInput = true;
    store.sessionInfo = { agent: "claude" };

    // Simulate what useWebSocket does when connected message has no chatSession
    store.state = "idle";
    store.awaitingUserInput = false;
    store.sessionInfo = null;
    store.pendingQuestion = null;

    expect(store.state).toBe("idle");
    expect(store.hasSession).toBe(false);
    expect(store.canSendMessage).toBe(false);
  });
});

describe("chat store edge cases — rehydrating flag guards state during replay", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("chat:idle during rehydration does NOT overwrite awaitingUserInput", () => {
    const store = useChatStore();

    // Simulate connected message: server says agent is working
    store.clearMessages();
    store.state = "active";
    store.awaitingUserInput = false;
    store.sessionInfo = { agent: "claude" };
    store.pendingQuestion = null;
    store.setRehydrating(true);

    // Replay contains chat:idle from a previous turn
    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({ type: "chat:idle", channel: "chat" });

    // State must remain as set by connected message
    expect(store.awaitingUserInput).toBe(false);
    expect(store.state).toBe("active");
  });

  it("chat:started during rehydration does NOT overwrite state", () => {
    const store = useChatStore();

    store.clearMessages();
    store.state = "question_pending";
    store.awaitingUserInput = false;
    store.sessionInfo = { agent: "claude" };
    store.setRehydrating(true);

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });

    expect(store.state).toBe("question_pending");
    expect(store.awaitingUserInput).toBe(false);
  });

  it("chat:question during rehydration sets pendingQuestion but does NOT overwrite state", () => {
    const store = useChatStore();

    store.clearMessages();
    store.state = "question_pending";
    store.awaitingUserInput = false;
    store.sessionInfo = { agent: "claude" };
    store.setRehydrating(true);

    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q-rehydrate",
      questions: [{ question: "Pick?", header: "H", options: [], multiSelect: false }],
      source: "claude",
    });

    // pendingQuestion IS restored (needed for UI)
    expect(store.pendingQuestion).not.toBeNull();
    expect(store.pendingQuestion!.questionId).toBe("q-rehydrate");
    // But state/awaitingUserInput remain from connected snapshot
    expect(store.state).toBe("question_pending");
    expect(store.awaitingUserInput).toBe(false);
  });

  it("after setRehydrating(false), chat:idle works normally", () => {
    const store = useChatStore();

    store.clearMessages();
    store.state = "active";
    store.awaitingUserInput = false;
    store.sessionInfo = { agent: "claude" };
    store.setRehydrating(true);

    // Replay done
    store.handleWsEvent({ type: "chat:idle", channel: "chat" });
    expect(store.awaitingUserInput).toBe(false); // blocked

    store.setRehydrating(false);

    // Now a live chat:idle should work
    store.handleWsEvent({ type: "chat:idle", channel: "chat" });
    expect(store.awaitingUserInput).toBe(true); // allowed
  });
});

describe("chat store edge cases — channel routing", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("agent:text with channel='execute' is ignored by chat store", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });

    // This is an execution channel event — should be ignored
    store.handleWsEvent({
      type: "agent:text",
      channel: "execute",
      text: "Execution output — should not appear in chat",
    } as any);

    // Only the started event should produce no messages (it's a lifecycle event)
    // No text messages should be added
    const textMsgs = store.messages.filter(m => m.type === "text");
    expect(textMsgs).toHaveLength(0);
  });

  it("agent:text with channel='chat' is added to messages", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });
    store.handleWsEvent({
      type: "agent:text",
      channel: "chat",
      text: "Chat output — should appear",
    });

    const textMsgs = store.messages.filter(m => m.type === "text");
    expect(textMsgs).toHaveLength(1);
    expect(textMsgs[0].content).toBe("Chat output — should appear");
  });

  it("agent:text without channel is ignored by chat store", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "chat:started", channel: "chat", agent: "claude" });

    // No channel — should be ignored (considered execution by default)
    store.handleWsEvent({
      type: "agent:text",
      text: "No channel output",
    } as any);

    const textMsgs = store.messages.filter(m => m.type === "text");
    expect(textMsgs).toHaveLength(0);
  });
});
