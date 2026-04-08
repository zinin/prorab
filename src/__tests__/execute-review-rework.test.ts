import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentDriver } from "../core/drivers/types.js";
import type { IterationResult, RunOptions, Task } from "../types.js";
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// --- Mocks ---

vi.mock("../core/tasks-json.js", () => {
  const _showTaskById = vi.fn().mockReturnValue({ id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [], metadata: {} });
  return {
    getAttemptCount: vi.fn().mockReturnValue(0),
    incrementAttemptCount: vi.fn().mockReturnValue(1),
    setStatusDirect: vi.fn(),
    setRevisions: vi.fn(),
    getRevisions: vi.fn().mockReturnValue(null),
    getTaskRevisions: vi.fn().mockReturnValue(null),
    setMetadata: vi.fn(),
    showTaskById: _showTaskById,
    getReviewRoundInfo: vi.fn().mockImplementation((taskId: string, cwd: string) => {
      const task = _showTaskById(taskId, cwd);
      const total = typeof task.metadata?.reviewRoundsTotal === "number" ? task.metadata.reviewRoundsTotal : 1;
      const round = typeof task.metadata?.reviewRound === "number" ? task.metadata.reviewRound : undefined;
      const suffix = total > 1 ? round : undefined;
      return { reviewRoundsTotal: total, reviewRound: round, roundSuffix: suffix };
    }),
    findNextAction: vi.fn(),
    readTasksFile: vi.fn().mockReturnValue({ tasks: [] }),
    TASK_FINAL_STATUSES: new Set(["closed"]),
    TaskNotFoundError: class extends Error {},
  };
});

vi.mock("../core/reporter.js", () => ({
  readReport: vi.fn().mockReturnValue(null),
  appendReport: vi.fn(),
  getReportPath: vi.fn().mockReturnValue("/fake/report.md"),
  writeReviewReport: vi.fn(),
  writeReviewerReport: vi.fn(),
  readReviewReport: vi.fn().mockReturnValue(null),
  readReworkReport: vi.fn().mockReturnValue(null),
  writeReworkReport: vi.fn(),
  getReviewReportPath: vi.fn().mockReturnValue("/fake/review-report.md"),
  stripReportMetadata: vi.fn((report: string) => report),
}));

vi.mock("../core/git.js", () => ({
  autoCommit: vi.fn().mockReturnValue(false),
  commitTaskmaster: vi.fn(),
  ensureLockNotTracked: vi.fn(),
  restoreTaskmasterIfTouched: vi.fn().mockReturnValue(false),
  getHeadRev: vi.fn().mockReturnValue("abc123"),
  getCommitsBetween: vi.fn().mockReturnValue([]),
}));

vi.mock("../prompts/execute.js", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
  buildPrompt: vi.fn().mockReturnValue("task prompt"),
}));

vi.mock("../prompts/review.js", () => ({
  buildReviewSystemPrompt: vi.fn().mockReturnValue("review system prompt"),
  buildReviewPrompt: vi.fn().mockReturnValue("review prompt"),
  buildReworkSystemPrompt: vi.fn().mockReturnValue("rework system prompt"),
  buildReworkPrompt: vi.fn().mockReturnValue("rework prompt"),
  buildAggregationSystemPrompt: vi.fn().mockReturnValue("aggregation system prompt"),
  buildAggregationTaskPrompt: vi.fn().mockReturnValue("aggregation task prompt"),
}));

// Mock createDriver so executeReview's internal fresh drivers use our mock
vi.mock("../core/drivers/factory.js", () => ({
  createDriver: vi.fn(),
}));

// Mock getReviewerId
vi.mock("../core/reviewer-utils.js", () => ({
  getReviewerId: vi.fn().mockReturnValue("claude-default"),
}));

import { executeReview, executeRework, executeReviewCycle } from "../commands/run.js";
import { setStatusDirect, getTaskRevisions, showTaskById, setMetadata, getReviewRoundInfo } from "../core/tasks-json.js";
import { readReport, writeReviewReport, writeReviewerReport, readReviewReport, writeReworkReport, appendReport } from "../core/reporter.js";
import { commitTaskmaster, ensureLockNotTracked, autoCommit } from "../core/git.js";
import { createDriver } from "../core/drivers/factory.js";
import { chatStubs } from "./helpers/driver-stubs.js";

