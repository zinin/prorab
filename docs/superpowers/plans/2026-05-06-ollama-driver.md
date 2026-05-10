# Ollama Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a new `ollama` agent to prorab that routes Claude Agent SDK traffic through the local Ollama daemon (`127.0.0.1:11434` by default), giving access to Ollama cloud models without depending on a CCS proxy.

**Architecture:** New `OllamaDriver` class composes over `ClaudeDriver` (mirroring the proven `CcsDriver` pattern; subclass alternative was considered and rejected to keep the interface explicit). It builds a per-session `env` override (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=ollama`, model defaults, `CLAUDE_CODE_*` knobs — with a strip pass for any leaked parent `ANTHROPIC_*`/`CLAUDE_CODE_*`) and delegates SDK work to the inner driver, stripping `opts.variant` before delegation. Preflight: HTTP probe `/api/version` + per-model `GET /v1/models/<id>` to disambiguate signed-in / not-signed-in / transient. The model catalog is hardcoded (`OLLAMA_CLOUD_CATALOG`) because the daemon's bulk `GET /v1/models` is local-manifest-only and returns `data:null` even for signed-in cloud profiles (verified empirically on Ollama 0.23.1).

**Tech Stack:** TypeScript (strict), Node.js 24+, `@anthropic-ai/claude-agent-sdk`, vitest, Vue 3 SFCs (UI), zod (`AgentTypeSchema`), commander (CLI).

---

## Status: Tasks 1–18 complete; only Pre-PR Cleanup remains

The detailed task instructions have been trimmed (preserved in git history). Each task heading retains a `✅ Done` marker with the implementing commit SHA. Two design bugs discovered during Task 18's verification have been fixed and are documented under "Post-Task-18 Findings" below.

---

## File Structure

**Created:**
- `src/core/drivers/ollama.ts` — the `OllamaDriver` class (composition over `ClaudeDriver`).
- `src/__tests__/ollama-driver.test.ts` — vitest suite mirroring `ccs-driver.test.ts` patterns.

**Modified:**
- `src/types.ts` — added `"ollama"` to `AgentTypeSchema`. `Reviewer` derives from this enum and updates automatically.
- `src/core/drivers/factory.ts` — `case "ollama"` added.
- `src/index.ts` — `--agent` help string extended.
- `src/server/routes/models.ts` — `needsSetup` exemption + cache-skip extended to include `"ollama"`.
- `ui/src/components/AgentWizard.vue` — added Ollama dropdown option + extended "No user settings" gate.
- `ui/src/views/TaskDetailView.vue`, `ExecutionView.vue`, `TaskListView.vue` — Ollama dropdown option.
- `src/__tests__/agent-wizard-component.test.ts` — count assertion 4 → 5; symmetric existence checks added.
- `.claude/rules/drivers.md`, `.claude/rules/frontend.md`, `CLAUDE.md`, `README.md` — OllamaDriver section + agent-list updates.

**Reference files (read-only):**
- `src/core/drivers/ccs.ts` — same architectural pattern.
- `src/__tests__/ccs-driver.test.ts` — same test patterns.
- `src/core/drivers/types.ts` — `AgentDriver`, `SessionOptions`, `ChatOptions` interfaces.

---

## Tasks

## Task 1: Skeleton — class file, test scaffold, "requires model" error
✅ Done — see commit `bd5cd58`

## Task 2: `listModels()` — hardcoded catalog probed via per-model GET
✅ Done — see commit `8cd6289`

## Task 3: `listModels()` honors `OLLAMA_HOST` (characterization)
✅ Done — see commit `cd3cfb9`

## Task 4: `setup()` cloud-only guard
✅ Done — see commit `9a3ebfb`

## Task 5: `setup()` preflight — daemon-not-reachable
✅ Done — see commit `6f94fd3`

## Task 6: `setup()` preflight — per-model GET disambiguates 404 vs transient
✅ Done — see commit `460f467`

## Task 7: `setup()` builds env vars + variant strip + env merge
✅ Done — see commit `b35d83f`

## Task 8: `setup()` env honors `OLLAMA_HOST` (characterization)
✅ Done — see commit `9ee4243`

## Task 9: `setup()` parses `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from model suffix
✅ Done — see commit `a1e91ab`

## Task 10: `startChat()` injects env, merges caller env, strips variant
✅ Done — see commit `ee1b813`

## Task 11: `sendMessage` / `replyQuestion` / `abortChat` delegation
✅ Done — see commit `c9a061a`

## Task 12: `teardown()` clears state and calls inner teardown
✅ Done — see commit `80dcef1`

## Task 13: Wire `AgentTypeSchema` and `factory.ts`
✅ Done — see commit `3a9a317`

## Task 14: CLI help text
✅ Done — see commit `574c88e`

## Task 15: UI dropdown — add `Ollama` to all four agent lists + extend "No user settings" gate
✅ Done — see commits `e43bade`, `fd5f38b` (test count fix-up: agent-wizard expected 4 → 5)

## Task 16: Update `/api/models` server route
✅ Done — see commit `e5b1bc5`

## Task 17: Documentation
✅ Done — see commits `3cfae96`, `5f08b29` (drivers.md AgentDriver intro polish)

## Task 18: End-to-end manual verification
✅ Done — see commit `10de5f3` (verification doc); identified 2 design bugs documented below

---

## Post-Task-18 Findings (discovered during verification, fixed before PR)

### Finding 1: Daemon rejects `[Nm]/[Nk]` suffix in model id

The hardcoded `OLLAMA_CLOUD_CATALOG` includes `deepseek-v4-pro:cloud[1m]` and `qwen3-coder:480b-cloud[1m]`. The daemon's `/v1/models/<id>` returns HTTP 400 `"invalid model name"` for these. The `[1m]` suffix is a prorab-internal decoration consumed by `parseContextWindow()` to set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; the daemon does not accept it.

**Fix:** Added `stripContextSuffix()` helper sharing `CONTEXT_WINDOW_SUFFIX_RE = /\[(\d+)([km])\]/i` constant with `parseContextWindow()`. Applied at all daemon-facing call sites:
- `/v1/models/<id>` probe URL (in `listModels` and `preflightModel`)
- `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` env vars
- `parseContextWindow(model)` keeps the original decorated form, so `CLAUDE_CODE_AUTO_COMPACT_WINDOW` continues to work

✅ Done — see commit `6ca8cbf`

### Finding 2: Cloud-only guard rejects `-cloud` variant

The cloud-only guard `model.includes(":cloud")` rejected 2 catalog entries that use `-cloud` separator instead of `:cloud`:
- `qwen3-coder:480b-cloud[1m]` — has `:480b-cloud`
- `gpt-oss:120b-cloud` — has `:120b-cloud`

**Fix:** Relaxed the guard to accept either `:cloud` OR `-cloud` substring. Error message updated to mention both. Added 2 tests using the previously-rejected catalog entries.

✅ Done — see commit `c4168e0`

### Documentation polish for the above

- `36a0590` — Updated `OLLAMA_CLOUD_CATALOG` JSDoc to clarify the `[Nm]/[Nk]` suffix is prorab-internal decoration; added new "Daemon-facing strip" paragraph to `.claude/rules/drivers.md`.
- `6713b17` — Updated drivers.md cloud-marker bullet to mention both `:cloud` and `-cloud`.

---

## External Code Review Iterations

Both rounds were `/external-code-review default` — multi-reviewer fan-out (Claude / Codex / Gemini + N CCS profiles + N Ollama profiles), Справедливо findings auto-applied, Спорно findings discussed with the user, dismissed iter-1 issues are not re-litigated when they reappear in later rounds.

### Iter-1 — commit `6ff6a7f`

8 reviewers ran (`ccs-albb-minimax` failed in recursive-orchestration mode and produced no findings). Applied: 1 Critical (model-id decoration leak in inner ClaudeDriver constructor) + 4 Important Справедливо (B/G/H/C — preflight-timeout validator, "No user settings" v-if extended to ollama, parseReviewerSpec last-colon bug for ollama, CONTEXT_WINDOW_SUFFIX_RE end-anchored) + 4 Important Спорно (E/F/J/CC — single resolveBaseUrl threading, setup() re-entry guard, 401/403 mapped to "ollama signin", symmetric env-merge precedence comment) + 3 Minor Справедливо (L/Q — drop `as ... & {variant?}` cast, add OllamaDriver case in driver-factory test). +5 tests.

### Iter-2 — commit `114f64e`

11 reviewers ran (Claude / Codex / Gemini + 5 CCS profiles + 3 Ollama profiles), all returned findings. 5 reviewers gave a clean "ready to merge"; the rest reported only Important / Minor. Applied:

- **B (codex, ollama-minimax) — Important:** preflightModel maps HTTP 400/422 to a distinct "invalid model id" message instead of the misleading "transient daemon" branch.
- **G (ccs-albb-qwen, ccs-albb-kimi) — Important:** dropped the dead-code "delete undefined values" loop in buildEnv (process.env values are always strings on Node 20+).
- **A+F (codex, ollama-minimax) — Important Спорно (user-approved):** `runSession`/`startChat` now strip `ANTHROPIC_*`/`CLAUDE_CODE_*` from caller-supplied `opts.env` via `stripManagedNamespaces()` — symmetric with the strip applied to `process.env` in `buildEnv`. Closes the asymmetry where parent-process leakage was guarded but caller-supplied env could reintroduce managed keys.
- **K (ccs-albb-glm, ollama-minimax) — Minor:** replace `this.model as string` casts with `const model = this.model` after the null-guard, threaded as a parameter to `preflightModel` and `buildEnv`.
- **N (gemini) — Minor:** drop redundant `: boolean` annotation on `useUserSettings = false`.

+2 tests (regression coverage for caller-env strip in both `runSession` and `startChat`). drivers.md updated to document 401/403 + 400/422 ladder and symmetric caller-env strip.

**Skipped (user-approved Спорно decision):** H — UI v-if duplication of `agent === 'claude' || 'ccs' || 'ollama'` across 4 files. Drift catch'ится тестами; user opted to leave the inline check.

**Skipped (already-dismissed iter-1):** C (PREFLIGHT_TIMEOUT_MS module-load), D (preflightDaemon catch generic message), I (cloud-guard substring), M (IPv6 OLLAMA_HOST), O (catalog drift), Q (runSession/startChat duplication). Future iter-3 would likely re-find these; do NOT silently re-apply.

---

## Pre-PR Cleanup (REMAINING)

Per `/home/zinin/.claude/CLAUDE.md`, design and plan documents under `docs/superpowers/` must NOT appear in the PR diff. Before opening the PR, remove **all** ollama-driver artifacts under `docs/superpowers/`:

```bash
git rm \
  docs/superpowers/specs/2026-05-06-ollama-agent-design.md \
  docs/superpowers/specs/2026-05-06-ollama-agent-review-merged-iter-*.md \
  docs/superpowers/specs/2026-05-06-ollama-agent-review-iter-*.md \
  docs/superpowers/specs/2026-05-06-ollama-task18-verification.md \
  docs/superpowers/plans/2026-05-06-ollama-driver.md \
  docs/superpowers/plans/2026-05-06-ollama-driver-execution-prompt.md \
  docs/superpowers/plans/2026-05-06-ollama-driver-continuation-prompt.md \
  2>/dev/null || true
git commit -m "chore: drop ollama-driver design + plan + review docs before PR"
```

The documents stay accessible via the branch's git history if needed later.

---

## Self-Review Checklist (run at end of implementation)

- [x] All 13 design test groups have a corresponding plan task. ✓
- [x] CRIT findings from review iter-1 are addressed:
  - CRIT-1 (`/api/models` route) → Task 16. ✓
  - CRIT-2 (`/v1/models` data:null) → hardcoded catalog + per-model probe in Tasks 2 + 6. ✓
  - CRIT-3 (cloud-only + variant leak) → Tasks 4 + 7 + 10. ✓
  - CRIT-4 (OLLAMA_HOST normalization) → Tasks 2 + 3 + 8. ✓
  - CRIT-5 (env hygiene) → Task 7. ✓
  - CRIT-6 (network mis-diagnosed as auth) → Task 6 disambiguation. ✓
  - CRIT-7 (5s timeout configurable) → `PREFLIGHT_TIMEOUT_MS` constant in Task 2 + `OLLAMA_PREFLIGHT_TIMEOUT_MS` env. ✓
- [x] Type names match across tasks. ✓
- [x] Commit messages are scoped (`feat(ollama)`, `test(ollama)`, `docs(ollama)`, `fix(ollama)`, `chore`). ✓
- [ ] Pre-PR cleanup removes design + plan + review iter + execution-prompt docs from `docs/superpowers/`. (PENDING — held until after code review)
- [x] No `vue-tsc` invocation (not installed in `ui/package.json`); UI verification runs through `npm run build:ui` only. ✓

---

## Test Suite Status (after iter-2 fix commit `114f64e`)

- Ollama-driver tests: 46 passing (`npx vitest run src/__tests__/ollama-driver.test.ts`)
- Full prorab suite: 3901 passing (142 files)
- TypeScript type check: clean (`npx tsc --noEmit`)
- Vite UI build: clean (`npm run build:ui`)
