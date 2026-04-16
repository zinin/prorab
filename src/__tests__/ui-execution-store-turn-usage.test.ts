import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useExecutionStore } from "../../ui/src/stores/execution";

describe("executionStore — turnUsage", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("stores and retrieves turn usage per unit", () => {
    const store = useExecutionStore();
    store.updateTurnUsage({ numTurns: 12, maxTurns: 100, model: "m1", unitId: "u1" });
    expect(store.turnUsageByUnit).toEqual({
      u1: { numTurns: 12, maxTurns: 100, model: "m1" },
    });
  });

  it("namespaces turn usage by reviewerId", () => {
    const store = useExecutionStore();
    store.updateTurnUsage({
      numTurns: 7, maxTurns: 100, model: "m1", unitId: "u1", reviewerId: "r1",
    });
    expect(store.turnUsageByUnit).toEqual({
      "u1:r1": { numTurns: 7, maxTurns: 100, model: "m1" },
    });
  });

  it("turnUsage getter returns the current unit's entry", () => {
    const store = useExecutionStore();
    store.currentUnit = { id: "u1", title: "x" };
    store.updateTurnUsage({ numTurns: 5, maxTurns: 50, model: "m1", unitId: "u1" });
    expect(store.turnUsage).toEqual({ numTurns: 5, maxTurns: 50, model: "m1" });
  });

  it("turnUsage returns null when no entry for current unit", () => {
    const store = useExecutionStore();
    store.currentUnit = { id: "u1", title: "x" };
    expect(store.turnUsage).toBeNull();
  });
});
