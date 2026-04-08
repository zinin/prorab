<script setup lang="ts">
/**
 * ExpandProgress — displays the progress of an expand (task decomposition) session.
 *
 * Supports five visual states:
 *   active    — streaming agent output with green pulsing dot + stop button
 *   stopping  — amber pulsing dot + disabled stop button
 *   completed/success   — green static dot + success banner (with subtask count)
 *   completed/failure   — red static dot + error banner with error list
 *   completed/cancelled — amber static dot + warning banner
 *
 * Props-driven (no direct store access) following ParsePrdProgress conventions.
 * Emits `stop` for the parent to call expandStore.stop().
 */
import type { ExpandMessage, ExpandStoreState, ExpandOutcome, ExpandSessionInfo } from "../stores/expand";
import {
  statusText,
  dotVariant,
  outcomeLabel,
  outcomeSeverity,
  showStopButton,
  isStopDisabled,
  showOutcomeBanner,
  outcomeErrors,
  showDismissButton,
  isCommitFailedAfterWrite,
  outcomeDetailMessage,
  reasonDisplayText,
} from "./expand-progress-logic";
import Button from "primevue/button";
import { ref, watch, nextTick, computed, onMounted } from "vue";

const props = defineProps<{
  messages: ExpandMessage[];
  state: ExpandStoreState;
  outcome: ExpandOutcome | null;
  sessionInfo: ExpandSessionInfo | null;
  contextUsage: { contextTokens: number; contextWindow: number; model: string } | null;
}>();

const emit = defineEmits<{
  stop: [];
  dismiss: [];
}>();

const outputEl = ref<HTMLElement | null>(null);

// --- Computed from pure helpers ---
const headerText = computed(() => statusText(props.state, props.outcome));
const headerDotClass = computed(() => `exp-dot--${dotVariant(props.state, props.outcome)}`);
const canShowStop = computed(() => showStopButton(props.state));
const stopDisabled = computed(() => isStopDisabled(props.state));
const canShowBanner = computed(() => showOutcomeBanner(props.state));
const bannerSeverity = computed(() => outcomeSeverity(props.outcome));
const bannerLabel = computed(() => outcomeLabel(props.outcome));
const bannerErrors = computed(() => outcomeErrors(props.outcome));
const canShowDismiss = computed(() => showDismissButton(props.state, props.outcome));
const commitFailedWarning = computed(() => isCommitFailedAfterWrite(props.outcome));
const detailMessage = computed(() => outcomeDetailMessage(props.outcome));
const reasonText = computed(() => reasonDisplayText(props.outcome));

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
 * Scroll signature that changes when new messages arrive OR when the last
 * message's content grows (streaming aggregation appends text to the last
 * element without changing array length).
 */
const scrollSignature = computed(() => {
  const len = props.messages.length;
  if (len === 0) return "0:0";
  const last = props.messages[len - 1];
  return `${len}:${last.content.length}`;
});

watch(scrollSignature, scrollToBottom);

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
</script>

<template>
  <div class="exp-progress" data-testid="expand-panel">
    <!-- Header bar -->
    <div class="exp-progress__header">
      <div class="exp-progress__status">
        <span class="exp-dot" :class="headerDotClass" />
        <span data-testid="expand-status-text">{{ headerText }}</span>
      </div>
      <div class="exp-progress__header-right">
        <span
          v-if="contextUsage && state === 'active'"
          class="exp-context"
          :style="{ color: contextColor }"
          data-testid="expand-context-usage"
        >{{ contextLabel }}</span>
        <Button
          v-if="canShowStop"
          icon="pi pi-stop"
          severity="danger"
          size="small"
          :disabled="stopDisabled"
          label="Stop"
          data-testid="expand-stop-button"
          @click="handleStop"
        />
      </div>
    </div>

    <!-- Outcome banner (completed state only) -->
    <div
      v-if="canShowBanner"
      class="exp-banner"
      :class="`exp-banner--${bannerSeverity}`"
      data-testid="expand-outcome-banner"
    >
      <span class="exp-banner__label" data-testid="expand-outcome-label">{{ bannerLabel }}</span>
      <span v-if="reasonText" class="exp-banner__reason" data-testid="expand-outcome-reason">{{ reasonText }}</span>
      <p v-if="detailMessage" class="exp-banner__detail">{{ detailMessage }}</p>
      <div v-if="commitFailedWarning" class="exp-banner__commit-warning">
        Subtasks were written to tasks.json but the git commit failed. The file may need a manual commit.
      </div>
      <ul v-if="bannerErrors.length > 0" class="exp-banner__errors" data-testid="expand-outcome-errors">
        <li v-for="(err, i) in bannerErrors" :key="i">{{ err }}</li>
      </ul>
      <Button
        v-if="canShowDismiss"
        label="Try Again"
        size="small"
        severity="secondary"
        class="exp-banner__dismiss"
        data-testid="expand-dismiss-button"
        @click="handleDismiss"
      />
    </div>

    <!-- Message output area -->
    <div ref="outputEl" class="exp-progress__output">
      <div v-if="messages.length === 0 && state !== 'completed'" class="exp-progress__empty">
        Waiting for agent output…
      </div>
      <template v-for="msg in messages" :key="msg.id">
        <details v-if="msg.type === 'system_prompt'" class="exp-details">
          <summary class="exp-summary exp-summary--prompt">[system-prompt] ({{ msg.content.length }} chars)</summary>
          <pre v-if="msg.content" class="exp-body exp-body--prompt">{{ msg.content }}</pre>
        </details>
        <details v-else-if="msg.type === 'task_prompt'" class="exp-details">
          <summary class="exp-summary exp-summary--prompt">[task-prompt] ({{ msg.content.length }} chars)</summary>
          <pre v-if="msg.content" class="exp-body exp-body--prompt">{{ msg.content }}</pre>
        </details>
        <div v-else-if="msg.type === 'text'" class="exp-line">{{ msg.content }}</div>
        <details v-else-if="msg.type === 'tool'" class="exp-details">
          <summary class="exp-summary exp-summary--tool">[{{ msg.toolName ?? "tool" }}]</summary>
          <pre v-if="msg.content" class="exp-body">{{ msg.content }}</pre>
        </details>
        <details v-else-if="msg.type === 'tool_result'" class="exp-details">
          <summary class="exp-summary exp-summary--result">[result]</summary>
          <pre v-if="msg.content" class="exp-body exp-body--result">{{ msg.content }}</pre>
        </details>
        <div v-else-if="msg.type === 'error'" class="exp-line exp-line--error">{{ msg.content }}</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ---- Root layout ---- */
