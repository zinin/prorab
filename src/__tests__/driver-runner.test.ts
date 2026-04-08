import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock the driver factory ─────────────────────────────────────────
const { mockCreateDriver } = vi.hoisted(() => ({
  mockCreateDriver: vi.fn(),
}));
vi.mock("../core/drivers/factory.js", () => ({
  createDriver: mockCreateDriver,
}));

import { DriverRunner } from "../server/session/driver-runner.js";
import type { AgentDriver, SessionOptions, SetupOptions } from "../core/drivers/types.js";
import type { IterationResult, OnLogCallback } from "../types.js";
import { chatStubs } from "./helpers/driver-stubs.js";

/** Helper: build a minimal AgentDriver stub. */
function stubDriver(overrides: Partial<AgentDriver> = {}): AgentDriver {
  return {
    runSession: vi.fn().mockResolvedValue({}),
    ...chatStubs,
    ...overrides,
  };
}

/** Helper: build a minimal SessionOptions stub (without onLog). */
function stubSessionOpts(
  overrides: Partial<Omit<SessionOptions, "onLog">> = {},
): Omit<SessionOptions, "onLog"> {
  return {
    prompt: "test",
    systemPrompt: "system",
    cwd: "/tmp",
    maxTurns: 10,
    verbosity: "info",
    unitId: "1",
    ...overrides,
  };
}

