<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { usePersistedRef } from "../composables/usePersistedRef";
import { useExecutionStore } from "../stores/execution";
import { useToast } from "primevue/usetoast";
import TaskContextPanel from "../components/TaskContextPanel.vue";
import EventLogEntry from "../components/EventLogEntry.vue";
import Button from "primevue/button";
import Select from "primevue/select";
import Checkbox from "primevue/checkbox";
import InputNumber from "primevue/inputnumber";
import ProgressBar from "primevue/progressbar";
import Panel from "primevue/panel";
import { FetchAbortGuard, buildModelsUrl, isAbortError, computeVariantOptions, type ModelEntry } from "../components/agent-wizard-logic";

interface ReviewerConfig {
  id: string;
  agent: string;
  model: string;
  variant: string;
}

const execStore = useExecutionStore();
const toast = useToast();

const agent = usePersistedRef("prorab:agent", "claude");
const model = usePersistedRef("prorab:modelFallback", "");
const reviewEnabled = usePersistedRef("prorab:reviewEnabled", true);
const maxRetries = usePersistedRef("prorab:maxRetries", 3);
const maxTurns = usePersistedRef("prorab:maxTurns", 200);
const maxIterations = usePersistedRef<number | null>("prorab:maxIterations", null);
const verbosity = usePersistedRef("prorab:verbosity", "info");
const verbosityOptions = [
  { label: "Info", value: "info" },
  { label: "Debug", value: "debug" },
  { label: "Trace", value: "trace" },
  { label: "Quiet", value: "quiet" },
];
const allowDirty = usePersistedRef("prorab:allowDirty", false);
const userSettings = usePersistedRef("prorab:userSettings", false);
const applyHooks = usePersistedRef("prorab:applyHooks", false);

// --- Reviewer configuration ---
const reviewers = usePersistedRef<ReviewerConfig[]>("prorab:reviewers", [], { deep: true });
const reviewRounds = usePersistedRef("prorab:reviewRounds", 1);
const reviewContext = usePersistedRef("prorab:reviewContext", false);
const reviewerModelLists = ref<Record<string, ModelEntry[]>>({});
const reviewerModelsLoading = ref<Record<string, boolean>>({});
const reviewerFetchGuards = ref<Record<string, FetchAbortGuard>>({});

// Sanitize persisted reviewers: ensure each entry has a valid id
reviewers.value = reviewers.value
  .filter((r): r is ReviewerConfig => r != null && typeof r === "object" && typeof r.agent === "string")
  .map(r => ({
    ...r,
    id: r.id || crypto.randomUUID(),
    model: r.model ?? "",
    variant: r.variant ?? "",
  }));

function addReviewer() {
  reviewers.value.push({
    id: crypto.randomUUID(),
    agent: agent.value,
    model: "",
    variant: "",
  });
}

function removeReviewer(id: string) {
  reviewers.value = reviewers.value.filter(r => r.id !== id);
  delete reviewerModelLists.value[id];
  delete reviewerModelsLoading.value[id];
  reviewerFetchGuards.value[id]?.abort();
  delete reviewerFetchGuards.value[id];
}

async function fetchReviewerModels(reviewerId: string, agentValue: string) {
  if (!reviewerFetchGuards.value[reviewerId]) {
    reviewerFetchGuards.value[reviewerId] = new FetchAbortGuard();
  }
  const guard = reviewerFetchGuards.value[reviewerId];
  const signal = guard.start();

  reviewerModelsLoading.value[reviewerId] = true;
  reviewerModelLists.value[reviewerId] = [];
  try {
    const res = await fetch(buildModelsUrl(agentValue), { signal });
    if (!guard.isCurrent(signal)) return; // superseded
    if (!res.ok) return;
    const data = await res.json();
    if (!guard.isCurrent(signal)) return; // superseded
    reviewerModelLists.value[reviewerId] = data.models;
  } catch (err) {
    if (isAbortError(err)) return;
  } finally {
    if (guard.isCurrent(signal)) {
      reviewerModelsLoading.value[reviewerId] = false;
    }
  }
}

