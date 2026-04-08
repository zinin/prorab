---
paths: "src/server/**/*.ts, src/commands/serve.ts"
---

# Server Architecture

## ChatManager (`server/chat-manager.ts`)

Single point of semantic translation from internal `ChatEvent` (driver) to public `WsEvent` (WebSocket). All events broadcast via `WsBroadcaster.broadcastWithChannel(event, "chat")`.

**Event mapping**: `text` → `agent:text` (appended to per-turn buffer), `tool` → `agent:tool`, `tool_result` → `agent:tool_result`, `context_usage` → `agent:context_usage`, `question` → `chat:question`, `idle` → `chat:idle`, `error` → `chat:error`, `finished` → `chat:finished`. `question_answer` is not broadcast (local only).

**State transitions**: `question` sets `state=question_pending`, `pendingQuestionId`, `awaitingUserInput=false`; `idle` restores `state=active`, clears `pendingQuestionId`, sets `awaitingUserInput=true`. On error/finished, `consumeChatStream()` performs cleanup and terminates with `chat:finished`; `chat:error` always precedes `chat:finished`.

**Cleanup**: centralized in private `cleanup()` method (teardown driver, release session lock, reset state, reset turn buffer and auto-finish guard). Invoked from three paths: `consumeChatStream()` finally block, `stop()` after abort, and `start()` catch block on setup failure. Session ownership token prevents stale finally blocks from destroying new sessions. `chatFinishedSent` one-shot guard prevents duplicate `chat:finished` broadcasts.

**Auto-finish**: maintains per-turn `turnBuffer` accumulating `text` ChatEvent content. At each turn boundary (`idle` event), checks via `parsePrdReadySignal()` for terminal `<prd-ready>true</prd-ready>`. When detected: marks session non-interactive (`state="stopping"`, `awaitingUserInput=false`), returns `false` from `handleChatEvent()` to terminate stream gracefully. Three guards: `autoFinishFired` (one-shot), `chatFinishedSent` (one-shot), session ownership token. Test-only accessors: `_getTurnBuffer()`, `_isAutoFinishFired()`.

## ParsePrdManager (`server/parse-prd-manager.ts`)

Manages parse-prd batch agent sessions: `start → stream → terminal outcome → cleanup`. Follows ChatManager architecture (own `SessionCore`, own session record, `DriverRunner`) but without question-flow and without server defaults for `model`/`variant`.

Uses batch `runSession()` (not interactive `startChat()`) with prompts from `prompts/parse-prd.ts`. Streams `agent:*` events through channel `"parse-prd"`. Terminal outcome: `ParsePrdManagerOutcome` — `success` (agent completed AND post-validation passed), `failure` (agent blocked/errored/validation failed, includes `errors[]`), `cancelled` (user stopped/abort). Simple stream completion is NOT treated as success — post-validation always required.

State: `ParsePrdState = "idle" | "active" | "stopping"`. `start(opts)` validates idle, acquires lock, creates DriverRunner, broadcasts `parse-prd:started`, launches `runParsePrdSession()` fire-and-forget. `stop()` aborts via `SessionCore.abort()`, broadcasts `parse-prd:finished` with `cancelled`. Background session guarded by session ownership token and `finishedSent` one-shot guard.

Abort handler: per-session `AbortController` registered with `SessionCore.registerAbortHandler()` — propagates to running agent session, preventing orphaned processes. Error class: `ParsePrdSessionActiveError`.

## Chat WebSocket Event Types

Typed interfaces in `types.ts`: `ChatStartedEvent`, `ChatQuestionEvent`, `ChatIdleEvent`, `ChatErrorEvent`, `ChatFinishedEvent` — each with `channel: "chat"`. Combined into `ChatWsEvent` discriminated union.

Parse-prd lifecycle events: `ParsePrdStartedEvent`, `ParsePrdErrorEvent`, `ParsePrdFinishedEvent` — each with `channel: "parse-prd"`. `ParsePrdFinishedEvent` carries `ParsePrdManagerOutcome`. Combined into `ParsePrdWsEvent` union. `ParsePrdManagerOutcome` defined in `types.ts`, re-exported from `parse-prd-manager.ts`.

