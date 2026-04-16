import { createDriver } from "../core/drivers/factory.js";
import type { AgentDriver } from "../core/drivers/types.js";
import {
  isGitRepo,
  isTrackedByGit,
  autoCommit,
  commitTaskmaster,
  hasUncommittedChangesExcluding,
  ensureLockNotTracked,
  restoreTaskmasterIfTouched,
  getHeadRev,
  getCommitsBetween,
} from "../core/git.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { appendReport, readReport, writeReviewReport, readReviewReport, writeReviewerReport, readReworkReport, writeReworkReport, stripReportMetadata } from "../core/reporter.js";
import { getAttemptCount, incrementAttemptCount, findNextAction, readTasksFile, TASK_FINAL_STATUSES, setStatusDirect, setRevisions, getRevisions, setMetadata, getTaskRevisions, showTaskById, getReviewRoundInfo } from "../core/tasks-json.js";
import type { NextAction } from "../core/tasks-json.js";
import type { ReportContext } from "../core/reporter.js";
import { buildSystemPrompt, buildPrompt } from "../prompts/execute.js";
import { buildReviewSystemPrompt, buildReviewPrompt, buildReworkSystemPrompt, buildReworkPrompt, buildAggregationSystemPrompt, buildAggregationTaskPrompt } from "../prompts/review.js";
import type { AggregationReportInput, PreviousRoundContext } from "../prompts/review.js";
import { getReviewerId } from "../core/reviewer-utils.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getVerbosity, AGGREGATOR_REVIEWER_ID } from "../types.js";
import type { AgentType, ExecutionUnit, IterationResult, OnLogCallback, ReviewResult, Reviewer, RunOptions, Task, Subtask, Verbosity } from "../types.js";

/** Creates an error IterationResult with zeroed-out metrics. */
function makeErrorResult(message: string): IterationResult {
  return {
    signal: { type: "error", message },
    durationMs: 0,
    costUsd: 0,
    numTurns: 0,
    resultText: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    model: "unknown",
    agentReport: null,
    reviewReport: null,
    startedAt: "",
    finishedAt: "",
  };
}

/** Mutable iteration budget shared across all executeUnit calls. */
export interface IterationBudget {
  remaining: number | null; // null = unlimited
}

/** Accumulates cost/token totals across the entire run. */
export interface RunTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  durationMs: number;
  numTurns: number;
  iterations: number;
}

function printSummary(totals: RunTotals, verbosity: Verbosity): void {
  if (verbosity === "quiet") return;
  if (totals.iterations === 0) return;
  const totalSec = (totals.durationMs / 1000).toFixed(1);
  console.log("\n=== Run Summary ===");
  console.log(`  Iterations : ${totals.iterations}`);
  console.log(`  Total turns: ${totals.numTurns}`);
  console.log(`  Total time : ${totalSec}s`);
  console.log(`  Total cost : $${totals.costUsd.toFixed(4)}`);
  console.log(`  Tokens in  : ${totals.inputTokens}`);
  console.log(`  Tokens out : ${totals.outputTokens}`);
  console.log(`  Cache read : ${totals.cacheReadTokens}`);
  console.log(`  Cache write: ${totals.cacheWriteTokens}`);
  console.log(`  Reasoning  : ${totals.reasoningTokens}`);
}

/** Simple helper: coerce task/subtask id to string. */
export function taskIdStr(id: number | string): string {
  return String(id);
}

/** Builds an ExecutionUnit from a task and optional subtask. */
export function buildExecutionUnit(task: Task, subtask?: Subtask): ExecutionUnit {
  if (subtask) {
    return {
      type: "subtask",
      taskId: taskIdStr(task.id),
      subtaskId: taskIdStr(subtask.id),
      title: subtask.title,
      description: subtask.description,
      details: subtask.details,
      testStrategy: subtask.testStrategy,
      parentTask: task,
    };
  }
  return {
    type: "task",
    taskId: taskIdStr(task.id),
    title: task.title,
    description: task.description,
    details: task.details,
    testStrategy: task.testStrategy,
    parentTask: task,
  };
}

/**
 * Executes a single execution unit with retry logic.
 * Returns true if the unit completed successfully, false otherwise.
 * @param registerAbort — callback to register each session's AbortController (for SIGINT)
 */
