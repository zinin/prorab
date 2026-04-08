/**
 * RefineTasksManager — orchestrates sequential chat-based tasks.json refinement pipeline.
 *
 * Lifecycle: start → run N chat steps sequentially → commit after each step →
 * terminal outcome → cleanup.
 *
 * Each step uses interactive `startChat()` + `sendMessage()` (not batch `runSession()`),
 * supporting questions for Claude/OpenCode agents. Codex steps are fully autonomous
 * (no question support).
 *
 * Follows ChatManager patterns for question handling and ParsePrdManager patterns
 * for lifecycle (shared SessionCore, DriverRunner, WsBroadcaster).
 *
 * Key design decisions:
 * - Shared SessionCore — received via constructor, NOT created internally
 * - stop() only calls sessionCore.abort() + abortChat() — cleanup happens
 *   exclusively in runPipeline() finally block
 * - No auto-launch downstream — refine-tasks is the END of the pipeline
 * - Codex steps are fully autonomous (no questions)
 * - Git via execFileSync with array args for command injection safety
 * - JSON.parse validation before each step to verify tasks.json integrity
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { AgentType, Verbosity } from "../types.js";
import type { RefineTasksManagerOutcome } from "../types-refine-tasks.js";
import type { ChatEvent, QuestionAnswers, QuestionData } from "../core/drivers/types.js";
import type { SessionCore } from "./session/session-core.js";
import type { WsBroadcaster } from "./session/ws-broadcaster.js";
import { DriverRunner } from "./session/driver-runner.js";
import { parseSignal } from "../core/drivers/types.js";
import { buildRefineTasksSystemPrompt, buildRefineTasksTaskPrompt } from "../prompts/refine-tasks.js";
import { TASKS_PATH } from "../prompts/parse-prd.js";
import { checkTasksFile } from "../core/project-state.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefineTasksState = "idle" | "active" | "stopping";

export interface RefineTasksStep {
  agent: AgentType;
  model?: string;
  variant?: string;
}

export interface RefineTasksSession {
  id: string;
  steps: RefineTasksStep[];
  currentStepIndex: number;
  stepState: "running" | "question_pending";
  pendingQuestionId: string | null;
  pendingQuestionData: { questions: QuestionData[]; source: "claude" | "opencode" } | null;
  verbosity: Verbosity;
  responseLanguage?: string;
  userSettings: boolean;
  applyHooks: boolean;
}

export interface RefineTasksStartOptions {
  steps: RefineTasksStep[];
  verbosity?: Verbosity;
  responseLanguage?: string;
  userSettings?: boolean;
  applyHooks?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when attempting to start refine-tasks while a session is already active. */
export class RefineTasksSessionActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineTasksSessionActiveError";
  }
}

/** Thrown when the refine-tasks session is not in the expected state. */
export class RefineTasksNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineTasksNotReadyError";
  }
}

/** Thrown when the provided question ID does not match the pending question. */
export class RefineTasksQuestionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineTasksQuestionMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class RefineTasksManager {
  private session: RefineTasksSession | null = null;
  private driverRunner: DriverRunner | null = null;
  private chatStream: AsyncIterable<ChatEvent> | null = null;

  /**
   * Per-turn buffer: accumulates assistant `text` events within a single
   * turn. Reset on each step start and after each turn boundary (`idle` event).
   * Used to detect completion/blocked signals via parseSignal().
   */
  private turnBuffer = "";

  /**
   * One-shot guard: set to `true` immediately before broadcasting
   * `refine-tasks:finished`, preventing duplicate broadcasts when `stop()`
   * races with normal pipeline completion.
   * Reset only in `start()` for the next session.
   */
  private finishedSent = false;

  /**
   * Terminal outcome of the last completed session.
   * Set inside `runPipeline()` before broadcasting `refine-tasks:finished`.
   */
  private _outcome: RefineTasksManagerOutcome | null = null;

  constructor(
    private readonly cwd: string,
    private readonly sessionCore: SessionCore,
    private readonly broadcaster: WsBroadcaster,
  ) {}

  // ---- Accessors ----

  getState(): RefineTasksState {
    if (!this.session) return "idle";
    if (this.sessionCore.isStopping()) return "stopping";
    return "active";
  }

  getSession(): RefineTasksSession | null {
    return this.session;
  }

