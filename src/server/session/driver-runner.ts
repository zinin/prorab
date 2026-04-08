import type { AgentType, IterationResult, ModelEntry, OnLogCallback } from "../../types.js";
import type { AgentDriver, SessionOptions, SetupOptions } from "../../core/drivers/types.js";
import { createDriver } from "../../core/drivers/factory.js";

/**
 * Manages the lifecycle of an AgentDriver: creation, setup, teardown.
 *
 * Wraps createDriver() and optional setup/teardown hooks into a single
 * object with clear ownership semantics. After construction the driver
 * does not exist yet — call setup() to instantiate and initialise it,
 * then getDriver() to obtain the ready instance.
 *
 * **onLog routing**: Call {@link setOnLog} to register an {@link OnLogCallback}
 * before running sessions. The callback is automatically injected into every
 * {@link runSession} call so callers don't need to thread it through manually.
 *
 * **abortSignal integration**: {@link setup} accepts {@link SetupOptions} which
 * carries an optional `abortSignal`. When used with {@link SessionCore}, the
 * signal comes from `SessionCore.getAbortSignal()` — aborting the SessionCore
 * will propagate to the driver's setup phase (relevant for OpenCodeDriver
 * which spawns a long-lived server process during setup).
 */
export class DriverRunner {
  private _driver: AgentDriver | null = null;
  private _setupDone: boolean = false;
  private _onLog?: OnLogCallback;

  private readonly _agent: AgentType;
  private readonly _model: string | undefined;
  private readonly _userSettings: boolean;
  private readonly _applyHooks: boolean;

  constructor(agent: AgentType, model?: string, userSettings: boolean = false, applyHooks: boolean = false) {
    this._agent = agent;
    this._model = model;
    this._userSettings = userSettings;
    this._applyHooks = applyHooks;
  }

  /** Whether setup() has been called successfully. */
  get setupDone(): boolean {
    return this._setupDone;
  }

  /** The agent type this runner was created for. */
  get agent(): AgentType {
    return this._agent;
  }

  /** The model override (if any). */
  get model(): string | undefined {
    return this._model;
  }

  /** Whether user settings are enabled. */
  get userSettings(): boolean {
    return this._userSettings;
  }

  /**
   * Register an {@link OnLogCallback} to receive log events from agent sessions.
   *
   * The callback is stored and automatically injected into the `onLog` field
   * of {@link SessionOptions} every time {@link runSession} is called.
   * Call with `undefined` to clear a previously set callback.
   */
  setOnLog(callback: OnLogCallback | undefined): void {
    this._onLog = callback;
  }

  /**
   * Proxy to the driver's `runSession()` with automatic `onLog` injection.
   *
   * Merges the stored {@link OnLogCallback} (set via {@link setOnLog}) into
   * the session options so callers don't need to thread the callback manually.
   *
   * @throws if setup() has not been called.
   */
  async runSession(opts: Omit<SessionOptions, "onLog">): Promise<IterationResult> {
    return this.getDriver().runSession({ ...opts, onLog: this._onLog });
  }

  /**
   * Create the driver and run its optional setup() hook.
   *
   * When used with {@link SessionCore}, pass `SessionCore.getAbortSignal()`
   * as `opts.abortSignal` so that aborting the session propagates to the
   * driver's setup phase (e.g. OpenCodeDriver server spawn).
   *
   * @param opts - setup options forwarded to the driver's setup() hook.
   * @param onLog - optional {@link OnLogCallback} to register at setup time.
   *   Equivalent to calling {@link setOnLog} before setup but avoids a separate call.
   *   Can still be changed later via {@link setOnLog}.
   * @throws if setup() has already been called without a matching teardown().
   */
  async setup(opts: SetupOptions, onLog?: OnLogCallback): Promise<void> {
    if (this._setupDone) {
      throw new Error("DriverRunner: already set up — call teardown() first");
    }

    if (onLog !== undefined) {
      this._onLog = onLog;
    }

    const driver = createDriver(this._agent, this._model, this._userSettings, this._applyHooks);

    try {
      if (driver.setup) {
        await driver.setup(opts);
      }
    } catch (err) {
      // Clean up: if driver.setup() failed, teardown the partially-initialised
      // driver to prevent resource leaks (e.g. spawned server processes).
      if (driver.teardown) {
        try {
          await driver.teardown();
        } catch {
          // Ignore teardown errors during cleanup — the original error is more important.
        }
      }
      throw err;
    }

    this._driver = driver;
    this._setupDone = true;
  }

  /**
   * Run the driver's optional teardown() hook and clear internal state.
   *
   * Safe to call when not set up (no-op).
   */
  async teardown(): Promise<void> {
    if (!this._setupDone || !this._driver) {
      return;
    }

    try {
      if (this._driver.teardown) {
        await this._driver.teardown();
      }
    } finally {
      this._driver = null;
      this._setupDone = false;
    }
  }

  /**
   * Return the initialised driver.
   *
   * @throws if setup() has not been called.
   */
  getDriver(): AgentDriver {
    if (!this._driver) {
      throw new Error("DriverRunner: driver not initialised — call setup() first");
    }
    return this._driver;
  }

  /**
   * Proxy to the driver's optional listModels() method.
   * Returns an empty array when the driver does not implement listModels().
   *
   * @throws if setup() has not been called.
   */
  async listModels(): Promise<ModelEntry[]> {
    return this.getDriver().listModels?.() ?? [];
  }
}