// Cleanup all in-flight reviewer model fetches on unmount
onUnmounted(() => {
  for (const guard of Object.values(reviewerFetchGuards.value)) {
    guard.abort();
  }
});

function reviewerVariantOptions(reviewer: ReviewerConfig): string[] {
  const models = reviewerModelLists.value[reviewer.id] ?? [];
  return computeVariantOptions(models, reviewer.model);
}

// Watcher 1 — agent changes: reset model/variant and fetch models
watch(
  () => reviewers.value.map(r => ({ id: r.id, agent: r.agent })),
  (entries, oldEntries) => {
    for (const { id, agent } of entries) {
      const prev = oldEntries?.find(o => o.id === id);
      if (!prev || prev.agent !== agent) {
        const reviewer = reviewers.value.find(r => r.id === id);
        if (reviewer) {
          reviewer.model = "";
          reviewer.variant = "";
        }
        if (agent) fetchReviewerModels(id, agent);
      }
    }
  },
  { deep: true }
);

// Watcher 2 — model changes: reset variant
watch(
  () => reviewers.value.map(r => ({ id: r.id, model: r.model })),
  (entries, oldEntries) => {
    for (const { id, model } of entries) {
      const prev = oldEntries?.find(o => o.id === id);
      if (prev && prev.model !== model) {
        const reviewer = reviewers.value.find(r => r.id === id);
        if (reviewer) reviewer.variant = "";
      }
    }
  },
  { deep: true }
);

// Watcher 3 — auto-select max variant when reviewer model list loads
watch(
  () => reviewers.value.map(r => ({
    id: r.id,
    variants: reviewerVariantOptions(r),
  })),
  (entries) => {
    for (const { id, variants } of entries) {
      if (variants.length === 0) continue;
      const reviewer = reviewers.value.find(r => r.id === id);
      if (reviewer && !reviewer.variant) {
        reviewer.variant = variants[variants.length - 1];
      }
    }
  },
  { deep: true },
);

// On mount, fetch models for any persisted reviewers that have an agent set
onMounted(() => {
  for (const r of reviewers.value) {
    if (r.agent && !reviewerModelLists.value[r.id]?.length) {
      fetchReviewerModels(r.id, r.agent);
    }
  }
});

const outputEl = ref<HTMLElement | null>(null);

const agentOptions = [
  { label: "Claude", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "CCS", value: "ccs" },
  { label: "Codex", value: "codex" },
];

const isRunning = computed(() => execStore.state !== "idle");
const controlsCollapsed = ref(isRunning.value);
const hasSidebar = computed(() => execStore.taskContext !== null || execStore.taskContextLoading);

// --- Resizable sidebar ---
const sidebarWidth = usePersistedRef("prorab:sidebarWidth", 380);
const isResizing = ref(false);
let cleanupResize: (() => void) | null = null;

function onResizeStart(e: MouseEvent) {
  e.preventDefault();
  isResizing.value = true;
  const startX = e.clientX;
  const startWidth = sidebarWidth.value;

  function onMouseMove(ev: MouseEvent) {
    const delta = startX - ev.clientX;
    sidebarWidth.value = Math.max(200, Math.min(800, startWidth + delta));
  }
  function cleanup() {
    isResizing.value = false;
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", cleanup);
    cleanupResize = null;
  }
  cleanupResize = cleanup;
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", cleanup);
}

onUnmounted(() => {
  cleanupResize?.();
});

const contextPercent = computed(() => {
  const u = execStore.contextUsage;
  if (!u || u.contextWindow === 0) return 0;
  return Math.min(100, Math.round((u.contextTokens / u.contextWindow) * 100));
});

