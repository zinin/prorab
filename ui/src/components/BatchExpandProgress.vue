<script setup lang="ts">
import type { SlotState, TaskSummaryItem, BatchExpandProgressData } from "../stores/batchExpand";
import type { BatchExpandOutcome } from "../../../src/types";
import {
  batchStatusText,
  progressPercent,
  taskCardClass,
  taskCardLabel,
  outcomeSummaryText,
} from "../composables/batch-expand-launch-helpers";
import {
  dotVariant,
  outcomeLabel,
  outcomeBannerClass as outcomeBannerClassFn,
  hasTaskErrors as hasTaskErrorsFn,
  showStopButton,
  isStopDisabled as isStopDisabledFn,
  showDoneButton,
  contextLabel as contextLabelFn,
  contextColor as contextColorFn,
  slotInfoLabel as slotInfoLabelFn,
} from "./batch-expand-progress-logic";
import Button from "primevue/button";
import { ref, watch, nextTick, computed, onMounted } from "vue";

const props = defineProps<{
  state: string;
  slots: SlotState[];
  summary: TaskSummaryItem[];
  progress: BatchExpandProgressData;
  outcome: BatchExpandOutcome | null;
  activeSlotIndex: number;
  focusedTaskId: number | null;
  error: string | null;
  contextUsage: { contextTokens: number; contextWindow: number; model: string } | null;
  pinned: boolean;
}>();

const emit = defineEmits<{
  stop: [];
  dismiss: [];
  selectTask: [taskId: number];
}>();

const outputEl = ref<HTMLElement | null>(null);

// --- Header ---
const statusLabel = computed(() => batchStatusText(props.state, props.progress, props.outcome));
const showStop = computed(() => showStopButton(props.state));
const stopDisabled = computed(() => isStopDisabledFn(props.state));
const showDone = computed(() => showDoneButton(props.state));

// --- Status dot ---
const dotClass = computed(() => dotVariant(props.state, props.outcome));

// --- Context usage ---
const contextLabel = computed(() => contextLabelFn(props.contextUsage));
const contextColor = computed(() => contextColorFn(props.contextUsage));

// --- Progress ---
const progressPct = computed(() => progressPercent(props.progress));

// --- Outcome ---
const outcomeBannerClass = computed(() => outcomeBannerClassFn(props.outcome));
const outcomeText = computed(() => outcomeLabel(props.outcome));
const outcomeSummary = computed(() => props.outcome ? outcomeSummaryText(props.outcome) : "");

// --- Active slot messages ---
const activeSlot = computed(() => props.slots[props.activeSlotIndex]);
const slotInfoLabel = computed(() => slotInfoLabelFn(activeSlot.value, props.pinned));

// --- Auto-scroll ---
function scrollToBottom() {
  nextTick(() => {
    if (outputEl.value) {
      outputEl.value.scrollTop = outputEl.value.scrollHeight;
    }
  });
}

const scrollSignature = computed(() => {
  const slot = activeSlot.value;
  if (!slot || slot.messages.length === 0) return `${props.activeSlotIndex}:0:0`;
  const last = slot.messages[slot.messages.length - 1];
  return `${props.activeSlotIndex}:${slot.messages.length}:${last.content?.length ?? 0}`;
});

watch(scrollSignature, scrollToBottom);

onMounted(() => {
  if (activeSlot.value && activeSlot.value.messages.length > 0) {
    scrollToBottom();
  }
});
</script>

