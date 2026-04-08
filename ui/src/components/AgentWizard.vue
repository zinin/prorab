<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import Select from "primevue/select";
import InputText from "primevue/inputtext";
import Button from "primevue/button";
import Textarea from "primevue/textarea";
import Checkbox from "primevue/checkbox";
import Tooltip from "primevue/tooltip";
import {
  computeVariantOptions,
  createModelsFetcher,
  type ModelEntry,
  type ModelsFetcher,
} from "./agent-wizard-logic";
import { useSessionDefaults } from "../composables/useSessionDefaults";

const vTooltip = Tooltip;

const props = withDefaults(
  defineProps<{
    /** Wizard mode: 'chat' shows textarea for initial message; 'parse-prd' hides it; 'refine-tasks' shows only refine-tasks steps. */
    mode?: "chat" | "parse-prd" | "refine-tasks";
    /** True while the parent is executing the two-step start flow (startChat → sendMessage). */
    starting?: boolean;
  }>(),
  { mode: "chat" },
);

const emit = defineEmits<{
  start: [config: { agent: string; model?: string; variant?: string; initialMessage?: string; responseLanguage?: string; verbosity?: string; userSettings?: boolean; applyHooks?: boolean; refinePrdSteps?: { agent: string; model?: string; variant?: string }[]; refineTasksSteps?: { agent: string; model?: string; variant?: string }[] }];
}>();

const sessionDefaults = useSessionDefaults();

interface RefineStep {
  id: number;
  agent: string;
  model: string;
  variant: string;
  models: ModelEntry[];
  modelsLoading: boolean;
  fetchError: boolean;
}

let refineStepId = 0;
const refineSteps = ref<RefineStep[]>([]);
const stepFetchers = new Map<number, ModelsFetcher>();
/** Track previous agent per step to detect changes. */
const stepPrevAgents = new Map<number, string>();

function addRefineStep() {
  if (refineSteps.value.length >= 20) return;
  const id = ++refineStepId;
  refineSteps.value.push({
    id,
    agent: "claude",
    model: "",
    variant: "",
    models: [],
    modelsLoading: false,
    fetchError: false,
  });
  // Get the reactive proxy from the array (not the raw object)
  // so that mutations in fetchStepModels trigger Vue reactivity
  const step = refineSteps.value[refineSteps.value.length - 1]!;

  const fetcher = createModelsFetcher(fetch.bind(globalThis));
  stepFetchers.set(id, fetcher);
  stepPrevAgents.set(id, step.agent);
  fetchStepModels(step, fetcher);
}

function removeRefineStep(id: number) {
  refineSteps.value = refineSteps.value.filter(s => s.id !== id);
  stepFetchers.get(id)?.abort();
  stepFetchers.delete(id);
  stepPrevAgents.delete(id);
}

function moveRefineStep(index: number, dir: -1 | 1) {
  const arr = [...refineSteps.value];
  const target = index + dir;
  if (target < 0 || target >= arr.length) return;
  [arr[index]!, arr[target]!] = [arr[target]!, arr[index]!];
  refineSteps.value = arr;
}

async function fetchStepModels(step: RefineStep, fetcher: ModelsFetcher) {
  step.modelsLoading = true;
  step.fetchError = false;
  step.models = [];
  const result = await fetcher(step.agent);
  if (!result.superseded) {
    step.models = result.models;
    step.fetchError = !!result.error;
    step.modelsLoading = false;
    // Auto-select last variant when models load
    const opts = computeVariantOptions(step.models, step.model);
    if (opts.length > 0 && !step.variant) {
      step.variant = opts[opts.length - 1];
    }
  }
}

function onStepAgentChange(step: RefineStep) {
  const prev = stepPrevAgents.get(step.id);
  if (prev === step.agent) return;
  stepPrevAgents.set(step.id, step.agent);
  step.model = "";
  step.variant = "";
  const fetcher = stepFetchers.get(step.id);
  if (fetcher) fetchStepModels(step, fetcher);
}

function onStepModelChange(step: RefineStep) {
  step.variant = "";
  // Auto-select last variant for new model
  const opts = computeVariantOptions(step.models, step.model);
  if (opts.length > 0) {
    step.variant = opts[opts.length - 1];
  }
}

