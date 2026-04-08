// src/prompts/complexity.ts
import { z } from "zod";

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export const COMPLEXITY_FAILURE_REASON_CODES = [
  "agent_failed",
  "result_parse_failed",
  "validation_failed",
] as const;

export type ComplexityFailureReasonCode =
  (typeof COMPLEXITY_FAILURE_REASON_CODES)[number];

// ---------------------------------------------------------------------------
// Result schema
// ---------------------------------------------------------------------------

export const ComplexityResultSchema = z
  .object({
    complexityScore: z.number().int().min(1).max(10),
    recommendedSubtasks: z.number().int().nonnegative(),
    expansionPrompt: z.string(),
    reasoning: z.string().min(1),
  });
// No .strict() — LLMs may add extra fields; tolerant parsing improves reliability

export type ComplexityResult = z.infer<typeof ComplexityResultSchema>;

// ---------------------------------------------------------------------------
// Task context (input for prompt builders)
// ---------------------------------------------------------------------------

export interface ComplexityTaskContext {
  id: string | number;
  title: string;
  description?: string;
  details?: string;
  dependencies?: (string | number)[];
  testStrategy?: string;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildComplexitySystemPrompt(cwd: string): string {
  return `You are an expert software architect assessing task complexity.

## Working Directory

Your project root is: ${cwd}
All file paths are relative to this directory. Do NOT look for project files outside of this directory.

## Your Goal

Evaluate the complexity of a single task on a 1–10 scale by analysing the codebase, and recommend how many subtasks it should be decomposed into.

## Rules

### Read-Only Access
You have FULL read-only access to the codebase. Explore files, directories, dependencies, and conventions as deeply as needed.
You MUST NOT modify, create, or delete any files. Do NOT run \`git add\`, \`git commit\`, \`git checkout\`, \`git switch\`, \`git reset\`, or any command that changes the working tree or git state.

### Output Contract
Your LAST textual message MUST contain ONLY a single JSON object matching this schema — no prose, no markdown fences, no XML tags, no wrappers of any kind before or after the JSON.

Example (output exactly like this, with NO wrapping):

{"complexityScore": 7, "recommendedSubtasks": 5, "expansionPrompt": "Break down into: setup, core logic, integration, tests, docs", "reasoning": "Requires multiple system integrations and careful error handling"}

### Field Requirements
- \`complexityScore\`: integer 1–10. 1 = trivial rename, 10 = major cross-cutting refactor.
- \`recommendedSubtasks\`: non-negative integer. 0 means the task is atomic and should NOT be decomposed.
- \`expansionPrompt\`: string guiding the decomposition agent — mention key areas to split.
- \`reasoning\`: string explaining your score — mention specific files, patterns, and risks found.

### Scoring Guidelines
- 1-2: Trivial changes (rename, config tweak, one-liner fix)
- 3-4: Simple feature (single file, well-understood pattern)
- 5-6: Moderate feature (2-4 files, some integration)
- 7-8: Complex feature (multiple files, new patterns, integration concerns)
- 9-10: Major cross-cutting change (architecture, many files, high risk)

### Forbidden
- Do NOT output prose, explanations, or commentary — only the raw JSON object.
- Do NOT wrap the JSON in markdown code fences (\`\`\`).
- Do NOT use XML tags (\`<task-complete>\`, \`<task-blocked>\`, etc.).
- Do NOT include fields beyond those listed above.`;
}

export function buildComplexityTaskPrompt(task: ComplexityTaskContext): string {
  const parts: string[] = [];

  parts.push(`# Task to Assess\n`);
  parts.push(`**Task ${task.id}**: ${task.title}\n`);

  if (task.description) {
    parts.push(`## Description\n${task.description}\n`);
  }

  if (task.details) {
    parts.push(`## Implementation Details\n${task.details}\n`);
  }

  if (task.dependencies && task.dependencies.length > 0) {
    parts.push(
      `## Dependencies\nThis task depends on tasks: ${task.dependencies.join(", ")}.\n`,
    );
  }

  if (task.testStrategy) {
    parts.push(`## Test Strategy\n${task.testStrategy}\n`);
  }

  parts.push(
    `Explore the project codebase at the working directory, then produce the complexity assessment JSON as your final message.`,
  );

  return parts.join("\n");
}
