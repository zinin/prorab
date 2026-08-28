import { describe, it, expect, beforeEach } from "vitest";
import { getContextWindow, setContextWindow, _resetContextWindowCache } from "../core/drivers/context-window.js";

describe("getContextWindow", () => {
  beforeEach(() => {
    _resetContextWindowCache();
  });

  it("returns 1_000_000 for Claude 4.x opus models", () => {
    expect(getContextWindow("claude-opus-4-6")).toBe(1_000_000);
  });

  it("returns 1_000_000 for Claude 4.x sonnet models", () => {
    expect(getContextWindow("claude-sonnet-4-6")).toBe(1_000_000);
  });

  it("returns 200_000 for model containing 'haiku'", () => {
    expect(getContextWindow("claude-haiku-4-5-20251001")).toBe(200_000);
  });

  it("returns 200_000 as default for unknown model", () => {
    expect(getContextWindow("gpt-4o")).toBe(200_000);
  });

  it("matches model substring (e.g. composite OpenCode IDs)", () => {
    expect(getContextWindow("anthropic/claude-opus-4-6")).toBe(1_000_000);
  });

  it("legacy Claude 3 models fall back to default 200_000", () => {
    expect(getContextWindow("claude-3-opus-20240229")).toBe(200_000);
  });

  it("returns 1_000_000 for the [1m] variants the SDK reports", () => {
    // Both the selectable id and the resolved id carry the marker.
    expect(getContextWindow("opus[1m]")).toBe(1_000_000);
    expect(getContextWindow("claude-opus-5[1m]")).toBe(1_000_000);
    expect(getContextWindow("claude-fable-5[1m]")).toBe(1_000_000);
  });

  it("returns 200_000 for Claude 5 ids without the [1m] marker", () => {
    expect(getContextWindow("claude-opus-5")).toBe(200_000);
    expect(getContextWindow("claude-sonnet-5")).toBe(200_000);
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
    setContextWindow("custom-model", 0);
    expect(getContextWindow("custom-model")).toBe(200_000);
  });

  it("ignores negative contextWindow", () => {
    setContextWindow("custom-model", -1);
    expect(getContextWindow("custom-model")).toBe(200_000);
  });

  it("a plan-reported 200K does not mask the 1M capability of a [1m] model", () => {
    // The guard exists precisely for this: an SDK-reported API limit below the
    // known model capability must be rejected, not cached.
    setContextWindow("claude-opus-5[1m]", 200_000);
    expect(getContextWindow("claude-opus-5[1m]")).toBe(1_000_000);
  });

  it("Ollama-cloud limits below the default still survive (no baseline to defend)", () => {
    setContextWindow("glm-5.1:cloud", 198_000);
    expect(getContextWindow("glm-5.1:cloud")).toBe(198_000);
  });

  it("_resetContextWindowCache clears all cached values", () => {
    setContextWindow("custom-model", 500_000);
    expect(getContextWindow("custom-model")).toBe(500_000);
    _resetContextWindowCache();
    expect(getContextWindow("custom-model")).toBe(200_000);
  });
});
