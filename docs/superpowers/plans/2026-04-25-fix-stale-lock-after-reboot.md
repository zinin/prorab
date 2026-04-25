# Fix Stale `prorab.lock` After OS Reboot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `acquireLock` correctly detect stale `.taskmaster/prorab.lock` after OS reboot or PID reuse, by combining a boot-time gate with a cmdline-match check on Linux.

**Architecture:** Extend `prorab.lock` with an `argv1` field. Add two module-private helpers in `src/core/lock.ts` — `getBootTime()` (Linux `/proc/stat` fast path + `os.uptime()` fallback) and `isProrabProcess(pid, expectedArgv1)` (Linux `/proc/<pid>/cmdline` + `Tgid` check, returns `boolean | null`). Refactor `acquireLock` to a 4-step decision tree: btime gate → PID alive → cmdline ownership → conservative throw.

**Tech Stack:** TypeScript, Node.js (`node:fs`, `node:os`, `node:process`), vitest, Linux `/proc` filesystem.

**Spec:** `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-design.md`

---

## File Structure

- **Modify** `src/core/lock.ts` — add `getBootTime` and `isProrabProcess` helpers, extend write format with `argv1`, refactor `acquireLock` to four-step decision tree.
- **Modify** `src/__tests__/lock.test.ts` — extend one existing assertion to cover the new `argv1` field. No other changes.
- **Create** `src/__tests__/lock-stale-detection.test.ts` — eight new test cases covering each decision-tree branch and conservative-fallback paths.

---

## Mocking Strategy (used by `lock-stale-detection.test.ts`)

Two partial module mocks at the top of the file. Default behavior of mocked functions is the real implementation (pass-through), so the lock file itself still lives on real ext4 in a `mkdtemp` directory. Each test selectively overrides `readFileSync` for `/proc/...` paths and `os.uptime` when needed. `process.kill` is spied via `vi.spyOn(process, "kill")`. `process.platform` is overridden via `Object.defineProperty(process, "platform", { value: "darwin", configurable: true })` and restored in `afterEach`.

The exact boilerplate is repeated verbatim in Task 2 (it sets up the file). Subsequent tasks **append** new `it(...)` blocks; they do not modify the boilerplate.

---

### Task 1: Add `argv1` field to lock-file format

**Files:**
- Modify `src/__tests__/lock.test.ts:24-31`
- Modify `src/core/lock.ts:47`

- [ ] **Step 1: Extend the existing assertion in `lock.test.ts`**

In `src/__tests__/lock.test.ts`, replace the body of the test `"creates lock file with current PID"` (currently lines 24–31) with the following:

```ts
  it("creates lock file with current PID", () => {
    acquireLock(tempDir);
    const lockPath = join(tempDir, ".taskmaster", LOCK_FILENAME);
    expect(existsSync(lockPath)).toBe(true);
    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(data.pid).toBe(process.pid);
    expect(data.startedAt).toBeDefined();
    expect(data.argv1).toBe(process.argv[1] ?? "");
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/__tests__/lock.test.ts -t "creates lock file with current PID"`

Expected: FAIL — `expect(undefined).toBe("/path/to/...")` (because `acquireLock` does not yet write `argv1`).

- [ ] **Step 3: Modify the writeFileSync in `acquireLock`**

In `src/core/lock.ts`, replace the writeFileSync call on line 47 with:

```ts
  writeFileSync(path, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv1: process.argv[1] ?? "",
  }));
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock.test.ts`

