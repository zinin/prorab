/**
 * RefinePrdManager — orchestrates sequential chat-based PRD refinement pipeline.
 *
 * Lifecycle: start → run N chat steps sequentially → commit after each step →
 * terminal outcome → cleanup → optionally auto-launch parse-prd.
 *
 * Each step uses interactive `startChat()` + `sendMessage()` (not batch `runSession()`),
 * supporting questions for Claude/OpenCode agents. Codex steps are fully autonomous
 * (no question support).
 *
 * Follows ChatManager patterns for question handling and ParsePrdManager patterns
 * for lifecycle (shared SessionCore, DriverRunner, WsBroadcaster).
 *
 * Key design decisions (from review iteration 1):
 * - Shared SessionCore — received via constructor, NOT created internally
 * - stop() only calls sessionCore.abort() + abortChat() — cleanup happens
 *   exclusively in runPipeline() finally block
 * - Auto-launch parse-prd happens AFTER cleanup() releases the lock
 * - Codex steps are fully autonomous (no questions)
 * - Git via execFileSync with array args for command injection safety
 * - existsSync check before each step to verify PRD file
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { AgentType, Verbosity } from "../types.js";
import type { RefinePrdManagerOutcome } from "../types-refine-prd.js";
import type { ChatEvent, QuestionAnswers, QuestionData } from "../core/drivers/types.js";
import type { SessionCore } from "./session/session-core.js";
import type { WsBroadcaster } from "./session/ws-broadcaster.js";
import { DriverRunner } from "./session/driver-runner.js";
import { parseSignal } from "../core/drivers/types.js";
import { buildRefinePrdSystemPrompt, buildRefinePrdTaskPrompt } from "../prompts/refine-prd.js";
import { PRD_PATH } from "../prompts/parse-prd.js";
import type { ParsePrdStartOptions } from "./parse-prd-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RefinePrdState = "idle" | "active" | "stopping";

export interface RefinePrdStep {
  agent: AgentType;
  model?: string;
  variant?: string;
}

export interface RefinePrdSession {
  id: string;
  steps: RefinePrdStep[];
  currentStepIndex: number;
  stepState: "running" | "question_pending";
  pendingQuestionId: string | null;
  pendingQuestionData: { questions: QuestionData[]; source: "claude" | "opencode" } | null;
  verbosity: Verbosity;
  responseLanguage?: string;
  userSettings: boolean;
  applyHooks: boolean;
}

export interface RefinePrdStartOptions {
  steps: RefinePrdStep[];
  verbosity?: Verbosity;
  responseLanguage?: string;
  userSettings?: boolean;
  applyHooks?: boolean;
  parsePrdOptions?: ParsePrdStartOptions | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when attempting to start refine-prd while a session is already active. */
export class RefinePrdSessionActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefinePrdSessionActiveError";
  }
}

/** Thrown when the refine-prd session is not in the expected state. */
export class RefinePrdNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefinePrdNotReadyError";
  }
}

/** Thrown when the provided question ID does not match the pending question. */
export class RefinePrdQuestionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefinePrdQuestionMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class RefinePrdManager {
  private session: RefinePrdSession | null = null;
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
   * `refine-prd:finished`, preventing duplicate broadcasts when `stop()`
   * races with normal pipeline completion.
   * Reset only in `start()` for the next session.
   */
  private finishedSent = false;

  /**
   * Terminal outcome of the last completed session.
   * Set inside `runPipeline()` before broadcasting `refine-prd:finished`.
   */
  private _outcome: RefinePrdManagerOutcome | null = null;

  /**
   * Options for auto-launching parse-prd after successful refinement.
   * Stored in start(), consumed in runPipeline() finally block after cleanup.
   */
  private _parsePrdOptions: ParsePrdStartOptions | null = null;

  /**
   * Reference to ParsePrdManager for auto-launch after successful refinement.
   * Injected via setParsePrdManager() during server wiring (serve.ts).
   */
  private parsePrdManager: { start(opts: ParsePrdStartOptions): Promise<void> } | null = null;

