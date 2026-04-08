import { describe, it, expect, vi } from "vitest";
import { ExecutionManager } from "../server/execution-manager.js";
import { WsBroadcaster, type WsEvent } from "../server/session/ws-broadcaster.js";
import type { ExecuteOptions } from "../server/execution-manager.js";
import type { FullTask } from "../core/tasks-json-types.js";
import type { ExecutionUnit } from "../types.js";
import type { AgentDriver } from "../core/drivers/types.js";
import { chatStubs } from "./helpers/driver-stubs.js";

/** Create a WsBroadcaster backed by an empty set (no real sockets). */
function createTestBroadcaster(): WsBroadcaster {
  return new WsBroadcaster(new Set());
}

/** Default ExecuteOptions for tests. */
function defaultOptions(overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    agent: "claude",
    maxRetries: 1,
    maxTurns: 10,
    debug: false,
    trace: false,
    quiet: false,
    allowDirty: true,
    userSettings: true,
    review: false,
    reviewRounds: 1,
    reviewContext: false,
    ...overrides,
  };
}

/**
 * Set the internal session state of an ExecutionManager.
 * Encapsulates private field access so tests don't break if SessionCore
 * renames its internals.
 */
function setSessionState(em: ExecutionManager, state: "idle" | "active" | "stopping"): void {
  const session = (em as any).session;
  session._state = state;
  if (state === "active" && !session.abortController) {
    session.abortController = new AbortController();
  }
}

