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

### OpenCodeDriver

- Extend `OpenCodeContext` with `maxTurns: number` populated from `opts.maxTurns` in `createContext`.
- In `handleStepFinish` (`src/core/drivers/opencode.ts`), after `ctx.numTurns++`, add:
  ```
  if (ctx.maxTurns && ctx.numTurns >= ctx.maxTurns) {
    client.session.abort({ sessionID: ctx.sessionId }).catch(() => {});
    ctx.errorResult = errorResult(`Max turns exceeded (${ctx.maxTurns})`);
  }
  ```
- The main `for await` loop in `runSession` already returns `ctx.errorResult` on next iteration, so no further changes to the loop are required.
- `maxTurns === 0` (or absent) is treated as "no limit" — `ctx.maxTurns &&` guard short-circuits.

### CodexDriver

- A single `thread.runStreamed(prompt)` is one Codex `turn`; the existing `numTurns: 1` hardcode in `IterationResult` is replaced with the actual tool-call count.
- Introduce local `toolCalls: number` in `runSession`, incremented on `item.completed` when `item.type ∈ {command_execution, file_change, mcp_tool_call, web_search}`. Other item types (`agent_message`, `reasoning`) are deliberately **not** counted — see "Why not count all items".
- When `toolCalls >= opts.maxTurns` (and `maxTurns > 0`):
  ```
  const err = new Error(`Max turns exceeded (${opts.maxTurns})`);
  err.name = "MaxTurnsExceeded";
  opts.abortController.abort(err);
  ```
- In the existing `catch` block, before returning the generic error result, check the abort reason:
  - If `signal.reason instanceof Error && signal.reason.name === "MaxTurnsExceeded"` → return `{ signal: { type: "error", message: err.message }, ... }`.
  - Otherwise → existing behavior (treat as external abort).
- Replace the final `numTurns: 1` literal with `numTurns: Math.max(1, toolCalls)`. Preserves the pre-existing invariant that a completed session reports at least one turn (some downstream reporter code paths assume `numTurns >= 1`), while actual tool-call-heavy sessions now report a useful number.

**Why not count all items.** Reasoning-heavy models (e.g. `gpt-5.4-xhigh`) emit 2–3× reasoning items per tool call. Counting them would make a default of 100 too tight and would vary across models. Tool-call count is both the natural failure unit (the Kimi K2 incident) and the closest semantic match to Claude's `maxTurns` (one assistant turn ≈ one tool-use round).

### CcsDriver

No changes. `runSession` delegates to `ClaudeDriver.runSession`, which already honors `maxTurns` via the Agent SDK's native `maxTurns` option.

### ClaudeDriver

No changes. Already passes `opts.maxTurns` into `query({ maxTurns })`.

## `reviewMaxTurns` wiring

### Types

- `src/types.ts` `RunOptions`: add `reviewMaxTurns: number` (required).
- `src/server/execution-manager.ts` `ExecutionOptions`: add `reviewMaxTurns: number`.

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

- Move/add `REVIEW MAX TURNS` (number input, min=1, default=100) into the `REVIEWERS` block, next to the `Review enabled` checkbox and the rounds counter. Rationale: it is a reviewer-specific limit, co-located with related controls.
- `ui/src/stores/execution.ts`: add `reviewMaxTurns` to state with default 100, persisted via `usePersistedRef` like other numeric settings.
- `ui/src/composables/useSessionDefaults.ts`: add `reviewMaxTurns: 100`.
- Payload sent on Start must include `reviewMaxTurns`.

### Turns indicator

A live progress indicator parallel to the existing `CONTEXT n / N ▇▇▇ p%` block, shown in the execution header:

```
TURNS 34 / 100 ▇▇ 34%
```

- Source: new WS event `agent:turn_count`, emitted per step-finish (OpenCode) / per counted `item.completed` (Codex) / per Claude SDK assistant message.
- Event payload: `{ numTurns: number, maxTurns: number, model: string, unitId: string }`.
- Handled in `server/ws.ts` like other agent events; routed to the per-execution channel.
- UI reads the last `agent:turn_count` for the active reviewer tab and renders the progress bar.

