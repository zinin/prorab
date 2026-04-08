import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before dynamic import of the module under test
// ---------------------------------------------------------------------------

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: vi.fn(() => ({})),
}));

/**
 * Mock child_process.spawn — returns an EventEmitter with pid, stdout, stderr.
 * Each test controls when (or whether) the ready line is emitted.
 */
let mockProc: any;

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  return {
    spawn: vi.fn((): any => {
      const proc: any = new EventEmitter();
      proc.pid = 42000;
      proc.exitCode = null;
      proc.signalCode = null;
      proc.kill = vi.fn();
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      mockProc = proc;
      return proc;
    }),
  };
});

// Import AFTER mocks are registered
const { OpenCodeDriver } = await import("../core/drivers/opencode.js");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenCodeDriver lifecycle", () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockProc = null;
    processKillSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as any);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("teardown sends SIGTERM then SIGKILL to process group", async () => {
    const driver = new OpenCodeDriver("test/model");

    // Setup: emit ready line on next tick so setup() resolves
    const setupPromise = driver.setup({ verbosity: "quiet" });
    // Wait a tick for spawn to be called and mockProc to be assigned
    await new Promise((r) => setTimeout(r, 0));
    expect(mockProc).toBeTruthy();

    // Emit ready line
    mockProc.stdout.push("opencode server listening on http://127.0.0.1:5555\n");
    await setupPromise;

    // Reset spy to only track teardown calls
    processKillSpy.mockClear();

    // Simulate process already exited (so teardown doesn't wait)
    mockProc.exitCode = 0;

    await driver.teardown();

    // Verify SIGTERM sent to process group (negative PID)
    expect(processKillSpy).toHaveBeenCalledWith(-42000, "SIGTERM");
    // Verify SIGKILL sent unconditionally after
    expect(processKillSpy).toHaveBeenCalledWith(-42000, "SIGKILL");

    // SIGTERM must come before SIGKILL
    const calls = processKillSpy.mock.calls;
    const termIdx = calls.findIndex((c: unknown[]) => c[1] === "SIGTERM");
    const killIdx = calls.findIndex((c: unknown[]) => c[1] === "SIGKILL");
    expect(termIdx).toBeLessThan(killIdx);
  });

  it("setup timeout triggers two-phase kill", async () => {
    vi.useFakeTimers();
    const driver = new OpenCodeDriver("test/model");

    // Don't emit ready line — let it timeout.
    // Attach .catch() immediately to prevent Node's "unhandled rejection"
    // warning: the rejection fires synchronously inside fake timer advancement,
    // before the try/catch in setup() can schedule its microtask handler.
    let caughtError: Error | null = null;
    const setupPromise = driver.setup({ verbosity: "quiet" }).catch((err) => {
      caughtError = err;
    });

    // runAllTimersAsync drains all pending timers including those created by
    // the catch handler (the 5s grace wait after the 15s startup timeout).
    await vi.runAllTimersAsync();
    await setupPromise;

    expect(caughtError).toBeTruthy();
    expect(caughtError!.message).toContain("Timeout");

    // Verify two-phase kill sequence
    expect(processKillSpy).toHaveBeenCalledWith(-42000, "SIGTERM");
    expect(processKillSpy).toHaveBeenCalledWith(-42000, "SIGKILL");

    vi.useRealTimers();
  });

  it("teardown without setup is a no-op", async () => {
    const driver = new OpenCodeDriver("test/model");
    // Should not throw
    await driver.teardown();
    expect(processKillSpy).not.toHaveBeenCalled();
  });

  it("double setup without teardown throws", async () => {
    const driver = new OpenCodeDriver("test/model");

    // First setup
    const setupPromise = driver.setup({ verbosity: "quiet" });
    await new Promise((r) => setTimeout(r, 0));
    mockProc.stdout.push("opencode server listening on http://127.0.0.1:5555\n");
    await setupPromise;

    // Second setup without teardown
    await expect(
      driver.setup({ verbosity: "quiet" }),
    ).rejects.toThrow("already initialized");

    // Cleanup
    mockProc.exitCode = 0;
    await driver.teardown();
  });

  it("abort during startup triggers two-phase kill", async () => {
    const ac = new AbortController();
    const driver = new OpenCodeDriver("test/model");

    // Start setup but do NOT emit the ready line — abort will fire first
    let caughtError: Error | null = null;
    const setupPromise = driver.setup({
      verbosity: "quiet",
      abortSignal: ac.signal,
    }).catch((err) => {
      caughtError = err;
    });

    // Wait for spawn to happen and mockProc to be assigned
    await new Promise((r) => setTimeout(r, 0));
    expect(mockProc).toBeTruthy();

    // Abort while waiting for ready line
    ac.abort();

    // Allow microtasks/timers from the catch handler (5s grace wait) to drain.
    // The catch block waits up to 5s for exit; simulate immediate exit.
    await new Promise((r) => setTimeout(r, 0));
    mockProc.exitCode = 0;
    mockProc.emit("exit", 0, null);
    await setupPromise;

    // Verify rejection with correct message
    expect(caughtError).toBeTruthy();
    expect(caughtError!.message).toBe("Aborted during startup");

    // Verify two-phase kill happened (SIGTERM from abort handler + catch block,
    // then SIGKILL from catch block)
    expect(processKillSpy).toHaveBeenCalledWith(-42000, "SIGTERM");
    expect(processKillSpy).toHaveBeenCalledWith(-42000, "SIGKILL");

    // Verify abort handler was cleaned up (removeEventListener was called)
    // After setup rejects, driver state should be reset
    // A second setup should work (proves cleanup happened)
  });

  it("setup handles ready line split across multiple chunks", async () => {
    const driver = new OpenCodeDriver("test/model");

    const setupPromise = driver.setup({ verbosity: "quiet" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockProc).toBeTruthy();

    // Emit the ready line in two chunks, splitting mid-URL
    mockProc.stdout.push("opencode server listening on http://127.0");
    mockProc.stdout.push(".0.1:5555\n");
    await setupPromise;

    // Cleanup
    mockProc.exitCode = 0;
    await driver.teardown();
  });

  it("setup with pre-aborted signal throws immediately", async () => {
    const driver = new OpenCodeDriver("test/model");
    const ac = new AbortController();
    ac.abort();

    await expect(
      driver.setup({ verbosity: "quiet", abortSignal: ac.signal }),
    ).rejects.toThrow("Aborted before setup");

    // No process should have been spawned
    expect(processKillSpy).not.toHaveBeenCalled();
  });
});
