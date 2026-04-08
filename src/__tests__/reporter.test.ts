import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendReport, readReport, getReportPath, stripReportMetadata, writeReviewerReport, readReviewerReport, getReviewerReportPath, getReviewReportPath, writeReviewReport, readReviewReport, getReworkReportPath, writeReworkReport, readReworkReport } from "../core/reporter.js";
import type { IterationResult } from "../types.js";

function makeResult(overrides: Partial<IterationResult> = {}): IterationResult {
  return {
    signal: { type: "complete" },
    durationMs: 158500,
    costUsd: 1.359,
    numTurns: 42,
    resultText: "some text <task-report>Did the thing.</task-report> <task-complete>DONE</task-complete>",
    inputTokens: 269,
    outputTokens: 6272,
    cacheReadTokens: 1632221,
    cacheWriteTokens: 70093,
    reasoningTokens: 0,
    model: "claude-opus-4-6",
    agentReport: "Did the thing.",
    reviewReport: null,
    startedAt: "2026-02-25T10:00:00.000Z",
    finishedAt: "2026-02-25T10:02:38.500Z",
    ...overrides,
  };
}

describe("appendReport", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prorab-reporter-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes structured report with agent report and commits", () => {
    appendReport(tempDir, "1.1", 1, makeResult(), {
      agentType: "claude",
      commits: ["abc1234 feat: add feature", "def5678 test: add tests"],
    });

    const content = readFileSync(getReportPath(tempDir, "1.1"), "utf-8");
    expect(content).toContain("## Iteration 1");
    expect(content).toContain("Status: complete");
    expect(content).toContain("Agent: claude");
    expect(content).toContain("Model: claude-opus-4-6");
    expect(content).toContain("Started: 2026-02-25T10:00:00.000Z");
    expect(content).toContain("Finished: 2026-02-25T10:02:38.500Z");
    expect(content).toContain("Duration: 158.5s");
    expect(content).toContain("Turns: 42");
    expect(content).toContain("Cost: $1.3590");
    expect(content).toContain("Input tokens: 269");
    expect(content).toContain("Output tokens: 6272");
    expect(content).toContain("Cache read tokens: 1632221");
    expect(content).toContain("Cache write tokens: 70093");
    expect(content).toContain("Reasoning tokens: 0");
    expect(content).toContain("### Commits");
    expect(content).toContain("- `abc1234` feat: add feature");
    expect(content).toContain("- `def5678` test: add tests");
    expect(content).toContain("### Agent Report");
    expect(content).toContain("Did the thing.");
  });

  it("writes fallback when agent report is null", () => {
    appendReport(tempDir, "2", 1, makeResult({ agentReport: null }), {
      agentType: "opencode",
      commits: [],
    });

    const content = readFileSync(getReportPath(tempDir, "2"), "utf-8");
    expect(content).toContain("Agent: opencode");
    expect(content).toContain("_Agent did not provide a report._");
    expect(content).toContain("_No commits._");
  });

  it("writes blocked status with reason", () => {
    appendReport(
      tempDir,
      "3",
      1,
      makeResult({
        signal: { type: "blocked", reason: "Missing API key" },
        agentReport: "Tried but couldn't proceed.",
      }),
      { agentType: "claude", commits: [] },
    );

    const content = readFileSync(getReportPath(tempDir, "3"), "utf-8");
    expect(content).toContain("Status: blocked: Missing API key");
  });

  it("writes error status with message", () => {
    appendReport(
      tempDir,
      "5",
      1,
      makeResult({
        signal: { type: "error", message: "SDK crashed" },
      }),
      { agentType: "claude", commits: [] },
    );

    const content = readFileSync(getReportPath(tempDir, "5"), "utf-8");
    expect(content).toContain("Status: error: SDK crashed");
  });

  it("appends multiple iterations to same file", () => {
    const ctx = { agentType: "claude", commits: [] };
    appendReport(tempDir, "4", 1, makeResult(), ctx);
    appendReport(tempDir, "4", 2, makeResult(), ctx);

    const content = readFileSync(getReportPath(tempDir, "4"), "utf-8");
    expect(content).toContain("## Iteration 1");
    expect(content).toContain("## Iteration 2");
  });
});

