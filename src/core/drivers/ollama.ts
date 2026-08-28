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
import { setContextWindow } from "./context-window.js";

/**
 * Read the preflight timeout from `OLLAMA_PREFLIGHT_TIMEOUT_MS` and validate
 * shape — `AbortSignal.timeout()` throws `RangeError` for negative or
 * non-integer delays, which would otherwise surface as a stack trace at
 * module load time. Falls back to the 5000 ms default when the env var is
 * unset, empty, NaN, non-positive, or non-integer.
 */
function resolvePreflightTimeout(): number {
  const raw = process.env.OLLAMA_PREFLIGHT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return 5000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return 5000;
  return n;
}
const PREFLIGHT_TIMEOUT_MS = resolvePreflightTimeout();

/**
 * Cloud model catalog with explicit context-window limits, sourced from the
 * per-model pages on https://ollama.com. Each entry has the bare daemon-facing
 * model id and the limit in tokens.
 *
 * Two consumers read `contextWindow`:
 *   1. `buildEnv()` — sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` so the inner
 *      Claude Code CLI triggers autocompaction at the right threshold.
 *   2. `setup()` — publishes the value into `context-window.ts`'s cache via
 *      `setContextWindow()` so the prorab UI shows the correct lookup limit
 *      in `agent:context_usage` events (the substring matcher in
 *      `context-window.ts` has no knowledge of Ollama-cloud model ids and
 *      would otherwise fall through to the 200K default).
 *
 * Bump this list when Ollama publishes new cloud models. Models not present
 * here are still accepted by `setup()` (the cloud-only guard + per-model
 * probe still apply) but receive no context-window publication — the UI then
 * falls back to the 200K default.
 */
