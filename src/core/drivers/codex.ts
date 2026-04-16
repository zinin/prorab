import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Codex } from "@openai/codex-sdk";
import type { ModelReasoningEffort, ThreadEvent, Thread } from "@openai/codex-sdk";
import type { IterationResult, ModelEntry } from "../../types.js";
import type {
  AgentDriver,
  ChatEvent,
  ChatOptions,
  QuestionAnswers,
  SessionOptions,
} from "./types.js";
import { parseSignal, parseReport, parseReviewReport, MaxTurnsExceededError } from "./types.js";
import { SessionLogger } from "./logging.js";
import { setContextWindow } from "./context-window.js";
import { AsyncQueue } from "./async-queue.js";

const DEFAULT_CODEX_MODEL = "gpt-5.4";
const DEFAULT_CODEX_CONTEXT_WINDOW = 272_000;

export class CodexDriver implements AgentDriver {
  constructor(private model?: string) {}

  /** Context window cache populated by listModels, keyed by model slug. */
  private contextWindows = new Map<string, number>();

  // --- Chat state ---
  private chatQueue: AsyncQueue<ChatEvent> | null = null;
  private chatThread: Thread | null = null;
  private chatAbortController: AbortController | null = null;
  private chatOpts: ChatOptions | null = null;
  private isFirstMessage = true;
  private messageQueue: AsyncQueue<string> | null = null;
  /** Thread ID from thread.started — used to find session file for accurate token counts. */
  private threadId: string | null = null;
  /** Cached path to the Codex session JSONL file (~/.codex/sessions/...). */
  private sessionFilePath: string | null = null;