describe("stripReportMetadata", () => {
  it("strips metadata lines from a report", () => {
    const report = `## Iteration 1

Status: complete
Agent: claude
Model: claude-opus-4-6
Started: 2026-02-27T18:40:35.814Z
Finished: 2026-02-27T18:42:31.593Z
Duration: 110.8s
Turns: 30
Cost: $0.6493
Input tokens: 6648
Output tokens: 5188
Cache read tokens: 594841
Cache write tokens: 51593
Reasoning tokens: 0

### Commits
- \`abc1234\` feat: add feature

### Agent Report
Task completed successfully.

---
`;
    const result = stripReportMetadata(report);
    expect(result).toContain("## Iteration 1");
    expect(result).toContain("### Commits");
    expect(result).toContain("- `abc1234` feat: add feature");
    expect(result).toContain("### Agent Report");
    expect(result).toContain("Task completed successfully.");
    expect(result).not.toContain("Status:");
    expect(result).not.toContain("Agent:");
    expect(result).not.toContain("Model:");
    expect(result).not.toContain("Started:");
    expect(result).not.toContain("Finished:");
    expect(result).not.toContain("Duration:");
    expect(result).not.toContain("Turns:");
    expect(result).not.toContain("Cost:");
    expect(result).not.toContain("Input tokens:");
    expect(result).not.toContain("Output tokens:");
    expect(result).not.toContain("Cache read tokens:");
    expect(result).not.toContain("Cache write tokens:");
    expect(result).not.toContain("Reasoning tokens:");
  });

  it("preserves content with colons that are not metadata", () => {
    const report = `## Iteration 1

### Agent Report
Fixed issue: the timeout was too short.
Error message: connection refused.
`;
    const result = stripReportMetadata(report);
    expect(result).toContain("Fixed issue: the timeout was too short.");
    expect(result).toContain("Error message: connection refused.");
  });

  it("collapses multiple blank lines", () => {
    const report = `## Iteration 1

Status: complete
Agent: claude


### Commits
_No commits._`;
    const result = stripReportMetadata(report);
    expect(result).not.toMatch(/\n{3,}/);
  });
});

describe("writeReviewerReport / readReviewerReport", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prorab-reviewer-report-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("writes and reads individual reviewer report", () => {
    writeReviewerReport(tempDir, "5", "claude-default", "Good code");
    const content = readReviewerReport(tempDir, "5", "claude-default");
    expect(content).toBe("Good code");
  });

  it("returns null for non-existent reviewer report", () => {
    expect(readReviewerReport(tempDir, "5", "opencode-glm")).toBeNull();
  });

  it("generates correct file path", () => {
    const path = getReviewerReportPath(tempDir, "5", "opencode-glm-4.7");
    expect(path).toContain("5-review-opencode-glm-4.7.md");
  });
});

describe("round-aware report paths", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prorab-round-reporter-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("getReviewReportPath returns standard path without round", () => {
    const path = getReviewReportPath(tempDir, "5");
    expect(path).toContain("5-review.md");
    expect(path).not.toMatch(/-r\d/);
  });

  it("getReviewReportPath returns round-suffixed path when round > 0", () => {
    const path = getReviewReportPath(tempDir, "5", 2);
    expect(path).toContain("5-review-r2.md");
  });

  it("getReviewerReportPath returns round-suffixed path", () => {
    const path = getReviewerReportPath(tempDir, "5", "claude-default", 3);
    expect(path).toContain("5-review-r3-claude-default.md");
  });

  it("getReviewerReportPath returns standard path without round", () => {
    const path = getReviewerReportPath(tempDir, "5", "claude-default");
    expect(path).toContain("5-review-claude-default.md");
  });

  it("getReworkReportPath returns standard path without round", () => {
    const path = getReworkReportPath(tempDir, "5");
    expect(path).toContain("5-rework.md");
  });

  it("getReworkReportPath returns round-suffixed path when round > 0", () => {
    const path = getReworkReportPath(tempDir, "5", 2);
    expect(path).toContain("5-rework-r2.md");
  });

  it("writeReworkReport + readReworkReport roundtrip", () => {
    writeReworkReport(tempDir, "5", "Rework content", 2);
    const content = readReworkReport(tempDir, "5", 2);
    expect(content).toBe("Rework content");
  });

  it("readReworkReport returns null for missing file", () => {
    expect(readReworkReport(tempDir, "5")).toBeNull();
  });

  it("writeReviewReport + readReviewReport roundtrip with round", () => {
    writeReviewReport(tempDir, "5", "Review round 3 content", 3);
    const content = readReviewReport(tempDir, "5", 3);
    expect(content).toBe("Review round 3 content");
  });

  it("writeReviewerReport + readReviewerReport roundtrip with round", () => {
    writeReviewerReport(tempDir, "5", "claude-default", "Reviewer round 1", 1);
    const content = readReviewerReport(tempDir, "5", "claude-default", 1);
    expect(content).toBe("Reviewer round 1");
  });
});
