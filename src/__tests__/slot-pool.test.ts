import { describe, it, expect, vi } from "vitest";
import { SlotPool } from "../core/slot-pool.js";

describe("SlotPool", () => {
  it("processes all items and returns results in input order", async () => {
    const items = [10, 20, 30];
    const results = await new SlotPool({
      items,
      concurrency: 2,
      worker: async (item) => item * 2,
    }).run();
    expect(results).toEqual([20, 40, 60]);
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await new SlotPool({
      items,
      concurrency: 3,
      worker: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      },
    }).run();
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("reuses slot indices", async () => {
    const slotsSeen: number[] = [];
    await new SlotPool({
      items: [1, 2, 3, 4, 5],
      concurrency: 2,
      worker: async (_item, slotIndex) => {
        slotsSeen.push(slotIndex);
        await new Promise((r) => setTimeout(r, 5));
      },
    }).run();
    // Only slot indices 0 and 1 should appear
    expect(new Set(slotsSeen)).toEqual(new Set([0, 1]));
  });

  it("calls onSlotStart and onSlotFinish callbacks", async () => {
    const starts: Array<[number, number]> = [];
    const finishes: Array<[number, number, number]> = [];
    await new SlotPool({
      items: [10, 20],
      concurrency: 2,
      worker: async (item) => item * 3,
      onSlotStart: (slot, item) => starts.push([slot, item]),
      onSlotFinish: (slot, item, result) => finishes.push([slot, item, result]),
    }).run();
    expect(starts).toHaveLength(2);
    expect(finishes).toHaveLength(2);
    expect(finishes.map(([, , r]) => r).sort()).toEqual([30, 60]);
  });

  it("abort cancels pending items", async () => {
    const processed: number[] = [];
    const pool = new SlotPool({
      items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      concurrency: 1,
      worker: async (item, _slot, signal) => {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 50);
          signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
        });
        processed.push(item);
      },
    });
    // Start and abort after short delay
    const runPromise = pool.run();
    await new Promise((r) => setTimeout(r, 80));
    pool.abort();
    await runPromise;
    expect(processed.length).toBeLessThan(10);
  });

  it("error in one worker does not stop others", async () => {
    const results = await new SlotPool({
      items: [1, 2, 3],
      concurrency: 3,
      worker: async (item) => {
        if (item === 2) throw new Error("fail");
        return item * 10;
      },
    }).run();
    // Item 2 should have undefined/error result, others should succeed
    expect(results[0]).toBe(10);
    expect(results[1]).toBeUndefined();
    expect(results[2]).toBe(30);
  });

  it("handles empty items array", async () => {
    const results = await new SlotPool({
      items: [],
      concurrency: 5,
      worker: async () => 42,
    }).run();
    expect(results).toEqual([]);
  });
});
