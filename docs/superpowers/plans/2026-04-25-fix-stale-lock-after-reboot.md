# Fix Stale `prorab.lock` After OS Reboot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `acquireLock` correctly detect stale `.taskmaster/prorab.lock` after OS reboot or PID reuse, by combining a boot-time gate with a `/proc/<pid>/cwd` ownership check on Linux.

**Architecture:** Lock-file format stays unchanged (`{ pid, startedAt }`). Add two module-private helpers in `src/core/lock.ts`:
- `getBootTime()` — Linux `/proc/stat` fast path + `os.uptime()` cross-platform fallback.
- `isOwningProcess(pid, lockedCwd)` — Linux-only `Tgid` check + `/proc/<pid>/cwd` symlink match against the project cwd. Returns `boolean | null`.

Refactor `acquireLock` to a 4-step decision tree: btime gate → PID alive → cwd ownership → conservative throw. ENOENT during `/proc` reads is trusted as "process died in the gap" (overwrite, no spurious 409).

**Tech Stack:** TypeScript, Node.js (`node:fs`, `node:os`, `node:process`), vitest, Linux `/proc` filesystem.

**Spec:** `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-design.md`
**Iter-1 review:** `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-review-iter-1.md`

---

## File Structure

- **Modify** `src/core/lock.ts` — add `getBootTime` and `isOwningProcess` helpers, refactor `acquireLock` to four-step decision tree, augment warn messages with reason suffixes. Lock-file *write* payload unchanged.
- **Create** `src/__tests__/lock-stale-detection.test.ts` — ten new test cases covering each decision-tree branch, ENOENT handling, and conservative-fallback paths.
- **No changes** to `src/__tests__/lock.test.ts` — existing four cases remain valid as-is.

---

## Mocking Strategy (used by `lock-stale-detection.test.ts`)

Two partial module mocks at the top of the file. Default behavior is the real implementation (pass-through), so the lock file itself still lives on real ext4 in a `mkdtemp` directory. Each test overrides selectively:

- `fs.readFileSync` for `/proc/stat` and `/proc/<pid>/status` paths.
- `fs.readlinkSync` for `/proc/<pid>/cwd`.
- `os.uptime` (only when needed to test the fallback or to force `null`).
- `process.kill` via `vi.spyOn(process, "kill")`.
- `console.warn` via `vi.spyOn(console, "warn")` to assert reason suffixes.
- `process.platform` via `Object.defineProperty(process, "platform", { value: ..., configurable: true })`, restored in `afterEach`.

`beforeEach` calls `mockClear()` (not `mockReset`) on the mocks, then re-installs the pass-through implementation, so per-test `mockImplementation` overrides do not leak.

The exact boilerplate appears verbatim in Task 1 (it sets up the file). Subsequent tasks **append** new `it(...)` blocks; they do not modify the boilerplate.

---

### Task 1: Boot-time gate via `/proc/stat` (Linux fast path)
✅ Done — see commit `f9e9b14`.

---

### Task 2: Boot-time fallback via `os.uptime()`
✅ Done — see commit `a543b93`.

---

### Task 3: Post-boot dead-PID regression test
✅ Done — see commit `3be13d4`.

---

### Task 4: btime undeterminable AND PID dead
✅ Done — see commit `8c17ca9`.

---

### Task 5: `isOwningProcess` (cwd check) + decision step 3
✅ Done — see commits `2861423` (impl) and `a0993b2` (out-of-plan: removed obsolete same-process self-test from `lock.test.ts` — replaced by mocked equivalent in `lock-stale-detection.test.ts` Task 7; user-approved).

---

### Task 6: `Tgid` check in `isOwningProcess`
✅ Done — see commit `a99edd1`.

---

### Task 7: Live owning prorab → throw (deterministic with mocks)
✅ Done — see commit `b992a15`.

---

### Task 8: ENOENT in `/proc` reads after live `kill(0)` → overwrite
✅ Done — see commit `f7efd85`.

