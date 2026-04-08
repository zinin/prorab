import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "../../ui/src/stores/chat";
import type { ChatMessage, ChatState, SessionInfo, PendingQuestion } from "../../ui/src/stores/chat";

// --- Mock fetch helper ---

function mockFetchOk(data: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockFetchError(status: number, error: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
  });
}

// Default chat start options used across tests
const startOpts = {
  agent: "claude" as const,
  model: "sonnet",
  systemPrompt: "You are a test assistant",
};

describe("useChatStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("has correct initial state values", () => {
    const store = useChatStore();

    expect(store.state).toBe("idle" satisfies ChatState);
    expect(store.awaitingUserInput).toBe(false);
    expect(store.messages).toEqual([]);
    expect(store.pendingQuestion).toBeNull();
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
  });

  it("has correct initial computed values", () => {
    const store = useChatStore();

    expect(store.lastMessage).toBeNull();
    expect(store.hasSession).toBe(false);
    expect(store.canSendMessage).toBe(false);
    expect(store.canReplyQuestion).toBe(false);
  });

  it("lastMessage returns the last message when messages exist", () => {
    const store = useChatStore();
    const msg: ChatMessage = {
      id: "test-1",
      type: "text",
      content: "hello",
      timestamp: Date.now(),
    };
    store.messages.push(msg);

    expect(store.lastMessage).toEqual(msg);
  });

  it("lastMessage updates reactively as messages are added", () => {
    const store = useChatStore();

    const msg1: ChatMessage = {
      id: "test-1",
      type: "user",
      content: "first",
      timestamp: 1000,
    };
    const msg2: ChatMessage = {
      id: "test-2",
      type: "text",
      content: "second",
      timestamp: 2000,
    };

    store.messages.push(msg1);
    expect(store.lastMessage?.id).toBe("test-1");

    store.messages.push(msg2);
    expect(store.lastMessage?.id).toBe("test-2");
  });

  it("hasSession is true when state is not idle", () => {
    const store = useChatStore();
    store.state = "active";
    expect(store.hasSession).toBe(true);

    store.state = "question_pending";
    expect(store.hasSession).toBe(true);

    store.state = "stopping";
    expect(store.hasSession).toBe(true);

    store.state = "idle";
    expect(store.hasSession).toBe(false);
  });

  it("canSendMessage requires active state and awaitingUserInput", () => {
    const store = useChatStore();

    // Not active, not awaiting — false
    expect(store.canSendMessage).toBe(false);

    // Active but not awaiting — false
    store.state = "active";
    expect(store.canSendMessage).toBe(false);

    // Active and awaiting — true
    store.awaitingUserInput = true;
    expect(store.canSendMessage).toBe(true);

    // Wrong state — false even if awaiting
    store.state = "question_pending";
    expect(store.canSendMessage).toBe(false);
  });

  it("canReplyQuestion requires question_pending state and pendingQuestion set", () => {
    const store = useChatStore();

    // Idle, no question — false
    expect(store.canReplyQuestion).toBe(false);

    // question_pending but no pending question object — false
    store.state = "question_pending";
    expect(store.canReplyQuestion).toBe(false);

    // question_pending with pending question — true
    store.pendingQuestion = {
      questionId: "q1",
      questions: [{ question: "Pick?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }],
      source: "claude",
    };
    expect(store.canReplyQuestion).toBe(true);

    // Wrong state — false even with pending question
    store.state = "active";
    expect(store.canReplyQuestion).toBe(false);
  });

  it("$reset restores all state to initial values", () => {
    const store = useChatStore();

    // Mutate everything
    store.state = "active";
    store.awaitingUserInput = true;
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.pendingQuestion = { questionId: "q1", questions: [], source: "claude" };
    store.sessionInfo = { agent: "claude", model: "opus" };
    store.error = "some error";

    store.$reset();

    expect(store.state).toBe("idle");
    expect(store.awaitingUserInput).toBe(false);
    expect(store.messages).toEqual([]);
    expect(store.pendingQuestion).toBeNull();
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
    expect(store.lastMessage).toBeNull();
  });

  it("clearMessages empties the message buffer", () => {
    const store = useChatStore();
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.messages.push({ id: "m2", type: "user", content: "world", timestamp: 2 });

    expect(store.messages).toHaveLength(2);
    store.clearMessages();
    expect(store.messages).toEqual([]);
  });

  it("clearChat resets entire state like $reset", () => {
    const store = useChatStore();

    store.state = "active";
    store.awaitingUserInput = true;
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.pendingQuestion = { questionId: "q1", questions: [], source: "claude" };
    store.sessionInfo = { agent: "claude", model: "opus" };
    store.error = "something broke";

    store.clearChat();

    expect(store.state).toBe("idle");
    expect(store.awaitingUserInput).toBe(false);
    expect(store.messages).toEqual([]);
    expect(store.pendingQuestion).toBeNull();
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
  });
});

