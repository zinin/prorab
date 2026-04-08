---
paths: "src/core/drivers/**/*.ts"
---

# Agent Drivers

## AgentDriver Interface

Strategy pattern with `ClaudeDriver` and `OpenCodeDriver`. Defines both batch (`runSession`) and interactive chat methods (`startChat`, `sendMessage`, `replyQuestion`, `abortChat`). Selected via `--agent claude|opencode`. Optional `--model` and `--variant` flags. OpenCode requires local server (`opencode serve`) started per iteration via setup/teardown. Context window limits in `context-window.ts`.

## Interactive Chat Types

Defined in `drivers/types.ts`: `ChatOptions`, `ChatEvent`, `QuestionData`, `QuestionAnswers`. `startChat()` returns `AsyncIterable<ChatEvent>` — streaming event source. Messages via `sendMessage()`, questions via `replyQuestion()`.

## ClaudeDriver Chat

`startChat()` eagerly initializes chat state (queues, AbortController) and starts SDK `query()` with `permissionMode: 'default'` and `canUseTool` callback. Callback auto-approves all tools except `AskUserQuestion`, which is intercepted via internal event bridge (`chatEventQueue`) — publishes `question` ChatEvent and awaits Promise that `replyQuestion()` resolves.

On abort, `canUseTool` catches rejection and returns `{ behavior: "allow" }` instead of throwing — prevents SDK unhandled rejections during `handleControlRequest` → `write` sequence.

Outer stream merges SDK event stream and internal event bridge via `Promise.race`. Private helpers: `createCanUseTool()`, `createPromptIterable()`, `extractQuestions()`, `mergeChatStreams()`, `sdkMessageToChatEvents()`, `cleanupChat()`.

## OpenCodeDriver Chat

`startChat()` eagerly initializes chat state AND starts session setup via `setupChatSession()` — subscribes to SSE via `client.event.subscribe()`, then creates session via `client.session.create()`. SSE subscription before session creation to not miss events. `chatSetupPromise` allows `sendMessage()` to work immediately.

Returns async generator that loops over SSE events translating to `ChatEvent` via `processChatEvent()`. Does NOT send prompt automatically — first message through `sendMessage()`.

Chat state: `chatSessionId`, `pendingQuestions` (Map of questionId → requestID), `chatAbortController`, `chatOptions`, `chatReportedTools` (dedup set), `chatSetupPromise`.

SSE mapping: `question.asked` → question, `session.idle` → idle, `session.error` → error, `message.part.updated` (text/tool/step-finish) → text/tool/tool_result/context_usage, `message.part.delta` → text.

`sendMessage()` calls `client.session.promptAsync()` fire-and-forget; awaits `chatSetupPromise` if session ID not yet set. `replyQuestion()` maps questionId to OpenCode requestID via `pendingQuestions`. `abortChat()` rejects pending questions, aborts session, signals event loop; idempotent.

## Driver Parity

Both drivers produce identical `ChatEvent` sequences. Frontend is fully agent-agnostic. Key differences: Claude uses sync `AsyncQueue` → prompt iterable; OpenCode uses async `promptAsync()` with SSE. Question ID formats: Claude `q${UUID}`, OpenCode `oq-${timestamp}-${counter}`. E2E parity verified in `opencode-chat-e2e.test.ts`.

## CodexDriver

Standalone driver using `@openai/codex-sdk`. SDK spawns Codex CLI as subprocess internally — no setup/teardown needed.

**Batch**: `new Codex() → startThread() → thread.runStreamed(fullPrompt)`. System prompt prepended to user prompt with `---` separator. Always `approvalPolicy: "never"`, `sandboxMode: "danger-full-access"`, `skipGitRepoCheck: true`, `networkAccessEnabled: true`. Variant maps directly to `ModelReasoningEffort` (`low/medium/high/xhigh`). Events streamed in real-time via `for await` loop. Context usage read from session file on each `item.completed`.

**Chat**: One `Thread` per session, messages queued via `AsyncQueue<string>` for sequential processing. Each message → `thread.runStreamed()` on same thread. System prompt prepended on first message via `isFirstMessage` flag. Events mapped: `item.started` → `tool`, `item.completed` → `text`/`tool_result`, `turn.completed` → `context_usage` + `idle`, `turn.failed` → `error`. No agent-initiated questions — `replyQuestion()` is no-op. State guards: throws on double `startChat()`, throws on `sendMessage()` without session.

**Models**: Read from `~/.codex/models_cache.json` (maintained by CLI). Filter `visibility: "list"`, sort by `priority`. ENOENT returns `[]`. Context windows cached from same file. Empty results not cached by `/api/models` route.

**Auth**: SDK reads `~/.codex/auth.json` automatically (OAuth via ChatGPT subscription).
