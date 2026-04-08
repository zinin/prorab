import { describe, it, expect } from "vitest";
import { buildReviewerList } from "../commands/run.js";

describe("buildReviewerList", () => {
  it("prepends primary reviewer before additional reviewers", () => {
    const reviewers = [
      { agent: "opencode" as const, model: "glm-4.7" },
    ];
    expect(buildReviewerList(reviewers, "claude", "sonnet", undefined)).toEqual([
      { agent: "claude", model: "sonnet" },
      { agent: "opencode", model: "glm-4.7" },
    ]);
  });

  it("prepends primary before multiple additional reviewers", () => {
    const reviewers = [
      { agent: "claude" as const, model: "opus" },
      { agent: "opencode" as const, model: "glm-4.7" },
    ];
    expect(buildReviewerList(reviewers, "claude", "sonnet", undefined)).toEqual([
      { agent: "claude", model: "sonnet" },
      { agent: "claude", model: "opus" },
      { agent: "opencode", model: "glm-4.7" },
    ]);
  });

  it("deduplicates when additional reviewer matches primary", () => {
    const reviewers = [
      { agent: "claude" as const, model: "sonnet" },
      { agent: "opencode" as const, model: "glm-4.7" },
    ];
    expect(buildReviewerList(reviewers, "claude", "sonnet", undefined)).toEqual(reviewers);
  });

  it("falls back to primary when reviewers empty", () => {
    expect(buildReviewerList([], "claude", "opus", "high")).toEqual([
      { agent: "claude", model: "opus", variant: "high" },
    ]);
  });

  it("falls back to primary when reviewers undefined", () => {
    expect(buildReviewerList(undefined, "opencode", "glm-4.7", undefined)).toEqual([
      { agent: "opencode", model: "glm-4.7" },
    ]);
  });
});
