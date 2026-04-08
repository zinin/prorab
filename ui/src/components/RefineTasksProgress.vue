<script setup lang="ts">
/**
 * RefineTasksProgress — displays the progress of a refine-tasks multi-step session.
 *
 * Supports five visual states:
 *   active    — streaming agent output with green pulsing dot + stop button
 *   stopping  — amber pulsing dot + disabled stop button
 *   completed/success   — green static dot + success banner
 *   completed/failure   — red static dot + error banner + "Try Again"
 *   completed/cancelled — amber static dot + warning banner + "Try Again"
 *
 * Adds question handling (structured via AskUserQuestion or free-text fallback)
 * for multi-step agent sessions that ask the user for input.
 *
 * Props-driven (no direct store access) following ParsePrdProgress conventions.
 * Emits `stop` for the parent to call refineTasksStore.stop(),
 * `dismiss` for "Try Again", and `reply` for question answers.
 */
import type {
  RefineTasksMessage,
  RefineTasksStoreState,
  RefineTasksOutcome,
  RefineTasksSessionInfo,
  RefineTasksPendingQuestion,
} from "../stores/refineTasks";
import type { QuestionAnswers } from "../stores/chat";
import {
  statusText,
  dotVariant,
  outcomeLabel,
  outcomeSeverity,
  showStopButton,
  isStopDisabled,
  showOutcomeBanner,
  showDismissButton,
  stepLabel,
  isQuestionPending,
} from "./refine-tasks-progress-logic";
import AskUserQuestion from "./AskUserQuestion.vue";
import Button from "primevue/button";
import Textarea from "primevue/textarea";
import { ref, watch, nextTick, computed, onMounted } from "vue";

const props = defineProps<{
  messages: RefineTasksMessage[];
  state: RefineTasksStoreState;
  outcome: RefineTasksOutcome | null;
  sessionInfo: RefineTasksSessionInfo | null;
  contextUsage: { contextTokens: number; contextWindow: number; model: string } | null;
  pendingQuestion: RefineTasksPendingQuestion | null;
}>();

const emit = defineEmits<{
  stop: [];
  dismiss: [];
  reply: [questionId: string, answers?: Record<string, string | string[]>];
}>();

const outputEl = ref<HTMLElement | null>(null);
const freeTextReply = ref("");

// --- Computed from pure helpers ---
const headerText = computed(() => statusText(props.state, props.outcome, props.sessionInfo));
const headerDotClass = computed(() => `rtsk-dot--${dotVariant(props.state, props.outcome)}`);
const headerStepLabel = computed(() => stepLabel(props.sessionInfo));
const canShowStop = computed(() => showStopButton(props.state));
const stopDisabled = computed(() => isStopDisabled(props.state));
const canShowBanner = computed(() => showOutcomeBanner(props.state));
const bannerSeverity = computed(() => outcomeSeverity(props.outcome));
const bannerLabel = computed(() => outcomeLabel(props.outcome));
const canShowDismiss = computed(() => showDismissButton(props.state, props.outcome));
const questionPending = computed(() => isQuestionPending(props.sessionInfo));

/** Whether the pending question has structured options (use AskUserQuestion) vs free-text */
const hasStructuredQuestion = computed(() => {
  if (!props.pendingQuestion) return false;
  return props.pendingQuestion.questions.length > 0 &&
    props.pendingQuestion.questions.some(q => q.options && q.options.length > 0);
});

const contextPercent = computed(() => {
  if (!props.contextUsage || !props.contextUsage.contextWindow) return 0;
  return Math.round((props.contextUsage.contextTokens / props.contextUsage.contextWindow) * 100);
});

const contextLabel = computed(() => {
  if (!props.contextUsage) return "";
  const fmt = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
  return `Context: ${fmt(props.contextUsage.contextTokens)} / ${fmt(props.contextUsage.contextWindow)} (${contextPercent.value}%)`;
});

const contextColor = computed(() => {
  const pct = contextPercent.value;
  if (pct >= 60) return "#f44747";
  if (pct >= 35) return "#f59e0b";
  return "#22c55e";
});

// --- Auto-scroll on new messages ---
function scrollToBottom() {
  nextTick(() => {
    if (outputEl.value) {
      outputEl.value.scrollTop = outputEl.value.scrollHeight;
    }
  });
}

/**
 * Deep watch on messages to catch both new messages and text merging
 * during streaming (where content appends to an existing message without
 * changing the array length).
 */
watch(() => props.messages, scrollToBottom, { deep: true });

// Scroll to bottom on mount when the buffer is already populated (e.g. WS reconnect)
onMounted(() => {
  if (props.messages.length > 0) {
    scrollToBottom();
  }
});

// --- Event handlers ---
function handleStop() {
  emit("stop");
}

function handleDismiss() {
  emit("dismiss");
}

function handleStructuredReply(answers: QuestionAnswers) {
  if (!props.pendingQuestion) return;
  emit("reply", props.pendingQuestion.questionId, answers);
}

