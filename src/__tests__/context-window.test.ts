import { describe, it, expect, beforeEach } from "vitest";
import { getContextWindow, setContextWindow, _resetContextWindowCache } from "../core/drivers/context-window.js";

describe("getContextWindow", () => {
  beforeEach(() => {
    _resetContextWindowCache();
  });

  it("returns 200_000 for model containing 'opus'", () => {
    expect(getContextWindow("claude-opus-4-6")).toBe(200_000);
  });

  it("returns 200_000 for model containing 'sonnet'", () => {
    expect(getContextWindow("claude-sonnet-4-6")).toBe(200_000);
  });

  it("returns 200_000 for model containing 'haiku'", () => {
    expect(getContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("returns 200_000 as default for unknown model", () => {
    expect(getContextWindow("gpt-4o")).toBe(200_000);
  });

  it("matches model substring (e.g. composite OpenCode IDs)", () => {
    expect(getContextWindow("anthropic/claude-opus-4-6")).toBe(200_000);
  });

  it("matches abstract model names (e.g. 'claude-3-opus-20240229')", () => {
    expect(getContextWindow("claude-3-opus-20240229")).toBe(200_000);
  });
});

describe("setContextWindow / cache", () => {
  beforeEach(() => {
    _resetContextWindowCache();
  });

  it("cached value is returned by getContextWindow", () => {
    setContextWindow("claude-opus-4-6[1m]", 1_000_000);
    expect(getContextWindow("claude-opus-4-6[1m]")).toBe(1_000_000);
  });

  it("cached value takes priority over hardcoded substring match", () => {
    setContextWindow("claude-opus-4-6", 1_000_000);
    expect(getContextWindow("claude-opus-4-6")).toBe(1_000_000);
  });

  it("uncached models still use hardcoded substring match", () => {
    setContextWindow("claude-opus-4-6[1m]", 1_000_000);
    expect(getContextWindow("claude-3-opus-20240229")).toBe(200_000);
  });

  it("ignores empty model string", () => {
    setContextWindow("", 1_000_000);
    expect(getContextWindow("")).toBe(200_000);
  });

  it("ignores zero contextWindow", () => {
    setContextWindow("claude-opus-4-6", 0);
    expect(getContextWindow("claude-opus-4-6")).toBe(200_000);
  });

  it("ignores negative contextWindow", () => {
    setContextWindow("claude-opus-4-6", -1);
    expect(getContextWindow("claude-opus-4-6")).toBe(200_000);
  });

  it("_resetContextWindowCache clears all cached values", () => {
    setContextWindow("claude-opus-4-6[1m]", 1_000_000);
    expect(getContextWindow("claude-opus-4-6[1m]")).toBe(1_000_000);
    _resetContextWindowCache();
    expect(getContextWindow("claude-opus-4-6[1m]")).toBe(200_000);
  });
});
