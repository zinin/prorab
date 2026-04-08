/**
 * ExpandManager — manages expand (task decomposition) agent sessions.
 *
 * Lifecycle: start(taskId) → stream agent:* events (channel "expand") → terminal outcome → cleanup.
 *
 * Follows the ParsePrdManager architecture: separate manager with its own SessionCore,
 * batch `runSession()` (not interactive `startChat()`), and server-side post-validation
 * of the agent's structured JSON output.
 *
 * Key differences from ParsePrdManager:
 * - Targets a specific top-level task (accepts `taskId` in start/stop).
 * - Outcome carries `taskId`, `subtaskCount`, and (for failures) a machine-readable `reason`.
 * - stop(taskId) returns typed results for `no_active_session` and `task_mismatch`.
 * - Agent output is a JSON object `{ subtasks: [...] }` validated against ExpandResultSchema.
 */

import { randomUUID } from "node:crypto";
import type { AgentType, ExpandManagerOutcome } from "../types.js";
import type {
  ExpandFailureReasonCode,
  ExpandStartReasonCode,
} from "../prompts/expand.js";
import type { SessionCore } from "./session/session-core.js";
import type { WsBroadcaster } from "./session/ws-broadcaster.js";
import { DriverRunner } from "./session/driver-runner.js";
import {
  buildExpandSystemPrompt,
  buildExpandTaskPrompt,
  type ExpandTaskContext,
} from "../prompts/expand.js";
import { broadcastTasksUpdated } from "./ws.js";
import { readTasksFile, writeExpandSubtasks, withTasksMutex } from "../core/tasks-json.js";
import {
  parseExpandResult,
  validateExpandResult,
} from "../core/expand-validation.js";
import {
  snapshotTasksJsonHash,
  verifyTasksJsonHash,
} from "../core/tasks-json-hash.js";
import { extractJsonFromResult } from "../core/json-extract.js";
import {
  isGitRepo,
  isTrackedByGit,
  hasGitIdentity,
  isPathDirty,
  commitExpandedTask,
} from "../core/git.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExpandState = "idle" | "active" | "stopping";

export interface ExpandSession {
  id: string;
  taskId: string;
  agent: AgentType;
  model?: string;
  variant?: string;
  state: ExpandState;
  verbosity: "quiet" | "info" | "debug" | "trace";
  /** SHA-256 hex digest of tasks.json captured before the agent session, used to detect concurrent mutations before writing. `null` when the file was absent at session start. */
  tasksJsonHash: string | null;
}

export interface ExpandStartOptions {
  agent: AgentType;
  model?: string;
  variant?: string;
  verbosity?: "quiet" | "info" | "debug" | "trace";
  userSettings?: boolean;
  applyHooks?: boolean;
}

/** Result of stop() — discriminated union for route-level status code mapping. */
export type ExpandStopResult =
  | { status: "stopped" }
  | { status: "no_active_session" }
  | { status: "task_mismatch"; activeTaskId: string };

// Re-export for backward compatibility — canonical definition is in types.ts.
export type { ExpandManagerOutcome } from "../types.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when attempting to start expand while a session is already active. */
export class ExpandSessionActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpandSessionActiveError";
  }
}

/**
 * Thrown when a git precondition check fails before the expand session starts.
 * Carries a machine-readable `reason` code for route-level mapping to 409 responses.
 */