function handleFreeTextReply() {
  if (!props.pendingQuestion || !freeTextReply.value.trim()) return;
  // For free-text, emit with a single answer keyed by "0"
  emit("reply", props.pendingQuestion.questionId, { "0": freeTextReply.value.trim() });
  freeTextReply.value = "";
}
</script>

<template>
  <div class="rtsk-progress" data-testid="refine-tasks-panel">
    <!-- Header bar -->
    <div class="rtsk-progress__header">
      <div class="rtsk-progress__status">
        <span class="rtsk-dot" :class="headerDotClass" />
        <span data-testid="refine-tasks-status-text">{{ headerText }}</span>
        <span
          v-if="headerStepLabel && state === 'active'"
          class="rtsk-step-label"
          data-testid="refine-tasks-step-label"
        >{{ headerStepLabel }}</span>
      </div>
      <div class="rtsk-progress__header-right">
        <span
          v-if="contextUsage && state === 'active'"
          class="rtsk-context"
          :style="{ color: contextColor }"
          data-testid="refine-tasks-context-usage"
        >{{ contextLabel }}</span>
        <Button
          v-if="canShowStop"
          icon="pi pi-stop"
          severity="danger"
          size="small"
          :disabled="stopDisabled"
          label="Stop"
          data-testid="refine-tasks-stop-button"
          @click="handleStop"
        />
        <Button
          v-if="canShowDismiss"
          icon="pi pi-check"
          severity="success"
          size="small"
          label="Done"
          data-testid="refine-tasks-dismiss-button"
          @click="handleDismiss"
        />
      </div>
    </div>

    <!-- Outcome banner (completed state only) -->
    <div
      v-if="canShowBanner"
      class="rtsk-banner"
      :class="`rtsk-banner--${bannerSeverity}`"
      data-testid="refine-tasks-outcome-banner"
    >
      <span class="rtsk-banner__label" data-testid="refine-tasks-outcome-label">{{ bannerLabel }}</span>
    </div>

    <!-- Question block (when question pending) -->
    <div
      v-if="questionPending && pendingQuestion"
      class="rtsk-question"
      data-testid="refine-tasks-question-block"
    >
      <!-- Structured question with options -->
      <AskUserQuestion
        v-if="hasStructuredQuestion"
        :question="{
          questionId: pendingQuestion.questionId,
          questions: pendingQuestion.questions,
          source: (pendingQuestion.source as 'claude' | 'opencode') ?? 'claude',
        }"
        @reply="handleStructuredReply"
      />
      <!-- Free-text fallback -->
      <div v-else class="rtsk-question__freetext">
        <p v-if="pendingQuestion.questions.length > 0" class="rtsk-question__text">
          {{ pendingQuestion.questions[0].question }}
        </p>
        <Textarea
          v-model="freeTextReply"
          class="rtsk-question__textarea"
          placeholder="Type your reply..."
          autoResize
          rows="3"
          data-testid="refine-tasks-reply-textarea"
        />
        <div class="rtsk-question__actions">
          <Button
            label="Reply"
            icon="pi pi-send"
            size="small"
            :disabled="!freeTextReply.trim()"
            data-testid="refine-tasks-reply-button"
            @click="handleFreeTextReply"
          />
        </div>
      </div>
    </div>

    <!-- Message output area -->
    <div ref="outputEl" class="rtsk-progress__output">
      <div v-if="messages.length === 0 && state !== 'completed'" class="rtsk-progress__empty">
        Waiting for agent output…
      </div>
      <template v-for="msg in messages" :key="msg.id">
        <details v-if="msg.type === 'system_prompt'" class="rtsk-details">
          <summary class="rtsk-summary rtsk-summary--prompt">[system-prompt] ({{ msg.content.length }} chars)</summary>
          <pre v-if="msg.content" class="rtsk-body rtsk-body--prompt">{{ msg.content }}</pre>
        </details>
        <details v-else-if="msg.type === 'task_prompt'" class="rtsk-details">
          <summary class="rtsk-summary rtsk-summary--prompt">[task-prompt] ({{ msg.content.length }} chars)</summary>
          <pre v-if="msg.content" class="rtsk-body rtsk-body--prompt">{{ msg.content }}</pre>
        </details>
        <div v-else-if="msg.type === 'text'" class="rtsk-line">{{ msg.content }}</div>
        <details v-else-if="msg.type === 'tool'" class="rtsk-details">
          <summary class="rtsk-summary rtsk-summary--tool">[{{ msg.toolName ?? "tool" }}]</summary>
          <pre v-if="msg.content" class="rtsk-body">{{ msg.content }}</pre>
        </details>
        <details v-else-if="msg.type === 'tool_result'" class="rtsk-details">
          <summary class="rtsk-summary rtsk-summary--result">[result]</summary>
          <pre v-if="msg.content" class="rtsk-body rtsk-body--result">{{ msg.content }}</pre>
        </details>
        <div v-else-if="msg.type === 'error'" class="rtsk-line rtsk-line--error">{{ msg.content }}</div>
        <div v-else-if="msg.type === 'question'" class="rtsk-line rtsk-line--question">&#10067; Question pending</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ---- Root layout ---- */
