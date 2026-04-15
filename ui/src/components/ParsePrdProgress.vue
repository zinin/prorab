<script setup lang="ts">
/**
 * ParsePrdProgress — displays the progress of a parse-prd batch session.
 *
 * Supports five visual states:
 *   active    — streaming agent output with green pulsing dot + stop button
 *   stopping  — amber pulsing dot + disabled stop button
 *   completed/success   — green static dot + success banner
 *   completed/failure   — red static dot + error banner with error list
 *   completed/cancelled — amber static dot + warning banner
 *
 * Props-driven (no direct store access) following AgentChatPanel conventions.
 * Emits `stop` for the parent to call parsePrdStore.stop().
 */
import type { ParsePrdMessage, ParsePrdStoreState, ParsePrdOutcome } from "../stores/parse-prd";
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
} from "./parse-prd-progress-logic";
import Button from "primevue/button";
import { ref, watch, nextTick, computed } from "vue";

const props = defineProps<{
  messages: ParsePrdMessage[];
  state: ParsePrdStoreState;
  outcome: ParsePrdOutcome | null;
  contextUsage: { contextTokens: number; contextWindow: number; model: string } | null;
}>();

const emit = defineEmits<{
  stop: [];
  dismiss: [];
}>();

const outputEl = ref<HTMLElement | null>(null);

// --- Computed from pure helpers ---
const headerText = computed(() => statusText(props.state, props.outcome));
const headerDotClass = computed(() => `pprd-dot--${dotVariant(props.state, props.outcome)}`);
const canShowStop = computed(() => showStopButton(props.state));
const stopDisabled = computed(() => isStopDisabled(props.state));
const canShowBanner = computed(() => showOutcomeBanner(props.state));
const bannerSeverity = computed(() => outcomeSeverity(props.outcome));
const bannerLabel = computed(() => outcomeLabel(props.outcome));
const bannerErrors = computed(() => outcomeErrors(props.outcome));
const canShowDismiss = computed(() => showDismissButton(props.state, props.outcome));

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

watch(() => props.messages.length, scrollToBottom);

// --- Event handlers ---
function handleStop() {
  emit("stop");
}

function handleDismiss() {
  emit("dismiss");
}
</script>

<template>
  <div class="pprd-progress" data-testid="parse-prd-panel">
    <!-- Header bar -->
    <div class="pprd-progress__header">
      <div class="pprd-progress__status">
        <span class="pprd-dot" :class="headerDotClass" />
        <span data-testid="parse-prd-status-text">{{ headerText }}</span>
      </div>
      <div class="pprd-progress__header-right">
        <span
          v-if="contextUsage && state === 'active'"
          class="pprd-context"
          :style="{ color: contextColor }"
          data-testid="parse-prd-context-usage"
        >{{ contextLabel }}</span>
        <Button
          v-if="canShowStop"
          icon="pi pi-stop"
          severity="danger"
          size="small"
          :disabled="stopDisabled"
          label="Stop"
          data-testid="parse-prd-stop-button"
          @click="handleStop"
        />
        <Button
          v-if="canShowDismiss"
          icon="pi pi-refresh"
          severity="secondary"
          size="small"
          label="Try Again"
          data-testid="parse-prd-dismiss-button"
          @click="handleDismiss"
        />
      </div>
    </div>

    <!-- Outcome banner (completed state only) -->
    <div
      v-if="canShowBanner"
      class="pprd-banner"
      :class="`pprd-banner--${bannerSeverity}`"
      data-testid="parse-prd-outcome-banner"
    >
      <span class="pprd-banner__label" data-testid="parse-prd-outcome-label">{{ bannerLabel }}</span>
      <ul v-if="bannerErrors.length > 0" class="pprd-banner__errors" data-testid="parse-prd-outcome-errors">
        <li v-for="(err, i) in bannerErrors" :key="i">{{ err }}</li>
      </ul>
    </div>

    <!-- Message output area -->
    <div ref="outputEl" class="pprd-progress__output">
      <div v-if="messages.length === 0 && state !== 'completed'" class="pprd-progress__empty">
        Waiting for agent output…
      </div>
      <template v-for="msg in messages" :key="msg.id">
        <details v-if="msg.type === 'system_prompt'" class="pprd-details">
          <summary class="pprd-summary pprd-summary--prompt">[system-prompt] ({{ msg.content.length }} chars)</summary>
          <pre v-if="msg.content" class="pprd-body pprd-body--prompt">{{ msg.content }}</pre>
        </details>
        <details v-else-if="msg.type === 'task_prompt'" class="pprd-details">
          <summary class="pprd-summary pprd-summary--prompt">[task-prompt] ({{ msg.content.length }} chars)</summary>
          <pre v-if="msg.content" class="pprd-body pprd-body--prompt">{{ msg.content }}</pre>
        </details>
        <div v-else-if="msg.type === 'text'" class="pprd-line">{{ msg.content }}</div>
        <details v-else-if="msg.type === 'tool'" class="pprd-details">
          <summary class="pprd-summary pprd-summary--tool">[{{ msg.toolName ?? "tool" }}]</summary>
          <pre v-if="msg.content" class="pprd-body">{{ msg.content }}</pre>
        </details>
        <details v-else-if="msg.type === 'tool_result'" class="pprd-details">
          <summary class="pprd-summary pprd-summary--result">[result]</summary>
          <pre v-if="msg.content" class="pprd-body pprd-body--result">{{ msg.content }}</pre>
        </details>
        <div v-else-if="msg.type === 'error'" class="pprd-line pprd-line--error">{{ msg.content }}</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ---- Root layout ---- */