function stepVariantOptions(step: RefineStep): string[] {
  return computeVariantOptions(step.models, step.model);
}

function stepVariantLabel(step: RefineStep): string {
  return step.agent === "claude" || step.agent === "ccs" ? "Effort" : "Variant";
}

function retryStepModels(step: RefineStep) {
  const fetcher = stepFetchers.get(step.id);
  if (fetcher) fetchStepModels(step, fetcher);
}

// --- Refine-tasks steps (post-generation task refinement) ---
let refineTasksStepId = 0;
const refineTasksSteps = ref<RefineStep[]>([]);
const refineTasksStepFetchers = new Map<number, ModelsFetcher>();
const refineTasksStepPrevAgents = new Map<number, string>();

function addRefineTasksStep() {
  if (refineTasksSteps.value.length >= 20) return;
  const id = ++refineTasksStepId;
  refineTasksSteps.value.push({
    id,
    agent: "claude",
    model: "",
    variant: "",
    models: [],
    modelsLoading: false,
    fetchError: false,
  });
  const step = refineTasksSteps.value[refineTasksSteps.value.length - 1]!;
  const fetcher = createModelsFetcher(fetch.bind(globalThis));
  refineTasksStepFetchers.set(id, fetcher);
  refineTasksStepPrevAgents.set(id, step.agent);
  fetchStepModels(step, fetcher);
}

function removeRefineTasksStep(id: number) {
  refineTasksSteps.value = refineTasksSteps.value.filter(s => s.id !== id);
  refineTasksStepFetchers.get(id)?.abort();
  refineTasksStepFetchers.delete(id);
  refineTasksStepPrevAgents.delete(id);
}

function moveRefineTasksStep(index: number, dir: -1 | 1) {
  const arr = [...refineTasksSteps.value];
  const target = index + dir;
  if (target < 0 || target >= arr.length) return;
  [arr[index]!, arr[target]!] = [arr[target]!, arr[index]!];
  refineTasksSteps.value = arr;
}

function onRefineTasksStepAgentChange(step: RefineStep) {
  const prev = refineTasksStepPrevAgents.get(step.id);
  if (prev === step.agent) return;
  refineTasksStepPrevAgents.set(step.id, step.agent);
  step.model = "";
  step.variant = "";
  const fetcher = refineTasksStepFetchers.get(step.id);
  if (fetcher) fetchStepModels(step, fetcher);
}

function onRefineTasksStepModelChange(step: RefineStep) {
  step.variant = "";
  const opts = computeVariantOptions(step.models, step.model);
  if (opts.length > 0) {
    step.variant = opts[opts.length - 1];
  }
}

function retryRefineTasksStepModels(step: RefineStep) {
  const fetcher = refineTasksStepFetchers.get(step.id);
  if (fetcher) fetchStepModels(step, fetcher);
}

const agent = ref(sessionDefaults.value.agent || "claude");
const model = ref(sessionDefaults.value.model || "");
const variant = ref(sessionDefaults.value.variant || "");
const responseLanguage = ref("");
const verbosity = ref(sessionDefaults.value.verbosity || "trace");
const noUserSettings = ref(!sessionDefaults.value.userSettings);
const applyHooks = ref(sessionDefaults.value.applyHooks ?? false);
const verbosityOptions = [
  { label: "Trace", value: "trace" },
  { label: "Debug", value: "debug" },
  { label: "Info", value: "info" },
  { label: "Quiet", value: "quiet" },
];
const message = ref("");
const models = ref<ModelEntry[]>([]);
const modelsLoading = ref(false);
const fetchError = ref(false);

const agentOptions = [
  { label: "Claude", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "CCS", value: "ccs" },
  { label: "Codex", value: "codex" },
];

const variantOptions = computed(() =>
  computeVariantOptions(models.value, model.value),
);

const canSubmit = computed(() => {
  if (props.starting) return false;
  if (props.mode === "refine-tasks") return refineTasksSteps.value.length > 0;
  if (modelsLoading.value) return false;
  if (props.mode === "parse-prd") return true;
  return message.value.trim().length > 0;
});

