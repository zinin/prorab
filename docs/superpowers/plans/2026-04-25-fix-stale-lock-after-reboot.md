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

**Files:**
- Create `src/__tests__/lock-stale-detection.test.ts`
- Modify `src/core/lock.ts` (add `getBootTime` Linux fast path; refactor `acquireLock` with four-step shell, btime + PID-dead branches only)

- [ ] **Step 1: Create the new test file with mock infrastructure and the first test**

Create `src/__tests__/lock-stale-detection.test.ts` with the following content:

```ts
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { join } from "node:path";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readlinkSync: vi.fn(actual.readlinkSync),
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    uptime: vi.fn(actual.uptime),
  };
});

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, realpathSync,
} from "node:fs";
import { tmpdir, uptime } from "node:os";
import { acquireLock, LOCK_FILENAME } from "../core/lock.js";

let actualReadFileSync: typeof readFileSync;
let actualReadlinkSync: typeof readlinkSync;
let actualUptime: typeof uptime;

beforeAll(async () => {
  const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const osActual = await vi.importActual<typeof import("node:os")>("node:os");
  actualReadFileSync = fsActual.readFileSync;
  actualReadlinkSync = fsActual.readlinkSync;
  actualUptime = osActual.uptime;
});

const readMock = vi.mocked(readFileSync);
const readlinkMock = vi.mocked(readlinkSync);
const uptimeMock = vi.mocked(uptime);

function readLockJson(tempDir: string): { pid: number; startedAt: string } {
  const path = join(tempDir, ".taskmaster", LOCK_FILENAME);
  return JSON.parse(actualReadFileSync(path, "utf-8") as string);
}

function writeLock(tempDir: string, data: object): void {
  const path = join(tempDir, ".taskmaster", LOCK_FILENAME);
  writeFileSync(path, JSON.stringify(data));
}

describe("acquireLock — stale detection", () => {
  let tempDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prorab-stale-"));
    mkdirSync(join(tempDir, ".taskmaster"), { recursive: true });

    readMock.mockClear();
    readlinkMock.mockClear();
    uptimeMock.mockClear();

    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) =>
      actualReadFileSync(path, ...(args as []))) as typeof readFileSync);
    readlinkMock.mockImplementation(((path: Parameters<typeof readlinkSync>[0], ...args: unknown[]) =>
      actualReadlinkSync(path, ...(args as []))) as typeof readlinkSync);
    uptimeMock.mockImplementation(() => actualUptime());

    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    killSpy = vi.spyOn(process, "kill");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    warnSpy.mockRestore();
    killSpy.mockRestore();
  });

  it("removes lock when startedAt predates boot time (btime from /proc/stat)", () => {
    writeLock(tempDir, {
      pid: 99999,
      startedAt: "2020-01-01T00:00:00.000Z",
    });

    // Recent btime (2023-11-14 22:13:20 UTC) — well after the lock's startedAt
    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      if (path === "/proc/stat") return "btime 1700000000\ncpu  1 2 3\n";
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("predates boot"));
  });
});
```

- [ ] **Step 2: Run the new test, confirm it fails**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: FAIL — current `acquireLock` doesn't read `/proc/stat`, so it falls through to `isProcessAlive(99999)` (false) and overwrites the lock, but the warn message it produces is `"Warning: removing stale lock (PID was 99999)."` and does not contain `"predates boot"`. The assertion on `warnSpy` fails.

- [ ] **Step 3: Add `getBootTime` (Linux fast path only) and refactor `acquireLock` to a four-step shell**

In `src/core/lock.ts`, after the existing `isProcessAlive` helper (around line 21), add:

```ts
function getBootTime(): number | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync("/proc/stat", "utf-8");
      const m = stat.match(/^btime\s+(\d+)$/m);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      // fall through to fallback in a later task
    }
  }
  return null;
}
```

Then, replace the body of `acquireLock` (currently lines 23–50) with:

```ts
export function acquireLock(cwd: string): void {
  const path = lockPath(cwd);

  if (existsSync(path)) {
    let data: { pid: number; startedAt: string } | undefined;
    try {
      const raw = readFileSync(path, "utf-8");
      data = JSON.parse(raw) as { pid: number; startedAt: string };
    } catch {
      console.warn("Warning: removing corrupt lock file.");
    }

    if (data) {
      const bootSec = getBootTime();
      const startedSec = Date.parse(data.startedAt) / 1000;

      if (bootSec !== null && Number.isFinite(startedSec) && startedSec < bootSec) {
        console.warn(`Warning: removing stale lock (PID was ${data.pid}, predates boot).`);
      } else if (!isProcessAlive(data.pid)) {
        console.warn(`Warning: removing stale lock (PID was ${data.pid}, process is gone).`);
      } else {
        throw new Error(
          `Another prorab instance is already running (PID ${data.pid}, started ${data.startedAt}).\n` +
          `Stop it first or remove .taskmaster/${LOCK_FILENAME} if the process is dead.`
        );
      }
    }
  }

  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  ensureLockInGitignore(cwd);
}
```

