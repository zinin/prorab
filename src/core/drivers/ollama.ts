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
 * Extract the context-window hint from a model id like
 * `deepseek-v4-pro:cloud[1m]` → 1_000_000, `foo:cloud[200k]` → 200_000.
 * Returns null if the model has no `[Nk]`/`[Nm]` suffix; the caller then
 * omits CLAUDE_CODE_AUTO_COMPACT_WINDOW and Claude Code uses its default.
 * Decimals (`[1.5m]`) and other units intentionally do not match.
 */
function parseContextWindow(model: string): number | null {
  const match = /\[(\d+)([km])\]/i.exec(model);
  if (!match) return null;
  const [, num, unit] = match;
  const multiplier = unit.toLowerCase() === "m" ? 1_000_000 : 1_000;
  return Number(num) * multiplier;
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

  async setup(opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    if (!this.model.includes(":cloud")) {
      throw new Error(
        `Ollama agent supports only cloud models (id must contain ':cloud'); got '${this.model}'.`,
      );
    }
    await this.preflightDaemon();
    await this.preflightModel();
    this.inner = new ClaudeDriver(this.model, this.useUserSettings);
    this.sessionEnv = this.buildEnv();
    const innerAsDriver = this.inner as AgentDriver;
    if (innerAsDriver.setup) {
      await innerAsDriver.setup(opts);
    }
  }

  private async preflightDaemon(): Promise<void> {
    const baseUrl = resolveBaseUrl();
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/api/version`, {
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });
    } catch {
      throw new Error(
        `Ollama daemon is not reachable at ${baseUrl}. Start it with: ollama serve`,
      );
    }
    if (!resp.ok) {
      throw new Error(
        `Ollama daemon is not reachable at ${baseUrl}. Start it with: ollama serve`,
      );
    }
  }

  private async preflightModel(): Promise<void> {
    const baseUrl = resolveBaseUrl();
    const url = `${baseUrl}/v1/models/${encodeURIComponent(this.model as string)}`;
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(
        `Ollama daemon at ${baseUrl} failed to verify model '${this.model}': ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The daemon may be transiently overloaded; retry, or check 'ollama serve' logs.`,
      );
    }
    if (resp.status === 404) {
      const catalog = OLLAMA_CLOUD_CATALOG.join(", ");
      throw new Error(
        `Model '${this.model}' is not available via ollama. ` +
          `Check 'ollama signin' status, or pick from: ${catalog}`,
      );
    }
    if (!resp.ok) {
      throw new Error(
        `Ollama daemon at ${baseUrl} failed to verify model '${this.model}': ` +
          `HTTP ${resp.status}. The daemon may be transiently overloaded; retry, or check 'ollama serve' logs.`,
      );
    }
  }

  private buildEnv(): Record<string, string> {
    const baseUrl = resolveBaseUrl();
    const model = this.model as string;
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    // Drop undefineds left behind by the spread on optional keys.
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete env[k];
    }
    // Strip any ANTHROPIC_*/CLAUDE_CODE_* leaked from the parent process so a
    // stale ANTHROPIC_API_KEY (real Anthropic key) cannot reach the inner SDK.
    for (const k of Object.keys(env)) {
      if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_")) delete env[k];
    }

    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = "ollama";        // sentinel; takes precedence over ANTHROPIC_API_KEY
    env.ANTHROPIC_API_KEY = "";                 // belt-and-suspenders: ensure no host key sneaks back via SDK defaults
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";   // matches `ollama launch claude` Run(); suppresses "Created by Claude Code" attribution
    const ctx = parseContextWindow(model);
    if (ctx !== null) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(ctx);
    }
    return env;
  }

  async teardown(): Promise<void> {
    const innerAsDriver = this.inner as AgentDriver | null;
    if (innerAsDriver?.teardown) {
      await innerAsDriver.teardown();
    }
    this.inner = null;
    this.sessionEnv = undefined;
  }

  runSession(opts: SessionOptions): Promise<IterationResult> {
    const driver = this.requireDriver();
    const { variant: _variant, env: callerEnv, ...rest } = opts as SessionOptions & { variant?: unknown };
    const mergedEnv = this.sessionEnv
      ? { ...(callerEnv ?? {}), ...this.sessionEnv }
      : callerEnv;
    return driver.runSession({ ...rest, env: mergedEnv } as SessionOptions);
  }

  private requireDriver(): ClaudeDriver {
    if (!this.inner) {
      throw new Error("Ollama driver not initialized. Call setup() first.");
    }
    return this.inner;
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
