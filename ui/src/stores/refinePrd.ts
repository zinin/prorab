import { defineStore } from "pinia";
import { ref, computed } from "vue";

// --- Refine-PRD message types ---

/**
 * Refine-PRD message stored in the local buffer.
 *
 * Multi-step agent session with question support.
 * The `type` field reuses the same semantic names as the execution store's
 * AgentEvent (`text`, `tool`, `tool_result`, `system_prompt`, `task_prompt`).
 * Additional refine-prd-specific types: `error`, `question`.
 */
export interface RefinePrdMessage {
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

/** Lifecycle state of the refine-prd session */
export type RefinePrdStoreState = "idle" | "active" | "stopping" | "completed";

/** Info about the active refine-prd session — includes step tracking */
export interface RefinePrdSessionInfo {
  steps: Array<{ agent: string; model?: string; variant?: string }>;
  currentStepIndex: number;
  stepState: "running" | "question_pending";
}

/**
 * Terminal outcome for the refine-prd operation.
 *
 * Mirrors server-side RefinePrdManagerOutcome.
 */
export interface RefinePrdOutcome {
  status: "success" | "failure" | "cancelled";
  stepsCompleted?: number;
  hasNextStep?: boolean;
  stepIndex?: number;
  error?: string;
}

/** Pending question awaiting user reply */
export interface RefinePrdPendingQuestion {
  questionId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  source?: string;
}

// --- WebSocket event types (mirrors server-side RefinePrdWsEvent + LogEvent from src/types.ts) ---

/** agent:* events routed through the refine-prd channel */
type AgentTextEvent = { type: "agent:text"; channel?: string; text: string };
type AgentReasoningEvent = { type: "agent:reasoning"; channel?: string; text: string };
type AgentToolEvent = { type: "agent:tool"; channel?: string; name: string; summary: string; input?: Record<string, unknown> };
type AgentToolResultEvent = { type: "agent:tool_result"; channel?: string; summary: string; output?: string };
type AgentContextUsageEvent = { type: "agent:context_usage"; channel?: string; contextTokens: number; contextWindow: number; model: string };
type AgentSystemPromptEvent = { type: "agent:system_prompt"; channel?: string; text: string };
type AgentTaskPromptEvent = { type: "agent:task_prompt"; channel?: string; text: string };

/** refine-prd:* lifecycle events */
type RefinePrdStartedEvent = {
  type: "refine-prd:started";
  channel?: string;
  steps?: Array<{ agent: string; model?: string; variant?: string }>;
  sessionId?: string;
};
type RefinePrdStepStartedEvent = {
  type: "refine-prd:step_started";
  channel?: string;
  stepIndex: number;
  agent: string;
  model?: string;
  variant?: string;
};
type RefinePrdStepFinishedEvent = {
  type: "refine-prd:step_finished";
  channel?: string;
  stepIndex: number;
};
type RefinePrdQuestionEvent = {
  type: "refine-prd:question";
  channel?: string;
  questionId: string;
  questions: RefinePrdPendingQuestion["questions"];
  source?: string;
};
type RefinePrdErrorEvent = { type: "refine-prd:error"; channel?: string; message: string };
type RefinePrdFinishedEvent = { type: "refine-prd:finished"; channel?: string; outcome: RefinePrdOutcome };

/** Union of all events handleWsEvent can process */
export type RefinePrdWsEvent =
  | AgentTextEvent
  | AgentReasoningEvent
  | AgentToolEvent
  | AgentToolResultEvent
  | AgentContextUsageEvent
  | AgentSystemPromptEvent
  | AgentTaskPromptEvent
  | RefinePrdStartedEvent
  | RefinePrdStepStartedEvent
  | RefinePrdStepFinishedEvent
  | RefinePrdQuestionEvent
  | RefinePrdErrorEvent
  | RefinePrdFinishedEvent;

// --- Constants ---

const MAX_MESSAGES = 1000;
const TRIM_TO = 500;

// --- Store ---

export const useRefinePrdStore = defineStore("refinePrd", () => {
  const state = ref<RefinePrdStoreState>("idle");
  const messages = ref<RefinePrdMessage[]>([]);
  const sessionInfo = ref<RefinePrdSessionInfo | null>(null);
  const pendingQuestion = ref<RefinePrdPendingQuestion | null>(null);
  const error = ref<string | null>(null);
  const outcome = ref<RefinePrdOutcome | null>(null);
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
   * When true, lifecycle events (refine-prd:started) skip state mutations.
   * Set during WS reconnect to prevent ring-buffer replay from overwriting
   * the authoritative server snapshot. Messages are still added normally.
   */
  let _rehydrating = false;

  function nextMessageId(): string {
    return `rprd-${Date.now()}-${++messageCounter}`;
  }

  function addMessage(msg: RefinePrdMessage) {
    messages.value.push(msg);
    if (messages.value.length > MAX_MESSAGES) {
      messages.value = messages.value.slice(-TRIM_TO);
    }
  }

  // --- Actions ---

  async function start(opts: {
    steps: Array<{ agent: string; model?: string }>;
    verbosity?: string;
    responseLanguage?: string;
    userSettings?: boolean;
    applyHooks?: boolean;
    parsePrdOptions?: {
      agent: string;
      model?: string;
      variant?: string;
      responseLanguage?: string;
      verbosity?: string;
      userSettings?: boolean;
      applyHooks?: boolean;
      refineTasksOptions?: {
        steps: Array<{ agent: string; model?: string; variant?: string }>;
        verbosity?: string;
        responseLanguage?: string;
        userSettings?: boolean;
        applyHooks?: boolean;
      } | null;
    } | null;
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
      const res = await fetch("/api/refine-prd", {
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
      const res = await fetch("/api/refine-prd", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || "Failed to stop refine-prd";
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
      const res = await fetch("/api/refine-prd/reply", {
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
   * Handle incoming WebSocket events for the refine-prd channel.
   *
   * Accepts both `agent:*` events (with `channel: "refine-prd"`) and `refine-prd:*` events.
   * Strips the transport envelope and stores canonical message types.
   */
  function handleWsEvent(event: RefinePrdWsEvent) {
    const type = event.type;

    // Only process agent:* events that belong to the refine-prd channel.
    if (type.startsWith("agent:") && event.channel !== "refine-prd") {
      return;
    }

    // Reset aggregation flag before processing — only agent:text sets it back to true
    const wasText = lastEventWasText;
    lastEventWasText = false;

    switch (type) {
      // --- agent:* events (with channel="refine-prd") ---
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

      // --- refine-prd:* lifecycle events ---
      case "refine-prd:started":
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

      case "refine-prd:step_started":
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

      case "refine-prd:step_finished":
        // Informational only — no state changes needed
        break;

      case "refine-prd:question":
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

      case "refine-prd:error":
        error.value = event.message ?? "Unknown refine-prd error";
        addMessage({
          id: nextMessageId(),
          type: "error",
          content: error.value!,
          timestamp: Date.now(),
        });
        break;

      case "refine-prd:finished":
        if (!_rehydrating) {
          state.value = "completed";
          outcome.value = event.outcome ?? null;
          sessionInfo.value = null;
          pendingQuestion.value = null;
        }
        // Preserve error.value — if a refine-prd:error preceded this event, the user
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

  /** Reset the entire refine-prd state back to idle — messages, session, errors, outcome, everything. */
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

  /** Alias for $reset — resets the entire refine-prd state back to idle. */
  function clearRefinePrd() {
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
    clearRefinePrd,
    setRehydrating(v: boolean) { _rehydrating = v; },
    $reset,
  };
});