**Why a dedicated event.** `agent:context_usage` already exists; overloading it with `numTurns` would muddle semantics and complicate tests. A dedicated event is cheap, mirrors the existing pattern, and is trivially tested.

## Failure behavior

On `maxTurns` breach the driver emits:

```
{ signal: { type: "error", message: "Max turns exceeded (N)" }, ... }
```

`run.ts` handles this via the standard retry loop (`--max-retries`, default 3). If retries are exhausted, the task follows the existing max-retries path (status unchanged; commit message records the failure). This keeps all new behavior inside one well-tested code path.

Retry rationale: OpenCode/Codex sessions are not fully deterministic (SSE ordering, tool-selection randomness), so a fresh session may escape a cycle that the previous one fell into. For review specifically, the multi-round feature (`--review-rounds`) also provides recovery if retries do not help.

## Edge cases

- `maxTurns === 0` or absent: treated as "no limit" (explicit `maxTurns &&` guard). The Zod schema enforces positive, so in practice this only matters for defensive programming.
- Off-by-one: comparison is `>=`, so `N` turns complete successfully and the `(N+1)`-th turn is not started.
- Race between our abort and external SIGINT in Codex: disambiguated by `AbortSignal.reason.name === "MaxTurnsExceeded"`. External abort keeps existing semantics.
- Race in OpenCode between `session.abort` HTTP call and the SSE `session.idle`/`session.error` arriving naturally: `ctx.errorResult` is checked before every loop iteration; the abort call is fire-and-forget. Double-termination is harmless.
- Unknown future Codex `item` types: whitelist-based counter conservatively excludes them, preventing spurious limit hits when the SDK evolves.

## Testing

### Driver units

- `src/__tests__/opencode-max-turns.test.ts`: mock SSE stream with N `step-finish` events.
  - `N < maxTurns` → normal completion via `session.idle`.
  - `N === maxTurns` → `client.session.abort` called, result `signal.type === "error"`, message matches `/Max turns exceeded/`.
  - `maxTurns === 0` → no abort, session runs to completion.
- `src/__tests__/codex-max-turns.test.ts`: mock `runStreamed` yielding a mix of `reasoning`, `agent_message`, and tool-call `item.completed` events.
  - Only tool-call types increment the counter.
  - On breach, `abortController.abort` is called with a `MaxTurnsExceeded` named error; result `signal.type === "error"`.
  - External abort (different reason) returns the standard aborted-result path unchanged.
  - `numTurns` in the returned `IterationResult` equals the tool-call counter.

### Integration

- Extend `src/__tests__/execute-review-rework.test.ts`: case where a review session hits `reviewMaxTurns`, returns `signal: error`, retry fires, second attempt succeeds.

### Server route

- `src/__tests__/execution-route.test.ts` (or equivalent): `reviewMaxTurns` defaults to 100, rejects non-positive, rejects non-integer.

### UI

- Store test: `reviewMaxTurns` default is 100 and persists across page reload.
- Component test: `REVIEW MAX TURNS` input rendered inside the `REVIEWERS` block, bound to the store.
- Turns indicator renders `TURNS n / N p%` given a mock `agent:turn_count` event.

### WS

- Extend `src/__tests__/ws-channel-routing.test.ts`: `agent:turn_count` is routed to the per-execution channel like other `agent:*` events.

No new E2E tests against real OpenCode/Codex binaries — unit coverage is sufficient and avoids flakiness.

## Risks

- Default `reviewMaxTurns = 100` may be too tight for complex diffs on strong models. Mitigation: the field is user-overridable via CLI and UI; if false positives appear, raise the default.
- Codex item-type whitelist could drift if the SDK introduces a new tool-call variant. Mitigation: whitelist is conservative (preferable to miss a counted tool call than to miscount). A small follow-up issue will track SDK upgrades.
- Adding a new WS event requires frontend and tests in sync; if the UI deploys without it, the indicator silently stays at 0/N, which is non-destructive.

## Rollout

Single PR on feature branch `max-turns-enforcement`. No migrations, no persisted state changes. Default `reviewMaxTurns = 100` applies on first start after deploy.
