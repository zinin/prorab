# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is prorab

Autonomous task execution CLI powered by Claude Agent SDK, OpenCode, CCS, and Codex. Reads tasks directly from `.taskmaster/tasks/tasks.json` (Task Master format), executes each via agent sessions (Claude Code, OpenCode, CCS, or Codex), auto-commits results. No `task-master` CLI dependency — all task I/O is in-process. Two commands: `prorab run` (autonomous execution) and `prorab serve` (web UI for task management).

## Commands

- `npm run build` — compile TypeScript + build Vue frontend
- `npm run dev` — watch mode (`tsc --watch`)
- `npm test` — run all tests (`vitest run`)
- `npx vitest run src/__tests__/parse-signal.test.ts` — run a single test file
- `npm run build:ui` — build Vue frontend (`cd ui && vite build`)
- `npx vue-tsc --noEmit --project ui/tsconfig.json` — type-check Vue SFC files (Vite skips type checking, run this after UI changes)
- `npm run dev:ui` — Vite dev server for frontend (`cd ui && vite dev`)
- `prorab serve` — start web UI server

## Architecture

```
src/
├── index.ts              # CLI entry (commander + zod)
├── types.ts              # Zod schemas, TS types, WS event types
├── commands/
│   ├── run.ts            # Main execution loop
│   └── serve.ts          # Fastify server setup
├── core/
│   ├── drivers/          # AgentDriver strategy: claude.ts, opencode.ts, ccs.ts, codex.ts, factory.ts, types.ts, logging.ts, context-window.ts, async-queue.ts
│   ├── tasks-json.ts     # Direct tasks.json I/O, findNextAction, setStatus, CRUD, writeExpandSubtasks, writeComplexityFields
│   ├── tasks-json-types.ts # Zod schemas for tasks.json format
│   ├── git.ts            # Git operations (auto-commit, dirty check, expand/complexity preflight/commit)
│   ├── lock.ts           # In-process mutex
│   ├── project-state.ts  # hasPrd, checkTasksFile, getProjectState
│   ├── reporter.ts       # Markdown reports in .taskmaster/reports/
│   ├── net-utils.ts      # findFreePort()
│   ├── reviewer-utils.ts # Multi-reviewer utilities
│   ├── validate-parse-prd.ts # Post-validation for parse-prd results
│   ├── expand-validation.ts  # Parse + validate expand agent JSON result
│   ├── complexity-validation.ts # Parse + validate complexity assessment agent results
│   ├── json-extract.ts       # Extract last top-level JSON block from agent text (string-aware brace scan)
│   ├── slot-pool.ts          # Generic async worker pool with fixed concurrency and stable slot indices
│   └── tasks-json-hash.ts    # SHA-256 hash snapshot + verification for tasks.json conflict detection
├── prompts/              # execute.ts, review.ts, parse-prd.ts, expand.ts, complexity.ts, refine-tasks.ts
└── server/
    ├── routes/           # tasks, execution, chat, parse-prd, refine-prd, refine-tasks, expand, batch-expand, reports, status, models
    ├── ws.ts             # WebSocket, file watcher, state providers (chat, parse-prd, refine-tasks, expand, batch-expand)
    ├── execution-manager.ts
    ├── chat-manager.ts
    ├── parse-prd-manager.ts
    ├── refine-prd-manager.ts       # Refine PRD pipeline manager (sequential chat sessions)
    ├── refine-tasks-manager.ts     # Refine Tasks pipeline manager (sequential chat sessions against tasks.json)
    ├── expand-manager.ts       # Expand (single task decomposition) session manager
    ├── batch-expand-manager.ts # Batch expand (parallel complexity + expansion) session manager
    └── session/          # session-core.ts, driver-runner.ts, ws-broadcaster.ts
ui/                       # Vue 3 + Vite + PrimeVue SPA
├── src/
│   ├── router.ts
│   ├── constants/        # prompts.ts (shared prompt templates)
│   ├── stores/           # tasks, execution, chat, parsePrd, refinePrd, refineTasks, expand, batchExpand (Pinia)
│   ├── composables/      # useWebSocket, usePersistedRef, useSessionDefaults, project-state-mapping, parse-prd-state-mapping, refine-prd-state-mapping, refine-tasks-state-mapping, expand-state-mapping, expand-launch-helpers, batch-expand-launch-helpers
│   ├── views/            # TaskList (+task-list-view-mode.ts), TaskDetail, SubtaskDetail, Chat, Execution
│   └── components/       # AgentWizard, AgentChatPanel, ParsePrdProgress, RefinePrdProgress, RefineTasksProgress, ExpandProgress, BatchExpandProgress, ChatMessageItem, AskUserQuestion, EventLogEntry, ReportSection, TaskContextPanel
```

## Key Patterns

**Task Master format**: reads/writes `.taskmaster/tasks/tasks.json` directly (no CLI dependency). Atomic writes via temp file + rename. Concurrent mutations serialized by in-process mutex. Supports standard and multi-tag formats.

**Status model**: Task: `pending → in-progress → done → review → rework → closed` + `blocked`. Subtask: `pending → in-progress → done` + `blocked`. Validated by `ALLOWED_TRANSITIONS` in `tasks-json.ts`.

**Execution flow**: `findNextAction(cwd, reviewEnabled)` returns action type by priority: `blocked` > `rework` > `review` > `execute`. Main loop in `run.ts` switches on action type. Each unit gets own SDK session → parse XML signals → auto-commit + report → set status.