This intentionally does **not** yet include the `isOwningProcess` step (added in Task 5). It also updates the `process is gone` warn message reason suffix as part of the refactor.

- [ ] **Step 4: Run all lock tests, confirm both files pass**

Run: `npx vitest run src/__tests__/lock.test.ts src/__tests__/lock-stale-detection.test.ts`

Expected: PASS — four tests in `lock.test.ts` plus the one in `lock-stale-detection.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: add btime gate via /proc/stat, refactor acquireLock decision tree"
```

---

### Task 2: Boot-time fallback via `os.uptime()`

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- Modify `src/core/lock.ts` (add fallback branch to `getBootTime`)

- [ ] **Step 1: Add the test**

Append the following `it` block inside the same `describe(...)` in `src/__tests__/lock-stale-detection.test.ts`:

```ts
  it("removes lock when startedAt predates boot time (btime via os.uptime fallback)", () => {
    writeLock(tempDir, {
      pid: 99999,
      startedAt: "2020-01-01T00:00:00.000Z",
    });

    // /proc/stat unreadable — forces fallback
    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      if (path === "/proc/stat") {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    // Uptime = 60 seconds → derived btime = now − 60s. Lock startedAt is 2020 → far before.
    uptimeMock.mockReturnValue(60);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("predates boot"));
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "os.uptime fallback"`

Expected: FAIL — `getBootTime()` returns `null` when `/proc/stat` throws (because the fallback is not yet implemented). Decision tree falls through to `isProcessAlive(99999)` (returns false) → warn says `"process is gone"`, not `"predates boot"`.

- [ ] **Step 3: Add the fallback branch to `getBootTime`**

In `src/core/lock.ts`, modify `getBootTime` to add a fallback after the Linux `/proc/stat` block. The function becomes:

```ts
function getBootTime(): number | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync("/proc/stat", "utf-8");
      const m = stat.match(/^btime\s+(\d+)$/m);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      // fall through to cross-platform fallback
    }
  }
  try {
    const uptimeSec = osUptime();
    if (Number.isFinite(uptimeSec) && uptimeSec > 0) {
      return Math.floor(Date.now() / 1000 - uptimeSec);
    }
  } catch {
    // fall through to null
  }
  return null;
}
```

Add the `osUptime` import at the top of `src/core/lock.ts`. Replace:

```ts
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
```

with:

```ts
import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { uptime as osUptime } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: both tests in this file PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: add os.uptime fallback to getBootTime"
```

---

### Task 3: Post-boot dead-PID regression test

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- No changes to `src/core/lock.ts`

- [ ] **Step 1: Add the test**

The existing `lock.test.ts` "removes stale lock from dead process" test now exits at step 1 (`predates boot`) because of the very-old `startedAt`. This regression test exercises step 2 (`process is gone`) explicitly.

Append:

```ts
  it("removes lock when PID is dead and startedAt is post-boot", () => {
    // startedAt is in the future of any plausible boot time
    writeLock(tempDir, {
      pid: 99999998,
      startedAt: new Date(Date.now() - 60_000).toISOString(),  // 1 minute ago
    });

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("process is gone"));
  });
```

- [ ] **Step 2: Run the test, confirm it passes immediately**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "PID is dead and startedAt is post-boot"`

Expected: PASS — `startedAt` was 1 minute ago, real `/proc/stat` btime is well before that, so step 1 doesn't fire; PID 99999998 is dead, step 2 fires.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: cover post-boot dead-PID path"
```

---

### Task 4: btime undeterminable AND PID dead

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- No changes to `src/core/lock.ts`

- [ ] **Step 1: Add the test**

Append:

```ts
  it("removes lock when btime is undeterminable and PID is dead", () => {
    writeLock(tempDir, {
      pid: 99999997,
      startedAt: "2020-01-01T00:00:00.000Z",
    });

    // /proc/stat unreadable AND os.uptime throws → bootSec = null
    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      if (path === "/proc/stat") {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);
    uptimeMock.mockImplementation(() => { throw new Error("uptime unavailable"); });

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("process is gone"));
  });
```

Note: `uptimeMock.mockImplementation(() => { throw … })` (not `mockReturnValue(0)`) is what actually drives `getBootTime` to return `null`. With `0`, `Number.isFinite(0) && 0 > 0` is false in the fallback, but the `Date.now()/1000 - 0` math is still finite and would return "boot was now", which is itself > startedAt 2020 — driving the wrong path. Throwing forces the outer try/catch to swallow and return `null`, which is what we want.