Expected: all four tests in this file PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock.test.ts
git commit -m "lock: write argv1 into prorab.lock for ownership check"
```

---

### Task 2: Boot-time gate via `/proc/stat` (Linux fast path)

**Files:**
- Create `src/__tests__/lock-stale-detection.test.ts`
- Modify `src/core/lock.ts` (add `getBootTime`, refactor `acquireLock`)

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
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from "node:fs";
import { tmpdir, uptime } from "node:os";
import { acquireLock, LOCK_FILENAME } from "../core/lock.js";

let actualReadFileSync: typeof readFileSync;
let actualUptime: typeof uptime;

beforeAll(async () => {
  const fsActual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const osActual = await vi.importActual<typeof import("node:os")>("node:os");
  actualReadFileSync = fsActual.readFileSync;
  actualUptime = osActual.uptime;
});

const readMock = vi.mocked(readFileSync);
const uptimeMock = vi.mocked(uptime);

function readLockJson(tempDir: string): { pid: number; startedAt: string; argv1?: string } {
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

    readMock.mockReset();
    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) =>
      actualReadFileSync(path, ...(args as []))) as typeof readFileSync);

    uptimeMock.mockReset();
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
      argv1: "/some/old/prorab",
    });

    // Recent btime (2023-11-14 22:13:20 UTC) — well after the lock's startedAt
    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      if (path === "/proc/stat") return "btime 1700000000\ncpu  1 2 3\n";
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/predates boot/));
  });
});
```

- [ ] **Step 2: Run the new test, confirm it fails**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: FAIL — current `acquireLock` doesn't read `/proc/stat`, so it falls through to `isProcessAlive(99999)` (false) and overwrites the lock, but the warn message it produces is `"Warning: removing stale lock (PID was 99999)."` and does not contain `"predates boot"`. The assertion on `warnSpy` fails.

- [ ] **Step 3: Add `getBootTime` (Linux fast path only) and refactor `acquireLock` to use the four-step decision tree**

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
    let data: { pid: number; startedAt: string; argv1?: string } | undefined;
    try {
      const raw = readFileSync(path, "utf-8");
      data = JSON.parse(raw) as { pid: number; startedAt: string; argv1?: string };
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

  writeFileSync(path, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    argv1: process.argv[1] ?? "",
  }));

  ensureLockInGitignore(cwd);
}
```

This intentionally does **not** yet include the `isProrabProcess` step (added in Task 5). It also updates the existing two warn messages with the reason suffix (`process is gone`).

- [ ] **Step 4: Run all lock tests, confirm both files pass**

Run: `npx vitest run src/__tests__/lock.test.ts src/__tests__/lock-stale-detection.test.ts`

Expected: PASS — five tests in `lock.test.ts` plus the one in `lock-stale-detection.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: add btime gate via /proc/stat, refactor acquireLock decision tree"
```

---

### Task 3: Boot-time fallback via `os.uptime()`

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- Modify `src/core/lock.ts` (add fallback branch to `getBootTime`)

- [ ] **Step 1: Add the test**

Append the following `it` block inside the same `describe("acquireLock — stale detection", …)` block in `src/__tests__/lock-stale-detection.test.ts`:

```ts
  it("removes lock when startedAt predates boot time (btime via os.uptime fallback)", () => {
    writeLock(tempDir, {
      pid: 99999,
      startedAt: "2020-01-01T00:00:00.000Z",
      argv1: "/some/old/prorab",
    });

    // /proc/stat fails — forces fallback
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
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/predates boot/));
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

### Task 4: Boot-time undeterminable AND PID dead — fall-through to step 2

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- No changes to `src/core/lock.ts`

- [ ] **Step 1: Add the test**

Append the following `it` block inside the same `describe(...)` in `src/__tests__/lock-stale-detection.test.ts`:

```ts
  it("removes lock when btime is undeterminable and PID is dead", () => {
    writeLock(tempDir, {
      pid: 99999998,           // PID guaranteed not to exist
      startedAt: "2020-01-01T00:00:00.000Z",
      argv1: "/some/old/prorab",
    });

    // /proc/stat unreadable AND os.uptime unusable → bootSec = null
    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      if (path === "/proc/stat") {
        const err = new Error("EACCES") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);
    uptimeMock.mockReturnValue(0);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/process is gone/));
  });
```

- [ ] **Step 2: Run the test, confirm it passes immediately**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "btime is undeterminable and PID is dead"`

Expected: PASS — this branch is already implemented (Task 2 step 3). The test exists to lock the behavior in.

- [ ] **Step 3: Run the entire file to make sure nothing regressed**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all three tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: cover btime-null + dead-PID fall-through"
```

