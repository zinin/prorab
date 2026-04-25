/**
 * Tests for ClaudeDriver.startChat() with a fake SDK.
 *
 * The SDK's `query()` function is mocked at the module level so we can
 * control the stream of SDKMessage objects the driver receives, as well as
 * inspect the `canUseTool` callback passed via options.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import type { ChatEvent, QuestionAnswers } from "../core/drivers/types.js";
import { AsyncQueue } from "../core/drivers/async-queue.js";

// ---------------------------------------------------------------------------
// Mock the SDK
// ---------------------------------------------------------------------------

/** We capture canUseTool from the options passed to query() */
let capturedCanUseTool:
  | ((
      toolName: string,
      toolInput: Record<string, unknown>,
      opts: { signal: AbortSignal; toolUseID: string },
    ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>)
  | undefined;

/** Queue of SDK messages the fake session will yield. */
let sdkQueue: AsyncQueue<Record<string, unknown>>;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ options }: { prompt: unknown; options: Record<string, unknown> }) => {
    capturedCanUseTool = options.canUseTool as typeof capturedCanUseTool;

    // Return an async generator that yields from sdkQueue
    const gen = (async function* () {
      for await (const msg of sdkQueue) {
        yield msg;
      }
    })();

    // Mimic the Query interface: an async generator with extra methods
    return Object.assign(gen, {
      interrupt: vi.fn(),
      setPermissionMode: vi.fn(),
      setModel: vi.fn(),
      setMaxThinkingTokens: vi.fn(),
      initializationResult: vi.fn(),
      supportedCommands: vi.fn(),
      supportedModels: vi.fn(),
      mcpServerStatus: vi.fn(),
      accountInfo: vi.fn(),
      rewindFiles: vi.fn(),
      reconnectMcpServer: vi.fn(),
      toggleMcpServer: vi.fn(),
      setMcpServers: vi.fn(),
      streamInput: vi.fn(),
      stopTask: vi.fn(),
      close: vi.fn(),
    });
  }),
}));

// Import after mock is set up
const { ClaudeDriver } = await import("../core/drivers/claude.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const defaultChatOpts = {
  systemPrompt: "You are a test assistant.",
  cwd: "/tmp/test",
  maxTurns: 10,
  verbosity: "quiet" as const,
};

