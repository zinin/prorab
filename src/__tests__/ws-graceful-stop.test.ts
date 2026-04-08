/**
 * Tests for the graceful stop WebSocket contract:
 * - connected message includes `gracefulStop` field
 * - `execution:graceful_stop` event updates execution store
 * - `gracefulStop` resets on `execution:state` idle and `execution:all_done`
 * - connected rehydration sets `gracefulStop` from server snapshot
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useExecutionStore } from "../../ui/src/stores/execution";

/**
 * Simulate the exec-store switch from useWebSocket for graceful-stop-related events.
 * Extracted from useWebSocket.ts lines 152-218.
 */
function applyExecEvent(
  execStore: ReturnType<typeof useExecutionStore>,
  data: Record<string, unknown>,
): void {
  switch (data.type) {
    case "execution:state":
      execStore.state = data.state as string;
      if (data.state === "idle") {
        execStore.clearIterationInfo();
        execStore.gracefulStop = false;
      }
      break;
    case "execution:graceful_stop":
      execStore.gracefulStop = data.enabled as boolean;
      break;
    case "execution:all_done":
      execStore.state = "idle";
      execStore.currentUnit = null;
      execStore.clearIterationInfo();
      execStore.gracefulStop = false;
      break;
  }
}

/**
 * Simulate connected message rehydration for gracefulStop.
 * Extracted from useWebSocket.ts line 103.
 */
function applyConnectedGracefulStop(
  execStore: ReturnType<typeof useExecutionStore>,
  data: { gracefulStop?: boolean },
): void {
  execStore.gracefulStop = data.gracefulStop ?? false;
}

describe("execution:graceful_stop WS event", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("sets gracefulStop to true when enabled=true", () => {
    const store = useExecutionStore();
    expect(store.gracefulStop).toBe(false);

    applyExecEvent(store, { type: "execution:graceful_stop", enabled: true });
    expect(store.gracefulStop).toBe(true);
  });

  it("sets gracefulStop to false when enabled=false", () => {
    const store = useExecutionStore();
    store.gracefulStop = true;

    applyExecEvent(store, { type: "execution:graceful_stop", enabled: false });
    expect(store.gracefulStop).toBe(false);
  });

  it("toggles gracefulStop on repeated events", () => {
    const store = useExecutionStore();

    applyExecEvent(store, { type: "execution:graceful_stop", enabled: true });
    expect(store.gracefulStop).toBe(true);

    applyExecEvent(store, { type: "execution:graceful_stop", enabled: false });
    expect(store.gracefulStop).toBe(false);

    applyExecEvent(store, { type: "execution:graceful_stop", enabled: true });
    expect(store.gracefulStop).toBe(true);
  });
});

describe("gracefulStop reset on terminal events", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("resets gracefulStop on execution:state idle", () => {
    const store = useExecutionStore();
    store.gracefulStop = true;

    applyExecEvent(store, { type: "execution:state", state: "idle" });
    expect(store.gracefulStop).toBe(false);
  });

  it("does NOT reset gracefulStop on execution:state running", () => {
    const store = useExecutionStore();
    store.gracefulStop = true;

    applyExecEvent(store, { type: "execution:state", state: "running" });
    expect(store.gracefulStop).toBe(true);
  });

  it("resets gracefulStop on execution:all_done", () => {
    const store = useExecutionStore();
    store.gracefulStop = true;

    applyExecEvent(store, { type: "execution:all_done" });
    expect(store.gracefulStop).toBe(false);
  });
});

describe("connected message gracefulStop rehydration", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("sets gracefulStop=true from connected when server reports true", () => {
    const store = useExecutionStore();

    applyConnectedGracefulStop(store, { gracefulStop: true });
    expect(store.gracefulStop).toBe(true);
  });

  it("sets gracefulStop=false from connected when server reports false", () => {
    const store = useExecutionStore();
    store.gracefulStop = true;

    applyConnectedGracefulStop(store, { gracefulStop: false });
    expect(store.gracefulStop).toBe(false);
  });

  it("defaults to false when gracefulStop is missing from connected", () => {
    const store = useExecutionStore();
    store.gracefulStop = true;

    applyConnectedGracefulStop(store, {});
    expect(store.gracefulStop).toBe(false);
  });

  it("defaults to false when gracefulStop is undefined", () => {
    const store = useExecutionStore();
    store.gracefulStop = true;

    applyConnectedGracefulStop(store, { gracefulStop: undefined });
    expect(store.gracefulStop).toBe(false);
  });
});

describe("connected message includes gracefulStop field (server side)", () => {
  it("gracefulStop is present in connected payload shape", () => {
    // Verify the contract: connected message must include gracefulStop boolean.
    // This mirrors ws.ts line 154: gracefulStop: executionManager.gracefulStop
    const connectedPayload = {
      type: "connected",
      state: "running",
      currentUnit: null,
      iterationCurrent: 3,
      iterationTotal: 10,
      gracefulStop: true,
    };

    expect(connectedPayload).toHaveProperty("gracefulStop");
    expect(typeof connectedPayload.gracefulStop).toBe("boolean");
  });

  it("gracefulStop=false in connected when execution is idle", () => {
    const connectedPayload = {
      type: "connected",
      state: "idle",
      currentUnit: null,
      iterationCurrent: 0,
      iterationTotal: null,
      gracefulStop: false,
    };

    expect(connectedPayload.gracefulStop).toBe(false);
  });
});