- [ ] **Step 2: Run the test, confirm it passes immediately**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: PASS — branch already implemented in Task 1. Test only locks the behavior in.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: cover btime-null + dead-PID fall-through"
```

---

### Task 5: `isOwningProcess` (cwd check) + decision step 3

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- Modify `src/core/lock.ts` (add `isOwningProcess` and step 3 in `acquireLock`)

- [ ] **Step 1: Add the test**

Append:

```ts
  it("removes lock when PID is alive but /proc/<pid>/cwd points elsewhere", () => {
    writeLock(tempDir, {
      pid: 99999996,
      startedAt: new Date().toISOString(),    // recent — passes btime gate
    });

    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    readlinkMock.mockImplementation(((path: Parameters<typeof readlinkSync>[0], ...args: unknown[]) => {
      if (String(path) === "/proc/99999996/cwd") return "/some/other/dir";
      return actualReadlinkSync(path, ...(args as []));
    }) as typeof readlinkSync);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reused by non-prorab"));
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "/proc/<pid>/cwd points elsewhere"`

Expected: FAIL — current `acquireLock` reaches the throw branch (PID alive, no cwd check yet) and the test gets an "Another prorab instance is already running" error instead of a successful overwrite.

- [ ] **Step 3: Add `isOwningProcess` (cwd-only initially) and the step-3 branch in `acquireLock`**

In `src/core/lock.ts`, after `getBootTime`, add:

```ts
function isOwningProcess(pid: number, lockedCwd: string): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const procCwd = readlinkSync(`/proc/${pid}/cwd`);
    return procCwd === realpathSync(lockedCwd);
  } catch {
    return null;
  }
}
```

Add `readlinkSync` and `realpathSync` to the `node:fs` import:

```ts
import {
  readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync,
  readlinkSync, realpathSync,
} from "node:fs";
```

In `acquireLock`, replace the final `else { throw ... }` branch with the step-3/step-4 split:

```ts
      } else {
        const ownership = isOwningProcess(data.pid, cwd);
        if (ownership === false) {
          console.warn(`Warning: removing stale lock (PID was ${data.pid}, reused by non-prorab process).`);
        } else {
          throw new Error(
            `Another prorab instance is already running (PID ${data.pid}, started ${data.startedAt}).\n` +
            `Stop it first or remove .taskmaster/${LOCK_FILENAME} if the process is dead.`
          );
        }
      }
```

(`Tgid` check and ENOENT-specific handling are added in subsequent tasks.)

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all five tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: cwd ownership check rejects PIDs reused by non-prorab"
```

---

### Task 6: `Tgid` check in `isOwningProcess`

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- Modify `src/core/lock.ts` (prepend `Tgid` check)

- [ ] **Step 1: Add the test**

Append:

```ts
  it("removes lock when PID belongs to a thread (Tgid !== pid) even if cwd matches", () => {
    writeLock(tempDir, {
      pid: 99999995,
      startedAt: new Date().toISOString(),
    });

    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      const p = String(path);
      // Status reports a different Tgid → PID is a thread of another process
      if (p === "/proc/99999995/status") return "Name: HangWatcher\nTgid:\t12345\nPid:\t99999995\n";
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    // cwd intentionally matches — to prove that Tgid takes priority
    readlinkMock.mockImplementation(((path: Parameters<typeof readlinkSync>[0], ...args: unknown[]) => {
      if (String(path) === "/proc/99999995/cwd") return realpathSync(tempDir);
      return actualReadlinkSync(path, ...(args as []));
    }) as typeof readlinkSync);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reused by non-prorab"));
  });
```

This test fixes a subtle scenario: even when the thread's cwd matches `lockedCwd` (because threads inherit cwd from their process), it must still be rejected because the thread is not the owning process.

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "Tgid !== pid"`

Expected: FAIL — current `isOwningProcess` only checks cwd, returns `true` (cwd matches), so `acquireLock` throws.

- [ ] **Step 3: Prepend the `Tgid` check to `isOwningProcess`**

Modify `isOwningProcess` in `src/core/lock.ts`:

```ts
function isOwningProcess(pid: number, lockedCwd: string): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const tgidMatch = status.match(/^Tgid:\s*(\d+)\s*$/m);
    if (!tgidMatch) return null;                 // missing field → cannot tell
    if (Number(tgidMatch[1]) !== pid) return false;  // thread, not the owning process

    const procCwd = readlinkSync(`/proc/${pid}/cwd`);
    return procCwd === realpathSync(lockedCwd);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all six tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: reject thread-PID via Tgid check before cwd comparison"