// --- API action tests with mock fetch ---

describe("useChatStore API actions", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // --- startChat ---

  describe("startChat", () => {
    it("sets state=active and awaitingUserInput=true on success", async () => {
      globalThis.fetch = mockFetchOk({ started: true, sessionId: "s1" });
      const store = useChatStore();

      await store.startChat(startOpts);

      expect(store.state).toBe("active");
      expect(store.awaitingUserInput).toBe(true);
      expect(store.error).toBeNull();
    });

    it("stores sessionInfo from options", async () => {
      globalThis.fetch = mockFetchOk({ started: true });
      const store = useChatStore();

      await store.startChat({ agent: "opencode", model: "gpt-4", variant: "high", systemPrompt: "test" });

      expect(store.sessionInfo).toEqual({ agent: "opencode", model: "gpt-4", variant: "high" });
    });

    it("POSTs correct payload to /api/chat/start", async () => {
      const mockFn = mockFetchOk({ started: true });
      globalThis.fetch = mockFn;
      const store = useChatStore();

      await store.startChat(startOpts);

      expect(mockFn).toHaveBeenCalledOnce();
      const [url, init] = mockFn.mock.calls[0];
      expect(url).toBe("/api/chat/start");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(startOpts);
    });

    it("clears previous messages and error before starting", async () => {
      globalThis.fetch = mockFetchOk({ started: true });
      const store = useChatStore();

      // Simulate previous session state
      store.messages.push({ id: "old", type: "text", content: "stale", timestamp: 1 });
      store.error = "old error";
      store.pendingQuestion = { questionId: "q1", questions: [], source: "claude" };

      await store.startChat(startOpts);

      // System prompt is added immediately during startChat
      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].type).toBe("system_prompt");
      expect(store.messages[0].content).toBe(startOpts.systemPrompt);
      expect(store.error).toBeNull();
      expect(store.pendingQuestion).toBeNull();
    });

    it("sets error and throws on HTTP error", async () => {
      globalThis.fetch = mockFetchError(409, "Another session is active");
      const store = useChatStore();

      await expect(store.startChat(startOpts)).rejects.toThrow("Another session is active");
      expect(store.error).toBe("Another session is active");
      expect(store.state).toBe("idle"); // stays idle on failure
    });

    it("sets error and throws on network error (fetch throws)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useChatStore();

      await expect(store.startChat(startOpts)).rejects.toThrow("Failed to fetch");
      expect(store.error).toBe("Failed to fetch");
      expect(store.state).toBe("idle"); // stays idle on failure
    });
  });

  // --- sendMessage ---

  describe("sendMessage", () => {
    it("adds user message to messages array", async () => {
      globalThis.fetch = mockFetchOk({ sent: true });
      const store = useChatStore();
      store.state = "active";
      store.awaitingUserInput = true;

      await store.sendMessage("Hello, world!");

      expect(store.messages).toHaveLength(1);
      expect(store.messages[0].type).toBe("user");
      expect(store.messages[0].content).toBe("Hello, world!");
    });

    it("sets awaitingUserInput=false after sending", async () => {
      globalThis.fetch = mockFetchOk({ sent: true });
      const store = useChatStore();
      store.state = "active";
      store.awaitingUserInput = true;

      await store.sendMessage("Hi");

      expect(store.awaitingUserInput).toBe(false);
    });

    it("POSTs correct payload to /api/chat/message", async () => {
      const mockFn = mockFetchOk({ sent: true });
      globalThis.fetch = mockFn;
      const store = useChatStore();

      await store.sendMessage("Test message");

      expect(mockFn).toHaveBeenCalledOnce();
      const [url, init] = mockFn.mock.calls[0];
      expect(url).toBe("/api/chat/message");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ text: "Test message" });
    });

    it("user message has valid id and timestamp", async () => {
      globalThis.fetch = mockFetchOk({ sent: true });
      const store = useChatStore();
      const before = Date.now();

      await store.sendMessage("timestamped");

      const msg = store.messages[0];
      expect(msg.id).toMatch(/^chat-\d+-\d+$/);
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it("sets error and throws on HTTP error", async () => {
      globalThis.fetch = mockFetchError(400, "Cannot send message");
      const store = useChatStore();

      await expect(store.sendMessage("oops")).rejects.toThrow("Cannot send message");
      expect(store.error).toBe("Cannot send message");
      // Message was optimistically added before the fetch
      expect(store.messages).toHaveLength(1);
    });

    it("restores awaitingUserInput on HTTP error so user can retry", async () => {
      globalThis.fetch = mockFetchError(400, "Cannot send message");
      const store = useChatStore();
      store.state = "active";
      store.awaitingUserInput = true;

      await expect(store.sendMessage("oops")).rejects.toThrow("Cannot send message");
      expect(store.awaitingUserInput).toBe(true);
      expect(store.canSendMessage).toBe(true);
    });

    it("restores awaitingUserInput on network error (fetch throws)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useChatStore();
      store.state = "active";
      store.awaitingUserInput = true;

      await expect(store.sendMessage("oops")).rejects.toThrow("Failed to fetch");
      expect(store.awaitingUserInput).toBe(true);
      expect(store.error).toBe("Failed to fetch");
    });
  });

  // --- replyQuestion ---

  describe("replyQuestion", () => {
    function setupWithPendingQuestion(store: ReturnType<typeof useChatStore>) {
      store.state = "question_pending";
      store.pendingQuestion = {
        questionId: "q42",
        questions: [{ question: "Pick one", header: "Choice", options: [{ label: "A", description: "option a" }], multiSelect: false }],
        source: "claude",
      };
    }

    it("clears pendingQuestion on success", async () => {
      globalThis.fetch = mockFetchOk({ replied: true });
      const store = useChatStore();
      setupWithPendingQuestion(store);

      await store.replyQuestion({ "Pick one": "A" });

      expect(store.pendingQuestion).toBeNull();
    });

    it("sets state=active and awaitingUserInput=false after reply", async () => {
      globalThis.fetch = mockFetchOk({ replied: true });
      const store = useChatStore();
      setupWithPendingQuestion(store);

      await store.replyQuestion({ "Pick one": "A" });

      expect(store.state).toBe("active");
      expect(store.awaitingUserInput).toBe(false);
    });

    it("adds question_answer message to buffer", async () => {
      globalThis.fetch = mockFetchOk({ replied: true });
      const store = useChatStore();
      setupWithPendingQuestion(store);

      const answers = { "Pick one": "A" };
      await store.replyQuestion(answers);

      expect(store.messages).toHaveLength(1);
      const msg = store.messages[0];
      expect(msg.type).toBe("question_answer");
      expect(msg.questionId).toBe("q42");
      expect(msg.answers).toEqual(answers);
    });

    it("POSTs to /api/chat/question/:id/reply with correct payload", async () => {
      const mockFn = mockFetchOk({ replied: true });
      globalThis.fetch = mockFn;
      const store = useChatStore();
      setupWithPendingQuestion(store);

      const answers = { "Pick one": "A" };
      await store.replyQuestion(answers);

      expect(mockFn).toHaveBeenCalledOnce();
      const [url, init] = mockFn.mock.calls[0];
      expect(url).toBe("/api/chat/question/q42/reply");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ answers });
    });

    it("encodes questionId in URL", async () => {
      const mockFn = mockFetchOk({ replied: true });
      globalThis.fetch = mockFn;
      const store = useChatStore();
      store.state = "question_pending";
      store.pendingQuestion = {
        questionId: "id with spaces/special",
        questions: [],
        source: "claude",
      };

      await store.replyQuestion({ q: "a" });

      const [url] = mockFn.mock.calls[0];
      expect(url).toBe(`/api/chat/question/${encodeURIComponent("id with spaces/special")}/reply`);
    });

    it("throws if no pending question", async () => {
      const store = useChatStore();

      await expect(store.replyQuestion({ q: "a" })).rejects.toThrow("No pending question to reply to");
    });

    it("sets error and throws on HTTP error, restoring question_pending state", async () => {
      globalThis.fetch = mockFetchError(400, "Question ID mismatch");
      const store = useChatStore();
      setupWithPendingQuestion(store);

      await expect(store.replyQuestion({ "Pick one": "A" })).rejects.toThrow("Question ID mismatch");
      expect(store.error).toBe("Question ID mismatch");
      // State must be restored so user can retry
      expect(store.pendingQuestion).not.toBeNull();
      expect(store.state).toBe("question_pending");
    });

    it("restores question_pending state on HTTP error so user can retry", async () => {
      globalThis.fetch = mockFetchError(400, "Question ID mismatch");
      const store = useChatStore();
      setupWithPendingQuestion(store);
      const originalPending = { ...store.pendingQuestion! };

      await expect(store.replyQuestion({ "Pick one": "A" })).rejects.toThrow("Question ID mismatch");

      // State should be restored to question_pending (matches server-side behavior)
      expect(store.state).toBe("question_pending");
      expect(store.pendingQuestion).toEqual(originalPending);
      expect(store.canReplyQuestion).toBe(true);
    });

    it("restores question_pending state on network error (fetch throws)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useChatStore();
      setupWithPendingQuestion(store);
      const originalPending = { ...store.pendingQuestion! };

      await expect(store.replyQuestion({ "Pick one": "A" })).rejects.toThrow("Failed to fetch");

      expect(store.state).toBe("question_pending");
      expect(store.pendingQuestion).toEqual(originalPending);
      expect(store.error).toBe("Failed to fetch");
    });
  });

  // --- stopChat ---

  describe("stopChat", () => {
    it("sets state=stopping and awaitingUserInput=false", async () => {
      globalThis.fetch = mockFetchOk({ stopped: true });
      const store = useChatStore();
      store.state = "active";
      store.awaitingUserInput = true;

      await store.stopChat();

      expect(store.state).toBe("stopping");
      expect(store.awaitingUserInput).toBe(false);
    });

    it("sends DELETE to /api/chat", async () => {
      const mockFn = mockFetchOk({ stopped: true });
      globalThis.fetch = mockFn;
      const store = useChatStore();

      await store.stopChat();

      expect(mockFn).toHaveBeenCalledOnce();
      const [url, init] = mockFn.mock.calls[0];
      expect(url).toBe("/api/chat");
      expect(init.method).toBe("DELETE");
    });

    it("throws on HTTP error and restores previous state", async () => {
      globalThis.fetch = mockFetchError(500, "Internal server error");
      const store = useChatStore();
      store.state = "active";
      store.awaitingUserInput = true;

      await expect(store.stopChat()).rejects.toThrow("Internal server error");

      // State should be restored to what it was before stopChat
      expect(store.state).toBe("active");
      expect(store.awaitingUserInput).toBe(true);
    });

    it("restores previous state on HTTP error so user can retry", async () => {
      globalThis.fetch = mockFetchError(500, "Internal server error");
      const store = useChatStore();
      store.state = "active";
      store.awaitingUserInput = true;

      await expect(store.stopChat()).rejects.toThrow("Internal server error");

      // State should be restored to what it was before stopChat
      expect(store.state).toBe("active");
      expect(store.awaitingUserInput).toBe(true);
    });

    it("restores previous state on network error (fetch throws)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useChatStore();
      store.state = "question_pending";
      store.awaitingUserInput = false;

      await expect(store.stopChat()).rejects.toThrow("Failed to fetch");

      // State should be restored to what it was before stopChat
      expect(store.state).toBe("question_pending");
      expect(store.awaitingUserInput).toBe(false);
    });
  });

  // --- startFlow ---

  describe("startFlow", () => {
    it("calls startChat then sendMessage sequentially", async () => {
      const callOrder: string[] = [];
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        callOrder.push(url);
        return { ok: true, json: () => Promise.resolve({}) };
      });
      const store = useChatStore();

      await store.startFlow(startOpts, "Hello from flow");

      expect(callOrder).toEqual(["/api/chat/start", "/api/chat/message"]);
    });

    it("sets state=active after startChat and adds user message after sendMessage", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      const store = useChatStore();

      await store.startFlow(startOpts, "First message");

      // After startFlow: state=active, system_prompt + user message, awaitingUserInput=false
      expect(store.state).toBe("active");
      expect(store.awaitingUserInput).toBe(false);
      expect(store.messages).toHaveLength(2);
      expect(store.messages[0].type).toBe("system_prompt");
      expect(store.messages[1].type).toBe("user");
      expect(store.messages[1].content).toBe("First message");
    });

    it("sends correct payloads for both requests", async () => {
      const mockFn = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      });
      globalThis.fetch = mockFn;
      const store = useChatStore();

      await store.startFlow(startOpts, "My message");

      // First call: startChat
      expect(JSON.parse(mockFn.mock.calls[0][1].body)).toEqual(startOpts);
      // Second call: sendMessage
      expect(JSON.parse(mockFn.mock.calls[1][1].body)).toEqual({ text: "My message" });
    });

    it("does not call sendMessage if startChat fails", async () => {
      const mockFn = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 409, json: () => Promise.resolve({ error: "Already active" }) });
      globalThis.fetch = mockFn;
      const store = useChatStore();

      await expect(store.startFlow(startOpts, "Hello")).rejects.toThrow("Already active");
      expect(mockFn).toHaveBeenCalledOnce(); // Only startChat, not sendMessage
    });
  });

  // --- clearChat ---

  describe("clearChat", () => {
    it("resets all state to idle defaults", () => {
      const store = useChatStore();
      store.state = "active";
      store.awaitingUserInput = true;
      store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
      store.pendingQuestion = { questionId: "q1", questions: [], source: "claude" };
      store.sessionInfo = { agent: "claude" };
      store.error = "error";

      store.clearChat();

      expect(store.state).toBe("idle");
      expect(store.awaitingUserInput).toBe(false);
      expect(store.messages).toEqual([]);
      expect(store.pendingQuestion).toBeNull();
      expect(store.sessionInfo).toBeNull();
      expect(store.error).toBeNull();
    });
  });
});

