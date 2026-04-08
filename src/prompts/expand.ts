/**
 * Prompts, schemas, and reason codes for the expand (task decomposition) agent session.
 *
 * The agent explores the codebase (read-only) and decomposes a single top-level
 * task into subtasks. The result is a strict JSON object `{ subtasks: [...] }`
 * emitted as the last textual message of the session.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

/**
 * Codes emitted at start-time when the expand session cannot begin.
 * Each value is a machine-readable string suitable for API responses.
 */
export const EXPAND_START_REASON_CODES = [
  "task_not_found",
  "tasks_file_missing",
  "tasks_file_invalid",
  "task_not_pending",
  "task_has_subtasks",
  "git_not_repo",
  "tasks_file_untracked",
  "git_identity_missing",
  "tasks_file_dirty",
  "active_session",
] as const;

export type ExpandStartReasonCode = (typeof EXPAND_START_REASON_CODES)[number];

/**
 * Codes emitted when the expand session terminates with a failure.
 */
export const EXPAND_FAILURE_REASON_CODES = [
  "agent_failed",
  "result_parse_failed",
  "validation_failed",
  "hash_conflict",
  "commit_failed_after_write",
] as const;

export type ExpandFailureReasonCode =
  (typeof EXPAND_FAILURE_REASON_CODES)[number];

// ---------------------------------------------------------------------------
// Result schemas
// ---------------------------------------------------------------------------

/**
 * Schema for a single subtask produced by the expand agent.
 *
 * Uses `.strict()` so that any unknown properties cause a validation error
 * rather than being silently stripped.
 */
export const ExpandSubtaskResultSchema = z
  .object({
    id: z.number().int().positive(),
    title: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1),
    details: z.string().trim().min(1),
    dependencies: z.array(z.number().int().positive()),
    testStrategy: z.string().trim().min(1).optional(),
  })
  .strict();

export type ExpandSubtaskResult = z.infer<typeof ExpandSubtaskResultSchema>;

/**
 * Schema for the complete expand result — the JSON object the agent must
 * produce as its final textual message.
 *
 * Uses `.strict()` to reject unknown top-level keys.
 */
export const ExpandResultSchema = z
  .object({
    subtasks: z.array(ExpandSubtaskResultSchema),
  })
  .strict()
  .superRefine((data, ctx) => {
    const { subtasks } = data;
    if (subtasks.length === 0) return; // valid no-op

    // IDs must be sequential 1..N
    for (let i = 0; i < subtasks.length; i++) {
      const expected = i + 1;
      if (subtasks[i].id !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["subtasks", i, "id"],
          message: `Expected sequential id ${expected}, got ${subtasks[i].id}`,
        });
      }
    }

    const allIds = new Set(subtasks.map((s) => s.id));

    for (let i = 0; i < subtasks.length; i++) {
      const subtask = subtasks[i];
      for (const dep of subtask.dependencies) {
        // No self-referential dependencies
        if (dep === subtask.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subtasks", i, "dependencies"],
            message: `Subtask ${subtask.id} cannot depend on itself`,
          });
        }
        // Dependencies must reference existing IDs
        if (!allIds.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subtasks", i, "dependencies"],
            message: `Dependency ${dep} references non-existent subtask id`,
          });
        }
        // No forward references (dependency ID must be < current ID)
        if (dep > subtask.id) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["subtasks", i, "dependencies"],
            message: `Dependency ${dep} is a forward reference from subtask ${subtask.id}`,
          });
        }
      }
    }
  });

export type ExpandResult = z.infer<typeof ExpandResultSchema>;

// ---------------------------------------------------------------------------
// Task context type (input for prompt builders)
// ---------------------------------------------------------------------------

/** Fields of the top-level task passed into expand prompts. */
export interface ExpandTaskContext {
  /**
   * Task ID — accepts `string | number` to match the `FullTask` type from
   * tasks-json, where IDs may be numeric or string depending on format.
   * Only used for display in prompts; the output schema enforces numeric IDs.
   */
  id: string | number;
  title: string;
  description?: string;
  details?: string;
  dependencies?: (string | number)[];
  testStrategy?: string;
  expansionPrompt?: string;
  complexityReasoning?: string;
  recommendedSubtasks?: number;
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

export function buildExpandSystemPrompt(cwd: string): string {
  return `You are an autonomous task decomposition agent.

## Working Directory

Your project root is: ${cwd}
All file paths are relative to this directory. Do NOT look for project files outside of this directory.

## Your Goal

Decompose a single top-level task into a set of ordered subtasks by analysing the codebase.

## Rules

### Read-Only Access
You have FULL read-only access to the codebase. Explore files, directories, dependencies, and conventions as deeply as needed.
You MUST NOT modify, create, or delete any files. Do NOT run \`git add\`, \`git commit\`, \`git checkout\`, \`git switch\`, \`git reset\`, or any command that changes the working tree or git state.

### Output Contract
Your LAST textual message MUST contain ONLY a single JSON object matching this schema — no prose, no markdown fences, no XML tags, no wrappers of any kind before or after the JSON.

Example (output exactly like this, with NO wrapping):

{"subtasks": [{"id": 1, "title": "Short subtask title", "description": "What needs to be done and why", "details": "Implementation guidance grounded in the actual codebase", "dependencies": []}]}

### Subtask Field Requirements
- \`id\`: sequential integer starting from 1, continuous up to N.
- \`title\`: string, non-empty, concise (at most 80 chars).
- \`description\`: string, non-empty, explains what and why.
- \`details\`: string, non-empty, implementation guidance referencing actual files/patterns found in the codebase.
- \`dependencies\`: array of subtask IDs (integers) within this same result. Only reference IDs that exist in this result. Use \`[]\` if none.
- \`testStrategy\`: string (optional), verification approach.

### Decomposition Guidelines
- Subtask IDs go \`1..N\` sequentially.
- Dependencies reference ONLY local subtask IDs from this result — never top-level task IDs or external IDs.
- An empty result \`{ "subtasks": [] }\` is valid when the task is atomic and cannot be meaningfully decomposed.
- Each subtask should be a focused, implementable unit of work completable in a single agent session.
- Order subtasks so that dependency targets have lower IDs than their dependents.
- Ground every subtask in what you actually find in the codebase — reference real files, modules, patterns.
- Do NOT invent requirements beyond what the task description and details specify.

### Forbidden
- Do NOT output prose, explanations, or commentary — only the raw JSON object.
- Do NOT wrap the JSON in markdown code fences (\`\`\`).
- Do NOT use XML tags (\`<task-complete>\`, \`<task-blocked>\`, etc.).
- Do NOT include fields beyond those listed above in subtask objects.
- Do NOT reference task IDs outside of this subtask list in dependencies.`;
}

export function buildExpandTaskPrompt(task: ExpandTaskContext): string {
  const parts: string[] = [];

  parts.push(`# Task to Decompose\n`);
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

  if (task.expansionPrompt) {
    parts.push(
      `## Expansion Guidance (from complexity analysis)\n${task.expansionPrompt}\n`,
    );
  }

  if (task.complexityReasoning) {
    parts.push(
      `## Complexity Analysis Context\n${task.complexityReasoning}\n`,
    );
  }

  if (task.recommendedSubtasks != null && task.recommendedSubtasks > 0) {
    parts.push(
      `## Recommended Subtask Count\nAim for approximately ${task.recommendedSubtasks} subtasks. This is a guideline, not a hard constraint — use your judgement based on what you find in the codebase.\n`,
    );
  }

  parts.push(
    `Explore the project codebase at the working directory, then produce the subtask decomposition JSON as your final message.`,
  );

  return parts.join("\n");
}