---

### Task 9: Conservative throws — non-Linux platform + missing `Tgid` field
✅ Done — see commit `0e14898`.

---

### Task 10: Final full-suite verification + build
✅ Done — see commits `2295b31` (out-of-plan: self-pid short-circuit needed to keep `cross-session-conflict.test.ts` and `session-core-integration.test.ts` passing — vitest worker `process.cwd()` ≠ tempDir would otherwise have caused `isOwningProcess` to silently overwrite; user-approved) and `2ea436c` (test hardening: assert lock preserved on self-pid throw).

---

## Self-Review Notes

- **Spec coverage:**
  - § Lock file format unchanged → no task needed (and no `argv1` extension to roll out).
  - § `getBootTime` Linux fast path + fallback → Tasks 1–2.
  - § `isOwningProcess` Tgid + cwd → Tasks 5–6.
  - § Decision tree four steps → Tasks 1 (steps 1, 2, 4) + Task 5 (step 3).
  - § ENOENT trust (Q2 from review) → Task 8.
  - § Non-Linux conservative throw + missing Tgid conservative throw → Task 9.
  - § Acceptance criteria 1 (post-reboot 200) → Task 1 (predates boot).
  - § Acceptance criteria 2 (live prorab still 409) → Task 7.
  - § Acceptance criteria 3 (PID reuse different cwd) → Task 5.
  - § Acceptance criteria 4 (ENOENT no spurious 409) → Task 8.
  - § Acceptance criteria 7 (`npm run build` & `npm test`) → Task 10.
- **No placeholders.** Every step has either exact code, exact command, or exact expected output.
- **Type consistency.** `getBootTime: () => number | null`, `isOwningProcess: (number, string) => boolean | null`, lock-data shape `{ pid, startedAt }` — used identically across all tasks.
- **Granularity.** Each task is 3–5 steps, each step 2–5 minutes.
- **Mock pattern.** Single `mockClear()`-then-pass-through implementation in `beforeEach`. No `mockReset` (which would also blow away the implementation, requiring re-installation). No `vi.spyOn` on namespace imports (which is unreliable for builtins with named imports in `lock.ts`); `vi.mock` factory with `actual` pass-through is the working pattern.

---

## External Review Iteration (post-plan, 2026-04-25)

After Task 10 the branch went through `/external-code-review default` — 9 reviewers (superpowers, codex, gemini, ccs ×6 profiles). 26 dedup'd findings; 13 dismissed as false positives, 6 dismissed as out-of-scope/stylistic, 7 applied:

| Finding | Decision | Commit |
|---|---|---|
| Warn text "reused by non-prorab" misleading on ENOENT-died path | Differentiate via `OwnershipResult` discriminator (`owns`/`stranger`/`died`/`unknown`) | `117bf71` |
| Self-pid comment inaccurate after reboot | Reworded | `117bf71` |
| Clock-skew + btime gate could steal live lock on `os.uptime()` fallback path | Move self-pid short-circuit BEFORE btime gate | `f1345be` |
| `realpathSync(lockedCwd)` inside `/proc` try/catch — theoretical lockedCwd-vanishes silent steal | Hoist to its own try/catch returning `"unknown"` | `c3be8ee` |
| cwd string equality vulnerable to bind mounts / `process.chdir()` | Inline doc comment (st_dev+st_ino approach left as future hardening) | `ab567d8` |
| TOCTOU read→write window (existing limitation per iter-1 DIS-3) | Atomic `O_EXCL` via `writeFileSync(..., { flag: "wx" })` + bounded retry (3 attempts) | `5bbe09e` |
| `predates boot` warn lacks `startedAt` and `bootSec` for debugging | Added both into the message | `f2ec999` |
| Identical throw text for self-pid double-acquire vs live cross-process conflict | Self-pid throw gets unique suffix `— double-acquire from the same process` (preserves `/already running/` substring for parsers) | `7933671` |