.pprd-progress {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--chat-bg-terminal, #1e1e1e);
  overflow: hidden;
}

/* ---- Header ---- */
.pprd-progress__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--chat-bg-surface, #2d2d2d);
  border-bottom: 1px solid #3c3c3c;
  flex-shrink: 0;
}

.pprd-progress__status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-family: monospace;
  font-size: 0.85rem;
  color: var(--chat-text-primary, #d4d4d4);
}

.pprd-progress__header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.pprd-context {
  font-family: monospace;
  font-size: 0.7rem;
  white-space: nowrap;
}

/* ---- Pulsing dot (state-aware) ---- */
.pprd-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.pprd-dot--active {
  background: #22c55e;
  animation: pprd-pulse 1.5s infinite;
}

.pprd-dot--stopping {
  background: #f59e0b;
  animation: pprd-pulse 1.5s infinite;
}

.pprd-dot--completed-success {
  background: #22c55e;
}

.pprd-dot--completed-failure {
  background: var(--chat-error-color, #f44747);
}

.pprd-dot--completed-cancelled {
  background: #f59e0b;
}

.pprd-dot--completed {
  background: #888;
}

@keyframes pprd-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ---- Outcome banner ---- */
.pprd-banner {
  padding: 0.5rem 0.75rem;
  font-family: monospace;
  font-size: 0.8rem;
  flex-shrink: 0;
  border-bottom: 1px solid #3c3c3c;
}

.pprd-banner--success {
  background: var(--chat-bg-result, #1e2d1e);
  color: var(--chat-result-color, #6a9955);
}

.pprd-banner--error {
  background: var(--chat-bg-error, #3a1e1e);
  color: var(--chat-error-color, #f44747);
}

.pprd-banner--warning {
  background: #2d2a1e;
  color: #f59e0b;
}

.pprd-banner--info {
  background: var(--chat-bg-surface, #2d2d2d);
  color: var(--chat-text-primary, #d4d4d4);
}

.pprd-banner__label {
  font-weight: 600;
}

.pprd-banner__errors {
  margin: 0.25rem 0 0;
  padding-left: 1.2rem;
  list-style: disc;
}

.pprd-banner__errors li {
  margin: 0.1rem 0;
}

.pprd-banner__dismiss {
  margin-top: 0.5rem;
}

/* ---- Output area ---- */
.pprd-progress__output {
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

.pprd-progress__output::-webkit-scrollbar { width: 8px; }
.pprd-progress__output::-webkit-scrollbar-track { background: var(--chat-bg-terminal, #1e1e1e); }
.pprd-progress__output::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }

.pprd-progress__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
  font-style: italic;
}

/* ---- Message lines ---- */
.pprd-line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
.pprd-line--error { color: var(--chat-error-color, #f44747); }
.pprd-details { margin: 2px 0; }
.pprd-summary { cursor: pointer; user-select: none; font-weight: 600; }
.pprd-summary--tool { color: var(--chat-tool-color, #569cd6); }
.pprd-summary--result { color: var(--chat-result-color, #6a9955); }
.pprd-summary--prompt { color: var(--chat-prefix-color, #ce9178); }
.pprd-body {
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
.pprd-body--result { background: var(--chat-bg-result, #1e2d1e); }
.pprd-body--prompt { background: var(--chat-bg-surface, #2d2d2d); color: var(--chat-prompt-color, #d4d4d4); }
</style>