**Review pipeline**: `done` → review agent (code-review via git diff) → `rework` → rework agent (fixes) → `closed`. `--no-review` skips to `closed`. Multi-reviewer via `--reviewer`, iterative rounds via `--review-rounds`. Details in `prompts/review.ts`.

**Agent signals**: XML tags in agent output: `<task-complete>`, `<task-blocked>`, `<task-report>`, `<review-report>`, `<prd-ready>`. Parsed by regex in `drivers/types.ts`. Blocked takes priority over complete. Expand/complexity agents use structured JSON output instead of XML signals.

**Agent drivers**: Strategy pattern — `AgentDriver` with `ClaudeDriver`, `OpenCodeDriver`, `CcsDriver`, and `CodexDriver`. Both batch (`runSession`) and interactive chat (`startChat/sendMessage/replyQuestion/abortChat`). Selected via `--agent claude|opencode|ccs|codex`.

**Commit strategy**: agent commits own code; prorab auto-commits uncommitted work (excluding `.taskmaster/`); prorab separately commits `.taskmaster/` changes.

**Git safety**: all git calls use `execFileSync` (no shell) to prevent command injection.

**Port allocation**: never hardcode port 3000. Use `findFreePort()` from `core/net-utils.ts` or `listen({ port: 0 })` in tests.

**Verbosity**: `quiet | info | debug | trace` via `Verbosity` type. `--debug` = full assistant text. `--trace` = full prompts. `--quiet` = no SDK output.

**Retry**: on "no signal", task resets to pending, previous report passed as context. SDK errors stop immediately. `--max-retries` configurable.

**SIGINT**: aborts current SDK session, task stays `in-progress` for resumption.

**Expand (task decomposition)**: read-only agent session decomposes a task into subtasks via `prompts/expand.ts`. Agent output is strict JSON `{ subtasks: [...] }` validated by `ExpandResultSchema` (Zod). `ExpandManager` lifecycle: git preflight → SHA-256 hash snapshot → agent session → parse/validate → mutex-guarded hash verify + write → broadcast → commit. Reason codes: `EXPAND_START_REASON_CODES`, `EXPAND_FAILURE_REASON_CODES`. Details in `server.md`, UI in `frontend.md`, tests in `testing.md`.

**Batch Expand (parallel complexity + expansion)**: `BatchExpandManager` runs complexity analysis then expansion for multiple pending tasks in parallel via `SlotPool` (max-10 concurrent agent sessions). Pipeline per task: complexity agent → write `complexityScore`/`recommendedSubtasks`/`expansionPrompt` → expand agent → write subtasks → commit. WS channel `"batch-expand"` with events: `batch_expand:started`, `batch_expand:slot_update`, `batch_expand:task_update`, `batch_expand:finished`. Complexity prompt/schema in `prompts/complexity.ts`, validation in `core/complexity-validation.ts`. JSON extraction from agent output via `core/json-extract.ts`.

**Refine PRD pipeline**: `RefinePrdManager` runs sequential chat sessions (one per configured agent/model step) against `prd.md`. Each step uses chat mode (`startChat/sendMessage`) to support agent questions (Claude/OpenCode). Codex steps are fully autonomous. On completion, optionally auto-launches `ParsePrdManager` for task generation via release-then-acquire handoff. WS channel `"refine-prd"` with events: `refine-prd:started`, `refine-prd:step_started`, `refine-prd:step_finished`, `refine-prd:question`, `refine-prd:finished`. Prompt in `prompts/refine-prd.ts`. Shares `SessionCore` with parse-prd for mutual exclusivity. Extended chain: refine-prd → parse-prd → refine-tasks.

**Refine Tasks pipeline**: `RefineTasksManager` runs sequential chat sessions against `tasks.json`. Mirrors `RefinePrdManager`. Auto-launched from `ParsePrdManager` on success. Three managers share `parsePrdSessionCore` for mutual exclusivity. WS channel `"refine-tasks"` with events: `refine-tasks:started`, `refine-tasks:step_started`, `refine-tasks:step_finished`, `refine-tasks:question`, `refine-tasks:finished`. Prompt in `prompts/refine-tasks.ts`.

**Normalized session conflicts**: execute, chat, parse-prd, expand share a single file lock via `SessionCore`. Cross-type conflicts return uniform `409 { reason: "active_session" }`.

## Build Notes

**tsconfig.json** excludes `src/__tests__` — test files import from `../../ui/src/` (outside `rootDir`), valid for vitest but not `tsc`. Tests run exclusively via `vitest`.

## Tech Stack

TypeScript, Node.js 24+, `@anthropic-ai/claude-agent-sdk`, `@opencode-ai/sdk`, `@openai/codex-sdk`, `fastify`, `commander`, `zod`, `vitest`

## Modular Docs

See `.claude/rules/` for domain-specific details:
- `server.md` — ChatManager, ParsePrdManager, RefinePrdManager, RefineTasksManager, ExpandManager, BatchExpandManager, WS events, API endpoints, session lifecycle
- `drivers.md` — AgentDriver interface, Claude/OpenCode chat implementation, driver parity
- `frontend.md` — Stores, components, view-mode state machine, WS routing, project-state model, batch-expand UI, refine-tasks UI
- `testing.md` — Browser smoke harnesses, test patterns

## Design Doc

Task Master tasks.json schema reference: `docs/taskmaster-task.md`