function makeResult(signal: IterationResult["signal"], extra?: Partial<IterationResult>): IterationResult {
  return {
    signal,
    durationMs: 1000,
    costUsd: 0.01,
    numTurns: 5,
    resultText: "review output text",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    model: "test-model",
    agentReport: null,
    reviewReport: null,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:01:00Z",
    ...extra,
  };
}

function makeDriver(result: IterationResult): AgentDriver {
  return {
    runSession: vi.fn(async () => result),
    ...chatStubs,
  };
}

const defaultOptions: RunOptions = {
  agent: "claude",
  maxRetries: 0,
  maxTurns: 10,
  allowDirty: false,
  quiet: false,
  debug: false,
  trace: false,
  userSettings: false,
  review: true,
  reviewRounds: 1,
  reviewContext: false,
};

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 5,
    title: "Test task",
    description: "A task to test",
    status: "done",
    dependencies: [],
    subtasks: [],
    details: "Some details",
    testStrategy: "Run vitest",
    ...overrides,
  } as Task;
}

function makeTotals() {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    durationMs: 0,
    numTurns: 0,
    iterations: 0,
  };
}

describe("executeReview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Default: revisions exist
    vi.mocked(getTaskRevisions).mockReturnValue({ startRev: "aaa111", endRev: "bbb222" });
    vi.mocked(readReport).mockReturnValue("execution report content");
  });

  /** Helper: mock createDriver to return a driver producing the given result. */
  function mockCreateDriver(result: IterationResult) {
    const mockDriver = makeDriver(result);
    vi.mocked(createDriver).mockReturnValue(mockDriver);
    return mockDriver;
  }

  describe("signal matrix", () => {
    it("complete signal → task transitions done → review → rework, review report written", async () => {
      const mockDriver = mockCreateDriver(makeResult({ type: "complete" }, { reviewReport: "review output text" }));
      const driver = makeDriver(makeResult({ type: "complete" })); // passed-in driver (unused by new code)
      const task = makeTask({ status: "done" });

      const result = await executeReview(task, "/fake/cwd", defaultOptions, driver, () => false);

      expect(result).toBe(true);
      // First call: transition to review; second call: transition to rework
      expect(setStatusDirect).toHaveBeenCalledWith("5", "review", "/fake/cwd");
      expect(setStatusDirect).toHaveBeenCalledWith("5", "rework", "/fake/cwd");
      expect(writeReviewReport).toHaveBeenCalledWith("/fake/cwd", "5", expect.any(String), undefined);
      expect(commitTaskmaster).toHaveBeenCalled();
      // createDriver was called to create fresh reviewer driver
      expect(createDriver).toHaveBeenCalled();
    });

    it("blocked signal → reviewer has report text → single report → task transitions to rework", async () => {
      // In multi-reviewer mode, a blocked signal WITH a reviewReport still counts as a report
      mockCreateDriver(makeResult({ type: "blocked", reason: "Cannot review" }, { reviewReport: "some review" }));
      const driver = makeDriver(makeResult({ type: "complete" }));
      const task = makeTask({ status: "done" });

      const result = await executeReview(task, "/fake/cwd", defaultOptions, driver, () => false);

      // With 1 report available (even from blocked reviewer), single-report path → rework
      expect(result).toBe(true);
      expect(setStatusDirect).toHaveBeenCalledWith("5", "review", "/fake/cwd");
      expect(setStatusDirect).toHaveBeenCalledWith("5", "rework", "/fake/cwd");
      expect(writeReviewReport).toHaveBeenCalled();
      expect(commitTaskmaster).toHaveBeenCalled();
    });

    it("error signal with no report → 0 reports → task moves to blocked", async () => {
      // Error with no reviewReport/agentReport/resultText → null report → 0 reports → blocked
      mockCreateDriver(makeResult({ type: "error", message: "SDK crash" }, { reviewReport: null, agentReport: null, resultText: "" }));
      const driver = makeDriver(makeResult({ type: "complete" }));
      const task = makeTask({ status: "done" });

      const result = await executeReview(task, "/fake/cwd", defaultOptions, driver, () => false);

      expect(result).toBe(false);
      expect(setStatusDirect).toHaveBeenCalledWith("5", "review", "/fake/cwd");
      expect(setStatusDirect).toHaveBeenCalledWith("5", "blocked", "/fake/cwd");
      expect(writeReviewReport).toHaveBeenCalled();
      expect(commitTaskmaster).toHaveBeenCalled();
    });

    it("no signal with only resultText (no tags) → no report → task transitions to blocked", async () => {
      // resultText without reviewReport/agentReport is not treated as a valid report
      mockCreateDriver(makeResult({ type: "none" }, { resultText: "some review text" }));
      const driver = makeDriver(makeResult({ type: "complete" }));
      const task = makeTask({ status: "done" });

      const result = await executeReview(task, "/fake/cwd", defaultOptions, driver, () => false);

      // 0 reports → blocked
      expect(result).toBe(false);
      expect(setStatusDirect).toHaveBeenCalledWith("5", "review", "/fake/cwd");
      expect(setStatusDirect).toHaveBeenCalledWith("5", "blocked", "/fake/cwd");
      expect(writeReviewReport).toHaveBeenCalled();
    });
  });

  describe("edge cases", () => {
    it("no git revisions → task transitions to blocked, review report explains why", async () => {
      vi.mocked(getTaskRevisions).mockReturnValue(null);
      mockCreateDriver(makeResult({ type: "complete" }));
      const driver = makeDriver(makeResult({ type: "complete" }));
      const task = makeTask({ status: "done" });

      const result = await executeReview(task, "/fake/cwd", defaultOptions, driver, () => false);

      expect(result).toBe(false);
      // Should set review first, then blocked
      expect(setStatusDirect).toHaveBeenCalledWith("5", "review", "/fake/cwd");
      expect(setStatusDirect).toHaveBeenCalledWith("5", "blocked", "/fake/cwd");
      // Review report should explain the issue
      expect(writeReviewReport).toHaveBeenCalledWith(
        "/fake/cwd",
        "5",
        expect.stringContaining("no git revisions"),
        undefined,
      );
      // createDriver should NOT have been called (early exit before reviewer loop)
      expect(createDriver).not.toHaveBeenCalled();
      expect(commitTaskmaster).toHaveBeenCalled();
    });

    it("task with subtasks → collects all subtask reports", async () => {
      const task = makeTask({
        subtasks: [
          { id: 1, title: "Sub 1", status: "done", dependencies: [] } as any,
          { id: 2, title: "Sub 2", status: "done", dependencies: [] } as any,
        ],
      });

      // Return different reports for each subtask
      vi.mocked(readReport)
        .mockReturnValueOnce("Report for subtask 1")
        .mockReturnValueOnce("Report for subtask 2");

      mockCreateDriver(makeResult({ type: "complete" }, { reviewReport: "review" }));
      const driver = makeDriver(makeResult({ type: "complete" }));

      await executeReview(task, "/fake/cwd", defaultOptions, driver, () => false);

      // Should have read reports for both subtasks
      expect(readReport).toHaveBeenCalledWith("/fake/cwd", "5.1");
      expect(readReport).toHaveBeenCalledWith("/fake/cwd", "5.2");
    });
  });

  it("accumulates budget and totals (budget decremented once, iterations incremented once)", async () => {
    mockCreateDriver(makeResult({ type: "complete" }, { reviewReport: "review text" }));
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask();
    const budget = { remaining: 3 };
    const totals = makeTotals();

    await executeReview(task, "/fake/cwd", defaultOptions, driver, () => false, undefined, budget, totals);

    // Budget is decremented once for the entire review (1 logical iteration)
    expect(budget.remaining).toBe(2);
    expect(totals.iterations).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.01);
    expect(totals.inputTokens).toBe(100);
    expect(totals.outputTokens).toBe(50);
  });
});