describe("DriverRunner", () => {
  beforeEach(() => {
    mockCreateDriver.mockReset();
  });

  // ── Constructor & initial state ───────────────────────────────────

  it("initialises with setupDone === false", () => {
    const runner = new DriverRunner("claude");
    expect(runner.setupDone).toBe(false);
  });

  it("stores agent type", () => {
    const runner = new DriverRunner("opencode");
    expect(runner.agent).toBe("opencode");
  });

  it("stores model when provided", () => {
    const runner = new DriverRunner("claude", "claude-opus-4-6");
    expect(runner.model).toBe("claude-opus-4-6");
  });

  it("model is undefined when not provided", () => {
    const runner = new DriverRunner("claude");
    expect(runner.model).toBeUndefined();
  });

  it("userSettings defaults to false", () => {
    const runner = new DriverRunner("claude");
    expect(runner.userSettings).toBe(false);
  });

  it("accepts userSettings = false", () => {
    const runner = new DriverRunner("claude", undefined, false);
    expect(runner.userSettings).toBe(false);
  });

  it("accepts all three parameters", () => {
    const runner = new DriverRunner("opencode", "anthropic/claude-opus-4-6", false);
    expect(runner.agent).toBe("opencode");
    expect(runner.model).toBe("anthropic/claude-opus-4-6");
    expect(runner.userSettings).toBe(false);
  });

  // ── setup() ───────────────────────────────────────────────────────

  it("setup() creates driver and sets setupDone", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude", "test-model", false);
    await runner.setup({ verbosity: "info" });

    expect(mockCreateDriver).toHaveBeenCalledWith("claude", "test-model", false, false);
    expect(runner.setupDone).toBe(true);
  });

  it("setup() calls driver.setup() when defined", async () => {
    const setupFn = vi.fn().mockResolvedValue(undefined);
    const driver = stubDriver({ setup: setupFn });
    mockCreateDriver.mockReturnValue(driver);

    const opts: SetupOptions = { verbosity: "debug", abortSignal: new AbortController().signal };
    const runner = new DriverRunner("opencode");
    await runner.setup(opts);

    expect(setupFn).toHaveBeenCalledWith(opts);
  });

  it("setup() works when driver has no setup hook", async () => {
    const driver = stubDriver();
    // Explicitly no setup method
    delete (driver as any).setup;
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "quiet" });

    expect(runner.setupDone).toBe(true);
  });

  it("setup() throws when called twice without teardown", async () => {
    mockCreateDriver.mockReturnValue(stubDriver());

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });

    await expect(runner.setup({ verbosity: "info" })).rejects.toThrow(
      "already set up",
    );
  });

  // ── teardown() ────────────────────────────────────────────────────

  it("teardown() calls driver.teardown() and resets state", async () => {
    const teardownFn = vi.fn().mockResolvedValue(undefined);
    mockCreateDriver.mockReturnValue(stubDriver({ teardown: teardownFn }));

    const runner = new DriverRunner("opencode");
    await runner.setup({ verbosity: "info" });
    await runner.teardown();

    expect(teardownFn).toHaveBeenCalledOnce();
    expect(runner.setupDone).toBe(false);
  });

  it("teardown() is a no-op when not set up", async () => {
    const runner = new DriverRunner("claude");
    await expect(runner.teardown()).resolves.toBeUndefined();
    expect(runner.setupDone).toBe(false);
  });

  it("teardown() resets state even if driver.teardown() throws", async () => {
    const teardownFn = vi.fn().mockRejectedValue(new Error("teardown failed"));
    mockCreateDriver.mockReturnValue(stubDriver({ teardown: teardownFn }));

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });

    await expect(runner.teardown()).rejects.toThrow("teardown failed");
    expect(runner.setupDone).toBe(false);
  });

  it("setup() succeeds after teardown() (re-setup)", async () => {
    mockCreateDriver.mockReturnValue(stubDriver());

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });
    await runner.teardown();
    await runner.setup({ verbosity: "debug" });

    expect(runner.setupDone).toBe(true);
  });

  // ── getDriver() ───────────────────────────────────────────────────

  it("getDriver() returns the driver after setup", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });

    expect(runner.getDriver()).toBe(driver);
  });

  it("getDriver() throws when not set up", () => {
    const runner = new DriverRunner("claude");
    expect(() => runner.getDriver()).toThrow("not initialised");
  });

  it("getDriver() throws after teardown", async () => {
    mockCreateDriver.mockReturnValue(stubDriver());

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });
    await runner.teardown();

    expect(() => runner.getDriver()).toThrow("not initialised");
  });

  // ── listModels() ──────────────────────────────────────────────────

  it("listModels() delegates to driver.listModels()", async () => {
    const models = [{ id: "m1", name: "Model 1" }];
    const listModelsFn = vi.fn().mockResolvedValue(models);
    mockCreateDriver.mockReturnValue(stubDriver({ listModels: listModelsFn }));

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });

    const result = await runner.listModels();
    expect(result).toEqual(models);
    expect(listModelsFn).toHaveBeenCalledOnce();
  });

  it("listModels() returns empty array when driver has no listModels", async () => {
    const driver = stubDriver();
    delete (driver as any).listModels;
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });

    const result = await runner.listModels();
    expect(result).toEqual([]);
  });

  it("listModels() throws when not set up", async () => {
    const runner = new DriverRunner("claude");
    await expect(runner.listModels()).rejects.toThrow("not initialised");
  });

  // ── setOnLog() ───────────────────────────────────────────────────

  it("setOnLog() stores the callback", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const onLog: OnLogCallback = vi.fn();
    const runner = new DriverRunner("claude");
    runner.setOnLog(onLog);

    await runner.setup({ verbosity: "info" });

    // Verify it was stored by running a session and checking onLog is passed
    await runner.runSession(stubSessionOpts());
    expect(driver.runSession).toHaveBeenCalledWith(
      expect.objectContaining({ onLog }),
    );
  });

  it("setOnLog(undefined) clears the callback", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const onLog: OnLogCallback = vi.fn();
    const runner = new DriverRunner("claude");
    runner.setOnLog(onLog);
    runner.setOnLog(undefined);

    await runner.setup({ verbosity: "info" });
    await runner.runSession(stubSessionOpts());

    expect(driver.runSession).toHaveBeenCalledWith(
      expect.objectContaining({ onLog: undefined }),
    );
  });

  // ── runSession() ────────────────────────────────────────────────

  it("runSession() injects onLog into driver.runSession()", async () => {
    const onLog: OnLogCallback = vi.fn();
    const fakeResult: IterationResult = {
      signal: { type: "complete" },
      durationMs: 100,
      costUsd: 0.01,
      numTurns: 1,
      resultText: "done",
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      model: "test-model",
      agentReport: null,
      reviewReport: null,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
    };
    const driver = stubDriver({
      runSession: vi.fn().mockResolvedValue(fakeResult),
    });
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude");
    runner.setOnLog(onLog);
    await runner.setup({ verbosity: "info" });

    const opts = stubSessionOpts();
    const result = await runner.runSession(opts);

    expect(result).toBe(fakeResult);
    expect(driver.runSession).toHaveBeenCalledWith({ ...opts, onLog });
  });

  it("runSession() works without onLog set (passes undefined)", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });

    const opts = stubSessionOpts();
    await runner.runSession(opts);

    expect(driver.runSession).toHaveBeenCalledWith({ ...opts, onLog: undefined });
  });

  it("runSession() throws when not set up", async () => {
    const runner = new DriverRunner("claude");
    await expect(runner.runSession(stubSessionOpts())).rejects.toThrow(
      "not initialised",
    );
  });

  it("runSession() passes all session options through", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });

    const controller = new AbortController();
    const opts: Omit<SessionOptions, "onLog"> = {
      prompt: "test prompt",
      systemPrompt: "system",
      cwd: "/tmp/test",
      maxTurns: 5,
      abortController: controller,
      verbosity: "debug",
      variant: "high",
      unitId: "1.2",
    };

    await runner.runSession(opts);

    expect(driver.runSession).toHaveBeenCalledWith({
      ...opts,
      onLog: undefined,
    });
  });

  // ── setup() + abortSignal ──────────────────────────────────────

  it("setup() forwards abortSignal to driver.setup()", async () => {
    const setupFn = vi.fn().mockResolvedValue(undefined);
    const driver = stubDriver({ setup: setupFn });
    mockCreateDriver.mockReturnValue(driver);

    const ac = new AbortController();
    const runner = new DriverRunner("opencode");
    await runner.setup({ verbosity: "info", abortSignal: ac.signal });

    expect(setupFn).toHaveBeenCalledWith({
      verbosity: "info",
      abortSignal: ac.signal,
    });
  });

  it("setup() works without abortSignal", async () => {
    const setupFn = vi.fn().mockResolvedValue(undefined);
    const driver = stubDriver({ setup: setupFn });
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "quiet" });

    expect(setupFn).toHaveBeenCalledWith({ verbosity: "quiet" });
  });

  // ── setup() + onLog parameter ─────────────────────────────────────

  it("setup() accepts onLog and stores it for runSession injection", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const onLog: OnLogCallback = vi.fn();
    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" }, onLog);

    await runner.runSession(stubSessionOpts());
    expect(driver.runSession).toHaveBeenCalledWith(
      expect.objectContaining({ onLog }),
    );
  });

  it("setup() without onLog preserves previously set callback", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const onLog: OnLogCallback = vi.fn();
    const runner = new DriverRunner("claude");
    runner.setOnLog(onLog);
    await runner.setup({ verbosity: "info" }); // no onLog param

    await runner.runSession(stubSessionOpts());
    expect(driver.runSession).toHaveBeenCalledWith(
      expect.objectContaining({ onLog }),
    );
  });

  it("setup() onLog overrides previously set callback", async () => {
    const driver = stubDriver();
    mockCreateDriver.mockReturnValue(driver);

    const oldLog: OnLogCallback = vi.fn();
    const newLog: OnLogCallback = vi.fn();
    const runner = new DriverRunner("claude");
    runner.setOnLog(oldLog);
    await runner.setup({ verbosity: "info" }, newLog);

    await runner.runSession(stubSessionOpts());
    expect(driver.runSession).toHaveBeenCalledWith(
      expect.objectContaining({ onLog: newLog }),
    );
  });

  // ── setup() failure cleanup ───────────────────────────────────────

  it("setup() cleans up driver when driver.setup() throws", async () => {
    const teardownFn = vi.fn().mockResolvedValue(undefined);
    const setupFn = vi.fn().mockRejectedValue(new Error("setup boom"));
    const driver = stubDriver({ setup: setupFn, teardown: teardownFn });
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("opencode");
    await expect(runner.setup({ verbosity: "info" })).rejects.toThrow("setup boom");

    // teardown was called to clean up the partially-initialised driver
    expect(teardownFn).toHaveBeenCalledOnce();
    // runner remains in uninitialised state
    expect(runner.setupDone).toBe(false);
    expect(() => runner.getDriver()).toThrow("not initialised");
  });

  it("setup() failure cleanup ignores teardown errors", async () => {
    const setupFn = vi.fn().mockRejectedValue(new Error("setup boom"));
    const teardownFn = vi.fn().mockRejectedValue(new Error("teardown boom"));
    const driver = stubDriver({ setup: setupFn, teardown: teardownFn });
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("opencode");
    // Original setup error is thrown, not the teardown error
    await expect(runner.setup({ verbosity: "info" })).rejects.toThrow("setup boom");
    expect(teardownFn).toHaveBeenCalledOnce();
    expect(runner.setupDone).toBe(false);
  });

  it("setup() can be retried after a failed setup", async () => {
    const setupFn = vi.fn().mockRejectedValueOnce(new Error("transient"));
    const driver = stubDriver({ setup: setupFn });
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("opencode");
    await expect(runner.setup({ verbosity: "info" })).rejects.toThrow("transient");

    // Second attempt succeeds (setup mock no longer rejects)
    setupFn.mockResolvedValue(undefined);
    await runner.setup({ verbosity: "info" });
    expect(runner.setupDone).toBe(true);
  });

  // ── abort signal interruption during active session ───────────────

  it("abort signal interrupts an active runSession", async () => {
    const ac = new AbortController();
    // Simulate a long-running session that resolves only when aborted
    const driver = stubDriver({
      runSession: vi.fn().mockImplementation((opts: SessionOptions) => {
        return new Promise<IterationResult>((resolve) => {
          if (opts.abortController) {
            opts.abortController.signal.addEventListener("abort", () => {
              resolve({
                signal: { type: "none" },
                durationMs: 0,
                costUsd: 0,
                numTurns: 0,
                resultText: "aborted",
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
                model: "test",
                agentReport: null,
                reviewReport: null,
                startedAt: "",
                finishedAt: "",
              });
            });
          }
        });
      }),
    });
    mockCreateDriver.mockReturnValue(driver);

    const runner = new DriverRunner("claude");
    await runner.setup({ verbosity: "info" });

    // Start a session with an AbortController
    const sessionPromise = runner.runSession(
      stubSessionOpts({ abortController: ac }),
    );

    // Abort mid-session
    ac.abort();

    const result = await sessionPromise;
    expect(result.resultText).toBe("aborted");
    expect(driver.runSession).toHaveBeenCalledOnce();
  });
});
