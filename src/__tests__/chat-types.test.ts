import { describe, expect, it } from "vitest";
import type {
  ChatOptions,
  ChatEvent,
  QuestionData,
  QuestionAnswerValue,
  QuestionAnswers,
  AgentDriver,
} from "../core/drivers/types.js";

// The first four describe blocks are compile-time type conformance tests.
// The typed variable declaration IS the test — if the type definition breaks,
// TypeScript will emit a compile error here before any runtime assertion runs.
// Runtime expects are kept minimal (just toBeDefined) to avoid vitest
// "no assertions" warnings.

describe("ChatOptions type", () => {
  it("should accept all required fields", () => {
    const opts: ChatOptions = {
      systemPrompt: "You are a helpful assistant.",
      cwd: "/tmp",
      maxTurns: 10,
      verbosity: "info",
    };
    expect(opts).toBeDefined();
  });

  it("should accept optional fields", () => {
    const opts: ChatOptions = {
      systemPrompt: "system",
      cwd: "/home",
      maxTurns: 5,
      verbosity: "debug",
      onLog: (event) => { void event.type; },
      variant: "high",
    };
    expect(opts).toBeDefined();
  });

  it("should allow omitting optional fields", () => {
    const opts: ChatOptions = {
      systemPrompt: "",
      cwd: ".",
      maxTurns: 1,
      verbosity: "quiet",
    };
    expect(opts.onLog).toBeUndefined();
    expect(opts.variant).toBeUndefined();
  });
});

describe("ChatEvent type", () => {
  it("should support all 9 event variants", () => {
    // Each typed declaration is a compile-time assertion that the variant
    // conforms to the ChatEvent discriminated union.
    const events: ChatEvent[] = [
      { type: "text", content: "hello" },
      { type: "tool", name: "Read", input: { file_path: "/tmp/a" } },
      { type: "tool_result", name: "Read", output: "file contents" },
      { type: "context_usage", usage: { contextTokens: 1000, contextWindow: 200000 } },
      { type: "question", questionId: "q1", questions: [{ question: "Pick a color", header: "Color", options: [{ label: "Red", description: "Warm" }, { label: "Blue", description: "Cool" }], multiSelect: false }], source: "claude" },
      { type: "question_answer", questionId: "q1", answers: { "Pick a color": "Red" } },
      { type: "idle" },
      { type: "finished" },
      { type: "error", message: "something broke" },
    ];
    expect(events).toHaveLength(9);
  });
});

describe("QuestionData type", () => {
  it("should accept all required fields with varying shapes", () => {
    const variants: QuestionData[] = [
      {
        question: "Which framework?",
        header: "Framework",
        options: [
          { label: "React", description: "Component-based UI" },
          { label: "Vue", description: "Progressive framework" },
        ],
        multiSelect: false,
      },
      {
        question: "Select features",
        header: "Features",
        options: [
          { label: "Auth", description: "User authentication" },
          { label: "DB", description: "Database support" },
          { label: "Cache", description: "Caching layer" },
        ],
        multiSelect: true,
      },
      {
        question: "Free text?",
        header: "Input",
        options: [],
        multiSelect: false,
      },
    ];
    expect(variants).toHaveLength(3);
  });
});

describe("QuestionAnswerValue type", () => {
  it("should accept string and string[] values", () => {
    const single: QuestionAnswerValue = "single answer";
    const multi: QuestionAnswerValue = ["a", "b", "c"];
    expect(single).toBeDefined();
    expect(multi).toBeDefined();
  });
});

describe("QuestionAnswers type", () => {
  it("should accept record of mixed values", () => {
    const answers: QuestionAnswers = {
      "Single select": "option A",
      "Multi select": ["option B", "option C"],
    };
    expect(answers).toBeDefined();
  });
});

// --- Type guard & discriminated union narrowing tests ---

function isTextEvent(e: ChatEvent): e is ChatEvent & { type: "text" } {
  return e.type === "text";
}