`LogEvent` has optional `channel?: WsChannel` for backward compatibility. `applyDefaultChannel()` in `ws.ts` adds `channel: 'execute'` to `agent:*` events without a channel. `WsChannel = "chat" | "execute" | "parse-prd" | "expand" | "batch-expand"` defined in `types.ts`. `LogEvent` also carries optional `slotIndex`, `taskId`, `phase` fields for batch-expand multi-slot routing.

WS state providers: `ChatStateProvider`/`ParsePrdStateProvider`/`BatchExpandStateProvider` interfaces + setters in `ws.ts`. `serve.ts` wires managers so `connected` message includes `chatSession`, `parsePrdSession`/`parsePrdOutcome`, and batch-expand state.

## Execution API (`routes/execution.ts`)

- `POST /api/execute` — starts execution; body: `{ agent, model?, variant?, review?, reviewRounds?, reviewer?, maxIterations?, quiet? }`; 409 if active session
- `DELETE /api/execute` — hard stop; always 200
- `GET /api/execute` — returns `{ state, currentUnit, iterationCurrent, iterationTotal }`
- `POST /api/execute/graceful-stop` — request graceful stop; 409 if not running or already active
- `DELETE /api/execute/graceful-stop` — cancel graceful stop; 409 if not running or not active

**Graceful stop**: `ExecutionManager._gracefulStop` boolean flag checked in `executeLoop()` while condition alongside `isActive()`. When true and current iteration finishes, loop exits and broadcasts `execution:all_done` (only if session still active — hard stop takes precedence). Flag reset in `start()` init, `start()` finally block. `requestGracefulStop()`/`cancelGracefulStop()` broadcast `execution:graceful_stop` with `{ enabled: boolean }` on `"execute"` channel.

**Execution WS events** (channel `"execute"`): `execution:state` (state changes), `execution:unit` (current unit), `execution:iteration` (iteration progress), `execution:all_done` (all tasks complete or graceful stop), `execution:graceful_stop` `{ enabled: boolean }` (graceful stop toggled). `connected` message includes `gracefulStop: boolean` for rehydration.

## Chat API (`routes/chat.ts`)

Zod schemas: `StartChatBodySchema` (agent, model?, variant?, systemPrompt?), `MessageBodySchema` (text min 1), `ReplyQuestionBodySchema` (answers as `Record<string, string | string[]>`).

- `POST /api/chat/start` — creates session (409 if active, 400 on invalid body)
- `POST /api/chat/message` — sends user message (400 if not awaiting input)
- `POST /api/chat/question/:id/reply` — replies to pending question (400 on ID mismatch)
- `DELETE /api/chat` — stops session (always 200, no-op if idle)
- `GET /api/chat` — returns `{state, session}`

## Parse-PRD API (`routes/parse-prd.ts`)

Zod schema: `StartParsePrdBodySchema` (agent, model?, variant?) — no `systemPrompt`, no server defaults.

- `POST /api/parse-prd` — starts session; 409 reasons: `prd_missing`, `tasks_file_exists`, `active_session`
- `DELETE /api/parse-prd` — stops session; 409 reason: `no_active_session`

Preconditions checked via `getProjectState()`. `ParsePrdConflictReason` enumerates all reason codes.

## Refine-PRD API (`routes/refine-prd.ts`)

- `POST /api/refine-prd` — start pipeline; body: `{ steps: [{ agent, model?, variant? }], verbosity?, responseLanguage?, parsePrdOptions? }`; max 20 steps; 409 reasons: `active_session`, `prd_missing`
- `DELETE /api/refine-prd` — stop pipeline; 409: `no_active_session`
- `POST /api/refine-prd/reply` — reply to agent question; discriminated union: `{ questionId, answers }` or `{ questionId, message }`; 409: `no_pending_question`; 400: `question_mismatch`

Preconditions checked via `isAnySessionActive()` + `isBatchExpandActive()` + `getProjectState()`.

## RefinePrdManager (`server/refine-prd-manager.ts`)

Sequential multi-agent chat pipeline for PRD refinement. Shares `SessionCore` with `ParsePrdManager` (mutual exclusivity via shared lock).