<template>
  <div class="bexp-progress" data-testid="batch-expand-progress">
    <!-- Header -->
    <div class="bexp-progress__header">
      <div class="bexp-progress__status">
        <span class="bexp-dot" :class="dotClass" />
        <span data-testid="batch-expand-status-text">{{ statusLabel }}</span>
      </div>
      <div class="bexp-progress__header-right">
        <span
          v-if="contextUsage && state === 'active'"
          class="bexp-context"
          :style="{ color: contextColor }"
          data-testid="batch-expand-context-usage"
        >{{ contextLabel }}</span>
        <Button
          v-if="showStop"
          icon="pi pi-stop"
          severity="danger"
          size="small"
          :disabled="stopDisabled"
          :label="stopDisabled ? 'Stopping...' : 'Stop'"
          data-testid="batch-expand-stop-button"
          @click="emit('stop')"
        />
        <Button
          v-if="showDone"
          label="Done"
          size="small"
          severity="success"
          data-testid="batch-expand-done-button"
          @click="emit('dismiss')"
        />
      </div>
    </div>

    <!-- Task cards -->
    <div class="bexp-cards" data-testid="batch-expand-cards">
      <div
        v-for="item in summary"
        :key="item.taskId"
        class="bexp-card"
        :class="taskCardClass(item.status, focusedTaskId === item.taskId)"
        @click="emit('selectTask', item.taskId)"
        data-testid="batch-expand-card"
      >
        <div class="bexp-card__id">#{{ item.taskId }}</div>
        <div class="bexp-card__label">{{ taskCardLabel(item) }}</div>
      </div>
    </div>

    <!-- Progress bar -->
    <div class="bexp-progress-bar">
      <div class="bexp-progress-bar__fill" :style="{ width: progressPct + '%' }" />
    </div>

    <!-- Error banner (batch-level errors, e.g. pool crash) -->
    <div
      v-if="error"
      class="bexp-banner bexp-banner--error"
      data-testid="batch-expand-error-banner"
    >
      <span class="bexp-banner__label">Error: {{ error }}</span>
    </div>

    <!-- Outcome banner -->
    <div
      v-if="state === 'completed' && outcome"
      class="bexp-banner"
      :class="outcomeBannerClass"
      data-testid="batch-expand-outcome-banner"
    >
      <span class="bexp-banner__label">{{ outcomeText }}</span>
      <span v-if="outcomeSummary" class="bexp-banner__stats">{{ outcomeSummary }}</span>
    </div>

    <!-- Agent output -->
    <div ref="outputEl" class="bexp-progress__output">
      <div v-if="!activeSlot || activeSlot.messages.length === 0" class="bexp-progress__empty">
        {{ state === 'completed' ? 'Click a task card to view its output' : pinned && !activeSlot ? 'Waiting for task to start…' : 'Waiting for agent output…' }}
      </div>
      <template v-else>
        <div class="bexp-slot-label">{{ slotInfoLabel }}</div>
        <template v-for="msg in activeSlot.messages" :key="msg.id">
          <div v-if="msg.type === 'separator'" class="bexp-separator">{{ msg.content }}</div>
          <details v-else-if="msg.type === 'system_prompt'" class="bexp-details">
            <summary class="bexp-summary bexp-summary--prompt">System prompt ({{ msg.content.length }} chars)</summary>
            <pre class="bexp-body bexp-body--prompt">{{ msg.content }}</pre>
          </details>
          <details v-else-if="msg.type === 'task_prompt'" class="bexp-details">
            <summary class="bexp-summary bexp-summary--prompt">Task prompt ({{ msg.content.length }} chars)</summary>
            <pre class="bexp-body bexp-body--prompt">{{ msg.content }}</pre>
          </details>
          <div v-else-if="msg.type === 'text'" class="bexp-line">{{ msg.content }}</div>
          <details v-else-if="msg.type === 'tool'" class="bexp-details">
            <summary class="bexp-summary bexp-summary--tool">Tool: {{ msg.toolName ?? "unknown" }}</summary>
            <pre v-if="msg.content" class="bexp-body">{{ msg.content }}</pre>
          </details>
          <details v-else-if="msg.type === 'tool_result'" class="bexp-details">
            <summary class="bexp-summary bexp-summary--result">Result</summary>
            <pre v-if="msg.content" class="bexp-body bexp-body--result">{{ msg.content }}</pre>
          </details>
          <div v-else-if="msg.type === 'error'" class="bexp-line bexp-line--error">{{ msg.content }}</div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* ---- Root layout ---- */
.bexp-progress {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--chat-bg-terminal, #1e1e1e);
  overflow: hidden;
}

/* ---- Header ---- */
.bexp-progress__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--chat-bg-surface, #2d2d2d);
  border-bottom: 1px solid #3c3c3c;
  flex-shrink: 0;
}

.bexp-progress__status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-family: monospace;
  font-size: 0.85rem;
  color: var(--chat-text-primary, #d4d4d4);
}

.bexp-progress__header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.bexp-context {
  font-family: monospace;
  font-size: 0.7rem;
  white-space: nowrap;
}

