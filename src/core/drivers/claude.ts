import path from "node:path";
import { createRequire } from "node:module";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKUserMessage, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSignal, IterationResult, ModelEntry } from "../../types.js";
import type { AgentDriver, ChatEvent, ChatOptions, QuestionData, QuestionAnswers, SessionOptions } from "./types.js";
import { parseSignal, parseReport, parseReviewReport } from "./types.js";
import { dim, truncate, SessionLogger } from "./logging.js";
import { getContextWindow, setContextWindow } from "./context-window.js";
import { AsyncQueue } from "./async-queue.js";

/**
 * Resolve the correct Claude Code native binary on Linux.
 *
 * The SDK's built-in selection (sdk.mjs:W7) tries the musl package before the
 * glibc one and returns whichever resolves first. If both optional packages
 * end up in node_modules (stale installs, Docker layers, forced installs),
 * the musl binary wins on glibc hosts and spawn fails with ENOENT because
 * /lib/ld-musl-x86_64.so.1 is absent. We detect the host libc via Node's
 * process.report and pin `pathToClaudeCodeExecutable` to the matching package
 * so the SDK skips its guessing step entirely. Returns undefined on
 * non-Linux, unsupported arch, or when the resolved package is missing.
 */
function resolveClaudeCodeExecutable(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const arch = process.arch;
  if (arch !== "x64" && arch !== "arm64") return undefined;

  const report = (process.report?.getReport?.() ?? {}) as {
    header?: { glibcVersionRuntime?: string };
  };
  const isGlibc = Boolean(report.header?.glibcVersionRuntime);
  const suffix = isGlibc ? "" : "-musl";
  const pkgName = `@anthropic-ai/claude-agent-sdk-linux-${arch}${suffix}`;

  const req = createRequire(import.meta.url);
  try {
    const pkgJson = req.resolve(`${pkgName}/package.json`);
    return path.join(path.dirname(pkgJson), "claude");
  } catch {
    return undefined;
  }
}

const CLAUDE_CODE_EXECUTABLE = resolveClaudeCodeExecutable();

/** Detect AbortError from the SDK (DOMException or Error with name "AbortError"). */
function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message === "This operation was aborted");
}

/** Mutable state accumulated during a Claude SDK session. */
interface ClaudeContext {
  logger: SessionLogger;
  cwd: string;
  resultText: string;
  durationMs: number;
  costUsd: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  unitId: string;
  /** Maximum agentic turns from SessionOptions; mirrors SDK's maxTurns. */
  maxTurns: number;
  /** Live counter incremented per unique main-thread API call (deduped by message.id). */
  numApiCalls: number;
  /**
   * Anthropic API message IDs already counted toward numApiCalls. The SDK
   * splits a single API response into one SDKAssistantMessage per content
   * block (thinking / text / tool_use) when `message.content.length > 1`,
   * and all splits share `message.id`. Without dedup the live turn indicator
   * overshoots the SDK's `num_turns` (e.g. 210 vs 152) on turns rich in
   * content blocks.
   *
   * Memory: bounded by the number of distinct main-thread API calls in one
   * session (≤ maxTurns ≈ 200 in practice → ~10 KB). The Set lives on
   * ClaudeContext, recreated by `createContext` per `runSession`, so there
   * is no cross-session accumulation.
   */
  seenApiMessageIds: Set<string>;
  /** Tracks displayed tool_progress events (5s bucket throttle). */
  reportedTools: Set<string>;
}

export class ClaudeDriver implements AgentDriver {
  // Chat state fields — null means no active chat session
  private messageQueue: AsyncQueue<string> | null = null;
  private chatEventQueue: AsyncQueue<ChatEvent> | null = null;
  private pendingQuestions: Map<string, {
    toolUseId: string;
    resolve: (answers: QuestionAnswers) => void;
    reject: (reason?: Error) => void;
  }> = new Map();
  private chatAbortController: AbortController | null = null;
  private questionIdCounter = 0;
  /** Cumulative input tokens from previous result messages (for per-turn delta). */
  private prevCumulativeContextTokens = 0;
  /**
   * Latest per-API-call context tokens from stream_event/message_start.
   * When includePartialMessages is enabled, this captures the accurate
   * context window usage from the most recent API call.  The `result`
   * handler prefers this value over the cumulative delta which over-counts
   * during multi-API-call turns (tool use).
   */
  private lastStreamContextTokens = 0;
  /** Actual model resolved by the SDK (from system init message). */
  private chatResolvedModel: string | null = null;

  constructor(
    private model?: string,
    private useUserSettings: boolean = false,
  ) {}

  /** Generate a unique question ID for the current chat session. */
  private generateQuestionId(): string {
    return `q-${Date.now()}-${++this.questionIdCounter}`;
  }

