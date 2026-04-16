import {
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { AssistantMessage, Part, TextPart } from "@opencode-ai/sdk/v2";
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentSignal, IterationResult, ModelEntry } from "../../types.js";
import type { AgentDriver, ChatEvent, ChatOptions, QuestionAnswers, SetupOptions, SessionOptions } from "./types.js";
import { parseSignal, parseReport, parseReviewReport } from "./types.js";
import { dim, truncate, SessionLogger, CYAN, RESET } from "./logging.js";
import { getContextWindow } from "./context-window.js";
import { AsyncQueue } from "./async-queue.js";
import { findFreePort } from "../net-utils.js";

// ---------------------------------------------------------------------------
// Model string parser
// ---------------------------------------------------------------------------

/**
 * Parse a "provider/model" string into { providerID, modelID }.
 * Splits on the first `/` only — everything after is the modelID.
 *
 * @example parseModelString("anthropic/claude-opus-4-6")
 *          // => { providerID: "anthropic", modelID: "claude-opus-4-6" }
 * @example parseModelString("google-vertex/deepseek-ai/deepseek-v3.1-maas")
 *          // => { providerID: "google-vertex", modelID: "deepseek-ai/deepseek-v3.1-maas" }
 */
export function parseModelString(model: string): {
  providerID: string;
  modelID: string;
} {
  const idx = model.indexOf("/");
  if (idx < 0) {
    throw new Error(
      `Invalid model string "${model}": expected "provider/model" (e.g. "anthropic/claude-opus-4-6")`,
    );
  }
  const providerID = model.slice(0, idx);
  const modelID = model.slice(idx + 1);
  if (!providerID) {
    throw new Error(
      `Invalid model string "${model}": provider part is empty (e.g. "anthropic/claude-opus-4-6")`,
    );
  }
  if (!modelID) {
    throw new Error(
      `Invalid model string "${model}": model part is empty (e.g. "anthropic/claude-opus-4-6")`,
    );
  }
  return { providerID, modelID };
}

// ---------------------------------------------------------------------------
// Server URL parser
// ---------------------------------------------------------------------------

/**
 * Parse the OpenCode server URL from a stdout line.
 *
 * Returns the URL string when the line matches the "opencode server listening on <url>"
 * pattern, `null` when the line is unrelated, or throws when the ready prefix is
 * present but the URL cannot be extracted (indicates a format change in OpenCode).
 */
export function parseServerUrl(line: string): string | null {
  if (!line.startsWith("opencode server listening")) return null;
  const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
  if (!match) {
    throw new Error(`Ready line found but URL not parsed: "${line}"`);
  }
  return match[1];
}

// ---------------------------------------------------------------------------
// Session context: mutable state accumulated during an OpenCode session
// ---------------------------------------------------------------------------

interface OpenCodeContext {
  logger: SessionLogger;
  cwd: string;
  // Metrics (filled from step-finish SSE events)
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
  // Text part tracking
  textPartAccumulator: Map<string, string>;
  loggedTextParts: Set<string>;
  displayedTextLength: Map<string, number>;
  // Tool tracking
  reportedTools: Set<string>;
  toolProgressBuckets: Map<string, number>;
  // Session ID (set after session creation)
  sessionId: string | null;
  /** Set by handleSessionError to propagate error result out of the event loop. */
  errorResult: IterationResult | null;
  /** Fallback text from session.messages() when SSE didn't capture text. */
  resultText: string;
  unitId: string;
  /** Context window resolved from providers API (0 = not resolved). */
  resolvedContextWindow: number;
  /** Max agentic turns; 0 means unlimited. */
  maxTurns: number;
  /** Set once we have sent session.abort — subsequent SSE events must be ignored. */
  aborted: boolean;
  /** True when abort reason was maxTurns breach — result built with signal: none + marker. */
  maxTurnsExceeded: boolean;
}

// ---------------------------------------------------------------------------
// OpenCodeDriver
// ---------------------------------------------------------------------------

/**
 * AgentDriver implementation backed by the OpenCode CLI server.
 *
 * Server lifecycle is PER ITERATION: `setup()` spawns an `opencode serve`
 * process directly (with `detached: true` for process-group kill), and
 * `teardown()` shuts it down via two-phase SIGTERM+SIGKILL to the entire
 * process group. Each `runSession()` creates a fresh OpenCode session, fires
 * an async prompt, then streams SSE events for real-time progress until the
 * session becomes idle.
 */
export class OpenCodeDriver implements AgentDriver {
  private parsedModel?: { providerID: string; modelID: string };
  private client: OpencodeClient | null = null;
  private serverProcess: ChildProcess | null = null;
  private serverPid: number | null = null;

  // Chat state fields
  private chatSessionId: string | null = null;
  private pendingQuestions: Map<string, { requestID: string }> = new Map();
  private chatAbortController: AbortController | null = null;
  private questionIdCounter = 0;
  private chatOptions: ChatOptions | null = null;
  private chatReportedTools: Set<string> = new Set();
  private chatDisplayedTextLength: Map<string, number> = new Map();
  private chatSetupPromise: Promise<{ stream: AsyncIterable<unknown> }> | null = null;
  /** Track user message IDs to filter out user text parts from SSE events. */
  private chatUserMessageIds: Set<string> = new Set();
  /** Actual model resolved by OpenCode (from first assistant message.updated). */
  private chatResolvedModel: string | null = null;
  private chatInternalQueue: AsyncQueue<ChatEvent> | null = null;

  constructor(model?: string) {
    if (model) {
      this.parsedModel = parseModelString(model);
    }
  }

  /** Generate a unique question ID for the chat session. */
  private generateChatQuestionId(): string {
    return `oq-${Date.now()}-${++this.questionIdCounter}`;
  }

