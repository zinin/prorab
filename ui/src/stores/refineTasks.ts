import { defineStore } from "pinia";
import { ref, computed } from "vue";

// --- Refine-Tasks message types ---

/**
 * Refine-Tasks message stored in the local buffer.
 *
 * Multi-step agent session with question support.
 * The `type` field reuses the same semantic names as the execution store's
 * AgentEvent (`text`, `tool`, `tool_result`, `system_prompt`, `task_prompt`).
 * Additional refine-tasks-specific types: `error`, `question`.
 */
export interface RefineTasksMessage {
  id: string;
  type:
    | "text"
    | "tool"
    | "tool_result"
    | "context_usage"
    | "system_prompt"
    | "task_prompt"
    | "error"
    | "question";
  content: string;
  timestamp: number;
  /** Tool name — present when type is "tool" or "tool_result" */
  toolName?: string;
}

/** Lifecycle state of the refine-tasks session */
export type RefineTasksStoreState = "idle" | "active" | "stopping" | "completed";

/** Info about the active refine-tasks session — includes step tracking */
export interface RefineTasksSessionInfo {
  steps: Array<{ agent: string; model?: string; variant?: string }>;
  currentStepIndex: number;
  stepState: "running" | "question_pending";
}

/**
 * Terminal outcome for the refine-tasks operation.
 *
 * Mirrors server-side RefineTasksManagerOutcome.
 */
export interface RefineTasksOutcome {
  status: "success" | "failure" | "cancelled";
  stepsCompleted?: number;
  stepIndex?: number;
  error?: string;
}

/** Pending question awaiting user reply */
export interface RefineTasksPendingQuestion {
  questionId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  source?: string;
}

// --- WebSocket event types (mirrors server-side RefineTasksWsEvent + LogEvent from src/types.ts) ---

/** agent:* events routed through the refine-tasks channel */
type AgentTextEvent = { type: "agent:text"; channel?: string; text: string };
type AgentReasoningEvent = { type: "agent:reasoning"; channel?: string; text: string };
type AgentToolEvent = { type: "agent:tool"; channel?: string; name: string; summary: string; input?: Record<string, unknown> };
type AgentToolResultEvent = { type: "agent:tool_result"; channel?: string; summary: string; output?: string };
type AgentContextUsageEvent = { type: "agent:context_usage"; channel?: string; contextTokens: number; contextWindow: number; model: string };
type AgentSystemPromptEvent = { type: "agent:system_prompt"; channel?: string; text: string };
type AgentTaskPromptEvent = { type: "agent:task_prompt"; channel?: string; text: string };

/** refine-tasks:* lifecycle events */
type RefineTasksStartedEvent = {
  type: "refine-tasks:started";
  channel?: string;
  steps?: Array<{ agent: string; model?: string; variant?: string }>;
  sessionId?: string;
};
type RefineTasksStepStartedEvent = {
  type: "refine-tasks:step_started";
  channel?: string;
  stepIndex: number;
  agent: string;
  model?: string;
  variant?: string;
};
type RefineTasksStepFinishedEvent = {
  type: "refine-tasks:step_finished";
  channel?: string;
  stepIndex: number;
};
type RefineTasksQuestionEvent = {
  type: "refine-tasks:question";
  channel?: string;
  questionId: string;
  questions: RefineTasksPendingQuestion["questions"];
  source?: string;
};
type RefineTasksErrorEvent = { type: "refine-tasks:error"; channel?: string; message: string };
type RefineTasksFinishedEvent = { type: "refine-tasks:finished"; channel?: string; outcome: RefineTasksOutcome };

/** Union of all events handleWsEvent can process */
export type RefineTasksWsEvent =
  | AgentTextEvent
  | AgentReasoningEvent
  | AgentToolEvent
  | AgentToolResultEvent
  | AgentContextUsageEvent
  | AgentSystemPromptEvent
  | AgentTaskPromptEvent
  | RefineTasksStartedEvent
  | RefineTasksStepStartedEvent
  | RefineTasksStepFinishedEvent
  | RefineTasksQuestionEvent
  | RefineTasksErrorEvent
  | RefineTasksFinishedEvent;

