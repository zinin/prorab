/**
 * Mock tests for SSE event translation in OpenCodeDriver.
 *
 * Covers:
 * 1. processChatEvent — all SSE event types → ChatEvent translation
 * 2. question.asked saves requestID in pendingQuestions
 * 3. replyQuestion uses the stored requestID
 * 4. abortChat rejects all pending questions
 * 5. Session filtering — events from other sessions are ignored
 * 6. Full chat lifecycle flow: startChat → sendMessage → question.asked → replyQuestion → session.idle
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenCodeDriver } from "../core/drivers/opencode.js";
import { AsyncQueue } from "../core/drivers/async-queue.js";
import type {
  ChatEvent,
  ChatOptions,
  QuestionAnswers,
} from "../core/drivers/types.js";

// ---------------------------------------------------------------------------
// Types for accessing private driver internals
// ---------------------------------------------------------------------------

type DriverInternals = {
  client: unknown;
  chatSessionId: string | null;
  pendingQuestions: Map<string, { requestID: string }>;
  chatAbortController: AbortController | null;
  chatOptions: ChatOptions | null;
  chatReportedTools: Set<string>;
  questionIdCounter: number;
  processChatEvent(event: unknown): ChatEvent[];
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
      create: vi
        .fn()
        .mockResolvedValue({ data: { id: "test-session-123" } }),
      promptAsync: vi.fn().mockResolvedValue({}),
      abort: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    question: {
      reply: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
    },
    config: {
      providers: vi
        .fn()
        .mockResolvedValue({ data: { providers: [], default: {} } }),
    },
  };
}

/** Collect chat events from an async iterable, up to a limit. */
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
// 1. processChatEvent — SSE → ChatEvent translation
// ---------------------------------------------------------------------------

