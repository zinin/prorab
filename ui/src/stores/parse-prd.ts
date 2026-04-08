import { defineStore } from "pinia";
import { ref, computed } from "vue";

// --- Parse-PRD message types ---

/**
 * Parse-PRD message stored in the local buffer.
 *
 * Batch-mode only — no user/question/question_answer types.
 * The `type` field reuses the same semantic names as the execution store's
 * AgentEvent (`text`, `tool`, `tool_result`, `system_prompt`, `task_prompt`).
 * Additional parse-prd-specific type: `error`.
 */
export interface ParsePrdMessage {
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

/** Lifecycle state of the parse-prd session */
export type ParsePrdStoreState = "idle" | "active" | "stopping" | "completed";

/** Info about the active parse-prd session */
export interface ParsePrdSessionInfo {
  agent: string;
  model?: string;
  variant?: string;
  responseLanguage?: string;
}

/**
 * Terminal outcome for the parse-prd operation.
 *
 * Structurally mirrors server-side `ParsePrdManagerOutcome` from `src/types.ts`
 * (three statuses: success / failure / cancelled).
 *
 * Note: the server also has a narrower `ParsePrdOutcome` in
 * `core/validate-parse-prd.ts` (only success / failure, no cancelled) —
 * that type is for pure file-validation logic; `cancelled` is added by
 * the manager layer and forwarded over WS, which is what this frontend type represents.
 */
export type ParsePrdOutcome =
  | { status: "success"; hasNextStep?: boolean }
  | { status: "failure"; errors: string[] }
  | { status: "cancelled" };

// --- WebSocket event types (mirrors server-side ParsePrdWsEvent + LogEvent from src/types.ts) ---

/** agent:* events routed through the parse-prd channel */
type AgentTextEvent = { type: "agent:text"; channel?: string; text: string };
type AgentToolEvent = { type: "agent:tool"; channel?: string; name: string; summary: string; input?: Record<string, unknown> };
type AgentToolResultEvent = { type: "agent:tool_result"; channel?: string; summary: string; output?: string };
type AgentContextUsageEvent = { type: "agent:context_usage"; channel?: string; contextTokens: number; contextWindow: number; model: string };
type AgentSystemPromptEvent = { type: "agent:system_prompt"; channel?: string; text: string };
type AgentTaskPromptEvent = { type: "agent:task_prompt"; channel?: string; text: string };

/** parse-prd:* lifecycle events */
type ParsePrdStartedEvent = { type: "parse-prd:started"; channel?: string; agent?: string; model?: string; variant?: string; sessionId?: string };
type ParsePrdErrorEvent = { type: "parse-prd:error"; channel?: string; message: string };
type ParsePrdFinishedEvent = { type: "parse-prd:finished"; channel?: string; outcome: ParsePrdOutcome };

/** Union of all events handleWsEvent can process */
export type ParsePrdWsEvent =
  | AgentTextEvent
  | AgentToolEvent
  | AgentToolResultEvent
  | AgentContextUsageEvent
  | AgentSystemPromptEvent
  | AgentTaskPromptEvent
  | ParsePrdStartedEvent
  | ParsePrdErrorEvent
  | ParsePrdFinishedEvent;

// --- Constants ---

const MAX_MESSAGES = 1000;
const TRIM_TO = 500;

// --- Store ---

export const useParsePrdStore = defineStore("parsePrd", () => {
  const state = ref<ParsePrdStoreState>("idle");
  const messages = ref<ParsePrdMessage[]>([]);
  const sessionInfo = ref<ParsePrdSessionInfo | null>(null);
  const error = ref<string | null>(null);
  const outcome = ref<ParsePrdOutcome | null>(null);
  /** Machine-readable reason from the last 409 response (e.g. "prd_missing", "active_session"). */
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
   * When true, lifecycle events (parse-prd:started) skip state mutations.
   * Set during WS reconnect to prevent ring-buffer replay from overwriting
   * the authoritative server snapshot. Messages are still added normally.
   */
  let _rehydrating = false;

  function nextMessageId(): string {
    return `pprd-${Date.now()}-${++messageCounter}`;
  }

  function addMessage(msg: ParsePrdMessage) {
    messages.value.push(msg);
    if (messages.value.length > MAX_MESSAGES) {
      messages.value = messages.value.slice(-TRIM_TO);
    }
  }

  // --- Actions ---

  async function start(opts: {
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
      const res = await fetch("/api/parse-prd", {
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
      agent: opts.agent,
      model: opts.model,
      variant: opts.variant,
      responseLanguage: opts.responseLanguage,
    };
    state.value = "active";
  }

  async function stop() {
    const prevState = state.value;
    state.value = "stopping";

    try {
      const res = await fetch("/api/parse-prd", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || "Failed to stop parse-prd";
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
   * Handle incoming WebSocket events for the parse-prd channel.
   *
   * Accepts both `agent:*` events (with `channel: "parse-prd"`) and `parse-prd:*` events.
   * Strips the transport envelope and stores canonical message types.
   */
  function handleWsEvent(event: ParsePrdWsEvent) {
    const type = event.type;

    // Only process agent:* events that belong to the parse-prd channel.
    if (type.startsWith("agent:") && event.channel !== "parse-prd") {
      return;
    }

    // Reset aggregation flag before processing — only agent:text sets it back to true
    const wasText = lastEventWasText;
    lastEventWasText = false;

    switch (type) {
      // --- agent:* events (with channel="parse-prd") ---
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

      // --- parse-prd:* lifecycle events ---
      case "parse-prd:started":
        if (!_rehydrating) {
          state.value = "active";
        }
        if (event.agent) {
          sessionInfo.value = {
            agent: event.agent,
            model: event.model,
            // Preserve variant from current sessionInfo when the event doesn't carry it
            // (server-side parse-prd:started includes variant; if absent, keep what start() set)
            variant: event.variant ?? sessionInfo.value?.variant,
          };
        }
        break;

      case "parse-prd:error":
        error.value = event.message ?? "Unknown parse-prd error";
        addMessage({
          id: nextMessageId(),
          type: "error",
          content: error.value!,
          timestamp: Date.now(),
        });
        break;

      case "parse-prd:finished":
        if (!_rehydrating) {
          state.value = "completed";
          outcome.value = event.outcome ?? null;
          sessionInfo.value = null;
        }
        // Preserve error.value — if a parse-prd:error preceded this event, the user
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

  /** Reset the entire parse-prd state back to idle — messages, session, errors, outcome, everything. */
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

  /** Alias for $reset — resets the entire parse-prd state back to idle. */
  function clearParsePrd() {
    $reset();
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
    isTerminal,

    // Actions
    start,
    stop,
    handleWsEvent,
    clearMessages,
    clearParsePrd,
    setRehydrating(v: boolean) { _rehydrating = v; },
    $reset,
  };
});
