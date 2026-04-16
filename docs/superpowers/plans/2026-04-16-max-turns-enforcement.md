# Max-Turns Enforcement Implementation Plan

> **Status:** All 11 tasks complete + external review iteration 2 applied. Feature ready for PR. See commits on branch `max-turns-enforcement` (`6de23c5..HEAD`).

**Goal:** Make `maxTurns` a real contract in OpenCode and Codex drivers, add a separate `reviewMaxTurns` limit (default 100) for review/aggregator paths, and surface live turn usage in the UI.

**Architecture:** Each driver runs its own per-step counter. On `numTurns >= maxTurns`, driver aborts its native session and returns `signal: none` with `"Max turns exceeded (N)\n..."` marker (preserves metrics; reuses existing `run.ts:371` no-signal retry). A new `agent:turn_count` WS event mirrors `agent:context_usage` for live UI updates. Shared `MaxTurnsExceededError` class in `src/core/drivers/types.ts` disambiguates our abort from external aborts.

**Tech Stack:** TypeScript, Node 24+, `@opencode-ai/sdk`, `@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`, Fastify, Zod, Vitest, Vue 3 + Pinia + PrimeVue.

**Spec:** `docs/superpowers/specs/2026-04-16-max-turns-enforcement-design.md`

---

## Task 1: Add `reviewMaxTurns` to `RunOptions` and `ExecuteOptions`
✅ Done — see commit(s): `ccc7905`

---

## Task 2: Add `--review-max-turns` CLI flag + update `--max-turns` help
✅ Done — see commit(s): `66a9b26`

---

## Task 3: Add `reviewMaxTurns` to the execute route Zod schema
✅ Done — see commit(s): `32ffb77`

---

## Task 4: Route `reviewMaxTurns` into review/aggregator in `run.ts`
✅ Done — see commit(s): `f7d7bd3`

---

## Task 5: Enforce `maxTurns` in `OpenCodeDriver` (+ abort on limit)
✅ Done — see commit(s): `3ddeddb`

---

## Task 6: Enforce `maxTurns` in `CodexDriver` (+ real `numTurns`)
✅ Done — see commit(s): `22e4d0c`, `47e4219` (dedup fix-up)

---

## Task 7: Add `agent:turn_count` event type + emission from all drivers
✅ Done — see commit(s): `ce36b7c`

---

## Task 8: UI store — `reviewMaxTurns` field + `turnUsageByUnit` state
✅ Done — see commit(s): `b2b2fc9`

---

## Task 9: UI — route `agent:turn_count` through WS handler
✅ Done — see commit(s): `8fdc0d8`

---

## Task 10: UI — `Review Max Turns` input + `Turns n / N` indicator
✅ Done — see commit(s): `382625f`, `ace809f` (moved to top row, hidden when review disabled), `2b0b1e8` (label nowrap)

---

## Task 11: Self-verification and final build
✅ Done — build clean, `npm test` 3831/3831 passing, CLI spot-check OK, vue-tsc shows only pre-existing `ChatView.vue:85` error.

---

## Post-implementation: External code review iteration 2
✅ Done — see commit(s): `cd38e56` (Claude/OpenCode/Codex breach contract hardening + test additions), `8fad812` (N=1 boundary tests).

**Fixes applied:**
- Claude `handleResult` now translates `result.subtype === "error_max_turns"` → `signal:none` + marker + preserved metrics.
- OpenCode for-await loop prioritizes `ctx.maxTurnsExceeded` over `ctx.errorResult` so server-synthesized `session.error` post-abort doesn't clobber breach result.
- Codex catch block classifies breach via `maxTurnsExceeded` flag OR `signal.reason instanceof MaxTurnsExceededError` to handle SDK wrapping our abort as DOMException AbortError. Removed `opts.maxTurns!` non-null assertions.
- UI store: removed unused `clearTurnUsage` action (dead code).
- Tests: Claude breach regression, OpenCode session.error race, Codex AbortError wrapping, executeUnit retry integration, N=1 boundary cases for both drivers.

---

## Remaining (out of scope, optional follow-ups)

- `ChatOptions.maxTurns` wiring for non-Claude chat drivers (design Non-goals).
- `ui-execution-turns-indicator.test.ts` component test for UI render paths (flagged by final review, not blocking).
- Per-driver "turn" semantic differences may deserve future normalization if users report confusion (design Risks).
- Review/aggregator/rework retry loop — explicitly accepted as trade-off; escalate only on real runaway-reviewer incidents.
