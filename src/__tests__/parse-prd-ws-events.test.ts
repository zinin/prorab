import { describe, expect, it } from "vitest";
import type {
  ParsePrdStartedEvent,
  ParsePrdErrorEvent,
  ParsePrdFinishedEvent,
  ParsePrdWsEvent,
  ParsePrdManagerOutcome,
  LogEvent,
} from "../types.js";

// Compile-time type conformance tests — the typed variable declaration IS the
// test. If the type definition breaks, TypeScript will emit a compile error
// before any runtime assertion runs.

describe("ParsePrdStartedEvent type", () => {
  it("should accept all required fields", () => {
    const event: ParsePrdStartedEvent = {
      type: "parse-prd:started",
      channel: "parse-prd",
      sessionId: "abc-123",
      agent: "claude",
    };
    expect(event).toBeDefined();
    expect(event.type).toBe("parse-prd:started");
    expect(event.channel).toBe("parse-prd");
  });

  it("should accept optional model field", () => {
    const event: ParsePrdStartedEvent = {
      type: "parse-prd:started",
      channel: "parse-prd",
      sessionId: "abc-123",
      agent: "opencode",
      model: "claude-sonnet-4-20250514",
    };
    expect(event.model).toBe("claude-sonnet-4-20250514");
  });

  it("should allow omitting optional model", () => {
    const event: ParsePrdStartedEvent = {
      type: "parse-prd:started",
      channel: "parse-prd",
      sessionId: "s1",
      agent: "claude",
    };
    expect(event.model).toBeUndefined();
  });
});

describe("ParsePrdErrorEvent type", () => {
  it("should accept required fields", () => {
    const event: ParsePrdErrorEvent = {
      type: "parse-prd:error",
      channel: "parse-prd",
      message: "agent session crashed",
    };
    expect(event).toBeDefined();
    expect(event.type).toBe("parse-prd:error");
    expect(event.channel).toBe("parse-prd");
    expect(event.message).toBe("agent session crashed");
  });
});

describe("ParsePrdFinishedEvent type", () => {
  it("should accept success outcome", () => {
    const event: ParsePrdFinishedEvent = {
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "success" },
    };
    expect(event).toBeDefined();
    expect(event.type).toBe("parse-prd:finished");
    expect(event.channel).toBe("parse-prd");
    expect(event.outcome.status).toBe("success");
  });

  it("should accept failure outcome with errors", () => {
    const event: ParsePrdFinishedEvent = {
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "failure", errors: ["no tasks found", "invalid format"] },
    };
    expect(event.outcome.status).toBe("failure");
    if (event.outcome.status === "failure") {
      expect(event.outcome.errors).toHaveLength(2);
    }
  });

  it("should accept cancelled outcome", () => {
    const event: ParsePrdFinishedEvent = {
      type: "parse-prd:finished",
      channel: "parse-prd",
      outcome: { status: "cancelled" },
    };
    expect(event.outcome.status).toBe("cancelled");
  });
});

// --- ParsePrdWsEvent discriminated union ---

