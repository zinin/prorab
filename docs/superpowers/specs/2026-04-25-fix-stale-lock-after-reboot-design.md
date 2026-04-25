# Spec: Fix Stale `prorab.lock` After OS Reboot

**Status:** Approved (brainstorming complete)
**Date:** 2026-04-25
**Branch:** `fix/stale-lock-after-reboot`
**Source:** `docs/fix-stale-lock-after-reboot.md` (initial proposal)

## Problem

After an unscheduled OS reboot (hang, forced reboot, kernel panic),
`.taskmaster/prorab.lock` retains the PID and `startedAt` of the previous
`prorab serve` process. On Linux, PID numbering restarts at boot and the same
numeric PID is reused by an unrelated live process or thread (any `node`,
browser, systemd unit, `HangWatcher` thread, etc.). `process.kill(pid, 0)`
succeeds against the new occupant and `acquireLock()` reports the lock as
held, returning `409 { reason: "active_session" }` from every session
endpoint (`POST /api/parse-prd|expand|chat|execute|refine-prd|refine-tasks|
batch-expand`). The UI shows "Another session is active"; the original
message "Another prorab instance is already running (PID …, started …)" is
buried in the response `message` field.

Linux additionally accepts thread PIDs (not only TGIDs) for `kill(2)`, so
even an "invisible to `ps`" thread of an unrelated process triggers the
false positive.

## Goals

- Detect lock files predating the current OS boot and overwrite them.
- Verify a live PID actually belongs to a `prorab` process before treating
  it as a held lock.
- Cross-platform fallback: never *worse* than current behavior on macOS or
  other non-Linux platforms.
- No new dependencies (only `node:fs`, `node:os`, `node:process`).

## Non-Goals

- Windows support (out of scope for `prorab`).
- macOS PID reuse without reboot — extremely unlikely; defer until proven
  needed.
- Changes to `SessionCore`, managers, routes, or UI 409 rendering.
- Structured logging or metrics for stale-detection events.
- Process start-time check via `/proc/<pid>/stat` field 22 — overkill on
  top of btime + cmdline matching.

## Design

### 1. Lock file format (extended, backwards-compatible)

```json
{
  "pid": 12345,
  "startedAt": "2026-04-25T14:30:00.000Z",
  "argv1": "/opt/prorab/dist/index.js"
}
```

`argv1` is `process.argv[1]` recorded at `acquireLock()` time. Old lock
files without `argv1` are read normally — the absence is treated as
"cannot prove ownership" (see decision tree).

**Storage location:** unchanged at `<cwd>/.taskmaster/prorab.lock`.
**Format invariants:** existing keys (`pid`, `startedAt`) keep their
semantics. Older `prorab` versions reading the new format silently ignore
the extra `argv1` field (JSON.parse tolerates extra keys).

### 2. New helpers (in `src/core/lock.ts`, module-private)

#### `getBootTime(): number | null`

Returns Unix-seconds boot time, or `null` if undeterminable.

- **Linux fast path:** read `/proc/stat`, regex `/^btime\s+(\d+)$/m`.
- **Cross-platform fallback:** `Math.floor(Date.now()/1000 - os.uptime())`.
  Sub-second drift acceptable for day-grade comparisons.
- **All errors swallowed:** any I/O failure or non-finite uptime returns
  `null`, so callers gracefully skip the btime gate.

#### `isProrabProcess(pid, expectedArgv1): boolean | null`

- `true` — confirmed: this PID belongs to a process whose `cmdline`
  contains `expectedArgv1` and whose `Tgid === pid`.
- `false` — confirmed not ours: live PID, but `Tgid !== pid` (thread) or
  `cmdline` does not contain `expectedArgv1`.
- `null` — cannot tell: `expectedArgv1` is falsy (legacy lock format),
  non-Linux platform, `/proc/<pid>/{cmdline,status}` unreadable, or the
  process disappeared between checks.

Linux implementation:

1. Read `/proc/<pid>/status`, extract `Tgid:` line. If missing or
   `≠ pid` → `false`.
2. Read `/proc/<pid>/cmdline`, split on `\0`, drop empty tokens. If
   `expectedArgv1` not in token list → `false`. Else → `true`.

Comparison is exact string equality on a single token (not `includes()`
substring) to avoid false positives such as another process running with
`--config=prorab.toml`.

#### `isProcessAlive(pid: number): boolean`

Unchanged from current implementation.

### 3. `acquireLock(cwd)` — decision tree

```
prevLock = readLock(path)
if !prevLock OR corrupt:
    → writeNewLock(); return

bootSec    = getBootTime()
startedSec = Date.parse(prevLock.startedAt) / 1000   // NaN if invalid

// 1. Boot-time gate — main reboot defense, format-independent
if bootSec !== null AND startedSec < bootSec:
    warn "removing stale lock (PID was X, predates boot)"
    → writeNewLock(); return

// 2. PID dead
if NOT isProcessAlive(prevLock.pid):
    warn "removing stale lock (PID was X, process is gone)"
    → writeNewLock(); return

// 3. PID alive — try to prove it isn't our process
ownership = isProrabProcess(prevLock.pid, prevLock.argv1)
if ownership === false:
    warn "removing stale lock (PID was X, reused by non-prorab process)"
    → writeNewLock(); return

// 4. ownership === true (definitely ours) OR null (can't tell)
//    → conservative throw
throw "Another prorab instance is already running (PID X, started Y)"
```

Backwards compatibility for legacy lock files (no `argv1`) is automatic:
`expectedArgv1 === undefined` → `isProrabProcess` returns `null` → step 4.
The btime gate (step 1) still fires for legacy files because `startedAt`
exists in the old format — that is the key reboot defense for upgraders.

The error text in step 4 is unchanged from the current implementation.
Only the `console.warn` messages get a reason suffix.

### 4. New lock-file write

```ts
writeFileSync(path, JSON.stringify({
  pid: process.pid,
  startedAt: new Date().toISOString(),
  argv1: process.argv[1] ?? "",
}));
```

If `process.argv[1]` is undefined (exotic ESM-loader scenario), `argv1: ""`
is written. A falsy `expectedArgv1` later collapses to the `null` ownership
branch — no throw at write time.

### 5. Edge cases — explicit handling

| Case | Behavior |
|------|----------|
| `process.argv[1]` undefined at write | `argv1: ""`; future read sees falsy → `null` ownership → conservative throw. |
| `/proc/<pid>/cmdline` empty (zombie) | tokens after `filter(Boolean)` is `[]` → `argv1` not in list → `false` → overwrite lock. |
| `/proc/<pid>/status` missing `Tgid` (custom kernel) | regex mismatch → `false` → overwrite. Conservative toward overwrite; rare on standard kernels. |
| `startedAt` invalid date | `Date.parse → NaN`; `NaN < bootSec` is `false`; btime gate skipped, flow continues to PID checks. |
| TOCTOU between `isProcessAlive` and `/proc` reads | `try/catch` in `isProrabProcess` → `null` → conservative throw. User retry sees dead PID and overwrites. |

## Logging

`console.warn` only. The reason suffix is added to the existing message:

- `"Warning: removing stale lock (PID was N, predates boot)."`
- `"Warning: removing stale lock (PID was N, process is gone)."`
- `"Warning: removing stale lock (PID was N, reused by non-prorab process)."`
- `"Warning: removing corrupt lock file."` (unchanged)

The 409 user-facing text and reason code (`active_session`) are unchanged.

## Tests

### Existing tests (no breaking changes)

`src/__tests__/lock.test.ts` — keep all four test cases. Add one assertion:
after `acquireLock`, the written lock contains `argv1 === process.argv[1]`.

### New file: `src/__tests__/lock-stale-detection.test.ts`

