import { randomUUID } from "node:crypto";
import type { AgentType } from "../types.js";
import type { ChatEvent, QuestionAnswers } from "../core/drivers/types.js";
import type { SessionCore } from "./session/session-core.js";
import type { WsBroadcaster } from "./session/ws-broadcaster.js";
import { DriverRunner } from "./session/driver-runner.js";
import { parsePrdReadySignal } from "../core/drivers/types.js";
import { getProjectState } from "../core/project-state.js";

export type ChatState = "idle" | "active" | "question_pending" | "stopping";

export interface ChatSession {
  id: string;
  agent: AgentType;
  model?: string;
  variant?: string;
  systemPrompt?: string;
  state: ChatState;
  pendingQuestionId: string | null;
  awaitingUserInput: boolean;
}

export interface ChatStartOptions {
  agent: AgentType;
  model?: string;
  variant?: string;
  systemPrompt?: string;
  userSettings?: boolean;
  applyHooks?: boolean;
}

/** Thrown when attempting to start a chat while a session is already active. */
export class ChatSessionActiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatSessionActiveError";
  }
}

/** Thrown when the chat is not in the expected state for the requested operation. */
export class ChatNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatNotReadyError";
  }
}

/** Thrown when the provided question ID does not match the pending question. */
export class QuestionMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionMismatchError";
  }
}

export class ChatManager {
  private session: ChatSession | null = null;
  private driverRunner: DriverRunner | null = null;
  private chatStream: AsyncIterable<ChatEvent> | null = null;

  /**
   * Per-turn buffer: accumulates assistant `text` events within a single
   * turn.  Reset when a new session starts (`start()`) and after each
   * turn boundary (`idle` event).  Used by auto-finish logic to detect
   * terminal `<prd-ready>true</prd-ready>` in the accumulated text.
   */
  private turnBuffer = "";

  /**
   * One-shot guard: set to `true` once auto-finish has been triggered
   * for the current session, preventing duplicate auto-finish in race
   * conditions (e.g. two `idle` events arriving in quick succession).
   * Reset on session start.
   */
  private autoFinishFired = false;

  /**
   * One-shot guard: set to `true` immediately before broadcasting
   * `chat:finished`, preventing duplicate broadcasts when `stop()`
   * races with auto-finish (or normal stream end).  Both paths
   * (`consumeChatStream` finally block and `stop()`) check this flag
   * before broadcasting.  Reset only in `start()` for the next session.
   */
  private chatFinishedSent = false;

  constructor(
    private readonly cwd: string,
    private readonly sessionCore: SessionCore,
    private readonly broadcaster: WsBroadcaster,
  ) {}

  /* ---- Internal buffer/guard accessors (test-visible) ---- */

  /** @internal Exposed for unit tests only. */
  _getTurnBuffer(): string { return this.turnBuffer; }
  /** @internal Exposed for unit tests only. */
  _isAutoFinishFired(): boolean { return this.autoFinishFired; }

  /**
   * Translate a ChatEvent from the driver into a WsEvent and broadcast it.
   * Also updates session state for question/idle/error/finished events.
   *
   * Returns false if the event terminates the stream (error/finished),
   * signalling the consumer to stop iterating.
   */
  private handleChatEvent(event: ChatEvent): boolean {
    if (!this.session) return false;

    switch (event.type) {
      case "text":
        this.turnBuffer += event.content;
        this.broadcaster.broadcastWithChannel(
          { type: "agent:text", text: event.content },
          "chat",
        );
        return true;

      case "reasoning":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:reasoning", text: event.content },
          "chat",
        );
        return true;

      case "tool":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:tool", name: event.name, summary: event.name, input: event.input },
          "chat",
        );
        return true;

      case "tool_result":
        this.broadcaster.broadcastWithChannel(
          { type: "agent:tool_result", summary: event.name, output: event.output },
          "chat",
        );
        return true;

