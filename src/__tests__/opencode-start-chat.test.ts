/**
 * Tests for OpenCodeDriver.startChat() with a mock OpenCode client.
 *
 * The client is injected directly via the private `client` field to avoid
 * spawning a real OpenCode server. The SSE stream is simulated with AsyncQueue.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenCodeDriver } from "../core/drivers/opencode.js";
import { AsyncQueue } from "../core/drivers/async-queue.js";
import type { ChatEvent, ChatOptions } from "../core/drivers/types.js";

// ---------------------------------------------------------------------------
// Types for accessing private fields
// ---------------------------------------------------------------------------

type DriverInternals = {
  client: unknown;
  chatSessionId: string | null;
  pendingQuestions: Map<string, { requestID: string }>;
  chatAbortController: AbortController | null;
  chatOptions: ChatOptions | null;
  chatReportedTools: Set<string>;
  chatSetupPromise: unknown;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const defaultChatOpts: ChatOptions = {
  systemPrompt: "You are a test assistant.",
  cwd: "/tmp/test",
  maxTurns: 10,
  verbosity: "quiet" as const,
};

/** Create a mock OpenCode client with a controllable SSE stream. */
function createMockClient(sseQueue: AsyncQueue<unknown>) {
  return {
    event: {
      subscribe: vi.fn().mockResolvedValue({
        stream: (async function* () {
          for await (const event of sseQueue) {
            yield event;
          }
        })(),
      }),
    },
    session: {
      create: vi.fn().mockResolvedValue({
        data: { id: "test-session-123" },
      }),
      promptAsync: vi.fn().mockResolvedValue({}),
      abort: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    question: {
      reply: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
    },
    config: {
      providers: vi.fn().mockResolvedValue({ data: { providers: [], default: {} } }),
    },
  };
}

/** Collect events from the chat generator until a condition or limit. */
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

/** Collect events with a timeout to prevent hanging. */
async function collectWithTimeout(
  gen: AsyncIterable<ChatEvent>,
  timeoutMs = 1000,
  limit = 50,
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  const collectPromise = (async () => {
    for await (const ev of gen) {
      events.push(ev);
      if (ev.type === "finished" || events.length >= limit) break;
    }
  })();

  await Promise.race([
    collectPromise,
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenCodeDriver.startChat()", () => {
  let driver: OpenCodeDriver;
  let sseQueue: AsyncQueue<unknown>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    driver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    sseQueue = new AsyncQueue<unknown>();
    mockClient = createMockClient(sseQueue);
    // Inject mock client
    (driver as unknown as DriverInternals).client = mockClient;
  });

  // ---- Session lifecycle ----

  it("creates session via client.session.create()", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    expect(mockClient.session.create).toHaveBeenCalledWith({
      directory: "/tmp/test",
    });

    sseQueue.close();
    await iterPromise;
  });

  it("subscribes to SSE via client.event.subscribe()", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    expect(mockClient.event.subscribe).toHaveBeenCalledWith({
      directory: "/tmp/test",
    });

    sseQueue.close();
    await iterPromise;
  });

  it("subscribes to SSE BEFORE creating session", async () => {
    const callOrder: string[] = [];
    mockClient.event.subscribe = vi.fn().mockImplementation(async () => {
      callOrder.push("subscribe");
      return {
        stream: (async function* () {
          for await (const event of sseQueue) {
            yield event;
          }
        })(),
      };
    });
    mockClient.session.create = vi.fn().mockImplementation(async () => {
      callOrder.push("create");
      return { data: { id: "test-session-123" } };
    });

    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    expect(callOrder).toEqual(["subscribe", "create"]);

    sseQueue.close();
    await iterPromise;
  });

  it("does not call promptAsync until sendMessage()", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    expect(mockClient.session.promptAsync).not.toHaveBeenCalled();

    sseQueue.close();
    await iterPromise;
  });

  it("sets chatSessionId after successful session creation", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    const internals = driver as unknown as DriverInternals;
    expect(internals.chatSessionId).toBe("test-session-123");

    sseQueue.close();
    await iterPromise;
  });

  it("double startChat throws Error", () => {
    driver.startChat(defaultChatOpts);
    // Second call should throw immediately (guard is synchronous)
    expect(() => driver.startChat(defaultChatOpts)).toThrow(
      "Chat session already active. Call abortChat() first.",
    );
  });

  it("throws when client not initialized", () => {
    const noClientDriver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    expect(() => noClientDriver.startChat(defaultChatOpts)).toThrow(
      "OpenCodeDriver: client not initialized — call setup() first",
    );
  });

  it("throws when session creation fails", async () => {
    mockClient.session.create = vi.fn().mockResolvedValue({
      error: { message: "quota exceeded" },
    });

    const gen = driver.startChat(defaultChatOpts);

    await expect(collectEvents(gen)).rejects.toThrow(
      "Failed to create chat session",
    );
  });

  // ---- Eager state initialization ----

  it("eagerly initializes chatAbortController", () => {
    driver.startChat(defaultChatOpts);
    const internals = driver as unknown as DriverInternals;
    expect(internals.chatAbortController).toBeInstanceOf(AbortController);
  });

  it("eagerly clears pendingQuestions", () => {
    const internals = driver as unknown as DriverInternals;
    // Simulate leftover state
    internals.pendingQuestions.set("old", { requestID: "old-req" });

    driver.startChat(defaultChatOpts);
    expect(internals.pendingQuestions.size).toBe(0);
  });

  it("eagerly saves chatOptions", () => {
    driver.startChat(defaultChatOpts);
    const internals = driver as unknown as DriverInternals;
    expect(internals.chatOptions).toBe(defaultChatOpts);
  });

  it("eagerly starts session setup (chatSetupPromise is set)", () => {
    driver.startChat(defaultChatOpts);
    const internals = driver as unknown as DriverInternals;
    expect(internals.chatSetupPromise).toBeDefined();
    expect(internals.chatSetupPromise).not.toBeNull();
  });

  it("chatSessionId is set after setup promise resolves (before generator consumption)", async () => {
    driver.startChat(defaultChatOpts);
    // Do NOT consume the generator — just await the setup promise
    await tick();

    const internals = driver as unknown as DriverInternals;
    expect(internals.chatSessionId).toBe("test-session-123");

    // Clean up — abort and close
    driver.abortChat();
    sseQueue.close();
  });

  // ---- Cleanup ----

  it("cleans up state after generator completes", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    // Close the SSE stream to end the generator
    sseQueue.close();
    await iterPromise;

    const internals = driver as unknown as DriverInternals;
    expect(internals.chatSessionId).toBeNull();
    expect(internals.chatAbortController).toBeNull();
    expect(internals.chatOptions).toBeNull();
    expect(internals.pendingQuestions.size).toBe(0);
    expect(internals.chatReportedTools.size).toBe(0);
    expect(internals.chatSetupPromise).toBeNull();
  });

  it("cleans up state after session creation error", async () => {
    mockClient.session.create = vi.fn().mockResolvedValue({
      error: { message: "failed" },
    });

    const gen = driver.startChat(defaultChatOpts);
    try {
      await collectEvents(gen);
    } catch {
      // Expected
    }

    const internals = driver as unknown as DriverInternals;
    expect(internals.chatSessionId).toBeNull();
    expect(internals.chatAbortController).toBeNull();
    expect(internals.chatOptions).toBeNull();
    expect(internals.chatSetupPromise).toBeNull();
  });

  // ---- SSE event processing: session events ----

  it("yields idle event on session.idle for our session", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    const result = await iterPromise;
    expect(result.value).toEqual({ type: "idle" });

    sseQueue.close();
  });

  it("ignores session.idle for other sessions", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Push idle for a different session
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "other-session" },
    });

    // Push idle for our session
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    const result = await firstNext;
    expect(result.value).toEqual({ type: "idle" });

    sseQueue.close();
  });

  it("yields error event on session.error for our session", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "session.error",
      properties: {
        sessionID: "test-session-123",
        error: { message: "rate limit" },
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({
      type: "error",
      message: 'Session error: {"message":"rate limit"}',
    });

    sseQueue.close();
  });

  it("yields error event for session.error without sessionID (assumes ours)", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "session.error",
      properties: { error: "unknown failure" },
    });

    const result = await firstNext;
    expect(result.value).toEqual({
      type: "error",
      message: 'Session error: "unknown failure"',
    });

    sseQueue.close();
  });

  // ---- SSE event processing: text ----

  it("yields text event from message.part.updated with text type", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "part-1",
          text: "Hello world",
        },
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({ type: "text", content: "Hello world" });

    sseQueue.close();
  });

  it("yields text event from message.part.delta", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "message.part.delta",
      properties: {
        sessionID: "test-session-123",
        partID: "part-1",
        field: "text",
        delta: "Hello ",
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({ type: "text", content: "Hello " });

    sseQueue.close();
  });

  it("ignores text parts from other sessions", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Push text for a different session
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "other-session",
          id: "part-1",
          text: "Not for us",
        },
      },
    });

    // Push text for our session
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "part-2",
          text: "For us",
        },
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({ type: "text", content: "For us" });

    sseQueue.close();
  });

  it("skips empty text parts", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Empty text — should be skipped
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "part-1",
          text: "",
        },
      },
    });

    // Non-empty text
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "part-2",
          text: "actual text",
        },
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({ type: "text", content: "actual text" });

    sseQueue.close();
  });

  // ---- SSE event processing: tools ----

  it("yields tool event from message.part.updated with tool type (running)", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-1",
          tool: "Read",
          state: {
            status: "running",
            input: { file_path: "/tmp/test.ts" },
          },
        },
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({
      type: "tool",
      name: "Read",
      input: { file_path: "/tmp/test.ts" },
    });

    sseQueue.close();
  });

  it("yields tool_result event when tool completes with output", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    // First: tool running (yields tool event)
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-1",
          tool: "Read",
          state: {
            status: "running",
            input: { file_path: "/tmp/test.ts" },
          },
        },
      },
    });
    await iterPromise;

    // Second: tool completed (yields tool_result event)
    const nextPromise = (gen as AsyncGenerator).next();
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-1",
          tool: "Read",
          state: {
            status: "completed",
            input: { file_path: "/tmp/test.ts" },
            output: "file contents here",
          },
        },
      },
    });

    const result = await nextPromise;
    // Should be tool_result since tool dispatch was already reported
    expect(result.value).toEqual({
      type: "tool_result",
      name: "Read",
      output: "file contents here",
    });

    sseQueue.close();
  });

  it("yields tool_result for tool errors", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-1",
          tool: "Bash",
          state: {
            status: "error",
            error: "command not found",
          },
        },
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({
      type: "tool_result",
      name: "Bash",
      output: "ERROR: command not found",
    });

    sseQueue.close();
  });

  it("deduplicates tool dispatch events for the same part ID", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const events: ChatEvent[] = [];

    // Start consuming
    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
        if (events.length >= 4) break;
      }
    })();
    await tick();

    // Send running event twice for the same tool part
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-1",
          tool: "Read",
          state: {
            status: "running",
            input: { file_path: "/tmp/test.ts" },
          },
        },
      },
    });
    await tick();

    // Same part, updated (still running, more input or progress)
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-1",
          tool: "Read",
          state: {
            status: "running",
            input: { file_path: "/tmp/test.ts" },
          },
        },
      },
    });
    await tick();

    // Now completed
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-1",
          tool: "Read",
          state: {
            status: "completed",
            input: { file_path: "/tmp/test.ts" },
            output: "done",
          },
        },
      },
    });
    await tick();

    // Close to let second tool through
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    sseQueue.close();
    await collectPromise;

    // Should have: 1 tool dispatch, 1 tool_result, 1 idle
    const toolEvents = events.filter((e) => e.type === "tool");
    const toolResults = events.filter((e) => e.type === "tool_result");
    expect(toolEvents).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
  });

  // ---- SSE event processing: questions ----

  it("yields question event from question.asked for our session", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-42",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js" },
              { label: "Vue", description: "Vue.js" },
            ],
            multiple: false,
          },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value as ChatEvent;
    expect(ev.type).toBe("question");
    if (ev.type === "question") {
      expect(ev.questionId).toMatch(/^oq-\d+-1$/);
      expect(ev.questions).toHaveLength(1);
      expect(ev.questions[0].question).toBe("Which framework?");
      expect(ev.questions[0].header).toBe("Framework");
      expect(ev.questions[0].options).toEqual([
        { label: "React", description: "React.js" },
        { label: "Vue", description: "Vue.js" },
      ]);
      expect(ev.questions[0].multiSelect).toBe(false);
      expect(ev.source).toBe("opencode");
    }

    sseQueue.close();
  });

  it("stores requestID in pendingQuestions on question.asked", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-42",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Pick?",
            header: "Pick",
            options: [{ label: "A", description: "a" }],
          },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value as ChatEvent;

    if (ev.type === "question") {
      const internals = driver as unknown as DriverInternals;
      const pending = internals.pendingQuestions.get(ev.questionId);
      expect(pending).toBeDefined();
      expect(pending!.requestID).toBe("req-42");
    }

    sseQueue.close();
  });

  it("maps multiple=true to multiSelect=true in question events", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-multi",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Select features",
            header: "Features",
            options: [
              { label: "Auth", description: "auth" },
              { label: "DB", description: "database" },
            ],
            multiple: true,
          },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value as ChatEvent;
    if (ev.type === "question") {
      expect(ev.questions[0].multiSelect).toBe(true);
    }

    sseQueue.close();
  });

  it("ignores question.asked for other sessions", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Question for different session — should be ignored
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-other",
        sessionID: "other-session",
        questions: [
          {
            question: "Not for us",
            header: "X",
            options: [{ label: "A", description: "a" }],
          },
        ],
      },
    });

    // Our session idle
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    const result = await firstNext;
    expect(result.value).toEqual({ type: "idle" });

    sseQueue.close();
  });

  // ---- SSE event processing: step-finish / context_usage ----

  it("yields context_usage event from step-finish", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "test-session-123",
          id: "sf-1",
          reason: "end_turn",
          tokens: {
            input: 1000,
            output: 500,
            reasoning: 200,
            cache: { read: 300, write: 100 },
          },
          cost: 0.05,
        },
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({
      type: "context_usage",
      usage: {
        contextTokens: 1400,
        contextWindow: 200_000,
        model: "anthropic/claude-sonnet-4-6",
      },
    });

    sseQueue.close();
  });

  // ---- SSE event processing: abort ----

  it("stops event loop when abortController is aborted", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    // Abort the chat
    const internals = driver as unknown as DriverInternals;
    internals.chatAbortController!.abort();

    // Push an event (should be ignored since aborted)
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    sseQueue.close();
    const result = await iterPromise;
    expect(result.done).toBe(true);
  });

  // ---- SSE event processing: unknown events ----

  it("ignores unknown event types", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Unknown event type — should be silently ignored
    sseQueue.push({
      type: "installation.updated",
      properties: { version: "2.0.0" },
    });

    // Push a real event
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    const result = await firstNext;
    expect(result.value).toEqual({ type: "idle" });

    sseQueue.close();
  });

  // ---- Multiple events from a single SSE event ----

  it("yields multiple ChatEvents from a single SSE event (tool completed with input + output)", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const events: ChatEvent[] = [];

    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
        if (events.length >= 3) break;
      }
    })();
    await tick();

    // A completed tool event produces both tool and tool_result
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-combo",
          tool: "Bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file1.ts\nfile2.ts",
          },
        },
      },
    });

    // Push an idle to give us a third event
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    await collectPromise;

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: "tool",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(events[1]).toEqual({
      type: "tool_result",
      name: "Bash",
      output: "file1.ts\nfile2.ts",
    });
    expect(events[2]).toEqual({ type: "idle" });

    sseQueue.close();
  });
});
