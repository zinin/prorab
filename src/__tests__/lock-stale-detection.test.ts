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

  it("removes lock when PID is alive but /proc/<pid>/cwd points elsewhere", () => {
    writeLock(tempDir, {
      pid: 99999996,
      startedAt: new Date().toISOString(),    // recent — passes btime gate
    });

    killSpy.mockImplementation(((_pid: number, _signal?: string | number) => true) as typeof process.kill);

    readMock.mockImplementation(((path: Parameters<typeof readFileSync>[0], ...args: unknown[]) => {
      const p = String(path);
      // Tgid matches PID → not a thread, proceed to cwd check
      if (p === "/proc/99999996/status") return "Name: other\nTgid:\t99999996\nPid:\t99999996\n";
      return actualReadFileSync(path, ...(args as []));
    }) as typeof readFileSync);

    readlinkMock.mockImplementation(((path: Parameters<typeof readlinkSync>[0], ...args: unknown[]) => {
      if (String(path) === "/proc/99999996/cwd") return "/some/other/dir";
      return actualReadlinkSync(path, ...(args as []));
    }) as typeof readlinkSync);

    acquireLock(tempDir);

    const data = readLockJson(tempDir);
    expect(data.pid).toBe(process.pid);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("reused by non-prorab"));
  });

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

  it("throws when lock file contains our own PID (self-pid short-circuit)", () => {
    // Lock contains process.pid → only we could have written it.  Refuse to
    // overwrite even when /proc/<self>/cwd does not match the locked cwd
    // (the typical situation in vitest where worker cwd is the project root,
    // not the test's tempDir).
    writeLock(tempDir, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    expect(() => acquireLock(tempDir)).toThrow(/already running/);
    // Lock file must be preserved on throw, not silently overwritten.
    expect(readLockJson(tempDir).pid).toBe(process.pid);
  });
});
