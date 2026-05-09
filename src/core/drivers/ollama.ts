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
 * Hardcoded list of cloud model ids prorab knows how to surface. Mirrors the
 * cloud catalog advertised by `ollama launch claude` upstream. Bump when new
 * cloud models ship; per-model probing in listModels() filters to whatever
 * the local daemon can actually serve, so false positives are auto-pruned.
 * The `[Nm]/[Nk]` suffix is a prorab-internal decoration consumed by
 * `parseContextWindow()` to set `CLAUDE_CODE_AUTO_COMPACT_WINDOW`; the daemon
 * never sees it because `stripContextSuffix()` removes it before any HTTP
 * probe or model-id env var.
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
 * Single source of truth for the context-window suffix shape — `[Nk]` / `[Nm]`,
 * integer only, case-insensitive, anchored at end-of-string so a `[Nm]`
 * fragment buried mid-id (a hypothetical `foo:cloud[1m]-beta`) is left intact
 * instead of producing a half-stripped daemon id like `foo:cloud-beta`. Used by
 * both `parseContextWindow` (extracts the numeric value) and
 * `stripContextSuffix` (removes the suffix to get the daemon-facing id).
 * Decimals (`[1.5m]`) and other units intentionally do not match.
 */
const CONTEXT_WINDOW_SUFFIX_RE = /\[(\d+)([km])\]$/i;

/**
 * Extract the context-window hint from a model id like
 * `deepseek-v4-pro:cloud[1m]` → 1_000_000, `foo:cloud[200k]` → 200_000.
 * Returns null if the model has no `[Nk]`/`[Nm]` suffix; the caller then
 * omits CLAUDE_CODE_AUTO_COMPACT_WINDOW and Claude Code uses its default.
 */
function parseContextWindow(model: string): number | null {
  const match = CONTEXT_WINDOW_SUFFIX_RE.exec(model);
  if (!match) return null;
  const [, num, unit] = match;
  const multiplier = unit.toLowerCase() === "m" ? 1_000_000 : 1_000;
  return Number(num) * multiplier;
}

/**
 * Strip a `[Nk]` / `[Nm]` context-window suffix from a model id, returning the
 * bare daemon-facing id. The Ollama daemon (0.23.x) rejects the decorated
 * form with HTTP 400 "invalid model name" — the suffix is a prorab-internal
 * decoration, used only by `parseContextWindow` to pin
 * `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. Returns the input unchanged when the
 * suffix is absent (or malformed, e.g. decimal `[1.5m]`).
 */
function stripContextSuffix(model: string): string {
  return model.replace(CONTEXT_WINDOW_SUFFIX_RE, "");
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
    // Resolve once and thread through; calling resolveBaseUrl() in each helper
    // would re-parse OLLAMA_HOST and could disagree if the env mutates between
    // calls (theoretical, but cheap to remove).
    const baseUrl = resolveBaseUrl();
    await this.preflightDaemon(baseUrl);
    await this.preflightModel(baseUrl);
    // Pass the stripped (daemon-facing) id to the inner ClaudeDriver — the
    // SDK forwards `queryOptions.model` to `/v1/messages` verbatim, and the
    // daemon rejects the [Nm]/[Nk]-decorated form with HTTP 400. The
    // decorated `this.model` is still consulted by `parseContextWindow` in
    // `buildEnv()` to pin `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
    this.inner = new ClaudeDriver(stripContextSuffix(this.model as string), this.useUserSettings);
    this.sessionEnv = this.buildEnv(baseUrl);
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

  private async preflightModel(baseUrl: string): Promise<void> {
    // Probe with the bare daemon-facing id; the [Nm]/[Nk] suffix is a prorab-
    // internal decoration that the daemon rejects with HTTP 400.
    const probeId = stripContextSuffix(this.model as string);
    const url = `${baseUrl}/v1/models/${encodeURIComponent(probeId)}`;
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
    // 401/403 indicate auth-side failure (cloud profile not signed in or
    // token revoked), same actionable message as 404 (run `ollama signin`).
    // Without this, a revoked/expired profile would surface as the misleading
    // "transient daemon issue" branch below.
    if (resp.status === 404 || resp.status === 401 || resp.status === 403) {
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

  private buildEnv(baseUrl: string): Record<string, string> {
    const model = this.model as string;
    // The SDK forwards the *_MODEL env vars verbatim to the daemon; the daemon
    // rejects the [Nm]/[Nk]-decorated id with HTTP 400. Strip for daemon-facing
    // env, but keep the decorated `model` for parseContextWindow below.
    const daemonModel = stripContextSuffix(model);
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
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = daemonModel;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = daemonModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = daemonModel;
    env.CLAUDE_CODE_SUBAGENT_MODEL = daemonModel;
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
    const { variant: _variant, env: callerEnv, ...rest } = opts;
    // Caller-supplied env survives for unmanaged keys (PATH/HOME/proxies);
    // sessionEnv wins for the ANTHROPIC_*/CLAUDE_CODE_* keys we manage.
    const mergedEnv = this.sessionEnv
      ? { ...(callerEnv ?? {}), ...this.sessionEnv }
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
    // Caller-supplied env survives for unmanaged keys (PATH/HOME/proxies);
    // sessionEnv wins for the ANTHROPIC_*/CLAUDE_CODE_* keys we manage.
    const mergedEnv = this.sessionEnv
      ? { ...(callerEnv ?? {}), ...this.sessionEnv }
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
      OLLAMA_CLOUD_CATALOG.map(async (id) => {
        // Probe with stripped (daemon-facing) form, but return the decorated
        // catalog id so the UI / `parseContextWindow` see the [Nm]/[Nk] suffix
        // when the user picks the model.
        const probeId = stripContextSuffix(id);
        try {
          const r = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(probeId)}`, {
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
