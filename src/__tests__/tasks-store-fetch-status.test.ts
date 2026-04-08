/**
 * Tests for tasksStore.fetchStatus() — authoritative project-state refresh
 * via GET /api/status.
 *
 * Verifies that fetchStatus correctly updates all project-state flags
 * from the server response, including the backward-compatible fallback chain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useTasksStore } from "../../ui/src/stores/tasks";

function mockFetchJson(data: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

function mockFetchFail(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error: "Server error" }),
  });
}

describe("tasksStore.fetchStatus", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("updates all project-state flags from server response", async () => {
    globalThis.fetch = mockFetchJson({
      hasPrd: true,
      hasTasksFile: true,
      hasValidTasks: true,
      hasTasksJson: true,
    });
    const store = useTasksStore();

    // Start with non-default values
    store.hasPrd = false;
    store.hasTasksFile = false;
    store.hasValidTasks = false;

    await store.fetchStatus();

    expect(store.hasPrd).toBe(true);
    expect(store.hasTasksFile).toBe(true);
    expect(store.hasValidTasks).toBe(true);
    expect(store.hasTasksJson).toBe(true);
  });

  it("sets hasTasksFile=false and hasValidTasks=false when server reports no file", async () => {
    globalThis.fetch = mockFetchJson({
      hasPrd: true,
      hasTasksFile: false,
      hasValidTasks: false,
      hasTasksJson: false,
    });
    const store = useTasksStore();

    await store.fetchStatus();

    expect(store.hasPrd).toBe(true);
    expect(store.hasTasksFile).toBe(false);
    expect(store.hasValidTasks).toBe(false);
    expect(store.hasTasksJson).toBe(false);
  });

  it("distinguishes hasTasksFile=true from hasValidTasks=false (corrupted file)", async () => {
    globalThis.fetch = mockFetchJson({
      hasPrd: false,
      hasTasksFile: true,
      hasValidTasks: false,
      hasTasksJson: true,
    });
    const store = useTasksStore();

    await store.fetchStatus();

    expect(store.hasTasksFile).toBe(true);
    expect(store.hasValidTasks).toBe(false);
  });

  it("falls back gracefully when server sends only hasTasksJson (old server)", async () => {
    globalThis.fetch = mockFetchJson({
      hasTasksJson: true,
    });
    const store = useTasksStore();
    store.hasPrd = true; // pre-existing value

    await store.fetchStatus();

    // hasPrd defaults to false when absent
    expect(store.hasPrd).toBe(false);
    // hasTasksFile falls back to hasTasksJson
    expect(store.hasTasksFile).toBe(true);
    // hasValidTasks falls back to hasTasksFile → hasTasksJson
    expect(store.hasValidTasks).toBe(true);
    expect(store.hasTasksJson).toBe(true);
  });

  it("sends GET request to /api/status", async () => {
    const mockFn = mockFetchJson({ hasPrd: false });
    globalThis.fetch = mockFn;
    const store = useTasksStore();

    await store.fetchStatus();

    expect(mockFn).toHaveBeenCalledOnce();
    expect(mockFn.mock.calls[0][0]).toBe("/api/status");
  });

  it("silently fails on HTTP error (no throw, no state change)", async () => {
    globalThis.fetch = mockFetchFail(500);
    const store = useTasksStore();

    // Set known values
    store.hasPrd = true;
    store.hasTasksFile = true;

    // Should not throw
    await store.fetchStatus();

    // Values should be unchanged
    expect(store.hasPrd).toBe(true);
    expect(store.hasTasksFile).toBe(true);
  });

  it("silently fails on network error (no throw, no state change)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Network error"));
    const store = useTasksStore();

    store.hasPrd = true;
    store.hasTasksFile = false;

    // Should not throw
    await store.fetchStatus();

    // Values should be unchanged
    expect(store.hasPrd).toBe(true);
    expect(store.hasTasksFile).toBe(false);
  });
});
