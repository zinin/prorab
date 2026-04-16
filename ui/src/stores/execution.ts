import { defineStore } from "pinia";
import { ref, computed } from "vue";

interface AgentEvent {
  timestamp: number;
  type: "text" | "tool" | "tool_result" | "system_prompt" | "task_prompt";
  content: string;
  toolName?: string;
}

interface ModelEntry {
  id: string;
  name: string;
  variants?: string[];
}

interface CurrentUnit {
  id: string;
  title: string;
  taskId?: string;
  subtaskId?: string;
}

interface TaskContext {
  task: Record<string, unknown>;
  subtask: Record<string, unknown> | null;
}

export const useExecutionStore = defineStore("execution", () => {
  const state = ref<"idle" | "running" | "stopping">("idle");
  const currentUnit = ref<CurrentUnit | null>(null);
  const events = ref<AgentEvent[]>([]);
  const models = ref<ModelEntry[]>([]);
  const modelsLoading = ref(false);
  const modelsError = ref<string | null>(null);
  const error = ref<string | null>(null);
  const taskContext = ref<TaskContext | null>(null);
  const taskContextLoading = ref(false);
  const contextUsageByUnit = ref<Record<string, { contextTokens: number; contextWindow: number; model: string }>>({});
  const turnUsageByUnit = ref<Record<string, { numTurns: number; maxTurns: number; model: string }>>({});

  // Per-reviewer state for multi-review tabs
  const reviewerTabs = ref<string[]>([]);
  const reviewerEvents = ref<Record<string, AgentEvent[]>>({});
  const activeReviewerTab = ref<string | null>(null);
  const reviewerStatuses = ref<Record<string, string>>({});
  const reviewRoundInfo = ref<{ round: number; total: number } | null>(null);
  const iterationCurrent = ref<number | null>(null);
  const iterationTotal = ref<number | null>(null);
  const gracefulStop = ref(false);

  const contextUsage = computed(() => {
    const unit = currentUnit.value;
    if (!unit) return null;
    // If viewing a reviewer tab, show that reviewer's context usage
    if (activeReviewerTab.value) {
      return contextUsageByUnit.value[`${unit.id}:${activeReviewerTab.value}`] ?? null;
    }
    return contextUsageByUnit.value[unit.id] ?? null;
  });

  const turnUsage = computed(() => {
    const unit = currentUnit.value;
    if (!unit) return null;
    if (activeReviewerTab.value) {
      return turnUsageByUnit.value[`${unit.id}:${activeReviewerTab.value}`] ?? null;
    }
    return turnUsageByUnit.value[unit.id] ?? null;
  });
  let fetchAbort: AbortController | null = null;

  async function startExecution(options: {
    agent?: string;
    model?: string;
    variant?: string;
    review?: boolean;
    reviewers?: Array<{ agent: string; model?: string; variant?: string }>;
    reviewRounds?: number;
    reviewContext?: boolean;
    maxRetries?: number;
    maxTurns?: number;
    reviewMaxTurns?: number;
    maxIterations?: number | null;
    debug?: boolean;
    trace?: boolean;
    quiet?: boolean;
    allowDirty?: boolean;
    userSettings?: boolean;
    applyHooks?: boolean;
  }) {
    // Clear state BEFORE fetch to avoid race with fire-and-forget server execution:
    // server starts execution immediately (no await), so WS events (prompts, execution:started)
    // can arrive before the HTTP response — clearing after fetch would discard them.
    events.value = [];
    error.value = null;
    taskContext.value = null;
    contextUsageByUnit.value = {};
    turnUsageByUnit.value = {};
    reviewRoundInfo.value = null;
    iterationCurrent.value = null;
    iterationTotal.value = null;
    gracefulStop.value = false;

    // Strip null values — Zod expects undefined, not null
    const sanitized = Object.fromEntries(
      Object.entries(options).filter(([, v]) => v !== null && v !== undefined && v !== ""),
    );
    const res = await fetch("/api/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sanitized),
    });
    if (!res.ok) {
      const data = await res.json();
      error.value = data.error;
      throw new Error(data.error);
    }
    // Only set running if WS hasn't already moved to a later state (e.g. idle after instant completion)
    if (state.value === "idle") {
      state.value = "running";
    }
  }

  async function fetchModels(agent: string) {
    // Cancel any in-flight request (race condition on fast agent switching)
    fetchAbort?.abort();
    const controller = new AbortController();
    fetchAbort = controller;

    modelsLoading.value = true;
    modelsError.value = null;
    models.value = [];
    try {
      const res = await fetch(`/api/models?agent=${encodeURIComponent(agent)}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      models.value = data.models;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return; // superseded
      modelsError.value = err instanceof Error ? err.message : String(err);
    } finally {
      if (fetchAbort === controller) {
        modelsLoading.value = false;
      }
    }
  }

  async function stopExecution() {
    const res = await fetch("/api/execute", { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Failed to stop execution");
    }
    state.value = "stopping";
  }

  function addEvent(event: AgentEvent) {
    events.value.push(event);
    // Keep buffer at max 1000 events
    if (events.value.length > 1000) {
      events.value = events.value.slice(-500);
    }
  }

  function clearEvents() {
    events.value = [];
  }

  async function fetchTaskContext(rawTaskId: string, subtaskId?: string) {
    if (!rawTaskId) return;
    // Handle composite IDs like "7.3" — split into taskId "7" and subtaskId "3"
    let taskId = rawTaskId;
    if (rawTaskId.includes(".")) {
      const parts = rawTaskId.split(".");
      taskId = parts[0];
      if (!subtaskId) subtaskId = parts[1];
    }
    taskContextLoading.value = true;
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`);
      if (!res.ok) return;
      const data = await res.json();
      const task = data.task;
      if (!task) return;
      let subtask = null;
      if (subtaskId && task.subtasks) {
        subtask = task.subtasks.find(
          (s: Record<string, unknown>) => String(s.id) === String(subtaskId),
        ) ?? null;
      }
      taskContext.value = { task, subtask };
    } catch {
      // Silently ignore — sidebar just won't show
    } finally {
      taskContextLoading.value = false;
    }
  }

  function updateContextUsage(data: { contextTokens: number; contextWindow: number; model: string; unitId: string; reviewerId?: string }) {
    const key = data.reviewerId ? `${data.unitId}:${data.reviewerId}` : data.unitId;
    contextUsageByUnit.value[key] = {
      contextTokens: data.contextTokens,
      contextWindow: data.contextWindow,
      model: data.model,
    };
  }

  function updateTurnUsage(data: { numTurns: number; maxTurns: number; model: string; unitId: string; reviewerId?: string }) {
    const key = data.reviewerId ? `${data.unitId}:${data.reviewerId}` : data.unitId;
    turnUsageByUnit.value[key] = {
      numTurns: data.numTurns,
      maxTurns: data.maxTurns,
      model: data.model,
    };
  }

  function clearTurnUsage(scope?: { unitId?: string; reviewerId?: string }) {
    if (!scope) {
      turnUsageByUnit.value = {};
      return;
    }
    if (scope.unitId && scope.reviewerId) {
      delete turnUsageByUnit.value[`${scope.unitId}:${scope.reviewerId}`];
    } else if (scope.unitId) {
      delete turnUsageByUnit.value[scope.unitId];
      for (const key of Object.keys(turnUsageByUnit.value)) {
        if (key.startsWith(`${scope.unitId}:`)) delete turnUsageByUnit.value[key];
      }
    }
  }

  function clearTaskContext() {
    taskContext.value = null;
  }

  function startMultiReview(reviewerIds: string[]) {
    reviewerTabs.value = reviewerIds;
    reviewerEvents.value = Object.fromEntries(reviewerIds.map(id => [id, []]));
    reviewerStatuses.value = {};
    activeReviewerTab.value = reviewerIds[0] ?? null;
  }

  function addReviewerEvent(reviewerId: string, event: AgentEvent) {
    // Fallback tab creation: if unknown reviewerId arrives, create tab automatically
    if (!reviewerEvents.value[reviewerId]) {
      reviewerEvents.value[reviewerId] = [];
      if (!reviewerTabs.value.includes(reviewerId)) {
        reviewerTabs.value = [...reviewerTabs.value, reviewerId];
      }
    }
    reviewerEvents.value[reviewerId].push(event);
    // Cap per-reviewer buffer at 500 events
    if (reviewerEvents.value[reviewerId].length > 500) {
      reviewerEvents.value[reviewerId] = reviewerEvents.value[reviewerId].slice(-250);
    }
  }

  function addAggregatorTab() {
    if (!reviewerTabs.value.includes("aggregator")) {
      reviewerTabs.value = [...reviewerTabs.value, "aggregator"];
      reviewerEvents.value["aggregator"] = [];
      activeReviewerTab.value = "aggregator";
    }
  }

  function closeReviewerTab(tabId: string) {
    reviewerTabs.value = reviewerTabs.value.filter(id => id !== tabId);
    if (activeReviewerTab.value === tabId) {
      activeReviewerTab.value = reviewerTabs.value[0] ?? null;
    }
    delete reviewerEvents.value[tabId];
    delete reviewerStatuses.value[tabId];
  }

  function clearReviewerTabs() {
    reviewerTabs.value = [];
    reviewerEvents.value = {};
    activeReviewerTab.value = null;
    reviewerStatuses.value = {};
  }

  function setReviewerStatus(reviewerId: string, status: string) {
    reviewerStatuses.value = { ...reviewerStatuses.value, [reviewerId]: status };
  }

  function setReviewRoundInfo(round: number, total: number) {
    reviewRoundInfo.value = { round, total };
  }

  function setIterationInfo(current: number, total: number | null) {
    iterationCurrent.value = current;
    iterationTotal.value = total;
  }

  function clearIterationInfo() {
    iterationCurrent.value = null;
    iterationTotal.value = null;
  }

  async function requestGracefulStop() {
    gracefulStop.value = true;
    const res = await fetch("/api/execute/graceful-stop", { method: "POST" });
    if (!res.ok) {
      gracefulStop.value = false;
      const data = await res.json();
      throw new Error(data.error || "Failed to request graceful stop");
    }
  }

  async function cancelGracefulStop() {
    gracefulStop.value = false;
    const res = await fetch("/api/execute/graceful-stop", { method: "DELETE" });
    if (!res.ok) {
      gracefulStop.value = true;
      const data = await res.json();
      throw new Error(data.error || "Failed to cancel graceful stop");
    }
  }

  return {
    state, currentUnit, events, error, models, modelsLoading, modelsError,
    taskContext, taskContextLoading, contextUsage, contextUsageByUnit,
    turnUsage, turnUsageByUnit,
    reviewerTabs, reviewerEvents, activeReviewerTab, reviewerStatuses, reviewRoundInfo,
    iterationCurrent, iterationTotal, gracefulStop,
    startExecution, stopExecution, addEvent, clearEvents, fetchModels,
    fetchTaskContext, clearTaskContext, updateContextUsage,
    updateTurnUsage, clearTurnUsage,
    startMultiReview, addReviewerEvent, addAggregatorTab, closeReviewerTab, clearReviewerTabs, setReviewerStatus, setReviewRoundInfo,
    setIterationInfo, clearIterationInfo, requestGracefulStop, cancelGracefulStop,
  };
});