// --- Constants ---

const MAX_MESSAGES = 1000;
const TRIM_TO = 500;

// --- Store ---

export const useRefineTasksStore = defineStore("refineTasks", () => {
  const state = ref<RefineTasksStoreState>("idle");
  const messages = ref<RefineTasksMessage[]>([]);
  const sessionInfo = ref<RefineTasksSessionInfo | null>(null);
  const pendingQuestion = ref<RefineTasksPendingQuestion | null>(null);
  const error = ref<string | null>(null);
  const outcome = ref<RefineTasksOutcome | null>(null);
  /** Machine-readable reason from the last 409 response (e.g. "active_session"). */
  const reason = ref<string | null>(null);
  /** Latest context window usage — updated on each agent:context_usage event. */
  const contextUsage = ref<{ contextTokens: number; contextWindow: number; model: string } | null>(null);

  // --- Computed ---

  const lastMessage = computed(() => messages.value.length > 0 ? messages.value[messages.value.length - 1] : null);
  const hasSession = computed(() => state.value !== "idle");
  const isTerminal = computed(() => state.value === "completed");

  // --- Internal helpers ---

  let messageCounter = 0;
  /** Tracks whether the previous WS event was agent:text — used for streaming aggregation. */
  let lastEventWasText = false;
  /**
   * When true, lifecycle events (refine-tasks:started) skip state mutations.
   * Set during WS reconnect to prevent ring-buffer replay from overwriting
   * the authoritative server snapshot. Messages are still added normally.
   */
  let _rehydrating = false;

  function nextMessageId(): string {
    return `rtsk-${Date.now()}-${++messageCounter}`;
  }

  function addMessage(msg: RefineTasksMessage) {
    messages.value.push(msg);
    if (messages.value.length > MAX_MESSAGES) {
      messages.value = messages.value.slice(-TRIM_TO);
    }
  }

  // --- Actions ---

  async function start(opts: {
    steps: Array<{ agent: string; model?: string; variant?: string }>;
    verbosity?: string;
    responseLanguage?: string;
    userSettings?: boolean;
    applyHooks?: boolean;
  }) {
    // Clear previous state before starting
    messages.value = [];
    error.value = null;
    outcome.value = null;
    reason.value = null;
    pendingQuestion.value = null;
    contextUsage.value = null;
    messageCounter = 0;
    lastEventWasText = false;

    try {
      const res = await fetch("/api/refine-tasks", {
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

    state.value = "active";
  }

  async function stop() {
    const prevState = state.value;
    state.value = "stopping";

    try {
      const res = await fetch("/api/refine-tasks", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || "Failed to stop refine-tasks";
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

  async function replyToQuestion(questionId: string, answers?: Record<string, string | string[]>, message?: string) {
    if (!pendingQuestion.value) {
      throw new Error("No pending question to reply to");
    }
    const savedPendingQuestion = pendingQuestion.value;
    const savedStepState = sessionInfo.value?.stepState;

    pendingQuestion.value = null;
    if (sessionInfo.value) {
      sessionInfo.value.stepState = "running";
    }

    try {
      const res = await fetch("/api/refine-tasks/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, answers, message }),
      });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || "Failed to reply to question";
        // Restore question state so the user can retry
        pendingQuestion.value = savedPendingQuestion;
        if (sessionInfo.value && savedStepState) {
          sessionInfo.value.stepState = savedStepState;
        }
        throw new Error(error.value!);
      }
    } catch (err) {
      // Restore question state on any error
      pendingQuestion.value = savedPendingQuestion;
      if (sessionInfo.value && savedStepState) {
        sessionInfo.value.stepState = savedStepState;
      }
      if (!error.value) {
        error.value = err instanceof Error ? err.message : "Network error";
      }
      throw err;
    }
  }

  /**
   * Handle incoming WebSocket events for the refine-tasks channel.
   *
   * Accepts both `agent:*` events (with `channel: "refine-tasks"`) and `refine-tasks:*` events.
   * Strips the transport envelope and stores canonical message types.
   */
  function handleWsEvent(event: RefineTasksWsEvent) {
    const type = event.type;

    // Only process agent:* events that belong to the refine-tasks channel.
    if (type.startsWith("agent:") && event.channel !== "refine-tasks") {
      return;
    }

    // Reset aggregation flag before processing — only agent:text sets it back to true
    const wasText = lastEventWasText;
    lastEventWasText = false;

    switch (type) {
      // --- agent:* events (with channel="refine-tasks") ---
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

      case "agent:reasoning":
        addMessage({
          id: nextMessageId(),
          type: "text",
          content: `[reasoning] ${event.text ?? ""}`,
          timestamp: Date.now(),
        });
        break;

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

      // --- refine-tasks:* lifecycle events ---
      case "refine-tasks:started":
        if (!_rehydrating) {
          state.value = "active";
        }
        if (event.steps) {
          sessionInfo.value = {
            steps: event.steps,
            currentStepIndex: 0,
            stepState: "running",
          };
        }
        break;

      case "refine-tasks:step_started":
        if (sessionInfo.value) {
          sessionInfo.value.currentStepIndex = event.stepIndex;
          sessionInfo.value.stepState = "running";
        }
        // Add visual divider message for step transition
        addMessage({
          id: nextMessageId(),
          type: "text",
          content: `--- Step ${event.stepIndex + 1}: ${event.agent}${event.model ? ` + ${event.model}` : ""} ---`,
          timestamp: Date.now(),
        });
        break;

      case "refine-tasks:step_finished":
        // Informational only — no state changes needed
        break;

      case "refine-tasks:question":
        pendingQuestion.value = {
          questionId: event.questionId,
          questions: event.questions,
          source: event.source,
        };
        if (sessionInfo.value) {
          sessionInfo.value.stepState = "question_pending";
        }
        addMessage({
          id: nextMessageId(),
          type: "question",
          content: "",
          timestamp: Date.now(),
        });
        break;

      case "refine-tasks:error":
        error.value = event.message ?? "Unknown refine-tasks error";
        addMessage({
          id: nextMessageId(),
          type: "error",
          content: error.value!,
          timestamp: Date.now(),
        });
        break;

      case "refine-tasks:finished":
        if (!_rehydrating) {
          state.value = "completed";
          outcome.value = event.outcome ?? null;
          sessionInfo.value = null;
          pendingQuestion.value = null;
        }
        // Preserve error.value — if a refine-tasks:error preceded this event, the user
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

  /** Reset the entire refine-tasks state back to idle — messages, session, errors, outcome, everything. */
  function $reset() {
    state.value = "idle";
    messages.value = [];
    sessionInfo.value = null;
    pendingQuestion.value = null;
    error.value = null;
    outcome.value = null;
    reason.value = null;
    contextUsage.value = null;
    messageCounter = 0;
    lastEventWasText = false;
    _rehydrating = false;
  }

  /** Alias for $reset — resets the entire refine-tasks state back to idle. */
  function clearRefineTasks() {
    $reset();
  }

  return {
    // State
    state,
    messages,
    sessionInfo,
    pendingQuestion,
    error,
    outcome,
    reason,
    contextUsage,

    // Computed
    lastMessage,
    hasSession,
    isTerminal,

    // Actions
    start,
    stop,
    replyToQuestion,
    handleWsEvent,
    clearMessages,
    clearRefineTasks,
    setRehydrating(v: boolean) { _rehydrating = v; },
    $reset,
  };
});