      case "context_usage":
        // Spread usage fields at top level to match LogEvent shape
        // (contextTokens, contextWindow, model, unitId when available).
        // Chat context may not have all execution-specific fields (e.g. unitId),
        // but spreading ensures whatever the driver provides is accessible
        // at the same level clients expect.
        this.broadcaster.broadcastWithChannel(
          { type: "agent:context_usage", ...event.usage },
          "chat",
        );
        return true;

      case "question":
        this.session.state = "question_pending";
        this.session.pendingQuestionId = event.questionId;
        this.session.awaitingUserInput = false;
        this.broadcaster.broadcastWithChannel(
          {
            type: "chat:question",
            questionId: event.questionId,
            questions: event.questions,
            source: event.source,
          },
          "chat",
        );
        return true;

      case "question_answer":
        // Store locally in session; not broadcast as a transport event
        return true;

      case "idle": {
        // Set state to "active" so that chat:idle is broadcast with the
        // correct session state.  On the auto-finish path (shouldAutoFinish
        // below), state is immediately overridden to "stopping" before any
        // async yield — safe in single-threaded Node.js, no external code
        // can observe this intermediate state.
        this.session.state = "active";
        this.session.pendingQuestionId = null;
        this.session.awaitingUserInput = true;
        this.broadcaster.broadcastWithChannel(
          { type: "chat:idle" },
          "chat",
        );

        // Check for terminal <prd-ready> signal in the accumulated turn text
        // before resetting the buffer.  The guard prevents duplicate auto-finish
        // when multiple idle events arrive in quick succession.
        const shouldAutoFinish =
          !this.autoFinishFired && parsePrdReadySignal(this.turnBuffer);

        // Reset the per-turn buffer for the next assistant turn
        this.turnBuffer = "";

        if (shouldAutoFinish) {
          this.autoFinishFired = true;
          // Immediately block further user input: mark the session as stopping
          // so that sendMessage() rejects during the async cleanup window
          // (e.g. while teardown() is in progress).
          this.session.state = "stopping";
          this.session.awaitingUserInput = false;
          // Gracefully terminate the stream — the consumeChatStream finally
          // block will call cleanup() and broadcast chat:finished.
          // No abort is needed: returning false breaks the for-await-of loop,
          // which calls the generator's return() method for clean teardown.
          return false;
        }

        return true;
      }

      case "error":
        // Broadcast error first; cleanup + chat:finished happen in consumeChatStream finally
        this.broadcaster.broadcastWithChannel(
          { type: "chat:error", message: event.message },
          "chat",
        );
        return false; // terminates the stream

      case "finished":
        // chat:finished is broadcast after cleanup in consumeChatStream finally
        return false; // terminates the stream

