import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionCore } from "../server/session/session-core.js";

/**
 * Integration tests for SessionCore using real file locks (no mocks).
 * Verifies the "one active session" guarantee via actual acquireLock/releaseLock.
 */
describe("SessionCore integration (real file lock)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-session-core-integ-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("acquire() creates the lock file on disk", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    try {
      expect(existsSync(join(cwd, ".taskmaster", "prorab.lock"))).toBe(true);
    } finally {
      session.release();
    }
  });

  it("release() removes the lock file from disk", () => {
    const session = new SessionCore(cwd);
    session.acquire();
    session.release();
    expect(existsSync(join(cwd, ".taskmaster", "prorab.lock"))).toBe(false);
  });

  it("second acquire() on same cwd fails while first session is active", () => {
    const session1 = new SessionCore(cwd);
    const session2 = new SessionCore(cwd);

    session1.acquire();
    try {
      expect(() => session2.acquire()).toThrow(/already running/);
      // session2 should remain idle after the failed acquire
      expect(session2.state).toBe("idle");
    } finally {
      session1.release();
    }
  });

  it("second acquire() succeeds after first session releases", () => {
    const session1 = new SessionCore(cwd);
    const session2 = new SessionCore(cwd);

    session1.acquire();
    session1.release();

    // Now session2 should be able to acquire
    session2.acquire();
    try {
      expect(session2.state).toBe("active");
      expect(existsSync(join(cwd, ".taskmaster", "prorab.lock"))).toBe(true);
    } finally {
      session2.release();
    }
  });

  it("acquire({ skipLock: true }) does not create a lock file", () => {
    const session = new SessionCore(cwd);
    session.acquire({ skipLock: true });
    try {
      expect(session.state).toBe("active");
      // .taskmaster/ may not even exist since bootstrap is skipped with skipLock
      const lockExists = existsSync(join(cwd, ".taskmaster", "prorab.lock"));
      expect(lockExists).toBe(false);
    } finally {
      session.release();
    }
  });

  it("full lifecycle with real locks: acquire → abort → release → re-acquire", () => {
    const session = new SessionCore(cwd);

    session.acquire();
    expect(session.state).toBe("active");
    expect(existsSync(join(cwd, ".taskmaster", "prorab.lock"))).toBe(true);

    session.abort();
    expect(session.state).toBe("stopping");
    // Lock file still exists during stopping
    expect(existsSync(join(cwd, ".taskmaster", "prorab.lock"))).toBe(true);

    session.release();
    expect(session.state).toBe("idle");
    expect(existsSync(join(cwd, ".taskmaster", "prorab.lock"))).toBe(false);

    // Re-acquire should work
    session.acquire();
    expect(session.state).toBe("active");
    expect(existsSync(join(cwd, ".taskmaster", "prorab.lock"))).toBe(true);
    session.release();
  });
});
