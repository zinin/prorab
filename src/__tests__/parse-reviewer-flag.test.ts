import { describe, it, expect } from "vitest";
import { parseReviewerSpec } from "../core/reviewer-utils.js";

describe("parseReviewerSpec", () => {
  it("parses agent:model", () => {
    expect(parseReviewerSpec("opencode:glm-4.7")).toEqual({
      agent: "opencode", model: "glm-4.7",
    });
  });

  it("parses agent:model:variant", () => {
    expect(parseReviewerSpec("claude:sonnet:high")).toEqual({
      agent: "claude", model: "sonnet", variant: "high",
    });
  });

  it("throws on invalid format (no colon)", () => {
    expect(() => parseReviewerSpec("invalid")).toThrow();
  });

  it("throws on invalid agent", () => {
    expect(() => parseReviewerSpec("unknown:model")).toThrow();
  });

  it("handles model with colon (last segment is variant)", () => {
    expect(parseReviewerSpec("opencode:org:model:high")).toEqual({
      agent: "opencode", model: "org:model", variant: "high",
    });
  });

  // Known limitation of last-colon split: without an explicit variant,
  // a model containing colons (e.g. "org:model") is ambiguous — the last
  // segment is always treated as variant.  To pass a colon-containing model,
  // append the variant explicitly: "opencode:org:model:high".
  it("handles model with colon and no variant", () => {
    expect(parseReviewerSpec("opencode:org:model")).toEqual({
      agent: "opencode", model: "org", variant: "model",
    });
  });

  // Ollama cloud model ids embed `:cloud` / `:cloud[Nm]` and have no variant
  // concept (cloud models ignore Claude's effort knob; OllamaDriver strips
  // opts.variant before delegation). Last-colon split would mis-parse
  // `ollama:deepseek-v4-pro:cloud[1m]` as model=`deepseek-v4-pro`,
  // variant=`cloud[1m]`, which setup() would then reject as non-cloud.
  it("treats entire remainder as model for ollama (no last-colon split)", () => {
    expect(parseReviewerSpec("ollama:deepseek-v4-pro:cloud[1m]")).toEqual({
      agent: "ollama", model: "deepseek-v4-pro:cloud[1m]",
    });
    expect(parseReviewerSpec("ollama:qwen3-coder:480b-cloud[1m]")).toEqual({
      agent: "ollama", model: "qwen3-coder:480b-cloud[1m]",
    });
    expect(parseReviewerSpec("ollama:kimi-k2.6:cloud")).toEqual({
      agent: "ollama", model: "kimi-k2.6:cloud",
    });
  });
});
