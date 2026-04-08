import { describe, expect, it } from "vitest";
import type {
  ChatStartedEvent,
  ChatQuestionEvent,
  ChatIdleEvent,
  ChatErrorEvent,
  ChatFinishedEvent,
  ChatWsEvent,
  LogEvent,
} from "../types.js";
import type { QuestionData } from "../core/drivers/types.js";

// Compile-time type conformance tests — the typed variable declaration IS the
// test. If the type definition breaks, TypeScript will emit a compile error
// before any runtime assertion runs.

describe("ChatStartedEvent type", () => {
  it("should accept all required fields", () => {
    const event: ChatStartedEvent = {
      type: "chat:started",
      channel: "chat",
      sessionId: "abc-123",
      agent: "claude",
    };
    expect(event).toBeDefined();
    expect(event.type).toBe("chat:started");
    expect(event.channel).toBe("chat");
  });

  it("should accept optional model field", () => {
    const event: ChatStartedEvent = {
      type: "chat:started",
      channel: "chat",
      sessionId: "abc-123",
      agent: "opencode",
      model: "claude-sonnet-4-20250514",
    };
    expect(event.model).toBe("claude-sonnet-4-20250514");
  });

  it("should allow omitting optional model", () => {
    const event: ChatStartedEvent = {
      type: "chat:started",
      channel: "chat",
      sessionId: "s1",
      agent: "claude",
    };
    expect(event.model).toBeUndefined();
  });
});

describe("ChatQuestionEvent type", () => {
  it("should accept all required fields", () => {
    const questions: QuestionData[] = [
      {
        question: "Which approach?",
        header: "Approach",
        options: [
          { label: "A", description: "First" },
          { label: "B", description: "Second" },
        ],
        multiSelect: false,
      },
    ];
    const event: ChatQuestionEvent = {
      type: "chat:question",
      channel: "chat",
      questionId: "q-42",
      questions,
      source: "claude",
    };
    expect(event).toBeDefined();
    expect(event.type).toBe("chat:question");
    expect(event.channel).toBe("chat");
    expect(event.questions).toHaveLength(1);
  });

  it("should accept opencode as source", () => {
    const event: ChatQuestionEvent = {
      type: "chat:question",
      channel: "chat",
      questionId: "q-1",
      questions: [],
      source: "opencode",
    };
    expect(event.source).toBe("opencode");
  });
});

describe("ChatIdleEvent type", () => {
  it("should accept required fields only", () => {
    const event: ChatIdleEvent = {
      type: "chat:idle",
      channel: "chat",
    };
    expect(event).toBeDefined();
    expect(event.type).toBe("chat:idle");
    expect(event.channel).toBe("chat");
  });
});

describe("ChatErrorEvent type", () => {
  it("should accept required fields", () => {
    const event: ChatErrorEvent = {
      type: "chat:error",
      channel: "chat",
      message: "something broke",
    };
    expect(event).toBeDefined();
    expect(event.type).toBe("chat:error");
    expect(event.message).toBe("something broke");
  });
});

describe("ChatFinishedEvent type", () => {
  it("should accept required fields only", () => {
    const event: ChatFinishedEvent = {
      type: "chat:finished",
      channel: "chat",
    };
    expect(event).toBeDefined();
    expect(event.type).toBe("chat:finished");
    expect(event.channel).toBe("chat");
  });
});

// --- ChatWsEvent discriminated union ---