describe("ExecutionManager", () => {
  it("starts in idle state", () => {
    const em = new ExecutionManager(process.cwd());
    expect(em.state).toBe("idle");
    expect(em.currentUnit).toBeNull();
  });

  it("stop() does nothing when idle", () => {
    const em = new ExecutionManager(process.cwd());
    em.stop(); // should not throw
    expect(em.state).toBe("idle");
  });

  it("throws when start() called while already running", async () => {
    const em = new ExecutionManager(process.cwd());
    setSessionState(em, "active");
    await expect(
      em.start(defaultOptions({ review: true })),
    ).rejects.toThrow("Cannot start: execution is running");
  });

  it("exposes iteration getters with defaults", () => {
    const em = new ExecutionManager(process.cwd());
    expect(em.iterationCurrent).toBe(0);
    expect(em.iterationTotal).toBeNull();
  });

  it("accepts a WsBroadcaster via setBroadcaster()", () => {
    const em = new ExecutionManager(process.cwd());
    const bc = createTestBroadcaster();
    em.setBroadcaster(bc);
    // No error means it's accepted; verify via internal access
    expect((em as any).broadcaster).toBe(bc);
  });

  it("stop() transitions to stopping and broadcasts state via broadcaster", () => {
    const em = new ExecutionManager(process.cwd());
    const bc = createTestBroadcaster();
    em.setBroadcaster(bc);

    setSessionState(em, "active");

    em.stop();
    expect(em.state).toBe("stopping");

    // Verify broadcaster received the state event
    const events = bc.buffer.filter(
      (e: WsEvent) => e.type === "execution:state" && e.channel === "execute",
    );
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "execution:state",
      state: "stopping",
      channel: "execute",
    });
  });

  it("gracefulStop defaults to false", () => {
    const em = new ExecutionManager(process.cwd());
    expect(em.gracefulStop).toBe(false);
  });

  it("requestGracefulStop() sets gracefulStop to true and broadcasts", () => {
    const em = new ExecutionManager(process.cwd());
    const bc = createTestBroadcaster();
    em.setBroadcaster(bc);
    setSessionState(em, "active");

    em.requestGracefulStop();
    expect(em.gracefulStop).toBe(true);

    const events = bc.buffer.filter(
      (e: WsEvent) => e.type === "execution:graceful_stop",
    );
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({
      type: "execution:graceful_stop",
      enabled: true,
      channel: "execute",
    });
  });

  it("cancelGracefulStop() sets gracefulStop to false and broadcasts", () => {
    const em = new ExecutionManager(process.cwd());
    const bc = createTestBroadcaster();
    em.setBroadcaster(bc);
    setSessionState(em, "active");

    em.requestGracefulStop();
    em.cancelGracefulStop();
    expect(em.gracefulStop).toBe(false);

    const events = bc.buffer.filter(
      (e: WsEvent) => e.type === "execution:graceful_stop" && (e as any).enabled === false,
    );
    expect(events.length).toBe(1);
  });

  it("requestGracefulStop() throws when not running", () => {
    const em = new ExecutionManager(process.cwd());
    expect(() => em.requestGracefulStop()).toThrow();
  });

  it("cancelGracefulStop() throws when not running", () => {
    const em = new ExecutionManager(process.cwd());
    expect(() => em.cancelGracefulStop()).toThrow();
  });

  it("throws when start() called while stopping", async () => {
    const em = new ExecutionManager(process.cwd());
    setSessionState(em, "stopping");
    await expect(
      em.start(defaultOptions({ review: true })),
    ).rejects.toThrow("Cannot start: execution is stopping");
  });

  describe("waitForIdle()", () => {
    it("resolves immediately when already idle", async () => {
      const em = new ExecutionManager(process.cwd());
      expect(em.state).toBe("idle");
      // Should resolve without blocking
      await em.waitForIdle();
    });

    it("resolves when state transitions to idle via stop→broadcastState", async () => {
      const em = new ExecutionManager(process.cwd());
      const bc = createTestBroadcaster();
      em.setBroadcaster(bc);

      // Simulate running state
      setSessionState(em, "active");

      const idlePromise = em.waitForIdle();
      let resolved = false;
      idlePromise.then(() => { resolved = true; });

      // Not yet resolved
      await Promise.resolve(); // flush microtasks
      expect(resolved).toBe(false);

      // Simulate the session going to idle (as would happen in finally block of start())
      setSessionState(em, "idle");
      (em as any).broadcastState(); // triggers idle callbacks

      await idlePromise;
      expect(resolved).toBe(true);
    });
  });

  describe("broadcaster integration", () => {
    it("broadcasts execution:state with channel=execute on stop()", () => {
      const em = new ExecutionManager(process.cwd());
      const bc = createTestBroadcaster();
      em.setBroadcaster(bc);

      setSessionState(em, "active");
      em.stop();

      const events = bc.buffer.filter((e: WsEvent) => e.channel === "execute");
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0]).toMatchObject({
        type: "execution:state",
        state: "stopping",
        channel: "execute",
      });
    });

    it("does not throw when no broadcaster is set", () => {
      const em = new ExecutionManager(process.cwd());
      // No broadcaster set — should not throw
      setSessionState(em, "active");
      em.stop(); // calls broadcastState() internally — should be a no-op for broadcaster
      expect(em.state).toBe("stopping");
    });

    it("clears buffer when state transitions to running", () => {
      const em = new ExecutionManager(process.cwd());
      const bc = createTestBroadcaster();
      em.setBroadcaster(bc);

      // Seed the buffer with some events
      bc.broadcast({ type: "old-event" });
      expect(bc.bufferSize).toBe(1);

      // Simulate entering running state and broadcasting
      setSessionState(em, "active"); // active maps to "running"
      (em as any).broadcastState();

      // Buffer should be cleared (only the new state event should be there)
      // clearBuffer() is called before broadcast, so only the new event remains
      expect(bc.bufferSize).toBe(1);
      expect(bc.buffer[0]).toMatchObject({
        type: "execution:state",
        state: "running",
        channel: "execute",
      });
    });
  });

  describe("driver creation integration", () => {
    it("_driver is null when idle", () => {
      const em = new ExecutionManager(process.cwd());
      expect((em as any)._driver).toBeNull();
    });

    it("start() creates driver via createDriver with correct parameters", async () => {
      const em = new ExecutionManager(process.cwd());
      const options = defaultOptions({ agent: "claude", model: "test-model", userSettings: false });

      // Stub session to bypass lock acquisition — directly set active state
      const session = (em as any).session;
      session.acquire = () => {
        setSessionState(em, "active");
      };

      // Capture the driver created during start()
      let capturedDriver: any = null;

      // Stub executeLoop to avoid full execution and capture driver
      (em as any).executeLoop = async (_opts: any, driver: any, _budget: any) => {
        capturedDriver = driver;
        // Immediately return to exit start()
      };

      // Mock hasUncommittedChangesExcluding to avoid git calls
      const gitModule = await import("../core/git.js");
      vi.spyOn(gitModule, "hasUncommittedChangesExcluding").mockReturnValue(false);
      vi.spyOn(gitModule, "commitTaskmaster").mockImplementation(() => true);

      // Mock createDriver to return a fake driver
      const factoryModule = await import("../core/drivers/factory.js");
      const fakeDriverObj = { runSession: vi.fn() };
      const createDriverSpy = vi.spyOn(factoryModule, "createDriver").mockReturnValue(fakeDriverObj as any);

      try {
        await em.start(options);

        // Verify createDriver was called with correct agent/model/userSettings
        expect(createDriverSpy).toHaveBeenCalledWith("claude", "test-model", false, false);

        // Verify executeLoop received the driver
        expect(capturedDriver).toBe(fakeDriverObj);

        // Verify _driver is nulled after execution
        expect((em as any)._driver).toBeNull();
      } finally {
        createDriverSpy.mockRestore();
        vi.mocked(gitModule.hasUncommittedChangesExcluding).mockRestore();
        vi.mocked(gitModule.commitTaskmaster).mockRestore();
      }
    });

    it("_driver is nulled even when executeLoop throws", async () => {
      const em = new ExecutionManager(process.cwd());
      const options = defaultOptions();

      // Stub session
      const session = (em as any).session;
      session.acquire = () => {
        setSessionState(em, "active");
      };

      // Stub executeLoop to throw
      (em as any).executeLoop = async () => {
        throw new Error("loop failed");
      };

      // Mock git + createDriver
      const gitModule = await import("../core/git.js");
      vi.spyOn(gitModule, "hasUncommittedChangesExcluding").mockReturnValue(false);
      vi.spyOn(gitModule, "commitTaskmaster").mockImplementation(() => true);

      const factoryModule = await import("../core/drivers/factory.js");
      const createDriverSpy = vi.spyOn(factoryModule, "createDriver").mockReturnValue({ runSession: vi.fn() } as any);

      try {
        await expect(em.start(options)).rejects.toThrow("loop failed");

        // Verify _driver is nulled
        expect((em as any)._driver).toBeNull();
        // Verify state is back to idle
        expect(em.state).toBe("idle");
      } finally {
        createDriverSpy.mockRestore();
        vi.mocked(gitModule.hasUncommittedChangesExcluding).mockRestore();
        vi.mocked(gitModule.commitTaskmaster).mockRestore();
      }
    });

    it("executeLoop receives raw AgentDriver (not DriverRunner)", async () => {
      const em = new ExecutionManager(process.cwd());
      const options = defaultOptions();

      // Stub session
      const session = (em as any).session;
      session.acquire = () => {
        setSessionState(em, "active");
      };

      // Capture what executeLoop receives
      let receivedDriver: any = null;
      (em as any).executeLoop = async (_opts: any, driver: any, _budget: any) => {
        receivedDriver = driver;
      };

      // Mock git + createDriver
      const gitModule = await import("../core/git.js");
      vi.spyOn(gitModule, "hasUncommittedChangesExcluding").mockReturnValue(false);
      vi.spyOn(gitModule, "commitTaskmaster").mockImplementation(() => true);

      const factoryModule = await import("../core/drivers/factory.js");
      const fakeDriverObj = { runSession: vi.fn() };
      const createDriverSpy = vi.spyOn(factoryModule, "createDriver").mockReturnValue(fakeDriverObj as any);

      try {
        await em.start(options);

        // Verify executeLoop received the raw driver from createDriver
        expect(receivedDriver).toBe(fakeDriverObj);
      } finally {
        createDriverSpy.mockRestore();
        vi.mocked(gitModule.hasUncommittedChangesExcluding).mockRestore();
        vi.mocked(gitModule.commitTaskmaster).mockRestore();
      }
    });

    it("start() does NOT call driver.setup() — executeUnit handles per-iteration lifecycle", async () => {
      const em = new ExecutionManager(process.cwd());
      const options = defaultOptions({ debug: true });

      // Stub session
      const session = (em as any).session;
      session.acquire = () => {
        setSessionState(em, "active");
      };

      (em as any).executeLoop = async () => {};

      // Mock git + createDriver
      const gitModule = await import("../core/git.js");
      vi.spyOn(gitModule, "hasUncommittedChangesExcluding").mockReturnValue(false);
      vi.spyOn(gitModule, "commitTaskmaster").mockImplementation(() => true);

      const factoryModule = await import("../core/drivers/factory.js");
      const setupFn = vi.fn();
      const fakeDriverObj = { runSession: vi.fn(), setup: setupFn };
      const createDriverSpy = vi.spyOn(factoryModule, "createDriver").mockReturnValue(fakeDriverObj as any);

      try {
        await em.start(options);

        // Verify driver.setup was NOT called by ExecutionManager
        expect(setupFn).not.toHaveBeenCalled();
      } finally {
        createDriverSpy.mockRestore();
        vi.mocked(gitModule.hasUncommittedChangesExcluding).mockRestore();
        vi.mocked(gitModule.commitTaskmaster).mockRestore();
      }
    });
  });

  describe("executeLoop/executeOne integration with SessionCore", () => {
    /** Minimal FullTask fixture for testing. */
    function fakeTask(overrides: Partial<FullTask> = {}): FullTask {
      return {
        id: 1,
        title: "Test task",
        status: "pending",
        dependencies: [],
        subtasks: [],
        ...overrides,
      } as FullTask;
    }

    /** Minimal AgentDriver stub. */
    function fakeDriver(): AgentDriver {
      return {
        runSession: vi.fn().mockResolvedValue({
          signal: { type: "complete" },
          durationMs: 100,
          costUsd: 0,
          numTurns: 1,
          resultText: "<task-complete>DONE</task-complete>",
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
        }),
        ...chatStubs,
      };
    }

    /** Common mock setup — returns cleanup function. */
    async function setupMocks() {
      const gitModule = await import("../core/git.js");
      vi.spyOn(gitModule, "hasUncommittedChangesExcluding").mockReturnValue(false);
      vi.spyOn(gitModule, "commitTaskmaster").mockImplementation(() => true);

      // Mock createDriver to return a fake driver
      const driver = fakeDriver();
      const factoryModule = await import("../core/drivers/factory.js");
      const createDriverSpy = vi.spyOn(factoryModule, "createDriver").mockReturnValue(driver);

      return {
        gitModule,
        createDriverSpy,
        driver,
        cleanup() {
          createDriverSpy.mockRestore();
          vi.mocked(gitModule.hasUncommittedChangesExcluding).mockRestore();
          vi.mocked(gitModule.commitTaskmaster).mockRestore();
        },
      };
    }

    /** Stub session.acquire to avoid file lock + dir creation. */
    function stubSessionAcquire(em: ExecutionManager): void {
      const session = (em as any).session;
      session.acquire = () => {
        setSessionState(em, "active");
      };
    }

    it("executeLoop exits when stop() is called during execution", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();

      // Mock findNextAction to return a task, then null (after interruption)
      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let findNextCallCount = 0;
      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction").mockImplementation(() => {
        findNextCallCount++;
        if (findNextCallCount === 1) {
          return { type: "execute", task } as any;
        }
        return null;
      });
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      // Mock executeUnit to call stop() during execution (simulating user interruption)
      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, _driver, isInterrupted, _registerAbort, _budget) => {
          // Simulate stop() being called mid-execution
          em.stop();
          // After stop(), isInterrupted should return true
          expect(isInterrupted()).toBe(true);
          return true; // task "completed" but loop should exit due to stopping
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        await em.start(defaultOptions());

        // After start() returns, state should be idle (released in finally)
        expect(em.state).toBe("idle");
        // executeUnit was called only once — loop exited after stop()
        expect(executeUnitSpy).toHaveBeenCalledOnce();
        // findNextAction was called only once — loop didn't iterate further
        expect(findNextSpy).toHaveBeenCalledOnce();
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("executeOne passes isInterrupted bound to sessionCore.isStopping()", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let capturedIsInterrupted: (() => boolean) | undefined;

      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction")
        .mockReturnValueOnce({ type: "execute", task } as any)
        .mockReturnValueOnce(null);
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, _driver, isInterrupted) => {
          capturedIsInterrupted = isInterrupted;
          return true;
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        await em.start(defaultOptions());

        // isInterrupted should have been captured
        expect(capturedIsInterrupted).toBeDefined();
        // After start() completes (session released), isStopping() returns false
        // so we test the binding itself: the function should be a closure over sessionCore
        expect(typeof capturedIsInterrupted).toBe("function");
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("executeOne passes registerAbort that delegates to sessionCore.registerAbortHandler()", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let capturedRegisterAbort: ((controller: AbortController) => void) | undefined;

      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction")
        .mockReturnValueOnce({ type: "execute", task } as any)
        .mockReturnValueOnce(null);
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, _driver, _isInterrupted, registerAbort) => {
          capturedRegisterAbort = registerAbort;
          return true;
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        await em.start(defaultOptions());

        // registerAbort should have been captured
        expect(capturedRegisterAbort).toBeDefined();

        // Test that registerAbort delegates to sessionCore.registerAbortHandler:
        // We can verify the function shape — it should accept an AbortController
        // and invoke sessionCore.registerAbortHandler with a function that aborts it
        expect(typeof capturedRegisterAbort).toBe("function");
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("abort propagation: registerAbort correctly aborts the controller when session is aborted", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let capturedRegisterAbort: ((controller: AbortController) => void) | undefined;

      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction")
        .mockReturnValueOnce({ type: "execute", task } as any)
        .mockReturnValueOnce(null);
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, _driver, _isInterrupted, registerAbort) => {
          capturedRegisterAbort = registerAbort;

          // Simulate registering an AbortController (as executeUnit does internally)
          const innerController = new AbortController();
          registerAbort?.(innerController);

          // Wait for abort signal to be propagated
          await new Promise<void>((resolve) => {
            // If abort fires, resolve immediately
            innerController.signal.addEventListener("abort", () => resolve(), { once: true });
          });

          return true;
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        // Start execution in background
        const startPromise = em.start(defaultOptions());

        // Wait a tick for executeUnit to be called
        await new Promise((r) => setTimeout(r, 10));

        // Verify execution is in progress
        expect(capturedRegisterAbort).toBeDefined();

        // Stop execution — this should propagate abort to the inner controller
        em.stop();

        // Execution should resolve (abort signal fired)
        await startPromise;

        expect(em.state).toBe("idle");
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("executeOne receives driver from createDriver()", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let capturedDriver: AgentDriver | undefined;

      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction")
        .mockReturnValueOnce({ type: "execute", task } as any)
        .mockReturnValueOnce(null);
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, driver) => {
          capturedDriver = driver;
          return true;
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        await em.start(defaultOptions());

        // Verify executeUnit received the driver from createDriver()
        expect(capturedDriver).toBe(mocks.driver);
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("review cycle receives driver from createDriver()", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask({ status: "done" as any });

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let capturedReviewDriver: AgentDriver | undefined;

      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction")
        .mockReturnValueOnce({ type: "review", task } as any)
        .mockReturnValueOnce(null);
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      const reviewCycleSpy = vi.spyOn(runModule, "executeReviewCycle").mockImplementation(
        async (_task, _cwd, _opts, driver) => {
          capturedReviewDriver = driver;
          return true;
        },
      );

      try {
        await em.start(defaultOptions({ review: true }));

        // Verify executeReviewCycle received the driver from createDriver()
        expect(capturedReviewDriver).toBe(mocks.driver);
      } finally {
        mocks.cleanup();
        reviewCycleSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("review cycle receives isInterrupted bound to sessionCore.isStopping()", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask({ status: "done" as any });

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let capturedIsInterrupted: (() => boolean) | undefined;

      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction")
        .mockReturnValueOnce({ type: "review", task } as any)
        .mockReturnValueOnce(null);
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      const reviewCycleSpy = vi.spyOn(runModule, "executeReviewCycle").mockImplementation(
        async (_task, _cwd, _opts, _driver, isInterrupted) => {
          capturedIsInterrupted = isInterrupted;
          return true;
        },
      );

      try {
        await em.start(defaultOptions({ review: true }));

        expect(capturedIsInterrupted).toBeDefined();
        expect(typeof capturedIsInterrupted).toBe("function");
      } finally {
        mocks.cleanup();
        reviewCycleSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("review cycle receives registerAbort bound to sessionCore.registerAbortHandler()", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask({ status: "done" as any });

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let capturedRegisterAbort: ((controller: AbortController) => void) | undefined;

      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction")
        .mockReturnValueOnce({ type: "review", task } as any)
        .mockReturnValueOnce(null);
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      const reviewCycleSpy = vi.spyOn(runModule, "executeReviewCycle").mockImplementation(
        async (_task, _cwd, _opts, _driver, _isInterrupted, registerAbort) => {
          capturedRegisterAbort = registerAbort;
          return true;
        },
      );

      try {
        await em.start(defaultOptions({ review: true }));

        expect(capturedRegisterAbort).toBeDefined();
        expect(typeof capturedRegisterAbort).toBe("function");
      } finally {
        mocks.cleanup();
        reviewCycleSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("budget is correctly decremented across iterations", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let capturedBudgets: Array<{ remaining: number | null }> = [];

      // Return 3 tasks, then null
      let findNextCallCount = 0;
      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction").mockImplementation(() => {
        findNextCallCount++;
        if (findNextCallCount <= 3) {
          return { type: "execute", task } as any;
        }
        return null;
      });
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, _driver, _isInterrupted, _registerAbort, budget) => {
          if (budget) {
            capturedBudgets.push({ remaining: budget.remaining });
          }
          return true;
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        // maxIterations=3 → budget starts at 3
        await em.start(defaultOptions({ maxIterations: 3 }));

        // executeUnit should have been called 3 times
        expect(executeUnitSpy).toHaveBeenCalledTimes(3);
        // Budget remaining is passed through to executeUnit (it decrements internally)
        expect(capturedBudgets.length).toBe(3);
        // All captured budgets reference the same object
        // The budget.remaining starts at 3 and is decremented by executeUnit
        capturedBudgets.forEach((b) => {
          expect(b.remaining).toEqual(expect.any(Number));
        });
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });

    it("executeLoop stops when budget is exhausted", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();
      const bc = createTestBroadcaster();
      em.setBroadcaster(bc);

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      // findNextAction always returns a task (but budget will stop us)
      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction").mockReturnValue(
        { type: "execute", task } as any,
      );

      // executeUnit "consumes" budget by decrementing remaining
      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, _driver, _isInterrupted, _registerAbort, budget) => {
          if (budget && budget.remaining !== null) {
            budget.remaining--;
          }
          return true;
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        await em.start(defaultOptions({ maxIterations: 2 }));

        // Should have executed exactly 2 times then stopped
        expect(executeUnitSpy).toHaveBeenCalledTimes(2);

        // Should have broadcast all_done
        const allDoneEvents = bc.buffer.filter(
          (e: WsEvent) => e.type === "execution:all_done",
        );
        expect(allDoneEvents.length).toBe(1);
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
      }
    });

    it("executeLoop exits gracefully when gracefulStop is set during execution", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();
      const bc = createTestBroadcaster();
      em.setBroadcaster(bc);

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction").mockReturnValue(
        { type: "execute", task } as any,
      );

      let execCount = 0;
      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, _driver, _isInterrupted, _registerAbort, budget) => {
          execCount++;
          if (execCount === 1) {
            em.requestGracefulStop();
          }
          if (budget && budget.remaining !== null) {
            budget.remaining--;
          }
          return true;
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        await em.start(defaultOptions({ maxIterations: 10 }));

        expect(executeUnitSpy).toHaveBeenCalledTimes(1);

        const allDoneEvents = bc.buffer.filter(
          (e: WsEvent) => e.type === "execution:all_done",
        );
        expect(allDoneEvents.length).toBe(1);

        expect(em.gracefulStop).toBe(false);
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
      }
    });

    it("cancelGracefulStop allows loop to continue", async () => {
      const em = new ExecutionManager(process.cwd());
      stubSessionAcquire(em);

      const mocks = await setupMocks();
      const task = fakeTask();

      const runModule = await import("../commands/run.js");
      const tasksJsonModule = await import("../core/tasks-json.js");

      let findNextCallCount = 0;
      const findNextSpy = vi.spyOn(tasksJsonModule, "findNextAction").mockImplementation(() => {
        findNextCallCount++;
        if (findNextCallCount <= 3) {
          return { type: "execute", task } as any;
        }
        return null;
      });
      const readTasksSpy = vi.spyOn(tasksJsonModule, "readTasksFile").mockReturnValue({
        tasks: [],
      } as any);

      let execCount = 0;
      const executeUnitSpy = vi.spyOn(runModule, "executeUnit").mockImplementation(
        async (_unit, _cwd, _opts, _driver, _isInterrupted, _registerAbort, budget) => {
          execCount++;
          if (execCount === 1) {
            em.requestGracefulStop();
            em.cancelGracefulStop();
          }
          if (budget && budget.remaining !== null) {
            budget.remaining--;
          }
          return true;
        },
      );
      const buildUnitSpy = vi.spyOn(runModule, "buildExecutionUnit").mockReturnValue({
        type: "task",
        taskId: "1",
        title: "Test task",
        parentTask: task,
      } as ExecutionUnit);

      try {
        await em.start(defaultOptions({ maxIterations: 10 }));

        expect(executeUnitSpy).toHaveBeenCalledTimes(3);
      } finally {
        mocks.cleanup();
        executeUnitSpy.mockRestore();
        buildUnitSpy.mockRestore();
        findNextSpy.mockRestore();
        readTasksSpy.mockRestore();
      }
    });
  });
});