  /**
   * Kill the server's entire process group.
   * Negative PID targets the process group (all children inherit PGID).
   * Swallows ESRCH (process already gone).
   */
  private killProcessGroup(signal: NodeJS.Signals = "SIGTERM"): void {
    if (!this.serverPid) return;
    try {
      process.kill(-this.serverPid, signal);
    } catch (err: unknown) {
      // ESRCH = no such process (already dead) — safe to ignore
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }

  async setup(opts: SetupOptions): Promise<void> {
    // Guard: prevent double setup without teardown (leaks server process)
    if (this.serverProcess) {
      throw new Error("OpenCodeDriver already initialized — call teardown() first");
    }

    // Guard: if already aborted, don't spawn
    if (opts.abortSignal?.aborted) {
      throw new Error("Aborted before setup");
    }

    const isQuiet = opts.verbosity === "quiet";
    const log = isQuiet
      ? (_msg: string) => {}
      : (msg: string) => console.log(dim(msg));

    const port = await findFreePort();

    // Re-check after async gap (abort could fire during findFreePort)
    if (opts.abortSignal?.aborted) {
      throw new Error("Aborted before setup");
    }

    log(`  [opencode] starting server on port ${port}...`);

    const args = ["serve", `--hostname=127.0.0.1`, `--port=${port}`];
    const proc = spawn("opencode", args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,  // creates new process group (PGID = PID) for kill(-pid)
      env: { ...process.env },
    });

    // Wait for server ready (parse URL from stdout)
    // IMPORTANT: stdout and stderr use SEPARATE buffers to prevent
    // interleaved stderr from corrupting stdout line parsing.
    const STARTUP_TIMEOUT = 15_000;
    let abortHandler: (() => void) | null = null;
    let serverUrl: string;
    try {
      serverUrl = await new Promise<string>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        // Attach error listener FIRST to prevent unhandled 'error' event
        // (e.g., ENOENT when opencode binary is missing)
        proc.on("error", (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        });

        // Verify we got a PID (spawn can fail silently)
        if (!proc.pid) {
          reject(new Error("Failed to spawn opencode: no PID assigned"));
          return;
        }

        this.serverProcess = proc;
        this.serverPid = proc.pid;

        timer = setTimeout(() => {
          reject(
            new Error(
              `Timeout waiting for opencode server to start after ${STARTUP_TIMEOUT}ms`,
            ),
          );
        }, STARTUP_TIMEOUT);

        // Wire abort signal into promise rejection (access to reject/timer)
        if (opts.abortSignal) {
          abortHandler = () => {
            clearTimeout(timer!);
            this.killProcessGroup();
            reject(new Error("Aborted during startup"));
          };
          opts.abortSignal.addEventListener("abort", abortHandler, { once: true });
        }

        let stdoutBuf = "";
        let stderrBuf = "";
        let settled = false;

        proc.stdout!.on("data", (chunk: Buffer) => {
          if (settled) return;
          stdoutBuf += chunk.toString();
          const lines = stdoutBuf.split("\n");
          stdoutBuf = lines.pop()!; // retain incomplete trailing line
          for (const line of lines) {
            try {
              const url = parseServerUrl(line);
              if (url) {
                settled = true;
                clearTimeout(timer!);
                resolve(url);
                return;
              }
            } catch (err) {
              settled = true;
              clearTimeout(timer!);
              reject(err as Error);
              return;
            }
          }
        });

        proc.stderr!.on("data", (chunk: Buffer) => {
          stderrBuf += chunk.toString();
        });

        proc.on("exit", (code) => {
          if (timer) clearTimeout(timer);
          let msg = `opencode server exited with code ${code}`;
          const combined = (stdoutBuf + stderrBuf).trim();
          if (combined) msg += `\nOutput: ${combined}`;
          reject(new Error(msg));
        });
      });
    } catch (err) {
      // Cleanup abort handler to prevent listener leak
      if (abortHandler && opts.abortSignal) {
        opts.abortSignal.removeEventListener("abort", abortHandler);
      }
      // Two-phase kill (same as teardown) to prevent orphaned processes
      if (this.serverProcess) {
        this.killProcessGroup("SIGTERM");
        await new Promise<void>((resolve) => {
          if (this.serverProcess!.exitCode !== null || this.serverProcess!.signalCode !== null) {
            resolve();
            return;
          }
          const t = setTimeout(() => resolve(), 5_000);
          this.serverProcess!.once("exit", () => {
            clearTimeout(t);
            resolve();
          });
        });
        this.killProcessGroup("SIGKILL");
      }
      this.serverProcess = null;
      this.serverPid = null;
      throw err;
    }

    // Cleanup abort handler on success
    if (abortHandler && opts.abortSignal) {
      opts.abortSignal.removeEventListener("abort", abortHandler);
    }

    log(`  [opencode] server ready at ${serverUrl}`);

    this.client = createOpencodeClient({ baseUrl: serverUrl });
  }

  async teardown(): Promise<void> {
    if (!this.serverProcess || !this.serverPid) {
      this.serverProcess = null;
      this.serverPid = null;
      this.client = null;
      return;
    }

    // Stage 1: graceful shutdown — SIGTERM to entire process group
    this.killProcessGroup("SIGTERM");

    // Wait up to 5 seconds for the server process to exit
    await new Promise<void>((resolve) => {
      if (this.serverProcess!.exitCode !== null || this.serverProcess!.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => resolve(), 5_000);
      this.serverProcess!.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // Stage 2: ALWAYS force kill the process group.
    // Parent opencode may have exited, but its children (dev servers,
    // Playwright, etc.) can survive SIGTERM. ESRCH is caught by
    // killProcessGroup if the group is already dead.
    this.killProcessGroup("SIGKILL");

    this.serverProcess = null;
    this.serverPid = null;
    this.client = null;
  }

  async runSession(opts: SessionOptions): Promise<IterationResult> {
    if (!this.client) {
      throw new Error(
        "OpenCodeDriver: client not initialized — call setup() first",
      );
    }

    const ctx = this.createContext(opts);

    // Wire AbortController to abort the OpenCode session
    const abortHandler = opts.abortController
      ? () => {
          if (ctx.sessionId && this.client) {
            this.client.session
              .abort({ sessionID: ctx.sessionId })
              .catch(() => {});
          }
        }
      : null;

    if (abortHandler && opts.abortController) {
      opts.abortController.signal.addEventListener("abort", abortHandler, {
        once: true,
      });
    }

    try {
      // 1. Subscribe to SSE BEFORE firing prompt (don't miss events)
      const sseResult = await this.client.event.subscribe({
        directory: opts.cwd,
      });

      // 2. Create session
      const createResult = await this.client.session.create({
        directory: opts.cwd,
      });
      if (createResult.error) {
        return errorResult(
          `Failed to create session: ${JSON.stringify(createResult.error)}`,
        );
      }
      if (!createResult.data?.id) {
        return errorResult("Session creation returned no ID");
      }
      ctx.sessionId = createResult.data.id;
      ctx.logger.log(`  [opencode] session created: ${ctx.sessionId}`);

      if (opts.abortController?.signal.aborted) {
        return errorResult("Aborted during session creation");
      }

      // 2b. Resolve context window from providers API
      this.resolveContextWindow(ctx);

      // 3. Fire async prompt (returns immediately with HTTP 204)
      const promptResult = await this.client.session.promptAsync({
        sessionID: ctx.sessionId,
        directory: opts.cwd,
        system: opts.systemPrompt,
        parts: [{ type: "text", text: opts.prompt }],
        ...(this.parsedModel && { model: this.parsedModel }),
        ...(opts.variant && { variant: opts.variant }),
      });
      if (promptResult.error) {
        return errorResult(
          `Failed to send task prompt: ${JSON.stringify(promptResult.error)}`,
        );
      }

      // 4. Consume SSE stream until session.idle or error
      for await (const event of sseResult.stream) {
        if (opts.abortController?.signal.aborted) break;

        const shouldBreak = this.processEvent(event, ctx);
        if (ctx.errorResult) return ctx.errorResult;
        if (shouldBreak) break;
      }

      // Terminate verbose streaming with newline
      if (ctx.logger.isVerbose && ctx.textPartAccumulator.size > 0) {
        process.stdout.write("\n");
      }

      // 5. Fetch final metrics from session.messages()
      await this.fetchFinalMetrics(ctx);

      // 5b. maxTurns breach: signal:none + marker + preserved metrics.
      // We deliberately skip parseSignal here — the agent didn't get to emit
      // <task-complete>/<task-blocked>, and run.ts treats signal:none as a
      // retry candidate. errorResult() would zero our hard-earned tokens/cost
      // so we use buildIterationResult() directly.
      if (ctx.maxTurnsExceeded) {
        const marker = `Max turns exceeded (${ctx.maxTurns})`;
        console.error(`  !!! ${marker} — retrying !!!`);
        const sseText = Array.from(ctx.textPartAccumulator.values()).join("\n");
        const originalText = sseText || ctx.resultText;
        const merged = originalText ? `${marker}\n${originalText}` : marker;
        return this.buildIterationResult(
          { ...ctx, resultText: merged },
          { type: "none" },
          null,
          null,
        );
      }

      // 6. Build result — merge SSE text with fallback from session.messages()
      const sseText = Array.from(ctx.textPartAccumulator.values()).join("\n");
      const finalText = sseText || ctx.resultText;
      const signal = parseSignal(finalText);
      // Review decision: parse report from both sources — SSE may be incomplete
      const agentReport = parseReport(finalText) ?? parseReport(ctx.resultText);
      const reviewReport = parseReviewReport(finalText) ?? parseReviewReport(ctx.resultText);
      return this.buildIterationResult(
        { ...ctx, resultText: finalText },
        signal,
        agentReport,
        reviewReport,
      );
    } catch (err) {
      console.error("OpenCode session error:", err);
      const errorMessage =
        err instanceof Error
          ? `${err.message}\n${err.stack ?? ""}`
          : String(err);
      return this.buildIterationResult(ctx, {
        type: "error",
        message: errorMessage,
      });
    } finally {
      if (abortHandler && opts.abortController) {
        opts.abortController.signal.removeEventListener("abort", abortHandler);
      }
      if (ctx.sessionId && this.client) {
        try {
          await this.client.session.delete({ sessionID: ctx.sessionId });
        } catch (deleteErr) {
          if (ctx.logger.isVerbose) {
            console.error(
              dim(
                `  [opencode] failed to delete session ${ctx.sessionId}: ${deleteErr}`,
              ),
            );
          }
        }
      }
    }
  }

  async listModels(): Promise<ModelEntry[]> {
    if (!this.client) {
      throw new Error("OpenCodeDriver: client not initialized — call setup() first");
    }
    const result = await this.client.config.providers();
    if (result.error || !result.data) {
      throw new Error(`Failed to list providers: ${JSON.stringify(result.error)}`);
    }
    const entries: ModelEntry[] = [];
    for (const provider of result.data.providers) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        const variantNames = model.variants ? Object.keys(model.variants) : [];
        const compositeId = `${provider.id}/${modelId}`;
        entries.push({
          id: compositeId,
          name: compositeId,
          ...(variantNames.length > 0 ? { variants: variantNames } : {}),
        });
      }
    }
    return entries;
  }

  // ---------------------------------------------------------------------------
  // Interactive chat methods
  // ---------------------------------------------------------------------------

  /**
   * Create an interactive chat session.
   *
   * Eagerly initializes chat state (AbortController, options) AND starts
   * session setup (SSE subscribe + session create) so the caller can call
   * sendMessage() right after startChat() without waiting for the generator
   * to be consumed. Returns an async generator that awaits the setup and
   * then loops over SSE events.
   *
   * Does NOT send a prompt automatically — the first user message must go
   * through sendMessage().
   */
  startChat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    if (!this.client) {
      throw new Error("OpenCodeDriver: client not initialized — call setup() first");
    }
    if (this.chatAbortController !== null) {
      throw new Error("Chat session already active. Call abortChat() first.");
    }

    // Eagerly initialize state (synchronous, before async generator starts)
    this.chatAbortController = new AbortController();
    this.pendingQuestions.clear();
    this.chatOptions = opts;
    this.chatReportedTools.clear();
    this.chatDisplayedTextLength.clear();
    this.chatUserMessageIds.clear();
    this.chatResolvedModel = null;
    this.questionIdCounter = 0;
    this.chatInternalQueue = new AsyncQueue<ChatEvent>();

    // Eagerly start session setup (SSE subscribe + session create).
    // This sets chatSessionId as soon as the promise resolves, allowing
    // sendMessage() to work even before the generator is consumed.
    this.chatSetupPromise = this.setupChatSession(opts);

    // Return async generator that awaits the setup promise
    return this.createChatEventStream();
  }

  /**
   * Send a follow-up message to the active chat session.
   *
   * Fire-and-forget: `promptAsync` returns immediately with HTTP 204,
   * the result will arrive through the SSE event stream.
   *
   * If the session setup is still in progress (chatSessionId not yet set),
   * waits for the setup promise to resolve before sending.
   */
  sendMessage(text: string): void {
    if (!this.client) {
      throw new Error("No active chat session. Call startChat() first.");
    }
    if (!this.chatSessionId && !this.chatSetupPromise) {
      throw new Error("No active chat session. Call startChat() first.");
    }

    const doSend = async () => {
      // Wait for session setup if not yet complete
      if (!this.chatSessionId && this.chatSetupPromise) {
        await this.chatSetupPromise;
      }
      if (!this.chatSessionId) {
        throw new Error("Chat session setup failed.");
      }

      await this.client!.session.promptAsync({
        sessionID: this.chatSessionId,
        directory: this.chatOptions?.cwd,
        system: this.chatOptions?.systemPrompt,
        parts: [{ type: "text", text }],
        ...(this.parsedModel && { model: this.parsedModel }),
        ...(this.chatOptions?.variant && { variant: this.chatOptions.variant }),
      });
    };

    doSend().catch((err: unknown) => {
      if (this.chatInternalQueue && !this.chatInternalQueue.isClosed) {
        this.chatInternalQueue.push({
          type: "error",
          message: `sendMessage failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  /**
   * Reply to a pending question from the agent.
   *
   * Looks up the OpenCode requestID from our internal `pendingQuestions` map
   * and calls `client.question.reply()`. Supports both single-select (string)
   * and multi-select (string[]) answer values.
   */
  replyQuestion(questionId: string, answers: QuestionAnswers): void {
    if (!this.client) {
      throw new Error("No active chat session.");
    }

    const pending = this.pendingQuestions.get(questionId);
    if (!pending) {
      throw new Error(
        `No pending question with id '${questionId}'. ` +
          `Available: ${Array.from(this.pendingQuestions.keys()).join(", ") || "none"}`,
      );
    }

    // Map answer values: each answer becomes a QuestionAnswer (Array<string>).
    // Single-select "React" → ["React"], multi-select ["Auth","DB"] stays as-is.
    const answerValues = Object.values(answers).map((value) =>
      Array.isArray(value) ? value : [value],
    );

    this.client.question
      .reply({
        requestID: pending.requestID,
        answers: answerValues,
      })
      .then(() => {
        this.pendingQuestions.delete(questionId);
      })
      .catch((err: unknown) => {
        if (this.chatInternalQueue && !this.chatInternalQueue.isClosed) {
          this.chatInternalQueue.push({
            type: "error",
            message: `replyQuestion failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      });
  }

  /**
   * Abort the active chat session.
   *
   * 1. Reject all pending questions (prevents agent from hanging)
   * 2. Abort the OpenCode session
   * 3. Signal the SSE event loop to stop via chatAbortController
   * 4. Reset local state (chatSessionId, chatAbortController)
   *
   * Idempotent: safe to call multiple times. The `cleanupChat()` in the
   * finally block of `createChatEventStream` will handle remaining cleanup.
   */
  abortChat(): void {
    // 1. Reject all pending questions
    if (this.client) {
      for (const [, pending] of this.pendingQuestions) {
        this.client.question
          .reject({
            requestID: pending.requestID,
          })
          .catch(() => {});
      }
    }
    this.pendingQuestions.clear();

    // 2. Abort the session
    if (this.client && this.chatSessionId) {
      this.client.session
        .abort({
          sessionID: this.chatSessionId,
        })
        .catch(() => {});
    }

    // 3. Signal abort to event loop
    this.chatAbortController?.abort();

    // 4. Reset state — chatSetupPromise is NOT nullified here because the
    //    async generator in createChatEventStream() reads it from `this`.
    //    Nullifying it would cause a TypeError. cleanupChat() in the
    //    generator's finally block handles full cleanup.
    this.chatSessionId = null;
    this.chatAbortController = null;
  }

  // ---------------------------------------------------------------------------
  // Private: interactive chat internals
  // ---------------------------------------------------------------------------

  /**
   * Eagerly start the chat session setup: subscribe to SSE, then create session.
   *
   * SSE subscription happens BEFORE session creation to not miss early events.
   * Sets `chatSessionId` when the session is created, allowing `sendMessage()`
   * to work even before the generator is consumed.
   */
  private async setupChatSession(opts: ChatOptions): Promise<{ stream: AsyncIterable<unknown> }> {
    // 1. Subscribe to SSE BEFORE creating session (don't miss events)
    const sseResult = await this.client!.event.subscribe({
      directory: opts.cwd,
    });

    // 2. Create session
    const createResult = await this.client!.session.create({
      directory: opts.cwd,
    });
    if (createResult.error || !createResult.data?.id) {
      throw new Error(
        `Failed to create chat session: ${JSON.stringify(createResult.error)}`,
      );
    }
    this.chatSessionId = createResult.data.id;

    // If abort was signaled while session.create() was in flight, the
    // newly created session would leak on the OpenCode server (abortChat()
    // skipped session.abort() because chatSessionId was still null).
    // Clean it up now.
    if (this.chatAbortController?.signal.aborted) {
      this.client!.session
        .abort({ sessionID: this.chatSessionId })
        .catch(() => {});
    }

    return { stream: sseResult.stream };
  }

  /**
   * Async generator that drives the SSE event loop for interactive chat.
   *
   * Awaits the eagerly-started setup promise, then merges SSE events with
   * the internal event queue (used to surface async errors from sendMessage/
   * replyQuestion) into a single ChatEvent stream. Cleans up in finally block.
   */
  private async *createChatEventStream(): AsyncGenerator<ChatEvent> {
    try {
      // Await the eagerly-started setup (SSE subscribe + session create)
      const { stream } = await this.chatSetupPromise!;

      yield* this.mergeSseAndInternalStreams(stream, this.chatInternalQueue!);
    } finally {
      this.cleanupChat();
    }
  }

  /**
   * Merge the SSE event stream with the internal event queue into a unified
   * ChatEvent stream. Internal queue carries async errors from sendMessage/
   * replyQuestion that would otherwise be silently swallowed.
   *
   * Uses Promise.race to interleave events from both sources. When the SSE
   * stream ends, the internal queue is closed too.
   */
  private async *mergeSseAndInternalStreams(
    sseStream: AsyncIterable<unknown>,
    internalQueue: AsyncQueue<ChatEvent>,
  ): AsyncGenerator<ChatEvent> {
    type Tagged =
      | { source: "sse"; result: IteratorResult<unknown> }
      | { source: "internal"; result: IteratorResult<ChatEvent> };

    const sseIter = sseStream[Symbol.asyncIterator]();
    const queueIter = internalQueue[Symbol.asyncIterator]();

    const safeSseNext = (): Promise<Tagged> =>
      sseIter.next().then(
        (r) => ({ source: "sse" as const, result: r }),
        () => ({ source: "sse" as const, result: { value: undefined, done: true as const } }),
      );

    const safeQueueNext = (): Promise<Tagged> =>
      queueIter.next().then(
        (r) => ({ source: "internal" as const, result: r }),
      );

    let sseNext: Promise<Tagged> | null = safeSseNext();
    let queueNext: Promise<Tagged> | null = safeQueueNext();

    while (sseNext || queueNext) {
      if (this.chatAbortController?.signal.aborted) break;

      const candidates = [sseNext, queueNext].filter(Boolean) as Promise<Tagged>[];
      if (candidates.length === 0) break;

      const resolved = await Promise.race(candidates);

      // Re-check abort after unblocking — abort may have been signaled while awaiting
      if (this.chatAbortController?.signal.aborted) break;

      if (resolved.source === "sse") {
        if (resolved.result.done) {
          sseNext = null;
          if (!internalQueue.isClosed) internalQueue.close();
        } else {
          const chatEvents = this.processChatEvent(resolved.result.value);
          for (const chatEvent of chatEvents) {
            yield chatEvent;
            if (chatEvent.type === "finished") return;
          }
          sseNext = safeSseNext();
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
  }

  /**
   * Translate a single SSE event into zero or more ChatEvent objects.
   * Only processes events for the current chat session.
   */
  private processChatEvent(event: unknown): ChatEvent[] {
    const ev = event as { type: string; properties: Record<string, unknown> };
    const events: ChatEvent[] = [];

    switch (ev.type) {
      case "message.updated": {
        // Track user message IDs so we can filter out their parts;
        // capture resolved model from first assistant message.
        const props = ev.properties as {
          info: { id: string; sessionID: string; role: string; providerID?: string; modelID?: string };
        };
        if (props.info.sessionID === this.chatSessionId) {
          if (props.info.role === "user") {
            this.chatUserMessageIds.add(props.info.id);
          } else if (props.info.role === "assistant" && !this.chatResolvedModel) {
            const p = props.info.providerID;
            const m = props.info.modelID;
            if (p && m) {
              this.chatResolvedModel = `${p}/${m}`;
            }
          }
        }
        break;
      }

      case "question.asked": {
        const props = ev.properties as {
          id: string;
          sessionID: string;
          questions: Array<{
            question: string;
            header: string;
            options: Array<{ label: string; description: string }>;
            multiple?: boolean;
          }>;
        };
        if (props.sessionID !== this.chatSessionId) break;

        const questionId = this.generateChatQuestionId();
        this.pendingQuestions.set(questionId, { requestID: props.id });

        events.push({
          type: "question",
          questionId,
          questions: props.questions.map((q) => ({
            question: q.question,
            header: q.header,
            options: q.options.map((o) => ({
              label: o.label,
              description: o.description,
            })),
            multiSelect: q.multiple ?? false,
          })),
          source: "opencode",
        });
        break;
      }

      case "session.idle": {
        const props = ev.properties as { sessionID: string };
        if (props.sessionID === this.chatSessionId) {
          events.push({ type: "idle" });
        }
        break;
      }

      case "session.error": {
        const props = ev.properties as {
          sessionID?: string;
          error?: unknown;
        };
        if (!props.sessionID || props.sessionID === this.chatSessionId) {
          const errMsg = props.error
            ? JSON.stringify(props.error)
            : "unknown session error";
          events.push({ type: "error", message: `Session error: ${errMsg}` });
        }
        break;
      }

      case "message.part.updated": {
        const props = ev.properties as {
          part: {
            type: string;
            sessionID: string;
            messageID: string;
            id: string;
            text?: string;
            tool?: string;
            state?: {
              status: string;
              input?: Record<string, unknown>;
              output?: string;
              error?: string;
            };
            tokens?: {
              input: number;
              output: number;
              reasoning: number;
              cache: { read: number; write: number };
            };
            cost?: number;
          };
        };
        if (props.part.sessionID !== this.chatSessionId) break;
        // Skip parts belonging to user messages (echoed input)
        if (this.chatUserMessageIds.has(props.part.messageID)) break;

        switch (props.part.type) {
          case "text": {
            // Only emit text not yet displayed via message.part.delta events.
            // Deltas stream incrementally; part.updated carries the full accumulated
            // text. Without this diff, the same text would appear twice.
            const fullText = props.part.text ?? "";
            const prevLen = this.chatDisplayedTextLength.get(props.part.id) ?? 0;
            if (fullText.length > prevLen) {
              const newText = fullText.slice(prevLen);
              this.chatDisplayedTextLength.set(props.part.id, fullText.length);
              events.push({ type: "text", content: newText });
            }
            break;
          }

          case "tool": {
            const state = props.part.state;
            if (!state) break;
            const toolName = props.part.tool ?? "unknown";

            // Yield tool dispatch event once per tool part
            if (
              (state.status === "running" || state.status === "completed") &&
              state.input &&
              Object.keys(state.input).length > 0 &&
              !this.chatReportedTools.has(props.part.id)
            ) {
              this.chatReportedTools.add(props.part.id);
              events.push({
                type: "tool",
                name: toolName,
                input: state.input,
              });
            }

            // Yield tool_result when completed with output
            if (state.status === "completed" && state.output) {
              events.push({
                type: "tool_result",
                name: toolName,
                output: state.output,
              });
            }

            // Yield tool_result for errors
            if (state.status === "error" && state.error) {
              events.push({
                type: "tool_result",
                name: toolName,
                output: `ERROR: ${state.error}`,
              });
            }
            break;
          }

          case "step-finish": {
            const sfp = props.part as unknown as {
              tokens?: {
                input: number;
                output: number;
                reasoning: number;
                cache: { read: number; write: number };
              };
              cost?: number;
            };
            if (sfp.tokens) {
              const contextTokens = sfp.tokens.input + sfp.tokens.cache.read + sfp.tokens.cache.write;
              if (contextTokens > 0) {
                const resolvedModel = this.chatResolvedModel
                  ?? (this.parsedModel ? `${this.parsedModel.providerID}/${this.parsedModel.modelID}` : "");
                // Extract modelID for context window lookup (after last /)
                const modelIdForLookup = resolvedModel.includes("/")
                  ? resolvedModel.slice(resolvedModel.indexOf("/") + 1)
                  : resolvedModel;
                events.push({
                  type: "context_usage",
                  usage: {
                    contextTokens,
                    contextWindow: getContextWindow(modelIdForLookup),
                    model: resolvedModel,
                  },
                });
              }
            }
            break;
          }
        }
        break;
      }

      case "message.part.delta": {
        const props = ev.properties as {
          sessionID: string;
          messageID: string;
          partID: string;
          field: string;
          delta: string;
        };
        if (props.sessionID !== this.chatSessionId) break;
        // Skip deltas belonging to user messages (echoed input)
        if (this.chatUserMessageIds.has(props.messageID)) break;
        if (props.field === "text" && props.delta) {
          // Track how much text has been displayed via deltas — used by
          // message.part.updated to avoid duplicating already-streamed text.
          const prevLen = this.chatDisplayedTextLength.get(props.partID) ?? 0;
          this.chatDisplayedTextLength.set(props.partID, prevLen + props.delta.length);
          events.push({ type: "text", content: props.delta });
        }
        break;
      }

      default:
        break;
    }

    return events;
  }

  /** Reset all chat state fields. Called from the finally block of createChatEventStream. */
  private cleanupChat(): void {
    this.chatSessionId = null;
    this.pendingQuestions.clear();
    this.chatAbortController = null;
    this.chatOptions = null;
    this.chatReportedTools.clear();
    this.chatDisplayedTextLength.clear();
    this.chatUserMessageIds.clear();
    this.chatResolvedModel = null;
    this.chatSetupPromise = null;
    if (this.chatInternalQueue && !this.chatInternalQueue.isClosed) {
      this.chatInternalQueue.close();
    }
    this.chatInternalQueue = null;
  }

  // ---------------------------------------------------------------------------
  // Private: context factory
  // ---------------------------------------------------------------------------

  private createContext(opts: SessionOptions): OpenCodeContext {
    return {
      logger: new SessionLogger(opts.verbosity, opts.onLog),
      cwd: opts.cwd,
      numTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      durationMs: 0,
      model: this.parsedModel ? `${this.parsedModel.providerID}/${this.parsedModel.modelID}` : "unknown",
      textPartAccumulator: new Map(),
      loggedTextParts: new Set(),
      displayedTextLength: new Map(),
      reportedTools: new Set(),
      toolProgressBuckets: new Map(),
      sessionId: null,
      errorResult: null,
      resultText: "",
      unitId: opts.unitId,
      resolvedContextWindow: 0,
      maxTurns: opts.maxTurns,
      aborted: false,
      maxTurnsExceeded: false,
    };
  }

  /**
   * Resolve context window from providers API.
   * Finds the model matching ctx.model (or parsedModel) and sets ctx.resolvedContextWindow.
   * Fire-and-forget: on failure, falls back to getContextWindow() at emit time.
   */
  private resolveContextWindow(ctx: OpenCodeContext): void {
    if (!this.client) return;
    this.client.config.providers().then((res) => {
      if (res.error || !res.data) return;
      for (const provider of res.data.providers) {
        for (const [modelId, model] of Object.entries(provider.models)) {
          const compositeId = `${provider.id}/${modelId}`;
          // Match by explicit --model flag or by default model
          if (
            (this.parsedModel && compositeId === `${this.parsedModel.providerID}/${this.parsedModel.modelID}`) ||
            (!this.parsedModel && res.data.default[provider.id] === modelId)
          ) {
            if (model.limit?.context > 0) {
              ctx.resolvedContextWindow = model.limit.context;
              if (ctx.model === "unknown") {
                ctx.model = compositeId;
              }
            }
            return;
          }
        }
      }
    }).catch((err) => {
      ctx.logger.logVerbose(`  [opencode] providers() failed: ${err}`);
    });
  }

  // ---------------------------------------------------------------------------
  // Private: SSE event dispatch
  // ---------------------------------------------------------------------------

  /**
   * Process a single SSE event. Returns true if the event loop should break.
   * Sets ctx.errorResult if an error should be returned to the caller.
   */
  private processEvent(event: unknown, ctx: OpenCodeContext): boolean {
    const ev = event as { type: string; properties: Record<string, unknown> };

    switch (ev.type) {
      case "session.idle":
        return this.handleSessionIdle(ev.properties, ctx);

      case "session.error":
        this.handleSessionError(ev.properties, ctx);
        return ctx.errorResult !== null;

      case "session.status":
        this.handleSessionStatus(ev.properties, ctx);
        return false;

      case "message.part.updated":
        this.handlePartUpdated(ev.properties, ctx);
        return false;

      case "message.part.delta":
        this.handlePartDelta(ev.properties, ctx);
        return false;

      default:
        return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: session-level event handlers
  // ---------------------------------------------------------------------------

  /** Check if session.idle is for our session. Returns true to break. */
  private handleSessionIdle(
    props: Record<string, unknown>,
    ctx: OpenCodeContext,
  ): boolean {
    return (props as { sessionID: string }).sessionID === ctx.sessionId;
  }

  /** Handle session.error — sets ctx.errorResult if it's our session. */
  private handleSessionError(
    props: Record<string, unknown>,
    ctx: OpenCodeContext,
  ): void {
    const p = props as { sessionID?: string; error?: unknown };
    if (!p.sessionID) {
      ctx.logger.logVerbose(
        `  [opencode] session.error without sessionID, assuming ours`,
      );
    }
    if (!p.sessionID || p.sessionID === ctx.sessionId) {
      const errMsg = p.error
        ? JSON.stringify(p.error)
        : "unknown session error";
      ctx.errorResult = errorResult(`Session error: ${errMsg}`);
    }
  }

  /** Handle session.status (retry info). */
  private handleSessionStatus(
    props: Record<string, unknown>,
    ctx: OpenCodeContext,
  ): void {
    const p = props as {
      sessionID: string;
      status: { type: string; attempt?: number; message?: string; next?: number };
    };
    if (p.sessionID === ctx.sessionId && p.status.type === "retry") {
      ctx.logger.log(
        `  [opencode] retrying (attempt ${p.status.attempt}, next in ${p.status.next}s): ${p.status.message}`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Private: message.part.updated handlers
  // ---------------------------------------------------------------------------

  /** Dispatch message.part.updated to the appropriate part-type handler. */
  private handlePartUpdated(
    props: Record<string, unknown>,
    ctx: OpenCodeContext,
  ): void {
    const p = props as {
      part: Part;
    };
    const part = p.part;

    // Filter to our session only
    if (part.sessionID !== ctx.sessionId) return;

    switch (part.type) {
      case "text":
        this.handleTextPart(part, ctx);
        break;
      case "tool":
        this.handleToolPart(part, ctx);
        break;
      case "step-finish":
        this.handleStepFinish(part, ctx);
        break;
    }
  }

  /**
   * Handle message.part.delta — v2 sends text deltas as separate events.
   * Applies the delta to the text part accumulator for streaming display.
   */
  private handlePartDelta(
    props: Record<string, unknown>,
    ctx: OpenCodeContext,
  ): void {
    const p = props as {
      sessionID: string;
      messageID: string;
      partID: string;
      field: string;
      delta: string;
    };

    // Filter to our session only
    if (p.sessionID !== ctx.sessionId) return;

    // Only handle text field deltas
    if (p.field !== "text") return;

    if (ctx.logger.isQuiet || !p.delta) return;

    if (ctx.logger.isVerbose) {
      // Verbose: stream delta text incrementally via stdout (cyan)
      process.stdout.write(CYAN + p.delta + RESET);
      // partID here matches Part.id in handleTextPart — shared displayedTextLength map prevents duplicates
      const prevLen = ctx.displayedTextLength.get(p.partID) ?? 0;
      ctx.displayedTextLength.set(p.partID, prevLen + p.delta.length);
    }
  }

  /** Accumulate text and display (streaming in debug/trace, first-line in info). */
  private handleTextPart(
    part: TextPart,
    ctx: OpenCodeContext,
  ): void {
    if (ctx.aborted) return;
    ctx.textPartAccumulator.set(part.id, part.text);

    if (ctx.logger.isQuiet || !part.text.trim()) return;

    if (ctx.logger.isVerbose) {
      // In v2, deltas arrive via separate message.part.delta events handled by
      // handlePartDelta(). Here we use a full-text diff fallback for models or
      // events that don't emit deltas — display any text not yet shown.
      const prevLen = ctx.displayedTextLength.get(part.id) ?? 0;
      if (part.text.length > prevLen) {
        process.stdout.write(
          CYAN + part.text.slice(prevLen) + RESET,
        );
        ctx.displayedTextLength.set(part.id, part.text.length);
      }
      // Send to onLog only (console output already handled by streaming above).
      // Truncation mirrors logAssistant: trace → full, debug → 2000ch.
      if (!ctx.loggedTextParts.has(part.id)) {
        ctx.loggedTextParts.add(part.id);
        ctx.logger.sendToLog({ type: "agent:text", text: ctx.logger.isTrace ? part.text : truncate(part.text, 2000) });
      }
    } else if (!ctx.loggedTextParts.has(part.id)) {
      // Info: show first line once per text part (logAssistant handles truncation)
      ctx.loggedTextParts.add(part.id);
      ctx.logger.logAssistant(part.text);
    }
  }

  /** Log tool dispatch and elapsed time for long-running tools. */
  private handleToolPart(
    part: Part,
    ctx: OpenCodeContext,
  ): void {
    if (ctx.aborted) return;
    const toolPart = part as unknown as {
      id: string;
      tool: string;
      state: {
        status: string;
        input?: Record<string, unknown>;
        output?: string;
        error?: string;
        time?: { start: number; end?: number };
      };
    };
    const toolName = toolPart.tool;
    const state = toolPart.state;

    // Log tool dispatch once — skip "pending" (input is always empty),
    // wait for "running" or "completed" when input is populated.
    const hasInput = state.input && Object.keys(state.input).length > 0;
    if (
      (state.status === "running" || state.status === "completed") &&
      hasInput &&
      !ctx.reportedTools.has(toolPart.id)
    ) {
      ctx.reportedTools.add(toolPart.id);
      ctx.logger.logTool(toolName, state.input!);
    }

    // Log elapsed time for long-running tools (5s bucket threshold)
    if (state.status === "running" && state.time) {
      const elapsed = (Date.now() - state.time.start) / 1000;
      const bucket = Math.floor(elapsed / 5);
      if (
        (ctx.toolProgressBuckets.get(toolPart.id) ?? -1) < bucket &&
        elapsed >= 5
      ) {
        ctx.toolProgressBuckets.set(toolPart.id, bucket);
        ctx.logger.log(
          `  [running] ${toolName} (${elapsed.toFixed(0)}s elapsed)`,
        );
      }
    }

    // Tool completed/error — send result to UI and verbose console
    if (state.status === "completed" && state.output) {
      ctx.logger.logToolResult(state.output);
    }
    if (state.status === "error" && state.error) {
      ctx.logger.logToolResult(`ERROR: ${state.error}`);
    }
  }

  /** Aggregate per-step token metrics and cost. */
  private handleStepFinish(
    part: Part,
    ctx: OpenCodeContext,
  ): void {
    if (ctx.aborted) return;
    const sfp = part as unknown as {
      reason: string;
      cost: number;
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
      };
    };

    ctx.numTurns++;
    ctx.inputTokens += sfp.tokens.input;
    ctx.outputTokens += sfp.tokens.output;
    ctx.reasoningTokens += sfp.tokens.reasoning;
    ctx.cacheReadTokens += sfp.tokens.cache.read;
    ctx.cacheWriteTokens += sfp.tokens.cache.write;
    ctx.costUsd += sfp.cost;

    // maxTurns enforcement: abort the live OpenCode session and flag the
    // breach so runSession() builds a signal:none result with metrics
    // preserved + "Max turns exceeded (N)" marker prepended to resultText.
    // maxTurns === 0 means "no limit".
    if (ctx.maxTurns && ctx.numTurns >= ctx.maxTurns && !ctx.aborted) {
      ctx.aborted = true;
      ctx.maxTurnsExceeded = true;
      this.client?.session
        .abort({ sessionID: ctx.sessionId! })
        .catch(() => {});
      // Suppress the terminal N/N turn-count blip — next retry resets cleanly.
      return;
    }

    if (ctx.logger.isVerbose) {
      const t = sfp.tokens;
      const parts = [`in=${t.input}`, `out=${t.output}`];
      if (t.reasoning) parts.push(`reason=${t.reasoning}`);
      if (t.cache.read) parts.push(`cache_r=${t.cache.read}`);
      if (t.cache.write) parts.push(`cache_w=${t.cache.write}`);
      if (sfp.cost) parts.push(`$${sfp.cost.toFixed(4)}`);
      ctx.logger.logVerbose(
        `  [step-finish] ${sfp.reason} | ${parts.join(" ")}`,
      );
    }

    // Emit context usage — per-step tokens = current context size
    // (stateless API resends full history each step, so per-step input is the real context size)
    const contextTokens = sfp.tokens.input + sfp.tokens.cache.read + sfp.tokens.cache.write;
    if (contextTokens > 0) {
      ctx.logger.sendToLog({
        type: "agent:context_usage",
        contextTokens,
        contextWindow: ctx.resolvedContextWindow ?? getContextWindow(ctx.model),
        model: ctx.model,
        unitId: ctx.unitId,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private: post-loop metrics and result assembly
  // ---------------------------------------------------------------------------

  /**
   * Fetch final metrics from session.messages() API.
   *
   * Token counts come from step-finish SSE events (already accumulated in ctx)
   * because OpenCode's AssistantMessage.tokens is per-step, not cumulative.
   * We use session.messages() for: duration, model name, cost (overrides), and
   * text fallback if SSE didn't capture any text.
   */
  private async fetchFinalMetrics(ctx: OpenCodeContext): Promise<void> {
    if (!ctx.sessionId || !this.client) return;

    try {
      const messagesResult = await this.client.session.messages({
        sessionID: ctx.sessionId,
        directory: ctx.cwd,
      });
      if (messagesResult.error || !messagesResult.data) {
        if (ctx.logger.isVerbose) {
          ctx.logger.log(`  [opencode] session.messages() failed`);
        }
        return;
      }

      const messages = messagesResult.data as Array<{
        info: { role: string } & Record<string, unknown>;
        parts: Part[];
      }>;
      const assistantMsgs = messages.filter(
        (m) => m.info.role === "assistant",
      );
      if (assistantMsgs.length === 0) return;

      // Cost: accumulated per-message in OpenCode (overrides step-finish total)
      let sumCost = 0;
      for (const msg of assistantMsgs) {
        const info = msg.info as unknown as AssistantMessage;
        sumCost += info.cost ?? 0;
      }
      ctx.costUsd = sumCost;

      // Duration: first message created → last message completed
      // OpenCode timestamps are milliseconds (despite SDK types declaring seconds)
      const first = assistantMsgs[0].info as unknown as AssistantMessage;
      const last =
        assistantMsgs[assistantMsgs.length - 1]
          .info as unknown as AssistantMessage;
      const createdMs = first.time?.created ?? 0;
      const completedMs =
        last.time?.completed ?? last.time?.created ?? createdMs;
      ctx.durationMs = Math.max(0, completedMs - createdMs);

      // Model from last assistant message
      if (last.providerID && last.modelID) {
        ctx.model = `${last.providerID}/${last.modelID}`;
      }

      ctx.numTurns = Math.max(ctx.numTurns, assistantMsgs.length);

      // Text fallback: if no text was accumulated from SSE, extract from messages
      if (ctx.textPartAccumulator.size === 0) {
        const lastMsg = assistantMsgs[assistantMsgs.length - 1];
        const textParts = lastMsg.parts.filter(
          (p): p is TextPart => p.type === "text",
        );
        ctx.resultText = textParts.map((p) => p.text).join("\n");
      }
    } catch (metricsErr) {
      if (ctx.logger.isVerbose) {
        ctx.logger.log(
          `  [opencode] session.messages() error: ${metricsErr}`,
        );
      }
    }
  }

  /** Assemble IterationResult from accumulated context and a signal. */
  private buildIterationResult(
    ctx: OpenCodeContext & { resultText: string },
    signal: AgentSignal,
    agentReport: string | null = null,
    reviewReport: string | null = null,
  ): IterationResult {
    return {
      signal,
      numTurns: ctx.numTurns,
      durationMs: ctx.durationMs,
      costUsd: ctx.costUsd,
      resultText: ctx.resultText,
      inputTokens: ctx.inputTokens,
      outputTokens: ctx.outputTokens,
      cacheReadTokens: ctx.cacheReadTokens,
      cacheWriteTokens: ctx.cacheWriteTokens,
      reasoningTokens: ctx.reasoningTokens,
      model: ctx.model,
      agentReport,
      reviewReport,
      startedAt: "",
      finishedAt: "",
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an error IterationResult with zero metrics. */
function errorResult(message: string): IterationResult {
  return {
    signal: { type: "error", message },
    durationMs: 0,
    costUsd: 0,
    numTurns: 0,
    resultText: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    model: "unknown",
    agentReport: null,
    reviewReport: null,
    startedAt: "",
    finishedAt: "",
  };
}