State: `RefinePrdState = "idle" | "active" | "stopping"`. Session tracks `steps[]`, `currentStepIndex`, `stepState` (running/question_pending), `pendingQuestionData` for rehydration.

Each step: `DriverRunner` → `startChat()` → consume `ChatEvent` stream → `parseSignal()` for completion detection → teardown → commit PRD changes via `core/git.ts`. Question handling: Claude/OpenCode emit structured `question` ChatEvent; Codex is fully autonomous (no questions).

Stop pattern: `stop()` only calls `sessionCore.abort()` + `driver.abortChat()`. Cleanup exclusively in `runPipeline()` finally block (prevents double-cleanup race). Auto-launch parse-prd: release-then-acquire after cleanup. Failed auto-launch broadcasts `refine-prd:error` (non-fatal).

Error classes: `RefinePrdSessionActiveError`, `RefinePrdNotReadyError`, `RefinePrdQuestionMismatchError`.

## Refine-Tasks API (`routes/refine-tasks.ts`)

- `POST /api/refine-tasks` — start pipeline; body: `{ steps: [{ agent, model?, variant? }], verbosity?, responseLanguage? }`; max 20 steps; 409 reasons: `active_session`, `tasks_file_missing`, `tasks_file_invalid`
- `DELETE /api/refine-tasks` — stop pipeline; 409: `no_active_session`
- `POST /api/refine-tasks/reply` — reply to agent question; discriminated union: `{ questionId, answers }` or `{ questionId, message }`; 409: `no_pending_question`; 400: `question_mismatch`

Preconditions checked via `isAnySessionActive()` + `isBatchExpandActive()` + `getProjectState()`.

## RefineTasksManager (`server/refine-tasks-manager.ts`)

Sequential multi-agent chat pipeline for tasks.json refinement. Mirrors `RefinePrdManager` — bugs found in one likely apply to both. Shares `SessionCore` with `ParsePrdManager` and `RefinePrdManager` (mutual exclusivity via shared `parsePrdSessionCore` lock).

State: `RefineTasksState = "idle" | "active" | "stopping"`. Session tracks `steps[]`, `currentStepIndex`, `stepState` (running/question_pending), `pendingQuestionData` for rehydration.

Each step: `DriverRunner` → `startChat()` → consume `ChatEvent` stream → `parseSignal()` for completion detection → teardown → commit tasks.json changes via `core/git.ts`. Question handling: Claude/OpenCode emit structured `question` ChatEvent; Codex is fully autonomous (no questions).

Stop pattern: `stop()` only calls `sessionCore.abort()` + `driver.abortChat()`. Cleanup exclusively in `runPipeline()` finally block (prevents double-cleanup race).

Auto-launch from ParsePrdManager: on successful parse-prd outcome, ParsePrdManager triggers RefineTasksManager via release-then-acquire handoff (same pattern as refine-prd → parse-prd chain).

WS channel `"refine-tasks"` with events: `refine-tasks:started`, `refine-tasks:step_started`, `refine-tasks:step_finished`, `refine-tasks:question`, `refine-tasks:finished`.

Error classes: `RefineTasksSessionActiveError`, `RefineTasksNotReadyError`, `RefineTasksQuestionMismatchError`.

## Parse-PRD Validation (`core/validate-parse-prd.ts`)

Server-side validation of `tasks.json` produced by parse-prd agent. Three layers: `validateParsePrdResult(parsed)` (pure logic, no I/O), `validateParsePrdFile(cwd)` (reads file + delegates), `getParsePrdOutcome(cwd)` (returns `ParsePrdOutcome` union: success or failure with errors).

Criteria: standard `{ tasks, metadata }` format only (multi-tag rejected); at least one task; all `status: "pending"`; all `subtasks: []`; non-empty `id` and `title`; dependencies reference existing IDs. Applies `nullsToUndefined()` before Zod parsing.

## Parse-PRD Prompt (`prompts/parse-prd.ts`)

Instructs agent to read `.taskmaster/docs/prd.md`, explore codebase, write `.taskmaster/tasks/tasks.json`. MVP: all tasks `status: "pending"`, all `subtasks: []`, at least one task, signal blocked if `tasks.json` exists. Fixed paths: `PRD_PATH`, `TASKS_PATH` constants.

