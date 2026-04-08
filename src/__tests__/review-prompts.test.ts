import { describe, it, expect } from "vitest";
import {
  buildReviewPrompt,
  buildReviewSystemPrompt,
  buildReworkPrompt,
  buildReworkSystemPrompt,
  buildAggregationSystemPrompt,
  buildAggregationTaskPrompt,
} from "../prompts/review.js";

describe("buildReviewPrompt", () => {
  it("includes task requirements", () => {
    const prompt = buildReviewPrompt({
      taskTitle: "Add auth",
      taskDescription: "Implement login",
      taskDetails: "Use JWT",
      executionReport: "Implemented login with JWT",
      gitRange: { startRev: "abc", endRev: "def" },
    });
    expect(prompt).toContain("Add auth");
    expect(prompt).toContain("Implement login");
    expect(prompt).toContain("Use JWT");
    expect(prompt).toContain("abc..def");
  });

  it("includes git commands for the agent", () => {
    const prompt = buildReviewPrompt({
      taskTitle: "Test",
      executionReport: "Done",
      gitRange: { startRev: "aaa", endRev: "bbb" },
    });
    expect(prompt).toContain("git diff aaa..bbb");
    expect(prompt).toContain("git log");
  });

  it("handles missing optional fields", () => {
    const prompt = buildReviewPrompt({
      taskTitle: "Test",
      executionReport: "Done",
      gitRange: { startRev: "aaa", endRev: "bbb" },
    });
    expect(prompt).toContain("Test");
    expect(prompt).not.toContain("undefined");
  });
});

describe("buildReviewSystemPrompt", () => {
  it("includes review checklist", () => {
    const prompt = buildReviewSystemPrompt();
    expect(prompt).toContain("Code Quality");
    expect(prompt).toContain("Architecture");
    expect(prompt).toContain("Testing");
    expect(prompt).toContain("Requirements Alignment");
    expect(prompt).toContain("Production Readiness");
  });

  it("includes output format", () => {
    const prompt = buildReviewSystemPrompt();
    expect(prompt).toContain("Strengths");
    expect(prompt).toContain("Issues");
    expect(prompt).toContain("Verdict");
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("IMPORTANT");
    expect(prompt).toContain("MINOR");
  });

  it("includes task-complete signal", () => {
    const prompt = buildReviewSystemPrompt();
    expect(prompt).toContain("<task-complete>");
  });
});

describe("buildReviewPrompt with previous round context", () => {
  it("includes previous round context when provided", () => {
    const prompt = buildReviewPrompt({
      taskTitle: "Test",
      executionReport: "exec report",
      gitRange: { startRev: "aaa", endRev: "bbb" },
      previousRoundContext: [
        { round: 1, reviewReport: "review findings r1", reworkReport: "rework fixes r1" },
      ],
    });
    expect(prompt).toContain("Previous Review Rounds");
    expect(prompt).toContain("Round 1 Review");
    expect(prompt).toContain("review findings r1");
    expect(prompt).toContain("Round 1 Rework");
    expect(prompt).toContain("rework fixes r1");
  });

  it("omits previous round section when no context", () => {
    const prompt = buildReviewPrompt({
      taskTitle: "Test",
      executionReport: "exec report",
      gitRange: { startRev: "aaa", endRev: "bbb" },
    });
    expect(prompt).not.toContain("Previous Review Rounds");
  });

  it("handles multiple rounds of context", () => {
    const prompt = buildReviewPrompt({
      taskTitle: "Test",
      executionReport: "exec report",
      gitRange: { startRev: "aaa", endRev: "bbb" },
      previousRoundContext: [
        { round: 1, reviewReport: "review r1", reworkReport: "rework r1" },
        { round: 2, reviewReport: "review r2", reworkReport: "rework r2" },
      ],
    });
    expect(prompt).toContain("Round 1 Review");
    expect(prompt).toContain("Round 2 Review");
    expect(prompt).toContain("Round 1 Rework");
    expect(prompt).toContain("Round 2 Rework");
  });

  it("handles null reworkReport in context", () => {
    const prompt = buildReviewPrompt({
      taskTitle: "Test",
      executionReport: "exec report",
      gitRange: { startRev: "aaa", endRev: "bbb" },
      previousRoundContext: [
        { round: 1, reviewReport: "review findings r1", reworkReport: null },
      ],
    });
    expect(prompt).toContain("Round 1 Review");
    expect(prompt).toContain("review findings r1");
    expect(prompt).not.toContain("Round 1 Rework");
  });
});

describe("buildReworkPrompt", () => {
  it("includes task requirements and review feedback", () => {
    const prompt = buildReworkPrompt({
      taskTitle: "Add auth",
      taskDescription: "Implement login",
      taskDetails: "Use JWT",
      reviewResult: "Issue: No input validation",
    });
    expect(prompt).toContain("Add auth");
    expect(prompt).toContain("Implement login");
    expect(prompt).toContain("No input validation");
  });

  it("includes priority instructions", () => {
    const prompt = buildReworkPrompt({
      taskTitle: "Test",
      reviewResult: "Issues found",
    });
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("IMPORTANT");
    expect(prompt).toContain("MINOR");
  });
});

describe("buildReworkSystemPrompt", () => {
  it("includes working directory", () => {
    const prompt = buildReworkSystemPrompt("/my/project");
    expect(prompt).toContain("/my/project");
  });

  it("includes rules for rework agent", () => {
    const prompt = buildReworkSystemPrompt("/tmp");
    expect(prompt).toContain("Fix all issues");
    expect(prompt).toContain("<task-complete>");
    expect(prompt).toContain("<task-blocked>");
    expect(prompt).toContain("<task-report>");
  });
});

describe("buildAggregationSystemPrompt", () => {
  it("includes deduplication instructions", () => {
    const prompt = buildAggregationSystemPrompt();
    expect(prompt).toContain("deduplic");
    expect(prompt).toContain("<review-report>");
    expect(prompt).toContain("<task-complete>");
  });

  it("includes priority levels", () => {
    const prompt = buildAggregationSystemPrompt();
    expect(prompt).toContain("CRITICAL");
    expect(prompt).toContain("IMPORTANT");
    expect(prompt).toContain("MINOR");
  });
});

describe("buildAggregationTaskPrompt", () => {
  it("includes all reviewer reports with headers", () => {
    const prompt = buildAggregationTaskPrompt([
      { reviewerId: "claude-default", report: "Report A" },
      { reviewerId: "opencode-glm-4.7", report: "Report B" },
    ]);
    expect(prompt).toContain("## Report from reviewer: claude-default");
    expect(prompt).toContain("Report A");
    expect(prompt).toContain("## Report from reviewer: opencode-glm-4.7");
    expect(prompt).toContain("Report B");
  });

  it("handles single report", () => {
    const prompt = buildAggregationTaskPrompt([
      { reviewerId: "claude-default", report: "Only report" },
    ]);
    expect(prompt).toContain("Only report");
  });
});
