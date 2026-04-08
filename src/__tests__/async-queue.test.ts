import { describe, expect, it } from "vitest";
import { AsyncQueue } from "../core/drivers/async-queue.js";

describe("AsyncQueue", () => {
  // ---- Basic push / consume ----

  it("yields items pushed before iteration starts (buffered)", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.push(3);
    q.close();

    const results: number[] = [];
    for await (const item of q) {
      results.push(item);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  it("yields items pushed while consumer is awaiting (immediate delivery)", async () => {
    const q = new AsyncQueue<string>();

    const collected: string[] = [];
    const done = (async () => {
      for await (const item of q) {
        collected.push(item);
      }
    })();

    // Allow the consumer to start awaiting
    await tick();

    q.push("a");
    q.push("b");
    await tick();

    q.close();
    await done;

    expect(collected).toEqual(["a", "b"]);
  });

  it("handles interleaved push and consume", async () => {
    const q = new AsyncQueue<number>();

    const collected: number[] = [];
    const done = (async () => {
      for await (const item of q) {
        collected.push(item);
      }
    })();

    // Push one item, let consumer pick it up, push another
    q.push(10);
    await tick();
    expect(collected).toEqual([10]);

    q.push(20);
    await tick();
    expect(collected).toEqual([10, 20]);

    q.push(30);
    q.push(40);
    await tick();
    expect(collected).toEqual([10, 20, 30, 40]);

    q.close();
    await done;
    expect(collected).toEqual([10, 20, 30, 40]);
  });

  // ---- close() ----

  it("close() terminates the async iterator", async () => {
    const q = new AsyncQueue<number>();

    const done = (async () => {
      const results: number[] = [];
      for await (const item of q) {
        results.push(item);
      }
      return results;
    })();

    q.push(1);
    await tick();
    q.close();

    const results = await done;
    expect(results).toEqual([1]);
  });

  it("close() resolves all pending waiters with done:true", async () => {
    const q = new AsyncQueue<string>();

    // Start two consumers — both should resolve when close() is called
    const iter = q[Symbol.asyncIterator]();

    const p1 = iter.next();
    const p2 = iter.next();

    q.close();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.done).toBe(true);
    expect(r2.done).toBe(true);
  });

  it("iterating an already-closed empty queue finishes immediately", async () => {
    const q = new AsyncQueue<number>();
    q.close();

    const results: number[] = [];
    for await (const item of q) {
      results.push(item);
    }
    expect(results).toEqual([]);
  });

  it("drains remaining buffer items even after close", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();

    const results: number[] = [];
    for await (const item of q) {
      results.push(item);
    }
    expect(results).toEqual([1, 2]);
  });

  // ---- push after close ----

  it("push() after close() throws an error", () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).toThrow("Queue is closed");
  });

  // ---- isClosed getter ----

  it("isClosed reflects queue state", () => {
    const q = new AsyncQueue<number>();
    expect(q.isClosed).toBe(false);
    q.close();
    expect(q.isClosed).toBe(true);
  });

  // ---- Multiple sequential push/yield ----

  it("handles many sequential push-then-consume cycles", async () => {
    const q = new AsyncQueue<number>();

    const collected: number[] = [];
    const done = (async () => {
      for await (const item of q) {
        collected.push(item);
      }
    })();

    for (let i = 0; i < 100; i++) {
      q.push(i);
    }
    await tick();

    q.close();
    await done;

    expect(collected).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  // ---- Generic type support ----

  it("works with complex object types", async () => {
    interface Event {
      type: string;
      payload: Record<string, unknown>;
    }

    const q = new AsyncQueue<Event>();
    q.push({ type: "text", payload: { content: "hello" } });
    q.push({ type: "tool", payload: { name: "Read" } });
    q.close();

    const results: Event[] = [];
    for await (const item of q) {
      results.push(item);
    }

    expect(results).toEqual([
      { type: "text", payload: { content: "hello" } },
      { type: "tool", payload: { name: "Read" } },
    ]);
  });

  // ---- Multiple iterators ----

  it("each iterator call creates an independent consumption stream", async () => {
    const q = new AsyncQueue<number>();

    // Get first iterator and consume first item
    const iter1 = q[Symbol.asyncIterator]();
    q.push(1);
    const r1 = await iter1.next();
    expect(r1).toEqual({ value: 1, done: false });

    // Push more and consume via same iterator
    q.push(2);
    const r2 = await iter1.next();
    expect(r2).toEqual({ value: 2, done: false });

    q.close();
    const r3 = await iter1.next();
    expect(r3.done).toBe(true);
  });

  // ---- Double close is safe ----

  it("calling close() multiple times is safe", () => {
    const q = new AsyncQueue<number>();
    q.close();
    // Should not throw
    q.close();
    expect(q.isClosed).toBe(true);
  });
});

/** Flush microtask queue to let async consumers process. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
