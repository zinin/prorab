#!/usr/bin/env node
import { Command } from "commander";
import { z } from "zod";
import { runCommand } from "./commands/run.js";
import { AgentTypeSchema } from "./types.js";
import { parseReviewerSpec, ReviewersArraySchema } from "./core/reviewer-utils.js";

const RunOptionsSchema = z.object({
  agent: AgentTypeSchema.default("claude"),
  model: z.string().optional(),
  variant: z.string().optional(),
  maxRetries: z.coerce.number().int().positive(),
  maxTurns: z.coerce.number().int().positive(),
  reviewMaxTurns: z.coerce.number().int().positive().default(100),
  allowDirty: z.boolean(),
  quiet: z.boolean(),
  debug: z.boolean(),
  trace: z.boolean(),
  maxIterations: z.coerce.number().int().positive().optional(),
  userSettings: z.boolean(),
  applyHooks: z.boolean().default(false),
  review: z.boolean(),
  reviewers: ReviewersArraySchema,
  reviewRounds: z.coerce.number().int().min(1).max(10).default(1),
  reviewContext: z.boolean().default(false),
});

const program = new Command();

program
  .name("prorab")
  .description("Autonomous task execution CLI powered by Claude Agent SDK and OpenCode")
  .version("0.1.0");

program
  .command("run")
  .description("Execute tasks from task-master autonomously")
  .option("--agent <type>", 'Agent backend: "claude", "opencode", "ccs", or "codex"', "claude")
  .option("--model <model>", "Model for the agent (optional)")
  .option("--variant <variant>", "Effort level (Claude: low/medium/high/max) or model variant (OpenCode)")
  .option("--max-retries <number>", "Max retry attempts per task", "3")
  .option("--max-turns <number>", "Max turns per task attempt (execute/rework)", "200")
  .option("--review-max-turns <number>", "Max turns per review/aggregator attempt", "100")
  .option("--max-iterations <number>", "Max total SDK sessions across all tasks")
  .option("--allow-dirty", "Allow running with uncommitted changes", false)
  .option("--quiet", "Suppress SDK session output", false)
  .option("--debug", "Show detailed agent output (text truncated at 2000ch)", false)
  .option("--trace", "Show full untruncated agent output", false)
  .option("--no-review", "Disable code review after task execution")
  .option("--reviewer <spec...>", "Additional reviewers as agent:model[:variant] (repeatable)")
  .option("--review-rounds <number>", "Number of review+rework cycles per task (1-10)", "1")
  .option("--review-context", "Pass previous round reports to re-review", false)
  .option("--no-user-settings", "Skip loading ~/.claude/settings.json in agent sessions")
  .option("--apply-hooks", "Apply hooks from CCS profile (ccs agent only)", false)
  .action(async (opts) => {
    let reviewers;
    try {
      reviewers = opts.reviewer?.map((s: string) => parseReviewerSpec(s));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    const parsed = RunOptionsSchema.safeParse({
      agent: opts.agent,
      model: opts.model,
      variant: opts.variant,
      maxRetries: opts.maxRetries,
      maxTurns: opts.maxTurns,
      reviewMaxTurns: opts.reviewMaxTurns,
      maxIterations: opts.maxIterations,
      allowDirty: opts.allowDirty,
      quiet: opts.quiet,
      debug: opts.debug,
      trace: opts.trace,
      userSettings: opts.userSettings,
      applyHooks: opts.applyHooks ?? false,
      review: opts.review ?? true,
      reviewers,
      reviewRounds: opts.reviewRounds,
      reviewContext: opts.reviewContext,
    });
    if (!parsed.success) {
      console.error("Invalid options:", parsed.error.format());
      process.exit(1);
    }
    const success = await runCommand(parsed.data);
    if (!success) process.exit(1);
  });

import { serveCommand, ServeOptionsSchema } from "./commands/serve.js";

program
  .command("serve")
  .description("Start web UI server for task management")
  .option("--port <number>", "Server port", "3000")
  .option("--open", "Open browser automatically", false)
  .action(async (opts) => {
    const parsed = ServeOptionsSchema.safeParse({
      port: opts.port,
      open: opts.open,
    });
    if (!parsed.success) {
      console.error("Invalid options:", parsed.error.format());
      process.exit(1);
    }
    await serveCommand(parsed.data);
  });

program.parse();
