<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted } from "vue";
import Button from "primevue/button";
import ChatMessageItem from "./ChatMessageItem.vue";
import AskUserQuestion from "./AskUserQuestion.vue";
import type { ChatMessage, ChatState, PendingQuestion, QuestionAnswers } from "../stores/chat";

const props = defineProps<{
  /** Chat messages to display */
  messages: ChatMessage[];
  /** Current chat session lifecycle state */
  state: ChatState;
  /** Whether the agent is waiting for user input */
  awaitingUserInput: boolean;
  /** Pending agent question awaiting user reply (null when none) */
  pendingQuestion: PendingQuestion | null;
  /** Whether the stop button should be shown/enabled */
  canStop: boolean;
}>();

const emit = defineEmits<{
  /** User sends a text message */
  send: [text: string];
  /** User replies to an agent question */
  reply: [answers: QuestionAnswers];
  /** User requests to stop the session */
  stop: [];
}>();

// --- Local state ---

/** Scrollable messages container ref */
const messagesEl = ref<HTMLElement | null>(null);

/** Textarea element ref for auto-resize */
const textareaEl = ref<HTMLTextAreaElement | null>(null);

/** Text input value */
const inputText = ref("");

// --- Computed ---

/** Whether the user can send a message right now */
const canSendMessage = computed(
  () =>
    props.state === "active" &&
    props.awaitingUserInput &&
    inputText.value.trim().length > 0 &&
    !props.pendingQuestion,
);

/** Whether the input field should be enabled */
const inputEnabled = computed(
  () =>
    props.state === "active" &&
    props.awaitingUserInput &&
    !props.pendingQuestion,
);

// --- Textarea auto-resize ---

/** Max visible rows before the textarea scrolls internally */
const TEXTAREA_MAX_ROWS = 8;

function autoResizeTextarea() {
  const el = textareaEl.value;
  if (!el) return;
  // Reset to single row to get accurate scrollHeight
  el.style.height = "auto";
  // Compute the line-height based row cap
  const style = getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const maxHeight = lineHeight * TEXTAREA_MAX_ROWS + paddingY + borderY;
  el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
}

watch(inputText, () => {
  nextTick(autoResizeTextarea);
});

// --- Auto-scroll ---

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  });
}

watch(() => props.messages.length, scrollToBottom);

watch(() => props.pendingQuestion, (q) => {
  if (q) scrollToBottom();
});

onMounted(() => {
  if (props.messages.length > 0) {
    scrollToBottom();
  }
});

// --- Actions ---

function handleSend() {
  if (!canSendMessage.value) return;
  const text = inputText.value.trim();
  inputText.value = "";
  // Reset textarea height after clearing (watcher fires on nextTick,
  // but we reset immediately to avoid visual flash)
  if (textareaEl.value) textareaEl.value.style.height = "auto";
  emit("send", text);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    handleSend();
  }
}

function handleReply(answers: QuestionAnswers) {
  emit("reply", answers);
}

function handleStop() {
  emit("stop");
}
</script>

<template>
  <div class="agent-chat-panel">
    <!-- Messages area -->
    <div ref="messagesEl" class="agent-chat-panel__messages">
      <template v-if="messages.length === 0">
        <div class="agent-chat-panel__empty">
          No messages yet.
        </div>
      </template>

      <template v-for="msg in messages" :key="msg.id">
        <ChatMessageItem :message="msg" />
      </template>

      <!-- Active question widget (shown below the last message when pending) -->
      <AskUserQuestion
        v-if="pendingQuestion"
        :question="pendingQuestion"
        @reply="handleReply"
      />
    </div>

    <!-- Status bar (shows when agent is working or session is transitioning) -->
    <div v-if="state === 'active' && !awaitingUserInput && !pendingQuestion" class="agent-chat-panel__status">
      <span class="agent-chat-panel__status-dot" />
      Agent is working…
    </div>
    <div v-else-if="state === 'stopping'" class="agent-chat-panel__status agent-chat-panel__status--warn">
      Stopping…
    </div>

    <!-- Input area -->
    <div class="agent-chat-panel__input-area">
      <div class="agent-chat-panel__input-row">
        <textarea
          ref="textareaEl"
          v-model="inputText"
          class="agent-chat-panel__textarea"
          placeholder="Type a message…"
          aria-label="Chat message input"
          :disabled="!inputEnabled"
          rows="1"
          @keydown="handleKeydown"
        />
        <Button
          icon="pi pi-send"
          :disabled="!canSendMessage"
          @click="handleSend"
          size="small"
          class="agent-chat-panel__send-btn"
          aria-label="Send message"
        />
        <Button
          v-if="canStop"
          icon="pi pi-stop"
          severity="danger"
          :disabled="state === 'stopping'"
          @click="handleStop"
          size="small"
          class="agent-chat-panel__stop-btn"
          aria-label="Stop session"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ================================================================
   AgentChatPanel — reusable chat UI styled to match execution view.
   Uses CSS custom properties from assets/chat.css for all colours.
   ================================================================ */

