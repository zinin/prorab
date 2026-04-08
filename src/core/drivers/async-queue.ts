/**
 * A generic async queue that supports async iteration.
 *
 * Used for multi-turn conversation: producers push items (user messages,
 * chat events) and consumers read them via `for await...of`.
 *
 * Backpressure model: unbounded buffer — push never blocks.
 * If a consumer is already waiting, the item is delivered immediately.
 */
export class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  /** Add an item to the queue. Throws if the queue has been closed. */
  push(item: T): void {
    if (this.closed) throw new Error("Queue is closed");
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  /**
   * Close the queue. All waiting consumers receive `done: true`.
   * Subsequent `push()` calls will throw.
   */
  close(): void {
    this.closed = true;
    for (const resolve of this.waiters) {
      resolve({ value: undefined as T, done: true });
    }
    this.waiters = [];
  }

  /** Whether the queue has been closed. */
  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      } else if (this.closed) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>(
          (resolve) => this.waiters.push(resolve),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }
}
