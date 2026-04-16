# Design: Enforce `maxTurns` in OpenCode and Codex drivers + separate review limit

## Motivation

During a multi-reviewer run, a Kimi K2 reviewer (OpenCode driver) entered an infinite loop: it retried the same `npm run build` tool call dozens of times, misdiagnosing a real `ENOENT` (frontend lives in a subdirectory) as a bash-tool bug, and never stopped. The session accumulated context for hours without producing a `<review-report>` signal.

Investigation revealed the underlying defect:

- `SessionOptions.maxTurns` is declared as required and passed from `run.ts` to every session (execute, review, aggregator, rework), but honored **only by the Claude driver**.
- `OpenCodeDriver`, `CodexDriver`, and `CcsDriver` (which delegates to Claude) silently ignore the parameter.
- The CLI help text `"Max turns per task attempt (claude only; ignored for opencode)"` documents the defect as intentional.

There is no other built-in safeguard against runaway sessions besides context-window exhaustion and manual Stop.

In parallel, review sessions should not need the same turn budget as execute sessions. Code review over a git diff is a bounded task; an agent that spends 100+ tool calls reviewing is either stuck or doing the wrong thing.

## Goals

1. Make `maxTurns` an honored contract across **all** production drivers (Claude, OpenCode, Codex; CCS inherits via delegation).
2. Introduce a separate `reviewMaxTurns` limit for review and aggregator paths, defaulting to 100, user-overridable from CLI and UI.
3. Keep execute and rework on the existing `maxTurns` (default 200).
4. Surface live turn usage in the UI (`TURNS n / N` indicator) analogous to the current context-window indicator.
5. On limit breach, fail soft: emit signal `error`, reuse the existing `--max-retries` retry loop.

## Non-goals

- `maxTurns` for interactive chat sessions — `ChatOptions.maxTurns` already exists and is ignored by non-Claude drivers; fix is tracked separately.
- `maxTurns` for `parse-prd`, `expand`, `complexity`, `refine-prd`, `refine-tasks` — they will begin honoring their existing per-pipeline constants (`PARSE_PRD_MAX_TURNS`, `EXPAND_MAX_TURNS`, `COMPLEXITY_MAX_TURNS`) automatically once drivers are fixed, but prompt tuning and UX for those pipelines is out of scope.
- Detector for repeated identical tool calls — separate future work.

## Driver changes

### Shared contract

On `maxTurns` breach every driver returns:

```
{ signal: { type: "none" }, resultText: "Max turns exceeded (N)\n<original text>", ... }
```

Rationale: `run.ts` treats `signal: error` as a hard stop (execute exits, review/aggregator/rework have no per-reviewer retry loop at all). `signal: none` triggers the existing no-signal retry path (`run.ts:371`) which is exactly the fail-soft recovery we want for runaway sessions. The reason is surfaced via `resultText` so it appears in `.taskmaster/reports/…` and in UI logs, and via a dedicated driver log line (`console.error("!!! Max turns exceeded (N) — retrying !!!"`)).

Metrics (tokens, cost, duration, numTurns) are preserved: every driver builds its IterationResult from accumulated session state, not from a zeroed `errorResult(...)` stub.

A shared error class disambiguates our abort from external aborts:

```typescript
// src/core/drivers/types.ts
export class MaxTurnsExceededError extends Error {
  constructor(public readonly maxTurns: number) {
    super(`Max turns exceeded (${maxTurns})`);
    this.name = "MaxTurnsExceeded";
  }
}
```

### OpenCodeDriver

