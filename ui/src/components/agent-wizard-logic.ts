/**
 * Pure logic for the AgentWizard component.
 *
 * Extracted into a separate module so it can be unit-tested without
 * DOM rendering or @vue/test-utils.
 */

export interface ModelEntry {
  id: string;
  name: string;
  variants?: string[];
}

/**
 * Compute available variant options based on selected model and full model list.
 *
 * - If a model is selected, returns that model's variants.
 * - If no model is selected, returns variants only if ALL models share
 *   the exact same variant set (useful when agent-wide variants are uniform).
 */
export function computeVariantOptions(models: ModelEntry[], selectedModelId: string): string[] {
  if (selectedModelId) {
    const entry = models.find(m => m.id === selectedModelId);
    return entry?.variants ?? [];
  }
  // No model selected — show variants if ALL models share the same set
  if (models.length === 0) return [];
  const first = models[0].variants ?? [];
  if (first.length === 0) return [];
  const allSame = models.every(m => {
    const v = m.variants ?? [];
    return v.length === first.length && first.every(f => v.includes(f));
  });
  return allSame ? first : [];
}

/** Build the models API URL for a given agent value. */
export function buildModelsUrl(agentValue: string): string {
  return `/api/models?agent=${encodeURIComponent(agentValue)}`;
}

/** Check if an error is a fetch AbortError (request was cancelled). */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Guards against concurrent fetch race conditions.
 *
 * Each `start()` call aborts any previous in-flight request and returns
 * a new AbortSignal. After a fetch completes, `isCurrent(signal)` tells
 * whether this is still the most recent request — only then is it safe
 * to update loading state.
 *
 * Used by AgentWizard's `fetchModels` and ExecutionView's `fetchReviewerModels`.
 */
export class FetchAbortGuard {
  private current: AbortController | null = null;

  /** Abort any in-flight request and return a new signal for the next one. */
  start(): AbortSignal {
    this.current?.abort();
    const c = new AbortController();
    this.current = c;
    return c.signal;
  }

  /** Check if the given signal belongs to the most recent request. */
  isCurrent(signal: AbortSignal): boolean {
    return this.current?.signal === signal;
  }

  /** Abort the current in-flight request (e.g. on component unmount). */
  abort(): void {
    this.current?.abort();
    this.current = null;
  }
}

/** Result of a model fetch operation. */
export interface FetchModelsResult {
  models: ModelEntry[];
  /** True if a newer fetch was started before this one completed. */
  superseded: boolean;
  /** True if the fetch failed due to a network or server error. */
  error?: boolean;
}

/** Return type for createModelsFetcher — a fetch function plus an abort handle. */
export interface ModelsFetcher {
  /** Fetch models for the given agent. Cancels any previous in-flight request. */
  (agentValue: string): Promise<FetchModelsResult>;
  /** Abort any in-flight request (e.g. on component unmount). */
  abort(): void;
}

/**
 * Creates an abort-safe model fetcher.
 *
 * Each call cancels any previous in-flight request via AbortController.
 * Returns `{ models, superseded }` — when `superseded` is true, the caller
 * should not update state (a newer request took over).
 *
 * The returned function also exposes an `abort()` method for cleanup
 * (e.g. calling from `onUnmounted`).
 *
 * @param fetchFn - Injectable fetch function (for testing).
 */
export function createModelsFetcher(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
): ModelsFetcher {
  const guard = new FetchAbortGuard();

  const fetcher = async (agentValue: string): Promise<FetchModelsResult> => {
    const signal = guard.start();
    try {
      const res = await fetchFn(buildModelsUrl(agentValue), { signal });
      if (!res.ok) return { models: [], superseded: !guard.isCurrent(signal), error: true };
      const data = await res.json();
      return { models: data.models, superseded: !guard.isCurrent(signal) };
    } catch (err) {
      if (isAbortError(err)) return { models: [], superseded: true };
      // Non-abort errors (network, etc.) — return empty models with error flag
      return { models: [], superseded: !guard.isCurrent(signal), error: true };
    }
  };

  fetcher.abort = () => guard.abort();
  return fetcher;
}