/* ---- Status dot ---- */
.bexp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.bexp-dot--active { background: #22c55e; animation: bexp-pulse 1.5s infinite; }
.bexp-dot--stopping { background: #f59e0b; animation: bexp-pulse 1.5s infinite; }
.bexp-dot--completed-success { background: #22c55e; }
.bexp-dot--completed-failure { background: var(--chat-error-color, #f44747); }
.bexp-dot--completed-cancelled { background: #f59e0b; }
.bexp-dot--completed { background: #888; }

@keyframes bexp-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ---- Task cards ---- */
.bexp-cards {
  display: flex;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  overflow-x: auto;
  background: var(--chat-bg-surface, #252525);
  border-bottom: 1px solid #3c3c3c;
  flex-shrink: 0;
}

.bexp-card {
  min-width: 70px;
  padding: 0.3rem 0.6rem;
  border-radius: 6px;
  font-family: monospace;
  font-size: 0.7rem;
  cursor: pointer;
  border: 1px solid #444;
  background: #222;
  transition: border-color 0.2s, box-shadow 0.2s;
}

.bexp-card__id { font-weight: 600; }
.bexp-card__label { color: #888; font-size: 0.65rem; margin-top: 1px; }

.bexp-card--done { border-color: #4caf50; background: rgba(76, 175, 80, 0.1); }
.bexp-card--done .bexp-card__id { color: #4caf50; }

.bexp-card--active { border-color: #2196f3; background: rgba(33, 150, 243, 0.1); }
.bexp-card--active .bexp-card__id { color: #42a5f5; }

.bexp-card--focused { border-width: 2px; box-shadow: 0 0 8px rgba(33, 150, 243, 0.3); }

.bexp-card--skipped { border-color: #78909c; background: rgba(120, 144, 156, 0.1); }
.bexp-card--skipped .bexp-card__id { color: #78909c; }

.bexp-card--error { border-color: #ef5350; background: rgba(239, 83, 80, 0.1); }
.bexp-card--error .bexp-card__id { color: #ef5350; }

.bexp-card--queued { opacity: 0.5; }
.bexp-card--queued.bexp-card--focused { opacity: 1; }

/* ---- Progress bar ---- */
.bexp-progress-bar {
  height: 3px;
  background: #333;
  flex-shrink: 0;
}
.bexp-progress-bar__fill {
  height: 100%;
  background: #4caf50;
  transition: width 0.3s;
}

/* ---- Outcome banner ---- */
.bexp-banner {
  padding: 0.5rem 0.75rem;
  font-family: monospace;
  font-size: 0.8rem;
  flex-shrink: 0;
  border-bottom: 1px solid #3c3c3c;
}
.bexp-banner--success { background: var(--chat-bg-result, #1e2d1e); color: var(--chat-result-color, #6a9955); }
.bexp-banner--error { background: var(--chat-bg-error, #3a1e1e); color: var(--chat-error-color, #f44747); }
.bexp-banner--warning { background: #2d2a1e; color: #f59e0b; }

.bexp-banner__label { font-weight: 600; }
.bexp-banner__stats { margin-left: 0.75rem; opacity: 0.85; font-size: 0.75rem; }

/* ---- Agent output ---- */
.bexp-progress__output {
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

.bexp-progress__output::-webkit-scrollbar { width: 8px; }
.bexp-progress__output::-webkit-scrollbar-track { background: var(--chat-bg-terminal, #1e1e1e); }
.bexp-progress__output::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }

.bexp-progress__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #666;
  font-style: italic;
}

.bexp-slot-label {
  font-size: 0.65rem;
  color: #42a5f5;
  opacity: 0.7;
  margin-bottom: 0.4rem;
}

.bexp-separator {
  padding: 0.5rem 0;
  color: #888;
  font-weight: 600;
  border-top: 1px dashed #444;
  margin-top: 0.5rem;
}

/* ---- Message lines ---- */
.bexp-line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
.bexp-line--error { color: var(--chat-error-color, #f44747); }
.bexp-details { margin: 2px 0; }
.bexp-summary { cursor: pointer; user-select: none; font-weight: 600; }
.bexp-summary--tool { color: var(--chat-tool-color, #569cd6); }
.bexp-summary--result { color: var(--chat-result-color, #6a9955); }
.bexp-summary--prompt { color: var(--chat-prefix-color, #ce9178); }
.bexp-body {
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
.bexp-body--result { background: var(--chat-bg-result, #1e2d1e); }
.bexp-body--prompt { background: var(--chat-bg-surface, #2d2d2d); color: var(--chat-prompt-color, #d4d4d4); }
</style>