const contextBarColor = computed(() => {
  const p = contextPercent.value;
  if (p >= 60) return "#f44747";
  if (p >= 35) return "#dcdcaa";
  return "#6a9955";
});

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function reviewerContextUsage(reviewerId: string): { contextTokens: number; contextWindow: number } | null {
  const unit = execStore.currentUnit;
  if (!unit) return null;
  return execStore.contextUsageByUnit[`${unit.id}:${reviewerId}`] ?? null;
}

function reviewerContextPercent(reviewerId: string): number | null {
  const usage = reviewerContextUsage(reviewerId);
  if (!usage || usage.contextWindow === 0) return null;
  return Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
}

function reviewerContextColor(reviewerId: string): string {
  const p = reviewerContextPercent(reviewerId);
  if (p === null) return '#969696';
  if (p >= 60) return '#f44747';
  if (p >= 35) return '#dcdcaa';
  return '#6a9955';
}

function reviewerContextLabel(reviewerId: string): string | null {
  const usage = reviewerContextUsage(reviewerId);
  if (!usage) return null;
  const tokens = formatTokens(usage.contextTokens);
  if (usage.contextWindow === 0) return tokens;
  const pct = Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100));
  return `${tokens} (${pct}%)`;
}

const selectedModel = usePersistedRef("prorab:selectedModel", "");
const selectedVariant = usePersistedRef("prorab:selectedVariant", "");

// Computed: variant options for selected model (or common variants when no model selected)
const variantOptions = computed(() =>
  computeVariantOptions(execStore.models, selectedModel.value),
);

// Watch agent changes — fetch models (no immediate: true — load only on explicit change)
watch(agent, (newAgent) => {
  selectedModel.value = "";
  selectedVariant.value = "";
  execStore.fetchModels(newAgent);
});

// Watch model changes — reset variant
watch(selectedModel, () => {
  selectedVariant.value = "";
});

// Auto-select default variant when options become available
watch(variantOptions, (opts) => {
  if (opts.length > 0 && !selectedVariant.value) {
    selectedVariant.value = opts[opts.length - 1];
  }
});

// Fetch models for the default agent on mount; validate persisted selections
onMounted(async () => {
  await execStore.fetchModels(agent.value);
  if (selectedModel.value && !execStore.models.some(m => m.id === selectedModel.value)) {
    selectedModel.value = "";
  }
  if (selectedVariant.value && !variantOptions.value.includes(selectedVariant.value)) {
    selectedVariant.value = "";
  }
});

// Auto-scroll: scroll to bottom when new events arrive or on remount with existing events
function scrollToBottom() {
  nextTick(() => {
    if (outputEl.value) {
      outputEl.value.scrollTop = outputEl.value.scrollHeight;
    }
  });
}

watch(() => execStore.events.length, scrollToBottom);

// Auto-scroll on reviewer tab switch
watch(() => execStore.activeReviewerTab, () => {
  nextTick(() => scrollToBottom());
});

// Auto-scroll when active reviewer tab receives new events
watch(
  () => {
    const tab = execStore.activeReviewerTab;
    return tab ? execStore.reviewerEvents[tab]?.length : 0;
  },
  scrollToBottom,
);

onMounted(() => {
  // Scroll to bottom on remount if events already exist (navigated away and back)
  if (execStore.events.length > 0) {
    scrollToBottom();
  }
});

async function start() {
  try {
    // Filter reviewers: only include rows with agent set (model is optional — backend uses default)
    const validReviewers = reviewEnabled.value
      ? reviewers.value
          .filter(r => r.agent)
          .map(r => ({
            agent: r.agent,
            model: r.model || undefined,
            variant: r.variant || undefined,
          }))
      : undefined;

    controlsCollapsed.value = true;
    await execStore.startExecution({
      agent: agent.value,
      model: execStore.models.length > 0 ? (selectedModel.value || undefined) : (model.value || undefined),
      variant: selectedVariant.value || undefined,
      review: reviewEnabled.value,
      reviewers: validReviewers && validReviewers.length > 0 ? validReviewers : undefined,
      reviewRounds: reviewEnabled.value ? reviewRounds.value : 1,
      reviewContext: reviewEnabled.value ? reviewContext.value : false,
      maxRetries: maxRetries.value,
      maxTurns: maxTurns.value,
      maxIterations: maxIterations.value ?? undefined,
      debug: verbosity.value === "debug",
      trace: verbosity.value === "trace",
      quiet: verbosity.value === "quiet",
      allowDirty: allowDirty.value,
      userSettings: userSettings.value,
      applyHooks: applyHooks.value || undefined,
    });
  } catch (error: unknown) {
    toast.add({ severity: "error", summary: "Execution Error", detail: error instanceof Error ? error.message : String(error), life: 5000 });
  }
}

