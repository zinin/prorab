import { describe, it, expect } from "vitest";
import {
  truncate,
  parseContextUsage,
  formatContextUsage,
  formatAnswers,
} from "../../ui/src/components/chat-message-logic";
import type { ChatMessage } from "../../ui/src/stores/chat";

// --- Helpers ---

function makeMessage(overrides: Partial<ChatMessage> & { type: ChatMessage["type"] }): ChatMessage {
  return {
    id: "test-1",
    content: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------
describe("truncate", () => {
  it("returns text unchanged when shorter than maxLen", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("returns text unchanged when exactly maxLen", () => {
    const text = "a".repeat(100);
    expect(truncate(text, 100)).toBe(text);
  });

  it("truncates and appends ellipsis when text exceeds maxLen", () => {
    const text = "a".repeat(150);
    const result = truncate(text, 100);
    expect(result.length).toBe(101); // 100 chars + ellipsis
    expect(result).toBe("a".repeat(100) + "\u2026");
  });

  it("uses default maxLen of 100", () => {
    const short = "a".repeat(100);
    expect(truncate(short)).toBe(short);

    const long = "a".repeat(101);
    expect(truncate(long)).toBe("a".repeat(100) + "\u2026");
  });

  it("handles empty string", () => {
    expect(truncate("", 10)).toBe("");
  });

  it("handles custom maxLen", () => {
    expect(truncate("hello world", 5)).toBe("hello\u2026");
  });
});

// ---------------------------------------------------------------------------
// parseContextUsage
// ---------------------------------------------------------------------------
describe("parseContextUsage", () => {
  it("parses valid context usage JSON", () => {
    const json = JSON.stringify({ contextTokens: 5000, contextWindow: 200000, model: "claude-3" });
    const result = parseContextUsage(json);
    expect(result).toEqual({ contextTokens: 5000, contextWindow: 200000, model: "claude-3" });
  });

  it("returns null for invalid JSON", () => {
    expect(parseContextUsage("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseContextUsage("")).toBeNull();
  });

  it("parses JSON with extra fields without error", () => {
    const json = JSON.stringify({ contextTokens: 100, contextWindow: 1000, model: "m", extra: true });
    const result = parseContextUsage(json);
    expect(result).not.toBeNull();
    expect(result!.contextTokens).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// formatContextUsage
// ---------------------------------------------------------------------------
describe("formatContextUsage", () => {
  it("formats context usage as percentage string", () => {
    const json = JSON.stringify({ contextTokens: 50000, contextWindow: 200000, model: "claude-3" });
    const result = formatContextUsage(json);
    expect(result).toContain("25%");
    expect(result).toContain("context used");
    expect(result).toContain("claude-3");
  });

  it("rounds percentage to nearest integer", () => {
    const json = JSON.stringify({ contextTokens: 1, contextWindow: 3, model: "m" });
    const result = formatContextUsage(json);
    expect(result).toContain("33%");
  });

  it("handles 0% usage", () => {
    const json = JSON.stringify({ contextTokens: 0, contextWindow: 200000, model: "m" });
    const result = formatContextUsage(json);
    expect(result).toContain("0%");
  });

  it("handles 100% usage", () => {
    const json = JSON.stringify({ contextTokens: 200000, contextWindow: 200000, model: "m" });
    const result = formatContextUsage(json);
    expect(result).toContain("100%");
  });

  it("includes agent and model in label", () => {
    const json = JSON.stringify({ contextTokens: 10000, contextWindow: 200000, model: "claude-opus-4-6", agent: "claude" });
    const result = formatContextUsage(json);
    expect(result).toContain("claude/claude-opus-4-6");
  });

  it("includes variant in label when present", () => {
    const json = JSON.stringify({ contextTokens: 10000, contextWindow: 200000, model: "claude-opus-4-6", agent: "claude", variant: "high" });
    const result = formatContextUsage(json);
    expect(result).toContain("claude/claude-opus-4-6:high");
  });

  it("shows only model when agent is absent", () => {
    const json = JSON.stringify({ contextTokens: 10000, contextWindow: 200000, model: "claude-3" });
    const result = formatContextUsage(json);
    expect(result).toContain("\u2014 claude-3");
  });

  it("returns raw content for invalid JSON", () => {
    expect(formatContextUsage("bad data")).toBe("bad data");
  });

  it("formats token counts with locale separators", () => {
    const json = JSON.stringify({ contextTokens: 50000, contextWindow: 200000, model: "m" });
    const result = formatContextUsage(json);
    // The exact separator depends on locale, but the number should be formatted
    expect(result).toContain("50");
    expect(result).toContain("200");
  });
});

// ---------------------------------------------------------------------------
// formatAnswers
// ---------------------------------------------------------------------------
describe("formatAnswers", () => {
  it("formats answers from message.answers map", () => {
    const msg = makeMessage({
      type: "question_answer",
      content: "{}",
      answers: { "Which color?": "Red", "Pick fruits?": ["Apple", "Banana"] },
    });
    const result = formatAnswers(msg);
    expect(result).toContain("Which color?: Red");
    expect(result).toContain("Pick fruits?: Apple, Banana");
  });

  it("handles single-select string answer", () => {
    const msg = makeMessage({
      type: "question_answer",
      content: "{}",
      answers: { "Q1?": "Yes" },
    });
    expect(formatAnswers(msg)).toBe("Q1?: Yes");
  });

  it("handles multi-select array answer", () => {
    const msg = makeMessage({
      type: "question_answer",
      content: "{}",
      answers: { "Q1?": ["A", "B", "C"] },
    });
    expect(formatAnswers(msg)).toBe("Q1?: A, B, C");
  });

  it("handles empty answers map", () => {
    const msg = makeMessage({
      type: "question_answer",
      content: "{}",
      answers: {},
    });
    expect(formatAnswers(msg)).toBe("");
  });

  it("falls back to parsing content JSON when answers is undefined", () => {
    const msg = makeMessage({
      type: "question_answer",
      content: JSON.stringify({ "Q?": "Answer" }),
    });
    expect(formatAnswers(msg)).toBe("Q?: Answer");
  });

  it("falls back to parsing content JSON with array values", () => {
    const msg = makeMessage({
      type: "question_answer",
      content: JSON.stringify({ "Q?": ["X", "Y"] }),
    });
    expect(formatAnswers(msg)).toBe("Q?: X, Y");
  });

  it("returns raw content when JSON parsing fails", () => {
    const msg = makeMessage({
      type: "question_answer",
      content: "plain text fallback",
    });
    expect(formatAnswers(msg)).toBe("plain text fallback");
  });

  it("joins multiple answers with newlines", () => {
    const msg = makeMessage({
      type: "question_answer",
      content: "{}",
      answers: { "Q1?": "A", "Q2?": "B" },
    });
    const result = formatAnswers(msg);
    expect(result).toBe("Q1?: A\nQ2?: B");
  });
});
