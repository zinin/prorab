import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentDriver, SessionOptions } from "../core/drivers/types.js";
import type { IterationResult, RunOptions, ExecutionUnit } from "../types.js";

// Mock modules BEFORE imports
vi.mock("../core/tasks-json.js", () => ({
  getAttemptCount: vi.fn().mockReturnValue(0),
  incrementAttemptCount: vi.fn().mockReturnValue(1),
  setStatusDirect: vi.fn(),
  setRevisions: vi.fn(),
  getRevisions: vi.fn().mockReturnValue(null),
  setMetadata: vi.fn(),
  findNextAction: vi.fn(),
  readTasksFile: vi.fn().mockReturnValue({ tasks: [] }),
  TASK_FINAL_STATUSES: new Set(["closed"]),
  TaskNotFoundError: class extends Error {},
}));

vi.mock("../core/reporter.js", () => ({
  readReport: vi.fn().mockReturnValue(null),
  appendReport: vi.fn(),
  getReportPath: vi.fn().mockReturnValue("/fake/report.md"),
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

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn((...args: unknown[]) => {
      // Intercept reads of the fake tasks.json path used in tests
      if (typeof args[0] === "string" && args[0].includes("/fake/cwd/")) {
        return '{"tasks":[]}';
      }
      return actual.readFileSync(args[0] as string, args[1] as BufferEncoding);
    }),
    writeFileSync: vi.fn((...args: unknown[]) => {
      // Intercept writes to fake paths used in tests
      if (typeof args[0] === "string" && args[0].includes("/fake/cwd/")) {
        return;
      }
      return actual.writeFileSync(args[0] as string, args[1] as string);
    }),
  };
});

import { executeUnit } from "../commands/run.js";
import { getAttemptCount, incrementAttemptCount } from "../core/tasks-json.js";
import { readReport, appendReport } from "../core/reporter.js";
import { setStatusDirect } from "../core/tasks-json.js";
import { chatStubs } from "./helpers/driver-stubs.js";

function makeResult(signal: IterationResult["signal"]): IterationResult {
  return {
    signal,
    durationMs: 1000,
    costUsd: 0.01,
    numTurns: 5,
    resultText: "done",
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
  };
}

function makeDriver(results: IterationResult[]): AgentDriver {
  let callIdx = 0;
  return {
    runSession: vi.fn(async () => results[callIdx++] ?? results[results.length - 1]),
    ...chatStubs,
  };
}

const defaultUnit: ExecutionUnit = {
  type: "subtask",
  taskId: "3",
  subtaskId: "1",
  title: "Test subtask",
  parentTask: {
    id: 3,
    title: "Parent task",
    status: "pending",
    dependencies: [],
    subtasks: [],
  },
};

const defaultOptions: RunOptions = {
  agent: "claude",
  maxRetries: 0,
  maxTurns: 10,
  reviewMaxTurns: 10,
  allowDirty: false,
  quiet: false,
  debug: false,
  trace: false,
  userSettings: false,
  review: true,
  reviewRounds: 1,
  reviewContext: false,
};

