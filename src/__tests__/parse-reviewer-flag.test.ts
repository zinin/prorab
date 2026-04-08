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
});
