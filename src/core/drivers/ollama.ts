import type { IterationResult, ModelEntry } from "../../types.js";
import type {
  AgentDriver,
  ChatEvent,
  ChatOptions,
  QuestionAnswers,
  SessionOptions,
  SetupOptions,
} from "./types.js";
import { ClaudeDriver } from "./claude.js";

/**
 * OllamaDriver wraps ClaudeDriver via composition (same strategy as CcsDriver).
 *
 * It points the Claude Agent SDK at the local Ollama daemon
 * (`http://127.0.0.1:11434` by default, or `OLLAMA_HOST`) so that
 * Anthropic-protocol requests reach Ollama-cloud models. The daemon takes
 * care of upstream Ed25519 signing.
 */
export class OllamaDriver implements AgentDriver {
  private inner: ClaudeDriver | null = null;
  private sessionEnv?: Record<string, string>;

  constructor(
    private model?: string,
    private useUserSettings: boolean = false,
  ) {}

  async setup(_opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    throw new Error("Not implemented yet");
  }

  async teardown(): Promise<void> {
    this.inner = null;
    this.sessionEnv = undefined;
  }

  runSession(_opts: SessionOptions): Promise<IterationResult> {
    throw new Error("Not implemented yet");
  }

  startChat(_opts: ChatOptions): AsyncIterable<ChatEvent> {
    throw new Error("Not implemented yet");
  }

  sendMessage(_text: string): void {
    throw new Error("Not implemented yet");
  }

  replyQuestion(_questionId: string, _answers: QuestionAnswers): void {
    throw new Error("Not implemented yet");
  }

  abortChat(): void {
    throw new Error("Not implemented yet");
  }

  async listModels(): Promise<ModelEntry[]> {
    return [];
  }
}