async function stop() {
  try {
    await execStore.stopExecution();
  } catch (error: unknown) {
    toast.add({ severity: "error", summary: "Stop Error", detail: error instanceof Error ? error.message : String(error), life: 5000 });
  }
}

async function toggleGracefulStop() {
  try {
    if (execStore.gracefulStop) {
      await execStore.cancelGracefulStop();
    } else {
      await execStore.requestGracefulStop();
    }
  } catch (error: unknown) {
    toast.add({ severity: "error", summary: "Graceful Stop Error", detail: error instanceof Error ? error.message : String(error), life: 5000 });
  }
}
</script>

<template>
  <div
    class="execution-view"
    :class="{ 'no-sidebar': !hasSidebar, resizing: isResizing }"
    :style="hasSidebar ? { gridTemplateColumns: `1fr ${sidebarWidth}px` } : undefined"
  >
    <div class="controls-bar">
      <Panel toggleable v-model:collapsed="controlsCollapsed">
        <template #header>
          <div class="config-panel-header">
            <span class="config-panel-title">Configuration</span>
            <Button
              :icon="controlsCollapsed ? 'pi pi-chevron-down' : 'pi pi-chevron-up'"
              :label="controlsCollapsed ? 'Show' : 'Hide'"
              size="small"
              text
              @click="controlsCollapsed = !controlsCollapsed"
            />
          </div>
        </template>
        <div class="controls-row">
          <div class="control-field">
            <label>Agent</label>
            <Select v-model="agent" :options="agentOptions" optionLabel="label" optionValue="value" :disabled="isRunning" />
          </div>
          <div class="control-field model-field">
            <label>Model</label>
            <Select
              v-if="execStore.models.length > 0 || execStore.modelsLoading"
              v-model="selectedModel"
              :options="execStore.models"
              optionLabel="name"
              optionValue="id"
              :disabled="isRunning"
              :loading="execStore.modelsLoading"
              placeholder="Default (auto)"
              showClear
              filter
              filterPlaceholder="Search models..."
              :virtualScrollerOptions="execStore.models.length > 30 ? { itemSize: 38 } : undefined"
            />
            <input v-else v-model="model" :placeholder="execStore.modelsError ? 'Optional (loading failed)' : 'Optional'" class="text-input" :disabled="isRunning" />
          </div>
          <div v-if="variantOptions.length > 0" class="control-field variant-field">
            <label>{{ agent === 'claude' || agent === 'ccs' ? 'Effort' : 'Variant' }}</label>
            <Select
              v-model="selectedVariant"
              :options="[{ label: 'Default', value: '' }, ...variantOptions.map(v => ({ label: v, value: v }))]"
              optionLabel="label"
              optionValue="value"
              :disabled="isRunning"
            />
          </div>
        </div>

        <div class="controls-row">
          <div class="control-field numeric-field">
            <label>Max retries</label>
            <InputNumber v-model="maxRetries" :min="1" :max="99" :disabled="isRunning" />
          </div>
          <div class="control-field numeric-field">
            <label>Max turns</label>
            <InputNumber v-model="maxTurns" :min="1" :max="9999" :disabled="isRunning" />
          </div>
          <div class="control-field numeric-field">
            <label>Max iterations</label>
            <InputNumber v-model="maxIterations" :min="1" placeholder="∞" :disabled="isRunning" />
          </div>
        </div>

        <div class="controls-row checkboxes">
          <div class="control-field">
            <label>Verbosity</label>
            <Select v-model="verbosity" :options="verbosityOptions" optionLabel="label" optionValue="value" :disabled="isRunning" />
          </div>
          <label class="checkbox-field"><Checkbox v-model="allowDirty" :binary="true" :disabled="isRunning" /> Allow dirty</label>
          <label v-if="agent === 'claude' || agent === 'ccs'" class="checkbox-field"><Checkbox v-model="userSettings" :binary="true" :trueValue="false" :falseValue="true" :disabled="isRunning" /> No user settings</label>
          <label v-if="agent === 'ccs'" class="checkbox-field"><Checkbox v-model="applyHooks" :binary="true" :disabled="isRunning" /> Apply hooks</label>
          <label class="checkbox-field"><Checkbox v-model="reviewEnabled" :binary="true" :disabled="isRunning" /> Review enabled</label>
          <div v-if="reviewEnabled" class="review-rounds-inline">
            <Button icon="pi pi-minus" size="small" text :disabled="isRunning || reviewRounds <= 1" @click="reviewRounds = Math.max(1, reviewRounds - 1)" class="rounds-btn" />
            <span class="rounds-value">{{ reviewRounds }}</span>
            <Button icon="pi pi-plus" size="small" text :disabled="isRunning || reviewRounds >= 10" @click="reviewRounds = Math.min(10, reviewRounds + 1)" class="rounds-btn" />
            <span class="rounds-label">rounds</span>
          </div>
          <label v-if="reviewEnabled && reviewRounds > 1" class="checkbox-field">
            <Checkbox v-model="reviewContext" :binary="true" :disabled="isRunning" />
            Pass context from previous rounds
          </label>
        </div>

        <div v-if="reviewEnabled" class="reviewer-config">
          <div class="reviewer-header">
            <label class="reviewer-title">Reviewers</label>
            <Button label="Add reviewer" icon="pi pi-plus" size="small" text @click="addReviewer" :disabled="isRunning || reviewers.length >= 10" />
          </div>
          <div v-for="reviewer in reviewers" :key="reviewer.id" class="reviewer-row">
            <div class="control-field">
              <label>Agent</label>
              <Select
                v-model="reviewer.agent"
                :options="agentOptions"
                optionLabel="label"
                optionValue="value"
                :disabled="isRunning"
                placeholder="Agent"
              />
            </div>
            <div class="control-field reviewer-model-field">
              <label>Model</label>
              <Select
                v-model="reviewer.model"
                :options="reviewerModelLists[reviewer.id] ?? []"
                optionLabel="name"
                optionValue="id"
                :disabled="isRunning"
                :loading="reviewerModelsLoading[reviewer.id]"
                placeholder="Default (auto)"
                showClear
                filter
                filterPlaceholder="Search models..."
              />
            </div>
            <div v-if="reviewerVariantOptions(reviewer).length > 0" class="control-field">
              <label>{{ reviewer.agent === 'claude' || reviewer.agent === 'ccs' ? 'Effort' : 'Variant' }}</label>
              <Select
                v-model="reviewer.variant"
                :options="[{ label: 'Default', value: '' }, ...reviewerVariantOptions(reviewer).map(v => ({ label: v, value: v }))]"
                optionLabel="label"
                optionValue="value"
                :disabled="isRunning"
              />
            </div>
            <Button icon="pi pi-trash" severity="danger" text size="small" @click="removeReviewer(reviewer.id)" :disabled="isRunning" class="reviewer-delete-btn" />
          </div>
          <div v-if="reviewers.length === 0" class="reviewer-empty">
            No reviewers configured. Default review agent will be used.
          </div>
        </div>
      </Panel>

      <div class="controls-row">
        <Button label="Start" icon="pi pi-play" @click="start" :disabled="isRunning" />
        <Button label="Stop" icon="pi pi-stop" severity="danger" @click="stop" :disabled="execStore.state !== 'running'" />
        <Button
          :label="execStore.gracefulStop ? 'Cancel Graceful Stop' : 'Stop After This'"
          :icon="execStore.gracefulStop ? 'pi pi-undo' : 'pi pi-clock'"
          :severity="execStore.gracefulStop ? 'secondary' : 'warn'"
          @click="toggleGracefulStop"
          :disabled="execStore.state !== 'running'"
          data-testid="graceful-stop-button"
        />
      </div>
    </div>

    <div v-if="execStore.currentUnit" class="current-unit">
      <div class="unit-info">
        Running: <strong>#{{ execStore.currentUnit.id }}</strong>
        <span v-if="execStore.currentUnit.title"> "{{ execStore.currentUnit.title }}"</span>
      </div>
      <div v-if="execStore.contextUsage" class="context-usage">
        <span class="context-label">Context</span>
        <span class="context-tokens">{{ formatTokens(execStore.contextUsage.contextTokens) }} / {{ formatTokens(execStore.contextUsage.contextWindow) }}</span>
        <ProgressBar
          :value="contextPercent"
          :showValue="false"
          :style="{ width: '120px', height: '16px', '--p-progressbar-value-background': contextBarColor }"
        />
        <span class="context-percent">{{ contextPercent }}%</span>
      </div>
    </div>

    <!-- Multi-review tabs -->
    <div v-if="execStore.reviewerTabs.length > 0" class="reviewer-tabs-container">
      <div class="reviewer-tabs-bar">
        <button
          v-for="tabId in execStore.reviewerTabs"
          :key="tabId"
          class="reviewer-tab"
          :class="{
            active: execStore.activeReviewerTab === tabId,
            complete: execStore.reviewerStatuses[tabId] === 'complete',
            'has-error': execStore.reviewerStatuses[tabId] && execStore.reviewerStatuses[tabId] !== 'complete',
          }"
          @click="execStore.activeReviewerTab = tabId"
        >
          {{ tabId }}
          <span v-if="reviewerContextLabel(tabId)"
                class="tab-context"
                :style="{ color: reviewerContextColor(tabId) }">
            {{ reviewerContextLabel(tabId) }}
          </span>
          <span
            v-if="execStore.reviewerStatuses[tabId]"
            class="status-dot"
            :class="execStore.reviewerStatuses[tabId] === 'complete' ? 'dot-green' : 'dot-red'"
          />
          <span class="tab-close" @click.stop="execStore.closeReviewerTab(tabId)">&times;</span>
        </button>
      </div>
      <div ref="outputEl" class="agent-output">
        <div
          v-for="(event, i) in (execStore.reviewerEvents[execStore.activeReviewerTab ?? ''] ?? [])"
          :key="i"
          class="event-line"
          :class="event.type"
        >
          <EventLogEntry :event="event" />
        </div>
      </div>
      <div v-if="execStore.error" class="event-line error" style="padding: 0.5rem 0.75rem;">
        <span class="event-prefix">[error]</span>
        <span>{{ execStore.error }}</span>
      </div>
    </div>

    <!-- Single output (no tabs) -->
    <div v-else ref="outputEl" class="agent-output">
      <div v-for="(event, i) in execStore.events" :key="i" class="event-line" :class="event.type">
        <EventLogEntry :event="event" />
      </div>
      <div v-if="execStore.error" class="event-line error">
        <span class="event-prefix">[error]</span>
        <span>{{ execStore.error }}</span>
      </div>
      <div v-if="execStore.events.length === 0 && execStore.state === 'idle' && !execStore.error" class="no-events">
        No execution output yet. Configure options above and click Run.
      </div>
    </div>

    <div v-if="hasSidebar" class="sidebar-resize-handle" @mousedown="onResizeStart" />
    <div v-if="hasSidebar" class="task-sidebar">
      <div v-if="execStore.taskContextLoading && !execStore.taskContext" class="sidebar-loading">
        Loading task context...
      </div>
      <TaskContextPanel v-if="execStore.taskContext" :context="execStore.taskContext" />
    </div>
  </div>