describe("ParsePrdWsEvent discriminated union", () => {
  it("should accept all 3 event variants", () => {
    const events: ParsePrdWsEvent[] = [
      { type: "parse-prd:started", channel: "parse-prd", sessionId: "s1", agent: "claude" },
      { type: "parse-prd:error", channel: "parse-prd", message: "err" },
      { type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "success" } },
    ];
    expect(events).toHaveLength(3);
  });

  it("switch/case narrows each variant correctly", () => {
    const events: ParsePrdWsEvent[] = [
      { type: "parse-prd:started", channel: "parse-prd", sessionId: "s1", agent: "claude", model: "opus" },
      { type: "parse-prd:error", channel: "parse-prd", message: "fail" },
      { type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "cancelled" } },
    ];

    const results: string[] = [];
    for (const event of events) {
      switch (event.type) {
        case "parse-prd:started":
          results.push(`started:${event.sessionId}:${event.agent}:${event.model ?? "none"}`);
          break;
        case "parse-prd:error":
          results.push(`error:${event.message}`);
          break;
        case "parse-prd:finished":
          results.push(`finished:${event.outcome.status}`);
          break;
      }
    }

    expect(results).toEqual([
      "started:s1:claude:opus",
      "error:fail",
      "finished:cancelled",
    ]);
  });

  it("exhaustive check: every ParsePrdWsEvent type variant is handled", () => {
    function assertExhaustive(event: ParsePrdWsEvent): string {
      switch (event.type) {
        case "parse-prd:started": return "started";
        case "parse-prd:error": return "error";
        case "parse-prd:finished": return "finished";
        default: {
          const _exhaustive: never = event;
          return _exhaustive;
        }
      }
    }

    const sample: ParsePrdWsEvent = { type: "parse-prd:error", channel: "parse-prd", message: "test" };
    expect(assertExhaustive(sample)).toBe("error");
  });

  it("all events have channel === 'parse-prd'", () => {
    const events: ParsePrdWsEvent[] = [
      { type: "parse-prd:started", channel: "parse-prd", sessionId: "s1", agent: "claude" },
      { type: "parse-prd:error", channel: "parse-prd", message: "err" },
      { type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "success" } },
    ];
    for (const event of events) {
      expect(event.channel).toBe("parse-prd");
    }
  });

  it("compile-time: ParsePrdWsEvent rejects invalid type discriminants", () => {
    // @ts-expect-error — "parse-prd:bogus" is not a valid ParsePrdWsEvent type
    const _bad: ParsePrdWsEvent = { type: "parse-prd:bogus", channel: "parse-prd" };
    void _bad;
  });

  it("compile-time: ParsePrdStartedEvent rejects wrong channel value", () => {
    // @ts-expect-error — channel must be "parse-prd", not "execute"
    const _bad: ParsePrdStartedEvent = { type: "parse-prd:started", channel: "execute", sessionId: "s1", agent: "claude" };
    void _bad;
  });

  it("compile-time: ParsePrdStartedEvent rejects 'chat' channel", () => {
    // @ts-expect-error — channel must be "parse-prd", not "chat"
    const _bad: ParsePrdStartedEvent = { type: "parse-prd:started", channel: "chat", sessionId: "s1", agent: "claude" };
    void _bad;
  });
});

// --- ParsePrdManagerOutcome type ---

describe("ParsePrdManagerOutcome type", () => {
  it("should accept success status", () => {
    const outcome: ParsePrdManagerOutcome = { status: "success" };
    expect(outcome.status).toBe("success");
  });

  it("should accept failure status with errors", () => {
    const outcome: ParsePrdManagerOutcome = { status: "failure", errors: ["task has no title"] };
    expect(outcome.status).toBe("failure");
    if (outcome.status === "failure") {
      expect(outcome.errors).toEqual(["task has no title"]);
    }
  });

  it("should accept cancelled status", () => {
    const outcome: ParsePrdManagerOutcome = { status: "cancelled" };
    expect(outcome.status).toBe("cancelled");
  });

  it("compile-time: rejects invalid status", () => {
    // @ts-expect-error — "unknown" is not a valid status
    const _bad: ParsePrdManagerOutcome = { status: "unknown" };
    void _bad;
  });
});

// --- LogEvent with parse-prd channel ---

describe("LogEvent with parse-prd channel", () => {
  it("should accept channel: 'parse-prd' on agent:text", () => {
    const event: LogEvent = { type: "agent:text", text: "Reading PRD...", channel: "parse-prd" };
    expect(event).toBeDefined();
    expect(event.channel).toBe("parse-prd");
  });

  it("should accept channel: 'parse-prd' on agent:tool", () => {
    const event: LogEvent = { type: "agent:tool", name: "Read", summary: "Read prd.md", channel: "parse-prd" };
    expect(event).toBeDefined();
    expect(event.channel).toBe("parse-prd");
  });

  it("should accept channel: 'parse-prd' on agent:tool_result", () => {
    const event: LogEvent = { type: "agent:tool_result", summary: "file contents", channel: "parse-prd" };
    expect(event).toBeDefined();
  });

  it("should accept channel: 'parse-prd' on agent:context_usage", () => {
    const event: LogEvent = {
      type: "agent:context_usage",
      contextTokens: 1000,
      contextWindow: 200000,
      model: "claude-sonnet",
      unitId: "parse-prd-session-1",
      channel: "parse-prd",
    };
    expect(event).toBeDefined();
  });

  it("should accept channel: 'parse-prd' on agent:system_prompt", () => {
    const event: LogEvent = { type: "agent:system_prompt", text: "You are a PRD parser", channel: "parse-prd" };
    expect(event).toBeDefined();
  });
});