## Project-State Helpers (`core/project-state.ts`)

`hasPrd(cwd)` — checks `.taskmaster/docs/prd.md` exists with non-whitespace content. `checkTasksFile(cwd)` — returns `{ hasTasksFile, hasValidTasks }` (three states: absent, invalid, valid). `getProjectState(cwd)` — aggregates into `ProjectState` (hasPrd, hasTasksFile, hasValidTasks). Used by `GET /api/status`, WS `connected`, parse-prd preconditions. Uses `PRD_PATH`/`TASKS_PATH` from `prompts/parse-prd.ts`.

## ExpandManager (`server/expand-manager.ts`)

Manages expand (task decomposition) batch agent sessions. Follows ParsePrdManager pattern: own `SessionCore`, `DriverRunner`, fire-and-forget batch session.

**Lifecycle**: `start(taskId, opts)` → git preflight checks (`isGitRepo`, `isTrackedByGit`, `hasGitIdentity`, `isPathDirty`) → acquire session lock → snapshot SHA-256 hash of `tasks.json` → run agent → parse/validate JSON result via `core/expand-validation.ts` → acquire `withTasksMutex` → verify hash (TOCTOU elimination) → `writeExpandSubtasks()` → `broadcastTasksUpdated()` → `commitExpandedTask()`. Empty subtasks `[]` skip write/commit entirely.

**Failure modes**: `ExpandPreflightError` carries `reason: ExpandStartReasonCode` for route-level 409 mapping. `commit_failed_after_write` — subtasks written but git commit failed, no rollback (broadcast already fired). Ownership token guards prevent stale cleanup.

**Hash conflict**: `crypto.createHash("sha256")` on raw file content (not parsed JSON) catches any mutation including whitespace changes and edits in inactive tags of multi-tag files.

**WS events**: `expand:started`, `expand:error`, `expand:finished` on `"expand"` channel. `stop(taskId)` returns `stopped | no_active_session | task_mismatch`.

## Expand API (`routes/expand.ts`)

- `POST /api/tasks/:id/expand` — start; route-level checks: `checkTasksFile()` → `tasks_file_missing`/`tasks_file_invalid` (409), task lookup → `task_not_found` (404), `status === "pending"` → `task_not_pending` (409), no subtasks → `task_has_subtasks` (409). Unmet deps do NOT block. Body: `{ agent, model?, variant? }` (strict Zod).
- `DELETE /api/tasks/:id/expand` — stop; 409: `no_active_session`, `task_mismatch`.
- `GET /api/expand` — state.

Error contract: `400` → `{ error, details }`, `404/409` → `{ error, reason, message? }`.

## Expand Validation (`core/expand-validation.ts`)

`parseExpandResult(lastMessage)` → JSON parse + Zod validation. `validateExpandResult(parsed)` → schema enforcement via `ExpandResultSchema` (`.strict()` + `.superRefine()` for sequential IDs 1..N, referential integrity, no self/forward references). Returns typed `ExpandValidationOutcome`: `ok: true` + data or `ok: false` + reason + errors[]. UI/file-independent.

## Git Helpers for Expand (`core/git.ts`)

`hasGitIdentity(cwd)` — checks `user.name` + `user.email`. `isPathDirty(filePath, cwd)` — targeted `git status --porcelain` for one path. `commitExpandedTask(cwd, taskId, subtaskCount)` — stages + commits only `tasks.json`, **throws** on failure (unlike `commitTasksJson` which silently returns false). Only `tasks.json` cleanliness matters for expand.

## Expand Write Pipeline (`core/tasks-json.ts`)

`writeExpandSubtasks(cwd, taskId, subtasks)` uses `mutateTasksFile()` for atomic multi-tag-safe read-modify-write. Writes prescribed fields only (`id`, `title`, `description`, `details`, `dependencies`, `testStrategy?`, `status: "pending"`) — no `parentId`, `priority`, or auto-populated fields. Empty `subtasks: []` = no-op (file stays byte-identical).

## BatchExpandManager (`server/batch-expand-manager.ts`)