      default:
        return true;
    }
  }

  /**
   * Consume the async iterable chat stream, translating each ChatEvent
   * to a WsEvent and broadcasting it. On completion or error, performs
   * cleanup and always sends a terminal `chat:finished` event.
   *
   * Cleanup is guarded by a session ownership token (`ownerSessionId`):
   * if `stop()` has already cleaned up and a new `start()` has created a
   * fresh session, the stale finally block is a no-op — preventing it
   * from destroying the new session's driver, lock, and state.
   */
  private async consumeChatStream(): Promise<void> {
    if (!this.chatStream || !this.session) return;

    // Capture session ID at stream start — used in finally/catch to verify
    // this stream still owns the current session.
    const ownerSessionId = this.session.id;

    try {
      for await (const event of this.chatStream) {
        if (!this.session) break;
        const continueStream = this.handleChatEvent(event);
        if (!continueStream) break;
      }
    } catch (err) {
      // Stream threw an exception — broadcast chat:error only if this
      // stream still owns the session (same ID, not replaced by a new one).
      // When stop() is called, cleanup() nulls this.session before the
      // stream throws its AbortError, so we skip the spurious error broadcast.
      // Also prevents leaking an error into a newly started session.
      if (this.session?.id === ownerSessionId) {
        const message = err instanceof Error ? err.message : String(err);
        this.broadcaster.broadcastWithChannel(
          { type: "chat:error", message },
          "chat",
        );
      }
    } finally {
      // Only perform cleanup if this stream still owns the current session.
      // After stop() calls cleanup() and nulls this.session, this guard
      // prevents the stale finally block from destroying a new session
      // that may have been started between stop() returning and here.
      if (this.session?.id === ownerSessionId) {
        await this.cleanup();
        // Guard against duplicate chat:finished: stop() may have pre-empted
        // us during the async cleanup (e.g. teardown was blocking) and
        // already broadcast chat:finished.
        if (!this.chatFinishedSent) {
          this.chatFinishedSent = true;
          // Include current project state so the frontend can update hasPrd
          // immediately without a separate fetchStatus() HTTP round-trip.
          const projectState = getProjectState(this.cwd);
          this.broadcaster.broadcastWithChannel(
            { type: "chat:finished", hasPrd: projectState.hasPrd, hasTasksFile: projectState.hasTasksFile, hasValidTasks: projectState.hasValidTasks },
            "chat",
          );
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
    this.chatStream = null;
    this.session = null;
    this.turnBuffer = "";
    this.autoFinishFired = false;
    this.sessionCore.release();
  }

  /**
   * Start a new chat session.
   *
   * 1. Validates that sessionCore is idle
   * 2. Acquires the session lock
   * 3. Creates and sets up a DriverRunner
   * 4. Starts the driver chat stream
   * 5. Broadcasts chat:started event
   *
   * On error during setup, releases the session and cleans up.
   */
  async start(opts: ChatStartOptions): Promise<void> {
    if (!this.sessionCore.isIdle()) {
      throw new ChatSessionActiveError(`Cannot start chat: session is ${this.sessionCore.state}`);
    }

    try {
      this.sessionCore.acquire();
    } catch (err) {
      // Lock contention (e.g. execution already holds the file lock for the
      // same cwd) should surface as a 409 conflict, not a generic 500.
      const message = err instanceof Error ? err.message : String(err);
      throw new ChatSessionActiveError(`Cannot start chat: ${message}`);
    }

    try {
      // Reset per-turn buffer, auto-finish guard, and finished-broadcast
      // guard for the new session
      this.turnBuffer = "";
      this.autoFinishFired = false;
      this.chatFinishedSent = false;

      // Create session record
      this.session = {
        id: randomUUID(),
        agent: opts.agent,
        model: opts.model,
        variant: opts.variant,
        systemPrompt: opts.systemPrompt,
        state: "active",
        pendingQuestionId: null,
        awaitingUserInput: true,
      };

      // Create and setup driver
      this.driverRunner = new DriverRunner(opts.agent, opts.model, opts.userSettings ?? false, opts.applyHooks ?? false);
      await this.driverRunner.setup({
        verbosity: "info",
        abortSignal: this.sessionCore.getAbortSignal(),
      });

      // Start the chat event stream
      const driver = this.driverRunner.getDriver();
      this.chatStream = driver.startChat({
        systemPrompt: opts.systemPrompt,
        cwd: this.cwd,
        verbosity: "info",
        variant: opts.variant,
      });

      // Clear the ring buffer so that reconnecting clients do not replay
      // events from a previous chat (or execution) session.
      this.broadcaster.clearBuffer();

      // Broadcast chat:started to WS clients
      this.broadcaster.broadcastWithChannel(
        { type: "chat:started", sessionId: this.session.id, agent: this.session.agent, model: this.session.model },
        "chat",
      );

      // Broadcast system prompt so the chat UI can display it (trace-level visibility)
      if (opts.systemPrompt) {
        this.broadcaster.broadcastWithChannel(
          { type: "agent:system_prompt", text: opts.systemPrompt },
          "chat",
        );
      }

      // Start consuming the chat stream in the background.
      // Errors are handled inside consumeChatStream; the promise is fire-and-forget.
      void this.consumeChatStream();
    } catch (err) {
      // Cleanup on failure: teardown driver, release session, reset state
      await this.cleanup();
      throw err;
    }
  }

  /**
   * Send a user message to the active chat session.
   *
   * Preconditions:
   * - Session must exist and be in 'active' state
   * - awaitingUserInput must be true (driver is idle, ready for input)
   * - No pending question (pendingQuestionId must be null)
   */
  async sendMessage(text: string): Promise<void> {
    if (
      !this.session ||
      this.session.state !== "active" ||
      !this.session.awaitingUserInput ||
      this.session.pendingQuestionId !== null
    ) {
      throw new ChatNotReadyError("Cannot send message: chat is not waiting for user input");
    }

    try {
      this.session.awaitingUserInput = false;

      // Broadcast user message so it enters the ring buffer (survives F5 replay)
      this.broadcaster.broadcastWithChannel(
        { type: "chat:user_message", text },
        "chat",
      );

      const driver = this.driverRunner?.getDriver();
      if (!driver) throw new Error("Cannot send message: driver not available");
      driver.sendMessage(text);
    } catch (err) {
      // Restore awaitingUserInput so the user can retry
      if (this.session) this.session.awaitingUserInput = true;
      throw err;
    }
  }

  /**
   * Reply to a pending agent question.
   *
   * Preconditions:
   * - Session must exist and be in 'question_pending' state
   * - questionId must match the pending question
   */
  async replyQuestion(questionId: string, answers: QuestionAnswers): Promise<void> {
    if (!this.session || this.session.state !== "question_pending") {
      throw new ChatNotReadyError("Cannot reply: no pending question");
    }

    if (questionId !== this.session.pendingQuestionId) {
      throw new QuestionMismatchError("Question ID mismatch");
    }

    const driver = this.driverRunner?.getDriver();
    if (!driver) throw new Error("Cannot reply: driver not available");
    try {
      driver.replyQuestion(questionId, answers);
    } catch (err) {
      // On failure, leave state as question_pending with the original
      // pendingQuestionId so the user can retry. State mutations below
      // only execute on success — no restoration needed here.
      if (this.session) {
        this.session.state = "question_pending";
        this.session.pendingQuestionId = questionId;
      }
      throw err;
    }

    this.session.pendingQuestionId = null;
    this.session.state = "active";
    this.session.awaitingUserInput = false;
  }

  /**
   * Stop the current chat session.
   *
   * Aborts the driver chat, signals sessionCore to stop,
   * tears down driver, releases session lock, and resets state.
   * No-op if no session is active.
   *
   * Broadcasts `chat:finished` directly — the background stream's
   * finally block will see that the session was already cleaned up
   * (ownership token mismatch) and skip its own broadcast.
   */
  async stop(): Promise<void> {
    if (!this.session) return;

    this.session.state = "stopping";
    this.session.awaitingUserInput = false;

    // Abort the driver chat stream (getDriver() may throw if setup() is still in progress)
    try {
      this.driverRunner?.getDriver().abortChat();
    } catch {
      // Driver not yet initialised — setup() still running. Abort will
      // propagate via sessionCore.abort() → abortSignal on setup().
    }

    // Signal sessionCore to stop
    this.sessionCore.abort();

    // Cleanup: teardown driver, release lock, reset state
    await this.cleanup();

    // Broadcast chat:finished here — the stale stream's finally block
    // will see session=null (ownership mismatch) and skip its broadcast.
    // Guard against duplicate: auto-finish's consumeChatStream may have
    // already broadcast chat:finished before stop() was called.
    if (!this.chatFinishedSent) {
      this.chatFinishedSent = true;
      const projectState = getProjectState(this.cwd);
      this.broadcaster.broadcastWithChannel(
        { type: "chat:finished", hasPrd: projectState.hasPrd, hasTasksFile: projectState.hasTasksFile, hasValidTasks: projectState.hasValidTasks },
        "chat",
      );
    }
  }

  getState(): ChatState {
    return this.session?.state ?? "idle";
  }

  getSession(): ChatSession | null {
    return this.session;
  }
}
