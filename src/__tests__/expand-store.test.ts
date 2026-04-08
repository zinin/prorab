import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useExpandStore } from "../../ui/src/stores/expand";
import type {
  ExpandMessage,
  ExpandStoreState,
  ExpandSessionInfo,
  ExpandOutcome,
} from "../../ui/src/stores/expand";

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

function mockFetchErrorWithReason(status: number, error: string, reason: string) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error, reason }),
  });
}

// Default start options used across tests
const taskId = "7";
const startOpts = {
  agent: "claude" as const,
  model: "sonnet",
};

describe("useExpandStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("has correct initial state values", () => {
    const store = useExpandStore();

    expect(store.state).toBe("idle" satisfies ExpandStoreState);
    expect(store.messages).toEqual([]);
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
    expect(store.outcome).toBeNull();
    expect(store.reason).toBeNull();
  });

  it("has correct initial computed values", () => {
    const store = useExpandStore();

    expect(store.lastMessage).toBeNull();
    expect(store.hasSession).toBe(false);
    expect(store.isTerminal).toBe(false);
    expect(store.isActive).toBe(false);
    expect(store.isStopping).toBe(false);
    expect(store.isCompleted).toBe(false);
    expect(store.hasOutcome).toBe(false);
    expect(store.isFileWritingOutcome).toBe(false);
  });

  it("lastMessage returns the last message when messages exist", () => {
    const store = useExpandStore();
    const msg: ExpandMessage = {
      id: "test-1",
      type: "text",
      content: "hello",
      timestamp: Date.now(),
    };
    store.messages.push(msg);

    expect(store.lastMessage).toEqual(msg);
  });

  it("lastMessage updates reactively as messages are added", () => {
    const store = useExpandStore();

    const msg1: ExpandMessage = {
      id: "test-1",
      type: "text",
      content: "first",
      timestamp: 1000,
    };
    const msg2: ExpandMessage = {
      id: "test-2",
      type: "tool",
      content: "second",
      timestamp: 2000,
      toolName: "Read",
    };

    store.messages.push(msg1);
    expect(store.lastMessage?.id).toBe("test-1");

    store.messages.push(msg2);
    expect(store.lastMessage?.id).toBe("test-2");
  });

  it("hasSession is true when state is not idle", () => {
    const store = useExpandStore();
    store.state = "active";
    expect(store.hasSession).toBe(true);

    store.state = "stopping";
    expect(store.hasSession).toBe(true);

    store.state = "completed";
    expect(store.hasSession).toBe(true);

    store.state = "idle";
    expect(store.hasSession).toBe(false);
  });

  it("isTerminal is true only when state is completed", () => {
    const store = useExpandStore();

    expect(store.isTerminal).toBe(false);

    store.state = "active";
    expect(store.isTerminal).toBe(false);

    store.state = "stopping";
    expect(store.isTerminal).toBe(false);

    store.state = "completed";
    expect(store.isTerminal).toBe(true);

    store.state = "idle";
    expect(store.isTerminal).toBe(false);
  });

  it("isActive, isStopping, isCompleted reflect state correctly", () => {
    const store = useExpandStore();

    store.state = "active";
    expect(store.isActive).toBe(true);
    expect(store.isStopping).toBe(false);
    expect(store.isCompleted).toBe(false);

    store.state = "stopping";
    expect(store.isActive).toBe(false);
    expect(store.isStopping).toBe(true);
    expect(store.isCompleted).toBe(false);

    store.state = "completed";
    expect(store.isActive).toBe(false);
    expect(store.isStopping).toBe(false);
    expect(store.isCompleted).toBe(true);
  });

  it("hasOutcome is true when outcome is set", () => {
    const store = useExpandStore();
    expect(store.hasOutcome).toBe(false);

    store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };
    expect(store.hasOutcome).toBe(true);
  });

  it("isFileWritingOutcome is true only for success with subtaskCount > 0", () => {
    const store = useExpandStore();

    store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };
    expect(store.isFileWritingOutcome).toBe(true);

    store.outcome = { status: "success", taskId: "7", subtaskCount: 0 };
    expect(store.isFileWritingOutcome).toBe(false);

    store.outcome = { status: "cancelled", taskId: "7", subtaskCount: 0 };
    expect(store.isFileWritingOutcome).toBe(false);

    store.outcome = { status: "failure", taskId: "7", reason: "agent_failed", errors: ["err"], message: "err", subtaskCount: 0 };
    expect(store.isFileWritingOutcome).toBe(false);
  });

  it("belongsToTask matches on sessionInfo.taskId", () => {
    const store = useExpandStore();
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude" };

    expect(store.belongsToTask("7")).toBe(true);
    expect(store.belongsToTask("8")).toBe(false);
  });

  it("belongsToTask matches on outcome.taskId", () => {
    const store = useExpandStore();
    store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };

    expect(store.belongsToTask("7")).toBe(true);
    expect(store.belongsToTask("8")).toBe(false);
  });

  it("belongsToTask returns false when no session and no outcome", () => {
    const store = useExpandStore();
    expect(store.belongsToTask("7")).toBe(false);
  });

  it("$reset restores all state to initial values", () => {
    const store = useExpandStore();

    // Mutate everything
    store.state = "active";
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude", model: "opus" };
    store.error = "some error";
    store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };
    store.reason = "active_session";

    store.$reset();

    expect(store.state).toBe("idle");
    expect(store.messages).toEqual([]);
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
    expect(store.outcome).toBeNull();
    expect(store.reason).toBeNull();
    expect(store.lastMessage).toBeNull();
  });

  it("clearMessages empties the message buffer", () => {
    const store = useExpandStore();
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.messages.push({ id: "m2", type: "tool", content: "world", timestamp: 2, toolName: "Read" });

    expect(store.messages).toHaveLength(2);
    store.clearMessages();
    expect(store.messages).toEqual([]);
  });

  it("clearExpand resets entire state like $reset", () => {
    const store = useExpandStore();

    store.state = "completed";
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude", model: "opus" };
    store.error = "something broke";
    store.outcome = { status: "failure", taskId: "7", reason: "agent_failed", errors: ["bad"], message: "bad", subtaskCount: 0 };
    store.reason = "task_not_pending";

    store.clearExpand();

    expect(store.state).toBe("idle");
    expect(store.messages).toEqual([]);
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
    expect(store.outcome).toBeNull();
    expect(store.reason).toBeNull();
  });

  it("trims messages buffer when exceeding MAX_MESSAGES", () => {
    const store = useExpandStore();

    // Push 1001 messages to exceed MAX_MESSAGES (1000)
    for (let i = 0; i < 1001; i++) {
      store.handleWsEvent({
        type: "agent:tool",
        channel: "expand",
        name: `tool-${i}`,
        summary: `summary-${i}`,
      });
    }

    // Should be trimmed to TRIM_TO (500)
    expect(store.messages.length).toBe(500);
    // The last message should be from tool-1000 (the most recent)
    expect(store.messages[store.messages.length - 1].toolName).toBe("tool-1000");
  });
});