// Compile-time type conformance tests
describe("chat store types", () => {
  it("ChatMessage accepts all valid type discriminants", () => {
    const msgs: ChatMessage[] = [
      { id: "1", type: "user", content: "hi", timestamp: 1 },
      { id: "2", type: "text", content: "hello", timestamp: 2 },
      { id: "3", type: "tool", content: "Read file", timestamp: 3, toolName: "Read" },
      { id: "4", type: "tool_result", content: "ok", timestamp: 4 },
      { id: "5", type: "question", content: "", timestamp: 5, questionId: "q1", questions: [] },
      { id: "6", type: "question_answer", content: "{}", timestamp: 6, questionId: "q1", answers: {} },
      { id: "7", type: "context_usage", content: "{}", timestamp: 7 },
      { id: "8", type: "error", content: "oops", timestamp: 8 },
    ];
    expect(msgs).toHaveLength(8);
  });

  it("ChatState accepts all valid values", () => {
    const states: ChatState[] = ["idle", "active", "question_pending", "stopping"];
    expect(states).toHaveLength(4);
  });

  it("SessionInfo and PendingQuestion accept correct shapes", () => {
    const session: SessionInfo = { agent: "claude", model: "opus", variant: "high" };
    const pending: PendingQuestion = {
      questionId: "q1",
      questions: [{ question: "Pick?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }],
      source: "opencode",
    };
    expect(session).toBeDefined();
    expect(pending).toBeDefined();
  });
});