- Extend `OpenCodeContext` with `maxTurns: number` and `aborted: boolean` (both populated in `createContext` — `maxTurns` from `opts.maxTurns`, `aborted = false`).
- Add an early-return guard at the top of `handleStepFinish`: `if (ctx.aborted) return;`. Same guard at the top of `handleToolPart` and `handleTextPart` — these must not run after we have decided to abort. This prevents race-induced double-abort or stale metric updates while the abort HTTP call is in flight.
- In `handleStepFinish`, after `ctx.numTurns++` and after metric accumulation, add:
  ```typescript
  if (ctx.maxTurns && ctx.numTurns >= ctx.maxTurns && !ctx.aborted) {
    ctx.aborted = true;
    this.client?.session.abort({ sessionID: ctx.sessionId! }).catch(() => {});
    ctx.maxTurnsExceeded = true;
  }
  ```
- Add `maxTurnsExceeded: boolean` field to the context. At the end of `runSession`, if it is set, build the result via `buildIterationResult(ctx, { type: "none" })` and prepend a marker to `resultText`: `ctx.resultText = \`Max turns exceeded (${ctx.maxTurns})\\n\` + ctx.resultText` (so the report/log carries the reason). Do **not** call `errorResult(...)` — that zeroes metrics.
- Emit `agent:turn_count` only when we actually incremented; skip if `ctx.aborted === true` was set this same tick (prevents a misleading `N/N 100%` blip after abort).
- `maxTurns === 0` (or absent) is treated as "no limit" — `ctx.maxTurns &&` guard short-circuits.

### CodexDriver

- A single `thread.runStreamed(prompt)` is one Codex `turn` in SDK terms, but inside that turn the model emits many `item.completed` events. The existing `numTurns: 1` hardcode in `IterationResult` is replaced with the actual tool-call count.
- Introduce locals `toolCalls: number` and `maxTurnsExceeded: boolean` in `runSession`.
- Increment `toolCalls` on `item.completed` when `item.type ∈ {command_execution, file_change, mcp_tool_call, web_search}`. Other item types (`agent_message`, `reasoning`) are deliberately **not** counted — see "Why not count all items".
- Add a guard at the top of the event loop: `if (maxTurnsExceeded) break;`. This stops processing immediately after we decide to abort, even if the SDK yields extra events before acknowledging `abort()`.
- On limit breach (strictly `>=`):
  ```typescript
  if (opts.maxTurns && toolCalls >= opts.maxTurns && !maxTurnsExceeded) {
    maxTurnsExceeded = true;
    const err = new MaxTurnsExceededError(opts.maxTurns);
    if (opts.abortController) {
      opts.abortController.abort(err);
    }
    break; // exit the for-await loop immediately, don't wait for SDK ack
  }
  ```
