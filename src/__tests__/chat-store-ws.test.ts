/**
 * Unit tests for chat store handleWsEvent method.
 *
 * Covers: chat:question sets pendingQuestion with source,
 * chat:error adds error message without resetting session,
 * agent:text adds text message, buffer trims at >1000 elements.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "../../ui/src/stores/chat";
import type { ChatWsEvent } from "../../ui/src/stores/chat";

describe("chat store — handleWsEvent", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // ---- chat:started ----

  it("chat:started sets state=active, awaitingUserInput=true, sessionInfo", () => {
    const store = useChatStore();
    store.handleWsEvent({
      type: "chat:started",
      channel: "chat",
      sessionId: "s1",
      agent: "claude",
      model: "sonnet",
    });

    expect(store.state).toBe("active");
    expect(store.awaitingUserInput).toBe(true);
    expect(store.sessionInfo).toEqual({ agent: "claude", model: "sonnet" });
  });

  // ---- chat:question ----

  it("chat:question sets pendingQuestion with source and awaitingUserInput=false", () => {
    const store = useChatStore();
    // Simulate active session
    store.handleWsEvent({ type: "chat:started", channel: "chat", sessionId: "s1", agent: "claude" });
    expect(store.awaitingUserInput).toBe(true);

    const questions = [
      { question: "Which approach?", header: "Approach", options: [{ label: "A", description: "Option A" }], multiSelect: false },
    ];

    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q1",
      questions,
      source: "claude",
    });

    expect(store.state).toBe("question_pending");
    expect(store.awaitingUserInput).toBe(false);
    expect(store.pendingQuestion).toEqual({
      questionId: "q1",
      questions,
      source: "claude",
    });
  });

  it("chat:question adds a question message to the buffer", () => {
    const store = useChatStore();
    const questions = [
      { question: "Pick one", header: "Choice", options: [{ label: "X", description: "desc" }], multiSelect: false },
    ];

    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q2",
      questions,
      source: "opencode",
    });

    expect(store.messages.length).toBe(1);
    const msg = store.messages[0];
    expect(msg.type).toBe("question");
    expect(msg.questionId).toBe("q2");
    expect(msg.questions).toEqual(questions);
  });

  // ---- chat:idle ----

  it("chat:idle resets to active with awaitingUserInput=true and clears pendingQuestion", () => {
    const store = useChatStore();
    // Simulate question_pending state
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q1",
      questions: [],
      source: "claude",
    });
    expect(store.state).toBe("question_pending");

    store.handleWsEvent({ type: "chat:idle", channel: "chat" });

    expect(store.state).toBe("active");
    expect(store.awaitingUserInput).toBe(true);
    expect(store.pendingQuestion).toBeNull();
  });

  // ---- chat:error ----

  it("chat:error adds error message and preserves session until chat:finished", () => {
    const store = useChatStore();
    // Set up active session
    store.handleWsEvent({ type: "chat:started", channel: "chat", sessionId: "s1", agent: "claude", model: "opus" });
    expect(store.sessionInfo).not.toBeNull();

    store.handleWsEvent({
      type: "chat:error",
      channel: "chat",
      message: "Something went wrong",
    });

    // Error message added
    expect(store.messages.length).toBe(1);
    expect(store.messages[0].type).toBe("error");
    expect(store.messages[0].content).toBe("Something went wrong");

    // Error stored
    expect(store.error).toBe("Something went wrong");

    // Session NOT cleared — that only happens on chat:finished
    expect(store.sessionInfo).not.toBeNull();
    expect(store.state).not.toBe("idle");
  });

  it("chat:error followed by chat:finished clears session but preserves error", () => {
    const store = useChatStore();
    store.handleWsEvent({ type: "chat:started", channel: "chat", sessionId: "s1", agent: "claude" });

    store.handleWsEvent({ type: "chat:error", channel: "chat", message: "Boom" });
    expect(store.sessionInfo).not.toBeNull();
    expect(store.error).toBe("Boom");

    store.handleWsEvent({ type: "chat:finished", channel: "chat" });
    expect(store.state).toBe("idle");
    expect(store.sessionInfo).toBeNull();
    expect(store.pendingQuestion).toBeNull();
    expect(store.awaitingUserInput).toBe(false);
    // Error is preserved so user can see what went wrong after session ends
    expect(store.error).toBe("Boom");
  });

  // ---- chat:finished ----

  it("chat:finished resets session state but preserves error for user visibility", () => {
    const store = useChatStore();
    store.handleWsEvent({ type: "chat:started", channel: "chat", sessionId: "s1", agent: "opencode" });
    store.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q1",
      questions: [],
      source: "opencode",
    });
    // Set an error to verify it persists after chat:finished
    store.handleWsEvent({ type: "chat:error", channel: "chat", message: "test error" });
    expect(store.error).toBe("test error");

    store.handleWsEvent({ type: "chat:finished", channel: "chat" });

    expect(store.state).toBe("idle");
    expect(store.awaitingUserInput).toBe(false);
    expect(store.pendingQuestion).toBeNull();
    expect(store.sessionInfo).toBeNull();
    // Error persists after chat:finished so user can see what went wrong
    expect(store.error).toBe("test error");
  });

  it("error is cleared when a new chat session starts", () => {
    const store = useChatStore();
    // Simulate error from previous session
    store.handleWsEvent({ type: "chat:started", channel: "chat", sessionId: "s1", agent: "claude" });
    store.handleWsEvent({ type: "chat:error", channel: "chat", message: "previous error" });
    store.handleWsEvent({ type: "chat:finished", channel: "chat" });
    expect(store.error).toBe("previous error");

    // Starting a new session via startChat would clear it (tested via store action),
    // but here we verify that $reset also clears it
    store.$reset();
    expect(store.error).toBeNull();
  });

  // ---- agent:text ----

  it("agent:text adds a message of type text", () => {
    const store = useChatStore();

    store.handleWsEvent({
      type: "agent:text",
      channel: "chat",
      text: "Hello from the agent",
    });

    expect(store.messages.length).toBe(1);
    const msg = store.messages[0];
    expect(msg.type).toBe("text");
    expect(msg.content).toBe("Hello from the agent");
    expect(msg.id).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  // ---- agent:tool ----

  it("agent:tool adds a message with toolName", () => {
    const store = useChatStore();

    store.handleWsEvent({
      type: "agent:tool",
      channel: "chat",
      name: "Read",
      summary: "Reading file.ts",
      input: { file_path: "file.ts" },
    });

    expect(store.messages.length).toBe(1);
    const msg = store.messages[0];
    expect(msg.type).toBe("tool");
    expect(msg.toolName).toBe("Read");
    expect(msg.content).toBe(JSON.stringify({ file_path: "file.ts" }, null, 2));
  });

  it("agent:tool without input stores empty content", () => {
    const store = useChatStore();

    store.handleWsEvent({
      type: "agent:tool",
      channel: "chat",
      name: "Bash",
      summary: "Running command",
    });

    expect(store.messages.length).toBe(1);
    expect(store.messages[0].content).toBe("");
  });

  // ---- agent:tool_result ----

  it("agent:tool_result adds a tool_result message with output", () => {
    const store = useChatStore();

    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "chat",
      summary: "File contents returned",
      output: "const x = 1;",
    });

    expect(store.messages.length).toBe(1);
    expect(store.messages[0].type).toBe("tool_result");
    expect(store.messages[0].content).toBe("const x = 1;");
  });

  it("agent:tool_result falls back to summary when output is absent", () => {
    const store = useChatStore();

    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "chat",
      summary: "File contents returned",
    });

    expect(store.messages.length).toBe(1);
    expect(store.messages[0].content).toBe("File contents returned");
  });

  // ---- agent:context_usage ----

  it("agent:context_usage adds a context_usage message with JSON content", () => {
    const store = useChatStore();

    store.handleWsEvent({
      type: "agent:context_usage",
      channel: "chat",
      contextTokens: 5000,
      contextWindow: 200000,
      model: "sonnet",
    });

    expect(store.messages.length).toBe(1);
    const msg = store.messages[0];
    expect(msg.type).toBe("context_usage");
    const parsed = JSON.parse(msg.content);
    expect(parsed).toEqual({
      contextTokens: 5000,
      contextWindow: 200000,
      model: "sonnet",
    });
  });

  // ---- Buffer trimming ----

  it("trims message buffer when exceeding 1000 elements", () => {
    const store = useChatStore();

    // Fill exactly 1000 messages — use tool events (each creates a separate message,
    // unlike agent:text which aggregates consecutive events into one message)
    for (let i = 0; i < 1000; i++) {
      store.handleWsEvent({
        type: "agent:tool",
        channel: "chat",
        name: `tool-${i}`,
        summary: `tool-${i}`,
      });
    }
    expect(store.messages.length).toBe(1000);

    // Add one more — triggers trim to last 500
    store.handleWsEvent({
      type: "agent:tool",
      channel: "chat",
      name: "overflow",
      summary: "overflow",
    });

    expect(store.messages.length).toBe(500);
    // The last message should be "overflow"
    expect(store.messages[store.messages.length - 1].toolName).toBe("overflow");
  });

  // ---- Channel filtering ----

  it("ignores agent:* events without channel='chat'", () => {
    const store = useChatStore();

    // No channel — should be ignored
    store.handleWsEvent({ type: "agent:text", text: "no channel" });
    expect(store.messages.length).toBe(0);

    // Execution channel — should be ignored
    store.handleWsEvent({ type: "agent:text", channel: "execute", text: "exec event" });
    expect(store.messages.length).toBe(0);

    // Chat channel — should be processed
    store.handleWsEvent({ type: "agent:text", channel: "chat", text: "chat event" });
    expect(store.messages.length).toBe(1);
    expect(store.messages[0].content).toBe("chat event");
  });

  it("processes chat:* events regardless of channel field", () => {
    const store = useChatStore();

    // chat:* events don't need channel filtering
    store.handleWsEvent({ type: "chat:started", agent: "claude" });
    expect(store.state).toBe("active");
  });

  // ---- Unknown events ----

  it("ignores unknown event types without error", () => {
    const store = useChatStore();
    store.handleWsEvent({ type: "execution:started" } as unknown as ChatWsEvent);
    expect(store.messages.length).toBe(0);
    expect(store.state).toBe("idle");
  });

  // ---- Message ID uniqueness ----

  it("generates unique message IDs", () => {
    const store = useChatStore();

    // Use tool events — consecutive agent:text events are aggregated into one message
    store.handleWsEvent({ type: "agent:tool", channel: "chat", name: "Read", summary: "Read" });
    store.handleWsEvent({ type: "agent:tool", channel: "chat", name: "Write", summary: "Write" });

    expect(store.messages[0].id).not.toBe(store.messages[1].id);
  });

  it("aggregates consecutive agent:text events into one message", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "agent:text", channel: "chat", text: "Hello " });
    store.handleWsEvent({ type: "agent:text", channel: "chat", text: "world!" });

    expect(store.messages.length).toBe(1);
    expect(store.messages[0].content).toBe("Hello world!");
  });

  it("creates new text message after non-text event", () => {
    const store = useChatStore();

    store.handleWsEvent({ type: "agent:text", channel: "chat", text: "first" });
    store.handleWsEvent({ type: "agent:tool", channel: "chat", name: "Read", summary: "Read" });
    store.handleWsEvent({ type: "agent:text", channel: "chat", text: "second" });

    expect(store.messages.length).toBe(3);
    expect(store.messages[0].content).toBe("first");
    expect(store.messages[2].content).toBe("second");
  });
});