const wizardTitle = computed(() => {
  if (props.mode === "parse-prd") return "Generate Tasks";
  if (props.mode === "refine-tasks") return "Refine Tasks";
  return "New Chat";
});

const submitLabel = computed(() => {
  if (props.mode === "refine-tasks") return props.starting ? "Refining..." : "Refine Tasks";
  if (props.starting) return props.mode === "parse-prd" ? "Generating..." : "Starting...";
  return props.mode === "parse-prd" ? "Generate" : "Start";
});

const fetchModelsImpl = createModelsFetcher(fetch.bind(globalThis));

async function fetchModels(agentValue: string) {
  modelsLoading.value = true;
  fetchError.value = false;
  models.value = [];
  const result = await fetchModelsImpl(agentValue);
  if (!result.superseded) {
    models.value = result.models;
    fetchError.value = !!result.error;
    modelsLoading.value = false;
  }
}

onUnmounted(() => {
  fetchModelsImpl.abort();
  for (const fetcher of stepFetchers.values()) fetcher.abort();
  stepFetchers.clear();
  for (const fetcher of refineTasksStepFetchers.values()) fetcher.abort();
  refineTasksStepFetchers.clear();
});

// Watch agent changes — reset model/variant and fetch models
watch(agent, (newAgent) => {
  model.value = "";
  variant.value = "";
  applyHooks.value = false;
  fetchModels(newAgent);
});

// Watch model changes — reset variant
watch(model, () => {
  variant.value = "";
});

// Auto-select default variant when options become available
watch(variantOptions, (opts) => {
  if (opts.length > 0 && !variant.value) {
    variant.value = opts[opts.length - 1];
  }
});

// Fetch models for the default agent on mount
onMounted(() => {
  fetchModels(agent.value);
});

function retryModels() {
  fetchModels(agent.value);
}

function onSubmit() {
  if (!canSubmit.value) return;

  // Persist current selections for next session (skip for refine-tasks — no top-level agent/model)
  if (props.mode !== "refine-tasks") {
    sessionDefaults.value = {
      agent: agent.value,
      model: model.value,
      variant: variant.value,
      verbosity: verbosity.value,
      userSettings: !noUserSettings.value,
      applyHooks: applyHooks.value,
    };
  }

  if (props.mode === "refine-tasks") {
    // Standalone refine-tasks mode — emit only refine-tasks-specific fields
    const payload: { refineTasksSteps: { agent: string; model?: string; variant?: string }[]; verbosity?: string; responseLanguage?: string; userSettings?: boolean; applyHooks?: boolean } = {
      refineTasksSteps: refineTasksSteps.value.map(s => ({
        agent: s.agent,
        model: s.model || undefined,
        variant: s.variant || undefined,
      })),
      verbosity: verbosity.value,
      userSettings: !noUserSettings.value,
    };
    if (responseLanguage.value.trim()) {
      payload.responseLanguage = responseLanguage.value.trim();
    }
    emit("start", payload as any);
    return;
  }

  const payload: { agent: string; model?: string; variant?: string; initialMessage?: string; responseLanguage?: string; verbosity?: string; userSettings?: boolean; applyHooks?: boolean; refinePrdSteps?: { agent: string; model?: string; variant?: string }[]; refineTasksSteps?: { agent: string; model?: string; variant?: string }[] } = {
    agent: agent.value,
    model: model.value || undefined,
    variant: variant.value || undefined,
    userSettings: !noUserSettings.value,
  };
  if (agent.value === "ccs") {
    payload.applyHooks = applyHooks.value;
  }
  if (props.mode === "parse-prd") {
    if (responseLanguage.value.trim()) {
      payload.responseLanguage = responseLanguage.value.trim();
    }
    payload.verbosity = verbosity.value;
    if (refineSteps.value.length > 0) {
      payload.refinePrdSteps = refineSteps.value.map(s => ({
        agent: s.agent,
        model: s.model || undefined,
        variant: s.variant || undefined,
      }));
    }
    if (refineTasksSteps.value.length > 0) {
      payload.refineTasksSteps = refineTasksSteps.value.map(s => ({
        agent: s.agent,
        model: s.model || undefined,
        variant: s.variant || undefined,
      }));
    }
  } else {
    payload.initialMessage = message.value.trim();
  }
  emit("start", payload);
}
</script>

