import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { applyConnectedExpandState } from "../composables/expand-state-mapping";

// --- Expand message types ---

/**
 * Expand message stored in the local buffer.
 *
 * Batch-mode only — no user/question/question_answer types.
 * The `type` field reuses the same semantic names as the execution store's
 * AgentEvent (`text`, `tool`, `tool_result`, `system_prompt`, `task_prompt`).
 * Additional expand-specific type: `error`.
 */
export interface ExpandMessage {
  id: string;
  type:
    | "text"
    | "tool"
    | "tool_result"
    | "context_usage"
    | "system_prompt"
    | "task_prompt"
    | "error";
  content: string;
  timestamp: number;
  /** Tool name — present when type is "tool" or "tool_result" */
  toolName?: string;
}

/** Lifecycle state of the expand session */
export type ExpandStoreState = "idle" | "active" | "stopping" | "completed";

/** Info about the active expand session */
export interface ExpandSessionInfo {
  sessionId: string;
  taskId: string;
  agent: string;
  model?: string;
  variant?: string;
}

/**
 * Terminal outcome for the expand operation.
 *
 * Structurally mirrors server-side `ExpandManagerOutcome` from `src/types.ts`
 * (three statuses: success / failure / cancelled).
 *
 * Unlike ParsePrdOutcome, expand outcomes always carry `taskId` and `subtaskCount`.
 */
export type ExpandOutcome =
  | { status: "success"; taskId: string; subtaskCount: number }
  | { status: "failure"; taskId: string; reason: string; errors: string[]; message: string; subtaskCount: number }
  | { status: "cancelled"; taskId: string; subtaskCount: number };

// --- WebSocket event types (mirrors server-side ExpandWsEvent + LogEvent from src/types.ts) ---

/** agent:* events routed through the expand channel */
type AgentTextEvent = { type: "agent:text"; channel?: string; text: string };
type AgentToolEvent = { type: "agent:tool"; channel?: string; name: string; summary: string; input?: Record<string, unknown> };
type AgentToolResultEvent = { type: "agent:tool_result"; channel?: string; summary: string; output?: string };
type AgentContextUsageEvent = { type: "agent:context_usage"; channel?: string; contextTokens: number; contextWindow: number; model: string };
type AgentSystemPromptEvent = { type: "agent:system_prompt"; channel?: string; text: string };
type AgentTaskPromptEvent = { type: "agent:task_prompt"; channel?: string; text: string };

/** expand:* lifecycle events */
type ExpandStartedEvent = { type: "expand:started"; channel?: string; sessionId?: string; taskId?: string; agent?: string; model?: string; variant?: string };
type ExpandErrorEvent = { type: "expand:error"; channel?: string; message: string; reason?: string };
type ExpandFinishedEvent = { type: "expand:finished"; channel?: string; outcome: ExpandOutcome };

/** Union of all events handleWsEvent can process */
export type ExpandWsEvent =
  | AgentTextEvent
  | AgentToolEvent
  | AgentToolResultEvent
  | AgentContextUsageEvent
  | AgentSystemPromptEvent
  | AgentTaskPromptEvent
  | ExpandStartedEvent
  | ExpandErrorEvent
  | ExpandFinishedEvent;

// --- Constants ---

const MAX_MESSAGES = 1000;
const TRIM_TO = 500;

// --- Store ---