describe("executeUnit attempt counter integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console output in tests
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Reset mocks to default values
    vi.mocked(getAttemptCount).mockReturnValue(0);
    vi.mocked(incrementAttemptCount).mockReturnValue(1);
    vi.mocked(readReport).mockReturnValue(null);
  });

  it("calls incrementAttemptCount after runSession, before appendReport", async () => {
    const callOrder: string[] = [];

    const driver: AgentDriver = {
      runSession: vi.fn(async () => {
        callOrder.push("runSession");
        return makeResult({ type: "complete" });
      }),
      ...chatStubs,
    };

    vi.mocked(incrementAttemptCount).mockImplementation((..._args: unknown[]) => {
      callOrder.push("incrementAttemptCount");
      return 1;
    });

    vi.mocked(appendReport).mockImplementation((..._args: unknown[]) => {
      callOrder.push("appendReport");
    });

    await executeUnit(defaultUnit, "/fake/cwd", defaultOptions, driver, () => false);

    expect(callOrder).toEqual(["runSession", "incrementAttemptCount", "appendReport"]);
  });

  it("reads previousReport unconditionally", async () => {
    vi.mocked(readReport).mockReturnValue("previous report content");

    const driver = makeDriver([makeResult({ type: "complete" })]);

    await executeUnit(defaultUnit, "/fake/cwd", defaultOptions, driver, () => false);

    expect(readReport).toHaveBeenCalledWith("/fake/cwd", "3.1");
  });

  it("passes currentAttempt (previousAttempts + attempt) to appendReport", async () => {
    vi.mocked(getAttemptCount).mockReturnValue(5);

    const driver = makeDriver([makeResult({ type: "complete" })]);

    await executeUnit(defaultUnit, "/fake/cwd", defaultOptions, driver, () => false);

    // appendReport(cwd, unitId, currentAttempt, result, reportContext)
    // currentAttempt = previousAttempts(5) + attempt(1) = 6
    expect(appendReport).toHaveBeenCalledWith(
      "/fake/cwd",
      "3.1",
      6,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("uses previousAttempts for log output offset", async () => {
    vi.mocked(getAttemptCount).mockReturnValue(3);

    const driver = makeDriver([makeResult({ type: "complete" })]);

    await executeUnit(defaultUnit, "/fake/cwd", defaultOptions, driver, () => false);

    // currentAttempt = previousAttempts(3) + attempt(1) = 4
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("attempt #4"),
    );
  });

  it("handles complete signal correctly", async () => {
    const driver = makeDriver([makeResult({ type: "complete" })]);

    const result = await executeUnit(defaultUnit, "/fake/cwd", defaultOptions, driver, () => false);

    expect(result).toBe(true);
    expect(setStatusDirect).toHaveBeenCalledWith("3.1", "done", "/fake/cwd", { reviewEnabled: true });
  });

  it("handles blocked signal correctly", async () => {
    const driver = makeDriver([
      makeResult({ type: "blocked", reason: "Missing dependency" }),
    ]);

    const result = await executeUnit(defaultUnit, "/fake/cwd", defaultOptions, driver, () => false);

    expect(result).toBe(false);
    expect(setStatusDirect).toHaveBeenCalledWith("3.1", "blocked", "/fake/cwd");
  });

  it("handles no-signal with retry", async () => {
    const options: RunOptions = { ...defaultOptions, maxRetries: 1 };
    const driver = makeDriver([
      makeResult({ type: "none" }),
      makeResult({ type: "none" }),
    ]);

    const result = await executeUnit(defaultUnit, "/fake/cwd", options, driver, () => false);

    expect(result).toBe(false);
    // setStatus called with "pending" for the retry (between attempt 1 and 2)
    expect(setStatusDirect).toHaveBeenCalledWith("3.1", "pending", "/fake/cwd");
    // incrementAttemptCount called once per session completion (twice total)
    expect(incrementAttemptCount).toHaveBeenCalledTimes(2);
  });

  it("maxTurns breach (signal:none + 'Max turns exceeded' marker) retries via existing no-signal path", async () => {
    // Regression test for the max-turns-enforcement feature contract.
    // Drivers signal a runaway session with `signal: { type: "none" }` and
    // `resultText: "Max turns exceeded (N)\n..."`. executeUnit MUST treat
    // this as the existing "no completion signal" retry candidate, not as a
    // hard failure. If this test starts reporting only ONE runSession call,
    // the fail-soft retry contract has regressed.
    const options: RunOptions = { ...defaultOptions, maxRetries: 1 };
    const driver = makeDriver([
      {
        ...makeResult({ type: "none" }),
        resultText: "Max turns exceeded (100)\nsome partial agent output",
      },
      makeResult({ type: "complete" }),
    ]);

    const result = await executeUnit(defaultUnit, "/fake/cwd", options, driver, () => false);

    expect(driver.runSession).toHaveBeenCalledTimes(2);
    // Success on retry — executeUnit returns true.
    expect(result).toBe(true);
    // Status reset to pending between attempts
    expect(setStatusDirect).toHaveBeenCalledWith("3.1", "pending", "/fake/cwd");
  });

  it("handles error signal - no retry", async () => {
    const options: RunOptions = { ...defaultOptions, maxRetries: 1 };
    const driver = makeDriver([
      makeResult({ type: "error", message: "SDK crash" }),
    ]);

    const result = await executeUnit(defaultUnit, "/fake/cwd", options, driver, () => false);

    expect(result).toBe(false);
    // Only one session ran — error stops immediately, no retry
    expect(driver.runSession).toHaveBeenCalledTimes(1);
    // incrementAttemptCount was still called (session completed)
    expect(incrementAttemptCount).toHaveBeenCalledTimes(1);
  });
});