  /** Terminal outcome of the last session (null if no session has completed). */
  getOutcome(): RefineTasksManagerOutcome | null {
    return this._outcome;
  }

  // ---- Lifecycle ----

  /**
   * Start a new refine-tasks pipeline session.
   *
   * 1. Validates that sessionCore is idle
   * 2. Validates that tasks.json exists and is valid
   * 3. Acquires the session lock
   * 4. Resets guards
   * 5. Creates session record
   * 6. Clears broadcaster buffer
   * 7. Broadcasts refine-tasks:started
   * 8. Launches runPipeline() fire-and-forget
   */
  async start(opts: RefineTasksStartOptions): Promise<void> {
    if (!this.sessionCore.isIdle()) {
      throw new RefineTasksSessionActiveError(
        `Cannot start refine-tasks: session is ${this.sessionCore.state}`,
      );
    }

    // Validate tasks.json exists and is valid before acquiring lock
    const tasksState = checkTasksFile(this.cwd);
    if (!tasksState.hasTasksFile || !tasksState.hasValidTasks) {
      throw new RefineTasksNotReadyError(
        `Cannot start refine-tasks: tasks.json is ${!tasksState.hasTasksFile ? "missing" : "invalid"}`,
      );
    }

    try {
      this.sessionCore.acquire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RefineTasksSessionActiveError(`Cannot start refine-tasks: ${message}`);
    }

    try {
      // Reset guards for the new session
      this.finishedSent = false;
      this._outcome = null;
      this.turnBuffer = "";

      // Create session record
      this.session = {
        id: randomUUID(),
        steps: opts.steps,
        currentStepIndex: 0,
        stepState: "running",
        pendingQuestionId: null,
        pendingQuestionData: null,
        verbosity: opts.verbosity ?? "trace",
        responseLanguage: opts.responseLanguage,
        userSettings: opts.userSettings ?? false,
        applyHooks: opts.applyHooks ?? false,
      };

      // Clear the ring buffer so reconnecting clients don't replay stale events
      this.broadcaster.clearBuffer();

      // Broadcast refine-tasks:started
      this.broadcaster.broadcastWithChannel(
        {
          type: "refine-tasks:started",
          sessionId: this.session.id,
          steps: this.session.steps.map((s) => ({
            agent: s.agent,
            model: s.model,
            variant: s.variant,
          })),
          currentStepIndex: 0,
        },
        "refine-tasks",
      );

      // Fire-and-forget pipeline execution
      void this.runPipeline();
    } catch (err) {
      // Cleanup on failure: release lock, reset state
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Stop the current refine-tasks session.
   *
   * Only calls sessionCore.abort() and tries to abort the current chat.
   * Does NOT call cleanup() — all cleanup happens in runPipeline() finally block.
   * This prevents double-cleanup race conditions.
   *
   * No-op if no session is active.
   */
  async stop(): Promise<void> {
    if (!this.session) return;

    // Try to abort the current chat stream
    try {
      this.driverRunner?.getDriver().abortChat();
    } catch {
      // Driver not yet initialised — setup() still running
    }

    // Signal sessionCore to stop — propagates to running agent session
    this.sessionCore.abort();
  }

  /**
   * Reply to a pending agent question.
   *
   * Preconditions:
   * - Session must exist and stepState must be "question_pending"
   * - questionId must match the pending question
   */
  async replyQuestion(questionId: string, answers: QuestionAnswers): Promise<void> {
    if (!this.session || this.session.stepState !== "question_pending") {
      throw new RefineTasksNotReadyError("Cannot reply: no pending question");
    }

    if (questionId !== this.session.pendingQuestionId) {
      throw new RefineTasksQuestionMismatchError("Question ID mismatch");
    }

    const driver = this.driverRunner?.getDriver();
    if (!driver) throw new Error("Cannot reply: driver not available");

    try {
      driver.replyQuestion(questionId, answers);
    } catch (err) {
      // On failure, leave state as question_pending so the user can retry
      if (this.session) {
        this.session.stepState = "question_pending";
        this.session.pendingQuestionId = questionId;
      }
      throw err;
    }

    // Success — clear pending state
    this.session.pendingQuestionId = null;
    this.session.pendingQuestionData = null;
    this.session.stepState = "running";
  }

  // ---- Internal: Pipeline ----

  /**
   * Run the sequential refinement pipeline (fire-and-forget).
   *
   * Iterates through each step, running an interactive chat session per step.
   * Commits tasks.json changes after each successful step.
   *
   * ALL cleanup happens exclusively in the finally block — stop() only signals
   * abort and lets this method handle teardown.
   */
  private async runPipeline(): Promise<void> {
    const ownerSessionId = this.session?.id;
    if (!ownerSessionId) return;

    try {
      const steps = this.session!.steps;

      for (let i = 0; i < steps.length; i++) {
        // Check session ownership and stopping state
        if (this.session?.id !== ownerSessionId) break;
        if (this.sessionCore.isStopping()) break;

        // Verify tasks.json exists and is valid JSON before each step
        const tasksPath = join(this.cwd, TASKS_PATH);
        if (!existsSync(tasksPath)) {
          this._outcome = { status: "failure", stepIndex: i, error: `Tasks file not found at ${TASKS_PATH}` };
          break;
        }
        // Validate JSON is parseable
        try {
          JSON.parse(readFileSync(tasksPath, "utf-8"));
        } catch {
          this._outcome = { status: "failure", stepIndex: i, error: `Tasks file at ${TASKS_PATH} contains invalid JSON` };
          break;
        }

        // Update session state for this step
        this.session!.currentStepIndex = i;
        this.session!.stepState = "running";
        this.session!.pendingQuestionId = null;
        this.session!.pendingQuestionData = null;
        this.turnBuffer = "";

        // Broadcast step_started
        this.broadcaster.broadcastWithChannel(
          {
            type: "refine-tasks:step_started",
            stepIndex: i,
            agent: steps[i].agent,
            model: steps[i].model,
          },
          "refine-tasks",
        );

        // Run the step
        const stepResult = await this.runStep(steps[i], i, ownerSessionId);

        // Broadcast step_finished
        this.broadcaster.broadcastWithChannel(
          {
            type: "refine-tasks:step_finished",
            stepIndex: i,
            stepOutcome: stepResult,
          },
          "refine-tasks",
        );

        if (stepResult === "error") {
          // _outcome already set by runStep or handleStepEvent
          if (!this._outcome) {
            this._outcome = {
              status: "failure",
              stepIndex: i,
              error: "Step failed",
            };
          }
          break;
        }

        // Validate tasks.json is still valid JSON before committing
        const tasksPathPostStep = join(this.cwd, TASKS_PATH);
        if (existsSync(tasksPathPostStep)) {
          try {
            JSON.parse(readFileSync(tasksPathPostStep, "utf-8"));
          } catch {
            this._outcome = {
              status: "failure",
              stepIndex: i,
              error: `Step ${i + 1} produced invalid JSON in ${TASKS_PATH}`,
            };
            break;
          }
        }

        // Commit tasks.json changes after successful step
        this.commitTasksChanges(i, steps[i]);
      }

      // If all steps completed successfully and no outcome set yet
      if (!this._outcome && this.session?.id === ownerSessionId) {
        if (this.sessionCore.isStopping()) {
          this._outcome = { status: "cancelled" };
        } else {
          this._outcome = { status: "success", stepsCompleted: steps.length };
        }
      }
    } catch (err) {
      if (this.session?.id === ownerSessionId && !this._outcome) {
        const message = err instanceof Error ? err.message : String(err);
        this._outcome = {
          status: "failure",
          stepIndex: this.session?.currentStepIndex ?? 0,
          error: message,
        };
      }
    } finally {
      // Only cleanup if this run still owns the current session
      if (this.session?.id === ownerSessionId) {
        const outcome = this._outcome ?? { status: "cancelled" as const };
        this._outcome = outcome;

        // Cleanup: teardown driver, release lock, reset state
        await this.cleanup();

        // Broadcast finished (with one-shot guard)
        if (!this.finishedSent) {
          this.finishedSent = true;
          this.broadcaster.broadcastWithChannel(
            { type: "refine-tasks:finished", outcome },
            "refine-tasks",
          );
        }
      }
    }
  }

  /**
   * Run a single refinement step as an interactive chat session.
   *
   * Creates a DriverRunner, starts a chat, sends the task prompt,
   * and consumes the stream until completion/error/abort.
   *
   * @returns "success" if the step completed normally, "error" on failure.
   */
  private async runStep(
    step: RefineTasksStep,
    stepIndex: number,
    ownerSessionId: string,
  ): Promise<"success" | "error"> {
    // Create and setup driver for this step
    this.driverRunner = new DriverRunner(
      step.agent,
      step.model,
      this.session?.userSettings ?? false,
      this.session?.applyHooks ?? false,
    );

    const abortController = new AbortController();
    const abortCleanup = this.sessionCore.registerAbortHandler(
      () => abortController.abort(),
    );

    try {
      await this.driverRunner.setup(
        {
          verbosity: this.session?.verbosity ?? "trace",
          abortSignal: abortController.signal,
        },
        (event) => {
          this.broadcaster.broadcastWithChannel(event, "refine-tasks");
        },
      );

      // Build prompts
      const systemPrompt = buildRefineTasksSystemPrompt({
        responseLanguage: this.session?.responseLanguage,
        stepIndex,
        totalSteps: this.session?.steps.length ?? 1,
      });
      const taskPrompt = buildRefineTasksTaskPrompt();

      // Broadcast prompts for UI visibility
      this.broadcaster.broadcastWithChannel(
        { type: "agent:system_prompt", text: systemPrompt },
        "refine-tasks",
      );
      this.broadcaster.broadcastWithChannel(
        { type: "agent:task_prompt", text: taskPrompt },
        "refine-tasks",
      );

      // Start interactive chat
      const driver = this.driverRunner.getDriver();
      this.chatStream = driver.startChat({
        systemPrompt,
        cwd: this.cwd,
        verbosity: this.session?.verbosity ?? "trace",
        variant: step.variant,
      });

      // Send the task prompt as the first message
      driver.sendMessage(taskPrompt);

      // Reset turn buffer for this step
      this.turnBuffer = "";

      // Consume the chat stream
      let stepOutcome: "success" | "error" = "success";

      try {
        for await (const event of this.chatStream) {
          // Check ownership and abort state
          if (this.session?.id !== ownerSessionId) {
            stepOutcome = "error";
            break;
          }
          if (this.sessionCore.isStopping()) {
            break; // runPipeline will set _outcome to cancelled
          }

          const continueStream = this.handleStepEvent(event, stepIndex);
          if (!continueStream) {
            // Check if it was an error/blocked event that stopped us
            if (event.type === "error") {
              stepOutcome = "error";
              if (!this._outcome) {
                this._outcome = {
                  status: "failure",
                  stepIndex,
                  error: event.message,
                };
              }
            }
            // handleStepEvent may have set _outcome for blocked signals
            if (this._outcome?.status === "failure") {
              stepOutcome = "error";
            }
            break;
          }
        }
      } catch (err) {
        if (this.session?.id === ownerSessionId) {
          const message = err instanceof Error ? err.message : String(err);
          this.broadcaster.broadcastWithChannel(
            { type: "refine-tasks:error", stepIndex, message },
            "refine-tasks",
          );
          if (!this._outcome) {
            this._outcome = {
              status: "failure",
              stepIndex,
              error: message,
            };
          }
          stepOutcome = "error";
        }
      }

      // Check for blocked signal in accumulated text
      if (stepOutcome === "success" && this.turnBuffer) {
        const signal = parseSignal(this.turnBuffer);
        if (signal.type === "blocked") {
          if (!this._outcome) {
            this._outcome = {
              status: "failure",
              stepIndex,
              error: `Agent signalled blocked: ${signal.reason}`,
            };
          }
          stepOutcome = "error";
        }
      }

      return stepOutcome;
    } catch (err) {
      // Setup or startChat failure
      if (this.session?.id === ownerSessionId) {
        const message = err instanceof Error ? err.message : String(err);
        this.broadcaster.broadcastWithChannel(
          { type: "refine-tasks:error", stepIndex, message },
          "refine-tasks",
        );
        if (!this._outcome) {
          this._outcome = {
            status: "failure",
            stepIndex,
            error: message,
          };
        }
      }
      return "error";
    } finally {
      abortCleanup();

      // Teardown driver for this step (next step creates a new one)
      try {
        await this.driverRunner?.teardown();
      } catch {
        // Ignore teardown errors
      }
      this.driverRunner = null;
      this.chatStream = null;
    }
  }

  /**
   * Handle a single ChatEvent from the agent stream.
   *
   * Translates driver events into WS broadcasts and manages question state.
   *
   * @returns true to continue consuming the stream, false to stop.
   */
  private handleStepEvent(event: ChatEvent, stepIndex: number): boolean {
    if (!this.session) return false;

    switch (event.type) {
      case "text":
        this.turnBuffer += event.content;
        this.broadcaster.broadcastWithChannel(
          { type: "agent:text", text: event.content },
          "refine-tasks",
        );
        return true;

      case "reasoning":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:reasoning", text: event.content },
          "refine-tasks",
        );
        return true;

      case "tool":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:tool", name: event.name, summary: event.name, input: event.input },
          "refine-tasks",
        );
        return true;

      case "tool_result":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:tool_result", summary: event.name, output: event.output },
          "refine-tasks",
        );
        return true;

      case "context_usage":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:context_usage", ...event.usage },
          "refine-tasks",
        );
        return true;