describe("ChatEvent discriminated union narrowing", () => {
  it("isTextEvent narrows to text variant and exposes content", () => {
    const event: ChatEvent = { type: "text", content: "hello world" };
    expect(isTextEvent(event)).toBe(true);
    if (isTextEvent(event)) {
      // TS narrows: event.content is accessible
      expect(event.content).toBe("hello world");
    }
  });

  it("isTextEvent returns false for all non-text event variants", () => {
    const events: ChatEvent[] = [
      { type: "tool", name: "Read", input: {} },
      { type: "tool_result", name: "Read", output: "ok" },
      { type: "context_usage", usage: { contextTokens: 1000 } },
      { type: "question", questionId: "q1", questions: [{ question: "Pick?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }], source: "claude" },
      { type: "question_answer", questionId: "q1", answers: { "Pick?": "A" } },
      { type: "idle" },
      { type: "finished" },
      { type: "error", message: "oops" },
    ];
    for (const e of events) {
      expect(isTextEvent(e)).toBe(false);
    }
  });

  it("switch/case narrows each variant correctly", () => {
    const events: ChatEvent[] = [
      { type: "text", content: "msg" },
      { type: "tool", name: "Bash", input: { command: "ls" } },
      { type: "tool_result", name: "Bash", output: "file.txt" },
      { type: "context_usage", usage: { contextTokens: 500 } },
      { type: "question", questionId: "q1", questions: [{ question: "Pick?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }], source: "claude" },
      { type: "question_answer", questionId: "q1", answers: { "Pick?": "A" } },
      { type: "idle" },
      { type: "finished" },
      { type: "error", message: "fail" },
    ];

    const results: string[] = [];
    for (const event of events) {
      switch (event.type) {
        case "text":
          results.push(`text:${event.content}`);
          break;
        case "tool":
          results.push(`tool:${event.name}:${JSON.stringify(event.input)}`);
          break;
        case "tool_result":
          results.push(`tool_result:${event.name}:${event.output}`);
          break;
        case "context_usage":
          results.push(`context_usage:${JSON.stringify(event.usage)}`);
          break;
        case "question":
          results.push(`question:${event.questionId}:${event.source}:${event.questions.length}`);
          break;
        case "question_answer":
          results.push(`question_answer:${event.questionId}:${JSON.stringify(event.answers)}`);
          break;
        case "idle":
          results.push("idle");
          break;
        case "finished":
          results.push("finished");
          break;
        case "error":
          results.push(`error:${event.message}`);
          break;
      }
    }

    expect(results).toEqual([
      'text:msg',
      'tool:Bash:{"command":"ls"}',
      'tool_result:Bash:file.txt',
      'context_usage:{"contextTokens":500}',
      'question:q1:claude:1',
      'question_answer:q1:{"Pick?":"A"}',
      'idle',
      'finished',
      'error:fail',
    ]);
  });

  it("exhaustive check: every ChatEvent type variant is handled", () => {
    // This function would cause a compile error if a new variant were added
    // to ChatEvent without being handled here.
    function assertExhaustive(event: ChatEvent): string {
      switch (event.type) {
        case "text": return "text";
        case "tool": return "tool";
        case "tool_result": return "tool_result";
        case "context_usage": return "context_usage";
        case "question": return "question";
        case "question_answer": return "question_answer";
        case "idle": return "idle";
        case "finished": return "finished";
        case "error": return "error";
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    }

    const sample: ChatEvent = { type: "text", content: "" };
    expect(assertExhaustive(sample)).toBe("text");
  });

  it("compile-time: ChatEvent rejects invalid type discriminants", () => {
    // @ts-expect-error — "bogus" is not a valid ChatEvent type
    const _bad: ChatEvent = { type: "bogus" };
    void _bad;
  });

  it("compile-time: ChatOptions rejects wrong verbosity values", () => {
    // @ts-expect-error — "verbose" is not a valid Verbosity value
    const _bad: ChatOptions = { systemPrompt: "", cwd: "", maxTurns: 1, verbosity: "verbose" };
    void _bad;
  });

  it("compile-time: QuestionAnswerValue rejects non-string/non-string-array", () => {
    // @ts-expect-error — number is not assignable to QuestionAnswerValue
    const _bad: QuestionAnswerValue = 42;
    void _bad;
  });
});
