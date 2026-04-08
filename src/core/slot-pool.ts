export interface SlotPoolOptions<T, R = void> {
  items: T[];
  concurrency: number;
  worker: (item: T, slotIndex: number, signal: AbortSignal) => Promise<R>;
  onSlotStart?: (slotIndex: number, item: T) => void;
  onSlotFinish?: (slotIndex: number, item: T, result: R) => void;
}

/**
 * Generic async worker pool with fixed concurrency and stable slot indices.
 *
 * Each concurrent worker gets a `slotIndex` (0..concurrency-1) that persists
 * across items — when a worker finishes an item, the next queued item inherits
 * that slot index. This enables UIs to bind tabs to slot indices.
 *
 * `abort()` cancels all in-flight workers via AbortSignal and skips remaining items.
 * Errors in individual workers are caught — the slot is freed and the next item proceeds.
 * `run()` returns results in input order; failed items have `undefined` at their index.
 */
export class SlotPool<T, R = void> {
  private readonly opts: SlotPoolOptions<T, R>;
  private abortController: AbortController | null = null;
  private _running = false;

  constructor(opts: SlotPoolOptions<T, R>) {
    this.opts = opts;
  }

  async run(): Promise<(R | undefined)[]> {
    if (this._running) throw new Error("SlotPool is already running");
    if (this.opts.concurrency < 1) throw new Error("SlotPool concurrency must be >= 1");
    this._running = true;
    this.abortController = new AbortController();

    try {
      const { items, concurrency, worker, onSlotStart, onSlotFinish } = this.opts;
      if (items.length === 0) return [];

      const results = new Array<R | undefined>(items.length);
      const effectiveConcurrency = Math.min(concurrency, items.length);
      let nextIndex = 0;

      const runSlot = async (slotIndex: number): Promise<void> => {
        while (nextIndex < items.length) {
          if (this.abortController!.signal.aborted) break;

          const itemIndex = nextIndex++;
          const item = items[itemIndex];

          // Re-check abort after acquiring item index
          if (this.abortController!.signal.aborted) break;

          onSlotStart?.(slotIndex, item);

          try {
            const result = await worker(item, slotIndex, this.abortController!.signal);
            results[itemIndex] = result;
            onSlotFinish?.(slotIndex, item, result);
          } catch {
            // Error in worker — item gets undefined, slot continues
            results[itemIndex] = undefined;
          }
        }
      };

      const slotPromises = Array.from({ length: effectiveConcurrency }, (_, i) => runSlot(i));
      await Promise.all(slotPromises);

      return results;
    } finally {
      this._running = false;
      this.abortController = null;
    }
  }

  abort(): void {
    this.abortController?.abort();
  }
}
