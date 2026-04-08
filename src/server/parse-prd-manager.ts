/**
 * ParsePrdManager — manages parse-prd agent sessions.
 *
 * Lifecycle: start → stream agent:* events (channel "parse-prd") → terminal outcome → cleanup.
 *
 * Follows the ChatManager architecture: separate manager with its own SessionCore,
 * without question-flow and without server defaults for model/variant.
 *
 * Key difference from ChatManager: uses batch `runSession()` (not interactive `startChat()`),
 * and determines success via server-side post-validation of the resulting tasks.json —
 * simple stream completion is NOT treated as success.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AgentType, OnLogCallback, ParsePrdManagerOutcome } from "../types.js";
import type { SessionCore } from "./session/session-core.js";
import type { WsBroadcaster } from "./session/ws-broadcaster.js";
import { DriverRunner } from "./session/driver-runner.js";
import { buildParsePrdSystemPrompt, buildParsePrdTaskPrompt, TASKS_PATH } from "../prompts/parse-prd.js";
import { getParsePrdOutcome } from "../core/validate-parse-prd.js";
import { commitParsePrdResult } from "../core/git.js";
import type { RefineTasksStartOptions } from "./refine-tasks-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsePrdState = "idle" | "active" | "stopping";

export interface ParsePrdSession {
  id: string;
  agent: AgentType;
  model?: string;
  variant?: string;
  responseLanguage?: string;
  verbosity: "quiet" | "info" | "debug" | "trace";
  state: ParsePrdState;
}

export interface ParsePrdStartOptions {
  agent: AgentType;
  model?: string;
  variant?: string;
  responseLanguage?: string;
  verbosity?: "quiet" | "info" | "debug" | "trace";
  userSettings?: boolean;
  applyHooks?: boolean;
  refineTasksOptions?: RefineTasksStartOptions | null;
}

// Re-export for backward compatibility — canonical definition is in types.ts.
export type { ParsePrdManagerOutcome } from "../types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when attempting to start parse-prd while a session is already active. */
export class ParsePrdSessionActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParsePrdSessionActiveError";
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Default max turns for the parse-prd agent session. */
const PARSE_PRD_MAX_TURNS = 200;

export class ParsePrdManager {
  private session: ParsePrdSession | null = null;
  private driverRunner: DriverRunner | null = null;

  /**
   * One-shot guard: set to `true` immediately before broadcasting
   * `parse-prd:finished`, preventing duplicate broadcasts when `stop()`
   * races with normal stream end.
   * Reset only in `start()` for the next session.
   */
  private finishedSent = false;

  /**
   * Terminal outcome of the last completed session.
   * Set inside `runParsePrdSession()` before broadcasting `parse-prd:finished`.
   */
  private _outcome: ParsePrdManagerOutcome | null = null;
  private _refineTasksOptions: RefineTasksStartOptions | null = null;
  private refineTasksManager: { start(opts: RefineTasksStartOptions): Promise<void> } | null = null;

  constructor(
    private readonly cwd: string,
    private readonly sessionCore: SessionCore,
    private readonly broadcaster: WsBroadcaster,
  ) {}

  setRefineTasksManager(manager: { start(opts: RefineTasksStartOptions): Promise<void> }): void {
    this.refineTasksManager = manager;
  }

  // ---- Accessors ----

  getState(): ParsePrdState {
    return this.session?.state ?? "idle";
  }

  getSession(): ParsePrdSession | null {
    return this.session;
  }

  /** Terminal outcome of the last session (null if no session has completed). */
  getOutcome(): ParsePrdManagerOutcome | null {
    return this._outcome;
  }

  // ---- Lifecycle ----

