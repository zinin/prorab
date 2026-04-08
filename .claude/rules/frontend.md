---
paths: "ui/**/*.{ts,vue,css}"
---

# Frontend Architecture

## WebSocket Channel Routing (`composables/useWebSocket.ts`)

Early routing by channel before main exec-store switch:
1. `channel === "chat"` or `type.startsWith("chat:")` → `chatStore.handleWsEvent()`, return early
2. `channel === "parse-prd"` or `type.startsWith("parse-prd:")` → `parsePrdStore.handleWsEvent()`, return early
3. `channel === "refine-tasks"` or `type.startsWith("refine-tasks:")` → `refineTasksStore.handleWsEvent()`, return early
4. `channel === "expand"` or `type.startsWith("expand:")` → `expandStore.handleWsEvent()`, return early
5. `channel === "batch-expand"` or `type.startsWith("batch_expand:")` → `batchExpandStore.handleWsEvent()`, return early
6. Remaining events → exec-store switch

`connected` message: populates `tasksStore` with project-state flags (`hasPrd`, `hasTasksFile`, `hasValidTasks`, `hasTasksJson` alias), clears message buffers, sets `wsInitialized = true`. Initializes chatStore/parsePrdStore/expandStore/batchExpandStore from server payload when sessions present. Sets `_rehydrating` flag to prevent replay lifecycle events from overwriting server snapshot. Flag cleared on `replay:complete` sentinel.

## Project-State Model (`stores/tasks.ts`)

Four flags: `hasPrd`, `hasTasksFile`, `hasValidTasks` (primary), `hasTasksJson` (backward alias). Populated from WS `connected` and `GET /api/status`. `tasks:updated` optimistically sets `hasTasksFile`/`hasTasksJson` but NOT `hasValidTasks`. `fetchStatus()` updates all four authoritatively.

Mapping logic extracted to `composables/project-state-mapping.ts` (`applyConnectedProjectState`, `applyTasksUpdatedProjectState`).

## TaskListView View-Mode State Machine

Pure function `computeViewMode(flags: ViewModeFlags): ViewMode` in `views/task-list-view-mode.ts`. Ten modes with strict priority:

`loading` → `inline-chat` → `refine-prd-progress` → `parse-prd-progress` → `refine-tasks-progress` → `batch-expand-progress` → `error` → `task-list` → `wizard-parse-prd` → `wizard-chat`

`ViewModeFlags` excludes task-array fields — uses only boolean flags and session state strings. Template uses `v-if="viewMode === '...'"` chain. Derived: `wizardMode` maps to AgentWizard mode, `isFullscreen` for inline-chat/parse-prd-progress.

**Parse-prd outcomes**: on `success` → `fetchStatus()` + `fetchTasks()` + `clearParsePrd()`. On `failure`/`cancelled` → "Try Again" → `clearParsePrd()` → wizard reappears.

**Error state**: `hasTasksFile: true` + `hasValidTasks: false` → "Invalid tasks file" message. No regeneration button by design — manual fix required. Data-testids: `invalid-tasks-error`, `invalid-tasks-heading`, `invalid-tasks-body`.

## AgentWizard (`components/AgentWizard.vue`)

Dual-mode via `mode` prop (`'chat'`/`'parse-prd'`). Chat: textarea, "New Chat", "Start". Parse-prd: no textarea, "Generate Tasks", "Generate". `canSubmit` is mode-aware. Pure logic in `agent-wizard-logic.ts`. Data-testids: `agent-wizard`, `wizard-title`, `wizard-agent-select`, `wizard-model-select`, `wizard-variant-select`, `wizard-message-field`, `wizard-message-textarea`, `wizard-submit-button`.

## ParsePrdProgress (`components/ParsePrdProgress.vue`)

Props-driven (no direct store access): `messages`, `state`, `outcome`. Emits: `stop`, `dismiss`. Five visual states: active (green pulsing), stopping (amber pulsing), completed/success (green static), completed/failure (red static + errors + "Try Again"), completed/cancelled (amber static + "Try Again"). Pure logic in `parse-prd-progress-logic.ts`. Data-testids: `parse-prd-panel`, `parse-prd-status-text`, `parse-prd-stop-button`, `parse-prd-outcome-banner`, `parse-prd-outcome-label`, `parse-prd-outcome-errors`, `parse-prd-dismiss-button`.

## ExpandProgress (`components/ExpandProgress.vue`)

Props-driven (no direct store access): `messages`, `state`, `outcome`, `sessionInfo`. Emits: `stop`, `dismiss`. Five visual states: active (green pulsing), stopping (amber pulsing), completed/success (green static + subtask count), completed/failure (red static + errors + detail message + "Try Again"), completed/cancelled (amber static + "Try Again"). Pure logic in `expand-progress-logic.ts` — adds `isCommitFailedAfterWrite()` and `outcomeDetailMessage()` beyond ParsePrdProgress helpers. Success label distinguishes subtaskCount > 0 ("Task expanded into N subtasks") from subtaskCount === 0 ("No decomposition needed"). Special `commit_failed_after_write` warning banner. Data-testids: `expand-panel`, `expand-status-text`, `expand-stop-button`, `expand-outcome-banner`, `expand-outcome-label`, `expand-outcome-errors`, `expand-dismiss-button`. CSS prefix `exp-` (vs `pprd-` for ParsePrd).