---

### Task 5: `isProrabProcess` cmdline check + decision step 3

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- Modify `src/core/lock.ts` (add `isProrabProcess` and step 3 in `acquireLock`)

- [ ] **Step 1: Add the test**

Append inside the same `describe(...)`:

```ts
  it("removes lock when PID is alive but cmdline does not contain argv1", () => {
    writeLock(tempDir, {
      pid: 99999997,
      startedAt: new Date().toISOString(),    // recent — passes btime gate
      argv1: "/old/prorab/dist/index.js",
    });

    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      const p = String(path);
      if (p === "/proc/99999997/status") return "Name: foo\nTgid:\t99999997\nPid:\t99999997\n";
      if (p === "/proc/99999997/cmdline") return "/usr/bin/firefox\0--profile\0";
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/reused by non-prorab/));
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "cmdline does not contain argv1"`

Expected: FAIL — current `acquireLock` reaches the throw branch (PID alive, no cmdline check yet) and the test gets an "Another prorab instance is already running" error instead of a successful overwrite.

- [ ] **Step 3: Add `isProrabProcess` and the step-3 branch in `acquireLock`**

In `src/core/lock.ts`, after `getBootTime`, add:

```ts
function isProrabProcess(pid: number, expectedArgv1: string | undefined): boolean | null {
  if (!expectedArgv1) return null;
  if (process.platform !== "linux") return null;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    const tokens = cmdline.split("\0").filter(Boolean);
    return tokens.includes(expectedArgv1);
  } catch {
    return null;
  }
}
```

(`Tgid` check is added in Task 6.)

In `acquireLock`, replace the `else { throw ... }` final branch with the step-3/step-4 split:

```ts
      } else {
        const ownership = isProrabProcess(data.pid, data.argv1);
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

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all four tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: cmdline ownership check rejects PIDs reused by non-prorab"
```

---

### Task 6: `Tgid` check in `isProrabProcess`

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- Modify `src/core/lock.ts` (add `Tgid` check)

- [ ] **Step 1: Add the test**

Append inside the same `describe(...)`:

```ts
  it("removes lock when PID belongs to a thread (Tgid !== pid)", () => {
    writeLock(tempDir, {
      pid: 99999996,
      startedAt: new Date().toISOString(),
      argv1: "/opt/prorab/dist/index.js",
    });

    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      const p = String(path);
      // Status reports a different Tgid → PID is a thread of another process
      if (p === "/proc/99999996/status") return "Name: HangWatcher\nTgid:\t12345\nPid:\t99999996\n";
      if (p === "/proc/99999996/cmdline") return "/opt/prorab/dist/index.js\0serve\0"; // intentionally matches argv1
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/reused by non-prorab/));
  });
```

This test fixes a subtle scenario: even when the thread's `cmdline` matches `argv1` (because threads inherit cmdline from their process), it must still be rejected because we are not the owning process.

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "Tgid !== pid"`

Expected: FAIL — current `isProrabProcess` only checks cmdline, returns `true` (cmdline matches), so `acquireLock` throws.

- [ ] **Step 3: Add the `Tgid` check to `isProrabProcess`**

Modify `isProrabProcess` in `src/core/lock.ts`:

```ts
function isProrabProcess(pid: number, expectedArgv1: string | undefined): boolean | null {
  if (!expectedArgv1) return null;
  if (process.platform !== "linux") return null;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const tgidMatch = status.match(/^Tgid:\s*(\d+)$/m);
    if (!tgidMatch || Number(tgidMatch[1]) !== pid) return false;

    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    const tokens = cmdline.split("\0").filter(Boolean);
    return tokens.includes(expectedArgv1);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all five tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/lock.ts src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: reject lock owned by thread PID via Tgid check"
```

---

### Task 7: Confirm a real, live `prorab` is still detected (throw)

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append one test)
- No changes to `src/core/lock.ts`

- [ ] **Step 1: Add the test**

Append inside the same `describe(...)`:

```ts
  it("throws when PID is alive AND cmdline contains argv1 (genuine running prorab)", () => {
    // Use *this* process — PID is real-alive, /proc/<pid>/cmdline contains process.argv[1]
    writeLock(tempDir, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      argv1: process.argv[1] ?? "",
    });

    // No /proc mocking — let the real /proc/<self>/{status,cmdline} answer.
    expect(() => acquireLock(tempDir)).toThrow(/already running/);
  });
