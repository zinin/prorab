import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useParsePrdStore } from "../../ui/src/stores/parse-prd";
import type {
  ParsePrdMessage,
  ParsePrdStoreState,
  ParsePrdSessionInfo,
  ParsePrdOutcome,
} from "../../ui/src/stores/parse-prd";

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
const startOpts = {
  agent: "claude" as const,
  model: "sonnet",
};

describe("useParsePrdStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("has correct initial state values", () => {
    const store = useParsePrdStore();

    expect(store.state).toBe("idle" satisfies ParsePrdStoreState);
    expect(store.messages).toEqual([]);
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
    expect(store.outcome).toBeNull();
    expect(store.reason).toBeNull();
  });

  it("has correct initial computed values", () => {
    const store = useParsePrdStore();

    expect(store.lastMessage).toBeNull();
    expect(store.hasSession).toBe(false);
    expect(store.isTerminal).toBe(false);
  });

  it("lastMessage returns the last message when messages exist", () => {
    const store = useParsePrdStore();
    const msg: ParsePrdMessage = {
      id: "test-1",
      type: "text",
      content: "hello",
      timestamp: Date.now(),
    };
    store.messages.push(msg);

    expect(store.lastMessage).toEqual(msg);
  });

  it("lastMessage updates reactively as messages are added", () => {
    const store = useParsePrdStore();

    const msg1: ParsePrdMessage = {
      id: "test-1",
      type: "text",
      content: "first",
      timestamp: 1000,
    };
    const msg2: ParsePrdMessage = {
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
    const store = useParsePrdStore();
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
    const store = useParsePrdStore();

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

  it("$reset restores all state to initial values", () => {
    const store = useParsePrdStore();

    // Mutate everything
    store.state = "active";
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.sessionInfo = { agent: "claude", model: "opus" };
    store.error = "some error";
    store.outcome = { status: "success" };
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
    const store = useParsePrdStore();
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.messages.push({ id: "m2", type: "tool", content: "world", timestamp: 2, toolName: "Read" });

    expect(store.messages).toHaveLength(2);
    store.clearMessages();
    expect(store.messages).toEqual([]);
  });

  it("clearParsePrd resets entire state like $reset", () => {
    const store = useParsePrdStore();

    store.state = "completed";
    store.messages.push({ id: "m1", type: "text", content: "hello", timestamp: 1 });
    store.sessionInfo = { agent: "claude", model: "opus" };
    store.error = "something broke";
    store.outcome = { status: "failure", errors: ["bad"] };
    store.reason = "prd_missing";

    store.clearParsePrd();

    expect(store.state).toBe("idle");
    expect(store.messages).toEqual([]);
    expect(store.sessionInfo).toBeNull();
    expect(store.error).toBeNull();
    expect(store.outcome).toBeNull();
    expect(store.reason).toBeNull();
  });

  it("trims messages buffer when exceeding MAX_MESSAGES", () => {
    const store = useParsePrdStore();

    // Push 1001 messages to exceed MAX_MESSAGES (1000)
    for (let i = 0; i < 1001; i++) {
      store.handleWsEvent({
        type: "agent:tool",
        channel: "parse-prd",
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

describe("useParsePrdStore API actions", () => {
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
      const store = useParsePrdStore();

      await store.start(startOpts);

      expect(store.state).toBe("active");
      expect(store.error).toBeNull();
    });

    it("stores sessionInfo from options", async () => {
      globalThis.fetch = mockFetchOk({ started: true });
      const store = useParsePrdStore();

      await store.start({ agent: "opencode", model: "gpt-4", variant: "high" });

      expect(store.sessionInfo).toEqual({ agent: "opencode", model: "gpt-4", variant: "high" });
    });

    it("POSTs correct payload to /api/parse-prd", async () => {
      const mockFn = mockFetchOk({ started: true });
      globalThis.fetch = mockFn;
      const store = useParsePrdStore();

      await store.start(startOpts);

      expect(mockFn).toHaveBeenCalledOnce();
      const [url, init] = mockFn.mock.calls[0];
      expect(url).toBe("/api/parse-prd");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual(startOpts);
    });

    it("clears previous messages, error and outcome before starting", async () => {
      globalThis.fetch = mockFetchOk({ started: true });
      const store = useParsePrdStore();

      // Simulate previous session state
      store.messages.push({ id: "old", type: "text", content: "stale", timestamp: 1 });
      store.error = "old error";
      store.outcome = { status: "success" };

      await store.start(startOpts);

      expect(store.messages).toHaveLength(0);
      expect(store.error).toBeNull();
      expect(store.outcome).toBeNull();
    });

    it("sets error and throws on HTTP error", async () => {
      globalThis.fetch = mockFetchError(409, "Another session is active");
      const store = useParsePrdStore();

      await expect(store.start(startOpts)).rejects.toThrow("Another session is active");
      expect(store.error).toBe("Another session is active");
      expect(store.state).toBe("idle"); // stays idle on failure
    });

    it("sets error and throws on network error (fetch throws)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useParsePrdStore();

      await expect(store.start(startOpts)).rejects.toThrow("Failed to fetch");
      expect(store.error).toBe("Failed to fetch");
      expect(store.state).toBe("idle"); // stays idle on failure
    });

    it("handles prd_missing conflict and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "PRD file is missing or empty", "prd_missing");
      const store = useParsePrdStore();

      await expect(store.start(startOpts)).rejects.toThrow("PRD file is missing or empty");
      expect(store.error).toBe("PRD file is missing or empty");
      expect(store.reason).toBe("prd_missing");
    });

    it("handles tasks_file_exists conflict and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "tasks.json already exists", "tasks_file_exists");
      const store = useParsePrdStore();

      await expect(store.start(startOpts)).rejects.toThrow("tasks.json already exists");
      expect(store.error).toBe("tasks.json already exists");
      expect(store.reason).toBe("tasks_file_exists");
    });

    it("handles active_session conflict and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "Another session is active", "active_session");
      const store = useParsePrdStore();

      await expect(store.start(startOpts)).rejects.toThrow("Another session is active");
      expect(store.error).toBe("Another session is active");
      expect(store.reason).toBe("active_session");
    });

    it("reason is null on network error (no 409 response)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useParsePrdStore();

      await expect(store.start(startOpts)).rejects.toThrow("Failed to fetch");
      expect(store.error).toBe("Failed to fetch");
      expect(store.reason).toBeNull();
    });

    it("reason is null on non-409 HTTP error (no reason field in response)", async () => {
      globalThis.fetch = mockFetchError(500, "Internal server error");
      const store = useParsePrdStore();

      await expect(store.start(startOpts)).rejects.toThrow("Internal server error");
      expect(store.error).toBe("Internal server error");
      expect(store.reason).toBeNull();
    });

    it("clears reason from previous error on new start attempt", async () => {
      const store = useParsePrdStore();

      // First attempt: 409 with reason
      globalThis.fetch = mockFetchErrorWithReason(409, "PRD file is missing or empty", "prd_missing");
      await expect(store.start(startOpts)).rejects.toThrow();
      expect(store.reason).toBe("prd_missing");

      // Second attempt: success
      globalThis.fetch = mockFetchOk({ started: true, sessionId: "s1" });
      await store.start(startOpts);
      expect(store.reason).toBeNull();
    });

    it("does not substitute local defaults for model/variant", async () => {
      const mockFn = mockFetchOk({ started: true });
      globalThis.fetch = mockFn;
      const store = useParsePrdStore();

      // Pass only agent, no model/variant
      await store.start({ agent: "claude" });

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
      const store = useParsePrdStore();
      store.state = "active";

      await store.stop();

      expect(store.state).toBe("stopping");
    });

    it("sends DELETE to /api/parse-prd", async () => {
      const mockFn = mockFetchOk({ stopped: true });
      globalThis.fetch = mockFn;
      const store = useParsePrdStore();

      await store.stop();

      expect(mockFn).toHaveBeenCalledOnce();
      const [url, init] = mockFn.mock.calls[0];
      expect(url).toBe("/api/parse-prd");
      expect(init.method).toBe("DELETE");
    });

    it("throws on HTTP error and restores previous state", async () => {
      globalThis.fetch = mockFetchError(500, "Internal server error");
      const store = useParsePrdStore();
      store.state = "active";

      await expect(store.stop()).rejects.toThrow("Internal server error");

      // State should be restored to what it was before stop
      expect(store.state).toBe("active");
    });

    it("stores error on HTTP error", async () => {
      globalThis.fetch = mockFetchError(500, "Internal server error");
      const store = useParsePrdStore();
      store.state = "active";

      await expect(store.stop()).rejects.toThrow();

      expect(store.error).toBe("Internal server error");
    });

    it("restores previous state on network error (fetch throws)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useParsePrdStore();
      store.state = "active";

      await expect(store.stop()).rejects.toThrow("Failed to fetch");

      // State should be restored to what it was before stop
      expect(store.state).toBe("active");
    });

    it("stores error on network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      const store = useParsePrdStore();
      store.state = "active";

      await expect(store.stop()).rejects.toThrow();

      expect(store.error).toBe("Failed to fetch");
    });

    it("handles no_active_session 409 and stores reason", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "No active parse-prd session", "no_active_session");
      const store = useParsePrdStore();
      store.state = "active";

      await expect(store.stop()).rejects.toThrow("No active parse-prd session");

      expect(store.state).toBe("active"); // restored
      expect(store.error).toBe("No active parse-prd session");
      expect(store.reason).toBe("no_active_session");
    });

    it("reason stays null on network error (no 409 response)", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Network failure"));
      const store = useParsePrdStore();
      store.state = "active";

      await expect(store.stop()).rejects.toThrow();

      expect(store.reason).toBeNull();
    });

    it("does not lose terminal outcome on stop failure", async () => {
      globalThis.fetch = mockFetchErrorWithReason(409, "No active parse-prd session", "no_active_session");
      const store = useParsePrdStore();
      store.state = "completed";
      store.outcome = { status: "success" };

      await expect(store.stop()).rejects.toThrow();

      // Outcome must survive the stop failure
      expect(store.outcome).toEqual({ status: "success" });
      expect(store.state).toBe("completed"); // restored
    });
  });
});