.exp-progress {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--chat-bg-terminal, #1e1e1e);
  overflow: hidden;
}

/* ---- Header ---- */
.exp-progress__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--chat-bg-surface, #2d2d2d);
  border-bottom: 1px solid #3c3c3c;
  flex-shrink: 0;
}

.exp-progress__status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-family: monospace;
  font-size: 0.85rem;
  color: var(--chat-text-primary, #d4d4d4);
}

.exp-progress__header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.exp-context {
  font-family: monospace;
  font-size: 0.7rem;
  white-space: nowrap;
}

/* ---- Pulsing dot (state-aware) ---- */
.exp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.exp-dot--active {
  background: #22c55e;
  animation: exp-pulse 1.5s infinite;
}

.exp-dot--stopping {
  background: #f59e0b;
  animation: exp-pulse 1.5s infinite;
}

.exp-dot--completed-success {
  background: #22c55e;
}

.exp-dot--completed-failure {
  background: var(--chat-error-color, #f44747);
}

.exp-dot--completed-cancelled {
  background: #f59e0b;
}

.exp-dot--completed {
  background: #888;
}

@keyframes exp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ---- Outcome banner ---- */
.exp-banner {
  padding: 0.5rem 0.75rem;
  font-family: monospace;
  font-size: 0.8rem;
  flex-shrink: 0;
  border-bottom: 1px solid #3c3c3c;
}

.exp-banner--success {
  background: var(--chat-bg-result, #1e2d1e);
  color: var(--chat-result-color, #6a9955);
}

.exp-banner--error {
  background: var(--chat-bg-error, #3a1e1e);
  color: var(--chat-error-color, #f44747);
}

.exp-banner--warning {
  background: #2d2a1e;
  color: #f59e0b;
}

.exp-banner--info {
  background: var(--chat-bg-surface, #2d2d2d);
  color: var(--chat-text-primary, #d4d4d4);
}

.exp-banner__label {
  font-weight: 600;
}

.exp-banner__reason {
  display: inline-block;
  margin-left: 0.4rem;
  font-size: 0.7rem;
  opacity: 0.75;
  font-weight: 400;
}

.exp-banner__detail {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  opacity: 0.9;
}

.exp-banner__commit-warning {
  margin: 0.4rem 0;
  padding: 0.3rem 0.5rem;
  background: rgba(245, 158, 11, 0.15);
  border-left: 3px solid #f59e0b;
  font-size: 0.75rem;
  color: #f59e0b;
}

.exp-banner__errors {
  margin: 0.25rem 0 0;
  padding-left: 1.2rem;
  list-style: disc;
}

.exp-banner__errors li {
  margin: 0.1rem 0;
}

.exp-banner__dismiss {
  margin-top: 0.5rem;
}

/* ---- Output area ---- */
.exp-progress__output {
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

.exp-progress__output::-webkit-scrollbar { width: 8px; }
.exp-progress__output::-webkit-scrollbar-track { background: var(--chat-bg-terminal, #1e1e1e); }
.exp-progress__output::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }

.exp-progress__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
  font-style: italic;
}

/* ---- Message lines ---- */
.exp-line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
.exp-line--error { color: var(--chat-error-color, #f44747); }
.exp-details { margin: 2px 0; }
.exp-summary { cursor: pointer; user-select: none; font-weight: 600; }
.exp-summary--tool { color: var(--chat-tool-color, #569cd6); }
.exp-summary--result { color: var(--chat-result-color, #6a9955); }
.exp-summary--prompt { color: var(--chat-prefix-color, #ce9178); }
.exp-body {
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
.exp-body--result { background: var(--chat-bg-result, #1e2d1e); }
.exp-body--prompt { background: var(--chat-bg-surface, #2d2d2d); color: var(--chat-prompt-color, #d4d4d4); }
</style>