describe("executeRework", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readReviewReport).mockReturnValue("Review feedback content");
  });

  describe("signal matrix", () => {
    it("complete signal → task transitions rework → closed", async () => {
      const driver = makeDriver(makeResult({ type: "complete" }));
      const task = makeTask({ status: "rework" });

      const result = await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

      expect(result).toBe(true);
      // Should NOT set to in-progress; should set to closed
      expect(setStatusDirect).toHaveBeenCalledTimes(1);
      expect(setStatusDirect).toHaveBeenCalledWith("5", "closed", "/fake/cwd");
      expect(ensureLockNotTracked).toHaveBeenCalled();
      expect(autoCommit).toHaveBeenCalled();
      expect(appendReport).toHaveBeenCalledWith(
        "/fake/cwd",
        "5-rework",
        1,
        expect.any(Object),
        expect.any(Object),
      );
      expect(commitTaskmaster).toHaveBeenCalled();
    });

    it("blocked signal → task transitions rework → blocked", async () => {
      const driver = makeDriver(makeResult({ type: "blocked", reason: "Cannot fix" }));
      const task = makeTask({ status: "rework" });

      const result = await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

      expect(result).toBe(false);
      expect(setStatusDirect).toHaveBeenCalledTimes(1);
      expect(setStatusDirect).toHaveBeenCalledWith("5", "blocked", "/fake/cwd");
      expect(commitTaskmaster).toHaveBeenCalled();
    });

    it("error/no signal → task stays in rework (resumable), returns false", async () => {
      const driver = makeDriver(makeResult({ type: "error", message: "crash" }));
      const task = makeTask({ status: "rework" });

      const result = await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

      expect(result).toBe(false);
      // No status transition at all — task stays in rework
      expect(setStatusDirect).not.toHaveBeenCalled();
      expect(commitTaskmaster).toHaveBeenCalledWith(
        "/fake/cwd",
        expect.stringContaining("rework incomplete"),
      );
    });

    it("no signal → task stays in rework (resumable), returns false", async () => {
      const driver = makeDriver(makeResult({ type: "none" }));
      const task = makeTask({ status: "rework" });

      const result = await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

      expect(result).toBe(false);
      expect(setStatusDirect).not.toHaveBeenCalled();
      expect(commitTaskmaster).toHaveBeenCalled();
    });
  });

  it("does NOT change task to in-progress", async () => {
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });

    await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    // The only setStatusDirect call should be to 'closed', never 'in-progress'
    const calls = vi.mocked(setStatusDirect).mock.calls;
    for (const call of calls) {
      expect(call[1]).not.toBe("in-progress");
    }
  });

  it("reads review feedback via readReviewReport", async () => {
    vi.mocked(readReviewReport).mockReturnValue("Fix the bug on line 42");
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });

    await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    expect(readReviewReport).toHaveBeenCalledWith("/fake/cwd", "5", undefined);
  });

  it("accumulates budget and totals", async () => {
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });
    const budget = { remaining: 5 };
    const totals = makeTotals();

    await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false, undefined, budget, totals);

    expect(budget.remaining).toBe(4);
    expect(totals.iterations).toBe(1);
    expect(totals.costUsd).toBeCloseTo(0.01);
  });

  it("writes rework report with taskId-rework as report ID", async () => {
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });

    await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    expect(appendReport).toHaveBeenCalledWith(
      "/fake/cwd",
      "5-rework",
      1,
      expect.any(Object),
      expect.objectContaining({ agentType: "claude" }),
    );
  });

  it("tracks rework attempt number via metadata.reworkAttempts", async () => {
    // Simulate second rework attempt — metadata already has reworkAttempts: 1
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [], metadata: { reworkAttempts: 1 },
    } as any);
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });

    await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    // setMetadata should be called with reworkAttempts: 2
    expect(setMetadata).toHaveBeenCalledWith("/fake/cwd", "5", { reworkAttempts: 2 });
    // appendReport should use attempt 2
    expect(appendReport).toHaveBeenCalledWith(
      "/fake/cwd",
      "5-rework",
      2,
      expect.any(Object),
      expect.any(Object),
    );
  });
});

