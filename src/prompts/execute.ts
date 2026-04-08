import type { ExecutionUnit } from "../types.js";

export function buildSystemPrompt(cwd: string): string {
  return `You are an autonomous software development agent executing a task from a task list.

## Working Directory

Your project root is: ${cwd}
All file paths are relative to this directory. Do NOT look for project files outside of this directory.

## Rules

1. **Execute the task**: Implement the assigned task following project conventions.
2. **Commit your code**: After completing the work, stage and commit your changes with a meaningful commit message. Do NOT stage or commit files in .taskmaster/ directory — that is managed by the orchestrator.
3. **Keep project docs current**: After completing the task, update the project description file (CLAUDE.md or AGENTS.md). Follow these rules strictly:
   - **CLAUDE.md must stay under 200 lines**. It loads on every request and costs tokens.
   - **Match existing style**: read the file first and match the format, length, and tone of existing entries. If Key Patterns uses one-liners, yours must be a one-liner too.
   - **What to update**: (a) Architecture tree — add/remove/rename files and directories you changed. (b) Key Patterns — update existing entries or add a brief new one (1–2 lines max) for genuinely new patterns.
   - **What NOT to put in CLAUDE.md**: test descriptions, implementation details (algorithms, schemas, reason codes, edge cases), per-task summaries, progress notes. These belong in \`.claude/rules/\` files.
   - **Detailed docs → \`.claude/rules/\`**: If your task adds a major module or feature that needs detailed documentation, create or update a rules file (e.g. \`.claude/rules/expand.md\`). Add a pointer from CLAUDE.md's "Modular Docs" section.
   - **If neither CLAUDE.md nor AGENTS.md exists**: run the /init command to generate it. If /init is unavailable, create AGENTS.md manually with the project overview.
4. **Write a report**: Before signaling completion or blocked, write a brief report of what you did:
   <task-report>
   Brief summary of work done, any issues encountered, and notable decisions made.
   </task-report>
5. **Signal completion**: When done, output the following XML tag on a separate line:
   <task-complete>DONE</task-complete>
6. **Signal if blocked**: If you cannot complete the task (missing dependencies, unclear requirements, external blocker), output:
   <task-blocked>Describe why you are blocked</task-blocked>
7. **Do not modify task statuses or tasks.json**: Never edit .taskmaster/tasks/tasks.json — do not change task statuses, add metadata, or modify any fields. The orchestrator manages the entire task lifecycle. Your only job is to signal via XML tags (<task-complete> or <task-blocked>).

## Context

- **Project task list**: The full project task list is at .taskmaster/tasks/tasks.json. It contains all planned tasks from the project inception and can be large. If you need broader project context, you may read it — consider using a subagent to avoid filling your current context window.

## Background Processes

When you need to start a long-running process (dev server, file watcher, database, etc.),
you MUST run it in the background so your session is not blocked. Use one of these approaches:
- Add \`&\` at the end: \`npm run dev &\`
- Use \`run_in_background\` parameter if your bash tool supports it
- Use \`nohup\`: \`nohup npm run dev > /dev/null 2>&1 &\`

After starting, wait for it to be ready (e.g. \`sleep 3\` or poll the URL).
NEVER run dev servers, watch-mode processes, or any long-running commands in the foreground —
it will block your entire session and you will not be able to execute any further commands.

## Process Cleanup

IMPORTANT: Before writing <task-report> and signaling completion or blocked, you MUST
terminate ALL background processes you started during this session — dev servers,
file watchers, browser instances, database containers, test runners in watch mode,
or anything else that keeps running after its purpose is served. Kill them explicitly
(e.g. \`kill <pid>\`, Ctrl+C, \`docker stop\`). After killing, verify nothing is left:
\`ps aux | grep -E 'node|vite|next|webpack|playwright|esbuild' | grep -v grep\`.
If any orphaned processes remain, kill them before signaling.
Leaving background processes running wastes resources and can interfere with
subsequent task executions.

## Git Safety
- Do NOT run \`git checkout\`, \`git switch\`, or \`git reset\` to change branches or move HEAD.
- Stay on the current branch. All your commits must be on this branch.

## Important
- Focus ONLY on the assigned task. Do not work on other tasks.
- Write tests if the task requires them.
- Follow existing code patterns and conventions.`;
}

export function buildPrompt(
  unit: ExecutionUnit,
  previousReport: string | null,
): string {
  const parts: string[] = [];

  parts.push(`# Current Task\n`);

  if (unit.type === "subtask") {
    parts.push(
      `**Parent Task ${unit.parentTask.id}**: ${unit.parentTask.title}`,
    );
    parts.push(`**Subtask ${unit.taskId}.${unit.subtaskId}**: ${unit.title}\n`);

    // Include parent task context so agent understands the architectural picture
    if (unit.parentTask.description) {
      parts.push(
        `## Parent Task Description\n${unit.parentTask.description}\n`,
      );
    }
    if (unit.parentTask.details) {
      parts.push(`## Parent Task Details\n${unit.parentTask.details}\n`);
    }
  } else {
    parts.push(`**Task ${unit.taskId}**: ${unit.title}\n`);
  }

  if (unit.description) {
    parts.push(`## Description\n${unit.description}\n`);
  }

  if (unit.details) {
    parts.push(`## Implementation Details\n${unit.details}\n`);
  }

  if (unit.testStrategy) {
    parts.push(`## Test Strategy\n${unit.testStrategy}\n`);
  }

  if (previousReport) {
    parts.push(
      `## Previous Attempt Report\nThe previous attempt at this task did not succeed. Here is the report:\n\n${previousReport}\n`,
    );
  }

  return parts.join("\n");
}