export class ExpandPreflightError extends Error {
  readonly reason: ExpandStartReasonCode;
  constructor(reason: ExpandStartReasonCode, message: string) {
    super(message);
    this.name = "ExpandPreflightError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

/** Default max turns for the expand agent session. */
const EXPAND_MAX_TURNS = 200;

export class ExpandManager {
  private session: ExpandSession | null = null;
  private driverRunner: DriverRunner | null = null;

  /**
   * One-shot guard: set to `true` immediately before broadcasting
   * `expand:finished`, preventing duplicate broadcasts when `stop()`
   * races with normal stream end.
   * Reset only in `start()` for the next session.
   */
  private finishedSent = false;

  /**
   * Terminal outcome of the last completed session.
   * Set inside `runExpandSession()` before broadcasting `expand:finished`.
   */
  private _outcome: ExpandManagerOutcome | null = null;

  constructor(
    private readonly cwd: string,
    private readonly sessionCore: SessionCore,
    private readonly broadcaster: WsBroadcaster,
  ) {}

  // ---- Accessors ----

  getState(): ExpandState {
    return this.session?.state ?? "idle";
  }

  getSession(): ExpandSession | null {
    return this.session;
  }

  /** Terminal outcome of the last session (null if no session has completed). */
  getOutcome(): ExpandManagerOutcome | null {
    return this._outcome;
  }

  // ---- Lifecycle ----

  /**
   * Start a new expand session for the given task.
   *
   * 1. Validates that sessionCore is idle
   * 2. Acquires the session lock
   * 3. Creates and sets up a DriverRunner
   * 4. Takes a SHA-256 hash snapshot of tasks.json for conflict detection
   * 5. Broadcasts expand:started event
   * 6. Launches the batch agent session in the background
   *
   * On error during setup, releases the session and cleans up.
   */
  async start(taskId: string, opts: ExpandStartOptions): Promise<void> {
    if (!this.sessionCore.isIdle()) {
      throw new ExpandSessionActiveError(
        `Cannot start expand: session is ${this.sessionCore.state}`,
      );
    }

    // --- Git preflight checks (before acquiring the session lock) ---
    this.runGitPreflight();

    try {
      this.sessionCore.acquire();
    } catch (err) {
      // Lock contention should surface as a conflict, not a generic error.
      const message = err instanceof Error ? err.message : String(err);
      throw new ExpandSessionActiveError(`Cannot start expand: ${message}`);
    }

    try {
      // Reset guards for the new session
      this.finishedSent = false;
      this._outcome = null;

      // Snapshot tasks.json hash BEFORE the agent session starts.
      // This hash is compared against the file right before writing results,
      // so any concurrent mutation (even whitespace) is detected.
      const tasksJsonHash = snapshotTasksJsonHash(this.cwd);

      // Create session record
      this.session = {
        id: randomUUID(),
        taskId,
        agent: opts.agent,
        model: opts.model,
        variant: opts.variant,
        state: "active",
        verbosity: opts.verbosity ?? "trace",
        tasksJsonHash,
      };

      // Create and setup driver with onLog that broadcasts to expand channel
      this.driverRunner = new DriverRunner(opts.agent, opts.model, opts.userSettings ?? false, opts.applyHooks ?? false);
      await this.driverRunner.setup(
        {
          verbosity: this.session.verbosity,
          abortSignal: this.sessionCore.getAbortSignal(),
        },
        (event) => {
          this.broadcaster.broadcastWithChannel(event, "expand");
        },
      );

      // Load task context BEFORE any WS broadcasts.
      // If the task doesn't exist, we throw before expand:started is sent,
      // so WS clients never enter a dangling state waiting for a terminal event.
      const taskContext = this.loadTaskContext(taskId);
      const systemPrompt = buildExpandSystemPrompt(this.cwd);
      const taskPrompt = buildExpandTaskPrompt(taskContext);

      // Clear the ring buffer so reconnecting clients don't replay stale events
      this.broadcaster.clearBuffer();

      // Broadcast expand:started to WS clients
      this.broadcaster.broadcastWithChannel(
        {
          type: "expand:started",
          sessionId: this.session.id,
          taskId: this.session.taskId,
          agent: this.session.agent,
          model: this.session.model,
          variant: this.session.variant,
        },
        "expand",
      );

      this.broadcaster.broadcastWithChannel(
        { type: "agent:system_prompt", text: systemPrompt },
        "expand",
      );
      this.broadcaster.broadcastWithChannel(
        { type: "agent:task_prompt", text: taskPrompt },
        "expand",
      );

      // Launch the batch session in the background.
      // Errors are handled inside runExpandSession; the promise is fire-and-forget.
      void this.runExpandSession(taskContext, systemPrompt, taskPrompt);
    } catch (err) {
      // Cleanup on failure: teardown driver, release session, reset state
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Stop the current expand session.
   *
   * Returns typed results for route-level status code mapping:
   * - `stopped` — session was active and has been stopped.
   * - `no_active_session` — no expand session is running.
   * - `task_mismatch` — an expand session is running but for a different task.
   *
   * Aborts only the agent phase; if the server has already transitioned to
   * validate → write → commit, the operation completes to terminal outcome.
   */
  async stop(taskId: string): Promise<ExpandStopResult> {
    if (!this.session) {
      return { status: "no_active_session" };
    }

    if (this.session.taskId !== taskId) {
      return { status: "task_mismatch", activeTaskId: this.session.taskId };
    }

    this.session.state = "stopping";

    // Signal abort — propagates to the running agent session
    this.sessionCore.abort();

    // Cleanup: teardown driver, release lock, reset state
    await this.cleanup();

    // Broadcast finished with cancelled outcome.
    // Guard against duplicate: runExpandSession may have already broadcast.
    if (!this.finishedSent) {
      this.finishedSent = true;
      this._outcome = { status: "cancelled", taskId, subtaskCount: 0 };
      this.broadcaster.broadcastWithChannel(
        { type: "expand:finished", outcome: this._outcome },
        "expand",
      );
    }

    return { status: "stopped" };
  }

  // ---- Internal ----

  /**
   * Run git precondition checks before starting an expand session.
   *
   * Checks (in order):
   * 1. Directory is a git repo
   * 2. tasks.json is tracked by git
   * 3. Git user identity (user.name + user.email) is configured
   * 4. tasks.json has no staged or unstaged changes
   *
   * @throws {ExpandPreflightError} with machine-readable reason code on failure.
   */
  private runGitPreflight(): void {
    const tasksFile = ".taskmaster/tasks/tasks.json";

    if (!isGitRepo(this.cwd)) {
      throw new ExpandPreflightError(
        "git_not_repo",
        "Cannot expand: not a git repository",
      );
    }

    if (!isTrackedByGit(tasksFile, this.cwd)) {
      throw new ExpandPreflightError(
        "tasks_file_untracked",
        "Cannot expand: .taskmaster/tasks/tasks.json is not tracked by git",
      );
    }

    if (!hasGitIdentity(this.cwd)) {
      throw new ExpandPreflightError(
        "git_identity_missing",
        "Cannot expand: git user identity (user.name / user.email) is not configured",
      );
    }

    if (isPathDirty(tasksFile, this.cwd)) {
      throw new ExpandPreflightError(
        "tasks_file_dirty",
        "Cannot expand: .taskmaster/tasks/tasks.json has uncommitted changes",
      );
    }
  }

  /**
   * Load task context for the expand prompt from tasks.json.
   *
   * @throws if the task is not found (readTasksFile / showTaskById throw).
   */
  private loadTaskContext(taskId: string): ExpandTaskContext {
    const data = readTasksFile(this.cwd);
    const task = data.tasks.find((t) => String(t.id) === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found in tasks.json`);
    }
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      details: task.details,
      dependencies: task.dependencies,
      testStrategy: task.testStrategy,
      expansionPrompt: task.expansionPrompt,
      complexityReasoning: task.complexityReasoning,
      recommendedSubtasks: typeof task.recommendedSubtasks === "number" ? task.recommendedSubtasks : undefined,
    };
  }

  /**
   * Run the expand agent session, parse the result, and determine the outcome.
   *
   * Flow:
   * 1. Run batch agent session
   * 2. Extract last text message, parse JSON, validate with ExpandResultSchema
   * 3. If subtasks empty → success with subtaskCount: 0
   * 4. If subtasks present → hash conflict check → write pipeline → git commit
   *
   * Guarded by session ownership token to prevent stale cleanup.
   *
   * A per-session AbortController is created and registered with SessionCore
   * so that stop() → sessionCore.abort() propagates to the running agent
   * session, preventing resource leaks from orphaned Claude/OpenCode sessions.
   */
  private async runExpandSession(
    taskContext: ExpandTaskContext,
    systemPrompt: string,
    taskPrompt: string,
  ): Promise<void> {
    const ownerSessionId = this.session?.id;
    const ownerTaskId = this.session?.taskId;
    if (!ownerSessionId || !ownerTaskId || !this.driverRunner) return;

    // Create a per-session AbortController and register it with SessionCore.
    // When stop() calls sessionCore.abort(), the handler fires controller.abort(),
    // which propagates to the running agent session.
    const abortController = new AbortController();
    const abortCleanup = this.sessionCore.registerAbortHandler(
      () => abortController.abort(),
    );

    try {
      const result = await this.driverRunner.runSession({
        prompt: taskPrompt,
        systemPrompt,
        cwd: this.cwd,
        maxTurns: EXPAND_MAX_TURNS,
        abortController,
        verbosity: this.session?.verbosity ?? "trace",
        variant: this.session?.variant,
        unitId: `expand-${ownerTaskId}-${ownerSessionId}`,
      });

      // Only process outcome if this run still owns the current session
      if (this.session?.id !== ownerSessionId) return;

      // Check agent signal — blocked/error short-circuit to failure
      if (result.signal.type === "blocked") {
        this.setFailureOutcome(
          ownerTaskId,
          "agent_failed",
          `Agent signalled blocked: ${result.signal.reason}`,
        );
        return;
      }

      if (result.signal.type === "error") {
        this.setFailureOutcome(
          ownerTaskId,
          "agent_failed",
          `Agent error: ${result.signal.message}`,
        );
        return;
      }

      // Extract JSON from agent output, then parse + validate via the
      // expand-validation module.  extractJsonFromResult handles noisy
      // driver output (Claude accumulates all text blocks; OpenCode may
      // include only the last message) by locating the last top-level
      // `{…}` block.  parseExpandResult then JSON.parse's + Zod-validates.
      const jsonText = extractJsonFromResult(result.resultText);
      if (jsonText === null) {
        this.setFailureOutcome(
          ownerTaskId,
          "result_parse_failed",
          "No JSON object found in agent output",
        );
        return;
      }

      // parseExpandResult does JSON.parse + validateExpandResult (Zod schema)
      const validation = parseExpandResult(jsonText);
      if (!validation.ok) {
        this._outcome = {
          status: "failure",
          taskId: ownerTaskId,
          reason: validation.reason,
          errors: validation.errors,
          message: `Validation failed: ${validation.errors[0]}`,
          subtaskCount: 0,
        };
        return;
      }

      const { subtasks } = validation.data;

      // Empty subtasks → valid no-op success
      if (subtasks.length === 0) {
        this._outcome = {
          status: "success",
          taskId: ownerTaskId,
          subtaskCount: 0,
        };
        return;
      }

      // Non-empty subtasks: hash check → write → commit pipeline
      //
      // Both the hash verification and the write are inside the same
      // withTasksMutex critical section to eliminate the TOCTOU window
      // where another writer could mutate tasks.json between the hash
      // check and the write.
      const snapshotHash = this.session?.tasksJsonHash;
      const writeResult = await withTasksMutex(() => {
        // Guard: if stop() ran during the mutex wait, the session has been
        // cleaned up and "cancelled" already broadcast — skip the write.
        if (this.session?.id !== ownerSessionId) return "cancelled" as const;

        // Hash conflict check: verify tasks.json has not been modified
        // since the snapshot taken in start(). Covers the entire file
        // including multi-tag wrappers and inactive tags.
        // snapshotHash is null if tasks.json was absent at session start —
        // treat as conflict since loadTaskContext() should have thrown ENOENT
        // first, but guard defensively in case of race conditions.
        if (!snapshotHash || !verifyTasksJsonHash(this.cwd, snapshotHash)) {
          return "hash_conflict" as const;
        }
        writeExpandSubtasks(this.cwd, ownerTaskId, subtasks);
        return "written" as const;
      });

      // stop() took over during the mutex wait — bail out silently.
      // stop() already broadcast "cancelled" and cleaned up.
      if (writeResult === "cancelled") return;

      if (writeResult === "hash_conflict") {
        this.setFailureOutcome(
          ownerTaskId,
          "hash_conflict",
          "tasks.json was modified during the expand session — aborting to prevent overwriting concurrent changes",
        );
        return;
      }

      // Broadcast tasks:updated so connected clients (TaskListView etc.) pick
      // up the new subtasks immediately — following the same pattern used by
      // routes/tasks.ts after every atomic write to tasks.json.
      broadcastTasksUpdated();

      // Post-write commit: stage and commit only tasks.json.
      // If the commit fails, the file has already been written —
      // report a terminal failure but do NOT rollback the write.
      try {
        commitExpandedTask(this.cwd, ownerTaskId, subtasks.length);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.setFailureOutcome(
          ownerTaskId,
          "commit_failed_after_write",
          `Subtasks written to disk but git commit failed: ${detail}. ` +
            "The subtasks are saved in .taskmaster/tasks/tasks.json but not committed to git.",
        );
        return;
      }

      this._outcome = {
        status: "success",
        taskId: ownerTaskId,
        subtaskCount: subtasks.length,
      };
    } catch (err) {
      // Session threw — set failure outcome if we still own the session.
      // The expand:error broadcast is deferred to the finally block which
      // handles all failure paths uniformly, avoiding duplicate broadcasts.
      if (this.session?.id === ownerSessionId) {
        const message = err instanceof Error ? err.message : String(err);
        this._outcome = {
          status: "failure",
          taskId: ownerTaskId,
          reason: "agent_failed",
          errors: [message],
          message,
          subtaskCount: 0,
        };
      }
    } finally {
      // Clean up the abort handler registration to prevent listener accumulation.
      abortCleanup();

      // Only cleanup if this run still owns the current session.
      // After stop() calls cleanup() and nulls this.session, this guard
      // prevents the stale finally block from destroying a new session.
      if (this.session?.id === ownerSessionId) {
        await this.cleanup();

        if (!this.finishedSent) {
          this.finishedSent = true;
          // Default to cancelled if no outcome was set (shouldn't happen normally)
          const outcome: ExpandManagerOutcome = this._outcome ?? {
            status: "cancelled",
            taskId: ownerTaskId,
            subtaskCount: 0,
          };
          this._outcome = outcome;

          // For terminal failures, broadcast expand:error before expand:finished
          // so the UI gets the machine-readable reason before the terminal event.
          if (outcome.status === "failure") {
            this.broadcaster.broadcastWithChannel(
              {
                type: "expand:error",
                message: outcome.message,
                reason: outcome.reason,
              },
              "expand",
            );
          }

          this.broadcaster.broadcastWithChannel(
            { type: "expand:finished", outcome },
            "expand",
          );

          // Clear success outcome — the UI auto-transitions after success,
          // so persisting it would cause stale state on reconnect.
          // Failure/cancelled are kept for the retry/error UI.
          if (outcome.status === "success") {
            this._outcome = null;
          }
        }
      }
    }
  }

  /**
   * Helper to set a failure outcome with a single error message.
   * Broadcasts `expand:error` before setting the outcome.
   */
  private setFailureOutcome(
    taskId: string,
    reason: ExpandFailureReasonCode,
    message: string,
  ): void {
    this._outcome = {
      status: "failure",
      taskId,
      reason,
      errors: [message],
      message,
      subtaskCount: 0,
    };
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
    this.sessionCore.release();
  }
}
