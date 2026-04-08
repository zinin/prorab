// ui/src/stores/batchExpand.ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { BatchExpandOutcome } from "../../../src/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BatchExpandStoreState = "idle" | "active" | "stopping" | "completed";

export interface SlotState {
  slotIndex: number;
  taskId: number | null;
  phase: "complexity" | "expand" | "idle";
  messages: BatchExpandMessage[];
  contextUsage: { contextTokens: number; contextWindow: number; model: string } | null;
}

export interface TaskSummaryItem {
  taskId: number;
  taskTitle: string;
  complexityScore: number | null;
  recommendedSubtasks: number | null;
  subtaskCount: number | null;
  skipped: boolean;
  error: string | null;
  status: "queued" | "complexity" | "expand" | "done" | "skipped" | "error";
}

export interface BatchExpandMessage {
  id: string;
  type: "text" | "tool" | "tool_result" | "system_prompt" | "task_prompt" | "error" | "separator";
  content: string;
  slotIndex: number;
  toolName?: string;
}

export interface BatchExpandProgressData {
  completed: number;
  total: number;
  errors: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGES_PER_SLOT = 500;
const TRIM_TO = 250;

let msgCounter = 0;
function nextId(): string {
  return `be-${++msgCounter}`;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useBatchExpandStore = defineStore("batchExpand", () => {
  const state = ref<BatchExpandStoreState>("idle");
  const slots = ref<SlotState[]>([]);
  const summary = ref<TaskSummaryItem[]>([]);
  const progress = ref<BatchExpandProgressData>({ completed: 0, total: 0, errors: 0, skipped: 0 });
  const outcome = ref<BatchExpandOutcome | null>(null);
  const error = ref<string | null>(null);
  const reason = ref<string | null>(null);

  // Focus state
  const taskSlotMap = ref(new Map<number, number>());
  const pinnedTaskId = ref<number | null>(null);
  const autoFocusSlotIndex = ref(0);

  // Rehydration guard
  let _rehydrating = false;

  // -----------------------------------------------------------------------
  // Computed
  // -----------------------------------------------------------------------

  const isRunning = computed(() => state.value === "active" || state.value === "stopping");
  const isTerminal = computed(() => state.value === "completed");

  const effectiveSlotIndex = computed(() => {
    const maxIdx = Math.max(0, slots.value.length - 1);
    if (pinnedTaskId.value !== null) {
      const si = taskSlotMap.value.get(pinnedTaskId.value);
      if (si !== undefined && si <= maxIdx) return si;
      return -1; // pinned to task without slot data yet — show empty state
    }
    return Math.min(autoFocusSlotIndex.value, maxIdx);
  });

  const isPinned = computed(() => pinnedTaskId.value !== null);

  /** The taskId whose log is currently displayed (pinned or auto-focused). */
  const focusedTaskId = computed<number | null>(() => {
    if (pinnedTaskId.value !== null) {
      return pinnedTaskId.value;
    }
    const slot = slots.value[effectiveSlotIndex.value];
    return slot?.taskId ?? null;
  });

  const activeContextUsage = computed(() => {
    const slot = slots.value[effectiveSlotIndex.value];
    return slot?.contextUsage ?? null;
  });

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  async function start(opts: { agent: string; model?: string; variant?: string; verbosity?: string; userSettings?: boolean; applyHooks?: boolean }) {
    error.value = null;
    reason.value = null;

    try {
      const res = await fetch("/api/batch-expand", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });

      const data = await res.json();

      if (!res.ok) {
        error.value = data.error ?? "Failed to start batch expand";
        reason.value = data.reason ?? null;
        throw new Error(error.value!);
      }

      if (!data.started) {
        // no_eligible_tasks
        reason.value = data.reason;
        return data;
      }

      // Initialize state — only if WS batch_expand:started hasn't already done it.
      // Race: server broadcasts WS events before POST response returns,
      // so slots/summary may already be populated with messages.
      state.value = "active";
      outcome.value = null;
      pinnedTaskId.value = null;

      if (slots.value.length === 0) {
        taskSlotMap.value = new Map();
        autoFocusSlotIndex.value = 0;
        progress.value = { completed: 0, total: data.taskIds.length, errors: 0, skipped: 0 };

        slots.value = Array.from({ length: data.slotCount }, (_, i) => ({
          slotIndex: i,
          taskId: null,
          phase: "idle" as const,
          messages: [],
          contextUsage: null,
        }));

        summary.value = data.taskIds.map((taskId: number) => ({
          taskId,
          taskTitle: `Task #${taskId}`,
          complexityScore: null,
          recommendedSubtasks: null,
          subtaskCount: null,
          skipped: false,
          error: null,
          status: "queued" as const,
        }));
      }

      return data;
    } catch (err) {
      if (err instanceof TypeError && err.message.includes("fetch")) {
        error.value = "Network error";
      }
      throw err;
    }
  }

  async function stop() {
    const prev = state.value;
    state.value = "stopping";
    try {
      const res = await fetch("/api/batch-expand", { method: "DELETE" });
      if (!res.ok) {
        state.value = prev;
      }
    } catch {
      state.value = prev;
    }
  }

  function pinToTask(taskId: number) {
    pinnedTaskId.value = taskId;
  }

  function unpinSlot() {
    pinnedTaskId.value = null;
  }

  function togglePinToTask(taskId: number) {
    if (pinnedTaskId.value === taskId) {
      pinnedTaskId.value = null;
    } else {
      pinnedTaskId.value = taskId;
    }
  }

  function handleWsEvent(data: Record<string, unknown>) {
    const type = data.type as string;

    // Agent events — route by slotIndex
    if (type.startsWith("agent:") && typeof data.slotIndex === "number") {
      const si = data.slotIndex as number;
      const slot = slots.value[si];
      if (!slot) return;

      // Auto-focus: update on every agent event (including context_usage)
      autoFocusSlotIndex.value = si;

      // Handle context_usage BEFORE the msg guard (it doesn't produce a msg)
      if (type === "agent:context_usage") {
        slot.contextUsage = {
          contextTokens: data.contextTokens as number,
          contextWindow: data.contextWindow as number,
          model: data.model as string,
        };
        return;
      }

      let msg: BatchExpandMessage | null = null;

      if (type === "agent:text") {
        // Streaming text aggregation
        const last = slot.messages[slot.messages.length - 1];
        if (last && last.type === "text") {
          last.content += (data.text as string) ?? "";
          return;
        }
        msg = { id: nextId(), type: "text", content: (data.text as string) ?? "", slotIndex: si };
      } else if (type === "agent:tool") {
        msg = { id: nextId(), type: "tool", content: (data.summary as string) ?? "", slotIndex: si, toolName: data.name as string };
      } else if (type === "agent:tool_result") {
        msg = { id: nextId(), type: "tool_result", content: (data.summary as string) ?? "", slotIndex: si };
      } else if (type === "agent:system_prompt") {
        msg = { id: nextId(), type: "system_prompt", content: (data.text as string) ?? "", slotIndex: si };
      } else if (type === "agent:task_prompt") {
        msg = { id: nextId(), type: "task_prompt", content: (data.text as string) ?? "", slotIndex: si };
      }

      if (!msg) return;

      slot.messages.push(msg);
      if (slot.messages.length > MAX_MESSAGES_PER_SLOT) {
        slot.messages = slot.messages.slice(-TRIM_TO);
      }
      return;
    }

    // Lifecycle events — block ALL batch_expand:* events during rehydration
    // (connected snapshot is newer than stale ring buffer events)
    if (_rehydrating && type.startsWith("batch_expand:")) return;

    switch (type) {
      case "batch_expand:started": {
        state.value = "active";
        // Initialize slots/summary if not yet created (race: WS event arrived before POST response)
        const startTaskIds = data.taskIds as number[] | undefined;
        const startSlotCount = data.slotCount as number | undefined;
        if (startTaskIds && startSlotCount && slots.value.length === 0) {
          slots.value = Array.from({ length: startSlotCount }, (_, i) => ({
            slotIndex: i,
            taskId: null,
            phase: "idle" as const,
            messages: [],
            contextUsage: null,
          }));
          summary.value = startTaskIds.map((taskId) => ({
            taskId,
            taskTitle: `Task #${taskId}`,
            complexityScore: null,
            recommendedSubtasks: null,
            subtaskCount: null,
            skipped: false,
            error: null,
            status: "queued" as const,
          }));
          progress.value = { completed: 0, total: startTaskIds.length, errors: 0, skipped: 0 };
          taskSlotMap.value = new Map();
          pinnedTaskId.value = null;
          autoFocusSlotIndex.value = 0;
        }
        // Update summary titles from taskTitles mapping
        const titles = data.taskTitles as Record<number, string> | undefined;
        if (titles) {
          for (const entry of summary.value) {
            if (titles[entry.taskId]) entry.taskTitle = titles[entry.taskId];
          }
        }
        break;
      }

      case "batch_expand:slot_started": {
        const si = data.slotIndex as number;
        const taskId = data.taskId as number;
        const phase = data.phase as "complexity" | "expand";
        const slot = slots.value[si];
        if (slot) {
          slot.taskId = taskId;
          slot.phase = phase;
          // Reset stale contextUsage from previous task on this slot
          slot.contextUsage = null;
          // Add separator
          slot.messages.push({
            id: nextId(),
            type: "separator",
            content: `── Task #${taskId} ${phase} ──`,
            slotIndex: si,
          });
        }
        // Track task→slot mapping for pin navigation
        taskSlotMap.value.set(taskId, si);
        // Update summary
        const entry = summary.value.find((s) => s.taskId === taskId);
        if (entry) entry.status = phase;
        break;
      }

      case "batch_expand:complexity_done": {
        const entry = summary.value.find((s) => s.taskId === (data.taskId as number));
        if (entry) {
          entry.complexityScore = data.score as number;
          entry.recommendedSubtasks = data.recommendedSubtasks as number;
        }
        break;
      }

      case "batch_expand:slot_finished": {
        const si = data.slotIndex as number;
        const slot = slots.value[si];
        if (slot) {
          slot.taskId = null;
          slot.phase = "idle";
        }
        const entry = summary.value.find((s) => s.taskId === (data.taskId as number));
        if (entry) {
          entry.subtaskCount = data.subtaskCount as number;
          entry.skipped = data.skipped as boolean;
          entry.status = data.skipped ? "skipped" : "done";
        }
        break;
      }

      case "batch_expand:progress":
        progress.value = {
          completed: data.completed as number,
          total: data.total as number,
          errors: data.errors as number,
          skipped: data.skipped as number,
        };
        break;

      case "batch_expand:error": {
        // Handle both task-level and batch-level errors
        if (data.taskId) {
          const entry = summary.value.find((s) => s.taskId === (data.taskId as number));
          if (entry) {
            entry.error = data.message as string;
            entry.status = "error";
          }
          // Reset slot to idle (server already freed it for next task)
          if (typeof data.slotIndex === "number") {
            const slot = slots.value[data.slotIndex];
            if (slot) {
              slot.taskId = null;
              slot.phase = "idle";
            }
          }
        } else {
          // Batch-level error (e.g., pool_crash) — terminal state, display in error banner
          error.value = data.message as string;
          reason.value = (data.reason as string) ?? null;
          state.value = "completed";
        }
        break;
      }

      case "batch_expand:finished":
        outcome.value = data.outcome as BatchExpandOutcome;
        state.value = "completed";
        // Reset in-flight summary statuses so cards don't retain active styling
        for (const entry of summary.value) {
          if (entry.status === "complexity" || entry.status === "expand") {
            entry.status = "queued";
          }
        }
        break;
    }
  }

  function rehydrateFromConnected(connected: Record<string, unknown>) {
    const bState = connected.batchExpandState as Record<string, unknown> | null;
    if (!bState) {
      state.value = "idle";
      _rehydrating = true;
      return;
    }

    // Clear stale state from previous WS connection
    taskSlotMap.value = new Map();
    pinnedTaskId.value = null;
    autoFocusSlotIndex.value = 0;

    // Backend uses "finished", frontend uses "completed" — map here
    const serverState = bState.state as string;
    if (serverState === "active" || serverState === "stopping") {
      state.value = serverState === "stopping" ? "stopping" : "active";
      // Backend slots don't include messages array — initialize it
      slots.value = ((bState.slots as SlotState[]) ?? []).map((s) => ({
        ...s,
        messages: s.messages ?? [],
        contextUsage: s.contextUsage ?? null,
      }));
      summary.value = (bState.summary as TaskSummaryItem[]) ?? [];
      outcome.value = null;
    } else if (serverState === "finished") {
      state.value = "completed"; // "finished" → "completed" mapping
      slots.value = ((bState.slots as SlotState[]) ?? []).map((s) => ({
        ...s,
        messages: s.messages ?? [],
        contextUsage: s.contextUsage ?? null,
      }));
      summary.value = (bState.summary as TaskSummaryItem[]) ?? [];
      outcome.value = (bState.outcome as BatchExpandOutcome) ?? null;
    } else {
      state.value = "idle";
    }

    // Rebuild taskSlotMap: prefer server-provided map (survives slot.taskId=null after completion),
    // fall back to current slot taskIds for backward compat
    const serverMap = bState.taskSlotMap as Record<string, number> | undefined;
    if (serverMap) {
      for (const [k, v] of Object.entries(serverMap)) {
        taskSlotMap.value.set(Number(k), v);
      }
    } else {
      for (const s of slots.value) {
        if (s.taskId !== null) taskSlotMap.value.set(s.taskId, s.slotIndex);
      }
    }

    // Restore progress from server state, or recompute from summary
    const serverProgress = bState.progress as BatchExpandProgressData | undefined;
    if (serverProgress) {
      progress.value = serverProgress;
    } else if (summary.value.length > 0) {
      progress.value = {
        completed: summary.value.filter((s) => s.status === "done" || s.status === "skipped" || s.status === "error").length,
        total: summary.value.length,
        errors: summary.value.filter((s) => s.status === "error").length,
        skipped: summary.value.filter((s) => s.status === "skipped").length,
      };
    }
    _rehydrating = true;
  }

  function clearRehydrating() {
    _rehydrating = false;
  }

  /** Reset local state only (no server call). Used by connected handler. */
  function resetLocal() {
    state.value = "idle";
    slots.value = [];
    summary.value = [];
    progress.value = { completed: 0, total: 0, errors: 0, skipped: 0 };
    outcome.value = null;
    error.value = null;
    reason.value = null;
    taskSlotMap.value = new Map();
    pinnedTaskId.value = null;
    autoFocusSlotIndex.value = 0;
    _rehydrating = false;
  }

  /** Reset local state + tell server to clear finished state (Done button). */
  function clear() {
    resetLocal();
    fetch("/api/batch-expand/dismiss", { method: "POST" }).catch(() => {});
  }

  return {
    state,
    slots,
    summary,
    progress,
    outcome,
    effectiveSlotIndex,
    isPinned,
    focusedTaskId,
    activeContextUsage,
    error,
    reason,
    isRunning,
    isTerminal,
    start,
    stop,
    pinToTask,
    unpinSlot,
    togglePinToTask,
    handleWsEvent,
    rehydrateFromConnected,
    clearRehydrating,
    resetLocal,
    clear,
  };
});
