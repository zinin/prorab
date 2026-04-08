import { describe, it, expect, beforeEach } from "vitest";
import { getContextWindow, setContextWindow, _resetContextWindowCache } from "../core/drivers/context-window.js";

describe("Claude context_usage event construction", () => {
  beforeEach(() => {
    _resetContextWindowCache();
  });

  it("constructs correct context_usage event from message_start usage", () => {
    const usage = {
      input_tokens: 35,
      cache_read_input_tokens: 150_000,
      cache_creation_input_tokens: 10_000,
      output_tokens: 1,
    };
    const model = "claude-opus-4-6";

    const contextTokens =
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0);

    const event = {
      type: "agent:context_usage" as const,
      contextTokens,
      contextWindow: getContextWindow(model),
      model,
      unitId: "1.1",
    };

    expect(event.contextTokens).toBe(160_035);
    expect(event.contextWindow).toBe(200_000);
    expect(event.model).toBe("claude-opus-4-6");
  });

  it("handles missing cache fields gracefully", () => {
    const usage = { input_tokens: 5000 };
    const contextTokens =
      ((usage as Record<string, number>).input_tokens || 0) +
      ((usage as Record<string, number>).cache_read_input_tokens || 0) +
      ((usage as Record<string, number>).cache_creation_input_tokens || 0);

    expect(contextTokens).toBe(5000);
  });

  it("uses SDK-cached contextWindow when available", () => {
    setContextWindow("claude-opus-4-6[1m]", 1_000_000);

    const model = "claude-opus-4-6[1m]";
    const event = {
      type: "agent:context_usage" as const,
      contextTokens: 160_035,
      contextWindow: getContextWindow(model),
      model,
      unitId: "1.1",
    };

    expect(event.contextWindow).toBe(1_000_000);
  });
});
