import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useBatchExpandStore } from "../../ui/src/stores/batchExpand";

function makeStore() {
  return useBatchExpandStore();
}

/** Simulate store after a successful start with 2 slots and 2 tasks */
function seedStore(store: ReturnType<typeof makeStore>) {
  // Manually set state as if start() succeeded
  store.state = "active";
  store.slots = [
    { slotIndex: 0, taskId: null, phase: "idle", messages: [], contextUsage: null },
    { slotIndex: 1, taskId: null, phase: "idle", messages: [], contextUsage: null },
  ];
  store.summary = [
    { taskId: 6, taskTitle: "Task #6", complexityScore: null, recommendedSubtasks: null, subtaskCount: null, skipped: false, error: null, status: "queued" },
    { taskId: 7, taskTitle: "Task #7", complexityScore: null, recommendedSubtasks: null, subtaskCount: null, skipped: false, error: null, status: "queued" },
  ];
  store.progress = { completed: 0, total: 2, errors: 0, skipped: 0 };
}

describe("batchExpand store — context usage per slot", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("stores context_usage on the correct slot", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({
      type: "agent:context_usage",
      slotIndex: 0,
      channel: "batch-expand",
      contextTokens: 45000,
      contextWindow: 200000,
      model: "claude-sonnet-4-20250514",
    });

    expect(store.slots[0].contextUsage).toEqual({
      contextTokens: 45000,
      contextWindow: 200000,
      model: "claude-sonnet-4-20250514",
    });
    expect(store.slots[1].contextUsage).toBeNull();
  });

  it("activeContextUsage returns usage from effective slot", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({
      type: "agent:context_usage",
      slotIndex: 1,
      channel: "batch-expand",
      contextTokens: 10000,
      contextWindow: 200000,
      model: "claude-sonnet-4-20250514",
    });

    // Trigger auto-focus by sending an agent event to slot 1
    store.handleWsEvent({ type: "agent:text", slotIndex: 1, text: "hello" });

    expect(store.activeContextUsage).toEqual({
      contextTokens: 10000,
      contextWindow: 200000,
      model: "claude-sonnet-4-20250514",
    });
  });
});

