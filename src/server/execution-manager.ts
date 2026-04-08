import { getVerbosity } from "../types.js";
import type { AgentType, ExecutionUnit, OnLogCallback, Reviewer, RunOptions } from "../types.js";
import {
  executeUnit,
  executeReviewCycle,
  buildExecutionUnit,
  taskIdStr,
  type IterationBudget,
} from "../commands/run.js";
import {
  findNextAction,
  readTasksFile,
  TASK_FINAL_STATUSES,
  setStatusDirect,
} from "../core/tasks-json.js";
import type { NextAction } from "../core/tasks-json.js";
import { commitTaskmaster, hasUncommittedChangesExcluding } from "../core/git.js";
import { SessionCore } from "./session/session-core.js";
import type { AgentDriver } from "../core/drivers/types.js";
import { createDriver } from "../core/drivers/factory.js";
import type { WsBroadcaster, WsEvent } from "./session/ws-broadcaster.js";

export interface ExecuteOptions {
  agent: AgentType;
  model?: string;
  maxRetries: number;
  maxTurns: number;
  maxIterations?: number;
  onLog?: OnLogCallback;
  lockAlreadyAcquired?: boolean;
  variant?: string;
  debug: boolean;
  trace: boolean;
  quiet: boolean;
  allowDirty: boolean;
  userSettings: boolean;
  applyHooks?: boolean;
  review: boolean;
  reviewers?: Reviewer[];
  reviewRounds: number;
  reviewContext: boolean;
}

export type ExecutionState = "idle" | "running" | "stopping";

export class ExecutionManager {
  private session: SessionCore;
  private broadcaster: WsBroadcaster | null = null;
  private _driver: AgentDriver | null = null;
  private _currentUnit: ExecutionUnit | null = null;
  private _iterationCurrent = 0;
  private _iterationTotal: number | null = null;
  private _budget: IterationBudget | null = null;
  private _onIdleCallbacks: Array<() => void> = [];
  private _gracefulStop = false;

  /** Maps SessionCore states to ExecutionManager states ("active" → "running"). */
  get state(): ExecutionState {
    const s = this.session.state;
    return s === "active" ? "running" : s;
  }

  get currentUnit(): ExecutionUnit | null {
    return this._currentUnit;
  }

  get iterationCurrent(): number {
    return this._iterationCurrent;
  }

  get iterationTotal(): number | null {
    return this._iterationTotal;
  }

  get gracefulStop(): boolean {
    return this._gracefulStop;
  }

  /** Inject WsBroadcaster for WebSocket event delivery. Must be called while idle. */
  setBroadcaster(b: WsBroadcaster): void {
    if (!this.session.isIdle()) {
      throw new Error(`Cannot set broadcaster while execution is ${this.state}`);
    }
    this.broadcaster = b;
  }

  /**
   * Returns a promise that resolves when state transitions to idle.
   * Resolves immediately if already idle.
   */
  waitForIdle(): Promise<void> {
    if (this.state === "idle") return Promise.resolve();
    return new Promise<void>((resolve) => {
      this._onIdleCallbacks.push(resolve);
    });
  }

  /**
   * Broadcast state change to WS clients and resolve idle-waiters when appropriate.
   * Clears event buffer when a new execution session starts ("running").
   */
  private broadcastState(): void {
    const state = this.state;
    if (state === "running") {
      try {
        this.broadcaster?.clearBuffer();
      } catch (err) {
        console.error("Failed to clear broadcaster buffer:", err);
      }
    }
    this.broadcaster?.broadcastWithChannel(
      { type: "execution:state", state },
      "execute",
    );
    if (state === "idle") {
      const callbacks = this._onIdleCallbacks.splice(0);
      for (const cb of callbacks) cb();
    }
  }

  private broadcastIterationChanged(): void {
    this.broadcaster?.broadcastWithChannel(
      {
        type: "execution:iteration_changed",
        current: this._iterationCurrent,
        total: this._iterationTotal,
      },
      "execute",
    );
  }

  private syncIterationCounter(): void {
    if (this._budget && this._budget.remaining !== null && this._iterationTotal !== null) {
      const consumed = this._iterationTotal - this._budget.remaining;
      if (consumed !== this._iterationCurrent) {
        this._iterationCurrent = consumed;
        this.broadcastIterationChanged();
      }
    } else {
      this._iterationCurrent++;
      this.broadcastIterationChanged();
    }
  }

  constructor(cwd: string) {
    this.session = new SessionCore(cwd);
  }