describe("ChatWsEvent discriminated union", () => {
  it("should accept all 5 event variants", () => {
    const events: ChatWsEvent[] = [
      { type: "chat:started", channel: "chat", sessionId: "s1", agent: "claude" },
      { type: "chat:question", channel: "chat", questionId: "q1", questions: [], source: "claude" },
      { type: "chat:idle", channel: "chat" },
      { type: "chat:error", channel: "chat", message: "err" },
      { type: "chat:finished", channel: "chat" },
    ];
    expect(events).toHaveLength(5);
  });

  it("switch/case narrows each variant correctly", () => {
    const events: ChatWsEvent[] = [
      { type: "chat:started", channel: "chat", sessionId: "s1", agent: "claude", model: "opus" },
      { type: "chat:question", channel: "chat", questionId: "q1", questions: [{ question: "Pick?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }], source: "opencode" },
      { type: "chat:idle", channel: "chat" },
      { type: "chat:error", channel: "chat", message: "fail" },
      { type: "chat:finished", channel: "chat" },
    ];

    const results: string[] = [];
    for (const event of events) {
      switch (event.type) {
        case "chat:started":
          results.push(`started:${event.sessionId}:${event.agent}:${event.model ?? "none"}`);
          break;
        case "chat:question":
          results.push(`question:${event.questionId}:${event.source}:${event.questions.length}`);
          break;
        case "chat:idle":
          results.push("idle");
          break;
        case "chat:error":
          results.push(`error:${event.message}`);
          break;
        case "chat:finished":
          results.push("finished");
          break;
      }
    }

    expect(results).toEqual([
      "started:s1:claude:opus",
      "question:q1:opencode:1",
      "idle",
      "error:fail",
      "finished",
    ]);
  });

  it("exhaustive check: every ChatWsEvent type variant is handled", () => {
    function assertExhaustive(event: ChatWsEvent): string {
      switch (event.type) {
        case "chat:started": return "started";
        case "chat:question": return "question";
        case "chat:idle": return "idle";
        case "chat:error": return "error";
        case "chat:finished": return "finished";
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    }

    const sample: ChatWsEvent = { type: "chat:idle", channel: "chat" };
    expect(assertExhaustive(sample)).toBe("idle");
  });

  it("all events have channel === 'chat'", () => {
    const events: ChatWsEvent[] = [
      { type: "chat:started", channel: "chat", sessionId: "s1", agent: "claude" },
      { type: "chat:question", channel: "chat", questionId: "q1", questions: [], source: "claude" },
      { type: "chat:idle", channel: "chat" },
      { type: "chat:error", channel: "chat", message: "err" },
      { type: "chat:finished", channel: "chat" },
    ];
    for (const event of events) {
      expect(event.channel).toBe("chat");
    }
  });

  it("compile-time: ChatWsEvent rejects invalid type discriminants", () => {
    // @ts-expect-error — "chat:bogus" is not a valid ChatWsEvent type
    const _bad: ChatWsEvent = { type: "chat:bogus", channel: "chat" };
    void _bad;
  });

  it("compile-time: ChatStartedEvent rejects wrong channel value", () => {
    // @ts-expect-error — channel must be "chat", not "execute"
    const _bad: ChatStartedEvent = { type: "chat:started", channel: "execute", sessionId: "s1", agent: "claude" };
    void _bad;
  });

  it("compile-time: ChatQuestionEvent rejects invalid source", () => {
    // @ts-expect-error — "gemini" is not a valid source
    const _bad: ChatQuestionEvent = { type: "chat:question", channel: "chat", questionId: "q1", questions: [], source: "gemini" };
    void _bad;
  });
});

// --- LogEvent channel field ---

describe("LogEvent channel field", () => {
  it("should accept channel: 'chat' on agent:text", () => {
    const event: LogEvent = { type: "agent:text", text: "hello", channel: "chat" };
    expect(event).toBeDefined();
  });

  it("should accept channel: 'execute' on agent:tool", () => {
    const event: LogEvent = { type: "agent:tool", name: "Read", summary: "Read file", channel: "execute" };
    expect(event).toBeDefined();
  });

  it("should accept channel on agent:tool_result", () => {
    const event: LogEvent = { type: "agent:tool_result", summary: "ok", channel: "chat" };
    expect(event).toBeDefined();
  });

  it("should accept channel on agent:context_usage", () => {
    const event: LogEvent = {
      type: "agent:context_usage",
      contextTokens: 1000,
      contextWindow: 200000,
      model: "claude-sonnet",
      unitId: "task-1",
      channel: "execute",
    };
    expect(event).toBeDefined();
  });

  it("should allow omitting channel (backward compatible)", () => {
    const event: LogEvent = { type: "agent:text", text: "hello" };
    expect(event).toBeDefined();
    // channel is optional — no runtime error when accessing
    if (event.type === "agent:text") {
      expect(event.channel).toBeUndefined();
    }
  });

  it("compile-time: LogEvent rejects invalid channel value", () => {
    // @ts-expect-error — "websocket" is not a valid channel
    const _bad: LogEvent = { type: "agent:text", text: "x", channel: "websocket" };
    void _bad;
  });
});