const OLLAMA_CLOUD_CATALOG: ReadonlyArray<{ id: string; contextWindow: number }> = [
  { id: "deepseek-v4-pro:cloud",      contextWindow: 1_000_000 },
  { id: "deepseek-v4-flash:cloud",    contextWindow: 1_000_000 },
  { id: "kimi-k3:cloud",              contextWindow: 1_000_000 },
  { id: "kimi-k2.7-code:cloud",       contextWindow:   256_000 },
  { id: "kimi-k2.6:cloud",            contextWindow:   256_000 },
  { id: "minimax-m3:cloud",           contextWindow: 1_000_000 },
  { id: "minimax-m2.7:cloud",         contextWindow:   200_000 },
  { id: "qwen3.5:cloud",              contextWindow:   256_000 },
  { id: "glm-5.3:cloud",              contextWindow: 1_000_000 },
  { id: "glm-5.3-flash:cloud",        contextWindow: 1_000_000 },
  { id: "glm-5.2:cloud",              contextWindow:   976_000 },
  { id: "glm-5.1:cloud",              contextWindow:   198_000 },
  { id: "nemotron-3-ultra:cloud",     contextWindow:   256_000 },
  { id: "nemotron-3-super:cloud",     contextWindow:   256_000 },
  // Published only under a size-qualified cloud tag — there is no bare
  // `mistral-large-3:cloud`. The `-cloud` form is accepted by setup()'s guard.
  { id: "mistral-large-3:675b-cloud", contextWindow:   256_000 },
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
 * Strip `ANTHROPIC_*` and `CLAUDE_CODE_*` keys from caller-supplied env.
 * Mirrors the same strip applied to `process.env` in `buildEnv()` so caller-
 * supplied env cannot reintroduce managed keys we deliberately removed (e.g.
 * a stale `ANTHROPIC_API_KEY` or a stray `CLAUDE_CODE_AUTO_COMPACT_WINDOW`).
 * PATH, HOME, language, proxy, and custom keys pass through.
 */
function stripManagedNamespaces(env: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  if (!env) return {};
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith("ANTHROPIC_") && !k.startsWith("CLAUDE_CODE_")) {
      out[k] = v;
    }
  }
  return out;
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
    private useUserSettings = false,
  ) {}

  async setup(opts: SetupOptions): Promise<void> {
    if (this.inner) {
      throw new Error(
        "Ollama driver already initialized. Call teardown() before setup() again.",
      );
    }
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    if (!this.model.includes(":cloud") && !this.model.includes("-cloud")) {
      throw new Error(
        `Ollama agent supports only cloud models (id must contain ':cloud' or '-cloud'); got '${this.model}'.`,
      );
    }
    // Capture the narrowed (non-undefined) model id once.
    const model = this.model;
    const baseUrl = resolveBaseUrl();
    await this.preflightDaemon(baseUrl);
    await this.preflightModel(baseUrl, model);

    // Look up the context window from the hardcoded catalog. Models not in
    // the catalog (custom cloud ids, future entries) get `undefined` — the
    // env var is omitted and the UI falls back to the 200K default.
    const catalogEntry = OLLAMA_CLOUD_CATALOG.find((e) => e.id === model);
    const contextWindow = catalogEntry?.contextWindow;

    // Publish the limit into the shared cache read by ClaudeDriver when
    // emitting `agent:context_usage`. Without this, getContextWindow(model)
    // falls back to DEFAULT_CONTEXT_WINDOW (200K) because no substring in
    // CONTEXT_WINDOWS (opus-4/sonnet-4/haiku) matches an Ollama cloud id.
    if (contextWindow !== undefined) {
      setContextWindow(model, contextWindow);
    }

    this.inner = new ClaudeDriver(model, this.useUserSettings);
    this.sessionEnv = this.buildEnv(baseUrl, model, contextWindow);
    const innerAsDriver = this.inner as AgentDriver;
    if (innerAsDriver.setup) {
      await innerAsDriver.setup(opts);
    }
  }

  private async preflightDaemon(baseUrl: string): Promise<void> {
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

  private async preflightModel(baseUrl: string, model: string): Promise<void> {
    const url = `${baseUrl}/v1/models/${encodeURIComponent(model)}`;
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(
        `Ollama daemon at ${baseUrl} failed to verify model '${model}': ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The daemon may be transiently overloaded; retry, or check 'ollama serve' logs.`,
      );
    }
    // 401/403 indicate auth-side failure (cloud profile not signed in or
    // token revoked), same actionable message as 404 (run `ollama signin`).
    // Without this, a revoked/expired profile would surface as the misleading
    // "transient daemon issue" branch below.
    if (resp.status === 404 || resp.status === 401 || resp.status === 403) {
      const catalog = OLLAMA_CLOUD_CATALOG.map((e) => e.id).join(", ");
      throw new Error(
        `Model '${model}' is not available via ollama. ` +
          `Check 'ollama signin' status, or pick from: ${catalog}`,
      );
    }
    // 400/422 indicate the daemon parsed the model id and rejected it as
    // malformed. Distinct from "transient" — retrying won't help.
    if (resp.status === 400 || resp.status === 422) {
      const catalog = OLLAMA_CLOUD_CATALOG.map((e) => e.id).join(", ");
      throw new Error(
        `Ollama daemon at ${baseUrl} rejected model id '${model}' with HTTP ${resp.status} (invalid format). ` +
          `Pick from: ${catalog}`,
      );
    }
    if (!resp.ok) {
      throw new Error(
        `Ollama daemon at ${baseUrl} failed to verify model '${model}': ` +
          `HTTP ${resp.status}. The daemon may be transiently overloaded; retry, or check 'ollama serve' logs.`,
      );
    }
  }

  private buildEnv(baseUrl: string, model: string, contextWindow: number | undefined): Record<string, string> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

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
    if (contextWindow !== undefined) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextWindow);
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
    const { variant: _variant, env: callerEnv, ...rest } = opts;
    // Caller-supplied ANTHROPIC_*/CLAUDE_CODE_* keys are stripped (same strip
    // buildEnv applies to process.env) — otherwise opts.env could reintroduce
    // managed keys we deliberately removed. PATH/HOME/proxies/custom keys
    // pass through; sessionEnv wins for our managed overrides.
    const mergedEnv = this.sessionEnv
      ? { ...stripManagedNamespaces(callerEnv), ...this.sessionEnv }
      : callerEnv;
    return driver.runSession({ ...rest, env: mergedEnv });
  }

  private requireDriver(): ClaudeDriver {
    if (!this.inner) {
      throw new Error("Ollama driver not initialized. Call setup() first.");
    }
    return this.inner;
  }

  startChat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    const driver = this.requireDriver();
    const { variant: _variant, env: callerEnv, ...rest } = opts;
    const mergedEnv = this.sessionEnv
      ? { ...stripManagedNamespaces(callerEnv), ...this.sessionEnv }
      : callerEnv;
    return driver.startChat({ ...rest, env: mergedEnv });
  }

  sendMessage(text: string): void {
    this.requireDriver().sendMessage(text);
  }

  replyQuestion(questionId: string, answers: QuestionAnswers): void {
    this.requireDriver().replyQuestion(questionId, answers);
  }

  abortChat(): void {
    this.requireDriver().abortChat();
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
      OLLAMA_CLOUD_CATALOG.map(async (entry) => {
        try {
          const r = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(entry.id)}`, {
            signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
          });
          return r.ok ? entry.id : null;
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