<template>
  <div class="agent-wizard" data-testid="agent-wizard">
    <div class="wizard-card">
      <h2 class="wizard-title" data-testid="wizard-title">{{ wizardTitle }}</h2>

      <!-- Refine PRD section (parse-prd mode only) -->
      <div v-if="mode === 'parse-prd'" class="wizard-section">
        <div class="wizard-section-header">
          <span class="wizard-section-label">Refine PRD before generating</span>
          <span class="wizard-section-hint">optional</span>
        </div>

        <div v-for="(step, idx) in refineSteps" :key="step.id" class="refine-step-card">
          <div class="refine-step-header">
            <span class="refine-step-label">Step {{ idx + 1 }}</span>
            <div class="refine-step-actions">
              <Button icon="pi pi-arrow-up" text size="small" :disabled="idx === 0" @click="moveRefineStep(idx, -1)" />
              <Button icon="pi pi-arrow-down" text size="small" :disabled="idx === refineSteps.length - 1" @click="moveRefineStep(idx, 1)" />
              <Button icon="pi pi-times" text severity="danger" size="small" @click="removeRefineStep(step.id)" />
            </div>
          </div>
          <div class="refine-step-fields">
            <div class="wizard-field refine-step-field">
              <label>Agent</label>
              <Select
                v-model="step.agent"
                :options="agentOptions"
                optionLabel="label"
                optionValue="value"
                class="wizard-select"
                :data-testid="`refine-step-${idx}-agent`"
                @change="onStepAgentChange(step)"
              />
            </div>
            <div class="wizard-field refine-step-field">
              <label>Model</label>
              <Select
                v-model="step.model"
                :options="step.models"
                optionLabel="name"
                optionValue="id"
                :loading="step.modelsLoading"
                placeholder="Default (auto)"
                showClear
                filter
                filterPlaceholder="Search models..."
                class="wizard-select"
                :data-testid="`refine-step-${idx}-model`"
                :virtualScrollerOptions="step.models.length > 30 ? { itemSize: 38 } : undefined"
                @change="onStepModelChange(step)"
              />
              <small v-if="step.fetchError" class="wizard-error">
                Failed to load models.
                <a href="#" class="wizard-retry" @click.prevent="retryStepModels(step)">Retry</a>
              </small>
            </div>
            <div v-if="stepVariantOptions(step).length > 0" class="wizard-field refine-step-field">
              <label>{{ stepVariantLabel(step) }}</label>
              <Select
                v-model="step.variant"
                :options="[{ label: 'Default', value: '' }, ...stepVariantOptions(step).map(v => ({ label: v, value: v }))]"
                optionLabel="label"
                optionValue="value"
                class="wizard-select"
              />
            </div>
          </div>
        </div>

        <Button label="+ Add refine step" text size="small" @click="addRefineStep" :disabled="refineSteps.length >= 20" v-tooltip.bottom="refineSteps.length >= 20 ? 'Maximum 20 steps' : undefined" class="refine-add-btn" />

        <hr class="wizard-divider" />
      </div>

      <!-- Generate Tasks agent/model/variant (parse-prd and chat modes only) -->
      <template v-if="mode !== 'refine-tasks'">
        <div v-if="mode === 'parse-prd'" class="wizard-section-header">
          <span class="wizard-section-label">Generate Tasks</span>
        </div>

        <div class="wizard-field">
          <label>Agent</label>
          <Select
            v-model="agent"
            :options="agentOptions"
            optionLabel="label"
            optionValue="value"
            class="wizard-select"
            data-testid="wizard-agent-select"
          />
        </div>

        <div class="wizard-field">
          <label>Model</label>
          <Select
            v-model="model"
            :options="models"
            optionLabel="name"
            optionValue="id"
            :loading="modelsLoading"
            placeholder="Default (auto)"
            showClear
            filter
            filterPlaceholder="Search models..."
            class="wizard-select"
            :virtualScrollerOptions="models.length > 30 ? { itemSize: 38 } : undefined"
            data-testid="wizard-model-select"
          />
          <small v-if="fetchError" class="wizard-error">
            Failed to load models.
            <a href="#" class="wizard-retry" @click.prevent="retryModels">Retry</a>
          </small>
        </div>

        <div v-if="variantOptions.length > 0" class="wizard-field">
          <label>{{ agent === 'claude' || agent === 'ccs' ? 'Effort' : 'Variant' }}</label>
          <Select
            v-model="variant"
            :options="[{ label: 'Default', value: '' }, ...variantOptions.map(v => ({ label: v, value: v }))]"
            optionLabel="label"
            optionValue="value"
            class="wizard-select"
            data-testid="wizard-variant-select"
          />
        </div>
      </template>

      <!-- Refine tasks section (parse-prd: optional post-generation; refine-tasks: main content) -->
      <div v-if="mode === 'parse-prd' || mode === 'refine-tasks'" class="wizard-section" :style="mode === 'parse-prd' ? 'margin-top: 0.5rem' : undefined">
        <hr v-if="mode === 'parse-prd'" class="wizard-divider" />
        <div class="wizard-section-header">
          <span class="wizard-section-label">{{ mode === 'refine-tasks' ? 'Refinement steps' : 'Refine tasks after generation' }}</span>
          <span v-if="mode === 'parse-prd'" class="wizard-section-hint">optional</span>
          <span v-else class="wizard-section-hint">at least 1 step required</span>
        </div>

        <div v-for="(step, idx) in refineTasksSteps" :key="step.id" class="refine-step-card">
          <div class="refine-step-header">
            <span class="refine-step-label">Step {{ idx + 1 }}</span>
            <div class="refine-step-actions">
              <Button icon="pi pi-arrow-up" text size="small" :disabled="idx === 0" @click="moveRefineTasksStep(idx, -1)" />
              <Button icon="pi pi-arrow-down" text size="small" :disabled="idx === refineTasksSteps.length - 1" @click="moveRefineTasksStep(idx, 1)" />
              <Button icon="pi pi-times" text severity="danger" size="small" @click="removeRefineTasksStep(step.id)" />
            </div>
          </div>
          <div class="refine-step-fields">
            <div class="wizard-field refine-step-field">
              <label>Agent</label>
              <Select
                v-model="step.agent"
                :options="agentOptions"
                optionLabel="label"
                optionValue="value"
                class="wizard-select"
                :data-testid="`refine-tasks-step-${idx}-agent`"
                @change="onRefineTasksStepAgentChange(step)"
              />
            </div>
            <div class="wizard-field refine-step-field">
              <label>Model</label>
              <Select
                v-model="step.model"
                :options="step.models"
                optionLabel="name"
                optionValue="id"
                :loading="step.modelsLoading"
                placeholder="Default (auto)"
                showClear
                filter
                filterPlaceholder="Search models..."
                class="wizard-select"
                :data-testid="`refine-tasks-step-${idx}-model`"
                :virtualScrollerOptions="step.models.length > 30 ? { itemSize: 38 } : undefined"
                @change="onRefineTasksStepModelChange(step)"
              />
              <small v-if="step.fetchError" class="wizard-error">
                Failed to load models.
                <a href="#" class="wizard-retry" @click.prevent="retryRefineTasksStepModels(step)">Retry</a>
              </small>
            </div>
            <div v-if="stepVariantOptions(step).length > 0" class="wizard-field refine-step-field">
              <label>{{ stepVariantLabel(step) }}</label>
              <Select
                v-model="step.variant"
                :options="[{ label: 'Default', value: '' }, ...stepVariantOptions(step).map(v => ({ label: v, value: v }))]"
                optionLabel="label"
                optionValue="value"
                class="wizard-select"
              />
            </div>
          </div>
        </div>

        <Button label="+ Add refine step" text size="small" @click="addRefineTasksStep" :disabled="refineTasksSteps.length >= 20" v-tooltip.bottom="refineTasksSteps.length >= 20 ? 'Maximum 20 steps' : undefined" class="refine-add-btn" />
      </div>

      <hr v-if="mode === 'parse-prd' || mode === 'refine-tasks'" class="wizard-divider" />

      <div v-if="mode === 'parse-prd' || mode === 'refine-tasks'" class="wizard-section-header">
        <span class="wizard-section-label">Settings</span>
      </div>

      <label v-if="mode !== 'refine-tasks' && (agent === 'claude' || agent === 'ccs')" class="wizard-checkbox">
        <Checkbox v-model="noUserSettings" :binary="true" />
        No user settings
      </label>

      <label v-if="mode !== 'refine-tasks' && agent === 'ccs'" class="wizard-checkbox">
        <Checkbox v-model="applyHooks" :binary="true" />
        Apply hooks
      </label>

      <div v-if="mode === 'parse-prd' || mode === 'refine-tasks'" class="wizard-field" data-testid="wizard-response-language-field">
        <label>Response Language</label>
        <InputText
          v-model="responseLanguage"
          placeholder="e.g. Russian, English..."
          :maxlength="50"
          class="wizard-select"
          data-testid="wizard-response-language-input"
        />
      </div>

      <div v-if="mode === 'parse-prd' || mode === 'refine-tasks'" class="wizard-field" data-testid="wizard-verbosity-field">
        <label>Verbosity</label>
        <Select
          v-model="verbosity"
          :options="verbosityOptions"
          optionLabel="label"
          optionValue="value"
          class="wizard-select"
          data-testid="wizard-verbosity-select"
        />
      </div>

      <div v-if="mode === 'chat'" class="wizard-field" data-testid="wizard-message-field">
        <label>Message</label>
        <Textarea
          v-model="message"
          placeholder="Describe your idea..."
          :autoResize="true"
          rows="4"
          class="wizard-textarea"
          @keydown.ctrl.enter="onSubmit"
          @keydown.meta.enter="onSubmit"
          data-testid="wizard-message-textarea"
        />
      </div>

      <Button
        :label="submitLabel"
        :icon="starting ? 'pi pi-spinner pi-spin' : 'pi pi-play'"
        :disabled="!canSubmit"
        :loading="starting"
        @click="onSubmit"
        class="wizard-submit"
        data-testid="wizard-submit-button"
      />
    </div>
  </div>
