import { describe, expect, it } from "vitest";
import {
  StartChatBodySchema,
  MessageBodySchema,
  ReplyQuestionBodySchema,
} from "../server/routes/chat.js";

describe("StartChatBodySchema", () => {
  it("accepts valid body with all fields", () => {
    const result = StartChatBodySchema.safeParse({
      agent: "claude",
      model: "opus",
      variant: "high",
      systemPrompt: "You are a helpful assistant.",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      agent: "claude",
      model: "opus",
      variant: "high",
      systemPrompt: "You are a helpful assistant.",
      userSettings: false,
      applyHooks: false,
    });
  });

  it("accepts valid body with only required fields (agent only)", () => {
    const result = StartChatBodySchema.safeParse({
      agent: "opencode",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      agent: "opencode",
      userSettings: false,
      applyHooks: false,
    });
  });

  it("accepts optional model and variant as undefined", () => {
    const result = StartChatBodySchema.safeParse({
      agent: "claude",
      systemPrompt: "hello",
    });
    expect(result.success).toBe(true);
    expect(result.data!.model).toBeUndefined();
    expect(result.data!.variant).toBeUndefined();
  });

  it("rejects missing agent", () => {
    const result = StartChatBodySchema.safeParse({
      systemPrompt: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("accepts missing systemPrompt (optional field)", () => {
    const result = StartChatBodySchema.safeParse({
      agent: "claude",
    });
    expect(result.success).toBe(true);
    expect(result.data!.systemPrompt).toBeUndefined();
  });

  it("rejects invalid agent type", () => {
    const result = StartChatBodySchema.safeParse({
      agent: "gpt",
      systemPrompt: "hello",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty body", () => {
    const result = StartChatBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = StartChatBodySchema.safeParse({
      agent: "claude",
      systemPrompt: "hello",
      extraField: "unexpected",
    });
    expect(result.success).toBe(false);
  });
});

describe("MessageBodySchema", () => {
  it("accepts valid message", () => {
    const result = MessageBodySchema.safeParse({
      text: "Hello, how are you?",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ text: "Hello, how are you?" });
  });

  it("rejects empty text", () => {
    const result = MessageBodySchema.safeParse({ text: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing text", () => {
    const result = MessageBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects non-string text", () => {
    const result = MessageBodySchema.safeParse({ text: 123 });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = MessageBodySchema.safeParse({ text: "hello", extra: "field" });
    expect(result.success).toBe(false);
  });
});

describe("ReplyQuestionBodySchema", () => {
  it("accepts answers with string values", () => {
    const result = ReplyQuestionBodySchema.safeParse({
      answers: { "Pick a color": "Red" },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ answers: { "Pick a color": "Red" } });
  });

  it("accepts answers with string array values", () => {
    const result = ReplyQuestionBodySchema.safeParse({
      answers: { "Select features": ["Auth", "DB", "Cache"] },
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      answers: { "Select features": ["Auth", "DB", "Cache"] },
    });
  });

  it("accepts mixed string and string array values", () => {
    const result = ReplyQuestionBodySchema.safeParse({
      answers: {
        "Single select": "option A",
        "Multi select": ["option B", "option C"],
      },
    });
    expect(result.success).toBe(true);
    expect(result.data!.answers["Single select"]).toBe("option A");
    expect(result.data!.answers["Multi select"]).toEqual(["option B", "option C"]);
  });

  it("accepts empty answers record", () => {
    const result = ReplyQuestionBodySchema.safeParse({ answers: {} });
    expect(result.success).toBe(true);
  });

  it("rejects missing answers", () => {
    const result = ReplyQuestionBodySchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects numeric answer values", () => {
    const result = ReplyQuestionBodySchema.safeParse({
      answers: { question: 42 },
    });
    expect(result.success).toBe(false);
  });

  it("rejects nested object answer values", () => {
    const result = ReplyQuestionBodySchema.safeParse({
      answers: { question: { nested: "value" } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = ReplyQuestionBodySchema.safeParse({
      answers: { q: "a" },
      extra: "field",
    });
    expect(result.success).toBe(false);
  });
});