## Parse-PRD Store (`stores/parse-prd.ts`)

State machine: `idle | active | stopping | completed`. `completed` persists outcome until cleared. Core state: `state`, `messages[]`, `sessionInfo`, `error`, `outcome`, `reason` (409 reason code).

`start(opts)` POSTs to `/api/parse-prd` — clears state; on 409 stores `error` + `reason`; no local defaults for model/variant. `stop()` DELETEs — on error restores previous state; terminal `outcome` never lost. `handleWsEvent()` processes `agent:*` (channel="parse-prd") and `parse-prd:*` events. Rehydration via `_rehydrating` flag. Mapping logic in `composables/parse-prd-state-mapping.ts`.

Message types: text, tool, tool_result, context_usage, system_prompt, task_prompt, error. IDs use `pprd-` prefix. Streaming: consecutive text merged. Buffer: MAX=1000, TRIM_TO=500.

## Refine-PRD Store (`stores/refinePrd.ts`)

State machine: `idle | active | stopping | completed`. `completed` persists outcome until cleared. Core state: `state`, `messages[]`, `sessionInfo` (steps, currentStepIndex, stepState), `error`, `outcome`, `pendingQuestion` (questionId, questions, source).

`start(opts)` POSTs to `/api/refine-prd` with steps array + parsePrdOptions for auto-launch. `stop()` DELETEs. `replyToQuestion(questionId, answers?, message?)` POSTs to `/api/refine-prd/reply`. `handleWsEvent()` processes `agent:*` (channel="refine-prd") and `refine-prd:*` events. Rehydration via `_rehydrating` flag. Mapping logic in `composables/refine-prd-state-mapping.ts`.

Message types: text, tool, tool_result, context_usage, system_prompt, task_prompt, error, question. IDs use `rprd-` prefix. Streaming: consecutive text merged. Buffer: MAX=1000, TRIM_TO=500.

## RefinePrdProgress (`components/RefinePrdProgress.vue`)

Props-driven: `messages`, `state`, `outcome`, `sessionInfo`, `contextUsage`, `pendingQuestion`. Emits: `stop`, `dismiss`, `reply`. Step indicator shows current step agent/model. Question block uses `AskUserQuestion` for structured options, `Textarea` for free-text. Auto-scroll via deep watch. Pure logic in `refine-prd-progress-logic.ts`. CSS prefix `rprd-`.

## RefineTasksProgress (`components/RefineTasksProgress.vue`)

Props-driven: `messages`, `state`, `outcome`, `sessionInfo`, `contextUsage`, `pendingQuestion`. Emits: `stop`, `dismiss`, `reply`. Mirrors `RefinePrdProgress` — step indicator shows current step agent/model, question block uses `AskUserQuestion` for structured options, `Textarea` for free-text. Auto-scroll via deep watch. Pure logic in `refine-tasks-progress-logic.ts`. CSS prefix `rtsk-`.

## AgentWizard Refine Section

When `mode="parse-prd"`, shows collapsible "Refine PRD before generating" section with step chain constructor. Each step: agent dropdown + model input + reorder/remove buttons. Non-empty steps emit `refinePrdSteps` in start config. TaskListView routes to `refinePrdStore.start()` when present, falling through to `parsePrdStore.start()` when empty.

## AgentWizard Refine Tasks Section

When `mode="parse-prd"`, shows collapsible "Refine Tasks after generating" section with step chain constructor (mirrors the refine-prd step chain). Non-empty steps emit `refineTasksSteps` in start config. Passed through parse-prd options to `RefineTasksManager` auto-launch chain.

## Refine-Tasks Store (`stores/refineTasks.ts`)

State machine: `idle | active | stopping | completed`. `completed` persists outcome until cleared. Core state: `state`, `messages[]`, `sessionInfo` (steps, currentStepIndex, stepState), `error`, `outcome`, `pendingQuestion` (questionId, questions, source).

`start(opts)` POSTs to `/api/refine-tasks` with steps array. `stop()` DELETEs. `replyToQuestion(questionId, answers?, message?)` POSTs to `/api/refine-tasks/reply`. `handleWsEvent()` processes `agent:*` (channel="refine-tasks") and `refine-tasks:*` events. Rehydration via `_rehydrating` flag. Mapping logic in `composables/refine-tasks-state-mapping.ts`.

Message types: text, tool, tool_result, context_usage, system_prompt, task_prompt, error, question. IDs use `rtsk-` prefix. Streaming: consecutive text merged. Buffer: MAX=1000, TRIM_TO=500.

