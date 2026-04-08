import { defineStore } from "pinia";
import { ref, computed } from "vue";

// --- Chat message types ---

/** Question option presented by the agent */
export interface QuestionOption {
  label: string;
  description: string;
}

/** Agent question data (mirrors server-side QuestionData from drivers/types.ts) */
export interface QuestionData {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/** Answer values: single string or multi-select array */
export type QuestionAnswerValue = string | string[];

/** Map of question text → answer value */
export type QuestionAnswers = Record<string, QuestionAnswerValue>;

/**
 * Chat message stored in the local buffer.
 *
 * The `type` field reuses the same semantic names as the execution store's
 * AgentEvent (`text`, `tool`, `tool_result`) — no aliasing (e.g. "assistant").
 * Additional chat-specific types: `user`, `question`, `question_answer`,
 * `context_usage`, `error`.
 */
export interface ChatMessage {
  id: string;
  type:
    | "user"
    | "text"
    | "reasoning"
    | "tool"
    | "tool_result"
    | "question"
    | "question_answer"
    | "context_usage"
    | "system_prompt"
    | "error";
  content: string;
  timestamp: number;
  /** Tool name — present when type is "tool" or "tool_result" */
  toolName?: string;
  /** Question ID — present when type is "question" or "question_answer" */
  questionId?: string;
  /** Agent questions — present when type is "question" */
  questions?: QuestionData[];
  /** User answers — present when type is "question_answer" */
  answers?: QuestionAnswers;
}

/** Lifecycle state of the chat session */
export type ChatState = "idle" | "active" | "question_pending" | "stopping";

/** Info about the active chat session */
export interface SessionInfo {
  agent: string;
  model?: string;
  variant?: string;
}

/** Pending question awaiting user reply */
export interface PendingQuestion {
  questionId: string;
  questions: QuestionData[];
  source: "claude" | "opencode";
}

// --- WebSocket event types (mirrors server-side ChatWsEvent + LogEvent from src/types.ts) ---

/** agent:* events routed through the chat channel */
type AgentTextEvent = { type: "agent:text"; channel?: string; text: string };
type AgentToolEvent = { type: "agent:tool"; channel?: string; name: string; summary: string; input?: Record<string, unknown> };
type AgentToolResultEvent = { type: "agent:tool_result"; channel?: string; summary: string; output?: string };
type AgentContextUsageEvent = { type: "agent:context_usage"; channel?: string; contextTokens: number; contextWindow: number; model: string };
type AgentReasoningEvent = { type: "agent:reasoning"; channel?: string; text: string };
type AgentSystemPromptEvent = { type: "agent:system_prompt"; channel?: string; text: string };

/** chat:* lifecycle events */
type ChatStartedEvent = { type: "chat:started"; channel?: string; agent?: string; model?: string; sessionId?: string };
type ChatUserMessageEvent = { type: "chat:user_message"; channel?: string; text: string };
type ChatQuestionEvent = { type: "chat:question"; channel?: string; questionId: string; questions: QuestionData[]; source: "claude" | "opencode" };
type ChatIdleEvent = { type: "chat:idle"; channel?: string };
type ChatErrorEvent = { type: "chat:error"; channel?: string; message: string };
type ChatFinishedEvent = { type: "chat:finished"; channel?: string; hasPrd?: boolean; hasTasksFile?: boolean; hasValidTasks?: boolean };

/** Union of all events handleWsEvent can process */
export type ChatWsEvent =
  | AgentTextEvent
  | AgentToolEvent
  | AgentToolResultEvent
  | AgentContextUsageEvent
  | AgentReasoningEvent
  | AgentSystemPromptEvent
  | ChatStartedEvent
  | ChatUserMessageEvent
  | ChatQuestionEvent
  | ChatIdleEvent
  | ChatErrorEvent
  | ChatFinishedEvent;

// --- Constants ---

const MAX_MESSAGES = 1000;
const TRIM_TO = 500;

// --- Store ---

export const useChatStore = defineStore("chat", () => {
  const state = ref<ChatState>("idle");
  const awaitingUserInput = ref(false);
  const messages = ref<ChatMessage[]>([]);
  const pendingQuestion = ref<PendingQuestion | null>(null);
  const sessionInfo = ref<SessionInfo | null>(null);
  const error = ref<string | null>(null);

  // --- Computed ---

  const lastMessage = computed(() => messages.value.length > 0 ? messages.value[messages.value.length - 1] : null);
  const hasSession = computed(() => state.value !== "idle");
  const canSendMessage = computed(() => state.value === "active" && awaitingUserInput.value);
  const canReplyQuestion = computed(() => state.value === "question_pending" && pendingQuestion.value !== null);

  // --- Internal helpers ---

  let messageCounter = 0;
  /** Tracks whether the previous WS event was agent:text — used for streaming aggregation. */
  let lastEventWasText = false;
  /** Set by sendMessage(), cleared by chat:user_message WS event — prevents duplicate user messages. */
  let pendingUserBroadcast = false;
  /** Set by startChat() when systemPrompt is provided — prevents duplicate system_prompt message from WS. */
  let systemPromptAdded = false;
  /**
   * When true, lifecycle events (chat:started, chat:idle, chat:question) skip
   * state/awaitingUserInput mutations. Set during WS reconnect to prevent
   * ring-buffer replay from overwriting the authoritative server snapshot.
   * Messages are still added normally.
   */
  let _rehydrating = false;

  function nextMessageId(): string {
    return `chat-${Date.now()}-${++messageCounter}`;
  }

  function addMessage(msg: ChatMessage) {
    messages.value.push(msg);
    if (messages.value.length > MAX_MESSAGES) {
      messages.value = messages.value.slice(-TRIM_TO);
    }
  }

  // --- Actions ---

  async function startChat(opts: {
    agent: string;
    model?: string;
    variant?: string;
    systemPrompt?: string;
    userSettings?: boolean;
    applyHooks?: boolean;
  }) {
    // Clear previous state before starting
    messages.value = [];
    error.value = null;
    pendingQuestion.value = null;
    messageCounter = 0;
    pendingUserBroadcast = false;
    systemPromptAdded = false;

    // Add system prompt immediately so it appears before the first user message
    // (avoids race where HTTP response arrives before WS agent:system_prompt event)
    if (opts.systemPrompt) {
      addMessage({
        id: nextMessageId(),
        type: "system_prompt",
        content: opts.systemPrompt,
        timestamp: Date.now(),
      });
      systemPromptAdded = true;
    }

    try {
      const res = await fetch("/api/chat/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || `HTTP ${res.status}`;
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
    };
    state.value = "active";
    awaitingUserInput.value = true;
  }

  async function sendMessage(text: string) {
    // Optimistically add user message to the buffer
    addMessage({
      id: nextMessageId(),
      type: "user",
      content: text,
      timestamp: Date.now(),
    });
    pendingUserBroadcast = true;
    awaitingUserInput.value = false;

    try {
      const res = await fetch("/api/chat/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || `HTTP ${res.status}`;
        // Restore input readiness so the user can retry
        awaitingUserInput.value = true;
        throw new Error(error.value!);
      }
    } catch (err) {
      // Restore input readiness on any error (network/CORS/abort or HTTP error re-thrown above)
      awaitingUserInput.value = true;
      if (!error.value) {
        error.value = err instanceof Error ? err.message : "Network error";
      }
      throw err;
    }
  }

  async function replyQuestion(answers: QuestionAnswers) {
    if (!pendingQuestion.value) {
      throw new Error("No pending question to reply to");
    }
    const questionId = pendingQuestion.value.questionId;
    const savedPendingQuestion = pendingQuestion.value;
    const savedState = state.value;

    // Add answer message to buffer
    addMessage({
      id: nextMessageId(),
      type: "question_answer",
      content: JSON.stringify(answers),
      timestamp: Date.now(),
      questionId,
      answers,
    });

    pendingQuestion.value = null;
    state.value = "active";
    awaitingUserInput.value = false;

    try {
      const res = await fetch(`/api/chat/question/${encodeURIComponent(questionId)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      if (!res.ok) {
        const data = await res.json();
        error.value = data.error || `HTTP ${res.status}`;
        // Restore question_pending state so the user can retry (matches server-side behavior)
        pendingQuestion.value = savedPendingQuestion;
        state.value = savedState;
        throw new Error(error.value!);
      }
    } catch (err) {
      // Restore question_pending state on any error (network/CORS/abort or HTTP error re-thrown above)
      pendingQuestion.value = savedPendingQuestion;
      state.value = savedState;
      if (!error.value) {
        error.value = err instanceof Error ? err.message : "Network error";
      }
      throw err;
    }
  }

  async function stopChat() {
    const prevState = state.value;
    const prevAwaitingUserInput = awaitingUserInput.value;
    state.value = "stopping";
    awaitingUserInput.value = false;

    try {
      const res = await fetch("/api/chat", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        // Restore previous state so the user can retry or continue
        state.value = prevState;
        awaitingUserInput.value = prevAwaitingUserInput;
        throw new Error(data.error || "Failed to stop chat");
      }
    } catch (err) {
      // Restore previous state on any error (network/CORS/abort or HTTP error re-thrown above)
      state.value = prevState;
      awaitingUserInput.value = prevAwaitingUserInput;
      throw err;
    }
  }

  /**
   * Convenience helper for wizard-style UX: start a session and immediately
   * send the first user message in one call.
   */
  async function startFlow(
    opts: { agent: string; model?: string; variant?: string; systemPrompt?: string; userSettings?: boolean; applyHooks?: boolean },
    initialMessage: string,
  ) {
    await startChat(opts);
    await sendMessage(initialMessage);
  }

  /**
   * Handle incoming WebSocket events for the chat channel.
   *
   * Accepts both `agent:*` events (with `channel: "chat"`) and `chat:*` events.
   * Strips the transport envelope and stores canonical message types.
   */
  function handleWsEvent(event: ChatWsEvent) {
    const type = event.type;

    // Only process agent:* events that belong to the chat channel.
    // Execution-channel events have channel="execute" (set by applyDefaultChannel on server)
    // and must not leak into the chat message buffer.
    if (type.startsWith("agent:") && event.channel !== "chat") {
      return;
    }

    // Reset aggregation flag before processing — only agent:text sets it back to true
    const wasText = lastEventWasText;
    lastEventWasText = false;

    switch (type) {
      // --- agent:* events (with channel="chat") ---
      case "agent:text": {
        // Streaming aggregation: append to the last text message when the
        // previous WS event was also agent:text (consecutive streaming chunks).
        // A non-text event in between (tool, idle, question, etc.) breaks
        // aggregation so separate agent turns produce separate messages.
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
          type: "reasoning",
          content: event.text ?? "",
          timestamp: Date.now(),
        });
        break;

      case "agent:tool":
        addMessage({
          id: nextMessageId(),
          type: "tool",
          content: event.input ? JSON.stringify(event.input, null, 2) : "",
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
        // Skip if already added locally during startChat (prevents duplicate on race)
        if (!systemPromptAdded) {
          addMessage({
            id: nextMessageId(),
            type: "system_prompt",
            content: event.text ?? "",
            timestamp: Date.now(),
          });
        }
        systemPromptAdded = false;
        break;

      // --- chat:* lifecycle events ---
      case "chat:started":
        if (!_rehydrating) {
          state.value = "active";
          awaitingUserInput.value = true;
        }
        if (event.agent) {
          sessionInfo.value = {
            agent: event.agent,
            model: event.model,
          };
        }
        break;

      case "chat:user_message":
        // On live session: skip (already added optimistically by sendMessage)
        // On F5 replay: pendingUserBroadcast is false, so the message is added
        if (pendingUserBroadcast) {
          pendingUserBroadcast = false;
        } else {
          addMessage({
            id: nextMessageId(),
            type: "user",
            content: event.text ?? "",
            timestamp: Date.now(),
          });
        }
        break;

      case "chat:question":
        if (!_rehydrating) {
          state.value = "question_pending";
          awaitingUserInput.value = false;
        }
        pendingQuestion.value = {
          questionId: event.questionId,
          questions: event.questions,
          source: event.source,
        };
        addMessage({
          id: nextMessageId(),
          type: "question",
          content: "",
          timestamp: Date.now(),
          questionId: event.questionId,
          questions: event.questions,
        });
        break;

      case "chat:idle":
        if (!_rehydrating) {
          state.value = "active";
          awaitingUserInput.value = true;
          pendingQuestion.value = null;
        }
        break;

      case "chat:error":
        error.value = event.message ?? "Unknown chat error";
        addMessage({
          id: nextMessageId(),
          type: "error",
          content: error.value!,
          timestamp: Date.now(),
        });
        break;

      case "chat:finished":
        state.value = "idle";
        awaitingUserInput.value = false;
        pendingQuestion.value = null;
        sessionInfo.value = null;
        // Preserve error.value — if a chat:error preceded this event, the user
        // should still see what went wrong. The error is cleared when a new
        // session starts (startChat clears it) or when the store is fully reset.
        break;
    }
  }

  function clearMessages() {
    messages.value = [];
    messageCounter = 0;
    lastEventWasText = false;
    pendingUserBroadcast = false;
    systemPromptAdded = false;
    _rehydrating = false;
  }

  /** Reset the entire chat state back to idle — messages, session, errors, everything. */
  function $reset() {
    state.value = "idle";
    awaitingUserInput.value = false;
    messages.value = [];
    pendingQuestion.value = null;
    sessionInfo.value = null;
    error.value = null;
    messageCounter = 0;
    lastEventWasText = false;
    pendingUserBroadcast = false;
    systemPromptAdded = false;
    _rehydrating = false;
  }

  /** Alias for $reset — resets the entire chat state back to idle. */
  function clearChat() {
    $reset();
  }

  return {
    // State
    state,
    awaitingUserInput,
    messages,
    pendingQuestion,
    sessionInfo,
    error,

    // Computed
    lastMessage,
    hasSession,
    canSendMessage,
    canReplyQuestion,

    // Actions
    startChat,
    sendMessage,
    replyQuestion,
    stopChat,
    startFlow,
    handleWsEvent,
    clearMessages,
    clearChat,
    setRehydrating(v: boolean) { _rehydrating = v; },
    $reset,
  };
});