// --- API action tests with mock fetch ---

describe("useExpandStore API actions", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // --- start ---

  describe("start", () => {
    it("sets state=active on success", async () => {
      globalThis.fetch = mockFetchOk({ started: true, sessionId: "s1" });
      const store = useExpandStore();

      await store.start(taskId, startOpts);

      expect(store.state).toBe("active");
      expect(store.error).toBeNull();
    });

    it("stores sessionInfo from options with taskId", async () => {
      globalThis.fetch = mockFetchOk({ started: true });
      const store = useExpandStore();

      await store.start("42", { agent: "opencode", model: "gpt-4", variant: "high" });

      expect(store.sessionInfo).toEqual({
        sessionId: "",
        taskId: "42",
        agent: "opencode",
        model: "gpt-4",
        variant: "high",
      });
    });

    it("POSTs correct payload to /api/tasks/:taskId/expand", async () => {
      const mockFn = mockFetchOk({ started: true });
      globalThis.fetch = mockFn;
      const store = useExpandStore();

      await store.start(taskId, startOpts);

      expect(mockFn).toHaveBeenCalledOnce();
      const [url, init] = mockFn.mock.calls[0];
      expect(url).toBe(`/api/tasks/${taskId}/expand`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(startOpts);
    });

    it("clears previous messages, error and outcome before starting", async () => {
      globalThis.fetch = mockFetchOk({ started: true });
      const store = useExpandStore();

      // Simulate previous session state
      store.messages.push({ id: "old", type: "text", content: "stale", timestamp: 1 });
      store.error = "old error";
      store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };

      await store.start(taskId, startOpts);

      expect(store.messages).toHaveLength(0);
      expect(store.error).toBeNull();
      expect(store.outcome).toBeNull();
    });

    it("sets error and throws on HTTP error", async () => {
      globalThis.fetch = mockFetchError(409, "Another session is active");
      const store = useExpandStore();

      await expect(store.start(taskId, startOpts)).rejects.toThrow("Another session is active");
      expect(store.error).toBe("Another session is active");
      expect(store.state).toBe("idle"); // stays idle on failure
    });

    it("sets error and throws on network error (fetch throws)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useExpandStore();

      await expect(store.start(taskId, startOpts)).rejects.toThrow("Failed to fetch");
      expect(store.error).toBe("Failed to fetch");
      expect(store.state).toBe("idle"); // stays idle on failure
    });

    it("handles task_not_pending conflict and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "Task is not pending", "task_not_pending");
      const store = useExpandStore();

      await expect(store.start(taskId, startOpts)).rejects.toThrow("Task is not pending");
      expect(store.error).toBe("Task is not pending");
      expect(store.reason).toBe("task_not_pending");
    });

    it("handles task_has_subtasks conflict and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "Task already has subtasks", "task_has_subtasks");
      const store = useExpandStore();

      await expect(store.start(taskId, startOpts)).rejects.toThrow("Task already has subtasks");
      expect(store.error).toBe("Task already has subtasks");
      expect(store.reason).toBe("task_has_subtasks");
    });

    it("handles active_session conflict and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "Another session is active", "active_session");
      const store = useExpandStore();

      await expect(store.start(taskId, startOpts)).rejects.toThrow("Another session is active");
      expect(store.error).toBe("Another session is active");
      expect(store.reason).toBe("active_session");
    });

    it("handles tasks_file_dirty conflict and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "tasks.json has uncommitted changes", "tasks_file_dirty");
      const store = useExpandStore();

      await expect(store.start(taskId, startOpts)).rejects.toThrow("tasks.json has uncommitted changes");
      expect(store.error).toBe("tasks.json has uncommitted changes");
      expect(store.reason).toBe("tasks_file_dirty");
    });

    it("reason is null on network error (no 409 response)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useExpandStore();

      await expect(store.start(taskId, startOpts)).rejects.toThrow("Failed to fetch");
      expect(store.error).toBe("Failed to fetch");
      expect(store.reason).toBeNull();
    });

    it("reason is null on non-409 HTTP error (no reason field in response)", async () => {
      globalThis.fetch = mockFetchError(500, "Internal server error");
      const store = useExpandStore();

      await expect(store.start(taskId, startOpts)).rejects.toThrow("Internal server error");
      expect(store.error).toBe("Internal server error");
      expect(store.reason).toBeNull();
    });

    it("clears reason from previous error on new start attempt", async () => {
      const store = useExpandStore();

      // First attempt: 409 with reason
      globalThis.fetch = mockFetchErrorWithReason(409, "Task is not pending", "task_not_pending");
      await expect(store.start(taskId, startOpts)).rejects.toThrow();
      expect(store.reason).toBe("task_not_pending");

      // Second attempt: success
      globalThis.fetch = mockFetchOk({ started: true, sessionId: "s1" });
      await store.start(taskId, startOpts);
      expect(store.reason).toBeNull();
    });

    it("does not substitute local defaults for model/variant", async () => {
      const mockFn = mockFetchOk({ started: true });
      globalThis.fetch = mockFn;
      const store = useExpandStore();

      // Pass only agent, no model/variant
      await store.start(taskId, { agent: "claude" });

      const body = JSON.parse(mockFn.mock.calls[0][1].body);
      expect(body).toEqual({ agent: "claude" });
      expect(body.model).toBeUndefined();
      expect(body.variant).toBeUndefined();
    });
  });

  // --- stop ---

  describe("stop", () => {
    it("sets state=stopping on success", async () => {
      globalThis.fetch = mockFetchOk({ stopped: true });
      const store = useExpandStore();
      store.state = "active";

      await store.stop(taskId);

      expect(store.state).toBe("stopping");
    });

    it("sends DELETE to /api/tasks/:taskId/expand", async () => {
      const mockFn = mockFetchOk({ stopped: true });
      globalThis.fetch = mockFn;
      const store = useExpandStore();

      await store.stop(taskId);

      expect(mockFn).toHaveBeenCalledOnce();
      const [url, init] = mockFn.mock.calls[0];
      expect(url).toBe(`/api/tasks/${taskId}/expand`);
      expect(init.method).toBe("DELETE");
    });

    it("throws on HTTP error and restores previous state", async () => {
      globalThis.fetch = mockFetchError(500, "Internal server error");
      const store = useExpandStore();
      store.state = "active";

      await expect(store.stop(taskId)).rejects.toThrow("Internal server error");

      // State should be restored to what it was before stop
      expect(store.state).toBe("active");
    });

    it("stores error on HTTP error", async () => {
      globalThis.fetch = mockFetchError(500, "Internal server error");
      const store = useExpandStore();
      store.state = "active";

      await expect(store.stop(taskId)).rejects.toThrow();

      expect(store.error).toBe("Internal server error");
    });

    it("restores previous state on network error (fetch throws)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useExpandStore();
      store.state = "active";

      await expect(store.stop(taskId)).rejects.toThrow("Failed to fetch");

      // State should be restored to what it was before stop
      expect(store.state).toBe("active");
    });

    it("stores error on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useExpandStore();
      store.state = "active";

      await expect(store.stop(taskId)).rejects.toThrow();

      expect(store.error).toBe("Failed to fetch");
    });

    it("handles no_active_session 409 and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "No active expand session", "no_active_session");
      const store = useExpandStore();
      store.state = "active";

      await expect(store.stop(taskId)).rejects.toThrow("No active expand session");

      expect(store.state).toBe("active"); // restored
      expect(store.error).toBe("No active expand session");
      expect(store.reason).toBe("no_active_session");
    });

    it("handles task_mismatch 409 and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "Expand session is for a different task", "task_mismatch");
      const store = useExpandStore();
      store.state = "active";

      await expect(store.stop(taskId)).rejects.toThrow("Expand session is for a different task");

      expect(store.state).toBe("active"); // restored
      expect(store.error).toBe("Expand session is for a different task");
      expect(store.reason).toBe("task_mismatch");
    });

    it("reason stays null on network error (no 409 response)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Network failure"));
      const store = useExpandStore();
      store.state = "active";

      await expect(store.stop(taskId)).rejects.toThrow();

      expect(store.reason).toBeNull();
    });

    it("does not lose terminal outcome on stop failure", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "No active expand session", "no_active_session");
      const store = useExpandStore();
      store.state = "completed";
      store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };

      await expect(store.stop(taskId)).rejects.toThrow();

      // Outcome must survive the stop failure
      expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 3 });
      expect(store.state).toBe("completed"); // restored
    });
  });
});