</template>

<style scoped>
.execution-view {
  display: grid;
  grid-template-columns: 1fr 380px;
  grid-template-rows: auto auto 1fr;
  height: var(--app-content-height, 100vh);
  overflow: hidden;
}
.execution-view.no-sidebar {
  grid-template-columns: 1fr;
}
.execution-view.resizing {
  user-select: none;
  cursor: col-resize;
}
.controls-bar {
  grid-column: 1;
  padding: 1rem;
  background: #fafafa;
  border-bottom: 1px solid #e5e5e5;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}
.controls-row {
  display: flex;
  gap: 1rem;
  align-items: end;
  flex-wrap: wrap;
}
.control-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}
.model-field {
  flex: 1;
  min-width: 200px;
}
.variant-field {
  min-width: 100px;
  flex-shrink: 0;
}
.numeric-field {
  flex-shrink: 0;
  width: 7rem;
}
.numeric-field :deep(.p-inputnumber) {
  width: 100%;
}
.numeric-field :deep(.p-inputnumber-input) {
  width: 100%;
}
.control-field label {
  font-size: 0.75rem;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
}
.text-input {
  padding: 0.5rem;
  border: 1px solid #ddd;
  border-radius: 4px;
  font-size: 0.875rem;
}
.checkboxes {
  align-items: end;
}
.checkboxes .checkbox-field {
  margin-bottom: 0.45rem;
}
.checkboxes .review-rounds-inline {
  margin-bottom: 0.25rem;
}
.checkbox-field {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.875rem;
  cursor: pointer;
}
.current-unit {
  grid-column: 1;
  padding: 0.5rem 1rem;
  background: #eff6ff;
  border-bottom: 1px solid #dbeafe;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  min-width: 0;
}
.unit-info {
  flex-shrink: 0;
}
.context-usage {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
}
.context-label {
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
  font-size: 0.7rem;
}
.context-tokens {
  color: #475569;
  font-family: monospace;
  font-size: 0.75rem;
}
.context-percent {
  font-weight: 600;
  font-size: 0.75rem;
  color: #475569;
  min-width: 2.5em;
}
.agent-output {
  grid-column: 1;
  grid-row: 3;
  font-family: monospace;
  font-size: 0.8rem;
  overflow-y: auto;
  background: #1e1e1e;
  color: #d4d4d4;
  padding: 0.75rem;
  min-height: 0;
  min-width: 0;
}
.sidebar-resize-handle {
  grid-column: 2;
  grid-row: 1 / -1;
  width: 5px;
  justify-self: start;
  cursor: col-resize;
  background: transparent;
  z-index: 10;
}
.sidebar-resize-handle:hover,
.execution-view.resizing .sidebar-resize-handle {
  background: #007acc;
}
.task-sidebar {
  grid-column: 2;
  grid-row: 1 / -1;
  border-left: 1px solid #e5e5e5;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 1rem;
  background: #fafafa;
  min-height: 0;
  min-width: 0;
}
.sidebar-loading {
  color: #94a3b8;
  font-size: 0.85rem;
  font-style: italic;
}
.event-line { padding: 2px 0; white-space: pre-wrap; word-break: break-all; }
.event-line.tool { color: #569cd6; }
.event-line.tool_result { color: #6a9955; }
.event-line.text { color: #d4d4d4; }
.event-line.error { color: #f44747; }
.event-line :deep(.event-prefix) { color: #ce9178; margin-right: 0.5rem; }
.event-prefix { color: #ce9178; margin-right: 0.5rem; }
.no-events { color: #666; font-style: italic; }

/* Prompt collapsible blocks (inside EventLogEntry child component) */
.event-line :deep(.prompt-details) {
  margin: 2px 0;
}
.event-line :deep(.prompt-summary) {
  color: #ce9178;
  cursor: pointer;
  user-select: none;
}
.event-line :deep(.prompt-summary:hover) {
  color: #e0a98a;
}
.event-line :deep(.prompt-body) {
  color: #9cdcfe;
  background: #2d2d2d;
  padding: 0.5rem;
  margin: 0.25rem 0 0;
  border-radius: 4px;
  max-height: 400px;
  overflow-y: auto;
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Collapsible configuration panel */
.controls-bar :deep(.p-panel) {
  border: none;
  background: transparent;
  box-shadow: none;
}
.controls-bar :deep(.p-panel-header) {
  background: transparent;
  padding: 0 0 0.5rem 0;
  border: none;
  font-size: 0.75rem;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
}
.controls-bar :deep(.p-panel-content) {
  padding: 0;
  border: none;
  background: transparent;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-height: 50vh;
  overflow-y: auto;
}
.controls-bar :deep(.p-panel-header-actions) {
  display: none;
}
.config-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.config-panel-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
}

/* Review rounds inline stepper */
.review-rounds-inline {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  flex-shrink: 0;
  padding-bottom: 0.2rem;
}
.rounds-btn {
  width: 1.4rem !important;
  height: 1.4rem !important;
  padding: 0 !important;
  border: 1px solid #ddd !important;
  border-radius: 3px !important;
  background: #fff !important;
  color: #555 !important;
}
.rounds-btn :deep(.p-button-icon) {
  font-size: 0.65rem;
}
.rounds-btn:hover:not(:disabled) {
  background: #f0f0f0 !important;
  border-color: #bbb !important;
}
.rounds-btn:disabled {
  opacity: 0.4;
}
.rounds-value {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.4rem;
  height: 1.4rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #333;
  border: 1px solid #ddd;
  border-radius: 3px;
  background: #fff;
}
.rounds-label {
  font-size: 0.875rem;
  color: inherit;
  margin-left: 0.15rem;
}

/* Reviewer configuration */
.reviewer-config {
  border: 1px solid #e5e5e5;
  border-radius: 6px;
  padding: 0.75rem;
  background: #f5f5f5;
}
.reviewer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}
.reviewer-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
}
.reviewer-row {
  display: flex;
  gap: 0.75rem;
  align-items: end;
  margin-bottom: 0.5rem;
  flex-wrap: wrap;
}
.reviewer-model-field {
  flex: 1;
  min-width: 180px;
}
.reviewer-delete-btn {
  align-self: end;
  margin-bottom: 2px;
}
.reviewer-empty {
  font-size: 0.8rem;
  color: #999;
  font-style: italic;
}

/* Multi-review output tabs */
.reviewer-tabs-container {
  grid-column: 1;
  grid-row: 3;
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.reviewer-tabs-container .agent-output {
  grid-column: unset;
  grid-row: unset;
  flex: 1;
}
.reviewer-tabs-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  background: #252526;
  border-bottom: 1px solid #3c3c3c;
  flex-shrink: 0;
}
.reviewer-tab {
  padding: 0.4rem 0.75rem;
  background: transparent;
  color: #969696;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  font-family: monospace;
  font-size: 0.75rem;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.reviewer-tab:hover {
  color: #d4d4d4;
}
.reviewer-tab.active {
  color: #d4d4d4;
  border-bottom-color: #007acc;
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  display: inline-block;
}
.dot-green { background: #6a9955; }
.dot-red { background: #f44747; }
.reviewer-tab.complete { color: #6a9955; }
.reviewer-tab.has-error { color: #f44747; }
.tab-close {
  font-size: 0.85rem;
  line-height: 1;
  opacity: 0;
  color: #969696;
  margin-left: 0.15rem;
  padding: 0 2px;
  border-radius: 3px;
}
.tab-close:hover {
  color: #fff;
  background: #505050;
}
.reviewer-tab:hover .tab-close {
  opacity: 1;
}
.tab-context {
  font-size: 0.65rem;
  font-family: monospace;
  opacity: 0.85;
}
</style>