</template>

<style scoped>
.agent-wizard {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: var(--app-content-height, 100vh);
  padding: 2rem;
}

.wizard-card {
  width: 100%;
  max-width: 760px;
  background: #fff;
  border-radius: 8px;
  padding: 2rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.wizard-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: #333;
  margin: 0 0 1.5rem 0;
  text-align: center;
}

.wizard-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-bottom: 1rem;
}

.wizard-field label {
  font-size: 0.75rem;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
}

.wizard-select {
  width: 100%;
}

.wizard-textarea {
  width: 100%;
  font-size: 0.875rem;
  resize: vertical;
}

.wizard-submit {
  width: 100%;
  margin-top: 1rem;
}

.wizard-error {
  color: #e74c3c;
  font-size: 0.75rem;
}

.wizard-retry {
  color: #3498db;
  text-decoration: underline;
  cursor: pointer;
  font-size: 0.75rem;
}

.wizard-retry:hover {
  color: #2980b9;
}

.wizard-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: #555;
  cursor: pointer;
  margin-bottom: 1rem;
}

.wizard-section {
  margin-bottom: 0.25rem;
}

.wizard-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.wizard-section-label {
  font-weight: 600;
  color: var(--text-color-secondary, #475569);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.wizard-section-hint {
  font-size: 0.7rem;
  color: var(--text-color-secondary, #94a3b8);
  opacity: 0.7;
}

.wizard-divider {
  border: none;
  border-top: 1px solid var(--surface-border, #e2e8f0);
  margin: 4px 0 20px 0;
}

.refine-step-card {
  border: 1px solid var(--surface-border, #e2e8f0);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
  background: var(--surface-ground, #f8fafc);
}

.refine-step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.refine-step-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-color, #334155);
}

.refine-step-actions {
  display: flex;
  gap: 2px;
}

.refine-step-fields {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

.refine-step-field {
  margin-bottom: 0;
}

.refine-add-btn {
  margin-top: 0.25rem;
}

@media (max-width: 480px) {
  .refine-step-fields {
    grid-template-columns: 1fr;
  }
}
</style>