      case "question":
        this.session.stepState = "question_pending";
        this.session.pendingQuestionId = event.questionId;
        this.session.pendingQuestionData = {
          questions: event.questions,
          source: event.source,
        };
        this.broadcaster.broadcastWithChannel(
          {
            type: "refine-tasks:question",
            stepIndex,
            questionId: event.questionId,
            questions: event.questions,
            source: event.source,
          },
          "refine-tasks",
        );
        return true;

      case "question_answer":
        // Not broadcast (local only)
        return true;

      case "idle": {
        // Clear pending question state
        this.session.stepState = "running";
        this.session.pendingQuestionId = null;
        this.session.pendingQuestionData = null;

        // Check for completion/blocked signal in accumulated turn text
        const signal = parseSignal(this.turnBuffer);

        // Reset turn buffer for next turn
        this.turnBuffer = "";

        if (signal.type === "complete" || signal.type === "blocked") {
          // Step is done — return false to stop consuming the stream
          if (signal.type === "blocked" && !this._outcome) {
            this._outcome = {
              status: "failure",
              stepIndex,
              error: `Agent signalled blocked: ${signal.reason}`,
            };
          }
          return false;
        }

        return true;
      }

      case "error":
        this.broadcaster.broadcastWithChannel(
          { type: "refine-tasks:error", stepIndex, message: event.message },
          "refine-tasks",
        );
        return false;

