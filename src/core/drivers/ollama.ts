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

const PREFLIGHT_TIMEOUT_MS = Number(process.env.OLLAMA_PREFLIGHT_TIMEOUT_MS) || 5000;

/**
 * Hardcoded list of cloud model ids prorab knows how to surface. Mirrors the
 * cloud catalog advertised by `ollama launch claude` upstream. Bump when new
 * cloud models ship; per-model probing in listModels() filters to whatever
 * the local daemon can actually serve, so false positives are auto-pruned.
 */
const OLLAMA_CLOUD_CATALOG: ReadonlyArray<string> = [
  "deepseek-v4-pro:cloud[1m]",
  "kimi-k2.6:cloud",
  "minimax-m2.7:cloud",
  "qwen3-coder:480b-cloud[1m]",
  "gpt-oss:120b-cloud",
];

function resolveBaseUrl(): string {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return "http://127.0.0.1:11434";
  if (raw.startsWith("/")) {
    throw new Error(
      `Unix-socket OLLAMA_HOST ('${raw}') is not supported. Use http://host:port or set TCP listening.`,
    );
  }
  if (/\s/.test(raw)) {
    throw new Error(`OLLAMA_HOST contains whitespace: '${raw}'`);
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

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
    let baseUrl: string;
    try {
      baseUrl = resolveBaseUrl();
    } catch {
      return [];
    }

    try {
      const v = await fetch(`${baseUrl}/api/version`, {
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });
      if (!v.ok) return [];
    } catch {
      return [];
    }

    const checks = await Promise.all(
      OLLAMA_CLOUD_CATALOG.map(async (id) => {
        try {
          const r = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(id)}`, {
            signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
          });
          return r.ok ? id : null;
        } catch {
          return null;
        }
      }),
    );
    return checks
      .filter((id): id is string => id !== null)
      .map((id) => ({ id, name: id }));
  }
}