export async function executeUnit(
  unit: ExecutionUnit,
  cwd: string,
  options: RunOptions,
  driver: AgentDriver,
  isInterrupted: () => boolean,
  registerAbort?: (controller: AbortController) => void,
  budget?: IterationBudget,
  totals?: RunTotals,
): Promise<boolean> {
  const unitId =
    unit.type === "subtask"
      ? `${unit.taskId}.${unit.subtaskId}`
      : unit.taskId;
  const retries = options.maxRetries;
  const previousAttempts = getAttemptCount(cwd, unitId);

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    // Check interrupted before each attempt — task stays in-progress
    if (isInterrupted()) {
      console.log(
        `\n  Interrupted before attempt #${previousAttempts + attempt}, task stays in-progress.`,
      );
      commitTaskmaster(cwd, `prorab: interrupted ${unit.type} ${unitId}`);
      return false;
    }

    // Check iteration budget BEFORE changing task status to avoid
    // leaving .taskmaster/ dirty on early exit
    if (budget && budget.remaining !== null && budget.remaining <= 0) {
      console.log(`\n  Iteration limit reached, stopping.`);
      return false;
    }

    // Read previous report for retry context
    const previousReport = readReport(cwd, unitId);

    const currentAttempt = previousAttempts + attempt;
    console.log(
      `\n--- Executing ${unit.type} ${unitId}: "${unit.title}" (attempt #${currentAttempt}, run ${attempt}/${retries + 1}) ---`,
    );

    // Set status to in-progress
    setStatusDirect(unitId, "in-progress", cwd);

    // Build prompts
    const systemPrompt = buildSystemPrompt(cwd);
    const prompt = buildPrompt(unit, previousReport);
    const verbosity = getVerbosity(options);

    // Log prompts in debug/trace mode
    if (verbosity === "debug" || verbosity === "trace") {
      console.log(`\n\x1b[36m  [system-prompt] (${systemPrompt.length} chars)\x1b[0m`);
      console.log(`\x1b[2m${systemPrompt}\x1b[0m`);
      console.log(`\n\x1b[36m  [task-prompt] (${prompt.length} chars)\x1b[0m`);
      console.log(`\x1b[2m${prompt}\x1b[0m`);
    }

    // Send prompts to UI (always — UI shows them in collapsible blocks)
    options.onLog?.({ type: "agent:system_prompt", text: systemPrompt });
    options.onLog?.({ type: "agent:task_prompt", text: prompt });

    // Capture start time and HEAD rev for structured report
    const startedAt = new Date().toISOString();
    const headBefore = getHeadRev(cwd);

    // Record startRev in metadata (idempotent — only set if not already present)
    if (headBefore) {
      const existingRevs = getRevisions(cwd, unitId);
      if (!existingRevs?.startRev) {
        setRevisions(cwd, unitId, headBefore, headBefore); // endRev updated on complete
      }
      // For subtasks: also record startRev on parent task (if not already set)
      if (unit.type === "subtask") {
        const parentId = taskIdStr(unit.taskId);
        const parentRevs = getRevisions(cwd, parentId);
        if (!parentRevs?.startRev) {
          setRevisions(cwd, parentId, headBefore, headBefore);
        }
      }
    }

    // Save tasks.json before agent session — agent may modify it on disk or via commits.
    // We'll restore this clean copy after git operations to preserve prorab's state.
    const tasksJsonPath = join(cwd, ".taskmaster", "tasks", "tasks.json");
    const savedTasksJson = readFileSync(tasksJsonPath, "utf-8");

    // Run agent session with fail-safe lifecycle
    const abortController = new AbortController();
    registerAbort?.(abortController);

    let result: IterationResult;
    try {
      await driver.setup?.({ verbosity, abortSignal: abortController.signal });
      result = await driver.runSession({
        prompt,
        systemPrompt,
        cwd,
        maxTurns: options.maxTurns,
        abortController,
        verbosity,
        onLog: options.onLog,
        variant: options.variant,
        unitId,
      });
    } catch (err) {
      // Map setup/runSession errors to IterationResult so report is always written
      const errorMessage = err instanceof Error
        ? `${err.message}\n${err.stack ?? ""}`
        : String(err);
      result = makeErrorResult(errorMessage);
    } finally {
      // Always attempt teardown; log errors in debug/trace mode but don't mask original failure
      try {
        await driver.teardown?.();
      } catch (teardownErr) {
        if (verbosity === "debug" || verbosity === "trace") {
          console.error(`  [teardown] error (swallowed): ${teardownErr}`);
        }
      }
    }

    // Set timestamps on result
    const finishedAt = new Date().toISOString();
    result.startedAt = startedAt;
    result.finishedAt = finishedAt;

    // Decrement iteration budget
    if (budget && budget.remaining !== null) {
      budget.remaining--;
    }

    // Accumulate run totals
    if (totals) {
      totals.costUsd += result.costUsd;
      totals.inputTokens += result.inputTokens;
      totals.outputTokens += result.outputTokens;
      totals.cacheReadTokens += result.cacheReadTokens;
      totals.cacheWriteTokens += result.cacheWriteTokens;
      totals.reasoningTokens += result.reasoningTokens;
      totals.durationMs += result.durationMs;
      totals.numTurns += result.numTurns;
      totals.iterations += 1;
    }

    // Log result line
    console.log(
      `--- Result: ${result.signal.type} | ${result.numTurns} turns | ${(result.durationMs / 1000).toFixed(1)}s | $${result.costUsd.toFixed(4)} | in=${result.inputTokens} out=${result.outputTokens} ---`,
    );
    if (totals && verbosity !== "quiet") {
      console.log(
        `    [total so far: $${totals.costUsd.toFixed(4)} | ${totals.iterations} iterations | in=${totals.inputTokens} out=${totals.outputTokens}]`,
      );
    }

    // Guard: ensure agent didn't track/stage the lock file
    ensureLockNotTracked(cwd);

    // Auto-commit uncommitted changes
    const didAutoCommit = autoCommit(cwd, unit.title);
    if (didAutoCommit) {
      console.log("  (auto-committed uncommitted changes)");
    }

    // Guard: restore .taskmaster/ if agent modified it in its commits
    if (headBefore) {
      restoreTaskmasterIfTouched(cwd, headBefore);
    }

    // Restore clean tasks.json saved before agent session.
    // Agent may have modified it on disk (directly or via commits that were restored above).
    // This ensures prorab's in-progress status, revisions, and runAttempts are preserved.
    writeFileSync(tasksJsonPath, savedTasksJson);

    // Persist attempt count after restoring clean tasks.json
    try {
      incrementAttemptCount(cwd, unitId);
    } catch (err) {
      console.error(`  [warning] Failed to persist attempt count: ${err instanceof Error ? err.message : err}`);
    }

    // Get commits made during this iteration
    const commits = headBefore ? getCommitsBetween(cwd, headBefore) : [];

    const reportContext: ReportContext = {
      agentType: options.agent,
      commits,
    };

    // Write report
    appendReport(cwd, unitId, currentAttempt, result, reportContext);

    // Print iteration report to console
    if (verbosity !== "quiet") {
      if (commits.length > 0) {
        console.log("  Commits:");
        for (const c of commits) {
          console.log(`    ${c}`);
        }
      } else {
        console.log("  Commits: (none)");
      }
      if (result.agentReport) {
        console.log("  Agent Report:");
        for (const line of result.agentReport.split("\n")) {
          console.log(`    ${line}`);
        }
      } else {
        console.log("  (Agent did not provide a report)");
      }
    }

    // Handle signal
    if (result.signal.type === "complete") {
      // Record endRev in metadata + executedAt timestamp
      const headAfter = getHeadRev(cwd);
      if (headAfter) {
        const currentRevs = getRevisions(cwd, unitId);
        const startRev = currentRevs?.startRev ?? headBefore ?? headAfter;
        setRevisions(cwd, unitId, startRev, headAfter);
        setMetadata(cwd, unitId, { executedAt: new Date().toISOString() });
        // For subtasks: update parent's endRev
        if (unit.type === "subtask") {
          const parentId = taskIdStr(unit.taskId);
          const parentRevs = getRevisions(cwd, parentId);
          const parentStart = parentRevs?.startRev ?? headBefore ?? headAfter;
          setRevisions(cwd, parentId, parentStart, headAfter);
        }
      }

      setStatusDirect(unitId, "done", cwd, { reviewEnabled: options.review });
      commitTaskmaster(
        cwd,
        `prorab: complete ${unit.type} ${unitId} "${unit.title}"`,
      );
      return true;
    }

    if (result.signal.type === "blocked") {
      console.error(`\n!!! BLOCKED: ${result.signal.reason} !!!`);
      setStatusDirect(unitId, "blocked", cwd);
      commitTaskmaster(cwd, `prorab: ${unit.type} ${unitId} blocked`);
      return false;
    }

    if (result.signal.type === "error") {
      // SDK error — stop immediately, no retry, task stays in-progress
      console.error(`\n!!! AGENT ERROR: ${result.signal.message} !!!`);
      commitTaskmaster(cwd, `prorab: agent error for ${unit.type} ${unitId}`);
      return false;
    }

    // signal.type === "none" — retry if attempts remain
    if (attempt <= retries) {
      // Check interrupted before resetting status — task must stay in-progress on SIGINT
      if (isInterrupted()) {
        console.log(`\n  Interrupted after attempt #${currentAttempt}, task stays in-progress.`);
        commitTaskmaster(cwd, `prorab: interrupted ${unit.type} ${unitId}`);
        return false;
      }
      console.log("  No completion signal, retrying...");
      setStatusDirect(unitId, "pending", cwd);
      commitTaskmaster(
        cwd,
        `prorab: retry ${unit.type} ${unitId} (attempt #${currentAttempt})`,
      );
    }
  }

  // All retries exhausted
  console.error(`\n!!! FAILED: max retries exceeded for ${unitId} (${previousAttempts + retries + 1} total attempts) !!!`);
  setStatusDirect(unitId, "blocked", cwd);
  commitTaskmaster(
    cwd,
    `prorab: ${unit.type} ${unitId} failed after ${previousAttempts + retries + 1} attempts`,
  );
  return false;
}

