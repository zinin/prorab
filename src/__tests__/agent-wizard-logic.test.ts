import { describe, it, expect, vi } from "vitest";
import {
  computeVariantOptions,
  buildModelsUrl,
  isAbortError,
  FetchAbortGuard,
  createModelsFetcher,
  type ModelEntry,
  type ModelsFetcher,
} from "../../ui/src/components/agent-wizard-logic";

// ---------------------------------------------------------------------------
// computeVariantOptions
// ---------------------------------------------------------------------------
describe("computeVariantOptions", () => {
  it("returns empty array when models list is empty and no model selected", () => {
    expect(computeVariantOptions([], "")).toEqual([]);
  });

  it("returns selected model's variants", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: ["low", "medium", "high"] },
      { id: "m2", name: "Model 2", variants: ["fast", "slow"] },
    ];
    expect(computeVariantOptions(models, "m1")).toEqual(["low", "medium", "high"]);
  });

  it("returns empty array when selected model has no variants", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1" },
      { id: "m2", name: "Model 2", variants: ["a"] },
    ];
    expect(computeVariantOptions(models, "m1")).toEqual([]);
  });

  it("returns empty array when selected model has empty variants", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: [] },
    ];
    expect(computeVariantOptions(models, "m1")).toEqual([]);
  });

  it("returns empty array when selected model is not found", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: ["a", "b"] },
    ];
    expect(computeVariantOptions(models, "nonexistent")).toEqual([]);
  });

  // --- No model selected: uniform variant detection ---

  it("returns shared variants when all models have the same variant set", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: ["low", "high"] },
      { id: "m2", name: "Model 2", variants: ["low", "high"] },
      { id: "m3", name: "Model 3", variants: ["low", "high"] },
    ];
    expect(computeVariantOptions(models, "")).toEqual(["low", "high"]);
  });

  it("returns empty array when models have different variant sets", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: ["low", "high"] },
      { id: "m2", name: "Model 2", variants: ["fast", "slow"] },
    ];
    expect(computeVariantOptions(models, "")).toEqual([]);
  });

  it("returns empty array when models have different variant lengths", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: ["low", "medium", "high"] },
      { id: "m2", name: "Model 2", variants: ["low", "high"] },
    ];
    expect(computeVariantOptions(models, "")).toEqual([]);
  });

  it("returns empty array when some models have no variants", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: ["low", "high"] },
      { id: "m2", name: "Model 2" },
    ];
    expect(computeVariantOptions(models, "")).toEqual([]);
  });

  it("returns empty array when first model has empty variants", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: [] },
      { id: "m2", name: "Model 2", variants: [] },
    ];
    expect(computeVariantOptions(models, "")).toEqual([]);
  });

  it("returns shared variants for single model with no selection", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: ["a", "b", "c"] },
    ];
    expect(computeVariantOptions(models, "")).toEqual(["a", "b", "c"]);
  });

  it("handles variants in different order as same set", () => {
    const models: ModelEntry[] = [
      { id: "m1", name: "Model 1", variants: ["high", "low"] },
      { id: "m2", name: "Model 2", variants: ["low", "high"] },
    ];
    // The comparison uses first model's order and checks inclusion
    expect(computeVariantOptions(models, "")).toEqual(["high", "low"]);
  });
});

// ---------------------------------------------------------------------------
// buildModelsUrl
// ---------------------------------------------------------------------------
describe("buildModelsUrl", () => {
  it("builds URL for simple agent name", () => {
    expect(buildModelsUrl("claude")).toBe("/api/models?agent=claude");
  });

  it("builds URL for opencode agent", () => {
    expect(buildModelsUrl("opencode")).toBe("/api/models?agent=opencode");
  });

  it("encodes special characters in agent name", () => {
    expect(buildModelsUrl("my agent")).toBe("/api/models?agent=my%20agent");
  });

  it("encodes ampersand in agent name", () => {
    expect(buildModelsUrl("a&b")).toBe("/api/models?agent=a%26b");
  });
});