  /**
   * Start a new parse-prd session.
   *
   * 1. Validates that sessionCore is idle
   * 2. Acquires the session lock
   * 3. Creates and sets up a DriverRunner
   * 4. Broadcasts parse-prd:started event
   * 5. Launches the batch agent session in the background
   *
   * On error during setup, releases the session and cleans up.
   */
  async start(opts: ParsePrdStartOptions): Promise<void> {
    if (!this.sessionCore.isIdle()) {
      throw new ParsePrdSessionActiveError(
        `Cannot start parse-prd: session is ${this.sessionCore.state}`,
      );
    }

    try {
      this.sessionCore.acquire();
    } catch (err) {
      // Lock contention should surface as a conflict, not a generic error.
      const message = err instanceof Error ? err.message : String(err);
      throw new ParsePrdSessionActiveError(`Cannot start parse-prd: ${message}`);
    }

    try {
      // Reset guards for the new session
      this.finishedSent = false;
      this._outcome = null;
      this._refineTasksOptions = opts.refineTasksOptions ?? null;

      // Create session record
      this.session = {
        id: randomUUID(),
        agent: opts.agent,
        model: opts.model,
        variant: opts.variant,
        responseLanguage: opts.responseLanguage,
        verbosity: opts.verbosity ?? "trace",
        state: "active",
      };

      // Create and setup driver with onLog that broadcasts to parse-prd channel
      this.driverRunner = new DriverRunner(opts.agent, opts.model, opts.userSettings ?? false, opts.applyHooks ?? false);
      await this.driverRunner.setup(
        {
          verbosity: this.session.verbosity,
          abortSignal: this.sessionCore.getAbortSignal(),
        },
        (event) => {
          this.broadcaster.broadcastWithChannel(event, "parse-prd");
        },
      );

      // Clear the ring buffer so reconnecting clients don't replay stale events
      this.broadcaster.clearBuffer();

      // Broadcast parse-prd:started to WS clients
      this.broadcaster.broadcastWithChannel(
        {
          type: "parse-prd:started",
          sessionId: this.session.id,
          agent: this.session.agent,
          model: this.session.model,
          variant: this.session.variant,
        },
        "parse-prd",
      );

      // Broadcast system + task prompts so the UI can show what was requested
      const systemPrompt = buildParsePrdSystemPrompt(this.cwd, this.session.responseLanguage);
      this.broadcaster.broadcastWithChannel(
        { type: "agent:system_prompt", text: systemPrompt },
        "parse-prd",
      );
      this.broadcaster.broadcastWithChannel(
        { type: "agent:task_prompt", text: buildParsePrdTaskPrompt() },
        "parse-prd",
      );

      // Launch the batch session in the background.
      // Errors are handled inside runParsePrdSession; the promise is fire-and-forget.
      void this.runParsePrdSession();
    } catch (err) {
      // Cleanup on failure: teardown driver, release session, reset state
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Stop the current parse-prd session.
   *
   * Aborts the session, tears down the driver, releases the lock,
   * and broadcasts `parse-prd:finished` with `cancelled` outcome.
   * No-op if no session is active.
   */
  async stop(): Promise<void> {
    if (!this.session) return;

    this.session.state = "stopping";

    // Signal abort — propagates to the running agent session
    this.sessionCore.abort();

    // Cleanup: teardown driver, release lock, reset state
    await this.cleanup();

    // Broadcast finished with cancelled outcome.
    // Guard against duplicate: runParsePrdSession may have already broadcast.
    if (!this.finishedSent) {
      this.finishedSent = true;
      this._outcome = { status: "cancelled" };
      this.broadcaster.broadcastWithChannel(
        { type: "parse-prd:finished", outcome: this._outcome },
        "parse-prd",
      );
    }
  }

  // ---- Internal ----

  /**
   * Run the parse-prd agent session and determine the outcome.
   *
   * Outcome is determined by post-validation of the resulting tasks.json,
   * NOT by agent signal alone. Simple stream completion without a valid
   * file is treated as failure.
   *
   * Guarded by session ownership token to prevent stale cleanup.
   *
   * A per-session AbortController is created and registered with SessionCore
   * so that stop() → sessionCore.abort() propagates to the running agent
   * session, preventing resource leaks from orphaned Claude/OpenCode sessions.
   */
  private async runParsePrdSession(): Promise<void> {
    const ownerSessionId = this.session?.id;
    if (!ownerSessionId || !this.driverRunner) return;

    // Create a per-session AbortController and register it with SessionCore.
    // When stop() calls sessionCore.abort(), the handler fires controller.abort(),
    // which propagates to the running agent session.
    const abortController = new AbortController();
    const abortCleanup = this.sessionCore.registerAbortHandler(
      () => abortController.abort(),
    );

    try {
      // Pre-flight check: tasks.json must not exist when the agent session
      // actually starts.  The route checks this too, but a small window exists
      // between the route precondition and session launch.  Defense-in-depth
      // against external actors creating the file in that gap (REQ-010).
      if (existsSync(join(this.cwd, TASKS_PATH))) {
        this._outcome = {
          status: "failure",
          errors: [`${TASKS_PATH} already exists — conflict detected before agent session started`],
        };
        return; // finally block handles cleanup + broadcast
      }

      const result = await this.driverRunner.runSession({
        prompt: buildParsePrdTaskPrompt(),
        systemPrompt: buildParsePrdSystemPrompt(this.cwd, this.session?.responseLanguage),
        cwd: this.cwd,
        maxTurns: PARSE_PRD_MAX_TURNS,
        abortController,
        verbosity: this.session?.verbosity ?? "trace",
        variant: this.session?.variant,
        unitId: `parse-prd-${ownerSessionId}`,
      });

      // Determine outcome via post-validation — agent signal alone is not sufficient.
      // Even if the agent signalled complete, the file must pass validation.
      if (this.session?.id === ownerSessionId) {
        if (result.signal.type === "blocked") {
          this._outcome = {
            status: "failure",
            errors: [`Agent signalled blocked: ${result.signal.reason}`],
          };
        } else if (result.signal.type === "error") {
          // Explicit error signal — always failure, skip post-validation.
          // Even if tasks.json happens to be valid from a previous run,
          // an errored session should not produce success.
          this._outcome = {
            status: "failure",
            errors: [`Agent error: ${result.signal.message}`],
          };
        } else {
          // Both "complete" and "none" (no signal) go through post-validation.
          // Success depends on a valid tasks.json, not merely on session completion.
          const fileOutcome = getParsePrdOutcome(this.cwd);
          if (fileOutcome.status === "success") {
            commitParsePrdResult(this.cwd);
            this._outcome = { status: "success" };
          } else {
            this._outcome = { status: "failure", errors: fileOutcome.errors };
          }
        }
      }
    } catch (err) {
      // Session threw — broadcast error if we still own the session
      if (this.session?.id === ownerSessionId) {
        const message = err instanceof Error ? err.message : String(err);
        this.broadcaster.broadcastWithChannel(
          { type: "parse-prd:error", message },
          "parse-prd",
        );
        this._outcome = { status: "failure", errors: [message] };
      }
    } finally {
      // Clean up the abort handler registration to prevent listener accumulation.
      abortCleanup();

      // Only cleanup if this run still owns the current session.
      // After stop() calls cleanup() and nulls this.session, this guard
      // prevents the stale finally block from destroying a new session.
      if (this.session?.id === ownerSessionId) {
        // Capture refineTasksOptions before cleanup nulls everything
        const refineTasksOpts = this._refineTasksOptions;
        const outcome = this._outcome ?? { status: "cancelled" };
        this._outcome = outcome;

        await this.cleanup();

        if (!this.finishedSent) {
          this.finishedSent = true;

          // Auto-launch refine-tasks BEFORE broadcasting finished,
          // so hasNextStep is only set if launch succeeds.
          let autoLaunchSucceeded = false;
          if (outcome.status === "success" && refineTasksOpts && this.refineTasksManager) {
            try {
              await this.refineTasksManager.start(refineTasksOpts);
              autoLaunchSucceeded = true;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              this.broadcaster.broadcastWithChannel(
                { type: "parse-prd:error", message: `Auto-launch refine-tasks failed: ${message}` },
                "parse-prd",
              );
            }
          }

          // Only set hasNextStep if auto-launch actually succeeded
          if (autoLaunchSucceeded && outcome.status === "success") {
            outcome.hasNextStep = true;
          }

          this.broadcaster.broadcastWithChannel(
            { type: "parse-prd:finished", outcome },
            "parse-prd",
          );

          // Clear success outcome — the UI auto-transitions to task-list,
          // so persisting it would only cause stale parse-prd-progress on
          // reconnect.  Failure/cancelled are kept for the retry/error UI.
          if (outcome.status === "success") {
            this._outcome = null;
          }
        }
      }
    }
  }

  /**
   * Teardown driver, release session lock, and reset internal state.
   */
  private async cleanup(): Promise<void> {
    try {
      await this.driverRunner?.teardown();
    } catch {
      // Ignore teardown errors during cleanup
    }
    this.driverRunner = null;
    this.session = null;
    this._refineTasksOptions = null;
    this.sessionCore.release();
  }
}