describe("reporter review helpers", () => {
  // These tests exercise the real (unmocked) reporter functions
  // We need to import them fresh without the mock

  it("getReviewReportPath returns correct format", async () => {
    // Import the real module
    const { getReviewReportPath } = await vi.importActual<typeof import("../core/reporter.js")>("../core/reporter.js");
    const path = getReviewReportPath("/project", "7");
    expect(path).toBe("/project/.taskmaster/reports/7-review.md");
  });

  it("writeReviewReport + readReviewReport roundtrip", async () => {
    const { writeReviewReport: write, readReviewReport: read } =
      await vi.importActual<typeof import("../core/reporter.js")>("../core/reporter.js");

    const tmpDir = mkdtempSync(join(tmpdir(), "prorab-test-"));
    const content = "# Review\n\nLooks good!";

    write(tmpDir, "42", content);
    const result = read(tmpDir, "42");

    expect(result).toBe(content);
  });

  it("readReviewReport returns null for missing file", async () => {
    const { readReviewReport: read } =
      await vi.importActual<typeof import("../core/reporter.js")>("../core/reporter.js");

    const tmpDir = mkdtempSync(join(tmpdir(), "prorab-test-"));
    const result = read(tmpDir, "nonexistent");

    expect(result).toBeNull();
  });
});

