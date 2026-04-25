# Spec: Fix Stale `prorab.lock` After OS Reboot

**Status:** Approved (brainstorming complete; revised after iter-1 review)
**Date:** 2026-04-25
**Branch:** `fix/stale-lock-after-reboot`
**Source:** `docs/fix-stale-lock-after-reboot.md` (initial proposal)
**Review:** `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-review-iter-1.md`

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
- Verify a live PID actually belongs to a `prorab` process bound to the
  same project working directory before treating it as a held lock.
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
  top of btime + cwd matching.
- `boot_id` (Linux UUID) as primary boot-identity gate — `btime` with
  `os.uptime()` fallback is cross-platform and sufficient.
- `proper-lockfile` and similar advisory-locking libraries — adds a
  dependency and is fragile under SIGKILL on some filesystems.

## Design

### 1. Lock file format — unchanged

```json
{
  "pid": 12345,
  "startedAt": "2026-04-25T14:30:00.000Z"
}
```

Format stays exactly as current. No `argv1`, no `cwd`, no extra fields.
The owning cwd is implicit: it is the directory whose `.taskmaster/prorab.lock`
is being read, passed in to `acquireLock(cwd)`. Backwards compatibility is
trivial: old lock files are read by the same code, no migration needed.

**Storage location:** unchanged at `<cwd>/.taskmaster/prorab.lock`.

### 2. New helpers (in `src/core/lock.ts`, module-private)

#### `getBootTime(): number | null`

Returns Unix-seconds boot time, or `null` if undeterminable.

- **Linux fast path:** read `/proc/stat`, regex `/^btime\s+(\d+)$/m`.
- **Cross-platform fallback:** `Math.floor(Date.now()/1000 - os.uptime())`.
  Sub-second drift acceptable for day-grade comparisons.
- **All errors swallowed:** any I/O failure, missing match, or non-finite
  uptime returns `null`, so callers gracefully skip the btime gate.

#### `isOwningProcess(pid, lockedCwd): boolean | null`

Determines whether the given live PID belongs to a process whose working
directory matches `lockedCwd`. Returns:

- `true` — confirmed: process exists, `Tgid === pid` (not a thread), and
  its `/proc/<pid>/cwd` symlink resolves to `lockedCwd`.
- `false` — confirmed not ours: process exists but `Tgid !== pid`
  (thread), or its cwd points elsewhere, or the process disappeared
  between `isProcessAlive` and the `/proc` reads (ENOENT — see edge cases).
- `null` — cannot tell: non-Linux platform, or `/proc/<pid>/{cwd,status}`
  unreadable for a reason other than ENOENT (e.g. EACCES on a hardened
  kernel), or `/proc/<pid>/status` is missing the `Tgid:` field.

Linux implementation:

1. Read `/proc/<pid>/status`. Extract `Tgid:` line via
   `/^Tgid:\s*(\d+)\s*$/m`. If line missing → `null` (cannot tell). If
   `Tgid !== pid` → `false` (thread).