/** Collect events from the chat generator until `finished` or limit reached. */
async function collectEvents(
  gen: AsyncIterable<ChatEvent>,
  limit = 50,
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const ev of gen) {
    events.push(ev);
    if (ev.type === "finished" || events.length >= limit) break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeDriver.startChat()", () => {
  let driver: InstanceType<typeof ClaudeDriver>;

  beforeEach(() => {
    driver = new ClaudeDriver();
    sdkQueue = new AsyncQueue<Record<string, unknown>>();
    capturedCanUseTool = undefined;
  });

  it("creates session and yields text events from SDK messages", async () => {
    const gen = driver.startChat(defaultChatOpts);
    // Allow the generator to start and SDK query to be called
    await tick();

    // Send a user message to trigger the SDK
    driver.sendMessage("Hello");
    await tick();

    // Simulate SDK producing an assistant text message
    sdkQueue.push({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Hello back!" }],
      },
    });
    await tick();

    // End the SDK session
    sdkQueue.close();

    const events = await collectEvents(gen);

    expect(events).toContainEqual({ type: "text", content: "Hello back!" });
    expect(events[events.length - 1]).toEqual({ type: "finished" });
  });

  it("yields tool and tool_result events", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Do something");
    await tick();

    // Assistant uses a tool
    sdkQueue.push({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/test.ts" } },
        ],
      },
    });

    // Tool result summary
    sdkQueue.push({
      type: "tool_use_summary",
      summary: "Read 42 lines from /test.ts",
    });

    sdkQueue.close();

    const events = await collectEvents(gen);

    expect(events).toContainEqual({
      type: "tool",
      name: "Read",
      input: { file_path: "/test.ts" },
    });
    expect(events).toContainEqual({
      type: "tool_result",
      name: "tool",
      output: "Read 42 lines from /test.ts",
    });
  });

  it("yields context_usage from result using last stream_event usage", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Check usage");
    await tick();

    // stream_event stores per-API-call usage (not emitted as event)
    sdkQueue.push({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          usage: { input_tokens: 1000, cache_read_input_tokens: 500 },
        },
      },
    });

    // result triggers context_usage emission using the stored stream value
    sdkQueue.push({
      type: "result",
      subtype: "success",
      model: "",
      modelUsage: {},
    });

    sdkQueue.close();

    const events = await collectEvents(gen);
    const usageEvent = events.find((e) => e.type === "context_usage");
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.type === "context_usage" && usageEvent!.usage).toEqual({
      contextTokens: 1500,
      contextWindow: 200_000,
      model: "",
    });
  });

  it("context_usage uses cumulative delta when no stream_event available", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("No stream events");
    await tick();

    // result with modelUsage but no preceding stream_event — falls back to delta
    sdkQueue.push({
      type: "result",
      subtype: "success",
      model: "claude-opus-4-6",
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 100,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 0,
        },
      },
    });

    sdkQueue.close();

    const events = await collectEvents(gen);
    const usageEvent = events.find((e) => e.type === "context_usage");
    expect(usageEvent).toBeDefined();
    expect(usageEvent!.type === "context_usage" && usageEvent!.usage).toEqual({
      contextTokens: 2100,
      contextWindow: 1_000_000,
      model: "claude-opus-4-6",
    });
  });

  it("context_usage prefers last stream_event over cumulative delta during tool use", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Use tools");
    await tick();

    // Simulate multi-API-call turn: 3 stream_events (tool use sub-turns)
    // Each message_start has progressively more tokens as conversation grows
    sdkQueue.push({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 40_000 } },
      },
    });
    sdkQueue.push({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { usage: { input_tokens: 200, cache_read_input_tokens: 42_000 } },
      },
    });
    sdkQueue.push({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { usage: { input_tokens: 300, cache_read_input_tokens: 44_000 } },
      },
    });

    // result with cumulative modelUsage (sum of all 3 sub-turns = 126,600)
    // The driver should use the LAST stream_event (44,300) not the delta (126,600)
    sdkQueue.push({
      type: "result",
      subtype: "success",
      model: "claude-opus-4-6",
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 600,
          cacheReadInputTokens: 126_000,
          cacheCreationInputTokens: 0,
        },
      },
    });

    sdkQueue.close();

    const events = await collectEvents(gen);
    const usageEvent = events.find((e) => e.type === "context_usage");
    expect(usageEvent).toBeDefined();
    // Should be the LAST stream_event value (44,300), NOT the cumulative delta (126,600)
    expect(usageEvent!.type === "context_usage" && usageEvent!.usage).toEqual({
      contextTokens: 44_300,
      contextWindow: 1_000_000,
      model: "claude-opus-4-6",
    });
  });

  it("canUseTool auto-approves non-AskUserQuestion tools and echoes input as updatedInput", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Use a tool");
    await tick();

    // canUseTool should have been captured from the query options
    expect(capturedCanUseTool).toBeDefined();

    const result = await capturedCanUseTool!(
      "Bash",
      { command: "ls" },
      { signal: new AbortController().signal, toolUseID: "tu-1" },
    );

    // `updatedInput` is required by the Claude Code permission-result Zod
    // schema; without it the response is rejected and the tool call denied.
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });

    sdkQueue.close();
    await collectEvents(gen);
  });

  it("canUseTool intercepts AskUserQuestion and publishes question event", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Ask me something");
    await tick();

    expect(capturedCanUseTool).toBeDefined();

    // Simulate the agent calling AskUserQuestion
    const canUseToolPromise = capturedCanUseTool!(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiSelect: false,
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: "tu-ask-1" },
    );

    // The canUseTool callback should be awaiting the answer.
    // Meanwhile, a question event should appear in the chat stream.
    await tick();

    // Collect events that have been yielded so far (non-blocking via timeout)
    // We need to start consuming the generator to get the question event
    const eventPromise = new Promise<ChatEvent>((resolve) => {
      (async () => {
        for await (const ev of gen) {
          if (ev.type === "question") {
            resolve(ev);
            break;
          }
        }
      })();
    });

    // Push a dummy SDK message to trigger the merge loop
    sdkQueue.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Let me ask..." }] },
    });

    const questionEvent = await eventPromise;
    expect(questionEvent.type).toBe("question");
    if (questionEvent.type === "question") {
      expect(questionEvent.questions).toHaveLength(1);
      expect(questionEvent.questions[0].question).toBe("Which framework?");
      expect(questionEvent.questions[0].options).toHaveLength(2);
      expect(questionEvent.source).toBe("claude");

      // Now reply to the question
      driver.replyQuestion(questionEvent.questionId, {
        "Which framework?": "React",
      });
    }

    // The canUseTool callback should now resolve
    const result = await canUseToolPromise;
    expect(result.behavior).toBe("allow");
    expect(result.updatedInput).toBeDefined();
    expect((result.updatedInput as Record<string, unknown>).answers).toEqual({
      "Which framework?": "React",
    });

    // Clean up
    sdkQueue.close();
  });

  it("abortChat rejects pending questions and closes queues", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Ask me");
    await tick();

    expect(capturedCanUseTool).toBeDefined();

    // Start a question that will be pending
    const canUseToolPromise = capturedCanUseTool!(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Pick one?",
            header: "Pick",
            options: [{ label: "A", description: "Option A" }],
            multiSelect: false,
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: "tu-ask-abort" },
    );

    await tick();

    // Abort the chat — the canUseTool callback catches the abort error
    // internally and returns a graceful allow with the original input as
    // `updatedInput` (required by the Claude Code permission-result schema)
    // to avoid unhandled rejections in the Claude Agent SDK.
    driver.abortChat();

    await expect(canUseToolPromise).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            question: "Pick one?",
            header: "Pick",
            options: [{ label: "A", description: "Option A" }],
            multiSelect: false,
          },
        ],
      },
    });

    // sendMessage should now throw since queues are closed
    expect(() => driver.sendMessage("more")).toThrow();

    // The generator should eventually finish after abort
    sdkQueue.close();
  });

  it("sendMessage throws when no active chat session", () => {
    const driver = new ClaudeDriver();
    expect(() => driver.sendMessage("hi")).toThrow(
      "No active chat session. Call startChat() first.",
    );
  });

  it("replyQuestion throws for unknown question id", () => {
    const driver = new ClaudeDriver();
    expect(() => driver.replyQuestion("q-unknown", {})).toThrow(
      "No pending question with id 'q-unknown'. Available: none",
    );
  });

  it("cleanupChat is called after generator completes", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Quick session");
    await tick();

    // End the SDK session immediately
    sdkQueue.close();

    const events = await collectEvents(gen);
    expect(events[events.length - 1]).toEqual({ type: "finished" });

    // After cleanup, sendMessage should throw (no active session)
    expect(() => driver.sendMessage("after")).toThrow(
      "No active chat session. Call startChat() first.",
    );
  });

  it("extractQuestions handles missing or malformed questions array", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Malformed question");
    await tick();

    expect(capturedCanUseTool).toBeDefined();

    // Call canUseTool with no questions array — should still work
    const canUseToolPromise = capturedCanUseTool!(
      "AskUserQuestion",
      { /* no questions field */ },
      { signal: new AbortController().signal, toolUseID: "tu-malformed" },
    );

    await tick();

    // A question event should be published with empty questions array
    // We need to consume the stream and find the question event
    const eventCollector = new Promise<ChatEvent | null>((resolve) => {
      const timeout = setTimeout(() => resolve(null), 200);
      (async () => {
        for await (const ev of gen) {
          if (ev.type === "question") {
            clearTimeout(timeout);
            resolve(ev);
            break;
          }
        }
      })();
    });

    // Trigger the merge loop
    sdkQueue.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "..." }] },
    });

    const questionEvent = await eventCollector;
    expect(questionEvent).not.toBeNull();
    if (questionEvent?.type === "question") {
      expect(questionEvent.questions).toEqual([]);

      // Reply to unblock the canUseTool callback
      driver.replyQuestion(questionEvent.questionId, {});
    }

    const result = await canUseToolPromise;
    expect(result.behavior).toBe("allow");

    sdkQueue.close();
  });

  it("multiple sendMessage calls queue messages in order", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();

    // Send multiple messages
    driver.sendMessage("First");
    driver.sendMessage("Second");
    driver.sendMessage("Third");
    await tick();

    // The messages are queued in the messageQueue.
    // Simulate SDK responding to each turn with assistant text
    sdkQueue.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Response 1" }] },
    });
    sdkQueue.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Response 2" }] },
    });
    sdkQueue.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Response 3" }] },
    });
    sdkQueue.close();

    const events = await collectEvents(gen);
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(3);
    expect(textEvents.map((e) => e.type === "text" && e.content)).toEqual([
      "Response 1",
      "Response 2",
      "Response 3",
    ]);
  });

  it("uses permissionMode 'default' for chat sessions", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("test");
    await tick();

    // Check the options passed to query()
    const lastCall = (mockQuery as Mock).mock.lastCall;
    expect(lastCall).toBeDefined();
    const opts = lastCall![0].options;
    expect(opts.permissionMode).toBe("default");
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.canUseTool).toBeDefined();

    sdkQueue.close();
    await collectEvents(gen);
  });

  it("startChat throws when a session is already active", async () => {
    // Start a first session
    const gen1 = driver.startChat(defaultChatOpts);
    await tick();

    // Attempting to start a second session should throw
    expect(() => driver.startChat(defaultChatOpts)).toThrow(
      "A chat session is already active. Call abortChat() before starting a new one.",
    );

    // Clean up the first session
    driver.abortChat();
    sdkQueue.close();
  });

  it("startChat works after abortChat clears the previous session", async () => {
    // Start and abort a session
    const gen1 = driver.startChat(defaultChatOpts);
    await tick();
    driver.abortChat();
    sdkQueue.close();

    // Reset SDK mock queue for the new session
    sdkQueue = new AsyncQueue<Record<string, unknown>>();

    // Starting a new session should work
    const gen2 = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Hello again");
    await tick();

    sdkQueue.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Welcome back" }] },
    });
    sdkQueue.close();

    const events = await collectEvents(gen2);
    expect(events).toContainEqual({ type: "text", content: "Welcome back" });
  });

  it("canUseTool normalizes multi-select array answers to comma-separated strings", async () => {
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Multi-select question");
    await tick();

    expect(capturedCanUseTool).toBeDefined();

    // Simulate AskUserQuestion with a multi-select question
    const canUseToolPromise = capturedCanUseTool!(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "Which features?",
            header: "Features",
            options: [
              { label: "Auth", description: "Authentication" },
              { label: "Logging", description: "Logging system" },
              { label: "Caching", description: "Cache layer" },
            ],
            multiSelect: true,
          },
        ],
      },
      { signal: new AbortController().signal, toolUseID: "tu-multi" },
    );
    await tick();

    // Consume the stream to get the question event
    const eventPromise = new Promise<ChatEvent>((resolve) => {
      (async () => {
        for await (const ev of gen) {
          if (ev.type === "question") {
            resolve(ev);
            break;
          }
        }
      })();
    });

    // Trigger the merge loop
    sdkQueue.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Asking..." }] },
    });

    const questionEvent = await eventPromise;
    expect(questionEvent.type).toBe("question");

    if (questionEvent.type === "question") {
      // Reply with a multi-select answer (string[])
      driver.replyQuestion(questionEvent.questionId, {
        "Which features?": ["Auth", "Logging", "Caching"],
      });
    }

    const result = await canUseToolPromise;
    expect(result.behavior).toBe("allow");
    // The answers should be normalized to comma-separated strings
    expect((result.updatedInput as Record<string, unknown>).answers).toEqual({
      "Which features?": "Auth, Logging, Caching",
    });

    sdkQueue.close();
  });

  it("mergeChatStreams handles SDK AbortError gracefully", async () => {
    // We need a custom SDK queue that throws AbortError
    const gen = driver.startChat(defaultChatOpts);
    await tick();
    driver.sendMessage("Will be aborted");
    await tick();

    // Push one message, then abort the chat
    sdkQueue.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "Before abort" }] },
    });
    await tick();

    // Abort the chat — should close queues gracefully
    driver.abortChat();
    sdkQueue.close();

    // The generator should terminate with a finished event, not throw
    const events: ChatEvent[] = [];
    // Use a timeout to prevent hanging if generator doesn't terminate
    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
        if (ev.type === "finished" || ev.type === "error") break;
      }
    })();

    await Promise.race([
      collectPromise,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);

    // Should have finished without throwing
    const lastEvent = events[events.length - 1];
    expect(lastEvent).toBeDefined();
    expect(["finished", "error"]).toContain(lastEvent.type);
  });

  it("passes model and variant to SDK options when set", async () => {
    const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");

    const modelDriver = new ClaudeDriver("claude-sonnet-4-6");
    const gen = modelDriver.startChat({
      ...defaultChatOpts,
      variant: "low",
    });
    await tick();
    modelDriver.sendMessage("test");
    await tick();

    const lastCall = (mockQuery as Mock).mock.lastCall;
    const opts = lastCall![0].options;
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.effort).toBe("low");

    sdkQueue.close();
    await collectEvents(gen);
  });
});