describe("getReviewRoundInfo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns defaults when no metadata", () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "done", dependencies: [], subtasks: [], metadata: {},
    } as any);
    const info = getReviewRoundInfo("5", "/fake/cwd");
    expect(info.reviewRoundsTotal).toBe(1);
    expect(info.reviewRound).toBeUndefined();
    expect(info.roundSuffix).toBeUndefined();
  });

  it("returns metadata values when present", () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "review", dependencies: [], subtasks: [],
      metadata: { reviewRoundsTotal: 3, reviewRound: 2 },
    } as any);
    const info = getReviewRoundInfo("5", "/fake/cwd");
    expect(info.reviewRoundsTotal).toBe(3);
    expect(info.reviewRound).toBe(2);
    expect(info.roundSuffix).toBe(2);
  });

  it("returns undefined roundSuffix when total is 1", () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "review", dependencies: [], subtasks: [],
      metadata: { reviewRoundsTotal: 1, reviewRound: 1 },
    } as any);
    const info = getReviewRoundInfo("5", "/fake/cwd");
    expect(info.reviewRoundsTotal).toBe(1);
    expect(info.reviewRound).toBe(1);
    expect(info.roundSuffix).toBeUndefined();
  });
});

describe("executeReviewCycle", () => {
  const cycleOptions: RunOptions = {
    ...defaultOptions,
    reviewRounds: 3,
    reviewContext: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Default showTaskById returns task with empty metadata
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "done", dependencies: [], subtasks: [], metadata: {},
    } as any);
  });

  it("runs N rounds of review+rework when reviewRounds > 1", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));

    const result = await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    expect(result).toBe(true);
    expect(mockReview).toHaveBeenCalledTimes(3);
    expect(mockRework).toHaveBeenCalledTimes(3);
  });

  it("budget decremented only once for entire cycle", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    const budget = { remaining: 2 };

    await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, () => false, undefined,
      budget, undefined, mockReview, mockRework,
    );

    expect(budget.remaining).toBe(1);
  });

  it("returns false when budget exhausted", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    const budget = { remaining: 0 };

    const result = await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, () => false, undefined,
      budget, undefined, mockReview, mockRework,
    );

    expect(result).toBe(false);
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockRework).not.toHaveBeenCalled();
  });

  it("breaks cycle on rework failure", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn()
      .mockResolvedValueOnce(true)   // round 1 OK
      .mockResolvedValueOnce(false); // round 2 fails
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));

    const result = await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    expect(result).toBe(false);
    expect(mockReview).toHaveBeenCalledTimes(2);
    expect(mockRework).toHaveBeenCalledTimes(2);
  });

  it("breaks cycle on review failure", async () => {
    const mockReview = vi.fn()
      .mockResolvedValueOnce(true)   // round 1 OK
      .mockResolvedValueOnce(false); // round 2 fails
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));

    const result = await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    expect(result).toBe(false);
    expect(mockReview).toHaveBeenCalledTimes(2);
    expect(mockRework).toHaveBeenCalledTimes(1);
  });

  it("works with single round (reviewRounds=1)", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    const singleOpts = { ...defaultOptions, reviewRounds: 1, reviewContext: false };

    const result = await executeReviewCycle(
      task, "/fake/cwd", singleOpts, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    expect(result).toBe(true);
    expect(mockReview).toHaveBeenCalledTimes(1);
    expect(mockRework).toHaveBeenCalledTimes(1);
  });

  it("stops on interrupt", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    // Interrupt after round 1 (first check passes, second returns true)
    const isInterrupted = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);

    const result = await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, isInterrupted, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    expect(result).toBe(false);
  });

  it("calls onPhaseChange callback", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    const onPhaseChange = vi.fn();

    await executeReviewCycle(
      task, "/fake/cwd", { ...defaultOptions, reviewRounds: 2, reviewContext: false }, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework, onPhaseChange,
    );

    expect(onPhaseChange).toHaveBeenCalledWith("review", 1, 2);
    expect(onPhaseChange).toHaveBeenCalledWith("rework", 1, 2);
    expect(onPhaseChange).toHaveBeenCalledWith("review", 2, 2);
    expect(onPhaseChange).toHaveBeenCalledWith("rework", 2, 2);
  });

  it("uses metadata.reviewRoundsTotal as source of truth over CLI flag", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "done", dependencies: [], subtasks: [],
      metadata: { reviewRoundsTotal: 2 },
    } as any);
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    // CLI says 5 rounds, but metadata says 2
    const opts = { ...defaultOptions, reviewRounds: 5, reviewContext: false };

    await executeReviewCycle(
      task, "/fake/cwd", opts, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    expect(mockReview).toHaveBeenCalledTimes(2);
    expect(mockRework).toHaveBeenCalledTimes(2);
  });

  it("persists reviewContext in metadata for crash recovery", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    const opts = { ...defaultOptions, reviewRounds: 2, reviewContext: true };

    await executeReviewCycle(
      task, "/fake/cwd", opts, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    // reviewContext should be persisted in setMetadata calls
    expect(setMetadata).toHaveBeenCalledWith("/fake/cwd", "5", expect.objectContaining({ reviewContext: true }));
  });

  it("uses metadata.reviewContext as source of truth over CLI flag", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "review", dependencies: [], subtasks: [],
      metadata: { reviewRound: 1, reviewRoundsTotal: 2, reviewContext: true, reviewPhaseComplete: false },
    } as any);
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "review" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    // CLI says reviewContext=false, but metadata says true
    const opts = { ...defaultOptions, reviewRounds: 2, reviewContext: false };

    await executeReviewCycle(
      task, "/fake/cwd", opts, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    // reviewFn should receive options with reviewContext=true from metadata
    const reviewCallOptions = mockReview.mock.calls[0][2] as RunOptions;
    expect(reviewCallOptions.reviewContext).toBe(true);
  });

  it("resumes from saved round (crash recovery)", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "review", dependencies: [], subtasks: [],
      metadata: { reviewRound: 2, reviewRoundsTotal: 3, reviewPhaseComplete: false },
    } as any);
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "review" });
    const driver = makeDriver(makeResult({ type: "complete" }));

    await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    // Should start from round 2, not round 1
    // Rounds 2 and 3 = 2 review + 2 rework calls
    expect(mockReview).toHaveBeenCalledTimes(2);
    expect(mockRework).toHaveBeenCalledTimes(2);
  });

  it("skips review when resuming with reviewPhaseComplete=true", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [],
      metadata: { reviewRound: 2, reviewRoundsTotal: 3, reviewPhaseComplete: true },
    } as any);
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "rework" });
    const driver = makeDriver(makeResult({ type: "complete" }));

    await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    // Round 2: skip review (already complete), run rework
    // Round 3: review + rework
    // Total: 1 review (round 3 only) + 2 rework (rounds 2 and 3)
    expect(mockReview).toHaveBeenCalledTimes(1);
    expect(mockRework).toHaveBeenCalledTimes(2);
  });

  it("passes undefined budget and normal totals to inner functions", async () => {
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "done" });
    const driver = makeDriver(makeResult({ type: "complete" }));
    const budget = { remaining: 5 };
    const totals = makeTotals();

    await executeReviewCycle(
      task, "/fake/cwd", { ...defaultOptions, reviewRounds: 1, reviewContext: false }, driver, () => false, undefined,
      budget, totals, mockReview, mockRework,
    );

    // Budget should be passed as undefined to inner functions
    expect(mockReview).toHaveBeenCalledWith(
      expect.anything(), "/fake/cwd", expect.anything(), driver, expect.anything(), undefined,
      undefined, totals,
    );
    expect(mockRework).toHaveBeenCalledWith(
      expect.anything(), "/fake/cwd", expect.anything(), driver, expect.anything(), undefined,
      undefined, totals,
    );
    // Budget is decremented once at the orchestrator level
    expect(budget.remaining).toBe(4);
  });

  it("resets to round 1 when savedRound exceeds reviewRoundsTotal", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "review", dependencies: [], subtasks: [],
      metadata: { reviewRound: 5, reviewRoundsTotal: 3 },
    } as any);
    const mockReview = vi.fn().mockResolvedValue(true);
    const mockRework = vi.fn().mockResolvedValue(true);
    const task = makeTask({ status: "review" });
    const driver = makeDriver(makeResult({ type: "complete" }));

    await executeReviewCycle(
      task, "/fake/cwd", cycleOptions, driver, () => false, undefined,
      undefined, undefined, mockReview, mockRework,
    );

    // Should run all 3 rounds from round 1 (not start from round 5)
    expect(mockReview).toHaveBeenCalledTimes(3);
    expect(mockRework).toHaveBeenCalledTimes(3);
  });
});

