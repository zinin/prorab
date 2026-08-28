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
 * that limit is below the 200K default.
 */
export function setContextWindow(model: string, contextWindow: number): void {
  if (!model || contextWindow <= 0) return;

  // Find the hardcoded fallback for this model
  let hardcodedLimit = DEFAULT_CONTEXT_WINDOW;
  let matched = false;
  for (const { match, limit } of CONTEXT_WINDOWS) {
    if (model.includes(match)) {
      hardcodedLimit = limit;
      matched = true;
      break;
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

  for (const { match, limit } of CONTEXT_WINDOWS) {
    if (model.includes(match)) return limit;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Reset the resolved cache. Exported for testing only. */
export function _resetContextWindowCache(): void {
  resolvedCache.clear();
}