  async runSession(opts: SessionOptions): Promise<IterationResult> {
    const ctx = this.createContext(opts);

    // --- Build SDK query options ---
    const settingSources: Array<"user" | "project" | "local"> = ["project"];
    if (this.useUserSettings) {
      settingSources.unshift("user");
    }

    const queryOptions: Record<string, unknown> = {
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      maxTurns: opts.maxTurns,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      settingSources,
      abortController: opts.abortController,
      stderr: ctx.logger.isQuiet ? undefined : (data: string) => {
        const trimmed = data.trim();
        if (trimmed) {
          console.error(dim(`  [stderr] ${trimmed}`));
        }
      },
    };
    if (this.model) {
      queryOptions.model = this.model;
    }
    if (opts.variant) {
      queryOptions.effort = opts.variant;
    }
    if (opts.hooks) {
      queryOptions.hooks = opts.hooks;
    }
    if (opts.env) {
      queryOptions.env = opts.env;
    }
    if (CLAUDE_CODE_EXECUTABLE) {
      queryOptions.pathToClaudeCodeExecutable = CLAUDE_CODE_EXECUTABLE;
    }

    // --- Start SDK session ---
    const session = query({
      prompt: opts.prompt,
      options: queryOptions as Parameters<typeof query>[0]["options"],
    });

    // --- Event loop ---
    try {
      for await (const message of session) {
        const msg = message as Record<string, unknown>;

        if (msg.type === "result") {
          const errorResult = this.handleResult(msg, ctx);
          if (errorResult) return errorResult;
          break; // Success — stop iterating (background tasks may keep iterator open)
        }

        this.dispatchMessage(msg, ctx);
      }
    } catch (err) {
      console.error("SDK session error:", err);
      const errorMessage = err instanceof Error
        ? `${err.message}\n${err.stack ?? ""}`
        : String(err);
      return this.buildIterationResult(ctx, { type: "error", message: errorMessage });
    }

    // --- Build final result ---
    const signal = parseSignal(ctx.resultText);
    const agentReport = parseReport(ctx.resultText);
    const reviewReport = parseReviewReport(ctx.resultText);
    return this.buildIterationResult(ctx, signal, agentReport, reviewReport);
  }