  constructor(
    private readonly cwd: string,
    private readonly sessionCore: SessionCore,
    private readonly broadcaster: WsBroadcaster,
  ) {}

  // ---- ParsePrdManager injection ----

  /**
   * Wire the ParsePrdManager reference for auto-launch after successful refinement.
   * Called during server initialization in serve.ts.
   */
  setParsePrdManager(manager: { start(opts: ParsePrdStartOptions): Promise<void> }): void {
    this.parsePrdManager = manager;
  }

  // ---- Accessors ----

  getState(): RefinePrdState {
    if (!this.session) return "idle";
    if (this.sessionCore.isStopping()) return "stopping";
    return "active";
  }

  getSession(): RefinePrdSession | null {
    return this.session;
  }

  /** Terminal outcome of the last session (null if no session has completed). */
  getOutcome(): RefinePrdManagerOutcome | null {
    return this._outcome;
  }

  // ---- Lifecycle ----

  /**
   * Start a new refine-prd pipeline session.
   *
   * 1. Validates that sessionCore is idle
   * 2. Acquires the session lock
   * 3. Resets guards and stores parsePrdOptions
   * 4. Creates session record
   * 5. Clears broadcaster buffer
   * 6. Broadcasts refine-prd:started
   * 7. Launches runPipeline() fire-and-forget
   */
  async start(opts: RefinePrdStartOptions): Promise<void> {
    if (!this.sessionCore.isIdle()) {
      throw new RefinePrdSessionActiveError(
        `Cannot start refine-prd: session is ${this.sessionCore.state}`,
      );
    }

    try {
      this.sessionCore.acquire();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new RefinePrdSessionActiveError(`Cannot start refine-prd: ${message}`);
    }

    try {
      // Reset guards for the new session
      this.finishedSent = false;
      this._outcome = null;
      this.turnBuffer = "";
      this._parsePrdOptions = opts.parsePrdOptions ?? null;

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

      // Broadcast refine-prd:started
      this.broadcaster.broadcastWithChannel(
        {
          type: "refine-prd:started",
          sessionId: this.session.id,
          steps: this.session.steps.map((s) => ({
            agent: s.agent,
            model: s.model,
            variant: s.variant,
          })),
          currentStepIndex: 0,
        },
        "refine-prd",
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
   * Stop the current refine-prd session.
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
      throw new RefinePrdNotReadyError("Cannot reply: no pending question");
    }

    if (questionId !== this.session.pendingQuestionId) {
      throw new RefinePrdQuestionMismatchError("Question ID mismatch");
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
   * Commits PRD changes after each successful step.
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

        // Verify PRD exists before each step
        if (!existsSync(join(this.cwd, PRD_PATH))) {
          this._outcome = {
            status: "failure",
            stepIndex: i,
            error: `PRD file not found at ${PRD_PATH}`,
          };
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
            type: "refine-prd:step_started",
            stepIndex: i,
            agent: steps[i].agent,
            model: steps[i].model,
          },
          "refine-prd",
        );

        // Run the step
        const stepResult = await this.runStep(steps[i], i, ownerSessionId);

        // Broadcast step_finished
        this.broadcaster.broadcastWithChannel(
          {
            type: "refine-prd:step_finished",
            stepIndex: i,
            stepOutcome: stepResult,
          },
          "refine-prd",
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

        // Commit PRD changes after successful step
        this.commitPrdChanges(i, steps[i]);
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
        // Capture parsePrdOptions before cleanup nulls everything
        const parsePrdOpts = this._parsePrdOptions;
        const outcome = this._outcome ?? { status: "cancelled" as const };
        this._outcome = outcome;

        // Cleanup: teardown driver, release lock, reset state
        await this.cleanup();

        // Broadcast finished (with one-shot guard)
        if (!this.finishedSent) {
          this.finishedSent = true;

          // Auto-launch parse-prd BEFORE broadcasting finished,
          // so hasNextStep is only set if launch succeeds.
          let autoLaunchSucceeded = false;
          if (outcome.status === "success" && parsePrdOpts && this.parsePrdManager) {
            try {
              await this.parsePrdManager.start(parsePrdOpts);
              autoLaunchSucceeded = true;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              this.broadcaster.broadcastWithChannel(
                { type: "refine-prd:error", message: `Auto-launch parse-prd failed: ${message}` },
                "refine-prd",
              );
            }
          }

          // Only set hasNextStep if auto-launch actually succeeded
          if (autoLaunchSucceeded && outcome.status === "success") {
            outcome.hasNextStep = true;
          }

          this.broadcaster.broadcastWithChannel(
            { type: "refine-prd:finished", outcome },
            "refine-prd",
          );
        }

        // Clear success outcome — the UI auto-transitions to parse-prd/refine-tasks,
        // so persisting it would cause stale refine-prd-progress on reconnect
        // (refine-prd-progress has higher view-mode priority than downstream stages).
        if (outcome.status === "success") {
          this._outcome = null;
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
    step: RefinePrdStep,
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
          this.broadcaster.broadcastWithChannel(event, "refine-prd");
        },
      );

      // Build prompts
      const systemPrompt = buildRefinePrdSystemPrompt({
        responseLanguage: this.session?.responseLanguage,
        stepIndex,
        totalSteps: this.session?.steps.length ?? 1,
      });
      const taskPrompt = buildRefinePrdTaskPrompt();

      // Broadcast prompts for UI visibility
      this.broadcaster.broadcastWithChannel(
        { type: "agent:system_prompt", text: systemPrompt },
        "refine-prd",
      );
      this.broadcaster.broadcastWithChannel(
        { type: "agent:task_prompt", text: taskPrompt },
        "refine-prd",
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
            { type: "refine-prd:error", stepIndex, message },
            "refine-prd",
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
          { type: "refine-prd:error", stepIndex, message },
          "refine-prd",
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
          "refine-prd",
        );
        return true;

      case "reasoning":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:reasoning", text: event.content },
          "refine-prd",
        );
        return true;

      case "tool":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:tool", name: event.name, summary: event.name, input: event.input },
          "refine-prd",
        );
        return true;