describe("processChatEvent: SSE → ChatEvent translation", () => {
  let driver: DriverInternals;

  function makeDriver(sessionId = "sess-1"): DriverInternals {
    const d = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    const internals = d as unknown as DriverInternals;
    internals.chatSessionId = sessionId;
    return internals;
  }

  beforeEach(() => {
    driver = makeDriver("sess-1");
  });

  // ---- question.asked ----

  it("translates question.asked → ChatEvent question with correct fields", () => {
    const events = driver.processChatEvent({
      type: "question.asked",
      properties: {
        id: "req-42",
        sessionID: "sess-1",
        questions: [
          {
            question: "Which framework?",
            header: "Framework",
            options: [
              { label: "React", description: "React.js library" },
              { label: "Vue", description: "Vue.js framework" },
            ],
            multiple: false,
          },
        ],
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("question");
    if (events[0].type === "question") {
      expect(events[0].questionId).toMatch(/^oq-\d+-\d+$/);
      expect(events[0].source).toBe("opencode");
      expect(events[0].questions).toHaveLength(1);
      expect(events[0].questions[0]).toEqual({
        question: "Which framework?",
        header: "Framework",
        options: [
          { label: "React", description: "React.js library" },
          { label: "Vue", description: "Vue.js framework" },
        ],
        multiSelect: false,
      });
    }
  });

  it("stores requestID in pendingQuestions on question.asked", () => {
    const events = driver.processChatEvent({
      type: "question.asked",
      properties: {
        id: "req-77",
        sessionID: "sess-1",
        questions: [
          { question: "Q?", header: "H", options: [] },
        ],
      },
    });

    if (events[0].type === "question") {
      const pending = driver.pendingQuestions.get(events[0].questionId);
      expect(pending).toBeDefined();
      expect(pending!.requestID).toBe("req-77");
    }
  });

  it("maps multiple=true → multiSelect=true", () => {
    const events = driver.processChatEvent({
      type: "question.asked",
      properties: {
        id: "req-multi",
        sessionID: "sess-1",
        questions: [
          {
            question: "Select features",
            header: "Features",
            options: [{ label: "Auth", description: "auth" }],
            multiple: true,
          },
        ],
      },
    });

    expect(events).toHaveLength(1);
    if (events[0].type === "question") {
      expect(events[0].questions[0].multiSelect).toBe(true);
    }
  });

  it("defaults multiSelect to false when multiple is undefined", () => {
    const events = driver.processChatEvent({
      type: "question.asked",
      properties: {
        id: "req-def",
        sessionID: "sess-1",
        questions: [
          { question: "Pick?", header: "H", options: [] },
        ],
      },
    });

    if (events[0].type === "question") {
      expect(events[0].questions[0].multiSelect).toBe(false);
    }
  });

  // ---- session.idle ----

  it("translates session.idle → ChatEvent idle", () => {
    const events = driver.processChatEvent({
      type: "session.idle",
      properties: { sessionID: "sess-1" },
    });
    expect(events).toEqual([{ type: "idle" }]);
  });

  // ---- session.error ----

  it("translates session.error → ChatEvent error", () => {
    const events = driver.processChatEvent({
      type: "session.error",
      properties: {
        sessionID: "sess-1",
        error: { message: "rate limit exceeded" },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "error",
      message: 'Session error: {"message":"rate limit exceeded"}',
    });
  });

  it("uses 'unknown session error' when error is missing", () => {
    const events = driver.processChatEvent({
      type: "session.error",
      properties: { sessionID: "sess-1" },
    });

    expect(events).toHaveLength(1);
    if (events[0].type === "error") {
      expect(events[0].message).toContain("unknown session error");
    }
  });

  it("accepts session.error without sessionID (assumes ours)", () => {
    const events = driver.processChatEvent({
      type: "session.error",
      properties: { error: "global failure" },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  // ---- message.part.updated (text) ----

  it("translates text part → ChatEvent text", () => {
    const events = driver.processChatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "sess-1",
          id: "t1",
          text: "Hello, world!",
        },
      },
    });
    expect(events).toEqual([{ type: "text", content: "Hello, world!" }]);
  });

  it("skips empty text parts", () => {
    const events = driver.processChatEvent({
      type: "message.part.updated",
      properties: {
        part: { type: "text", sessionID: "sess-1", id: "t1", text: "" },
      },
    });
    expect(events).toHaveLength(0);
  });

  // ---- message.part.updated (tool) ----

  it("translates running tool → ChatEvent tool", () => {
    const events = driver.processChatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "sess-1",
          id: "tool-1",
          tool: "Read",
          state: { status: "running", input: { file_path: "/tmp/x.ts" } },
        },
      },
    });
    expect(events).toEqual([
      { type: "tool", name: "Read", input: { file_path: "/tmp/x.ts" } },
    ]);
  });

  it("translates completed tool → tool + tool_result", () => {
    const events = driver.processChatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "sess-1",
          id: "tool-2",
          tool: "Bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "a.ts\nb.ts",
          },
        },
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      type: "tool",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(events[1]).toEqual({
      type: "tool_result",
      name: "Bash",
      output: "a.ts\nb.ts",
    });
  });

  it("translates errored tool → tool_result with ERROR prefix", () => {
    const events = driver.processChatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "sess-1",
          id: "tool-err",
          tool: "Bash",
          state: { status: "error", error: "command not found" },
        },
      },
    });
    expect(events).toEqual([
      { type: "tool_result", name: "Bash", output: "ERROR: command not found" },
    ]);
  });

  it("deduplicates tool dispatch for the same part ID", () => {
    const toolEvent = {
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "sess-1",
          id: "tool-dup",
          tool: "Read",
          state: { status: "running", input: { file_path: "/tmp/x.ts" } },
        },
      },
    };

    // First call: yields tool event
    expect(driver.processChatEvent(toolEvent)).toHaveLength(1);
    // Second call: deduped
    expect(driver.processChatEvent(toolEvent)).toHaveLength(0);

    // Completed call: yields only tool_result (dispatch already reported)
    const completed = driver.processChatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "sess-1",
          id: "tool-dup",
          tool: "Read",
          state: {
            status: "completed",
            input: { file_path: "/tmp/x.ts" },
            output: "contents",
          },
        },
      },
    });
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      type: "tool_result",
      name: "Read",
      output: "contents",
    });
  });

  // ---- message.part.updated (step-finish) ----

  it("translates step-finish with tokens → context_usage", () => {
    const events = driver.processChatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "sess-1",
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
    expect(events).toEqual([
      {
        type: "context_usage",
        usage: {
          contextTokens: 1400,
          contextWindow: 200_000,
          model: "anthropic/claude-sonnet-4-6",
        },
      },
    ]);
  });

  it("skips step-finish without tokens", () => {
    const events = driver.processChatEvent({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "sess-1",
          id: "sf-2",
          reason: "end_turn",
        },
      },
    });
    expect(events).toHaveLength(0);
  });

  // ---- message.part.delta ----

  it("translates text delta → ChatEvent text", () => {
    const events = driver.processChatEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "sess-1",
        field: "text",
        delta: "Hello ",
      },
    });
    expect(events).toEqual([{ type: "text", content: "Hello " }]);
  });

  it("skips non-text field deltas", () => {
    const events = driver.processChatEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "sess-1",
        field: "tool_input",
        delta: '{"key":"val"}',
      },
    });
    expect(events).toHaveLength(0);
  });

  it("skips empty deltas", () => {
    const events = driver.processChatEvent({
      type: "message.part.delta",
      properties: {
        sessionID: "sess-1",
        field: "text",
        delta: "",
      },
    });
    expect(events).toHaveLength(0);
  });

  // ---- unknown events ----

  it("returns empty array for unknown event types", () => {
    expect(
      driver.processChatEvent({
        type: "installation.updated",
        properties: { version: "2.0" },
      }),
    ).toHaveLength(0);
  });

  // ---- session filtering ----

  it("ignores events from other sessions across all event types", () => {
    const other = "other-session-999";

    const results = [
      driver.processChatEvent({
        type: "question.asked",
        properties: {
          id: "r1",
          sessionID: other,
          questions: [{ question: "Q", header: "H", options: [] }],
        },
      }),
      driver.processChatEvent({
        type: "session.idle",
        properties: { sessionID: other },
      }),
      driver.processChatEvent({
        type: "session.error",
        properties: { sessionID: other, error: "err" },
      }),
      driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: other, id: "t1", text: "hi" },
        },
      }),
      driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: other,
            id: "tl1",
            tool: "Read",
            state: { status: "running", input: { x: 1 } },
          },
        },
      }),
      driver.processChatEvent({
        type: "message.part.delta",
        properties: { sessionID: other, field: "text", delta: "nope" },
      }),
    ];

    for (const events of results) {
      expect(events).toHaveLength(0);
    }
    // Verify nothing leaked into pending questions
    expect(driver.pendingQuestions.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. replyQuestion — uses stored requestID
// ---------------------------------------------------------------------------

describe("replyQuestion: requestID lookup and reply", () => {
  let driver: OpenCodeDriver;
  let sseQueue: AsyncQueue<unknown>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    driver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    sseQueue = new AsyncQueue<unknown>();
    mockClient = createMockClient(sseQueue);
    (driver as unknown as DriverInternals).client = mockClient;
  });

  it("calls client.question.reply with the stored requestID", async () => {
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
          },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value as ChatEvent;
    expect(ev.type).toBe("question");

    if (ev.type === "question") {
      driver.replyQuestion(ev.questionId, { "Which framework?": "React" });

      expect(mockClient.question.reply).toHaveBeenCalledWith({
        requestID: "req-42",
        answers: [["React"]],
      });
    }

    sseQueue.close();
  });

  it("removes question from pendingQuestions after reply", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-99",
        sessionID: "test-session-123",
        questions: [
          { question: "Pick?", header: "P", options: [{ label: "A", description: "a" }] },
        ],
      },
    });

    const result = await firstNext;
    const ev = result.value as ChatEvent;

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

  it("throws for unknown questionId", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    expect(() => driver.replyQuestion("nonexistent", { q: "a" })).toThrow(
      "No pending question with id 'nonexistent'",
    );

    sseQueue.close();
    await iterPromise;
  });

  it("flattens multi-select answers (string[])", async () => {
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
    const ev = result.value as ChatEvent;

    if (ev.type === "question") {
      driver.replyQuestion(ev.questionId, {
        "Select features": ["Auth", "Cache"],
      });

      expect(mockClient.question.reply).toHaveBeenCalledWith({
        requestID: "req-multi",
        answers: [["Auth", "Cache"]],
      });
    }

    sseQueue.close();
  });
});