  async start(options: ExecuteOptions): Promise<void> {
    if (!this.session.isIdle()) {
      throw new Error(`Cannot start: execution is ${this.state}`);
    }

    // Preflight: check dirty tree if allowDirty is false
    if (!options.allowDirty) {
      if (hasUncommittedChangesExcluding(this.session.cwd, ".taskmaster/")) {
        throw new Error("Working directory has uncommitted changes. Commit or stash them, or enable 'Allow dirty'.");
      }
    }

    // Acquire session: state → active, file lock acquired (unless caller holds it)
    this.session.acquire({ skipLock: options.lockAlreadyAcquired });
    this.broadcastState();
    this._gracefulStop = false;

    this._iterationCurrent = 0;
    this._iterationTotal = options.maxIterations ?? null;
    this.broadcastIterationChanged();

    // Default onLog broadcasts events for WS forwarding if no callback provided
    const onLog: OnLogCallback =
      options.onLog ?? ((event) => {
        this.broadcaster?.broadcastWithChannel(event as WsEvent, "execute");
      });

    const runOptions: RunOptions = {
      agent: options.agent,
      model: options.model,
      maxRetries: options.maxRetries,
      maxTurns: options.maxTurns,
      maxIterations: options.maxIterations,
      allowDirty: options.allowDirty,
      quiet: options.quiet,
      debug: options.debug,
      trace: options.trace,
      variant: options.variant,
      userSettings: options.userSettings,
      applyHooks: options.applyHooks ?? false,
      review: options.review,
      reviewers: options.reviewers,
      reviewRounds: options.reviewRounds,
      reviewContext: options.reviewContext,
      onLog,
      onExecutionEvent: (event) => {
        this.broadcaster?.broadcastWithChannel(event as WsEvent, "execute");
      },
    };

    const budget: IterationBudget = {
      remaining: options.maxIterations ?? null,
    };
    this._budget = budget;

    // Create driver but do NOT call setup() — executeUnit/executeReviewCycle
    // handle per-iteration setup/teardown internally (required for OpenCodeDriver
    // which spawns a server process per iteration).
    this._driver = createDriver(options.agent, options.model, options.userSettings, options.applyHooks ?? false);
    try {
      await this.executeLoop(runOptions, this._driver, budget);
    } finally {
      this._driver = null;
      // Wrap commitTaskmaster in try/catch to prevent wedging state on git failure
      try {
        commitTaskmaster(
          this.session.cwd,
          "prorab: commit taskmaster state after execution",
        );
      } catch (err) {
        console.error("Failed to commit taskmaster state:", err);
      }
      this.session.release();
      this._currentUnit = null;
      this._iterationCurrent = 0;
      this._iterationTotal = null;
      this._budget = null;
      this._gracefulStop = false;
      this.broadcastState();
    }
  }

  stop(): void {
    if (!this.session.isActive()) return;
    this.session.abort();
    this.broadcastState();
  }

  requestGracefulStop(): void {
    if (!this.session.isActive()) {
      throw new Error(`Cannot request graceful stop: execution is ${this.state}`);
    }
    this._gracefulStop = true;
    this.broadcaster?.broadcastWithChannel(
      { type: "execution:graceful_stop", enabled: true },
      "execute",
    );
  }

  cancelGracefulStop(): void {
    if (!this.session.isActive()) {
      throw new Error(`Cannot cancel graceful stop: execution is ${this.state}`);
    }
    this._gracefulStop = false;
    this.broadcaster?.broadcastWithChannel(
      { type: "execution:graceful_stop", enabled: false },
      "execute",
    );
  }

  private async executeOne(
    unit: ExecutionUnit,
    options: RunOptions,
    driver: AgentDriver,
    budget?: IterationBudget,
  ): Promise<boolean> {
    const unitId =
      unit.type === "subtask"
        ? `${unit.taskId}.${unit.subtaskId}`
        : unit.taskId;

    const abortCleanups: Array<() => void> = [];
    const registerAbort = (controller: AbortController) => {
      const cleanup = this.session.registerAbortHandler(() => controller.abort());
      abortCleanups.push(cleanup);
    };

    try {
      const result = await executeUnit(
        unit,
        this.session.cwd,
        options,
        driver,
        () => this.session.isStopping(),
        registerAbort,
        budget,
      );

      this.broadcaster?.broadcastWithChannel(
        { type: "execution:finished", unitId, result },
        "execute",
      );
      return result;
    } finally {
      for (const cleanup of abortCleanups) cleanup();
    }
  }