```

---

### Task 7: Live owning prorab → throw (deterministic with mocks)

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- No changes to `src/core/lock.ts`

- [ ] **Step 1: Add the test**

Append:

```ts
  it("throws when PID is alive AND cwd matches AND Tgid matches", () => {
    const fakePid = 99999994;
    writeLock(tempDir, {
      pid: fakePid,
      startedAt: new Date().toISOString(),
    });

    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      if (String(path) === `/proc/${fakePid}/status`) return `Name: prorab\nTgid:\t${fakePid}\nPid:\t${fakePid}\n`;
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    readlinkMock.mockImplementation(((path: Parameters<typeof readlinkSync>[0], ...args: unknown[]) => {
      if (String(path) === `/proc/${fakePid}/cwd`) return realpathSync(tempDir);
      return actualReadlinkSync(path, ...(args as []));
    }) as typeof readlinkSync);

    expect(() => acquireLock(tempDir)).toThrow(/already running/);
  });
```

This test does not depend on real `/proc/self` or the test runner's `argv`, so it is fully deterministic regardless of how vitest is invoked.

- [ ] **Step 2: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "cwd matches AND Tgid matches"`

Expected: PASS — `isOwningProcess` returns `true` from the mocked /proc reads, decision tree falls through to step 4 throw.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: regression-test live owning process throws"
```

---

### Task 8: ENOENT in `/proc` reads after live `kill(0)` → overwrite

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- Modify `src/core/lock.ts` (explicit `ENOENT` branch in `isOwningProcess`)

- [ ] **Step 1: Add the test**

Append:

```ts
  it("overwrites lock when /proc/<pid>/... ENOENTs after kill(0) success (process died in gap)", () => {
    const fakePid = 99999993;
    writeLock(tempDir, {
      pid: fakePid,
      startedAt: new Date().toISOString(),
    });

    // kill(0) succeeds — but then /proc reads will throw ENOENT
    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      const p = String(path);
      if (p === `/proc/${fakePid}/status`) {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reused by non-prorab"));
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "ENOENTs after kill"`

Expected: FAIL — current `isOwningProcess` catches ENOENT in the generic `catch` block, returns `null` → step 4 throw.

- [ ] **Step 3: Add explicit `ENOENT` handling to `isOwningProcess`**

Modify the catch block:

```ts
function isOwningProcess(pid: number, lockedCwd: string): boolean | null {
  if (process.platform !== "linux") return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const tgidMatch = status.match(/^Tgid:\s*(\d+)\s*$/m);
    if (!tgidMatch) return null;
    if (Number(tgidMatch[1]) !== pid) return false;

    const procCwd = readlinkSync(`/proc/${pid}/cwd`);
    return procCwd === realpathSync(lockedCwd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    return null;
  }
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all eight tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: trust ENOENT in /proc reads as 'process died in gap'"
```

---

### Task 9: Conservative throws — non-Linux platform + missing `Tgid` field

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append two tests)
- No changes to `src/core/lock.ts`

- [ ] **Step 1: Add the two tests**

Append:

```ts
  it("throws conservatively on non-Linux platform when PID is alive", () => {
    writeLock(tempDir, {
      pid: 99999992,
      startedAt: new Date().toISOString(),
    });

    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      expect(() => acquireLock(tempDir)).toThrow(/already running/);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("throws conservatively when /proc/<pid>/status lacks Tgid field (custom kernel)", () => {
    const fakePid = 99999991;
    writeLock(tempDir, {
      pid: fakePid,
      startedAt: new Date().toISOString(),
    });

    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      // Status without a Tgid line — non-mainstream kernel
      if (String(path) === `/proc/${fakePid}/status`) return "Name: weirdproc\nState: S\nPid:\t99999991\n";
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    expect(() => acquireLock(tempDir)).toThrow(/already running/);
  });
```

- [ ] **Step 2: Run the tests, confirm they pass**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all ten tests PASS. No code change needed — `isOwningProcess` already returns `null` on non-Linux (early return) and on missing `Tgid` (regex match fails), and the decision tree falls into the throw branch.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: lock conservative-throw behavior for non-Linux + missing Tgid"
```

---

### Task 10: Final full-suite verification + build

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every test passes, including `lock.test.ts` (4 unchanged tests) and `lock-stale-detection.test.ts` (10 tests).

If any test fails, do NOT mark the task complete — investigate and fix in a new sub-task before proceeding.

- [ ] **Step 2: Run the build**

Run: `npm run build`

Expected: TypeScript compilation succeeds (no errors). Vue build also succeeds (UI is untouched, but the build runs both).

- [ ] **Step 3: Sanity-check the modified file is well-formed**

Run: `node --check dist/core/lock.js` (after `npm run build`)

Expected: no output (module parses cleanly).

- [ ] **Step 4: No new commit if nothing changed**

If steps 1–3 produced no edits, do not create a commit. The plan's commits already cover the work.

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