```

- [ ] **Step 2: Run the test, confirm it passes**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts -t "genuine running prorab"`

Expected: PASS — `process.argv[1]` (vitest binary) is in `/proc/self/cmdline`, `Tgid === process.pid`, `isProrabProcess` returns `true`, `acquireLock` throws.

Note: this test relies on real `/proc` and a live `process.argv[1]`. It only runs correctly on Linux. If the test suite ever needs to run on macOS in CI, gate this `it()` with `it.skipIf(process.platform !== "linux")`. Not added now (project tests run on Linux).

- [ ] **Step 3: Run the entire file**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all six tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: regression-test live prorab still throws"
```

---

### Task 8: Conservative throws for legacy lock + non-Linux platform

**Files:**
- Modify `src/__tests__/lock-stale-detection.test.ts` (append two tests)
- No changes to `src/core/lock.ts`

- [ ] **Step 1: Add the two tests**

Append inside the same `describe(...)`:

```ts
  it("throws conservatively when legacy lock has no argv1 and PID is alive", () => {
    // Legacy format — no argv1
    writeLock(tempDir, {
      pid: process.pid,                       // alive (this process)
      startedAt: new Date().toISOString(),    // recent — btime gate doesn't fire
    });

    expect(() => acquireLock(tempDir)).toThrow(/already running/);
  });

  it("throws conservatively on non-Linux platform when PID is alive", () => {
    writeLock(tempDir, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      argv1: "/some/argv1/that/would/match/on/linux",
    });

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    try {
      expect(() => acquireLock(tempDir)).toThrow(/already running/);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
```

- [ ] **Step 2: Run the tests, confirm they pass**

Run: `npx vitest run src/__tests__/lock-stale-detection.test.ts`

Expected: all eight tests in this file PASS. No code change needed — `isProrabProcess` returns `null` in both cases (falsy `expectedArgv1`; non-Linux), and the decision tree falls into the throw branch.

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/lock-stale-detection.test.ts
git commit -m "lock: lock conservative-throw behavior for legacy + non-Linux"
```

---

### Task 9: Final full-suite verification + build

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every test passes, including `lock.test.ts` (5 tests, of which 1 has the new `argv1` assertion) and `lock-stale-detection.test.ts` (8 tests).

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
  - § Lock file format → Task 1.
  - § `getBootTime` Linux fast path + fallback → Tasks 2–3.
  - § `isProrabProcess` cmdline + Tgid → Tasks 5–6.
  - § Decision tree four steps → Tasks 2 (steps 1, 2, 4), 5 (step 3).
  - § Backwards compat (legacy lock without argv1) → Task 8 (test 1).
  - § Non-Linux conservative throw → Task 8 (test 2).
  - § Edge case: zombie cmdline empty → covered implicitly by Task 5's logic (filter Boolean → empty array → not includes argv1 → false). Not separately tested — low value vs. cost.
  - § Edge case: `process.argv[1]` undefined → covered implicitly by `process.argv[1] ?? ""` in Task 1's write code; legacy-test in Task 8 covers the read-side behavior.
  - § Acceptance criteria 1 (post-reboot 200) → Task 2 test (predates boot → overwrite).
  - § Acceptance criteria 2 (live prorab still 409) → Task 7.
  - § Acceptance criteria 6 (`npm run build` & `npm test`) → Task 9.
- **No placeholders.** Every step has either exact code, exact command, or exact expected output.
- **Type consistency.** `getBootTime: () => number | null`, `isProrabProcess: (number, string | undefined) => boolean | null`, lock-data shape `{ pid, startedAt, argv1? }` — used identically across all tasks.
- **Granularity.** Each task is 4–5 steps, each step 2–5 minutes.