      case "tool_result":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:tool_result", summary: event.name, output: event.output },
          "refine-prd",
        );
        return true;

      case "context_usage":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:context_usage", ...event.usage },
          "refine-prd",
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
            type: "refine-prd:question",
            stepIndex,
            questionId: event.questionId,
            questions: event.questions,
            source: event.source,
          },
          "refine-prd",
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
          { type: "refine-prd:error", stepIndex, message: event.message },
          "refine-prd",
        );
        return false;

      case "finished":
        return false;

      default:
        return true;
    }
  }

  /**
   * Commit PRD changes after a successful step.
   *
   * Uses execFileSync with array args (no shell) for command injection safety.
   * Checks git diff --staged before committing to skip no-op commits.
   * Logs errors but does not throw — pipeline continues.
   */
  private commitPrdChanges(stepIndex: number, step: RefinePrdStep): void {
    const prdPath = join(this.cwd, PRD_PATH);

    try {
      // Check PRD file exists
      if (!existsSync(prdPath)) return;

      // Stage the PRD file
      execFileSync("git", ["add", PRD_PATH], { cwd: this.cwd });

      // Check if there are staged changes (exit 0 = no changes)
      try {
        execFileSync("git", ["diff", "--staged", "--quiet", PRD_PATH], { cwd: this.cwd });
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
      const message = `refine-prd: step ${stepIndex + 1} via ${step.agent}${modelPart}${variantPart}`;

      execFileSync("git", ["commit", "-m", message, "--", PRD_PATH], { cwd: this.cwd });
    } catch (err) {
      // Log error but don't stop the pipeline
      console.error(
        `[refine-prd] Failed to commit PRD changes for step ${stepIndex}:`,
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
    this._parsePrdOptions = null;
    this.sessionCore.release();
  }
}