/* ---- Root container ---- */
.agent-chat-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--chat-bg-terminal);
  overflow: hidden;
}

/* ---- Messages area (modelled after .agent-output in ExecutionView) ---- */
.agent-chat-panel__messages {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--chat-text-primary);
  min-height: 0;   /* required for flex overflow-y to work */
}

/* Dark-theme scrollbar (matches execution terminal feel) */
.agent-chat-panel__messages::-webkit-scrollbar {
  width: 8px;
}
.agent-chat-panel__messages::-webkit-scrollbar-track {
  background: var(--chat-bg-terminal);
}
.agent-chat-panel__messages::-webkit-scrollbar-thumb {
  background: #555;
  border-radius: 4px;
}
.agent-chat-panel__messages::-webkit-scrollbar-thumb:hover {
  background: #666;
}

/* Firefox scrollbar */
.agent-chat-panel__messages {
  scrollbar-width: thin;
  scrollbar-color: #555 var(--chat-bg-terminal);
}

/* ---- Empty state (matches .no-events in ExecutionView) ---- */
.agent-chat-panel__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
  font-family: monospace;
  font-size: 0.85rem;
  font-style: italic;
}

/* ---- Status bar (between messages and input) ---- */
.agent-chat-panel__status {
  padding: 0.25rem 0.75rem;
  background: var(--chat-bg-surface);
  border-top: 1px solid #3c3c3c;
  font-family: monospace;
  font-size: 0.7rem;
  color: var(--chat-text-muted);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.agent-chat-panel__status--warn {
  color: #dcdcaa;
}

/* Pulsing dot — reuses the execution indicator animation */
.agent-chat-panel__status-dot {
  width: 6px;
  height: 6px;
  background: #22c55e;
  border-radius: 50%;
  animation: agent-chat-pulse 1.5s infinite;
}
@keyframes agent-chat-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ---- Input area ---- */
.agent-chat-panel__input-area {
  border-top: 1px solid #3c3c3c;
  padding: 0.5rem 0.75rem;
  background: var(--chat-bg-surface);
  flex-shrink: 0;
}

.agent-chat-panel__input-row {
  display: flex;
  gap: 0.4rem;
  align-items: flex-end;
}

/* ---- Textarea (auto-resizes up to TEXTAREA_MAX_ROWS, then scrolls) ---- */
.agent-chat-panel__textarea {
  flex: 1;
  resize: none;
  border: 1px solid #444;
  border-radius: 4px;
  background: var(--chat-bg-terminal);
  color: var(--chat-text-primary);
  font-family: monospace;
  font-size: 0.8rem;
  padding: 0.4rem 0.5rem;
  line-height: 1.4;
  outline: none;
  transition: border-color 0.15s;
  overflow-y: auto;
}
.agent-chat-panel__textarea:focus {
  border-color: var(--chat-tool-color);
}
.agent-chat-panel__textarea:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.agent-chat-panel__textarea::placeholder {
  color: var(--chat-text-muted);
  opacity: 0.6;
}

/* ---- PrimeVue button overrides ---- */
.agent-chat-panel__send-btn {
  font-family: monospace;
  flex-shrink: 0;
}
.agent-chat-panel__stop-btn {
  font-family: monospace;
  flex-shrink: 0;
}

/* Compact PrimeVue small buttons inside the input row */
.agent-chat-panel__input-row :deep(.p-button.p-button-sm) {
  padding: 0.4rem 0.6rem;
}
</style>
