import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { IterationResult } from "../types.js";

export interface ReportContext {
  agentType: string;
  commits: string[];
}

export function getReportPath(cwd: string, taskId: string): string {
  return join(cwd, ".taskmaster", "reports", `${taskId}.md`);
}

export function appendReport(
  cwd: string,
  taskId: string,
  iteration: number,
  result: IterationResult,
  context: ReportContext,
): void {
  const reportPath = getReportPath(cwd, taskId);
  mkdirSync(dirname(reportPath), { recursive: true });

  const signal = result.signal;
  const status =
    signal.type === "complete"
      ? "complete"
      : signal.type === "blocked"
        ? `blocked: ${signal.reason}`
        : signal.type === "error"
          ? `error: ${signal.message}`
          : "no signal";

  const durationSec = (result.durationMs / 1000).toFixed(1);

  // Commits section
  let commitsSection: string;
  if (context.commits.length > 0) {
    const lines = context.commits.map((c) => {
      const spaceIdx = c.indexOf(" ");
      if (spaceIdx > 0) {
        const sha = c.slice(0, spaceIdx);
        const msg = c.slice(spaceIdx + 1);
        return `- \`${sha}\` ${msg}`;
      }
      return `- \`${c}\``;
    });
    commitsSection = lines.join("\n");
  } else {
    commitsSection = "_No commits._";
  }

  // Agent report section
  const reportSection = result.agentReport ?? "_Agent did not provide a report._";

  const entry = `## Iteration ${iteration}

Status: ${status}
Agent: ${context.agentType}
Model: ${result.model}
Started: ${result.startedAt}
Finished: ${result.finishedAt}
Duration: ${durationSec}s
Turns: ${result.numTurns}
Cost: $${result.costUsd.toFixed(4)}
Input tokens: ${result.inputTokens}
Output tokens: ${result.outputTokens}
Cache read tokens: ${result.cacheReadTokens}
Cache write tokens: ${result.cacheWriteTokens}
Reasoning tokens: ${result.reasoningTokens}

### Commits
${commitsSection}

### Agent Report
${reportSection}

---

`;
  appendFileSync(reportPath, entry, "utf-8");
}

/**
 * Strip metadata lines (Status, Agent, Model, timestamps, tokens, cost)
 * from execution reports, keeping only iteration headers, commits, and agent reports.
 */
export function stripReportMetadata(report: string): string {
  const metadataKeys = new Set([
    "status", "agent", "model", "started", "finished",
    "duration", "turns", "cost", "input tokens", "output tokens",
    "cache read tokens", "cache write tokens", "reasoning tokens",
  ]);

  const lines = report.split("\n");
  const result: string[] = [];
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      if (metadataKeys.has(key)) continue;
    }
    result.push(line);
  }

  // Collapse multiple blank lines into one
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function readReport(cwd: string, taskId: string): string | null {
  const reportPath = getReportPath(cwd, taskId);
  try {
    return readFileSync(reportPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function getReviewerReportPath(cwd: string, taskId: string, reviewerId: string, round?: number): string {
  const roundSuffix = round && round > 0 ? `-r${round}` : "";
  return join(cwd, ".taskmaster", "reports", `${taskId}-review${roundSuffix}-${reviewerId}.md`);
}

export function writeReviewerReport(cwd: string, taskId: string, reviewerId: string, content: string, round?: number): void {
  const reportPath = getReviewerReportPath(cwd, taskId, reviewerId, round);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, content, "utf-8");
}

export function readReviewerReport(cwd: string, taskId: string, reviewerId: string, round?: number): string | null {
  const reportPath = getReviewerReportPath(cwd, taskId, reviewerId, round);
  try {
    return readFileSync(reportPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function getReviewReportPath(cwd: string, taskId: string, round?: number): string {
  const roundSuffix = round && round > 0 ? `-r${round}` : "";
  return join(cwd, ".taskmaster", "reports", `${taskId}-review${roundSuffix}.md`);
}

export function writeReviewReport(cwd: string, taskId: string, content: string, round?: number): void {
  const reportPath = getReviewReportPath(cwd, taskId, round);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, content, "utf-8");
}

export function readReviewReport(cwd: string, taskId: string, round?: number): string | null {
  const reportPath = getReviewReportPath(cwd, taskId, round);
  try {
    return readFileSync(reportPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function getReworkReportPath(cwd: string, taskId: string, round?: number): string {
  const roundSuffix = round && round > 0 ? `-r${round}` : "";
  return join(cwd, ".taskmaster", "reports", `${taskId}-rework${roundSuffix}.md`);
}

export function writeReworkReport(cwd: string, taskId: string, content: string, round?: number): void {
  const reportPath = getReworkReportPath(cwd, taskId, round);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, content, "utf-8");
}

export function readReworkReport(cwd: string, taskId: string, round?: number): string | null {
  const reportPath = getReworkReportPath(cwd, taskId, round);
  try {
    return readFileSync(reportPath, "utf-8");
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}