  // NOTE: This loop mirrors runCommand() in commands/run.ts.
  // Future changes to the task iteration logic should be applied in both places.
  private async executeLoop(
    options: RunOptions,
    driver: AgentDriver,
    budget: IterationBudget,
  ): Promise<void> {
    const isInterrupted = () => this.session.isStopping();

    while (this.session.isActive() && !this._gracefulStop) {
      if (budget.remaining !== null && budget.remaining <= 0) {
        this.broadcaster?.broadcastWithChannel(
          { type: "execution:all_done" },
          "execute",
        );
        return;
      }

      let action: NextAction;
      try {
        action = findNextAction(this.session.cwd, options.review);
      } catch (err) {
        console.error("Error getting next action:", err instanceof Error ? err.message : err);
        return;
      }

      if (!action) {
        // Completion check: verify all tasks are actually closed (not deadlocked)
        const data = readTasksFile(this.session.cwd);
        const nonClosed = data.tasks.filter((t) => !TASK_FINAL_STATUSES.has(t.status));
        if (nonClosed.length > 0) {
          console.error(`\nNo available actions, but ${nonClosed.length} task(s) not closed:`);
          for (const t of nonClosed) {
            console.error(`  Task ${t.id} "${t.title}" — status: ${t.status}`);
          }
          console.error(`Possible deadlock or unresolvable dependencies. Check tasks.json.`);
        }
        this.broadcaster?.broadcastWithChannel(
          { type: "execution:all_done" },
          "execute",
        );
        return;
      }

      switch (action.type) {
        case "blocked": {
          const task = action.task;
          this.broadcaster?.broadcastWithChannel(
            { type: "execution:blocked", taskId: taskIdStr(task.id) },
            "execute",
          );
          console.error(`\nTask ${task.id}: "${task.title}" is blocked. Process stopped.`);
          return;
        }

        case "execute": {
          const task = action.task;

          if (action.subtask) {
            // Execute specific subtask — auto-set parent to in-progress if pending
            if (task.status === "pending") {
              setStatusDirect(taskIdStr(task.id), "in-progress", this.session.cwd);
            }
            const unit = buildExecutionUnit(task, action.subtask);
            this._currentUnit = unit;
            const unitId = `${task.id}.${action.subtask.id}`;
            this.broadcaster?.broadcastWithChannel(
              {
                type: "execution:started",
                unitId,
                title: unit.title,
                taskId: unit.taskId,
                subtaskId: unit.subtaskId ?? "",
              },
              "execute",
            );
            const success = await this.executeOne(unit, options, driver, budget);
            this.syncIterationCounter();
            if (!success) return;
          } else {
            // No subtasks — execute task directly
            const unit = buildExecutionUnit(task);
            this._currentUnit = unit;
            this.broadcaster?.broadcastWithChannel(
              {
                type: "execution:started",
                unitId: taskIdStr(task.id),
                title: unit.title,
                taskId: unit.taskId,
                subtaskId: unit.subtaskId ?? "",
              },
              "execute",
            );
            const success = await this.executeOne(unit, options, driver, budget);
            this.syncIterationCounter();
            if (!success) return;
            // If review disabled, move done → closed explicitly
            if (!options.review) {
              setStatusDirect(taskIdStr(task.id), "closed", this.session.cwd);
              commitTaskmaster(this.session.cwd, `prorab: task ${task.id} closed (no review)`);
            }
          }
          break;
        }

        case "review":
        case "rework": {
          const task = action.task;
          const abortCleanups: Array<() => void> = [];
          const registerAbort = (controller: AbortController) => {
            const cleanup = this.session.registerAbortHandler(() => controller.abort());
            abortCleanups.push(cleanup);
          };
          try {
            await executeReviewCycle(
              task, this.session.cwd, options, driver, isInterrupted, registerAbort, budget, undefined,
              undefined, undefined,  // reviewFn, reworkFn — use defaults
              (phase, round, total) => {
                const tid = taskIdStr(task.id);
                // Broadcast round info BEFORE phase_started so UI has correct reviewRoundInfo when computing title
                if (phase === "review") {
                  this.broadcaster?.broadcastWithChannel(
                    { type: "execution:review_round_changed", taskId: tid, round, total },
                    "execute",
                  );
                }
                this.broadcaster?.broadcastWithChannel(
                  { type: `execution:${phase}_started`, taskId: tid },
                  "execute",
                );
              },
            );
            this.syncIterationCounter();
          } finally {
            for (const cleanup of abortCleanups) cleanup();
          }
          break;
        }
      }
    }

    if (this._gracefulStop && this.session.isActive()) {
      this.broadcaster?.broadcastWithChannel(
        { type: "execution:all_done" },
        "execute",
      );
    }
  }
}