Orchestrates parallel complexity analysis + task expansion for all eligible pending tasks. State machine: `idle → active → (stopping) → finished`.

**Architecture**: Uses `SlotPool` (from `core/slot-pool.ts`) with max-10 concurrent agent sessions. Each slot processes tasks sequentially from a shared queue. Stable slot indices enable UI tab binding.

**Per-task pipeline**: complexity agent → `writeComplexityFields()` + `commitComplexityFields()` → check `recommendedSubtasks` (skip expand if 0) → expand agent → `writeExpandSubtasks()` + `commitExpandedTask()`. Both writes inside `withTasksMutex()`. Expand phase re-reads task to get updated complexity fields.

**Lifecycle**: `start(opts)` → git preflight → `acquireLock()` → read eligible tasks (pending, no subtasks, `recommendedSubtasks !== 0`) → create SlotPool → fire-and-forget `runPool()`. Returns `null` if no eligible tasks. `stop()` calls `pool.abort()`. `dismiss()` resets finished state for clean reconnect. `waitForFinished()` for SIGINT handler.

**WS events** (channel `"batch-expand"`): `batch_expand:started` (taskIds, slotCount, taskTitles), `batch_expand:slot_started` (slotIndex, taskId, phase), `batch_expand:complexity_done` (score, recommendedSubtasks), `batch_expand:slot_finished` (subtaskCount, skipped), `batch_expand:progress` (completed, total, errors, skipped), `batch_expand:error` (per-task or pool-level), `batch_expand:finished` (BatchExpandOutcome). Agent `agent:*` events carry `slotIndex`, `taskId`, `phase` for multi-slot routing.

**Error handling**: individual task errors are caught — slot is freed, next task proceeds. Aborted tasks (signal.aborted) don't count as errors. Pool-level crash broadcasts `batch_expand:error` with `reason: "pool_crash"`. Error classes: `BatchExpandSessionActiveError`, `BatchExpandPreflightError`.

**Complexity validation** (`core/complexity-validation.ts`): Two-layer (mirrors expand-validation). `parseComplexityResult(text)` → `ComplexityResultSchema` (complexityScore 1–10, recommendedSubtasks, expansionPrompt, reasoning). `ComplexityValidationOutcome` typed union.

**JSON extraction** (`core/json-extract.ts`): `extractJsonFromResult(text)` — string-aware brace scanner, extracts last top-level `{…}` block. Used by both complexity and expand agents in batch mode.

## Batch-Expand API (`routes/batch-expand.ts`)

- `POST /api/batch-expand` — start; preconditions: valid tasks file, no active session; body: `{ agent, model?, variant?, verbosity? }`; returns `{ started: true, taskIds, slotCount }` or `{ started: false, reason: "no_eligible_tasks" }`; 409 reasons: `tasks_file_missing`, `tasks_file_invalid`, `active_session`, `batch_active`, git preflight reasons
- `DELETE /api/batch-expand` — stop; 409: `no_active_batch`
- `POST /api/batch-expand/dismiss` — clear finished state; 409: `not_finished`
- `GET /api/batch-expand` — returns `BatchExpandFullState` (state, slots, summary, progress, outcome, taskSlotMap)

## Complexity Prompt (`prompts/complexity.ts`)

Schema: `ComplexityResultSchema` — `complexityScore` (1–10), `recommendedSubtasks` (0 = atomic), `expansionPrompt`, `reasoning`. No `.strict()` — tolerant parsing for LLM extra fields. Failure reason codes: `agent_failed`, `result_parse_failed`, `validation_failed`.

## Git Helpers for Complexity (`core/git.ts`)

`commitComplexityFields(cwd, taskId)` — stages + commits only `tasks.json` after writing complexity fields.

## Complexity Write Pipeline (`core/tasks-json.ts`)

`writeComplexityFields(cwd, taskId, fields)` — writes `complexityScore`, `recommendedSubtasks`, `expansionPrompt`, `complexityReasoning` to task via `mutateTasksFile()`.

## Server Abort Safety

`serve.ts` installs global `unhandledRejection` handler — Claude Agent SDK may emit rejections during abort flows. Expected abort-related rejections suppressed; others logged to stderr.