  async listModels(): Promise<ModelEntry[]> {
    const session = query({ prompt: "", options: {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(CLAUDE_CODE_EXECUTABLE ? { pathToClaudeCodeExecutable: CLAUDE_CODE_EXECUTABLE } : {}),
    } });
    try {
      const models = await session.supportedModels();
      // SDK only reports supportedEffortLevels for "default" model,
      // but effort works with all Claude models — propagate to all entries.
      // Filter out "max" — not available for Claude.ai subscribers.
      const effortLevels = models
        .flatMap((m) => m.supportedEffortLevels ?? [])
        .filter((v, i, a) => a.indexOf(v) === i)
        .filter((v) => v !== "max");
      return models.map((m) => ({
        id: m.value,
        name: m.displayName,
        ...(effortLevels.length > 0 ? { variants: effortLevels } : {}),
      }));
    } finally {
      session.return?.(undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Interactive chat methods
  // ---------------------------------------------------------------------------

  /**
   * Start an interactive chat session using SDK query() with an internal event bridge.
   *
   * Uses `canUseTool` to intercept AskUserQuestion tool calls: when the agent
   * asks a question, it is published to an internal `chatEventQueue` (the event
   * bridge), and the canUseTool callback awaits a Promise that is resolved when
   * the caller invokes `replyQuestion()`. All other tools are auto-approved.
   *
   * The returned AsyncIterable merges the SDK event stream and the internal
   * event bridge into a unified `ChatEvent` stream.
   *
   * Initialization (queues, abort controller, SDK session) is **eager** — it
   * happens synchronously when startChat() is called, so the caller can call
   * `sendMessage()` immediately without first iterating the returned stream.
   * The SDK session blocks on the prompt iterable until the first `sendMessage()`.
   */
  startChat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    // Guard: prevent concurrent sessions — existing state would be silently
    // overwritten, leaving the old generator with dangling references and
    // orphaned pending questions.
    if (this.messageQueue !== null) {
      throw new Error(
        "A chat session is already active. Call abortChat() before starting a new one.",
      );
    }

    // Eagerly initialize chat state (before iteration starts)
    this.chatAbortController = new AbortController();
    this.messageQueue = new AsyncQueue<string>();
    this.chatEventQueue = new AsyncQueue<ChatEvent>();
    this.pendingQuestions.clear();
    this.questionIdCounter = 0;
    this.prevCumulativeContextTokens = 0;
    this.lastStreamContextTokens = 0;
    this.chatResolvedModel = null;

    // Build SDK query options
    const settingSources: Array<"user" | "project" | "local"> = ["project"];
    if (this.useUserSettings) {
      settingSources.unshift("user");
    }

    const queryOptions: Record<string, unknown> = {
      systemPrompt: opts.systemPrompt,
      cwd: opts.cwd,
      maxTurns: opts.maxTurns,
      permissionMode: "default",
      abortController: this.chatAbortController,
      settingSources,
      canUseTool: this.createCanUseTool(),
      // Enable stream_event messages so we get per-API-call usage from
      // message_start.  Without this, the only source is the cumulative
      // modelUsage in `result`, whose delta over-counts during multi-API-call
      // turns (tool use) — see sdkMessageToChatEvents / stream_event handler.
      includePartialMessages: true,
    };
    if (this.model) {
      queryOptions.model = this.model;
    }
    if (opts.variant) {
      queryOptions.effort = opts.variant;
    }
    if (opts.hooks) {
      queryOptions.hooks = opts.hooks;
    }
    if (opts.env) {
      queryOptions.env = opts.env;
    }
    if (CLAUDE_CODE_EXECUTABLE) {
      queryOptions.pathToClaudeCodeExecutable = CLAUDE_CODE_EXECUTABLE;
    }

    // Start SDK session eagerly — it blocks on the prompt iterable
    // until the first sendMessage() call pushes a message.
    const session = query({
      prompt: this.createPromptIterable(),
      options: queryOptions as Parameters<typeof query>[0]["options"],
    });

    // Capture local reference — the generator body runs lazily, and by the
    // time the consumer iterates, abortChat() may have set this.chatEventQueue
    // to null. Passing the reference eagerly avoids a null dereference.
    const eventQueue = this.chatEventQueue;

    // Return a lazy generator that merges SDK events and the event bridge
    return this.createChatEventStream(session, eventQueue);
  }

  /**
   * Internal generator returned by startChat(). Merges the SDK stream with the
   * internal event bridge and performs cleanup in the finally block.
   */
  private async *createChatEventStream(
    session: AsyncIterable<unknown>,
    eventQueue: AsyncQueue<ChatEvent>,
  ): AsyncGenerator<ChatEvent> {
    try {
      yield* this.mergeChatStreams(session, eventQueue);
    } finally {
      this.cleanupChat();
    }
  }

  /**
   * Send a user message to the active chat session.
   * Pushes to the internal messageQueue which feeds into the SDK prompt iterable.
   *
   * The first call starts the first SDK turn; subsequent calls trigger follow-up turns.
   * The method is synchronous — it only enqueues the message for the SDK to pick up
   * via the async prompt iterable.
   */
  sendMessage(text: string): void {
    if (!this.messageQueue) {
      throw new Error("No active chat session. Call startChat() first.");
    }
    if (this.chatAbortController?.signal.aborted) {
      throw new Error("Chat session has been aborted.");
    }
    if (this.messageQueue.isClosed) {
      throw new Error("No active chat session. Call startChat() first.");
    }
    this.messageQueue.push(text);
  }

  /**
   * Reply to a pending AskUserQuestion by resolving its Promise.
   * The canUseTool callback will resume and return the answers to the SDK.
   */
  replyQuestion(questionId: string, answers: QuestionAnswers): void {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      throw new Error(
        `No pending question with id '${questionId}'. ` +
        `Available: ${Array.from(this.pendingQuestions.keys()).join(", ") || "none"}`,
      );
    }

    // Remove from map immediately so repeated reply throws
    this.pendingQuestions.delete(questionId);

    // Resolve the Promise — canUseTool callback continues with the answers
    pending.resolve(answers);
  }

  /**
   * Abort the active chat session.
   *
   * Sequence:
   * 1. Abort the SDK session via AbortController — signals the SDK to stop.
   *    The abort event synchronously fires any registered abort listeners
   *    in `canUseTool`, which reject pending question Promises.
   * 2. Reject any remaining pending questions that weren't handled by the
   *    abort signal listener (defensive — Promise.reject is a no-op if
   *    the Promise is already settled).
   * 3. Close internal queues so async iterators terminate.
   * 4. Reset state to null — allows starting a new session via startChat().
   *
   * Safe to call multiple times (idempotent).
   */
  abortChat(): void {
    // 1. Abort the SDK session — fires abort signal synchronously
    if (this.chatAbortController) {
      this.chatAbortController.abort();
    }

    // 2. Reject all pending questions — unblock canUseTool callbacks
    const abortError = new Error("Chat aborted");
    for (const [, pending] of this.pendingQuestions) {
      pending.reject(abortError);
    }
    this.pendingQuestions.clear();

    // 3. Close internal queues
    if (this.messageQueue && !this.messageQueue.isClosed) {
      this.messageQueue.close();
    }
    if (this.chatEventQueue && !this.chatEventQueue.isClosed) {
      this.chatEventQueue.close();
    }

    // 4. Reset state — allows a new session via startChat()
    this.chatAbortController = null;
    this.messageQueue = null;
    this.chatEventQueue = null;
  }

  // ---------------------------------------------------------------------------
  // Private: chat helpers
  // ---------------------------------------------------------------------------

  /**
   * Create the `canUseTool` callback for interactive chat sessions.
   *
   * For AskUserQuestion: publishes a question event to the internal event bridge
   * (chatEventQueue), then awaits the answer via a pending Promise. When
   * `replyQuestion()` is called, the Promise resolves and the callback returns
   * `{ behavior: 'allow', updatedInput: { ...original, answers } }`.
   *
   * For all other tools: immediately returns `{ behavior: 'allow', updatedInput }`.
   *
   * `updatedInput` MUST be present in every "allow" reply — Claude Code parses
   * the SDK host response with a Zod schema that requires the field
   * (`d7.record(d7.string(), d7.unknown())`, no `.optional()`). Returning
   * `{ behavior: 'allow' }` without `updatedInput` makes Claude Code convert
   * the response into `{ behavior: 'deny', message: "Tool permission request
   * failed: ZodError ..." }`, blocking Edit/Write/Bash tool calls in chat
   * sessions. The SDK's TypeScript type marks `updatedInput` as optional, so
   * this is not caught at compile time.
   */
  private createCanUseTool(): (
    toolName: string,
    toolInput: Record<string, unknown>,
    options: { signal: AbortSignal; toolUseID: string },
  ) => Promise<PermissionResult> {
    return async (
      toolName: string,
      toolInput: Record<string, unknown>,
      toolOpts: { signal: AbortSignal; toolUseID: string },
    ): Promise<PermissionResult> => {
      if (toolName !== "AskUserQuestion") {
        return { behavior: "allow", updatedInput: toolInput };
      }

      const questionId = this.generateQuestionId();
      const questions = this.extractQuestions(toolInput);

      // Publish question event to the internal event bridge
      if (this.chatEventQueue && !this.chatEventQueue.isClosed) {
        this.chatEventQueue.push({
          type: "question",
          questionId,
          questions,
          source: "claude",
        });
      }

      // Wait for the answer from replyQuestion().
      // On abort, the pending promise rejects — we catch it and return a
      // graceful "allow" with empty answers so the SDK does not receive an
      // unhandled rejection from canUseTool. The abort signal has already
      // been fired, so the SDK session will terminate shortly after.
      let answers: QuestionAnswers;
      try {
        answers = await new Promise<QuestionAnswers>((resolve, reject) => {
          this.pendingQuestions.set(questionId, {
            toolUseId: toolOpts.toolUseID,
            resolve,
            reject,
          });

          // If the chat is aborted, reject this pending question
          this.chatAbortController?.signal.addEventListener(
            "abort",
            () => reject(new Error("Chat aborted")),
            { once: true },
          );
        });
      } catch {
        // Abort or other error — return a graceful allow without answers.
        // `updatedInput` is required by the Claude Code permission-result
        // schema; even though the SDK session is being torn down, the response
        // is still parsed before the abort fully propagates, so an incomplete
        // shape would surface as a ZodError instead of being ignored.
        this.pendingQuestions.delete(questionId);
        return { behavior: "allow" as const, updatedInput: toolInput };
      }

      this.pendingQuestions.delete(questionId);

      // Normalize answers to Record<string, string> — the SDK's AskUserQuestion
      // expects string values; multi-select arrays are joined as comma-separated.
      const normalizedAnswers: Record<string, string> = {};
      for (const [key, value] of Object.entries(answers)) {
        normalizedAnswers[key] = Array.isArray(value) ? value.join(", ") : value;
      }

      // Return the original input augmented with answers
      return {
        behavior: "allow",
        updatedInput: { ...toolInput, answers: normalizedAnswers },
      };
    };
  }

  /**
   * Create an async iterable adapter that transforms simple text messages
   * from `messageQueue` into `SDKUserMessage` objects for the SDK.
   */
  private async *createPromptIterable(): AsyncGenerator<SDKUserMessage> {
    if (!this.messageQueue) return;
    for await (const text of this.messageQueue) {
      yield {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
      } as SDKUserMessage;
    }
  }

  /**
   * Extract QuestionData[] from the AskUserQuestion tool input.
   * Handles the SDK's AskUserQuestion input format with questions array.
   */
  private extractQuestions(toolInput: Record<string, unknown>): QuestionData[] {
    const questions = toolInput.questions;
    if (!Array.isArray(questions)) return [];
    return questions.map((q: Record<string, unknown>) => ({
      question: String(q.question || ""),
      header: String(q.header || ""),
      options: Array.isArray(q.options)
        ? (q.options as Array<Record<string, unknown>>).map((o) => ({
            label: String(o.label || ""),
            description: String(o.description || ""),
          }))
        : [],
      multiSelect: Boolean(q.multiSelect),
    }));
  }

  /**
   * Merge two async streams — the SDK event stream and the internal event bridge
   * (chatEventQueue) — into a single ChatEvent stream.
   *
   * Uses Promise.race to interleave events from both sources. When the SDK
   * stream ends (agent session completes), the event bridge is closed too.
   */
  private async *mergeChatStreams(
    sdkStream: AsyncIterable<unknown>,
    eventQueue: AsyncQueue<ChatEvent>,
  ): AsyncGenerator<ChatEvent> {
    type Tagged =
      | { source: "sdk"; result: IteratorResult<unknown> }
      | { source: "queue"; result: IteratorResult<ChatEvent> };

    const sdkIter = sdkStream[Symbol.asyncIterator]();
    const queueIter = eventQueue[Symbol.asyncIterator]();

    /** Wrap iterator .next() so that abort/SDK errors don't surface as uncaught. */
    const safeSdkNext = (): Promise<Tagged> =>
      sdkIter.next().then(
        (r) => ({ source: "sdk" as const, result: r }),
        (err) => {
          // Treat AbortError (and any other SDK error during iteration) as
          // stream termination rather than letting it propagate as an
          // unhandled rejection from Promise.race.
          if (isAbortError(err)) {
            return { source: "sdk" as const, result: { value: undefined, done: true as const } };
          }
          // Re-wrap non-abort errors so they surface as an error event
          // rather than crashing the merge loop.
          return { source: "sdk" as const, result: { value: { _error: err }, done: true as const } };
        },
      );

    const safeQueueNext = (): Promise<Tagged> =>
      queueIter.next().then(
        (r) => ({ source: "queue" as const, result: r }),
      );

    let sdkNext: Promise<Tagged> | null = safeSdkNext();
    let queueNext: Promise<Tagged> | null = safeQueueNext();

    while (sdkNext || queueNext) {
      const candidates = [sdkNext, queueNext].filter(Boolean) as Promise<Tagged>[];
      if (candidates.length === 0) break;

      let resolved: Tagged;
      try {
        resolved = await Promise.race(candidates);
      } catch (err) {
        // Defensive: if Promise.race itself rejects (shouldn't happen with
        // safe wrappers above, but guard against unexpected queue errors)
        if (!isAbortError(err)) {
          yield { type: "error", message: err instanceof Error ? err.message : String(err) };
        }
        break;
      }

      if (resolved.source === "sdk") {
        if (resolved.result.done) {
          // Check if termination was due to a non-abort SDK error
          const val = resolved.result.value as Record<string, unknown> | undefined;
          if (val && "_error" in val) {
            const sdkErr = val._error;
            yield {
              type: "error",
              message: sdkErr instanceof Error ? sdkErr.message : String(sdkErr),
            };
          }
          sdkNext = null;
          // SDK stream ended — close the event bridge too
          if (!eventQueue.isClosed) eventQueue.close();
        } else {
          const events = this.sdkMessageToChatEvents(
            resolved.result.value as Record<string, unknown>,
          );
          for (const event of events) {
            yield event;
          }
          sdkNext = safeSdkNext();
        }
      } else {
        if (resolved.result.done) {
          queueNext = null;
        } else {
          yield resolved.result.value;
          queueNext = safeQueueNext();
        }
      }
    }

    yield { type: "finished" };
  }

  /**
   * Convert an SDK message into zero or more ChatEvent objects.
   * Maps assistant text → `text`, tool_use → `tool`, tool_use_summary → `tool_result`,
   * stream_event usage → `context_usage`, result → `finished`.
   */
  private sdkMessageToChatEvents(msg: Record<string, unknown>): ChatEvent[] {
    const events: ChatEvent[] = [];

    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init" && msg.model) {
          this.chatResolvedModel = String(msg.model);
        }
        break;
      }
      case "assistant": {
        const content = (
          msg as unknown as {
            message: { content: Array<Record<string, unknown>> };
          }
        ).message.content;
        for (const block of content) {
          if (block.type === "text") {
            events.push({ type: "text", content: String(block.text) });
          }
          if (block.type === "tool_use") {
            events.push({
              type: "tool",
              name: String(block.name || "unknown"),
              input: (block.input || {}) as Record<string, unknown>,
            });
          }
        }
        break;
      }
      case "tool_use_summary": {
        const summary = String(msg.summary || "").trim();
        if (summary) {
          events.push({ type: "tool_result", name: "tool", output: summary });
        }
        break;
      }
      case "stream_event": {
        const event = msg.event as Record<string, unknown> | undefined;
        if (event?.type === "message_start") {
          const message = event.message as Record<string, unknown> | undefined;
          const usage = message?.usage as Record<string, number> | undefined;
          if (usage) {
            const contextTokens =
              (usage.input_tokens ?? 0) +
              (usage.cache_read_input_tokens ?? 0) +
              (usage.cache_creation_input_tokens ?? 0);
            if (contextTokens > 0) {
              this.lastStreamContextTokens = contextTokens;
              // Emit context_usage on every API call so the UI shows real-time
              // context tracking during long tool-use turns. Skip when the model
              // is not yet known (no system/init message) — the final result
              // message will carry the resolved model and emit the definitive
              // context_usage event.
              const model = this.chatResolvedModel || this.model || "";
              if (model) {
                events.push({
                  type: "context_usage",
                  usage: {
                    contextTokens,
                    contextWindow: getContextWindow(model),
                    model,
                  },
                });
              }
            }
          }
        }
        break;
      }
      case "result": {
        // Extract context usage from modelUsage in the result message.
        // modelUsage is CUMULATIVE across all turns.
        const modelUsageMap = (msg.modelUsage || {}) as Record<string, {
          inputTokens?: number;
          cacheReadInputTokens?: number;
          cacheCreationInputTokens?: number;
          contextWindow?: number;
        }>;
        let cumulativeContextTokens = 0;
        for (const [modelName, usage] of Object.entries(modelUsageMap)) {
          cumulativeContextTokens +=
            (usage.inputTokens ?? 0) +
            (usage.cacheReadInputTokens ?? 0) +
            (usage.cacheCreationInputTokens ?? 0);
          if (usage.contextWindow && usage.contextWindow > 0) {
            setContextWindow(modelName, usage.contextWindow);
          }
        }

        // Prefer per-API-call context from stream_event/message_start (accurate
        // for the latest API call) over the cumulative delta which over-counts
        // during multi-API-call turns (tool use: delta = sum of ALL sub-turn
        // input tokens, not the actual context window footprint).
        const turnContextTokens = this.lastStreamContextTokens > 0
          ? this.lastStreamContextTokens
          : cumulativeContextTokens - this.prevCumulativeContextTokens;

        this.prevCumulativeContextTokens = cumulativeContextTokens;
        this.lastStreamContextTokens = 0;

        if (turnContextTokens > 0) {
          const resultModel = String(msg.model || this.chatResolvedModel || this.model || "");
          events.push({
            type: "context_usage",
            usage: {
              contextTokens: turnContextTokens,
              contextWindow: getContextWindow(resultModel),
              model: resultModel,
            },
          });
        }

        // Result signals the end of an SDK turn. In multi-turn mode the SDK
        // emits `result` after each turn and then blocks on the next prompt.
        // Yield an `idle` event so that ChatManager marks the session as
        // ready for user input (awaitingUserInput = true).
        events.push({ type: "idle" });
        break;
      }
    }

    return events;
  }

  /**
   * Reset all chat state fields to null / empty.
   * Called in the finally block of startChat() to ensure cleanup.
   */
  private cleanupChat(): void {
    // Close queues if still open
    if (this.messageQueue && !this.messageQueue.isClosed) {
      this.messageQueue.close();
    }
    if (this.chatEventQueue && !this.chatEventQueue.isClosed) {
      this.chatEventQueue.close();
    }
    this.messageQueue = null;
    this.chatEventQueue = null;
    this.chatAbortController = null;
    this.pendingQuestions.clear();
    this.prevCumulativeContextTokens = 0;
    this.lastStreamContextTokens = 0;
    this.chatResolvedModel = null;
  }

  // ---------------------------------------------------------------------------
  // Private: context factory
  // ---------------------------------------------------------------------------

  private createContext(opts: SessionOptions): ClaudeContext {
    return {
      logger: new SessionLogger(opts.verbosity, opts.onLog),
      cwd: opts.cwd,
      resultText: "",
      durationMs: 0,
      costUsd: 0,
      numTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      model: "unknown",
      unitId: opts.unitId,
      maxTurns: opts.maxTurns,
      numApiCalls: 0,
      seenApiMessageIds: new Set<string>(),
      reportedTools: new Set(),
    };
  }

  // ---------------------------------------------------------------------------
  // Private: message dispatch
  // ---------------------------------------------------------------------------

  /** Route an SDK message to the appropriate handler by type. */
  private dispatchMessage(msg: Record<string, unknown>, ctx: ClaudeContext): void {
    switch (msg.type) {
      case "system":
        this.handleSystem(msg, ctx);
        break;
      case "assistant":
        this.handleAssistant(msg, ctx);
        break;
      case "tool_use_summary":
        this.handleToolUseSummary(msg, ctx);
        break;
      case "tool_progress":
        this.handleToolProgress(msg, ctx);
        break;
      case "rate_limit_event":
        this.handleRateLimit(msg, ctx);
        break;
      case "stream_event":
        this.handleStreamEvent(msg, ctx);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: individual message handlers
  // ---------------------------------------------------------------------------

  /** Handle system messages: init, status, task lifecycle. */
  private handleSystem(msg: Record<string, unknown>, ctx: ClaudeContext): void {
    if (msg.subtype === "init") {
      ctx.model = String(msg.model || "unknown");
      const tools = Array.isArray(msg.tools) ? msg.tools.length : "?";
      ctx.logger.log(`  [init] model=${ctx.model}, tools=${tools}, cwd=${ctx.cwd}`);
    } else if (msg.subtype === "status") {
      if (msg.status) {
        ctx.logger.log(`  [status] ${msg.status}`);
      }
    } else if (msg.subtype === "task_started") {
      const desc = msg.description || msg.task_id || "";
      ctx.logger.log(`  [task-started] ${desc}`);
    } else if (msg.subtype === "task_notification") {
      const status = msg.status || "";
      const summary = msg.summary || msg.task_id || "";
      ctx.logger.log(`  [task-done] ${status}: ${truncate(String(summary), 120)}`);
    }
  }

  /** Handle assistant message: extract text and tool_use content blocks. */
  private handleAssistant(msg: Record<string, unknown>, ctx: ClaudeContext): void {
    const message = (msg as unknown as {
      message: { id?: unknown; content: Array<Record<string, unknown>> };
    }).message;

    // Live turn count for UI indicator. SDK only exposes num_turns at end of
    // session via the `result` message — too late for the live indicator.
    // We maintain our own counter incremented per MAIN-thread API call.
    //
    // Two dedup rules keep our count aligned with SDK's num_turns:
    //   1. Sub-agent messages (Task tool workers) carry parent_tool_use_id !== null;
    //      SDK's maxTurns limit applies to the main thread only, so they must NOT
    //      be counted (would overshoot, e.g. 268/200).
    //   2. The SDK splits a single API response into one SDKAssistantMessage per
    //      content block (thinking / text / tool_use) when content.length > 1,
    //      and all splits inherit `message.id`. Counting each split would overshoot
    //      (e.g. 210/200 with real num_turns=152). Dedup on `message.id` so each
    //      API round-trip contributes exactly one increment.
    //
    // Fallback: if `message.id` is missing (only happens in tests with stripped
    // fixtures — `BetaMessage.id` is non-optional in the SDK), keep the old
    // behavior — count once per assistant message. Tests without explicit `id`
    // continue to work unchanged.
    //
    // Only fires from runSession; startChat uses sdkMessageToChatEvents instead.
    if (msg.parent_tool_use_id == null) {
      const apiMessageId = typeof message.id === "string" ? message.id : null;
      const alreadyCounted = apiMessageId !== null && ctx.seenApiMessageIds.has(apiMessageId);
      if (!alreadyCounted) {
        if (apiMessageId !== null) ctx.seenApiMessageIds.add(apiMessageId);
        ctx.numApiCalls++;
        ctx.logger.sendToLog({
          type: "agent:turn_count",
          numTurns: ctx.numApiCalls,
          maxTurns: ctx.maxTurns,
          model: ctx.model,
          unitId: ctx.unitId,
        });
      }
    }

    for (const block of message.content) {
      if (block.type === "text") {
        ctx.resultText += block.text as string;
        ctx.logger.logAssistant(String(block.text));
      }
      if (block.type === "tool_use") {
        const name = String(block.name || "unknown");
        const input = (block.input || {}) as Record<string, unknown>;
        ctx.logger.logTool(name, input);
      }
    }
  }

  /** Handle tool result summary line. */
  private handleToolUseSummary(msg: Record<string, unknown>, ctx: ClaudeContext): void {
    const summary = String(msg.summary || "").trim();
    if (summary) {
      ctx.logger.logToolResult(summary);
    }
  }

  /** Handle tool progress with 5s bucket throttle to avoid flooding. */
  private handleToolProgress(msg: Record<string, unknown>, ctx: ClaudeContext): void {
    const toolName = String(msg.tool_name || "unknown");
    const elapsed = Number(msg.elapsed_time_seconds || 0);
    const toolUseId = String(msg.tool_use_id || "");
    // Report each tool_use_id at most once per 5-second window
    const key = `${toolUseId}-${Math.floor(elapsed / 5)}`;
    if (!ctx.reportedTools.has(key)) {
      ctx.reportedTools.add(key);
      ctx.logger.log(`  [running] ${toolName} (${elapsed.toFixed(0)}s elapsed)`);
    }
  }

  /** Handle rate limit events. */
  private handleRateLimit(msg: Record<string, unknown>, ctx: ClaudeContext): void {
    const info = (msg.rate_limit_info || {}) as Record<string, unknown>;
    const status = info.status || msg.status || "";
    const resetsAt = info.resetsAt || msg.resetsAt || "";
    const limitType = info.rateLimitType || msg.rateLimitType || "";
    ctx.logger.log(
      `  [rate-limit] ${limitType}: ${status}${resetsAt ? `, resets at ${resetsAt}` : ""}`,
    );
  }

  /** Handle stream_event: extract per-turn usage from message_start for context tracking. */
  private handleStreamEvent(msg: Record<string, unknown>, ctx: ClaudeContext): void {
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event || event.type !== "message_start") return;

    const message = event.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, number> | undefined;
    if (!usage) return;

    const contextTokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);

    // Guard: skip if model not yet known (init hasn't arrived yet)
    if (ctx.model === "unknown") return;

    if (contextTokens > 0) {
      ctx.logger.sendToLog({
        type: "agent:context_usage",
        contextTokens,
        contextWindow: getContextWindow(ctx.model),
        model: ctx.model,
        unitId: ctx.unitId,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: result handling
  // ---------------------------------------------------------------------------

  /**
   * Process SDK result message: extract metrics from modelUsage.
   * Returns error IterationResult if subtype is not "success", null otherwise.
   */
  private handleResult(msg: Record<string, unknown>, ctx: ClaudeContext): IterationResult | null {
    ctx.durationMs = Number(msg.duration_ms || 0);
    ctx.costUsd = Number(msg.total_cost_usd || 0);
    ctx.numTurns = Number(msg.num_turns || 0);

    // Aggregate token counts across all models (primary + sub-agents like haiku)
    const modelUsageMap = (msg.modelUsage || {}) as Record<string, {
      inputTokens: number; outputTokens: number;
      cacheReadInputTokens: number; cacheCreationInputTokens: number;
      contextWindow?: number;
    }>;
    for (const [modelName, usage] of Object.entries(modelUsageMap)) {
      ctx.inputTokens += Number(usage.inputTokens || 0);
      ctx.outputTokens += Number(usage.outputTokens || 0);
      ctx.cacheReadTokens += Number(usage.cacheReadInputTokens || 0);
      ctx.cacheWriteTokens += Number(usage.cacheCreationInputTokens || 0);
      if (usage.contextWindow && usage.contextWindow > 0) {
        setContextWindow(modelName, usage.contextWindow);
      }
    }

    if (msg.subtype === "success") {
      if (msg.result) {
        ctx.resultText += "\n" + String(msg.result);
      }
      return null; // Caller breaks the event loop
    }

    // SDK hit its built-in maxTurns limit. Mirror the OpenCode/Codex fail-soft
    // contract: signal:none + "Max turns exceeded (N)" marker + preserved
    // metrics, so run.ts:371 treats it as a retry candidate instead of a hard
    // stop. The SDK subtype is "error_max_turns" in current SDK versions.
    if (msg.subtype === "error_max_turns") {
      const limit = ctx.maxTurns || ctx.numTurns;
      const marker = `Max turns exceeded (${limit})`;
      console.error(`  !!! ${marker} — retrying !!!`);
      if (msg.result) {
        ctx.resultText += "\n" + String(msg.result);
      }
      ctx.resultText = ctx.resultText
        ? `${marker}\n${ctx.resultText.trimStart()}`
        : marker;
      return this.buildIterationResult(ctx, { type: "none" }, null, null);
    }

    return this.buildIterationResult(ctx, {
      type: "error",
      message: `SDK result: ${msg.subtype}`,
    });
  }

  /** Assemble IterationResult from accumulated context and a signal. */
  private buildIterationResult(
    ctx: ClaudeContext,
    signal: AgentSignal,
    agentReport: string | null = null,
    reviewReport: string | null = null,
  ): IterationResult {
    return {
      signal,
      durationMs: ctx.durationMs,
      costUsd: ctx.costUsd,
      numTurns: ctx.numTurns,
      resultText: ctx.resultText,
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
      cacheReadTokens: ctx.cacheReadTokens,
      cacheWriteTokens: ctx.cacheWriteTokens,
      reasoningTokens: 0,
      model: ctx.model,
      agentReport,
      reviewReport,
      startedAt: "",
      finishedAt: "",
    };
  }
}