- In the existing `catch` block, check `err instanceof MaxTurnsExceededError` (or the abortController's `signal.reason instanceof MaxTurnsExceededError`). If true → return `{ signal: { type: "none" }, resultText: \`Max turns exceeded (${opts.maxTurns})\\n${resultText}\`, numTurns: Math.max(1, toolCalls), ...preservedMetrics }`. Otherwise → existing behaviour (genuine error).
- If we exited via `break` instead of throwing, skip the catch entirely — fall through to a maxTurns-aware branch that returns the same `signal: none` result with preserved metrics.
- Replace the final `numTurns: 1` literal with `numTurns: Math.max(1, toolCalls)`.

**Why not count all items.** Reasoning-heavy models (e.g. `gpt-5.4-xhigh`) emit 2–3× reasoning items per tool call. Counting them would make a default of 100 too tight and would vary across models. Tool-call count is both the natural failure unit (the Kimi K2 incident) and the closest semantic match to Claude's `maxTurns` (one assistant turn ≈ one tool-use round). Pure-text infinite loops in Codex are physically impossible within one `runStreamed` — the turn ends when the model stops emitting.

### ClaudeDriver

`maxTurns` enforcement is already handled natively by the Agent SDK. What this spec adds is **live turn emission** — the SDK's `result` message gives a final `num_turns` count only at the end of the session, which is too late for the UI indicator.

- Add `numApiCalls: number` to `ClaudeContext`, start at 0.
- In `handleAssistant` (called once per assistant SDK message), increment `numApiCalls` and emit:
  ```typescript
  ctx.logger.sendToLog({
    type: "agent:turn_count",
    numTurns: ctx.numApiCalls,
    maxTurns: ctx.maxTurns,
    model: ctx.model,
    unitId: ctx.unitId,
  });
  ```
- `ctx.maxTurns` and `ctx.unitId` are populated in `createContext` from `opts.maxTurns` / `opts.unitId` (the `opts` object is not in scope inside `handleAssistant`, so both fields must live on the context).
- `agent:turn_count` is emitted **only from `runSession`**, not from `startChat`. Chat sessions have their own (non-limited) flow and their UI does not render the turns indicator.

### CcsDriver

No code changes. `runSession` and `startChat` delegate to `ClaudeDriver`, which now emits `agent:turn_count` for runSession. The CCS reviewer tab picks up the event via the same WS plumbing.

## `reviewMaxTurns` wiring

### Types

- `src/types.ts` `RunOptions`: add `reviewMaxTurns: number` (required).
- `src/server/execution-manager.ts` `ExecuteOptions`: add `reviewMaxTurns: number`.
- Because `RunOptions` is a required-field interface, every existing construction site in tests (search all `RunOptions` / `ExecuteOptions` literals in `src/__tests__/`) must be updated to include `reviewMaxTurns`. This is a one-time tsc-driven sweep.

### CLI

- `src/index.ts`: new option `--review-max-turns <number>` with default `"100"`, coerced via the same Zod pattern as `maxTurns`.
- Update `--max-turns` help text: drop `(claude only; ignored for opencode)`.

### Server route

- `src/server/routes/execution.ts`: extend the Zod body schema with `reviewMaxTurns: z.number().int().positive().default(100)`. Pass to `ExecutionOptions`.

### `run.ts` routing

| Path                            | Value passed to `runSession.maxTurns` |
| ------------------------------- | ------------------------------------- |
| Execute (src/commands/run.ts:217) | `options.maxTurns` (unchanged)      |
| Review — each reviewer (:594)   | `options.reviewMaxTurns` (new)        |
| Aggregator (:780)               | `options.reviewMaxTurns` (new)        |
| Rework (:933)                   | `options.maxTurns` (unchanged)        |

## UI

### Configuration

- Add a `REVIEW MAX TURNS` (number input, min=1, default=100) input into the `REVIEWERS` block, next to the `Add reviewer` button. Rationale: it is a reviewer-specific limit, co-located with related controls.
- `ui/src/views/ExecutionView.vue`: persist the value via `usePersistedRef("prorab:reviewMaxTurns", 100)` at the view level, next to the existing `maxTurns` ref. The execution store is cleared on every run start, so persistence must live with the form state, not in the store.
- The `startExecution` payload (both the Vue-side options interface and the actual POST body) must include `reviewMaxTurns`.
- `useSessionDefaults.ts` is **not** touched — it holds cross-session agent/model/variant defaults, not per-run numeric limits.

### Turns indicator

A live progress indicator parallel to the existing `CONTEXT n / N ▇▇▇ p%` block, shown in the execution header:

```
TURNS 34 / 100 ▇▇ 34%
```

- Source: new WS event `agent:turn_count`, emitted per step-finish (OpenCode) / per counted tool-call `item.completed` (Codex) / per `handleAssistant` call (Claude — using a local `ctx.numApiCalls` counter).
- Event payload: `{ numTurns: number, maxTurns: number, model: string, unitId: string, reviewerId?: string }`.
- Handled in `server/ws.ts` like other agent events; routed to the per-execution channel.
- UI reads the last `agent:turn_count` for the active reviewer tab and renders the progress bar.
- The store's `turnUsageByUnit` map must be reset on the same lifecycle boundaries that reset `contextUsageByUnit`: `startExecution`, `execution:multi_review_started`, `execution:reviewer_finished` (per-reviewer clear), `execution:all_done`. Without this, the header shows stale values when phases change.

**Why a dedicated event.** `agent:context_usage` already exists; overloading it with `numTurns` would muddle semantics and complicate tests. A dedicated event is cheap, mirrors the existing pattern, and is trivially tested.

## Failure behavior

On `maxTurns` breach every driver returns `IterationResult` with:

```
signal:     { type: "none" }
resultText: "Max turns exceeded (N)\n<accumulated text>"
numTurns:   <real count>
cost/tokens/duration: <preserved from session>
```

`run.ts` treats `signal: none` as "no completion signal" (line 371) and takes the existing retry branch (up to `--max-retries`, default 3). If retries are exhausted, the task follows the existing max-retries path (status unchanged; commit message records the failure). All new behaviour reuses one well-tested code path.

**Why not `signal: error`.** `run.ts:364` treats `signal: error` as an immediate hard stop — `return false`, no retry, no fallback. The review/aggregator/rework paths don't have a per-session retry loop at all. Emitting `error` would make every maxTurns breach a hard fail the first time, contradicting the fail-soft goal. Emitting `none` reuses the existing retry machinery for free.

**Why retry is worth it.** OpenCode/Codex sessions are non-deterministic (SSE ordering, tool-selection randomness), so a fresh session may escape a cycle the previous one fell into. For review specifically, the multi-round feature (`--review-rounds`) provides a second layer of recovery.

**Visibility.** The "Max turns exceeded" marker is prepended to `resultText`, so it appears in:
- `.taskmaster/reports/…` (via `appendReport`),
- the agent-output panel in the UI (the last raw text surfaces in the log),
- a driver-side `console.error` line emitted before returning the result so a CLI user sees it immediately.

## Edge cases

- `maxTurns === 0` or absent: treated as "no limit" (`ctx.maxTurns &&` guard). Zod enforces positive, so this only matters for defensive programming.
- Off-by-one: comparison is `>=`, so `N` turns complete successfully and the `(N+1)`-th turn is not started. OpenCode increments `ctx.numTurns` before the check but emits `agent:turn_count` only after; if the check decides to abort in the same tick, the `N/N` terminal emission is suppressed.
- Race in Codex between our `abort(err)` and SDK emitting further events before the abort lands: handled by the `if (maxTurnsExceeded) break;` guard at the top of the `for await` loop plus the synchronous `break` immediately after `abort()`. Final result is built outside the loop from preserved counters.
- Race in OpenCode between `session.abort` HTTP call and the SSE continuing to emit `step-finish` / `tool` / `text` events: handled by `ctx.aborted` guard at the top of `handleStepFinish` / `handleToolPart` / `handleTextPart`. Post-abort events are ignored.
- External SIGINT in Codex (user `abortController.abort()` with a different reason or no reason): `err instanceof MaxTurnsExceededError` check cleanly separates our abort from the user's. External abort keeps the existing error-result path.
- Unknown future Codex `item` types: whitelist-based counter conservatively excludes them, preventing spurious limit hits when the SDK evolves. A follow-up issue will track the whitelist.
- Cross-driver "turn" semantics divergence: OpenCode counts LLM steps (one `step-finish` per API call — may include several tool uses), Codex counts tool-call items, Claude counts assistant SDK messages. The same `maxTurns = N` therefore represents slightly different budgets, but intent (cap runaway work) is identical. Documented in the CLI help text and in Risks.

## Testing

### Driver units

- `src/__tests__/opencode-max-turns.test.ts`: mock SSE stream with N `step-finish` events.
  - `N < maxTurns` → normal completion via `session.idle`.
  - `N === maxTurns` → `client.session.abort` called exactly once, result `signal.type === "none"`, `resultText` starts with `"Max turns exceeded (N)"`, metrics (`numTurns`, `inputTokens`, etc.) are non-zero.
  - `maxTurns === 0` → no abort, session runs to completion.
  - Post-abort events ignored: after the limit hits, further simulated SSE events don't increment counters or re-trigger abort.
- `src/__tests__/codex-max-turns.test.ts`: mock `runStreamed` yielding a mix of `reasoning`, `agent_message`, and tool-call `item.completed` events.
  - Only tool-call types increment the counter.
  - On breach, `abortController.abort` is called with a `MaxTurnsExceededError` instance; result `signal.type === "none"`, `resultText` starts with the marker, `numTurns === Math.max(1, toolCalls)`.
  - External abort (different reason / plain Error) returns the standard error-result path unchanged.
  - Extra events yielded after the break guard are not reflected in the result.
- `src/__tests__/claude-turn-count.test.ts`: verify `handleAssistant` emits `agent:turn_count` with incrementing `numTurns`, that `maxTurns` field matches `opts.maxTurns`, and that `startChat` does NOT emit the event.

### Integration

- Extend `src/__tests__/execute-review-rework.test.ts`:
  - Reviewer path: mock driver returns `signal: none, resultText: "Max turns exceeded (100)\n..."`. Verify retry fires (via `runSession` call count) and the second attempt's `runSession` receives `maxTurns === options.reviewMaxTurns`.
  - Aggregator path: analogous case for the aggregator step.
  - Rework path: analogous case, but `runSession` should receive `options.maxTurns` (not `reviewMaxTurns`).
  - Execute path: analogous case for a single executeUnit. Verify max-retries is honoured and task stays in-progress after exhaustion.

### Server route

- `src/__tests__/execution-route.test.ts` (or equivalent): `reviewMaxTurns` defaults to 100, rejects non-positive, rejects non-integer.

### UI

- Store test: `turnUsageByUnit` is populated by `updateTurnUsage`, cleared on `startExecution` and on phase-transition events.
- View test: `REVIEW MAX TURNS` input is rendered inside the `REVIEWERS` block, bound to a persisted ref, and its value is included in the `startExecution` payload.
- Turns indicator renders `TURNS n / N p%` given a mock `agent:turn_count` event; hides the progress bar when `maxTurns === 0` and renders `TURNS n` only.

### WS

- Extend `src/__tests__/ws-channel-routing.test.ts`: `agent:turn_count` without explicit `channel` is routed to the `"execute"` channel like other `agent:*` events, and preserves `reviewerId`.

No new E2E tests against real OpenCode/Codex binaries — unit coverage is sufficient and avoids flakiness.

## Risks

- Default `reviewMaxTurns = 100` may be too tight for complex diffs on strong models. Mitigation: the field is user-overridable via CLI and UI; if false positives appear, raise the default.
- Codex item-type whitelist could drift if the SDK introduces a new tool-call variant. Mitigation: whitelist is conservative (preferable to miss a counted tool call than to miscount). A follow-up issue will track SDK upgrades.
- Adding a new WS event requires frontend and tests in sync; if the UI deploys without it, the indicator silently stays at 0/N, which is non-destructive. Unknown WS event types are already silently ignored by the existing switch-case dispatcher, so old UIs don't break.
- Cross-driver "turn" semantics differ (OpenCode step-finish, Codex tool-call, Claude SDK assistant-message). A single `maxTurns = 100` represents different budgets across drivers. Mitigation: documented in CLI help and here; intent (cap runaway work) is the same across all three. Normalizing later is a follow-up if it becomes a practical problem.
- Signal transition from `error` to `none` on breach means the failure is quieter in logs (no `!!! AGENT ERROR !!!`). Mitigation: drivers print `!!! Max turns exceeded (N) — retrying !!!` explicitly, and the marker is prepended to `resultText` so it appears in reports and UI.

## Rollout

Single PR on feature branch `max-turns-enforcement`. No migrations, no persisted state changes. Default `reviewMaxTurns = 100` applies on first start after deploy.