// --- WebSocket event handling ---

describe("useParsePrdStore handleWsEvent", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // --- agent:* events ---

  it("adds text message on agent:text", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "Hello world",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("text");
    expect(store.messages[0].content).toBe("Hello world");
  });

  it("aggregates consecutive agent:text events", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "Hello ",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "world",
    });

    // Should aggregate into a single message
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].content).toBe("Hello world");
  });

  it("breaks text aggregation on non-text event", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "first",
    });
    store.handleWsEvent({
      type: "agent:tool",
      channel: "parse-prd",
      name: "Read",
      summary: "Read file.ts",
    });
    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "second",
    });

    // Three separate messages
    expect(store.messages).toHaveLength(3);
    expect(store.messages[0].content).toBe("first");
    expect(store.messages[1].type).toBe("tool");
    expect(store.messages[2].content).toBe("second");
  });

  it("adds tool message on agent:tool", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:tool",
      channel: "parse-prd",
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
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "parse-prd",
      summary: "File written",
      output: "OK",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("tool_result");
    expect(store.messages[0].content).toBe("OK");
  });

  it("prefers output over summary for tool_result content", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "parse-prd",
      summary: "summary text",
      output: "output text",
    });

    expect(store.messages[0].content).toBe("output text");
  });

  it("falls back to summary when output is absent for tool_result", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "parse-prd",
      summary: "summary text",
    });

    expect(store.messages[0].content).toBe("summary text");
  });

  it("adds context_usage message on agent:context_usage", () => {
    const store = useParsePrdStore();
    store.sessionInfo = { agent: "claude", model: "sonnet" };

    store.handleWsEvent({
      type: "agent:context_usage",
      channel: "parse-prd",
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
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:system_prompt",
      channel: "parse-prd",
      text: "You are a parse-prd agent",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("system_prompt");
    expect(store.messages[0].content).toBe("You are a parse-prd agent");
  });

  it("adds task_prompt message on agent:task_prompt", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:task_prompt",
      channel: "parse-prd",
      text: "Parse the PRD and create tasks",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("task_prompt");
    expect(store.messages[0].content).toBe("Parse the PRD and create tasks");
  });

  it("ignores agent:* events without parse-prd channel", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:text",
      channel: "execute",
      text: "wrong channel",
    });

    expect(store.messages).toEqual([]);
  });

  it("ignores agent:* events without channel", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:text",
      text: "no channel",
    });

    expect(store.messages).toEqual([]);
  });

  // --- parse-prd:* lifecycle events ---

  it("sets state=active on parse-prd:started", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "parse-prd:started",
      agent: "claude",
      model: "sonnet",
      sessionId: "s1",
    });

    expect(store.state).toBe("active");
    expect(store.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: undefined });
  });

  it("preserves variant from start() when parse-prd:started arrives without variant", () => {
    const store = useParsePrdStore();
    // Simulate what start() does — sets sessionInfo with variant
    store.sessionInfo = { agent: "claude", model: "sonnet", variant: "high" };
    store.state = "active";

    // Server broadcasts parse-prd:started without variant
    store.handleWsEvent({
      type: "parse-prd:started",
      agent: "claude",
      model: "sonnet",
      sessionId: "s1",
    });

    // variant should be preserved from the original sessionInfo
    expect(store.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: "high" });
  });

  it("updates variant from parse-prd:started when event carries it", () => {
    const store = useParsePrdStore();
    store.sessionInfo = { agent: "claude", model: "sonnet", variant: "low" };
    store.state = "active";

    // Server broadcasts parse-prd:started with variant
    store.handleWsEvent({
      type: "parse-prd:started",
      agent: "claude",
      model: "sonnet",
      sessionId: "s1",
      variant: "high",
    });

    expect(store.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: "high" });
  });

  it("skips state mutation on parse-prd:started when rehydrating", () => {
    const store = useParsePrdStore();
    store.setRehydrating(true);
    store.state = "completed"; // server snapshot
    // Simulate pre-existing sessionInfo (e.g. from connected message)
    store.sessionInfo = { agent: "claude", model: "sonnet", variant: "high" };

    store.handleWsEvent({
      type: "parse-prd:started",
      agent: "claude",
      model: "sonnet",
    });

    // State should NOT be overwritten
    expect(store.state).toBe("completed");
    // But sessionInfo IS updated (same pattern as chat store)
    expect(store.sessionInfo?.agent).toBe("claude");
    // variant preserved from pre-existing sessionInfo
    expect(store.sessionInfo?.variant).toBe("high");
  });

  it("sets error on parse-prd:error", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "parse-prd:error",
      channel: "parse-prd",
      message: "Agent crashed",
    });

    expect(store.error).toBe("Agent crashed");
    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("error");
    expect(store.messages[0].content).toBe("Agent crashed");
  });

  it("sets state=completed and outcome on parse-prd:finished with success", () => {
    const store = useParsePrdStore();
    store.state = "active";
    store.sessionInfo = { agent: "claude" };

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "success" },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "success" });
    expect(store.sessionInfo).toBeNull(); // cleared on finish
  });

  it("sets outcome with errors on parse-prd:finished with failure", () => {
    const store = useParsePrdStore();
    store.state = "active";

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "failure", errors: ["No tasks found", "Invalid format"] },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "failure", errors: ["No tasks found", "Invalid format"] });
  });

  it("sets outcome=cancelled on parse-prd:finished with cancelled", () => {
    const store = useParsePrdStore();
    store.state = "stopping";

    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "cancelled" },
    });

    expect(store.state).toBe("completed");
    expect(store.outcome).toEqual({ status: "cancelled" });
  });

  it("preserves error across parse-prd:finished", () => {
    const store = useParsePrdStore();
    store.state = "active";

    // Error event arrives first
    store.handleWsEvent({
      type: "parse-prd:error",
      channel: "parse-prd",
      message: "Something went wrong",
    });

    // Then finished
    store.handleWsEvent({
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "failure", errors: ["task validation failed"] },
    });

    // Error should be preserved
    expect(store.error).toBe("Something went wrong");
    expect(store.outcome).toEqual({ status: "failure", errors: ["task validation failed"] });
  });

  it("message IDs have pprd- prefix", () => {
    const store = useParsePrdStore();

    store.handleWsEvent({
      type: "agent:text",
      channel: "parse-prd",
      text: "hello",
    });

    expect(store.messages[0].id).toMatch(/^pprd-\d+-\d+$/);
  });
});

// Compile-time type conformance tests
describe("parse-prd store types", () => {
  it("ParsePrdMessage accepts all valid type discriminants", () => {
    const msgs: ParsePrdMessage[] = [
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

  it("ParsePrdStoreState accepts all valid values", () => {
    const states: ParsePrdStoreState[] = ["idle", "active", "stopping", "completed"];
    expect(states).toHaveLength(4);
  });

  it("ParsePrdSessionInfo and ParsePrdOutcome accept correct shapes", () => {
    const session: ParsePrdSessionInfo = { agent: "claude", model: "opus", variant: "high" };
    const outcomes: ParsePrdOutcome[] = [
      { status: "success" },
      { status: "failure", errors: ["bad"] },
      { status: "cancelled" },
    ];
    expect(session).toBeDefined();
    expect(outcomes).toHaveLength(3);
  });
});
