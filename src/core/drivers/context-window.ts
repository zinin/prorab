/**
 * Substring → context-window table, checked in order (first match wins).
 *
 * `[1m]` comes first because it is the authoritative marker: the SDK exposes
 * 1M-context variants as explicitly suffixed ids (`opus[1m]`,
 * `claude-opus-5[1m]`, `claude-fable-5[1m]`). Matching the suffix rather than
 * a model family keeps the table correct across generations — a bare
 * `claude-opus-5` really is a 200K model, and only the suffixed variant is 1M.
 *
 * The `opus-4`/`sonnet-4` entries are kept for older ids that carry no suffix
 * (including composite OpenCode ids like `anthropic/claude-opus-4-6`).
 */
const CONTEXT_WINDOWS: Array<{ match: string; limit: number }> = [
  { match: "[1m]", limit: 1_000_000 },
  { match: "opus-4", limit: 1_000_000 },
  { match: "sonnet-4", limit: 1_000_000 },
  { match: "haiku", limit: 200_000 },
];

/**
 * Whether the table above may be consulted for this model id.
 *
 * Every entry describes a Claude model, but prorab also routes third-party
 * models through drivers that reuse ClaudeDriver, and their ids can carry the
 * same decorations. CCS passes each profile's `ANTHROPIC_MODEL` straight in
 * (`deepseek-v4-pro[1m]`, `glm-5.3[1m]`), and the documented Ollama reviewer
 * spec accepts `ollama:deepseek-v4-pro:cloud[1m]`. Without this gate the
 * `[1m]` row would claim 1M for all of them, and — worse — mark them
 * `matched`, so `setContextWindow` would then reject the real limit reported
 * at runtime and the wrong value could never be corrected.
 *
 * Non-Claude ids therefore get no hardcoded baseline, which is exactly the
 * relaxed path OllamaDriver relies on to publish its catalog limits.
 */
const CLAUDE_ALIAS = /^(default|opus|sonnet|haiku|fable)(\[|$)/;

function isClaudeModelId(model: string): boolean {
  // Fully-qualified ids (`claude-opus-5[1m]`) and the composite OpenCode form
  // (`anthropic/claude-opus-4-6`) both contain `claude-`; the CLI additionally
  // offers short aliases with an optional `[1m]` suffix.
  return model.includes("claude-") || CLAUDE_ALIAS.test(model);
}

const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Cache of model context windows resolved from SDK modelUsage at runtime. */
const resolvedCache = new Map<string, number>();

/**
 * Store a model's context window size.
 *
 * For models that match a substring in CONTEXT_WINDOWS (`[1m]` / opus-4 /
 * sonnet-4 / haiku) we keep the original guard: only accept values that are
 * >= the hardcoded fallback. This prevents SDK-reported API limits (e.g. a
 * 200K plan) from masking the known model capability (e.g. Opus 1M).
 *
 * For models that do NOT match any substring (e.g. Ollama-cloud ids like
 * `glm-5.1:cloud` with a 198K real limit) there is no hardcoded baseline to
 * defend, so any positive value is accepted. This is necessary for
 * OllamaDriver to publish the authoritative limit from its catalog even when
 * that limit is below the 200K default. Non-Claude ids never match — see
 * `isClaudeModelId`.
 */
export function setContextWindow(model: string, contextWindow: number): void {
  if (!model || contextWindow <= 0) return;

  // Find the hardcoded fallback for this model
  let hardcodedLimit = DEFAULT_CONTEXT_WINDOW;
  let matched = false;
  if (isClaudeModelId(model)) {
    for (const { match, limit } of CONTEXT_WINDOWS) {
      if (model.includes(match)) {
        hardcodedLimit = limit;
        matched = true;
        break;
      }
    }
  }

  if (!matched || contextWindow >= hardcodedLimit) {
    resolvedCache.set(model, contextWindow);
  }
}

/**
 * Look up model context window size.
 * Priority: exact-match cache (from SDK) → substring match (hardcoded) → default.
 */
export function getContextWindow(model: string): number {
  const cached = resolvedCache.get(model);
  if (cached !== undefined) return cached;

  if (!isClaudeModelId(model)) return DEFAULT_CONTEXT_WINDOW;

  for (const { match, limit } of CONTEXT_WINDOWS) {
    if (model.includes(match)) return limit;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Reset the resolved cache. Exported for testing only. */
export function _resetContextWindowCache(): void {
  resolvedCache.clear();
}