// --- WebSocket event handling ---

describe("useExpandStore handleWsEvent", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // --- agent:* events ---

  it("adds text message on agent:text", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Hello world",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("text");
    expect(store.messages[0].content).toBe("Hello world");
  });

  it("aggregates consecutive agent:text events", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Hello ",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "world",
    });

    // Should aggregate into a single message
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].content).toBe("Hello world");
  });

  it("breaks text aggregation on non-text event", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "first",
    });
    store.handleWsEvent({
      type: "agent:tool",
      channel: "expand",
      name: "Read",
      summary: "Read file.ts",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "second",
    });

    // Three separate messages
    expect(store.messages).toHaveLength(3);
    expect(store.messages[0].content).toBe("first");
    expect(store.messages[1].type).toBe("tool");
    expect(store.messages[2].content).toBe("second");
  });

  it("adds tool message on agent:tool", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:tool",
      channel: "expand",
      name: "Write",
      summary: "Write tasks.json",
      input: { path: "tasks.json" },
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("tool");
    expect(store.messages[0].toolName).toBe("Write");
    expect(store.messages[0].content).toContain("tasks.json");
  });

  it("adds tool_result message on agent:tool_result", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "expand",
      summary: "File written",
      output: "OK",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("tool_result");
    expect(store.messages[0].content).toBe("OK");
  });

  it("prefers output over summary for tool_result content", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "expand",
      summary: "summary text",
      output: "output text",
    });

    expect(store.messages[0].content).toBe("output text");
  });

  it("falls back to summary when output is absent for tool_result", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "expand",
      summary: "summary text",
    });

    expect(store.messages[0].content).toBe("summary text");
  });

  it("adds context_usage message on agent:context_usage", () => {
    const store = useExpandStore();
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude", model: "sonnet" };

    store.handleWsEvent({
      type: "agent:context_usage",
      channel: "expand",
      contextTokens: 5000,
      contextWindow: 200000,
      model: "sonnet",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("context_usage");
    const parsed = JSON.parse(store.messages[0].content);
    expect(parsed.contextTokens).toBe(5000);
    expect(parsed.contextWindow).toBe(200000);
    expect(parsed.agent).toBe("claude");
  });

  it("adds system_prompt message on agent:system_prompt", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:system_prompt",
      channel: "expand",
      text: "You are an expand agent",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("system_prompt");
    expect(store.messages[0].content).toBe("You are an expand agent");
  });

  it("adds task_prompt message on agent:task_prompt", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:task_prompt",
      channel: "expand",
      text: "Decompose the task into subtasks",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("task_prompt");
    expect(store.messages[0].content).toBe("Decompose the task into subtasks");
  });

  it("ignores agent:* events without expand channel", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:text",
      channel: "execute",
      text: "wrong channel",
    });

    expect(store.messages).toEqual([]);
  });

  it("ignores agent:* events without channel", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:text",
      text: "no channel",
    });

    expect(store.messages).toEqual([]);
  });

  // --- expand:* lifecycle events ---

  it("sets state=active on expand:started", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "expand:started",
      agent: "claude",
      model: "sonnet",
      sessionId: "s1",
      taskId: "7",
    });

    expect(store.state).toBe("active");
    expect(store.sessionInfo).toEqual({
      sessionId: "s1",
      taskId: "7",
      agent: "claude",
      model: "sonnet",
      variant: undefined,
    });
  });

  it("preserves variant from start() when expand:started arrives without variant", () => {
    const store = useExpandStore();
    // Simulate what start() does — sets sessionInfo with variant
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude", model: "sonnet", variant: "high" };
    store.state = "active";

    // Server broadcasts expand:started without variant
    store.handleWsEvent({
      type: "expand:started",
      agent: "claude",
      model: "sonnet",
      sessionId: "s1",
      taskId: "7",
    });

    // variant should be preserved from the original sessionInfo
    expect(store.sessionInfo?.variant).toBe("high");
  });

  it("updates variant from expand:started when event carries it", () => {
    const store = useExpandStore();
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude", model: "sonnet", variant: "low" };
    store.state = "active";

    // Server broadcasts expand:started with variant
    store.handleWsEvent({
      type: "expand:started",
      agent: "claude",
      model: "sonnet",
      sessionId: "s1",
      taskId: "7",
      variant: "high",
    });

    expect(store.sessionInfo?.variant).toBe("high");
  });

  it("skips state and sessionInfo mutation on expand:started when rehydrating", () => {
    const store = useExpandStore();
    store.setRehydrating(true);
    store.state = "completed"; // server snapshot
    // Simulate pre-existing sessionInfo (e.g. from connected message)
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude", model: "sonnet", variant: "high" };

    store.handleWsEvent({
      type: "expand:started",
      agent: "claude",
      model: "sonnet",
      taskId: "99", // stale replay event with different taskId
    });

    // State should NOT be overwritten
    expect(store.state).toBe("completed");
    // sessionInfo must NOT be overwritten — the connected snapshot is authoritative,
    // and a stale replay event could carry a different taskId/sessionId which would
    // corrupt belongsToTask() results.
    expect(store.sessionInfo).toEqual({
      sessionId: "s1",
      taskId: "7",
      agent: "claude",
      model: "sonnet",
      variant: "high",
    });
  });

  it("sets error on expand:error", () => {
    const store = useExpandStore();
    store.state = "active";

    store.handleWsEvent({
      type: "expand:error",
      channel: "expand",
      message: "Agent crashed",
    });

    expect(store.error).toBe("Agent crashed");
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("error");
    expect(store.messages[0].content).toBe("Agent crashed");
  });

  it("sets state=completed and outcome on expand:finished with success", () => {
    const store = useExpandStore();
    store.state = "active";
    store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude" };

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 4 },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
    expect(store.sessionInfo).toBeNull(); // cleared on finish
  });

  it("sets outcome with errors on expand:finished with failure", () => {
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
  });

  it("sets outcome=cancelled on expand:finished with cancelled", () => {
    const store = useExpandStore();
    store.state = "stopping";

    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "cancelled", taskId: "7", subtaskCount: 0 },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled", taskId: "7", subtaskCount: 0 });
  });

  it("preserves error across expand:finished", () => {
    const store = useExpandStore();
    store.state = "active";

    // Error event arrives first
    store.handleWsEvent({
      type: "expand:error",
      channel: "expand",
      message: "Something went wrong",
    });

    // Then finished
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "failure",
        taskId: "7",
        reason: "agent_failed",
        errors: ["task validation failed"],
        message: "task validation failed",
        subtaskCount: 0,
      },
    });

    // Error should be preserved
    expect(store.error).toBe("Something went wrong");
    expect(store.outcome?.status).toBe("failure");
  });

  it("message IDs have exp- prefix", () => {
    const store = useExpandStore();

    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "hello",
    });

    expect(store.messages[0].id).toMatch(/^exp-\d+-\d+$/);
  });

  it("skips state mutation on expand:finished when rehydrating", () => {
    const store = useExpandStore();
    store.setRehydrating(true);
    store.state = "completed"; // authoritative server snapshot
    store.outcome = { status: "success", taskId: "7", subtaskCount: 3 };

    // Replay event should not overwrite
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: { status: "success", taskId: "7", subtaskCount: 3 },
    });

    // State preserved from authoritative snapshot
    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 3 });
  });
});