## Expand Store (`stores/expand.ts`)

State machine: `idle | active | stopping | completed`. `completed` persists outcome until cleared. Core state: `state`, `messages[]`, `sessionInfo` (includes `taskId`, `sessionId`), `error`, `outcome`, `reason` (409 reason code).

`start(taskId, opts)` POSTs to `/api/tasks/:taskId/expand` — clears state; on 409 stores `error` + `reason`; no local defaults for model/variant. `stop(taskId)` DELETEs `/api/tasks/:taskId/expand` — on error restores previous state; terminal `outcome` never lost. `handleWsEvent()` processes `agent:*` (channel="expand") and `expand:*` events. Rehydration via `_rehydrating` flag. Mapping logic in `composables/expand-state-mapping.ts`.

Expand outcomes carry `taskId` and `subtaskCount` (unlike ParsePrdOutcome). Failure outcomes also carry `reason`, `errors`, `message`. Computed getters: `isActive`, `isStopping`, `isCompleted`, `isRunning` (active or stopping — used for conflict detection instead of `hasSession` which includes terminal `completed`), `hasOutcome`, `isFileWritingOutcome` (success + subtaskCount > 0), `belongsToTask(taskId)`.

Message types: text, tool, tool_result, context_usage, system_prompt, task_prompt, error. IDs use `exp-` prefix. Streaming: consecutive text merged. Buffer: MAX=1000, TRIM_TO=500.

## Expand in TaskDetailView (`views/TaskDetailView.vue`)

Expand button visible when `task.status === "pending"` and no subtasks; disabled when form dirty, saving, or conflicting session active. PrimeVue `Dialog` with agent/model/variant fields following `AgentWizard` patterns (reuses `createModelsFetcher`, `computeVariantOptions`). Persisted launch defaults via `usePersistedRef("prorab:expandLaunchDefaults", ...)`.

**Auto-refresh**: watches `expandStore.outcome`, reloads task when `shouldReloadAfterExpand(outcome, taskId)` is true — success with `subtaskCount > 0` or `commit_failed_after_write`. Guards: taskId match, dedup via `lastReloadedOutcomeRef`, no-op skip. Warning toast for `commit_failed_after_write`.

**Launch helpers** (`composables/expand-launch-helpers.ts`): `canShowExpandButton`, `isExpandDisabled`, `hasConflictingSession`, `expandDisabledTooltip`, `shouldReloadAfterExpand`, `startReasonDisplayText`. All pure functions for testability.

## Batch Expand Store (`stores/batchExpand.ts`)

State machine: `idle | active | stopping | finished`. Manages parallel complexity + expansion for all eligible pending tasks. Core state: `state`, `slots[]` (SlotState per concurrent worker), `summary[]` (TaskSummary per task), `progress` (completed, total, errors, skipped), `outcome` (BatchExpandOutcome), `messages` (per-slot message buffers keyed by slotIndex).

`start(opts)` POSTs to `/api/batch-expand`. `stop()` DELETEs. `dismiss()` POSTs `/api/batch-expand/dismiss` to clear finished state. `handleWsEvent()` routes `batch_expand:*` and slot-level `agent:*` events (using `slotIndex`/`taskId`/`phase` fields). Rehydration from `connected` message via `batchExpand` payload.

## BatchExpandProgress (`components/BatchExpandProgress.vue`)

Multi-slot progress UI for batch expand operations. Props-driven: `state`, `slots`, `summary`, `progress`, `outcome`, `messages`. Emits: `stop`, `dismiss`. Shows per-slot agent output tabs, task progress table, and aggregate statistics. Pure logic in `batch-expand-progress-logic.ts`.

**Launch helpers** (`composables/batch-expand-launch-helpers.ts`): Pure functions for gating batch-expand launch from TaskListView.

## SubtaskDetailView (`views/SubtaskDetailView.vue`)

Detail view for individual subtasks (parallel to TaskDetailView for parent tasks).

## Shared Components

- `ReportSection` — reusable report rendering component used in task/subtask detail views
- `TaskContextPanel` — displays task context information (dependencies, related tasks)

## Shared Constants (`constants/prompts.ts`)

Shared prompt templates used across components. Has co-located test file `prompts.test.ts`.

## Navbar (`App.vue`)

Three nav links: Tasks (`/`), Execution (`/execution`) with green dot + iteration badge, Chat (`/chat`) with purple dot when active. Visibility gated on `tasksStore.wsInitialized && tasksStore.hasTasksFile`. Connection status right-aligned.

## Chat Components

- `ChatMessageItem` — pure formatting in `chat-message-logic.ts` (truncate, parseContextUsage, formatContextUsage, formatAnswers)
- `AskUserQuestion` — pure validation in `ask-question-logic.ts` (isAllAnswered, assembleAnswers)
- `AgentChatPanel` — main chat UI with terminal-dark theme from `assets/chat.css`