describe("executeRework isFinalRound", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readReviewReport).mockReturnValue("Review feedback content");
  });

  it("non-final round: sets rework→review and resets reworkAttempts", async () => {
    // Task is in round 1 of 3
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [],
      metadata: { reviewRound: 1, reviewRoundsTotal: 3, reworkAttempts: 0 },
    } as any);
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });

    const result = await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    expect(result).toBe(true);
    // Should transition to review (not closed)
    expect(setStatusDirect).toHaveBeenCalledWith("5", "review", "/fake/cwd");
    expect(setStatusDirect).not.toHaveBeenCalledWith("5", "closed", "/fake/cwd");
    // Should reset reworkAttempts and increment round
    expect(setMetadata).toHaveBeenCalledWith("/fake/cwd", "5", { reworkAttempts: 0, reviewRound: 2, reviewPhaseComplete: false });
  });

  it("final round: sets closed", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [],
      metadata: { reviewRound: 3, reviewRoundsTotal: 3, reworkAttempts: 0 },
    } as any);
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });

    const result = await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    expect(result).toBe(true);
    expect(setStatusDirect).toHaveBeenCalledWith("5", "closed", "/fake/cwd");
    expect(setStatusDirect).not.toHaveBeenCalledWith("5", "review", "/fake/cwd");
  });

  it("single round (no metadata): treated as final, sets closed", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [],
      metadata: {},
    } as any);
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });

    const result = await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    expect(result).toBe(true);
    expect(setStatusDirect).toHaveBeenCalledWith("5", "closed", "/fake/cwd");
  });

  it("reviewRoundsTotal=1: always final regardless of reviewRound value", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [],
      metadata: { reviewRound: 1, reviewRoundsTotal: 1, reworkAttempts: 0 },
    } as any);
    const driver = makeDriver(makeResult({ type: "complete" }));
    const task = makeTask({ status: "rework" });

    const result = await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    expect(result).toBe(true);
    expect(setStatusDirect).toHaveBeenCalledWith("5", "closed", "/fake/cwd");
  });

  it("writes structured rework report via writeReworkReport when agentReport present", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [],
      metadata: { reviewRound: 2, reviewRoundsTotal: 3, reworkAttempts: 0 },
    } as any);
    const driver = makeDriver(makeResult({ type: "complete" }, { agentReport: "Fixed the bug" }));
    const task = makeTask({ status: "rework" });

    await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    // Should write structured rework report with round suffix
    expect(writeReworkReport).toHaveBeenCalledWith("/fake/cwd", "5", "Fixed the bug", 2);
  });

  it("does not write structured rework report when agentReport is null", async () => {
    vi.mocked(showTaskById).mockReturnValue({
      id: 5, title: "Test task", status: "rework", dependencies: [], subtasks: [],
      metadata: {},
    } as any);
    const driver = makeDriver(makeResult({ type: "complete" }, { agentReport: null }));
    const task = makeTask({ status: "rework" });

    await executeRework(task, "/fake/cwd", defaultOptions, driver, () => false);

    expect(writeReworkReport).not.toHaveBeenCalled();
  });
});