2. Read `/proc/<pid>/cwd` via `readlinkSync` (it is a symlink to the
   process's cwd). Compare result to `realpathSync(lockedCwd)`. Match →
   `true`; mismatch → `false`.
3. Errors: `ENOENT` → `false` (process died in the gap, see edge cases);
   any other error → `null`.

Comparison uses `realpathSync` on `lockedCwd` so symlinked project
directories match the kernel-resolved cwd from `/proc`.

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
if bootSec !== null AND Number.isFinite(startedSec) AND startedSec < bootSec:
    warn "removing stale lock (PID was X, predates boot)"
    → writeNewLock(); return

// 2. PID dead
if NOT isProcessAlive(prevLock.pid):
    warn "removing stale lock (PID was X, process is gone)"
    → writeNewLock(); return

// 3. PID alive — try to prove this process is not ours
ownership = isOwningProcess(prevLock.pid, cwd)
if ownership === false:
    warn "removing stale lock (PID was X, reused by non-prorab process)"
    → writeNewLock(); return

// 4. ownership === true (definitely ours) OR null (can't tell, e.g. macOS)
//    → conservative throw
throw "Another prorab instance is already running (PID X, started Y)"
```

**ENOENT handling.** A process can die between `isProcessAlive(pid) === true`
and the `/proc/<pid>/...` reads. In that case `readlinkSync` or `readFileSync`
throws `ENOENT`. `isOwningProcess` catches that specifically and returns
`false`, sending us to step 3 → overwrite — the right thing to do, since the
process is gone. All other errors collapse to `null` → conservative throw.

The error text in step 4 is unchanged from the current implementation.
Only the `console.warn` messages get a reason suffix.

### 4. Lock-file write

```ts
writeFileSync(path, JSON.stringify({
  pid: process.pid,
  startedAt: new Date().toISOString(),
}));
```

Identical to the current code. No new fields written. `releaseLock` is
unchanged.

### 5. Edge cases — explicit handling

| Case | Behavior |
|------|----------|
| `/proc/<pid>/cwd` ENOENT after live `kill(0)` | `false` → overwrite (process died in gap). |
| `/proc/<pid>/cwd` exists but resolves to a different path | `false` → overwrite (PID reused by unrelated process). |
| `/proc/<pid>/status` missing `Tgid` field (custom kernel) | `null` → conservative throw (cannot tell — refuse to overwrite). |
| `/proc/<pid>/...` EACCES (hardened kernel, restricted ns) | `null` → conservative throw. |
| Process is a thread (`Tgid !== pid`) | `false` → overwrite. |
| `lockedCwd` is itself a symlink | `realpathSync` resolves both sides; comparison is canonical. |
| `startedAt` invalid date | `Date.parse → NaN`; `Number.isFinite` is `false`; btime gate skipped, flow continues to PID checks. |
| `pid` is 0 / negative / non-integer in JSON | `process.kill(non-int, 0)` throws → `isProcessAlive` returns `false` → overwrite. (Treats malformed lock as stale, which is the safe choice.) |
| Container with PID namespace (Docker/Podman) | Inside the container, `/proc/<pid>` reflects the namespace's PID, and the host's PID is invisible. Lock written from inside maps to the container's view. Cross-namespace lock sharing is not supported (existing limitation, unchanged). |

## Logging

`console.warn` only. The reason suffix is added to the existing message:

- `"Warning: removing stale lock (PID was N, predates boot)."`
- `"Warning: removing stale lock (PID was N, process is gone)."`
- `"Warning: removing stale lock (PID was N, reused by non-prorab process)."`
- `"Warning: removing corrupt lock file."` (unchanged)

The 409 user-facing text and reason code (`active_session`) are unchanged.

## Tests

### Existing tests (`src/__tests__/lock.test.ts`) — no changes

Lock-file format does not change, so all four existing test cases pass
without modification:

- "creates lock file with current PID"
- "throws when lock held by live process (self)"
- "removes stale lock from dead process"
- "replaces corrupt lock file"

(Note: the existing "removes stale lock from dead process" test uses
`startedAt: "2020-01-01"` and a dead PID. With the new btime gate this
test now exits at step 1 (`predates boot`) rather than step 2
(`process is gone`); the assertion only checks that the lock got
overwritten, so it still passes. A separate regression test below
explicitly covers the post-boot dead-PID branch.)

### New file: `src/__tests__/lock-stale-detection.test.ts`

**Mocking strategy:** partial `vi.mock("node:fs")` and `vi.mock("node:os")`
with pass-through factories — default behavior delegates to the actual
implementations, so `writeFileSync`, `existsSync`, `appendFileSync`, and
`readFileSync` for the real lock file all hit ext4 in `mkdtempSync`. Tests
override `readFileSync`, `readlinkSync`, and `os.uptime` selectively for
`/proc/...` paths only. `process.kill` is spied via `vi.spyOn`.
`process.platform` is overridden via `Object.defineProperty(process,
"platform", { value: "darwin", configurable: true })` and restored in
`afterEach`.

`beforeEach` uses `mockClear()` (not `mockReset`) on the mocks, then
re-installs the pass-through implementation, so per-test customizations
do not leak.

Cases (one decision-tree branch each):

1. **predates boot via /proc/stat** — `startedAt < btime` from `/proc/stat`
   → warn `predates boot`, overwrite.
2. **predates boot via os.uptime fallback** — `/proc/stat` unreadable,
   `uptime` mocked → derived btime > `startedAt` → warn `predates boot`,
   overwrite.
3. **post-boot dead PID** — `startedAt > bootSec`, PID dead → warn
   `process is gone`, overwrite. (Regression for the dead-PID branch
   that the existing `lock.test.ts` no longer reaches.)
4. **btime undeterminable AND PID dead** — `/proc/stat` errors, `os.uptime`
   throws → btime null, PID dead → warn `process is gone`, overwrite.
5. **PID alive, /proc/<pid>/cwd points elsewhere** → warn `reused by
   non-prorab`, overwrite.
6. **PID alive, Tgid !== pid (thread)** → warn `reused by non-prorab`,
   overwrite, regardless of what `/proc/<pid>/cwd` resolves to.
7. **PID alive, cwd matches, Tgid matches** → throw.
8. **ENOENT after kill(0) success** — `kill(0)` returns true, but
   `readlinkSync('/proc/<pid>/cwd')` throws ENOENT → treated as
   `process is gone`-style overwrite (warn `reused by non-prorab` since
   we discovered it in step 3, with explicit ENOENT handling in
   `isOwningProcess`).
9. **non-Linux platform, PID alive** — `process.platform === "darwin"`
   (mocked) → `isOwningProcess` returns `null` → throw (conservative).
10. **`/proc/<pid>/status` missing Tgid (custom kernel)** — readable
    `/proc/<pid>/cwd` matching `lockedCwd`, but `status` text without
    `Tgid:` line → `isOwningProcess` returns `null` → throw.

Warn assertions use `expect.stringContaining(...)` (not `stringMatching`)
to be robust to surrounding punctuation tweaks. Reason fragments are
stable: `"predates boot"`, `"process is gone"`, `"reused by non-prorab"`.

### Manual E2E (not automated)

1. `prorab serve` → note PID.
2. `kill -9 <PID>`.
3. Edit `prorab.lock` to set `startedAt` to before current `btime`.
4. `prorab serve` → starts cleanly; `POST /api/parse-prd` returns 200, not 409.

## Acceptance Criteria

1. After OS reboot, the first session-endpoint call returns 200 (lock
   auto-overwritten via btime gate).
2. A real second `prorab serve` from the same cwd still produces 409 with
   the correct message.
3. PID reuse where the new occupant lives in a different cwd is detected
   and overwritten.
4. Live PID where `/proc/<pid>` becomes unreadable (process dies in the
   gap, ENOENT) is treated as gone and overwritten — no spurious 409 for
   the user.
5. All 10 branches in `lock-stale-detection.test.ts` pass.
6. All existing `lock.test.ts` cases pass without modification.
7. `npm run build` and `npm test` pass.

## Scope

### In

- `src/core/lock.ts`: new helpers `getBootTime`, `isOwningProcess`;
  refactored `acquireLock` with four-step decision tree; warn messages
  include reason suffix. Lock-file write payload unchanged.
- `src/__tests__/lock-stale-detection.test.ts`: 10 new test cases.

### Out

- `src/__tests__/lock.test.ts` — no changes.
- `SessionCore`, managers, routes — no changes (existing 409 translation
  already correct).
- UI rendering of 409 messages.
- macOS process-ownership probing (deferred).
- Windows support.
- Structured logging or metrics.
- Process start-time additional check.
- `boot_id` boot-identity primary; `proper-lockfile`; atomic `O_EXCL`
  creation. All explicitly out of scope.

## Risks

- **macOS PID reuse without reboot.** Conservative throw; user must
  delete `prorab.lock` manually. Acceptable: requires a stranger's
  process to grab the same PID within seconds between two `prorab serve`
  invocations.
- **Hardened kernels with restricted `/proc` access** (EACCES rather than
  ENOENT). All paths covered by `try/catch` → `null` → conservative
  throw. No worse than current behavior.
- **Two `prorab` instances chdir'ing into the same cwd then chdir'ing
  away** — `/proc/<pid>/cwd` reflects the *current* cwd, not the cwd at
  process start. `prorab` does not call `process.chdir()`, so this risk
  is theoretical for normal use; if a future change introduces chdir,
  ownership detection would need re-evaluation.

## References

- `src/core/lock.ts` — current `isProcessAlive` / `acquireLock`.
- `src/server/session/session-core.ts` — `acquireLock` invocation site.
- `src/server/parse-prd-manager.ts` — error rewrap to `*SessionActiveError`.
- `src/server/routes/{parse-prd,expand,chat,execution,refine-prd,refine-tasks,batch-expand}.ts` — 409 mapping.
- `docs/fix-stale-lock-after-reboot.md` — initial proposal that drove
  this brainstorming.
- `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-review-merged-iter-1.md`
  — merged review feedback.
- `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-review-iter-1.md`
  — iteration-1 decisions and changes.
