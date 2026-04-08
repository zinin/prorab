/**
 * Tests for OpenCodeDriver.sendMessage(), replyQuestion(), and abortChat()
 * with a mock OpenCode client.
 *
 * The client is injected directly via the private `client` field to avoid
 * spawning a real OpenCode server.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenCodeDriver } from "../core/drivers/opencode.js";
import { AsyncQueue } from "../core/drivers/async-queue.js";
import type { ChatOptions, QuestionAnswers } from "../core/drivers/types.js";

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

// ---------------------------------------------------------------------------
// sendMessage tests
// ---------------------------------------------------------------------------

describe("OpenCodeDriver.sendMessage()", () => {
  let driver: OpenCodeDriver;
  let sseQueue: AsyncQueue<unknown>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    driver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    sseQueue = new AsyncQueue<unknown>();
    mockClient = createMockClient(sseQueue);
    (driver as unknown as DriverInternals).client = mockClient;
  });

  it("calls client.session.promptAsync with the correct arguments", async () => {
    // Start a chat session so chatSessionId gets set
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    driver.sendMessage("Hello agent");

    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "test-session-123",
      directory: "/tmp/test",
      system: "You are a test assistant.",
      parts: [{ type: "text", text: "Hello agent" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    sseQueue.close();
    await iterPromise;
  });

  it("throws when no active chat session (client is null)", () => {
    const noClientDriver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    expect(() => noClientDriver.sendMessage("test")).toThrow(
      "No active chat session. Call startChat() first.",
    );
  });

  it("throws when no active chat session (chatSessionId is null)", () => {
    // Client is set but no chat session started
    (driver as unknown as DriverInternals).client = mockClient;
    (driver as unknown as DriverInternals).chatSessionId = null;

    expect(() => driver.sendMessage("test")).toThrow(
      "No active chat session. Call startChat() first.",
    );
  });

  it("handles promptAsync failure by pushing error to internal queue", async () => {
    mockClient.session.promptAsync = vi.fn().mockRejectedValue(new Error("network error"));

    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    driver.sendMessage("Hello");
    // Wait for the promise rejection to be caught
    await tick();

    // Error should appear as the next event in the stream (via internal queue)
    const result = await iterPromise;
    expect(result.value).toEqual({
      type: "error",
      message: expect.stringContaining("sendMessage failed"),
    });

    sseQueue.close();
  });

  it("can call sendMessage() before consuming the generator (buffers until session ready)", async () => {
    const gen = driver.startChat(defaultChatOpts);
    // Do NOT consume the generator — sendMessage() should buffer until session is ready
    await tick(); // Allow setup promise to resolve

    driver.sendMessage("Hello before consuming");
    await tick(); // Allow the doSend async to complete

    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "test-session-123",
      directory: "/tmp/test",
      system: "You are a test assistant.",
      parts: [{ type: "text", text: "Hello before consuming" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    sseQueue.close();
    // Consume the generator to let it complete (cleanup runs in finally block)
    for await (const _ of gen) { break; }
  });

  it("can send multiple messages sequentially", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    driver.sendMessage("First message");
    driver.sendMessage("Second message");

    expect(mockClient.session.promptAsync).toHaveBeenCalledTimes(2);
    expect(mockClient.session.promptAsync).toHaveBeenNthCalledWith(1, {
      sessionID: "test-session-123",
      directory: "/tmp/test",
      system: "You are a test assistant.",
      parts: [{ type: "text", text: "First message" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });
    expect(mockClient.session.promptAsync).toHaveBeenNthCalledWith(2, {
      sessionID: "test-session-123",
      directory: "/tmp/test",
      system: "You are a test assistant.",
      parts: [{ type: "text", text: "Second message" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    sseQueue.close();
    await iterPromise;
  });
});

// ---------------------------------------------------------------------------
// replyQuestion tests
// ---------------------------------------------------------------------------

describe("OpenCodeDriver.replyQuestion()", () => {
  let driver: OpenCodeDriver;
  let sseQueue: AsyncQueue<unknown>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    driver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    sseQueue = new AsyncQueue<unknown>();
    mockClient = createMockClient(sseQueue);
    (driver as unknown as DriverInternals).client = mockClient;
  });

  it("calls client.question.reply with the correct requestID and answers", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Simulate a question being asked
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
          },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value;
    expect(ev.type).toBe("question");

    if (ev.type === "question") {
      const answers: QuestionAnswers = { "Which framework?": "React" };
      driver.replyQuestion(ev.questionId, answers);

      expect(mockClient.question.reply).toHaveBeenCalledWith({
        requestID: "req-42",
        answers: [["React"]],
      });
    }

    sseQueue.close();
  });

  it("removes the question from pendingQuestions after reply", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-99",
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
    const ev = result.value;

    if (ev.type === "question") {
      const internals = driver as unknown as DriverInternals;
      expect(internals.pendingQuestions.has(ev.questionId)).toBe(true);

      driver.replyQuestion(ev.questionId, { Pick: "A" });

      // Delete is async (after reply resolves) — flush microtask queue
      await tick();
      expect(internals.pendingQuestions.has(ev.questionId)).toBe(false);
    }

    sseQueue.close();
  });

  it("throws when questionId is unknown", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    expect(() => driver.replyQuestion("nonexistent-id", { q: "a" })).toThrow(
      "No pending question with id 'nonexistent-id'",
    );
    expect(() => driver.replyQuestion("nonexistent-id", { q: "a" })).toThrow(
      "Available: none",
    );

    sseQueue.close();
    await iterPromise;
  });

  it("includes available question IDs in error message", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Add a pending question
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-1",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Q?",
            header: "H",
            options: [{ label: "X", description: "x" }],
          },
        ],
      },
    });

    await firstNext;

    try {
      driver.replyQuestion("wrong-id", { q: "a" });
      expect.fail("Should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("No pending question with id 'wrong-id'");
      expect((err as Error).message).toMatch(/Available: oq-\d+-1/);
    }

    sseQueue.close();
  });

  it("throws when client is not initialized", () => {
    const noClientDriver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    expect(() => noClientDriver.replyQuestion("q1", { q: "a" })).toThrow(
      "No active chat session.",
    );
  });

  it("handles multi-select answers (flattens arrays)", async () => {
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
              { label: "Cache", description: "cache" },
            ],
            multiple: true,
          },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value;

    if (ev.type === "question") {
      const answers: QuestionAnswers = {
        "Select features": ["Auth", "Cache"],
      };
      driver.replyQuestion(ev.questionId, answers);

      expect(mockClient.question.reply).toHaveBeenCalledWith({
        requestID: "req-multi",
        answers: [["Auth", "Cache"]],
      });
    }

    sseQueue.close();
  });

  it("handles mixed single and multi-select answers", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-mixed",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Q1",
            header: "H1",
            options: [{ label: "A", description: "a" }],
          },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value;

    if (ev.type === "question") {
      const answers: QuestionAnswers = {
        "single-q": "React",
        "multi-q": ["Auth", "DB"],
      };
      driver.replyQuestion(ev.questionId, answers);

      expect(mockClient.question.reply).toHaveBeenCalledWith({
        requestID: "req-mixed",
        answers: [["React"], ["Auth", "DB"]],
      });
    }

    sseQueue.close();
  });

  it("handles reply failure by pushing error to internal queue", async () => {
    mockClient.question.reply = vi.fn().mockRejectedValue(new Error("reply failed"));

    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-fail",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Q?",
            header: "H",
            options: [{ label: "A", description: "a" }],
          },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value;

    if (ev.type === "question") {
      driver.replyQuestion(ev.questionId, { Q: "A" });
      await tick();

      // Error should appear as the next event in the stream (via internal queue)
      const nextResult = await (gen as AsyncGenerator).next();
      expect(nextResult.value).toEqual({
        type: "error",
        message: expect.stringContaining("replyQuestion failed"),
      });
    }

    sseQueue.close();
  });
});

// ---------------------------------------------------------------------------
// abortChat tests
// ---------------------------------------------------------------------------

describe("OpenCodeDriver.abortChat()", () => {
  let driver: OpenCodeDriver;
  let sseQueue: AsyncQueue<unknown>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    driver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    sseQueue = new AsyncQueue<unknown>();
    mockClient = createMockClient(sseQueue);
    (driver as unknown as DriverInternals).client = mockClient;
  });

  it("calls session.abort with the correct sessionID", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    driver.abortChat();

    expect(mockClient.session.abort).toHaveBeenCalledWith({
      sessionID: "test-session-123",
    });

    sseQueue.close();
    await iterPromise;
  });

  it("calls question.reject for all pending questions", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Push two questions
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-1",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Q1?",
            header: "H1",
            options: [{ label: "A", description: "a" }],
          },
        ],
      },
    });
    await firstNext;

    const secondNext = (gen as AsyncGenerator).next();
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-2",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Q2?",
            header: "H2",
            options: [{ label: "B", description: "b" }],
          },
        ],
      },
    });
    await secondNext;

    driver.abortChat();

    expect(mockClient.question.reject).toHaveBeenCalledTimes(2);
    expect(mockClient.question.reject).toHaveBeenCalledWith({
      requestID: "req-1",
    });
    expect(mockClient.question.reject).toHaveBeenCalledWith({
      requestID: "req-2",
    });

    sseQueue.close();
  });

  it("clears pendingQuestions after abort", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-1",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Q?",
            header: "H",
            options: [{ label: "A", description: "a" }],
          },
        ],
      },
    });
    await firstNext;

    const internals = driver as unknown as DriverInternals;
    expect(internals.pendingQuestions.size).toBe(1);

    driver.abortChat();

    expect(internals.pendingQuestions.size).toBe(0);

    sseQueue.close();
  });

  it("signals abort to event loop via chatAbortController", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    const internals = driver as unknown as DriverInternals;
    const abortController = internals.chatAbortController!;
    expect(abortController.signal.aborted).toBe(false);

    driver.abortChat();

    expect(abortController.signal.aborted).toBe(true);

    sseQueue.close();
    await iterPromise;
  });

  it("resets chatSessionId and chatAbortController to null", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    const internals = driver as unknown as DriverInternals;
    expect(internals.chatSessionId).toBe("test-session-123");
    expect(internals.chatAbortController).not.toBeNull();

    driver.abortChat();

    expect(internals.chatSessionId).toBeNull();
    expect(internals.chatAbortController).toBeNull();

    sseQueue.close();
    await iterPromise;
  });

  it("is idempotent — safe to call multiple times", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    // First abort
    driver.abortChat();

    // Second abort should not throw
    expect(() => driver.abortChat()).not.toThrow();

    // Third abort should not throw either
    expect(() => driver.abortChat()).not.toThrow();

    sseQueue.close();
    await iterPromise;
  });

  it("handles no pending questions gracefully", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    // No questions were pushed — abort should still work
    driver.abortChat();

    expect(mockClient.question.reject).not.toHaveBeenCalled();
    expect(mockClient.session.abort).toHaveBeenCalledWith({
      sessionID: "test-session-123",
    });

    sseQueue.close();
    await iterPromise;
  });

  it("handles session.abort failure gracefully", async () => {
    mockClient.session.abort = vi.fn().mockRejectedValue(new Error("abort failed"));

    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    // Should not throw
    expect(() => driver.abortChat()).not.toThrow();

    sseQueue.close();
    await iterPromise;
  });

  it("handles question.reject failure gracefully", async () => {
    mockClient.question.reject = vi.fn().mockRejectedValue(new Error("reject failed"));

    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-1",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Q?",
            header: "H",
            options: [{ label: "A", description: "a" }],
          },
        ],
      },
    });
    await firstNext;

    // Should not throw even though reject fails
    expect(() => driver.abortChat()).not.toThrow();

    sseQueue.close();
  });

  it("works when client is null (no-op)", () => {
    const noClientDriver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    // Should not throw
    expect(() => noClientDriver.abortChat()).not.toThrow();
  });

  it("stops the SSE event loop (generator completes)", async () => {
    const gen = driver.startChat(defaultChatOpts);

    // Consume events in the background
    const events: unknown[] = [];
    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();
    await tick();

    driver.abortChat();

    // Push an event after abort — it should be ignored
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "post-abort",
          text: "Should not appear",
        },
      },
    });

    sseQueue.close();
    await collectPromise;

    // No text events should have been captured
    const textEvents = events.filter((e: any) => e.type === "text");
    expect(textEvents).toHaveLength(0);
  });
});