export const useExpandStore = defineStore("expand", () => {
  const state = ref<ExpandStoreState>("idle");
  const messages = ref<ExpandMessage[]>([]);
  const sessionInfo = ref<ExpandSessionInfo | null>(null);
  const error = ref<string | null>(null);
  const outcome = ref<ExpandOutcome | null>(null);
  /** Machine-readable reason from the last 409 response (e.g. "task_not_pending", "active_session"). */
  const reason = ref<string | null>(null);
  /** Latest context window usage — updated on each agent:context_usage event. */
  const contextUsage = ref<{ contextTokens: number; contextWindow: number; model: string } | null>(null);

  // --- Computed ---

  const lastMessage = computed(() => messages.value.length > 0 ? messages.value[messages.value.length - 1] : null);
  const hasSession = computed(() => state.value !== "idle");
  /** True when expand is actively running (agent phase or stopping). Not true for terminal `completed` state. */
  const isRunning = computed(() => state.value === "active" || state.value === "stopping");
  const isTerminal = computed(() => state.value === "completed");
  const isActive = computed(() => state.value === "active");
  const isStopping = computed(() => state.value === "stopping");
  const isCompleted = computed(() => state.value === "completed");
  const hasOutcome = computed(() => outcome.value !== null);
  /**
   * True when the outcome resulted in subtasks being written to the file.
   *
   * Covers two cases:
   * - `success` with `subtaskCount > 0` — subtasks written and committed.
   * - `failure` with `reason === "commit_failed_after_write"` — subtasks written
   *   but git commit failed; the file still changed on disk.
   */
  const isFileWritingOutcome = computed(() => {
    const o = outcome.value;
    if (!o) return false;
    if (o.status === "success" && o.subtaskCount > 0) return true;
    if (o.status === "failure" && o.reason === "commit_failed_after_write") return true;
    return false;
  });

  // --- Internal helpers ---

  let messageCounter = 0;
  /** Tracks whether the previous WS event was agent:text — used for streaming aggregation. */
  let lastEventWasText = false;
  /**
   * When true, lifecycle events (expand:started, expand:finished) skip state mutations.
   * Set during WS reconnect to prevent ring-buffer replay from overwriting
   * the authoritative server snapshot. Messages are still added normally.
   */
  let _rehydrating = false;

  function nextMessageId(): string {
    return `exp-${Date.now()}-${++messageCounter}`;
  }

  function addMessage(msg: ExpandMessage) {
    messages.value.push(msg);
    if (messages.value.length > MAX_MESSAGES) {
      messages.value = messages.value.slice(-TRIM_TO);
    }
  }

  // --- Convenience getter ---

  /** Returns true if the store belongs to the given taskId (active session or terminal outcome). */
  function belongsToTask(taskId: string): boolean {
    if (sessionInfo.value && sessionInfo.value.taskId === taskId) return true;
    if (outcome.value && outcome.value.taskId === taskId) return true;
    return false;
  }

  // --- Actions ---

  async function start(taskId: string, opts: {
    agent: string;
    model?: string;
    variant?: string;
    verbosity?: string;
    userSettings?: boolean;
    applyHooks?: boolean;
  }) {
    // Clear previous state before starting
    messages.value = [];
    error.value = null;
    outcome.value = null;
    reason.value = null;
    contextUsage.value = null;
    messageCounter = 0;
    lastEventWasText = false;

    try {
      const res = await fetch(`/api/tasks/${taskId}/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || `HTTP ${res.status}`;
        reason.value = data.reason ?? null;
        throw new Error(error.value!);
      }
    } catch (err) {
      // If error.value wasn't set by the !res.ok branch, it's a network/CORS/abort error
      if (!error.value) {
        error.value = err instanceof Error ? err.message : "Network error";
      }
      throw err;
    }

    sessionInfo.value = {
      sessionId: "",
      taskId,
      agent: opts.agent,
      model: opts.model,
      variant: opts.variant,
    };
    state.value = "active";
  }

  async function stop(taskId: string) {
    const prevState = state.value;
    state.value = "stopping";

    try {
      const res = await fetch(`/api/tasks/${taskId}/expand`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || "Failed to stop expand";
        reason.value = data.reason ?? null;
        throw new Error(error.value!);
      }
    } catch (err) {
      // Restore previous state on any error (network/CORS/abort or HTTP error re-thrown above)
      state.value = prevState;
      // If error.value wasn't set by the !res.ok branch, it's a network/CORS/abort error
      if (!error.value) {
        error.value = err instanceof Error ? err.message : "Network error";
      }
      throw err;
    }
  }

  /**
   * Handle incoming WebSocket events for the expand channel.
   *
   * Accepts both `agent:*` events (with `channel: "expand"`) and `expand:*` events.
   * Strips the transport envelope and stores canonical message types.
   */
  function handleWsEvent(event: ExpandWsEvent) {
    const type = event.type;

    // Only process agent:* events that belong to the expand channel.
    if (type.startsWith("agent:") && event.channel !== "expand") {
      return;
    }

    // Reset aggregation flag before processing — only agent:text sets it back to true
    const wasText = lastEventWasText;
    lastEventWasText = false;

    switch (type) {
      // --- agent:* events (with channel="expand") ---
      case "agent:text": {
        // Streaming aggregation: append to the last text message when the
        // previous WS event was also agent:text (consecutive streaming chunks).
        const last = messages.value.length > 0 ? messages.value[messages.value.length - 1] : null;
        if (wasText && last && last.type === "text") {
          last.content += event.text ?? "";
          last.timestamp = Date.now();
        } else {
          addMessage({
            id: nextMessageId(),
            type: "text",
            content: event.text ?? "",
            timestamp: Date.now(),
          });
        }
        lastEventWasText = true;
        break;
      }

      case "agent:tool":
        addMessage({
          id: nextMessageId(),
          type: "tool",
          content: event.input ? JSON.stringify(event.input, null, 2) : event.summary ?? "",
          timestamp: Date.now(),
          toolName: event.name,
        });
        break;

      case "agent:tool_result":
        addMessage({
          id: nextMessageId(),
          type: "tool_result",
          content: event.output ?? event.summary ?? "",
          timestamp: Date.now(),
        });
        break;

      case "agent:context_usage":
        contextUsage.value = {
          contextTokens: event.contextTokens,
          contextWindow: event.contextWindow,
          model: event.model,
        };
        addMessage({
          id: nextMessageId(),
          type: "context_usage",
          content: JSON.stringify({
            contextTokens: event.contextTokens,
            contextWindow: event.contextWindow,
            model: event.model,
            agent: sessionInfo.value?.agent,
            variant: sessionInfo.value?.variant,
          }),
          timestamp: Date.now(),
        });
        break;

      case "agent:system_prompt":
        addMessage({
          id: nextMessageId(),
          type: "system_prompt",
          content: event.text ?? "",
          timestamp: Date.now(),
        });
        break;

      case "agent:task_prompt":
        addMessage({
          id: nextMessageId(),
          type: "task_prompt",
          content: event.text ?? "",
          timestamp: Date.now(),
        });
        break;

      // --- expand:* lifecycle events ---
      case "expand:started":
        if (!_rehydrating) {
          state.value = "active";
          // Only update sessionInfo outside rehydration — during rehydration the
          // authoritative connected snapshot must not be overwritten by stale
          // ring-buffer replay events (which may carry a different taskId/sessionId,
          // corrupting belongsToTask() results).
          if (event.agent) {
            sessionInfo.value = {
              sessionId: (event as ExpandStartedEvent).sessionId ?? sessionInfo.value?.sessionId ?? "",
              taskId: (event as ExpandStartedEvent).taskId ?? sessionInfo.value?.taskId ?? "",
              agent: event.agent,
              model: event.model ?? sessionInfo.value?.model,
              // Preserve variant from current sessionInfo when the event doesn't carry it
              variant: event.variant ?? sessionInfo.value?.variant,
            };
          }
        }
        break;

      case "expand:error":
        error.value = event.message ?? "Unknown expand error";
        addMessage({
          id: nextMessageId(),
          type: "error",
          content: error.value!,
          timestamp: Date.now(),
        });
        break;

      case "expand:finished":
        if (!_rehydrating) {
          state.value = "completed";
          outcome.value = event.outcome ?? null;
          sessionInfo.value = null;
        }
        // Preserve error.value — if an expand:error preceded this event, the user
        // should still see what went wrong. The error is cleared when a new session starts.
        break;
    }
  }

  function clearMessages() {
    messages.value = [];
    contextUsage.value = null;
    messageCounter = 0;
    lastEventWasText = false;
    // _rehydrating is managed by setRehydrating() and $reset() only.
  }

  /** Reset the entire expand state back to idle — messages, session, errors, outcome, everything. */
  function $reset() {
    state.value = "idle";
    messages.value = [];
    sessionInfo.value = null;
    error.value = null;
    outcome.value = null;
    reason.value = null;
    contextUsage.value = null;
    messageCounter = 0;
    lastEventWasText = false;
    _rehydrating = false;
  }

  /** Alias for $reset — resets the entire expand state back to idle. */
  function clearExpand() {
    $reset();
  }

  /**
   * Restore expand state from a WS `connected` payload.
   *
   * Delegates to `applyConnectedExpandState()` for the actual mapping,
   * keeping the store's public API self-contained so callers don't need
   * to import the mapping composable directly.
   *
   * Must be called after `clearMessages()` — the connected-message handler
   * in useWebSocket.ts clears message buffers before calling this action.
   */
  function rehydrateFromConnected(connected: Record<string, unknown>) {
    // The mapping function treats this store as an ExpandStateStore (minimal
    // writable interface), mutating state/sessionInfo/outcome and calling
    // setRehydrating().  All fields are reactive refs so Vue picks up changes.
    applyConnectedExpandState(
      {
        get state() { return state.value; },
        set state(v) { state.value = v; },
        get sessionInfo() { return sessionInfo.value; },
        set sessionInfo(v) { sessionInfo.value = v; },
        get outcome() { return outcome.value; },
        set outcome(v) { outcome.value = v; },
        setRehydrating(v: boolean) { _rehydrating = v; },
      },
      connected,
    );
  }

  return {
    // State
    state,
    messages,
    sessionInfo,
    error,
    outcome,
    reason,
    contextUsage,

    // Computed
    lastMessage,
    hasSession,
    isRunning,
    isTerminal,
    isActive,
    isStopping,
    isCompleted,
    hasOutcome,
    isFileWritingOutcome,

    // Methods
    belongsToTask,

    // Actions
    start,
    stop,
    handleWsEvent,
    rehydrateFromConnected,
    clearMessages,
    clearExpand,
    setRehydrating(v: boolean) { _rehydrating = v; },
    $reset,
  };
});