// Compile-time type conformance tests
describe("expand store types", () => {
  it("ExpandMessage accepts all valid type discriminants", () => {
    const msgs: ExpandMessage[] = [
      { id: "1", type: "text", content: "hello", timestamp: 1 },
      { id: "2", type: "tool", content: "Read file", timestamp: 2, toolName: "Read" },
      { id: "3", type: "tool_result", content: "ok", timestamp: 3 },
      { id: "4", type: "context_usage", content: "{}", timestamp: 4 },
      { id: "5", type: "system_prompt", content: "prompt", timestamp: 5 },
      { id: "6", type: "task_prompt", content: "task", timestamp: 6 },
      { id: "7", type: "error", content: "oops", timestamp: 7 },
    ];
    expect(msgs).toHaveLength(7);
  });

  it("ExpandStoreState accepts all valid values", () => {
    const states: ExpandStoreState[] = ["idle", "active", "stopping", "completed"];
    expect(states).toHaveLength(4);
  });

  it("ExpandSessionInfo includes taskId and sessionId", () => {
    const session: ExpandSessionInfo = { sessionId: "s1", taskId: "7", agent: "claude", model: "opus", variant: "high" };
    expect(session.taskId).toBe("7");
    expect(session.sessionId).toBe("s1");
  });

  it("ExpandOutcome accepts correct shapes", () => {
    const outcomes: ExpandOutcome[] = [
      { status: "success", taskId: "7", subtaskCount: 3 },
      { status: "failure", taskId: "7", reason: "agent_failed", errors: ["bad"], message: "bad", subtaskCount: 0 },
      { status: "cancelled", taskId: "7", subtaskCount: 0 },
    ];
    expect(outcomes).toHaveLength(3);
  });
});
