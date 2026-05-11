const CONTEXT_WINDOWS: Array<{ match: string; limit: number }> = [
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
 * For models that match a substring in CONTEXT_WINDOWS (opus-4 / sonnet-4 /
 * haiku) we keep the original guard: only accept values that are >= the
 * hardcoded fallback. This prevents SDK-reported API limits (e.g. a 200K
 * plan) from masking the known model capability (e.g. Opus 1M).
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