// ---------------------------------------------------------------------------
// isAbortError
// ---------------------------------------------------------------------------
describe("isAbortError", () => {
  it("returns true for DOMException with AbortError name", () => {
    const err = new DOMException("The operation was aborted", "AbortError");
    expect(isAbortError(err)).toBe(true);
  });

  it("returns false for DOMException with different name", () => {
    const err = new DOMException("fail", "NetworkError");
    expect(isAbortError(err)).toBe(false);
  });

  it("returns false for regular Error", () => {
    expect(isAbortError(new Error("fail"))).toBe(false);
  });

  it("returns false for TypeError", () => {
    expect(isAbortError(new TypeError("fail"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isAbortError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isAbortError(undefined)).toBe(false);
  });

  it("returns false for string", () => {
    expect(isAbortError("AbortError")).toBe(false);
  });

  it("returns false for plain object with matching name", () => {
    expect(isAbortError({ name: "AbortError" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FetchAbortGuard
// ---------------------------------------------------------------------------
describe("FetchAbortGuard", () => {
  it("start() returns an AbortSignal", () => {
    const guard = new FetchAbortGuard();
    const signal = guard.start();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("isCurrent() returns true for the most recent signal", () => {
    const guard = new FetchAbortGuard();
    const signal = guard.start();
    expect(guard.isCurrent(signal)).toBe(true);
  });

  it("isCurrent() returns false for a superseded signal", () => {
    const guard = new FetchAbortGuard();
    const first = guard.start();
    const second = guard.start();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("start() aborts the previous signal", () => {
    const guard = new FetchAbortGuard();
    const first = guard.start();
    expect(first.aborted).toBe(false);
    guard.start();
    expect(first.aborted).toBe(true);
  });

  it("handles multiple sequential starts correctly", () => {
    const guard = new FetchAbortGuard();
    const s1 = guard.start();
    const s2 = guard.start();
    const s3 = guard.start();
    expect(s1.aborted).toBe(true);
    expect(s2.aborted).toBe(true);
    expect(s3.aborted).toBe(false);
    expect(guard.isCurrent(s1)).toBe(false);
    expect(guard.isCurrent(s2)).toBe(false);
    expect(guard.isCurrent(s3)).toBe(true);
  });

  it("isCurrent() returns false for an unrelated signal", () => {
    const guard = new FetchAbortGuard();
    guard.start();
    const unrelated = new AbortController().signal;
    expect(guard.isCurrent(unrelated)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createModelsFetcher
// ---------------------------------------------------------------------------
describe("createModelsFetcher", () => {
  // --- Helpers ---

  function mockFetchSuccess(models: ModelEntry[]): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ models }),
    }) as unknown as typeof fetch;
  }

  function mockFetchError(status: number): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: false,
      status,
    }) as unknown as typeof fetch;
  }

  function mockFetchNetworkError(): typeof fetch {
    return vi.fn().mockRejectedValue(new TypeError("fetch failed")) as unknown as typeof fetch;
  }

  // --- Basic fetch ---

  it("fetches models for a given agent", async () => {
    const models: ModelEntry[] = [
      { id: "claude-3", name: "Claude 3", variants: ["low", "high"] },
    ];
    const fetchFn = mockFetchSuccess(models);
    const fetchModels = createModelsFetcher(fetchFn);

    const result = await fetchModels("claude");

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledWith(
      "/api/models?agent=claude",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.models).toEqual(models);
    expect(result.superseded).toBe(false);
  });

  it("returns empty models on non-ok response", async () => {
    const fetchFn = mockFetchError(500);
    const fetchModels = createModelsFetcher(fetchFn);

    const result = await fetchModels("claude");

    expect(result.models).toEqual([]);
    expect(result.superseded).toBe(false);
  });

  it("returns empty models on network error", async () => {
    const fetchFn = mockFetchNetworkError();
    const fetchModels = createModelsFetcher(fetchFn);

    const result = await fetchModels("claude");

    expect(result.models).toEqual([]);
    expect(result.superseded).toBe(false);
  });

  it("returns superseded=true on abort error", async () => {
    const fetchFn = vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    ) as unknown as typeof fetch;
    const fetchModels = createModelsFetcher(fetchFn);

    const result = await fetchModels("claude");

    expect(result.models).toEqual([]);
    expect(result.superseded).toBe(true);
  });

  // --- Agent change triggers new fetch ---

  it("calls fetch with correct URL when agent changes", async () => {
    const models: ModelEntry[] = [{ id: "m1", name: "M1" }];
    const fetchFn = mockFetchSuccess(models);
    const fetchModels = createModelsFetcher(fetchFn);

    await fetchModels("claude");
    await fetchModels("opencode");

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      "/api/models?agent=claude",
      expect.any(Object),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "/api/models?agent=opencode",
      expect.any(Object),
    );
  });

  // --- AbortController cancels previous request ---

  it("aborts previous request when new fetch starts", async () => {
    // Create a fetch that never resolves (simulating slow request)
    let resolveSlow!: (value: Response) => void;
    const slowPromise = new Promise<Response>((r) => { resolveSlow = r; });
    const fastModels: ModelEntry[] = [{ id: "fast", name: "Fast Model" }];

    const fetchFn = vi.fn()
      .mockReturnValueOnce(slowPromise)
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: fastModels }),
      }) as unknown as typeof fetch;

    const fetchModels = createModelsFetcher(fetchFn);

    // Start slow fetch (will be aborted)
    const slowPromiseResult = fetchModels("claude");

    // Start fast fetch immediately (aborts the slow one)
    const fastResult = await fetchModels("opencode");

    // Verify the first request's signal was aborted
    const firstCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    const firstSignal = firstCall[1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);

    // Verify the second request's signal was NOT aborted
    const secondCall = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1];
    const secondSignal = secondCall[1].signal as AbortSignal;
    expect(secondSignal.aborted).toBe(false);

    // Fast fetch returns correct models
    expect(fastResult.models).toEqual(fastModels);
    expect(fastResult.superseded).toBe(false);

    // Resolve the slow promise (simulate it completing after abort)
    resolveSlow({
      ok: true,
      json: () => Promise.resolve({ models: [{ id: "stale", name: "Stale" }] }),
    } as Response);

    // The slow result should be superseded
    const slowResult = await slowPromiseResult;
    expect(slowResult.superseded).toBe(true);
  });

  it("handles rapid sequential fetches — only last one is not superseded", async () => {
    const calls: Array<{
      resolve: (value: Response) => void;
      signal: AbortSignal;
    }> = [];

    const fetchFn = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise<Response>((resolve) => {
        calls.push({ resolve, signal: init.signal! });
      });
    }) as unknown as typeof fetch;

    const fetchModels = createModelsFetcher(fetchFn);

    // Start three fetches rapidly
    const p1 = fetchModels("agent1");
    const p2 = fetchModels("agent2");
    const p3 = fetchModels("agent3");

    // First two signals should be aborted
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(true);
    expect(calls[2].signal.aborted).toBe(false);

    // Resolve all three
    const makeResponse = (id: string) => ({
      ok: true,
      json: () => Promise.resolve({ models: [{ id, name: id }] }),
    } as Response);

    calls[0].resolve(makeResponse("m1"));
    calls[1].resolve(makeResponse("m2"));
    calls[2].resolve(makeResponse("m3"));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1.superseded).toBe(true);
    expect(r2.superseded).toBe(true);
    expect(r3.superseded).toBe(false);
    expect(r3.models).toEqual([{ id: "m3", name: "m3" }]);
  });

  it("passes abort signal to fetch function", async () => {
    const fetchFn = mockFetchSuccess([]);
    const fetchModels = createModelsFetcher(fetchFn);

    await fetchModels("claude");

    const call = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[1]).toHaveProperty("signal");
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  // --- error flag ---

  it("returns error=true on non-ok response", async () => {
    const fetchFn = mockFetchError(500);
    const fetchModels = createModelsFetcher(fetchFn);

    const result = await fetchModels("claude");

    expect(result.error).toBe(true);
  });

  it("returns error=true on network error", async () => {
    const fetchFn = mockFetchNetworkError();
    const fetchModels = createModelsFetcher(fetchFn);

    const result = await fetchModels("claude");

    expect(result.error).toBe(true);
  });

  it("does not set error on successful fetch", async () => {
    const models: ModelEntry[] = [{ id: "m1", name: "M1" }];
    const fetchFn = mockFetchSuccess(models);
    const fetchModels = createModelsFetcher(fetchFn);

    const result = await fetchModels("claude");

    expect(result.error).toBeUndefined();
  });

  it("does not set error on abort (superseded)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    ) as unknown as typeof fetch;
    const fetchModels = createModelsFetcher(fetchFn);

    const result = await fetchModels("claude");

    expect(result.error).toBeUndefined();
  });

  // --- abort() method ---

  it("exposes abort() method on returned function", () => {
    const fetchFn = mockFetchSuccess([]);
    const fetchModels = createModelsFetcher(fetchFn);

    expect(typeof fetchModels.abort).toBe("function");
  });

  it("abort() cancels in-flight request", async () => {
    let resolveSlowFetch!: (value: Response) => void;
    const slowPromise = new Promise<Response>((r) => { resolveSlowFetch = r; });

    const fetchFn = vi.fn().mockReturnValue(slowPromise) as unknown as typeof fetch;
    const fetchModels: ModelsFetcher = createModelsFetcher(fetchFn);

    const resultPromise = fetchModels("claude");

    // Verify the signal was not aborted before abort()
    const signal = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    // Call abort
    fetchModels.abort();

    // Signal should now be aborted
    expect(signal.aborted).toBe(true);

    // Resolve the slow fetch — result should be superseded because guard was cleared
    resolveSlowFetch({
      ok: true,
      json: () => Promise.resolve({ models: [{ id: "m1", name: "M1" }] }),
    } as Response);

    const result = await resultPromise;
    expect(result.superseded).toBe(true);
  });

  it("abort() is safe to call multiple times", () => {
    const fetchFn = mockFetchSuccess([]);
    const fetchModels = createModelsFetcher(fetchFn);

    // Should not throw
    fetchModels.abort();
    fetchModels.abort();
  });

  it("abort() is safe to call without any prior fetch", () => {
    const fetchFn = mockFetchSuccess([]);
    const fetchModels = createModelsFetcher(fetchFn);

    // Should not throw even when no fetch has been started
    expect(() => fetchModels.abort()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FetchAbortGuard.abort()
// ---------------------------------------------------------------------------
describe("FetchAbortGuard.abort()", () => {
  it("aborts the current signal", () => {
    const guard = new FetchAbortGuard();
    const signal = guard.start();
    expect(signal.aborted).toBe(false);

    guard.abort();
    expect(signal.aborted).toBe(true);
  });

  it("isCurrent returns false after abort()", () => {
    const guard = new FetchAbortGuard();
    const signal = guard.start();
    guard.abort();
    expect(guard.isCurrent(signal)).toBe(false);
  });

  it("is safe to call when no request has been started", () => {
    const guard = new FetchAbortGuard();
    expect(() => guard.abort()).not.toThrow();
  });

  it("is safe to call multiple times", () => {
    const guard = new FetchAbortGuard();
    guard.start();
    guard.abort();
    guard.abort();
    // Should not throw
  });

  it("allows new start() after abort()", () => {
    const guard = new FetchAbortGuard();
    const first = guard.start();
    guard.abort();
    expect(first.aborted).toBe(true);

    const second = guard.start();
    expect(second.aborted).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });
});