      case "finished":
        return false;

      default:
        return true;
    }
  }

  /**
   * Commit tasks.json changes after a successful step.
   *
   * Uses execFileSync with array args (no shell) for command injection safety.
   * Checks git diff --staged before committing to skip no-op commits.
   * Logs errors but does not throw — pipeline continues.
   */
  private commitTasksChanges(stepIndex: number, step: RefineTasksStep): void {
    const tasksPath = join(this.cwd, TASKS_PATH);

    try {
      // Check tasks file exists
      if (!existsSync(tasksPath)) return;

      // Stage the tasks file
      execFileSync("git", ["add", TASKS_PATH], { cwd: this.cwd });

      // Check if there are staged changes (exit 0 = no changes)
      try {
        execFileSync("git", ["diff", "--staged", "--quiet", TASKS_PATH], { cwd: this.cwd });
        // Exit 0 — no staged changes, skip commit
        return;
      } catch {
        // Non-zero exit = there are staged changes — proceed to commit
      }

      // Build commit message with sanitized model/variant
      const sanitize = (s: string | undefined): string =>
        s ? s.replace(/[^a-zA-Z0-9\-_.]/g, "_") : "";

      const modelPart = step.model ? ` ${sanitize(step.model)}` : "";
      const variantPart = step.variant ? ` (${sanitize(step.variant)})` : "";
      const message = `refine-tasks: step ${stepIndex + 1} via ${step.agent}${modelPart}${variantPart}`;

      execFileSync("git", ["commit", "-m", message, "--", TASKS_PATH], { cwd: this.cwd });
    } catch (err) {
      // Log error but don't stop the pipeline
      console.error(
        `[refine-tasks] Failed to commit tasks.json changes for step ${stepIndex}:`,
        err instanceof Error ? err.message : String(err),
      );
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
    this.chatStream = null;
    this.session = null;
    this.turnBuffer = "";
    this.sessionCore.release();
  }
}