describe("batchExpand store — auto-focus and pinning", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("effectiveSlotIndex follows last active slot (auto-focus)", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({ type: "agent:text", slotIndex: 0, text: "a" });
    expect(store.effectiveSlotIndex).toBe(0);

    store.handleWsEvent({ type: "agent:text", slotIndex: 1, text: "b" });
    expect(store.effectiveSlotIndex).toBe(1);
  });

  it("pinToTask locks focus to the slot processing that task", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 0, taskId: 6, phase: "complexity" });
    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 1, taskId: 7, phase: "complexity" });

    store.handleWsEvent({ type: "agent:text", slotIndex: 1, text: "x" });
    expect(store.effectiveSlotIndex).toBe(1);

    store.pinToTask(6);
    expect(store.effectiveSlotIndex).toBe(0);
    expect(store.isPinned).toBe(true);

    store.handleWsEvent({ type: "agent:text", slotIndex: 1, text: "y" });
    expect(store.effectiveSlotIndex).toBe(0);
  });

  it("unpinSlot resumes auto-focus", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 0, taskId: 6, phase: "complexity" });
    store.handleWsEvent({ type: "agent:text", slotIndex: 0, text: "a" });

    store.pinToTask(6);
    expect(store.isPinned).toBe(true);

    store.unpinSlot();
    expect(store.isPinned).toBe(false);

    store.handleWsEvent({ type: "agent:text", slotIndex: 1, text: "b" });
    expect(store.effectiveSlotIndex).toBe(1);
  });

  it("taskSlotMap persists after slot finishes (for history navigation)", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 0, taskId: 6, phase: "complexity" });
    store.handleWsEvent({ type: "batch_expand:slot_finished", slotIndex: 0, taskId: 6, subtaskCount: 3, skipped: false });

    store.pinToTask(6);
    expect(store.effectiveSlotIndex).toBe(0);
  });

  it("togglePinToTask pins on first click, unpins on second", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 0, taskId: 6, phase: "complexity" });
    store.handleWsEvent({ type: "agent:text", slotIndex: 0, text: "a" });

    store.togglePinToTask(6);
    expect(store.isPinned).toBe(true);

    store.togglePinToTask(6);
    expect(store.isPinned).toBe(false);
  });

  it("togglePinToTask switches between tasks", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 0, taskId: 6, phase: "complexity" });
    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 1, taskId: 7, phase: "complexity" });

    store.togglePinToTask(6);
    expect(store.effectiveSlotIndex).toBe(0);

    store.togglePinToTask(7);
    expect(store.effectiveSlotIndex).toBe(1);
  });

  it("clear() resets all focus state", () => {
    const store = makeStore();
    seedStore(store);

    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 0, taskId: 6, phase: "complexity" });
    store.pinToTask(6);

    store.clear();
    expect(store.isPinned).toBe(false);
    expect(store.effectiveSlotIndex).toBe(0);
    expect(store.activeContextUsage).toBeNull();
  });

  it("effectiveSlotIndex clamped when slots empty", () => {
    const store = makeStore();
    seedStore(store);
    store.slots = [];
    expect(store.effectiveSlotIndex).toBe(0);
  });

  it("effectiveSlotIndex clamped when autoFocusSlotIndex exceeds slots length", () => {
    const store = makeStore();
    seedStore(store);
    // Send events to many slots to push autoFocusSlotIndex high
    store.handleWsEvent({ type: "agent:text", slotIndex: 1, text: "x" });
    // Now reduce slots to just 1
    store.slots = [{ slotIndex: 0, taskId: null, phase: "idle", messages: [], contextUsage: null }];
    expect(store.effectiveSlotIndex).toBe(0);
  });

  it("togglePinToTask allows pinning to queued tasks without mapping", () => {
    const store = makeStore();
    seedStore(store);
    // Task 6 is queued — no slot_started, no mapping
    store.togglePinToTask(6);
    expect(store.isPinned).toBe(true);
    expect(store.focusedTaskId).toBe(6);
    // effectiveSlotIndex returns -1 (no slot data yet)
    expect(store.effectiveSlotIndex).toBe(-1);
  });

  it("contextUsage resets on slot_started", () => {
    const store = makeStore();
    seedStore(store);

    // Set context usage on slot 0
    store.handleWsEvent({
      type: "agent:context_usage", slotIndex: 0, channel: "batch-expand",
      contextTokens: 50000, contextWindow: 200000, model: "claude-sonnet-4-20250514",
    });
    expect(store.slots[0].contextUsage).not.toBeNull();

    // Start new task on slot 0 — should reset contextUsage
    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 0, taskId: 6, phase: "complexity" });
    expect(store.slots[0].contextUsage).toBeNull();
  });

  it("rehydrateFromConnected rebuilds taskSlotMap", () => {
    const store = makeStore();
    seedStore(store);

    // Set up some state
    store.handleWsEvent({ type: "batch_expand:slot_started", slotIndex: 0, taskId: 6, phase: "complexity" });
    store.pinToTask(6);

    // Simulate reconnect
    store.rehydrateFromConnected({
      batchExpandState: {
        state: "active",
        slots: [
          { slotIndex: 0, taskId: 6, phase: "expand", messages: [] },
          { slotIndex: 1, taskId: 7, phase: "complexity", messages: [] },
        ],
        summary: store.summary,
      },
    });

    // Pin should be cleared, taskSlotMap rebuilt
    expect(store.isPinned).toBe(false);
    // But pinning to task 6 should work (mapping rebuilt)
    store.pinToTask(6);
    expect(store.effectiveSlotIndex).toBe(0);
    expect(store.isPinned).toBe(true);
  });
});
