import { describe, it, expect } from "vitest";
import { ReviewerSchema } from "../types.js";
import { getReviewerId } from "../core/reviewer-utils.js";

describe("ReviewerSchema", () => {
  it("parses valid reviewer", () => {
    const result = ReviewerSchema.safeParse({ agent: "claude", model: "sonnet" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ agent: "claude", model: "sonnet" });
  });

  it("parses reviewer with variant", () => {
    const result = ReviewerSchema.safeParse({ agent: "opencode", model: "glm-4.7", variant: "fast" });
    expect(result.success).toBe(true);
  });

  it("parses reviewer with only agent", () => {
    const result = ReviewerSchema.safeParse({ agent: "claude" });
    expect(result.success).toBe(true);
  });

  it("rejects invalid agent", () => {
    const result = ReviewerSchema.safeParse({ agent: "unknown", model: "x" });
    expect(result.success).toBe(false);
  });
});

describe("getReviewerId", () => {
  it("generates id from agent and model", () => {
    expect(getReviewerId({ agent: "opencode", model: "glm-4.7" })).toBe("opencode-glm-4-7");
  });

  it("includes variant in id", () => {
    expect(getReviewerId({ agent: "claude", model: "sonnet", variant: "high" })).toBe("claude-sonnet-high");
  });

  it("uses 'default' when model is undefined", () => {
    expect(getReviewerId({ agent: "claude" })).toBe("claude-default");
  });

  it("normalizes slashes, dots and backslashes", () => {
    expect(getReviewerId({ agent: "opencode", model: "org/model.v2" })).toBe("opencode-org-model-v2");
  });

  it("rejects path traversal patterns", () => {
    expect(() => getReviewerId({ agent: "opencode", model: "../etc" })).toThrow();
  });
});