  async listModels(): Promise<ModelEntry[]> {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    let raw: string;
    try {
      raw = await fs.readFile(cachePath, "utf-8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let data: {
      models: Array<{
        slug: string;
        display_name: string;
        visibility: string;
        priority: number;
        context_window?: number;
        supported_reasoning_levels?: Array<{ effort: string }>;
      }>;
    };
    try {
      data = JSON.parse(raw);
    } catch {
      return []; // malformed cache file
    }
    if (!Array.isArray(data?.models)) return [];
    // Cache context windows for later use in runSession/startChat
    for (const m of data.models) {
      if (m.context_window) {
        this.contextWindows.set(m.slug, m.context_window);
      }
    }
    return data.models
      .filter((m) => m.visibility === "list")
      .sort((a, b) => a.priority - b.priority)
      .map((m) => ({
        id: m.slug,
        name: m.display_name,
        variants: m.supported_reasoning_levels?.map((l) => l.effort),
      }));
  }

  /**
   * Read last_token_usage from the Codex session file (~/.codex/sessions/...).
   * The session file contains token_count events with both cumulative (total_token_usage)
   * and per-API-call (last_token_usage) data. The TUI uses last_token_usage for accurate
   * context percentage — we do the same.
   */
  private async readLastTokenUsage(): Promise<{ inputTokens: number; contextWindow: number } | null> {
    if (!this.threadId) return null;
    // Find session file by thread ID (cached after first lookup)
    if (!this.sessionFilePath) {
      const sessDir = path.join(os.homedir(), ".codex", "sessions");
      try {
        const found = await this.findSessionFile(sessDir, this.threadId);
        if (!found) return null;
        this.sessionFilePath = found;
      } catch {
        return null;
      }
    }
    // Read the last token_count line from the file
    try {
      const content = await fs.readFile(this.sessionFilePath, "utf-8");
      const lines = content.split("\n");
      let lastTokenCount: string | null = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes('"token_count"')) {
          lastTokenCount = lines[i];
          break;
        }
      }
      if (!lastTokenCount) return null;
      const parsed = JSON.parse(lastTokenCount);
      const info = parsed?.payload?.info;
      if (!info?.last_token_usage) return null;
      return {
        inputTokens: info.last_token_usage.input_tokens + (info.last_token_usage.output_tokens ?? 0),
        contextWindow: info.model_context_window ?? DEFAULT_CODEX_CONTEXT_WINDOW,
      };
    } catch {
      return null;
    }
  }

  private async findSessionFile(sessDir: string, threadId: string): Promise<string | null> {
    // Session files: ~/.codex/sessions/YYYY/MM/DD/rollout-...-{threadId}.jsonl
    // Search recent date dirs (today, yesterday) for the thread ID
    const now = new Date();
    for (let daysBack = 0; daysBack < 3; daysBack++) {
      const d = new Date(now.getTime() - daysBack * 86400000);
      const dir = path.join(
        sessDir,
        String(d.getFullYear()),
        String(d.getMonth() + 1).padStart(2, "0"),
        String(d.getDate()).padStart(2, "0"),
      );
      try {
        const files = await fs.readdir(dir);
        const match = files.find((f) => f.includes(threadId));
        if (match) return path.join(dir, match);
      } catch {
        // dir doesn't exist
      }
    }
    return null;
  }

  /**
   * Build the IterationResult returned when maxTurns is breached. Both the
   * in-loop breach branch and the MaxTurnsExceededError catch branch share
   * this single source of truth.
   */
  private buildMaxTurnsResult(params: {
    maxTurns: number;
    startTime: number;
    toolCalls: number;
    resultText: string;
    usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number } | null;
    modelName: string;
  }): IterationResult {
    const marker = `Max turns exceeded (${params.maxTurns})`;
    console.error(`  !!! ${marker} — retrying !!!`);
    return {
      signal: { type: "none" },
      durationMs: Date.now() - params.startTime,
      costUsd: 0,
      numTurns: Math.max(1, params.toolCalls),
      resultText: `${marker}\n${params.resultText}`,
      inputTokens: params.usage?.input_tokens ?? 0,
      outputTokens: params.usage?.output_tokens ?? 0,
      cacheReadTokens: params.usage?.cached_input_tokens ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      model: params.modelName,
      agentReport: null,
      reviewReport: null,
      startedAt: "",
      finishedAt: "",
    };
  }

  async runSession(opts: SessionOptions): Promise<IterationResult> {
    const startTime = Date.now();
    const modelName = this.model ?? DEFAULT_CODEX_MODEL;

    const codex = new Codex();
    const thread = codex.startThread({
      workingDirectory: opts.cwd,
      model: this.model,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      modelReasoningEffort: opts.variant as ModelReasoningEffort | undefined,
      skipGitRepoCheck: true,
    });

    const fullPrompt = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
      : opts.prompt;

    const logger = new SessionLogger(opts.verbosity, opts.onLog);
    // NOTE: system_prompt and task_prompt are already emitted by commands/run.ts — don't duplicate.

    let resultText = "";
    let usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number } | null = null;
    let threadId: string | null = null;
    let toolCalls = 0;
    let maxTurnsExceeded = false;

    try {
      const streamedTurn = await thread.runStreamed(fullPrompt, {
        signal: opts.abortController?.signal,
      });

      for await (const event of streamedTurn.events) {
        if (maxTurnsExceeded) break;
        switch (event.type) {
          case "thread.started":
            threadId = (event as { thread_id: string }).thread_id;
            this.sessionFilePath = null; // reset cache for new thread
            // Emit initial context_usage so the model tab appears immediately in UI
            logger.sendToLog({
              type: "agent:context_usage",
              contextTokens: 0,
              contextWindow: this.contextWindows.get(modelName) ?? DEFAULT_CODEX_CONTEXT_WINDOW,
              model: modelName,
              unitId: opts.unitId,
            });
            break;
          case "item.started": {
            const item = event.item;
            if (item.type === "command_execution") {
              logger.logTool("command", { command: item.command });
            } else if (item.type === "file_change") {
              const paths = item.changes.map((c) => `${c.kind}: ${c.path}`).join(", ");
              logger.logTool("file_change", { changes: paths });
            } else if (item.type === "mcp_tool_call") {
              logger.logTool(item.tool, item.arguments as Record<string, unknown>);
            } else if (item.type === "web_search") {
              logger.logTool("web_search", {});
            }
            break;
          }
          case "item.completed": {
            const item = event.item;
            // Tool-call accounting: only actual tool invocations count toward
            // maxTurns. agent_message/reasoning/error items are excluded.
            if (
              item.type === "command_execution" ||
              item.type === "file_change" ||
              item.type === "mcp_tool_call" ||
              item.type === "web_search"
            ) {
              toolCalls++;
              // Emit live turn count for UI indicator BEFORE the abort check
              // so the breaching N/N value reaches the UI before the retry.
              logger.sendToLog({
                type: "agent:turn_count",
                numTurns: toolCalls,
                maxTurns: opts.maxTurns ?? 0,
                model: modelName,
                unitId: opts.unitId,
              });
              if (opts.maxTurns && toolCalls >= opts.maxTurns && !maxTurnsExceeded) {
                maxTurnsExceeded = true;
                const err = new MaxTurnsExceededError(opts.maxTurns);
                if (opts.abortController) {
                  opts.abortController.abort(err);
                }
                break; // exit switch; top-of-loop guard exits for-await
              }
            }
            if (item.type === "agent_message") {
              resultText += item.text;
              logger.logAssistant(item.text);
            } else if (item.type === "reasoning") {
              logger.sendToLog({ type: "agent:reasoning", text: item.text });
            } else if (item.type === "command_execution") {
              logger.logToolResult(item.aggregated_output);
            } else if (item.type === "file_change") {
              const paths = item.changes.map((c) => `${c.kind}: ${c.path}`).join(", ");
              logger.logToolResult(paths);
            } else if (item.type === "mcp_tool_call") {
              const output = item.error?.message ?? JSON.stringify(item.result ?? {});
              logger.logToolResult(output);
            } else if (item.type === "web_search") {
              logger.logTool("web_search", {});
            } else if (item.type === "error") {
              logger.logToolResult(`error: ${(item as { message?: string }).message ?? "unknown"}`);
            }
            // Update context usage from session file after each completed item
            if (threadId) {
              this.threadId = threadId;
              const tokenUsage = await this.readLastTokenUsage();
              if (tokenUsage) {
                setContextWindow(modelName, tokenUsage.contextWindow);
                logger.sendToLog({
                  type: "agent:context_usage",
                  contextTokens: tokenUsage.inputTokens,
                  contextWindow: tokenUsage.contextWindow,
                  model: modelName,
                  unitId: opts.unitId,
                });
              }
            }
            break;
          }
          case "turn.completed":
            usage = event.usage;
            break;
          case "turn.failed":
            throw new Error(event.error.message);
          case "error":
            throw new Error(event.message);
        }
      }

      if (maxTurnsExceeded) {
        const breachLimit = opts.maxTurns ?? 0;
        return this.buildMaxTurnsResult({
          maxTurns: breachLimit,
          startTime,
          toolCalls,
          resultText,
          usage,
          modelName,
        });
      }
    } catch (err: unknown) {
      // Detect our own abort even when the SDK wraps or replaces the reason.
      // abortController.abort(err) may surface as:
      //   - the MaxTurnsExceededError itself (direct throw)
      //   - a DOMException AbortError whose signal.reason IS our error
      //   - some other thrown Error while maxTurnsExceeded flag is already set
      const reason = opts.abortController?.signal.reason;
      const isOurBreach =
        maxTurnsExceeded ||
        err instanceof MaxTurnsExceededError ||
        reason instanceof MaxTurnsExceededError;
      if (isOurBreach) {
        const breachLimit =
          (err instanceof MaxTurnsExceededError && err.maxTurns) ||
          (reason instanceof MaxTurnsExceededError && reason.maxTurns) ||
          opts.maxTurns ||
          0;
        return this.buildMaxTurnsResult({
          maxTurns: breachLimit,
          startTime,
          toolCalls,
          resultText,
          usage,
          modelName,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return {
        signal: { type: "error", message },
        durationMs: Date.now() - startTime,
        costUsd: 0,
        numTurns: Math.max(0, toolCalls),
        resultText: "",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: modelName,
        agentReport: null,
        reviewReport: null,
        startedAt: "",
        finishedAt: "",
      };
    }

    const signal = parseSignal(resultText);
    const agentReport = parseReport(resultText);
    const reviewReport = parseReviewReport(resultText);

    return {
      signal,
      durationMs: Date.now() - startTime,
      costUsd: 0,
      numTurns: Math.max(1, toolCalls),
      resultText,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cached_input_tokens ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      model: modelName,
      agentReport,
      reviewReport,
      startedAt: "",
      finishedAt: "",
    };
  }

  startChat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    if (this.chatThread !== null) {
      throw new Error("A chat session is already active. Call abortChat() before starting a new one.");
    }

    const codex = new Codex();
    this.chatOpts = opts;
    this.isFirstMessage = true;
    this.threadId = null;
    this.sessionFilePath = null;
    this.chatAbortController = new AbortController();
    this.chatQueue = new AsyncQueue<ChatEvent>();
    this.messageQueue = new AsyncQueue<string>();
    this.chatThread = codex.startThread({
      workingDirectory: opts.cwd,
      model: this.model,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      modelReasoningEffort: opts.variant as ModelReasoningEffort | undefined,
      skipGitRepoCheck: true,
    });

    // Background consumer: process messages sequentially
    this.consumeMessages();

    return this.chatQueue;
  }

  private async consumeMessages(): Promise<void> {
    if (!this.messageQueue || !this.chatThread || !this.chatQueue || !this.chatAbortController) return;
    const queue = this.chatQueue;
    const thread = this.chatThread;
    const ac = this.chatAbortController;
    try {
      for await (const text of this.messageQueue) {
        if (queue.isClosed) break;
        let prompt = text;
        if (this.isFirstMessage && this.chatOpts?.systemPrompt) {
          prompt = `${this.chatOpts.systemPrompt}\n\n---\n\n${text}`;
          this.isFirstMessage = false;
        }
        try {
          const streamedTurn = await thread.runStreamed(prompt, {
            signal: ac.signal,
          });
          for await (const event of streamedTurn.events) {
            if (queue.isClosed) break;
            this.mapCodexEventToChatEvent(event, queue);
          }
          // Read accurate context usage from Codex session file (last_token_usage),
          // then emit context_usage + idle (idle must come after context_usage).
          if (!queue.isClosed) {
            const tokenUsage = await this.readLastTokenUsage();
            const modelName = this.model ?? DEFAULT_CODEX_MODEL;
            if (tokenUsage) {
              setContextWindow(modelName, tokenUsage.contextWindow);
              queue.push({
                type: "context_usage",
                usage: {
                  contextTokens: tokenUsage.inputTokens,
                  contextWindow: tokenUsage.contextWindow,
                  model: modelName,
                },
              });
            }
            queue.push({ type: "idle" });
          }
        } catch (err: unknown) {
          if (ac.signal.aborted) {
            break;
          }
          try {
            if (!queue.isClosed) {
              const msg = err instanceof Error ? err.message : String(err);
              queue.push({ type: "error", message: msg });
            }
          } catch {
            // Queue closed — safe to ignore
          }
          // Terminal — ChatManager stops consuming on error, so exit loop
          // to avoid orphaning this background producer.
          break;
        }
      }
    } finally {
      try {
        if (!queue.isClosed) {
          queue.push({ type: "finished" });
          queue.close();
        }
      } catch {
        // already closed
      }
    }
  }

  sendMessage(text: string): void {
    if (!this.messageQueue) {
      throw new Error("No active chat session. Call startChat() first.");
    }
    if (this.chatAbortController?.signal.aborted) {
      throw new Error("Chat session has been aborted.");
    }
    this.messageQueue.push(text);
  }

  replyQuestion(_questionId: string, _answers: QuestionAnswers): void {
    // no-op — Codex SDK does not support agent-initiated questions
  }

  abortChat(): void {
    this.chatAbortController?.abort();
    this.messageQueue?.close();
    this.chatThread = null;
    this.messageQueue = null;
    this.chatAbortController = null;
    this.chatOpts = null;
  }

  private mapCodexEventToChatEvent(
    event: ThreadEvent,
    queue: AsyncQueue<ChatEvent>,
  ): void {
    switch (event.type) {
      case "thread.started":
        if ("thread_id" in event) {
          this.threadId = (event as { thread_id: string }).thread_id;
          this.sessionFilePath = null; // reset cache for new thread
        }
        break;
      case "item.started": {
        const item = event.item;
        if (item.type === "command_execution") {
          queue.push({
            type: "tool",
            name: "command",
            input: { command: item.command },
          });
        } else if (item.type === "file_change") {
          queue.push({
            type: "tool",
            name: "file_change",
            input: { changes: item.changes },
          });
        } else if (item.type === "mcp_tool_call") {
          queue.push({
            type: "tool",
            name: item.tool,
            input: item.arguments as Record<string, unknown>,
          });
        }
        break;
      }
      case "item.completed": {
        const item = event.item;
        if (item.type === "agent_message") {
          queue.push({ type: "text", content: item.text });
        } else if (item.type === "reasoning") {
          queue.push({ type: "reasoning", content: item.text });
        } else if (item.type === "command_execution") {
          queue.push({
            type: "tool_result",
            name: "command",
            output: item.aggregated_output,
          });
        } else if (item.type === "file_change") {
          const paths = item.changes
            .map((c) => `${c.kind}: ${c.path}`)
            .join(", ");
          queue.push({ type: "tool_result", name: "file_change", output: paths });
        } else if (item.type === "mcp_tool_call") {
          const output =
            item.error?.message ?? JSON.stringify(item.result ?? {});
          queue.push({ type: "tool_result", name: item.tool, output });
        } else if (item.type === "web_search") {
          queue.push({ type: "tool", name: "web_search", input: {} });
        } else if (item.type === "error") {
          queue.push({ type: "tool_result", name: "error", output: (item as { message?: string }).message ?? "unknown error" });
        }
        break;
      }
      case "turn.completed": {
        // context_usage + idle emitted asynchronously after reading session file (see consumeMessages)
        break;
      }
      case "turn.failed": {
        const error = event.error;
        queue.push({ type: "error", message: error.message });
        break;
      }
      case "error": {
        queue.push({ type: "error", message: event.message });
        break;
      }
    }
  }
}