// ---------------------------------------------------------------------------
// 3. abortChat — rejects all pending questions
// ---------------------------------------------------------------------------

describe("abortChat: pending question rejection", () => {
  let driver: OpenCodeDriver;
  let sseQueue: AsyncQueue<unknown>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    driver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    sseQueue = new AsyncQueue<unknown>();
    mockClient = createMockClient(sseQueue);
    (driver as unknown as DriverInternals).client = mockClient;
  });

  it("calls question.reject for every pending question", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    // Push question 1
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-1",
        sessionID: "test-session-123",
        questions: [
          { question: "Q1?", header: "H1", options: [{ label: "A", description: "a" }] },
        ],
      },
    });
    await firstNext;

    // Push question 2
    const secondNext = (gen as AsyncGenerator).next();
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-2",
        sessionID: "test-session-123",
        questions: [
          { question: "Q2?", header: "H2", options: [{ label: "B", description: "b" }] },
        ],
      },
    });
    await secondNext;

    driver.abortChat();

    expect(mockClient.question.reject).toHaveBeenCalledTimes(2);
    expect(mockClient.question.reject).toHaveBeenCalledWith({ requestID: "req-1" });
    expect(mockClient.question.reject).toHaveBeenCalledWith({ requestID: "req-2" });
  });

  it("calls session.abort with correct sessionID", async () => {
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

  it("clears pendingQuestions and resets state", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-1",
        sessionID: "test-session-123",
        questions: [
          { question: "Q?", header: "H", options: [{ label: "A", description: "a" }] },
        ],
      },
    });
    await firstNext;

    const internals = driver as unknown as DriverInternals;
    expect(internals.pendingQuestions.size).toBe(1);

    driver.abortChat();

    expect(internals.pendingQuestions.size).toBe(0);
    expect(internals.chatSessionId).toBeNull();
    expect(internals.chatAbortController).toBeNull();

    sseQueue.close();
  });

  it("is idempotent — safe to call multiple times", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    driver.abortChat();
    expect(() => driver.abortChat()).not.toThrow();
    expect(() => driver.abortChat()).not.toThrow();

    sseQueue.close();
    await iterPromise;
  });

  it("works when client is null (no-op)", () => {
    const noClientDriver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    expect(() => noClientDriver.abortChat()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Full chat lifecycle flow
// ---------------------------------------------------------------------------

describe("Full chat lifecycle: startChat → sendMessage → question → reply → idle", () => {
  let driver: OpenCodeDriver;
  let sseQueue: AsyncQueue<unknown>;
  let mockClient: ReturnType<typeof createMockClient>;

  beforeEach(() => {
    driver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
    sseQueue = new AsyncQueue<unknown>();
    mockClient = createMockClient(sseQueue);
    (driver as unknown as DriverInternals).client = mockClient;
  });

  it("completes a full question→reply flow and reaches idle", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const events: ChatEvent[] = [];

    // Start collecting events in the background
    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
        // Stop after idle
        if (ev.type === "idle") break;
      }
    })();
    await tick();

    // 1. Verify session was created and subscribed
    expect(mockClient.event.subscribe).toHaveBeenCalledWith({
      directory: "/tmp/test",
    });
    expect(mockClient.session.create).toHaveBeenCalledWith({
      directory: "/tmp/test",
    });

    // 2. Send first message
    driver.sendMessage("Hello, implement a feature");
    expect(mockClient.session.promptAsync).toHaveBeenCalledWith({
      sessionID: "test-session-123",
      directory: "/tmp/test",
      system: "You are a test assistant.",
      parts: [{ type: "text", text: "Hello, implement a feature" }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    });

    // 3. Agent produces text output
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "text-1",
          text: "I'll implement the feature. First, let me ask a question.",
        },
      },
    });
    await tick();

    // 4. Agent asks a question
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-42",
        sessionID: "test-session-123",
        questions: [
          {
            question: "Which database should I use?",
            header: "Database",
            options: [
              { label: "PostgreSQL", description: "Relational DB" },
              { label: "MongoDB", description: "Document DB" },
            ],
            multiple: false,
          },
        ],
      },
    });
    await tick();

    // 5. Find the question event and reply
    const questionEvent = events.find((e) => e.type === "question");
    expect(questionEvent).toBeDefined();
    expect(questionEvent!.type).toBe("question");

    if (questionEvent?.type === "question") {
      // Verify pending question was stored
      const internals = driver as unknown as DriverInternals;
      expect(internals.pendingQuestions.has(questionEvent.questionId)).toBe(true);

      // Reply to the question
      driver.replyQuestion(questionEvent.questionId, {
        "Which database should I use?": "PostgreSQL",
      });

      // Verify reply was sent with correct requestID
      expect(mockClient.question.reply).toHaveBeenCalledWith({
        requestID: "req-42",
        answers: [["PostgreSQL"]],
      });

      // Delete is async (after reply resolves) — flush microtask queue
      await tick();
      expect(internals.pendingQuestions.has(questionEvent.questionId)).toBe(false);
    }

    // 6. Agent produces more text after reply
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "text-2",
          text: "Great, I'll use PostgreSQL.",
        },
      },
    });

    // 7. Agent uses a tool
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "tool",
          sessionID: "test-session-123",
          id: "tool-1",
          tool: "Write",
          state: {
            status: "completed",
            input: { file_path: "/tmp/db.ts" },
            output: "File written",
          },
        },
      },
    });

    // 8. Step finish with token usage
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "step-finish",
          sessionID: "test-session-123",
          id: "sf-1",
          reason: "end_turn",
          tokens: {
            input: 2000,
            output: 1000,
            reasoning: 500,
            cache: { read: 400, write: 200 },
          },
          cost: 0.10,
        },
      },
    });

    // 9. Session goes idle
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    await collectPromise;

    // Verify the full event sequence
    const types = events.map((e) => e.type);
    expect(types).toEqual([
      "text",          // Agent text response
      "question",      // Agent asks question
      "text",          // Agent response after reply
      "tool",          // Tool dispatch (Write)
      "tool_result",   // Tool result
      "context_usage", // Step-finish tokens
      "idle",          // Session idle
    ]);

    // Verify text content
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents[0]).toEqual({
      type: "text",
      content: "I'll implement the feature. First, let me ask a question.",
    });
    expect(textEvents[1]).toEqual({
      type: "text",
      content: "Great, I'll use PostgreSQL.",
    });

    // Verify tool events
    const toolEvent = events.find((e) => e.type === "tool");
    expect(toolEvent).toEqual({
      type: "tool",
      name: "Write",
      input: { file_path: "/tmp/db.ts" },
    });

    // Verify context usage
    const usageEvent = events.find((e) => e.type === "context_usage");
    if (usageEvent?.type === "context_usage") {
      expect(usageEvent.usage).toEqual({
        contextTokens: 2600,
        contextWindow: 200_000,
        model: "anthropic/claude-sonnet-4-6",
      });
    }

    sseQueue.close();
  });

  it("handles multiple questions interleaved with text and tools", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const events: ChatEvent[] = [];

    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
        if (ev.type === "idle") break;
      }
    })();
    await tick();

    driver.sendMessage("Start working");

    // First question
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
    await tick();

    const q1 = events.find((e) => e.type === "question");
    if (q1?.type === "question") {
      driver.replyQuestion(q1.questionId, { "Q1?": "A" });
    }

    // Text response after first answer
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "text-1",
          text: "Got it, continuing...",
        },
      },
    });
    await tick();

    // Second question
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
            multiple: true,
          },
        ],
      },
    });
    await tick();

    const q2 = events.filter((e) => e.type === "question")[1];
    if (q2?.type === "question") {
      driver.replyQuestion(q2.questionId, { "Q2?": ["B"] });
    }

    // Session idle
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    await collectPromise;

    // Verify both questions were answered
    expect(mockClient.question.reply).toHaveBeenCalledTimes(2);
    expect(mockClient.question.reply).toHaveBeenCalledWith({
      requestID: "req-1",
      answers: [["A"]],
    });
    expect(mockClient.question.reply).toHaveBeenCalledWith({
      requestID: "req-2",
      answers: [["B"]],
    });

    // Verify event types
    const types = events.map((e) => e.type);
    expect(types).toContain("question");
    expect(types).toContain("text");
    expect(types).toContain("idle");
    expect(types.filter((t) => t === "question")).toHaveLength(2);
  });

  it("abort during question stops the event loop", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const events: ChatEvent[] = [];

    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
      }
    })();
    await tick();

    driver.sendMessage("Start");

    // Question arrives
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-abort",
        sessionID: "test-session-123",
        questions: [
          { question: "Q?", header: "H", options: [{ label: "A", description: "a" }] },
        ],
      },
    });
    await tick();

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("question");

    // Abort instead of replying
    driver.abortChat();

    // Verify question was rejected
    expect(mockClient.question.reject).toHaveBeenCalledWith({
      requestID: "req-abort",
    });

    // Events after abort should not appear
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

    // Only the question event should have been captured
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents).toHaveLength(0);
  });

  it("cleanup resets all state after generator finishes", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const iterPromise = (gen as AsyncGenerator).next();
    await tick();

    const internals = driver as unknown as DriverInternals;
    expect(internals.chatSessionId).toBe("test-session-123");
    expect(internals.chatAbortController).toBeInstanceOf(AbortController);

    // Push question to add to pending
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "req-cleanup",
        sessionID: "test-session-123",
        questions: [
          { question: "Q?", header: "H", options: [{ label: "A", description: "a" }] },
        ],
      },
    });
    await iterPromise;

    expect(internals.pendingQuestions.size).toBe(1);

    // Close stream to trigger cleanup
    sseQueue.close();
    // Drain remaining generator
    for await (const _ of gen) {
      // drain
    }

    // All state should be reset
    expect(internals.chatSessionId).toBeNull();
    expect(internals.chatAbortController).toBeNull();
    expect(internals.chatOptions).toBeNull();
    expect(internals.pendingQuestions.size).toBe(0);
    expect(internals.chatReportedTools.size).toBe(0);
  });

  it("events from other sessions are filtered in the live stream", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const events: ChatEvent[] = [];

    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
        if (ev.type === "idle") break;
      }
    })();
    await tick();

    driver.sendMessage("Hello");

    // Event from a different session — should be filtered
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "other-session",
          id: "other-1",
          text: "Should be filtered",
        },
      },
    });

    // Question from a different session — should be filtered
    sseQueue.push({
      type: "question.asked",
      properties: {
        id: "other-req",
        sessionID: "other-session",
        questions: [
          { question: "Not ours", header: "X", options: [] },
        ],
      },
    });

    // Our event should come through
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "our-1",
          text: "Our text",
        },
      },
    });

    // Our idle to end the test
    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    await collectPromise;

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "text", content: "Our text" });
    expect(events[1]).toEqual({ type: "idle" });

    // Verify no pending questions from other sessions
    const internals = driver as unknown as DriverInternals;
    expect(internals.pendingQuestions.size).toBe(0);

    sseQueue.close();
  });

  it("session error interrupts the flow", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const firstNext = (gen as AsyncGenerator).next();
    await tick();

    driver.sendMessage("Start");

    // Text arrives normally
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "text-1",
          text: "Processing...",
        },
      },
    });

    const result = await firstNext;
    expect(result.value).toEqual({ type: "text", content: "Processing..." });

    // Then an error
    const errorNext = (gen as AsyncGenerator).next();
    sseQueue.push({
      type: "session.error",
      properties: {
        sessionID: "test-session-123",
        error: { message: "context window exceeded" },
      },
    });

    const errorResult = await errorNext;
    expect(errorResult.value).toEqual({
      type: "error",
      message: 'Session error: {"message":"context window exceeded"}',
    });

    sseQueue.close();
  });

  it("mixed deltas and updated events deduplicate text", async () => {
    const gen = driver.startChat(defaultChatOpts);
    const events: ChatEvent[] = [];

    const collectPromise = (async () => {
      for await (const ev of gen) {
        events.push(ev);
        if (ev.type === "idle") break;
      }
    })();
    await tick();

    driver.sendMessage("Go");

    // Delta events (streaming text)
    sseQueue.push({
      type: "message.part.delta",
      properties: {
        sessionID: "test-session-123",
        partID: "part-1",
        field: "text",
        delta: "Hello ",
      },
    });
    sseQueue.push({
      type: "message.part.delta",
      properties: {
        sessionID: "test-session-123",
        partID: "part-1",
        field: "text",
        delta: "world!",
      },
    });

    // Full text update (replaces accumulated)
    sseQueue.push({
      type: "message.part.updated",
      properties: {
        part: {
          type: "text",
          sessionID: "test-session-123",
          id: "part-1",
          text: "Hello world!",
        },
      },
    });

    sseQueue.push({
      type: "session.idle",
      properties: { sessionID: "test-session-123" },
    });

    await collectPromise;

    const textEvents = events.filter((e) => e.type === "text");
    // Deltas covered the full text ("Hello " + "world!" = 12 chars),
    // so message.part.updated with the same 12-char text emits nothing new.
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0]).toEqual({ type: "text", content: "Hello " });
    expect(textEvents[1]).toEqual({ type: "text", content: "world!" });

    sseQueue.close();
  });
});
