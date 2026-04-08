const CONTEXT_WINDOWS: Array<{ match: string; limit: number }> = [
  { match: "opus", limit: 1_000_000 },
  { match: "sonnet", limit: 1_000_000 },
  { match: "haiku", limit: 200_000 },
];

const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Cache of model context windows resolved from SDK modelUsage at runtime. */
const resolvedCache = new Map<string, number>();

/**
 * Store a model's context window size (from SDK modelUsage).
 * Only accepts values that are >= the hardcoded fallback for the model.
 * This prevents SDK-reported API limits (e.g. 200K) from overriding
 * known model capabilities (e.g. Opus 1M).
 */
export function setContextWindow(model: string, contextWindow: number): void {
  if (!model || contextWindow <= 0) return;

  // Find the hardcoded fallback for this model
  let hardcodedLimit = DEFAULT_CONTEXT_WINDOW;
  for (const { match, limit } of CONTEXT_WINDOWS) {
    if (model.includes(match)) {
      hardcodedLimit = limit;
      break;
    }
  }

  // Only cache if SDK value meets or exceeds the hardcoded limit
  if (contextWindow >= hardcodedLimit) {
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