.rtsk-progress {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--chat-bg-terminal, #1e1e1e);
  overflow: hidden;
}

/* ---- Header ---- */
.rtsk-progress__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--chat-bg-surface, #2d2d2d);
  border-bottom: 1px solid #3c3c3c;
  flex-shrink: 0;
}

.rtsk-progress__status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-family: monospace;
  font-size: 0.85rem;
  color: var(--chat-text-primary, #d4d4d4);
}

.rtsk-step-label {
  font-size: 0.7rem;
  color: var(--chat-text-muted, #888);
  margin-left: 0.3rem;
}

.rtsk-progress__header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.rtsk-context {
  font-family: monospace;
  font-size: 0.7rem;
  white-space: nowrap;
}

/* ---- Pulsing dot (state-aware) ---- */
.rtsk-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.rtsk-dot--active {
  background: #22c55e;
  animation: rtsk-pulse 1.5s infinite;
}

.rtsk-dot--stopping {
  background: #f59e0b;
  animation: rtsk-pulse 1.5s infinite;
}

.rtsk-dot--completed-success {
  background: #22c55e;
}

.rtsk-dot--completed-failure {
  background: var(--chat-error-color, #f44747);
}

.rtsk-dot--completed-cancelled {
  background: #f59e0b;
}

.rtsk-dot--completed {
  background: #888;
}

@keyframes rtsk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ---- Outcome banner ---- */
.rtsk-banner {
  padding: 0.5rem 0.75rem;
  font-family: monospace;
  font-size: 0.8rem;
  flex-shrink: 0;
  border-bottom: 1px solid #3c3c3c;
}

.rtsk-banner--success {
  background: var(--chat-bg-result, #1e2d1e);
  color: var(--chat-result-color, #6a9955);
}

.rtsk-banner--error {
  background: var(--chat-bg-error, #3a1e1e);
  color: var(--chat-error-color, #f44747);
}

.rtsk-banner--warning {
  background: #2d2a1e;
  color: #f59e0b;
}

.rtsk-banner--info {
  background: var(--chat-bg-surface, #2d2d2d);
  color: var(--chat-text-primary, #d4d4d4);
}

.rtsk-banner__label {
  font-weight: 600;
}

.rtsk-banner__dismiss {
  margin-top: 0.5rem;
}

/* ---- Question block ---- */
.rtsk-question {
  padding: 0.75rem;
  background: var(--chat-bg-surface, #2d2d2d);
  border-bottom: 1px solid #3c3c3c;
  flex-shrink: 0;
}

.rtsk-question__freetext {
  font-family: monospace;
  font-size: 0.8rem;
}

.rtsk-question__text {
  color: var(--chat-text-primary, #d4d4d4);
  margin: 0 0 0.5rem;
  font-weight: 500;
}

.rtsk-question__textarea {
  width: 100%;
  max-height: 10rem !important;
  overflow-y: auto !important;
  font-family: monospace;
  font-size: 0.8rem;
}

.rtsk-question__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.5rem;
}

/* ---- Output area ---- */
.rtsk-progress__output {
  flex: 1;
  overflow-y: auto;
  padding: 0.75rem;
  font-family: monospace;
  font-size: 0.8rem;
  color: var(--chat-text-primary, #d4d4d4);
  min-height: 0;
  scrollbar-width: thin;
  scrollbar-color: #555 var(--chat-bg-terminal, #1e1e1e);
}

.rtsk-progress__output::-webkit-scrollbar { width: 8px; }
.rtsk-progress__output::-webkit-scrollbar-track { background: var(--chat-bg-terminal, #1e1e1e); }
.rtsk-progress__output::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }

.rtsk-progress__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
  font-style: italic;
}

/* ---- Message lines ---- */
.rtsk-line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
.rtsk-line--error { color: var(--chat-error-color, #f44747); }
.rtsk-line--question { color: var(--chat-question-color, #569cd6); }
.rtsk-details { margin: 2px 0; }
.rtsk-summary { cursor: pointer; user-select: none; font-weight: 600; }
.rtsk-summary--tool { color: var(--chat-tool-color, #569cd6); }
.rtsk-summary--result { color: var(--chat-result-color, #6a9955); }
.rtsk-summary--prompt { color: var(--chat-prefix-color, #ce9178); }
.rtsk-body {
  color: var(--chat-text-primary, #d4d4d4);
  background: var(--chat-bg-tool, #1e2a3a);
  padding: 0.5rem;
  margin: 0.25rem 0 0;
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.75rem;
}
.rtsk-body--result { background: var(--chat-bg-result, #1e2d1e); }
.rtsk-body--prompt { background: var(--chat-bg-surface, #2d2d2d); color: var(--chat-prompt-color, #d4d4d4); }
</style>
