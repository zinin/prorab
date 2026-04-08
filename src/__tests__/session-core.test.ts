import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock the lock module ────────────────────────────────────────────────
const { mockAcquireLock, mockReleaseLock } = vi.hoisted(() => ({
  mockAcquireLock: vi.fn(),
  mockReleaseLock: vi.fn(),
}));
vi.mock("../core/lock.js", () => ({
  acquireLock: mockAcquireLock,
  releaseLock: mockReleaseLock,
}));

import { SessionCore } from "../server/session/session-core.js";

describe("SessionCore", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-session-core-test-"));
    mockAcquireLock.mockReset();
    mockReleaseLock.mockReset();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  // ── Initial state ──────────────────────────────────────────────────

  it("initialises in idle state", () => {
    const session = new SessionCore(cwd);
    expect(session.state).toBe("idle");
    expect(session.isIdle()).toBe(true);
    expect(session.isActive()).toBe(false);
    expect(session.isStopping()).toBe(false);
  });

  it("getAbortSignal() returns undefined when idle", () => {
    const session = new SessionCore(cwd);
    expect(session.getAbortSignal()).toBeUndefined();
  });

  // ── acquire() ──────────────────────────────────────────────────────

  it("acquire() transitions idle → active and creates AbortController", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    try {
      expect(session.state).toBe("active");
      expect(session.isActive()).toBe(true);
      expect(session.isIdle()).toBe(false);
      expect(session.getAbortSignal()).toBeInstanceOf(AbortSignal);
    } finally {
      session.release();
    }
  });

  it("acquire() calls acquireLock with cwd", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    try {
      expect(mockAcquireLock).toHaveBeenCalledOnce();
      expect(mockAcquireLock).toHaveBeenCalledWith(cwd);
    } finally {
      session.release();
    }
  });

  it("acquire() throws when already active", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    try {
      expect(() => session.acquire()).toThrow("Cannot acquire: session is active");
    } finally {
      session.release();
    }
  });

  it("acquire() throws when stopping", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    session.abort();
    try {
      expect(session.state).toBe("stopping");
      expect(() => session.acquire()).toThrow(
        "Cannot acquire: session is stopping",
      );
    } finally {
      session.release();
    }
  });

  it("acquire() does not change state when acquireLock throws", () => {
    mockAcquireLock.mockImplementation(() => {
      throw new Error("Lock held by another process");
    });
    const session = new SessionCore(cwd);
    expect(() => session.acquire()).toThrow("Lock held by another process");
    expect(session.state).toBe("idle");
    expect(session.isIdle()).toBe(true);
    expect(session.getAbortSignal()).toBeUndefined();
  });

  // ── release() ─────────────────────────────────────────────────────

  it("release() transitions to idle and clears AbortController", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    session.release();
    expect(session.state).toBe("idle");
    expect(session.isIdle()).toBe(true);
    expect(session.getAbortSignal()).toBeUndefined();
  });

  it("release() calls releaseLock with cwd", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    session.release();
    expect(mockReleaseLock).toHaveBeenCalledOnce();
    expect(mockReleaseLock).toHaveBeenCalledWith(cwd);
  });

  it("release() does not call releaseLock if lock was never acquired", () => {
    const session = new SessionCore(cwd);
    session.release(); // should not throw
    expect(session.state).toBe("idle");
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it("release() is safe to call when already idle", () => {
    const session = new SessionCore(cwd);
    session.release(); // should not throw
    expect(session.state).toBe("idle");
  });

  it("release() resets from stopping to idle", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    session.abort();
    expect(session.state).toBe("stopping");
    session.release();
    expect(session.state).toBe("idle");
    expect(session.isIdle()).toBe(true);
    expect(session.getAbortSignal()).toBeUndefined();
  });

  // ── re-acquire ────────────────────────────────────────────────────

  it("acquire() succeeds after release() (re-acquire)", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    session.release();
    expect(session.isIdle()).toBe(true);

    session.acquire();
    try {
      expect(session.state).toBe("active");
      expect(session.isActive()).toBe(true);
      expect(session.getAbortSignal()).toBeInstanceOf(AbortSignal);
    } finally {
      session.release();
    }
  });

  it("re-acquire creates a fresh AbortSignal", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    const signal1 = session.getAbortSignal();
    session.release();

    session.acquire();
    const signal2 = session.getAbortSignal();
    session.release();

    expect(signal1).not.toBe(signal2);
  });

  // ── abort() ───────────────────────────────────────────────────────

  it("abort() transitions to stopping and signals abort", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    const signal = session.getAbortSignal()!;
    expect(signal.aborted).toBe(false);

    session.abort();
    expect(session.state).toBe("stopping");
    expect(session.isStopping()).toBe(true);
    expect(signal.aborted).toBe(true);

    session.release();
  });

  it("abort() when idle sets state to stopping without error", () => {
    const session = new SessionCore(cwd);
    session.abort(); // no AbortController — should not throw
    expect(session.state).toBe("stopping");
    expect(session.isStopping()).toBe(true);
  });

  // ── registerAbortHandler() ────────────────────────────────────────

  it("registerAbortHandler() fires callback on abort", () => {
    const session = new SessionCore(cwd);
    session.acquire();

    let called = false;
    session.registerAbortHandler(() => {
      called = true;
    });

    session.abort();
    expect(called).toBe(true);

    session.release();
  });

  it("registerAbortHandler() supports multiple handlers", () => {
    const session = new SessionCore(cwd);
    session.acquire();

    const calls: string[] = [];
    session.registerAbortHandler(() => calls.push("a"));
    session.registerAbortHandler(() => calls.push("b"));
    session.registerAbortHandler(() => calls.push("c"));

    session.abort();
    expect(calls).toEqual(["a", "b", "c"]);

    session.release();
  });

  it("registerAbortHandler() queues handler when idle, fires on abort after acquire", () => {
    const session = new SessionCore(cwd);
    let called = false;
    // Register while idle — handler should be queued
    session.registerAbortHandler(() => {
      called = true;
    });

    session.acquire();
    expect(called).toBe(false); // not yet

    session.abort();
    expect(called).toBe(true);

    session.release();
  });

  it("pending abort handlers are cleared after acquire", () => {
    const session = new SessionCore(cwd);
    let callCount = 0;
    session.registerAbortHandler(() => {
      callCount++;
    });

    // First cycle — handler fires
    session.acquire();
    session.abort();
    expect(callCount).toBe(1);
    session.release();

    // Second cycle — handler should NOT fire again (was cleared)
    session.acquire();
    session.abort();
    expect(callCount).toBe(1);
    session.release();
  });

  it("multiple pending handlers all fire after acquire + abort", () => {
    const session = new SessionCore(cwd);
    const calls: number[] = [];
    session.registerAbortHandler(() => calls.push(1));
    session.registerAbortHandler(() => calls.push(2));

    session.acquire();
    session.abort();
    expect(calls).toEqual([1, 2]);

    session.release();
  });

  it("handler registered after abort on active session fires immediately", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    session.abort();

    // When registering a handler on an already-aborted session (stopping state),
    // the handler is invoked synchronously so it is not silently lost.
    let called = false;
    session.registerAbortHandler(() => {
      called = true;
    });
    expect(called).toBe(true);

    session.release();
  });

  // ── acquire({ skipLock }) ────────────────────────────────────────

  it("acquire({ skipLock: true }) transitions to active without calling acquireLock", () => {
    const session = new SessionCore(cwd);
    session.acquire({ skipLock: true });
    try {
      expect(session.state).toBe("active");
      expect(session.isActive()).toBe(true);
      expect(session.getAbortSignal()).toBeInstanceOf(AbortSignal);
      expect(mockAcquireLock).not.toHaveBeenCalled();
    } finally {
      session.release();
    }
  });

  it("release() does not call releaseLock after acquire({ skipLock: true })", () => {
    const session = new SessionCore(cwd);
    session.acquire({ skipLock: true });
    session.release();
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it("acquire({ skipLock: true }) does not bootstrap .taskmaster/", () => {
    const session = new SessionCore(cwd);
    session.acquire({ skipLock: true });
    try {
      expect(existsSync(join(cwd, ".taskmaster"))).toBe(false);
    } finally {
      session.release();
    }
  });

  // ── cwd property ───────────────────────────────────────────────────

  it("exposes cwd as a readonly property", () => {
    const session = new SessionCore(cwd);
    expect(session.cwd).toBe(cwd);
  });

  // ── bootstrap .taskmaster/ ────────────────────────────────────────

  it("bootstraps .taskmaster/ directory on acquire if missing", () => {
    const session = new SessionCore(cwd);
    expect(existsSync(join(cwd, ".taskmaster"))).toBe(false);

    session.acquire();
    try {
      expect(existsSync(join(cwd, ".taskmaster"))).toBe(true);
    } finally {
      session.release();
    }
  });

  it("acquire() does not fail if .taskmaster/ already exists", () => {
    mkdirSync(join(cwd, ".taskmaster"), { recursive: true });
    const session = new SessionCore(cwd);
    expect(() => session.acquire()).not.toThrow();
    session.release();
  });

  // ── Full lifecycle ────────────────────────────────────────────────

  it("full lifecycle: idle → acquire → abort → release → re-acquire → release", () => {
    const session = new SessionCore(cwd);
    expect(session.state).toBe("idle");

    session.acquire();
    expect(session.state).toBe("active");
    expect(mockAcquireLock).toHaveBeenCalledTimes(1);

    session.abort();
    expect(session.state).toBe("stopping");

    session.release();
    expect(session.state).toBe("idle");
    expect(mockReleaseLock).toHaveBeenCalledTimes(1);

    session.acquire();
    expect(session.state).toBe("active");
    expect(mockAcquireLock).toHaveBeenCalledTimes(2);

    session.release();
    expect(session.state).toBe("idle");
    expect(mockReleaseLock).toHaveBeenCalledTimes(2);
  });
});