`vi.spyOn` strategy (no whole-module `vi.mock`): spy on `fs.readFileSync`
for `/proc/...` paths only, `os.uptime`, `process.kill`, and use
`Object.defineProperty(process, 'platform', …)` for platform overrides.
Lock-file I/O still hits real ext4 in `mkdtempSync` tempdir.

Cases (one decision-tree branch each):

1. fresh start (no lock) → writes lock with `argv1`
2. lock `startedAt < btime` (btime from `/proc/stat`) → warn `predates boot`, overwrite
3. lock `startedAt < btime` via `os.uptime` fallback (no `/proc/stat`) → same
4. btime undeterminable (`null`) AND PID dead → warn `process is gone`, overwrite
5. btime undeterminable AND PID alive AND `cmdline` lacks `argv1` → warn `reused by non-prorab`, overwrite
6. PID alive AND `Tgid !== pid` (thread case) → warn `reused by non-prorab`, overwrite
7. PID alive AND `cmdline` contains correct `argv1` → throw
8. PID alive AND lock has no `argv1` (legacy format, btime gate doesn't fire) → throw (conservative)
9. PID alive AND `process.platform === "darwin"` (mocked) → throw (conservative)
10. corrupt JSON → warn, overwrite (regression guard)

### Manual E2E (not automated)

1. `prorab serve` → note PID
2. `kill -9 <PID>`
3. Edit `prorab.lock` to set `startedAt` to before current `btime`
4. `prorab serve` → starts cleanly; `POST /api/parse-prd` returns 200, not 409.

## Acceptance Criteria

1. After OS reboot, the first session-endpoint call returns 200 (lock
   auto-overwritten via btime gate).
2. A real second `prorab serve` from the same cwd still produces 409 with
   the correct message.
3. Legacy lock files (no `argv1`): btime gate handles the reboot case;
   live-PID case still throws conservatively.
4. All 10 branches in `lock-stale-detection.test.ts` pass.
5. All existing `lock.test.ts` cases pass (only the added `argv1`
   assertion is new).
6. `npm run build` and `npm test` pass.

## Scope

### In

- `src/core/lock.ts`: new helpers `getBootTime`, `isProrabProcess`;
  refactored `acquireLock`; new `argv1` field in written lock files.
- `src/__tests__/lock-stale-detection.test.ts`: 10 new test cases.
- `src/__tests__/lock.test.ts`: one added assertion for `argv1`.

### Out

- `SessionCore`, managers, routes — no changes (existing 409 translation
  already correct).
- UI rendering of 409 messages.
- macOS `ps` fallback (deferred).
- Windows support.
- Structured logging or metrics.
- Process start-time additional check.

## Risks

- **macOS PID reuse without reboot.** Conservative throw; user must delete
  `prorab.lock` manually. Acceptable: requires a stranger's process to
  grab the same PID within seconds between two `prorab serve` invocations.
- **`/proc/<pid>/cmdline` parsing edge cases on non-mainstream Linux
  distros.** All paths covered by `try/catch` → `null` → conservative
  throw. No worse than current behavior.
- **`argv[1]` mismatch when `prorab` is invoked through unusual loaders**
  (`esbuild-register`, `tsx`-via-shebang, etc.). If `argv[1]` differs
  between two real `prorab` runs of the same installation, ownership
  check returns `false` → overwrite — incorrect *if* the live process
  really is another prorab in the same cwd. At that point lock semantics
  are already broken (two truly running prorabs). Risk accepted.

## References

- `src/core/lock.ts` — current `isProcessAlive` / `acquireLock`.
- `src/server/session/session-core.ts` — `acquireLock` invocation site.
- `src/server/parse-prd-manager.ts` — error rewrap to `*SessionActiveError`.
- `src/server/routes/{parse-prd,expand,chat,execution,refine-prd,refine-tasks,batch-expand}.ts` — 409 mapping.
- `docs/fix-stale-lock-after-reboot.md` — initial proposal that drove
  this brainstorming.