/**
 * Build the list of reviewers to use.
 * The primary (main agent/model/variant) always participates in review.
 * If additional reviewers are provided via --reviewer, they are appended after the primary.
 * Deduplication: if an explicit reviewer matches the primary, the primary is not prepended.
 */
export function buildReviewerList(
  reviewers: Reviewer[] | undefined,
  mainAgent: AgentType,
  mainModel: string | undefined,
  mainVariant: string | undefined,
): Reviewer[] {
  const primary: Reviewer = { agent: mainAgent };
  if (mainModel) primary.model = mainModel;
  if (mainVariant) primary.variant = mainVariant;
  if (!reviewers || reviewers.length === 0) return [primary];
  const primaryId = getReviewerId(primary);
  const alreadyIncluded = reviewers.some(r => getReviewerId(r) === primaryId);
  if (alreadyIncluded) return reviewers;
  return [primary, ...reviewers];
}

/**
 * Executes a code review for a completed task.
 * Supports parallel multi-reviewer: runs each reviewer concurrently, then
 * aggregates their reports (if >1) into a single review.
 * Returns true if review completed and task moved to `rework`, false otherwise.
 */
export async function executeReview(
  task: Task,
  cwd: string,
  options: RunOptions,
  driver: AgentDriver,
  isInterrupted: () => boolean,
  registerAbort?: (controller: AbortController) => void,
  budget?: IterationBudget,
  totals?: RunTotals,
): Promise<boolean> {
  const taskId = taskIdStr(task.id);
  const verbosity = getVerbosity(options);
  const { reviewRoundsTotal, reviewRound, roundSuffix } = getReviewRoundInfo(taskId, cwd);

  // Check iteration budget before starting
  if (budget && budget.remaining !== null && budget.remaining <= 0) {
    console.log(`\n  Iteration limit reached, stopping.`);
    return false;
  }

  // Check interrupted
  if (isInterrupted()) {
    console.log(`\n  Interrupted before review of task ${taskId}.`);
    return false;
  }

  // Build reviewer list
  const reviewers = buildReviewerList(options.reviewers, options.agent, options.model, options.variant);

  console.log(`\n--- Reviewing task ${taskId}: "${task.title}" (${reviewers.length} reviewer${reviewers.length === 1 ? "" : "s"}) ---`);

  // Transition to review status
  setStatusDirect(taskId, "review", cwd);

  // Get git revisions — if null, move to blocked
  const revisions = getTaskRevisions(cwd, taskId);
  if (!revisions) {
    console.log(`  No git revisions found for task ${taskId}, moving to blocked.`);
    const noRevReport = `# Review: Task ${taskId} — ${task.title}\n\nCould not perform review: no git revisions (startRev/endRev) recorded for this task.\n`;
    writeReviewReport(cwd, taskId, noRevReport, roundSuffix);
    setStatusDirect(taskId, "blocked", cwd);
    commitTaskmaster(cwd, `prorab: review blocked — no revisions for task ${taskId}`);
    return false;
  }

  // Collect execution reports (strip metadata — only keep iterations, commits, agent reports)
  let executionReport: string;
  const subtasks = task.subtasks || [];
  if (subtasks.length > 0) {
    const parts: string[] = [];
    for (const st of subtasks) {
      const subReportId = `${taskId}.${taskIdStr(st.id)}`;
      const report = readReport(cwd, subReportId);
      if (report) {
        parts.push(`### Subtask ${subReportId}: ${st.title}\n\n${stripReportMetadata(report)}`);
      }
    }
    executionReport = parts.length > 0
      ? parts.join("\n---\n\n")
      : "_No subtask reports found._";
  } else {
    const raw = readReport(cwd, taskId);
    executionReport = raw ? stripReportMetadata(raw) : "_No execution report found._";
  }

  // Collect previous round context (executeReview is sole owner of this logic)
  let previousRoundContext: PreviousRoundContext[] | undefined;
  if (options.reviewContext && reviewRound && reviewRound > 1 && reviewRoundsTotal > 1) {
    previousRoundContext = [];
    for (let prevRound = 1; prevRound < reviewRound; prevRound++) {
      const prevReview = readReviewReport(cwd, taskId, prevRound);
      const prevRework = readReworkReport(cwd, taskId, prevRound);
      if (prevReview) {
        previousRoundContext.push({
          round: prevRound,
          reviewReport: prevReview,
          reworkReport: prevRework,
        });
      }
    }
  }

  // Build review prompts
  const systemPrompt = buildReviewSystemPrompt();
  const prompt = buildReviewPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    taskDetails: task.details,
    executionReport,
    gitRange: { startRev: revisions.startRev, endRev: revisions.endRev },
    previousRoundContext,
  });

  // Log prompts in debug/trace mode
  if (verbosity === "debug" || verbosity === "trace") {
    console.log(`\n\x1b[36m  [review-system-prompt] (${systemPrompt.length} chars)\x1b[0m`);
    console.log(`\x1b[2m${systemPrompt}\x1b[0m`);
    console.log(`\n\x1b[36m  [review-prompt] (${prompt.length} chars)\x1b[0m`);
    console.log(`\x1b[2m${prompt}\x1b[0m`);
  }

  // Review = 1 logical iteration
  if (totals) {
    totals.iterations += 1;
  }
  // Budget: when called from executeReviewCycle, budget is undefined
  // (the cycle manages budget itself, decrementing once for all rounds).
  if (budget && budget.remaining !== null) {
    budget.remaining--;
  }

  // --- Parallel multi-reviewer execution ---

  const isMultiReview = reviewers.length > 1;

  // Set of active abort controllers for parallel sessions
  const activeAbortControllers = new Set<AbortController>();

  // Register composite abort that aborts ALL active controllers
  const compositeAbort = new AbortController();
  const originalAbort = compositeAbort.abort.bind(compositeAbort);
  compositeAbort.abort = function () {
    originalAbort();
    for (const ac of new Set(activeAbortControllers)) {
      ac.abort();
    }
  };
  registerAbort?.(compositeAbort);

  // Emit multi_review_started only for multiple reviewers
  if (isMultiReview) {
    options.onExecutionEvent?.({
      type: "execution:multi_review_started",
      taskId,
      reviewers: reviewers.map(r => ({ ...r, reviewerId: getReviewerId(r) })),
    });
  }

  const reviewPromises = reviewers.map(async (reviewer): Promise<ReviewResult> => {
    const reviewerId = getReviewerId(reviewer);

    // Create fresh driver for this reviewer
    const reviewerDriver = createDriver(reviewer.agent, reviewer.model, options.userSettings, false);

    // Create per-reviewer AbortController
    const ac = new AbortController();
    activeAbortControllers.add(ac);

    // Tag onLog events with reviewerId (only in multi-review mode to avoid unnecessary tabs)
    const taggedOnLog: OnLogCallback | undefined = options.onLog
      ? isMultiReview
        ? (event) => { options.onLog!({ ...event, reviewerId }); }
        : options.onLog
      : undefined;

    // Send prompts to UI with reviewerId
    taggedOnLog?.({ type: "agent:system_prompt", text: systemPrompt });
    taggedOnLog?.({ type: "agent:task_prompt", text: prompt });

    const startedAt = new Date().toISOString();

    let result: IterationResult;
    try {
      await reviewerDriver.setup?.({ verbosity, abortSignal: ac.signal });
      result = await reviewerDriver.runSession({
        prompt,
        systemPrompt,
        cwd,
        maxTurns: options.reviewMaxTurns,
        abortController: ac,
        verbosity,
        onLog: taggedOnLog,
        variant: reviewer.variant,
        unitId: taskId,
      });
    } catch (err) {
      const errorMessage = err instanceof Error
        ? `${err.message}\n${err.stack ?? ""}`
        : String(err);
      result = makeErrorResult(errorMessage);
    } finally {
      activeAbortControllers.delete(ac);
      try {
        await reviewerDriver.teardown?.();
      } catch (teardownErr) {
        if (verbosity === "debug" || verbosity === "trace") {
          console.error(`  [teardown] error for reviewer ${reviewerId} (swallowed): ${teardownErr}`);
        }
      }
    }

    // Set timestamps
    const finishedAt = new Date().toISOString();
    result.startedAt = startedAt;
    result.finishedAt = finishedAt;

    // Accumulate totals (no budget decrement — already done once above).
    // Safe: JS is single-threaded and there is no await between read/write of totals fields.
    // Do NOT add async operations between these += lines.
    if (totals) {
      totals.costUsd += result.costUsd;
      totals.inputTokens += result.inputTokens;
      totals.outputTokens += result.outputTokens;
      totals.cacheReadTokens += result.cacheReadTokens;
      totals.cacheWriteTokens += result.cacheWriteTokens;
      totals.reasoningTokens += result.reasoningTokens;
      totals.durationMs += result.durationMs;
      totals.numTurns += result.numTurns;
    }

    console.log(
      `--- Review result [${reviewerId}]: ${result.signal.type} | ${result.numTurns} turns | ${(result.durationMs / 1000).toFixed(1)}s | $${result.costUsd.toFixed(4)} ---`,
    );

    const reviewReport = result.reviewReport || result.agentReport || null;

    // Emit reviewer_finished event (only in multi-review mode)
    if (isMultiReview) {
      options.onExecutionEvent?.({
        type: "execution:reviewer_finished",
        taskId,
        reviewerId,
        signal: result.signal,
        hasReport: !!reviewReport,
      });
    }

    return {
      reviewer,
      reviewerId,
      signal: result.signal,
      reviewReport,
      iterationResult: result,
    };
  });

  // Wait for all reviewers to finish
  const settled = await Promise.allSettled(reviewPromises);

  // Collect results and write reports/errors
  const allResults: ReviewResult[] = [];
  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      allResults.push(outcome.value);
    } else {
      // Promise rejected — write error report and emit reviewer_finished
      const reviewer = reviewers[i];
      const reviewerId = getReviewerId(reviewer);
      const errorMsg = outcome.reason instanceof Error
        ? `${outcome.reason.message}\n${outcome.reason.stack ?? ""}`
        : String(outcome.reason);
      const errorReport = `# Review Error: Task ${taskId} — Reviewer ${reviewerId}\n\n${errorMsg}\n`;
      writeReviewerReport(cwd, taskId, `${reviewerId}-error`, errorReport, roundSuffix);
      console.error(`  Reviewer ${reviewerId} failed: ${outcome.reason instanceof Error ? outcome.reason.message : outcome.reason}`);
      if (isMultiReview) {
        options.onExecutionEvent?.({
          type: "execution:reviewer_finished",
          taskId,
          reviewerId,
          signal: { type: "error", message: errorMsg },
          hasReport: false,
        });
      }
    }
  }

  // Filter to results that have a review report (regardless of signal type)
  const withReports = allResults.filter((r) => r.reviewReport != null);

  // Write error reports for fulfilled results that errored without producing a report
  for (const r of allResults) {
    if (r.reviewReport != null) continue;
    if (r.signal.type === "error") {
      const errorReport = `# Review Error: Task ${taskId} — Reviewer ${r.reviewerId}\n\n${r.signal.message}\n`;
      writeReviewerReport(cwd, taskId, `${r.reviewerId}-error`, errorReport, roundSuffix);
    } else if (r.signal.type === "none" && r.iterationResult.resultText) {
      // Breach (e.g. maxTurns exceeded) — preserve partial output for postmortem.
      const incompleteReport = `# Review Incomplete: Task ${taskId} — Reviewer ${r.reviewerId}\n\n${r.iterationResult.resultText}\n`;
      writeReviewerReport(cwd, taskId, `${r.reviewerId}-incomplete`, incompleteReport, roundSuffix);
    }
  }

  // Save individual reviewer reports with metadata headers
  for (const r of withReports) {
    const header = `Reviewer: ${r.reviewer.agent} / ${r.reviewer.model || "default"}${r.reviewer.variant ? ` / ${r.reviewer.variant}` : ""}\nAgent: ${r.reviewer.agent}\nModel: ${r.reviewer.model || "default"}\n\n`;
    writeReviewerReport(cwd, taskId, r.reviewerId, header + r.reviewReport!, roundSuffix);
  }

  // Emit multi_review_finished event (only in multi-review mode)
  if (isMultiReview) {
    options.onExecutionEvent?.({
      type: "execution:multi_review_finished",
      taskId,
      successCount: withReports.length,
      failCount: settled.length - withReports.length,
    });
  }

  // --- Check abort before state transitions ---

  if (isInterrupted()) {
    console.log(`  Review interrupted, preserving reports on disk.`);
    return false;
  }

  // --- Decide outcome based on number of reports ---

  if (withReports.length === 0) {
    // No reports at all — move to blocked
    console.log(`  No review reports produced, moving task ${taskId} to blocked.`);
    writeReviewReport(cwd, taskId, `# Review: Task ${taskId} — ${task.title}\n\nAll reviewers failed to produce a report.\n`, roundSuffix);
    setStatusDirect(taskId, "blocked", cwd);
    commitTaskmaster(cwd, `prorab: review blocked — no reports for task ${taskId}`);
    return false;
  }

  if (withReports.length === 1) {
    // Single report — use directly as the review report
    writeReviewReport(cwd, taskId, withReports[0].reviewReport!, roundSuffix);
    setStatusDirect(taskId, "rework", cwd);
    commitTaskmaster(cwd, `prorab: review complete for task ${taskId}, moving to rework`);
    return true;
  }

  // Multiple reports — run aggregation
  console.log(`  Aggregating ${withReports.length} review reports...`);

  const aggregationInputs: AggregationReportInput[] = withReports.map((r) => ({
    reviewerId: r.reviewerId,
    report: r.reviewReport!,
  }));

  const aggSystemPrompt = buildAggregationSystemPrompt();
  const aggTaskPrompt = buildAggregationTaskPrompt(aggregationInputs);

  // Tagged onLog for aggregator
  const aggTaggedOnLog: OnLogCallback | undefined = options.onLog
    ? (event) => {
        options.onLog!({ ...event, reviewerId: AGGREGATOR_REVIEWER_ID });
      }
    : undefined;

  aggTaggedOnLog?.({ type: "agent:system_prompt", text: aggSystemPrompt });
  aggTaggedOnLog?.({ type: "agent:task_prompt", text: aggTaskPrompt });

  // Create fresh driver for aggregation (NOT reusing the passed-in driver)
  const aggDriver = createDriver(options.agent, options.model, options.userSettings, false);

  const aggAc = new AbortController();
  activeAbortControllers.add(aggAc);

  let aggResult: IterationResult;
  try {
    await aggDriver.setup?.({ verbosity, abortSignal: aggAc.signal });
    aggResult = await aggDriver.runSession({
      prompt: aggTaskPrompt,
      systemPrompt: aggSystemPrompt,
      cwd,
      maxTurns: options.reviewMaxTurns,
      abortController: aggAc,
      verbosity,
      onLog: aggTaggedOnLog,
      variant: options.variant,
      unitId: taskId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error
      ? `${err.message}\n${err.stack ?? ""}`
      : String(err);
    aggResult = makeErrorResult(errorMessage);
  } finally {
    activeAbortControllers.delete(aggAc);
    try {
      await aggDriver.teardown?.();
    } catch (teardownErr) {
      if (verbosity === "debug" || verbosity === "trace") {
        console.error(`  [teardown] error for aggregator (swallowed): ${teardownErr}`);
      }
    }
  }

  // Accumulate aggregation totals
  if (totals) {
    totals.costUsd += aggResult.costUsd;
    totals.inputTokens += aggResult.inputTokens;
    totals.outputTokens += aggResult.outputTokens;
    totals.cacheReadTokens += aggResult.cacheReadTokens;
    totals.cacheWriteTokens += aggResult.cacheWriteTokens;
    totals.reasoningTokens += aggResult.reasoningTokens;
    totals.durationMs += aggResult.durationMs;
    totals.numTurns += aggResult.numTurns;
  }

  console.log(
    `--- Aggregation result: ${aggResult.signal.type} | ${aggResult.numTurns} turns | ${(aggResult.durationMs / 1000).toFixed(1)}s | $${aggResult.costUsd.toFixed(4)} ---`,
  );

  // Emit reviewer_finished for aggregator so its tab gets a status dot
  options.onExecutionEvent?.({
    type: "execution:reviewer_finished",
    taskId,
    reviewerId: AGGREGATOR_REVIEWER_ID,
    signal: aggResult.signal,
    hasReport: !!(aggResult.reviewReport || aggResult.agentReport),
  });

  // Write aggregated review report (no resultText fallback — raw text should not reach rework)
  const aggContent = aggResult.reviewReport || aggResult.agentReport;

  if (!aggContent) {
    if (aggResult.resultText) {
      // Breach or malformed output — preserve partial text for postmortem.
      const incompleteReport = `# Aggregation Incomplete: Task ${taskId}\n\n${aggResult.resultText}\n`;
      writeReviewerReport(cwd, taskId, "aggregator-incomplete", incompleteReport, roundSuffix);
    }
    console.log(`  Aggregation produced no parseable report, moving task ${taskId} to blocked.`);
    setStatusDirect(taskId, "blocked", cwd);
    commitTaskmaster(cwd, `prorab: aggregation produced no report for task ${taskId}`);
    return false;
  }

  writeReviewReport(cwd, taskId, aggContent, roundSuffix);

  if (aggResult.signal.type === "complete") {
    setStatusDirect(taskId, "rework", cwd);
    commitTaskmaster(cwd, `prorab: aggregated review complete for task ${taskId}, moving to rework`);
    return true;
  }

  // Aggregation failed — move to blocked
  const sig = aggResult.signal;
  if (sig.type === "blocked") {
    console.error(`\n!!! AGGREGATION BLOCKED: ${sig.reason} !!!`);
  } else if (sig.type === "error") {
    console.error(`\n!!! AGGREGATION ERROR: ${sig.message} !!!`);
  } else {
    console.log(`  Aggregation produced no signal, moving task ${taskId} to blocked.`);
  }
  setStatusDirect(taskId, "blocked", cwd);
  commitTaskmaster(cwd, `prorab: aggregation failed for task ${taskId}`);
  return false;
}

/**
 * Executes rework (fixing review issues) for a task.
 * Returns true if rework completed and task moved to `closed`, false otherwise.
 */
export async function executeRework(
  task: Task,
  cwd: string,
  options: RunOptions,
  driver: AgentDriver,
  isInterrupted: () => boolean,
  registerAbort?: (controller: AbortController) => void,
  budget?: IterationBudget,
  totals?: RunTotals,
): Promise<boolean> {
  const taskId = taskIdStr(task.id);
  const verbosity = getVerbosity(options);
  const { reviewRoundsTotal, reviewRound, roundSuffix } = getReviewRoundInfo(taskId, cwd);

  // Check iteration budget before starting
  if (budget && budget.remaining !== null && budget.remaining <= 0) {
    console.log(`\n  Iteration limit reached, stopping.`);
    return false;
  }

  // Check interrupted
  if (isInterrupted()) {
    console.log(`\n  Interrupted before rework of task ${taskId}.`);
    return false;
  }

  console.log(`\n--- Reworking task ${taskId}: "${task.title}" ---`);

  // Task stays in rework — do NOT change to in-progress

  // Read review feedback
  const reviewFeedback = readReviewReport(cwd, taskId, roundSuffix);

  // Build rework prompts
  const systemPrompt = buildReworkSystemPrompt(cwd);
  const prompt = buildReworkPrompt({
    taskTitle: task.title,
    taskDescription: task.description,
    taskDetails: task.details,
    reviewResult: reviewFeedback ?? "_No review feedback found._",
  });

  // Log prompts in debug/trace mode
  if (verbosity === "debug" || verbosity === "trace") {
    console.log(`\n\x1b[36m  [rework-system-prompt] (${systemPrompt.length} chars)\x1b[0m`);
    console.log(`\x1b[2m${systemPrompt}\x1b[0m`);
    console.log(`\n\x1b[36m  [rework-prompt] (${prompt.length} chars)\x1b[0m`);
    console.log(`\x1b[2m${prompt}\x1b[0m`);
  }

  // Send prompts to UI
  options.onLog?.({ type: "agent:system_prompt", text: systemPrompt });
  options.onLog?.({ type: "agent:task_prompt", text: prompt });

  // Capture start time and HEAD rev BEFORE session starts
  const startedAt = new Date().toISOString();
  const headBefore = getHeadRev(cwd);

  // Run agent session
  const abortController = new AbortController();
  registerAbort?.(abortController);

  let result: IterationResult;
  try {
    await driver.setup?.({ verbosity, abortSignal: abortController.signal });
    result = await driver.runSession({
      prompt,
      systemPrompt,
      cwd,
      maxTurns: options.maxTurns,
      abortController,
      verbosity,
      onLog: options.onLog,
      variant: options.variant,
      unitId: taskId,
    });
  } catch (err) {
    const errorMessage = err instanceof Error
      ? `${err.message}\n${err.stack ?? ""}`
      : String(err);
    result = makeErrorResult(errorMessage);
  } finally {
    try {
      await driver.teardown?.();
    } catch (teardownErr) {
      if (verbosity === "debug" || verbosity === "trace") {
        console.error(`  [teardown] error (swallowed): ${teardownErr}`);
      }
    }
  }

  // Set timestamps on result
  const finishedAt = new Date().toISOString();
  result.startedAt = startedAt;
  result.finishedAt = finishedAt;

  // Budget: when called from executeReviewCycle, budget is undefined
  // (the cycle manages budget itself, decrementing once for all rounds).
  if (budget && budget.remaining !== null) {
    budget.remaining--;
  }

  // Accumulate run totals
  if (totals) {
    totals.costUsd += result.costUsd;
    totals.inputTokens += result.inputTokens;
    totals.outputTokens += result.outputTokens;
    totals.cacheReadTokens += result.cacheReadTokens;
    totals.cacheWriteTokens += result.cacheWriteTokens;
    totals.reasoningTokens += result.reasoningTokens;
    totals.durationMs += result.durationMs;
    totals.numTurns += result.numTurns;
    totals.iterations += 1;
  }

  // Log result line
  console.log(
    `--- Rework result: ${result.signal.type} | ${result.numTurns} turns | ${(result.durationMs / 1000).toFixed(1)}s | $${result.costUsd.toFixed(4)} ---`,
  );

  // Guard: ensure agent didn't track/stage the lock file
  ensureLockNotTracked(cwd);

  // Auto-commit uncommitted changes
  const didAutoCommit = autoCommit(cwd, task.title);
  if (didAutoCommit) {
    console.log("  (auto-committed uncommitted changes)");
  }

  // Get commits made during this iteration
  const commits = headBefore ? getCommitsBetween(cwd, headBefore) : [];

  // Write rework report (track attempt number to avoid overwriting on retry)
  const reworkReportId = `${taskId}-rework`;
  const currentTask = showTaskById(taskId, cwd);
  const prevReworkAttempts = typeof currentTask.metadata?.reworkAttempts === "number" ? currentTask.metadata.reworkAttempts : 0;
  const reworkAttempt = prevReworkAttempts + 1;
  setMetadata(cwd, taskId, { reworkAttempts: reworkAttempt });
  const reportContext: ReportContext = {
    agentType: options.agent,
    commits,
  };
  appendReport(cwd, reworkReportId, reworkAttempt, result, reportContext);
  // Also write structured rework report for round-aware reads (used by executeReview in next round)
  if (result.agentReport) {
    writeReworkReport(cwd, taskId, result.agentReport, roundSuffix);
  }

  // Print iteration report to console
  if (verbosity !== "quiet") {
    if (commits.length > 0) {
      console.log("  Commits:");
      for (const c of commits) {
        console.log(`    ${c}`);
      }
    } else {
      console.log("  Commits: (none)");
    }
    if (result.agentReport) {
      console.log("  Agent Report:");
      for (const line of result.agentReport.split("\n")) {
        console.log(`    ${line}`);
      }
    } else {
      console.log("  (Agent did not provide a report)");
    }
  }

  // Signal branching
  if (result.signal.type === "complete") {
    const totalRounds = reviewRoundsTotal ?? 1;
    const currentRound = reviewRound ?? 1;
    const isFinalRound = totalRounds <= 1 || currentRound >= totalRounds;

    if (isFinalRound) {
      setStatusDirect(taskId, "closed", cwd);
      commitTaskmaster(cwd, `prorab: rework complete for task ${taskId}, moving to closed`);
    } else {
      // Atomically: reset reworkAttempts, increment round, transition to review
      setMetadata(cwd, taskId, { reworkAttempts: 0, reviewRound: currentRound + 1, reviewPhaseComplete: false });
      setStatusDirect(taskId, "review", cwd);
      commitTaskmaster(cwd, `prorab: rework complete for task ${taskId} round ${currentRound}/${totalRounds}, next round`);
    }
    return true;
  }

  if (result.signal.type === "blocked") {
    console.error(`\n!!! REWORK BLOCKED: ${result.signal.reason} !!!`);
    setStatusDirect(taskId, "blocked", cwd);
    commitTaskmaster(cwd, `prorab: rework blocked for task ${taskId}`);
    return false;
  }

  // error or no signal — task stays in rework (resumable)
  if (result.signal.type === "error") {
    console.error(`\n!!! REWORK ERROR: ${result.signal.message} !!!`);
  } else {
    console.log(`  No rework signal, task stays in rework (resumable).`);
  }
  commitTaskmaster(cwd, `prorab: rework incomplete for task ${taskId}`);
  return false;
}

/**
 * Runs N rounds of review+rework for a task.
 * Budget is decremented once for the entire cycle.
 * Accepts reviewFn/reworkFn as DI params (default to real functions) for testability.
 */
export async function executeReviewCycle(
  task: Task,
  cwd: string,
  options: RunOptions,
  driver: AgentDriver,
  isInterrupted: () => boolean,
  registerAbort?: (controller: AbortController) => void,
  budget?: IterationBudget,
  totals?: RunTotals,
  reviewFn: typeof executeReview = executeReview,
  reworkFn: typeof executeRework = executeRework,
  onPhaseChange?: (phase: "review" | "rework", round: number, total: number) => void,
): Promise<boolean> {
  const taskId = taskIdStr(task.id);

  // Budget: check once, decrement once for entire cycle
  if (budget && budget.remaining !== null && budget.remaining <= 0) {
    console.log(`\n  Iteration limit reached, stopping.`);
    return false;
  }
  if (budget && budget.remaining !== null) {
    budget.remaining--;
  }

  // Metadata is source of truth for active cycles — read task once
  const freshTask = showTaskById(taskId, cwd);
  const metaRoundsTotal = typeof freshTask.metadata?.reviewRoundsTotal === "number"
    ? freshTask.metadata.reviewRoundsTotal : undefined;
  const metaReviewContext = typeof freshTask.metadata?.reviewContext === "boolean"
    ? freshTask.metadata.reviewContext : undefined;
  const reviewRounds = metaRoundsTotal ?? options.reviewRounds ?? 1;
  const reviewContext = metaReviewContext ?? options.reviewContext ?? false;

  // Warn if CLI flag differs from metadata (user restarted with different value)
  if (metaRoundsTotal !== undefined && options.reviewRounds && metaRoundsTotal !== options.reviewRounds) {
    console.log(`  [review cycle] Warning: --review-rounds=${options.reviewRounds} ignored, using metadata value ${metaRoundsTotal}`);
  }
  const savedRound = typeof freshTask.metadata?.reviewRound === "number"
    ? freshTask.metadata.reviewRound : 0;
  let startRound = savedRound > 0 ? savedRound : 1;

  // Validate metadata consistency
  if (savedRound > reviewRounds) {
    console.log(`  [review cycle] Warning: metadata.reviewRound (${savedRound}) > reviewRoundsTotal (${reviewRounds}), resetting to round 1`);
    startRound = 1;
  }

  // Skip review if already completed for this round (crash recovery)
  // Check BOTH "review" and "rework" statuses — crash can happen after
  // reviewPhaseComplete=true but before status transitions to "rework"
  const skipReview = (freshTask.status === "rework" || freshTask.status === "review")
    && savedRound > 0
    && savedRound <= reviewRounds
    && freshTask.metadata?.reviewPhaseComplete === true;

  for (let round = startRound; round <= reviewRounds; round++) {
    if (isInterrupted()) return false;

    // Update metadata for this round (reviewContext persisted for crash recovery)
    setMetadata(cwd, taskId, { reviewRound: round, reviewRoundsTotal: reviewRounds, reviewContext });

    // --- Review phase (skip if resuming with review already complete) ---
    if (!(skipReview && round === startRound)) {
      onPhaseChange?.("review", round, reviewRounds);
      console.log(`\n  [review cycle] Round ${round}/${reviewRounds} — review`);
      setMetadata(cwd, taskId, { reviewPhaseComplete: false });

      // Run review — budget=undefined (don't decrement), totals passed normally
      // Pass effective reviewContext from metadata (source of truth for active cycles)
      const effectiveOptions = reviewContext !== options.reviewContext
        ? { ...options, reviewContext } : options;
      const reviewOk = await reviewFn(
        task, cwd, effectiveOptions, driver, isInterrupted, registerAbort,
        undefined, totals,
      );
      if (!reviewOk) return false;

      setMetadata(cwd, taskId, { reviewPhaseComplete: true });
      task = showTaskById(taskId, cwd) as Task;
    }

    // --- Rework phase ---
    console.log(`\n  [review cycle] Round ${round}/${reviewRounds} — rework`);
    onPhaseChange?.("rework", round, reviewRounds);

    // executeRework handles isFinalRound internally:
    // - final round → sets "closed"
    // - non-final → resets reworkAttempts, sets metadata(reviewRound=N+1) + status "review"
    const reworkOk = await reworkFn(
      task, cwd, options, driver, isInterrupted, registerAbort,
      undefined, totals,
    );
    if (!reworkOk) return false;

    task = showTaskById(taskId, cwd) as Task;
  }

  return true;
}

/**
 * Main execution loop for `prorab run`.
 * Returns true if all tasks completed successfully, false otherwise.
 */
export async function runCommand(options: RunOptions): Promise<boolean> {
  // Allow spawning Claude Code SDK sessions from within a Claude Code session.
  delete process.env.CLAUDECODE;

  const cwd = process.cwd();

  // --- Preflight checks ---

  if (!isGitRepo(cwd)) {
    console.error("Error: current directory is not a git repository.");
    process.exit(1);
  }

  if (options.agent === "opencode") {
    try {
      execFileSync("opencode", ["--version"], { stdio: "pipe" });
    } catch {
      console.error(
        "Error: opencode is not available in PATH. Install from: https://opencode.ai",
      );
      process.exit(1);
    }
  }

  const tasksPath = join(cwd, ".taskmaster", "tasks", "tasks.json");
  if (!existsSync(tasksPath)) {
    console.error(
      "Error: .taskmaster/tasks/tasks.json not found. Run task-master init first.",
    );
    process.exit(1);
  }

  if (!isTrackedByGit(join(".taskmaster", "tasks", "tasks.json"), cwd)) {
    console.error(
      "Error: .taskmaster/tasks/tasks.json is not tracked by git. " +
        "Run: git add .taskmaster/ && git commit -m 'init taskmaster'",
    );
    process.exit(1);
  }

  if (hasUncommittedChangesExcluding(cwd, ".taskmaster/")) {
    if (!options.allowDirty) {
      console.error(
        "Error: uncommitted changes in working tree. Commit or stash them, or use --allow-dirty.",
      );
      process.exit(1);
    }
    console.warn(
      "Warning: there are uncommitted changes in the working tree. " +
        "auto-commit may capture your uncommitted files into agent commits.",
    );
  }

  try {
    acquireLock(cwd);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // --- SIGINT handler (declared before try so it's accessible in finally) ---
  let interrupted = false;
  const isInterrupted = () => interrupted;
  let currentAbort: AbortController | undefined;
  const registerAbort = (controller: AbortController) => {
    currentAbort = controller;
  };
  const sigintHandler = () => {
    console.log("\n\nSIGINT received, aborting current session...");
    interrupted = true;
    currentAbort?.abort();
  };
  process.once("SIGINT", sigintHandler);

  try {
    const budget: IterationBudget = {
      remaining: options.maxIterations ?? null,
    };

    const verbosity = getVerbosity(options);
    let driver: AgentDriver;
    try {
      driver = createDriver(options.agent, options.model, options.userSettings, options.applyHooks ?? false);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }

    const totals: RunTotals = {
      costUsd: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      durationMs: 0, numTurns: 0, iterations: 0,
    };

    console.log("prorab run — starting execution loop\n");

    // --- Main loop (findNextAction-based) ---
    const budgetExhausted = () =>
      budget.remaining !== null && budget.remaining <= 0;

    while (!interrupted && !budgetExhausted()) {
      let action: NextAction;
      try {
        action = findNextAction(cwd, options.review);
      } catch (err) {
        console.error("Error getting next action:", err instanceof Error ? err.message : err);
        return false;
      }

      if (!action) {
        // Completion check: verify all tasks are actually closed (not deadlocked)
        const data = readTasksFile(cwd);
        const nonClosed = data.tasks.filter((t) => !TASK_FINAL_STATUSES.has(t.status));
        if (nonClosed.length > 0) {
          console.error(`\nNo available actions, but ${nonClosed.length} task(s) not closed:`);
          for (const t of nonClosed) {
            console.error(`  Task ${t.id} "${t.title}" — status: ${t.status}`);
          }
          console.error(`Possible deadlock or unresolvable dependencies. Check tasks.json.`);
          printSummary(totals, verbosity);
          return false;
        }
        console.log("\nAll tasks completed!");
        printSummary(totals, verbosity);
        return true;
      }

      switch (action.type) {
        case "blocked": {
          const task = action.task;
          console.error(`\nTask ${task.id}: "${task.title}" is blocked. Process stopped.`);
          console.error(`Resolve the blocked task manually and re-run.`);
          printSummary(totals, verbosity);
          return false;
        }

        case "execute": {
          const task = action.task;
          console.log(`\n=== Task ${task.id}: "${task.title}" ===`);

          if (action.subtask) {
            // Execute specific subtask — auto-set parent to in-progress if pending
            if (task.status === "pending") {
              setStatusDirect(taskIdStr(task.id), "in-progress", cwd);
            }
            console.log(`  → Subtask ${task.id}.${action.subtask.id}: "${action.subtask.title}"`);
            const unit = buildExecutionUnit(task, action.subtask);
            const success = await executeUnit(unit, cwd, options, driver, isInterrupted, registerAbort, budget, totals);
            if (!success) break; // break switch, outer while will re-evaluate
            // After subtask done: if review disabled and all subtasks done, parent needs done→closed
            // But reverse cascade in setStatusDirect already handles parent → done/closed
            // So we only need explicit done→closed for tasks WITHOUT subtasks (below)
          } else {
            // No subtasks — execute task directly
            console.log(`  No subtasks, executing task directly`);
            const unit = buildExecutionUnit(task);
            const success = await executeUnit(unit, cwd, options, driver, isInterrupted, registerAbort, budget, totals);
            if (!success) break;
            // If review disabled, move done → closed explicitly
            // (For tasks WITH subtasks, reverse cascade handles this already)
            if (!options.review) {
              setStatusDirect(taskIdStr(task.id), "closed", cwd);
              commitTaskmaster(cwd, `prorab: task ${task.id} closed (no review)`);
            }
          }
          break;
        }

        case "review":
        case "rework": {
          await executeReviewCycle(action.task, cwd, options, driver, isInterrupted, registerAbort, budget, totals);
          break;
        }
      }
    }

    if (interrupted) {
      console.log("Execution interrupted by user.");
    } else if (budgetExhausted()) {
      console.log(
        `Iteration limit reached (${options.maxIterations} iteration${options.maxIterations === 1 ? "" : "s"} used).`,
      );
    }
    printSummary(totals, verbosity);
    return false;
  } finally {
    // Safety net: commit any uncommitted .taskmaster/ changes before exiting.
    // Normally each code path commits explicitly, but edge cases (budget
    // exhaustion, unexpected errors) may leave .taskmaster/ dirty.
    commitTaskmaster(cwd, "prorab: commit taskmaster state on exit");
    process.removeListener("SIGINT", sigintHandler);
    releaseLock(cwd);
  }
}
