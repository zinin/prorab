<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useTasksStore } from "../stores/tasks";
import { useExpandStore } from "../stores/expand";
import { useExecutionStore } from "../stores/execution";
import { useChatStore } from "../stores/chat";
import { useParsePrdStore } from "../stores/parse-prd";
import { useToast } from "primevue/usetoast";
import Checkbox from "primevue/checkbox";
import { useSessionDefaults } from "../composables/useSessionDefaults";
import {
  canShowExpandButton,
  isExpandDisabled,
  hasConflictingSession,
  expandDisabledTooltip,
  startReasonDisplayText,
  shouldReloadAfterExpand,
} from "../composables/expand-launch-helpers";
import {
  computeVariantOptions,
  createModelsFetcher,
  type ModelEntry,
} from "../components/agent-wizard-logic";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import Select from "primevue/select";
import Button from "primevue/button";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Dialog from "primevue/dialog";
import ReportSection from "../components/ReportSection.vue";
import ExpandProgress from "../components/ExpandProgress.vue";

const route = useRoute();
const router = useRouter();
const tasksStore = useTasksStore();
const expandStore = useExpandStore();
const executionStore = useExecutionStore();
const chatStore = useChatStore();
const parsePrdStore = useParsePrdStore();
const toast = useToast();

const task = ref<any>(null);
const loading = ref(true);
interface TaskDraft {
  title: string;
  status: string;
  priority: string;
  description: string;
  details: string;
  testStrategy: string;
}

const draft = ref<TaskDraft>({
  title: "", status: "pending", priority: "", description: "", details: "", testStrategy: "",
});
const snapshot = ref<TaskDraft>({
  title: "", status: "pending", priority: "", description: "", details: "", testStrategy: "",
});
const subtaskChanges = ref<Map<string, Record<string, unknown>>>(new Map());
const saving = ref(false);

const isDirty = computed(() =>
  JSON.stringify(draft.value) !== JSON.stringify(snapshot.value)
  || subtaskChanges.value.size > 0
);

const statusOptions = [
  { label: "Pending", value: "pending" },
  { label: "In Progress", value: "in-progress" },
  { label: "Done", value: "done" },
  { label: "Blocked", value: "blocked" },
  { label: "Review", value: "review" },
  { label: "Rework", value: "rework" },
  { label: "Closed", value: "closed" },
];

const subtaskStatusOptions = [
  { label: "Pending", value: "pending" },
  { label: "In Progress", value: "in-progress" },
  { label: "Done", value: "done" },
  { label: "Blocked", value: "blocked" },
];

const priorityOptions = [
  { label: "\u2014", value: "" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Critical", value: "critical" },
];

function syncDraft() {
  if (!task.value) return;
  const d: TaskDraft = {
    title: task.value.title ?? "",
    status: task.value.status ?? "pending",
    priority: task.value.priority ?? "",
    description: task.value.description ?? "",
    details: task.value.details ?? "",
    testStrategy: task.value.testStrategy ?? "",
  };
  draft.value = { ...d };
  snapshot.value = { ...d };
  subtaskChanges.value = new Map();
  // Update last-known server state for N7 remote change detection
  const storeTask = tasksStore.tasks.find((t) => String(t.id) === String(task.value!.id));
  if (storeTask) lastKnownJson.value = JSON.stringify(storeTask);
}

async function loadTask() {
  loading.value = true;
  const id = String(route.params.id);
  task.value = await tasksStore.fetchTask(id);
  loading.value = false;
  syncDraft();
}

onMounted(loadTask);
watch(() => route.params.id, loadTask);

// [N7] Show notification on remote update instead of auto-overwriting form
// Compare store snapshot against our last-known server state to detect external changes.
const hasRemoteUpdate = ref(false);
const lastKnownJson = ref("");
watch(() => tasksStore.tasks, () => {
  if (!task.value || saving.value) return;
  const found = tasksStore.tasks.find((t) => String(t.id) === String(task.value.id));
  if (!found) return;
  const foundJson = JSON.stringify(found);
  if (lastKnownJson.value && foundJson !== lastKnownJson.value) {
    hasRemoteUpdate.value = true;
    toast.add({ severity: "info", summary: "Task updated", detail: "This task was updated externally. Click Refresh to load changes.", life: 5000 });
  }
  lastKnownJson.value = foundJson;
}, { deep: true });

function refreshTask() {
  hasRemoteUpdate.value = false;
  loadTask();
}

async function save() {
  if (!task.value || !isDirty.value) return;
  saving.value = true;
  try {
    // Compute task field diff
    const updates: Record<string, unknown> = {};
    for (const key of Object.keys(draft.value) as (keyof TaskDraft)[]) {
      if (draft.value[key] !== snapshot.value[key]) {
        const val = draft.value[key];
        updates[key] = key === "priority" && val === "" ? null : val;
      }
    }
    if (Object.keys(updates).length > 0) {
      await tasksStore.updateTask(String(task.value.id), updates);
    }
    // Save subtask changes
    for (const [subId, changes] of subtaskChanges.value) {
      await tasksStore.updateSubtask(String(task.value.id), subId, changes);
    }
    await loadTask();
    toast.add({ severity: "success", summary: "Saved", life: 2000 });
  } catch (e) {
    toast.add({ severity: "error", summary: "Save failed", detail: String(e), life: 5000 });
  } finally {
    saving.value = false;
  }
}

function trackSubtaskChange(subId: string, field: string, value: unknown) {
  const existing = subtaskChanges.value.get(subId) ?? {};
  existing[field] = value;
  subtaskChanges.value = new Map(subtaskChanges.value.set(subId, existing));
}

function goToSubtask(event: any) {
  router.push(`/tasks/${task.value.id}/subtasks/${event.data.id}`);
}

// --- Expand dialog ---

const expandDialogVisible = ref(false);
const expandStarting = ref(false);
const expandNoUserSettings = ref(true);
const expandApplyHooks = ref(false);

const sessionDefaults = useSessionDefaults();

// Local dialog form state (initialized from persisted defaults when dialog opens)
const expandAgent = ref("claude");
const expandModel = ref("");
const expandVariant = ref("");
const expandModels = ref<ModelEntry[]>([]);
const expandModelsLoading = ref(false);
const expandFetchError = ref(false);
const expandVerbosity = ref("trace");
const expandVerbosityOptions = [
  { label: "Trace", value: "trace" },
  { label: "Debug", value: "debug" },
  { label: "Info", value: "info" },
  { label: "Quiet", value: "quiet" },
];

const expandAgentOptions = [
  { label: "Claude", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "CCS", value: "ccs" },
  { label: "Codex", value: "codex" },
];

const expandVariantOptions = computed(() =>
  computeVariantOptions(expandModels.value, expandModel.value),
);

const expandCanSubmit = computed(() => {
  if (expandModelsLoading.value || expandStarting.value) return false;
  return true;
});

const expandSubmitLabel = computed(() =>
  expandStarting.value ? "Expanding..." : "Expand",
);

// --- Expand gating ---

const currentTaskId = computed(() => task.value ? String(task.value.id) : "");

const showExpandButton = computed(() => {
  if (!task.value) return false;
  return canShowExpandButton(
    task.value.status,
    task.value.subtasks?.length ?? 0,
  );
});

const sessionConflict = computed(() =>
  hasConflictingSession({
    executionState: executionStore.state,
    chatHasSession: chatStore.hasSession,
    parsePrdHasSession: parsePrdStore.hasSession,
    expandIsRunning: expandStore.isRunning,
    expandBelongsToTask: expandStore.belongsToTask(currentTaskId.value),
  }),
);

const expandDisabled = computed(() =>
  isExpandDisabled({
    isDirty: isDirty.value,
    isSaving: saving.value,
    hasConflictingSession: sessionConflict.value,
  }),
);

const expandTooltip = computed(() =>
  expandDisabledTooltip({
    isDirty: isDirty.value,
    isSaving: saving.value,
    hasConflictingSession: sessionConflict.value,
  }),
);

/** Whether to show ExpandProgress inline for the current task. */
const showExpandProgress = computed(() => {
  if (!task.value) return false;
  return expandStore.hasSession && expandStore.belongsToTask(currentTaskId.value);
});

// --- Model fetching for expand dialog ---

const fetchExpandModelsImpl = createModelsFetcher(fetch.bind(globalThis));

async function fetchExpandModels(agentValue: string) {
  expandModelsLoading.value = true;
  expandFetchError.value = false;
  expandModels.value = [];
  const result = await fetchExpandModelsImpl(agentValue);
  if (!result.superseded) {
    expandModels.value = result.models;
    expandFetchError.value = !!result.error;
    expandModelsLoading.value = false;
  }
}

onUnmounted(() => {
  fetchExpandModelsImpl.abort();
});

// Guard flag: when true, agent/model watchers skip their reset logic.
// Prevents openExpandDialog() from having its persisted defaults wiped
// by the asynchronous watcher flush that follows synchronous ref assignments.
let skipExpandWatcherResets = false;

// Watch agent changes in expand dialog — reset model/variant and fetch models
watch(expandAgent, (newAgent) => {
  if (skipExpandWatcherResets) return;
  expandModel.value = "";
  expandVariant.value = "";
  fetchExpandModels(newAgent);
});

// Watch model changes — reset variant
watch(expandModel, () => {
  if (skipExpandWatcherResets) return;
  expandVariant.value = "";
});

// Auto-select default variant when options become available
watch(expandVariantOptions, (opts) => {
  if (opts.length > 0 && !expandVariant.value) {
    expandVariant.value = opts[opts.length - 1];
  }
});

function retryExpandModels() {
  fetchExpandModels(expandAgent.value);
}

function openExpandDialog() {
  // Suppress agent/model watcher resets while restoring persisted defaults.
  // Without this guard the watchers fire on the next tick (Vue 'pre' flush)
  // and wipe model/variant back to "" — defeating the persisted-defaults contract.
  skipExpandWatcherResets = true;
  // Initialize from shared session defaults
  expandAgent.value = sessionDefaults.value.agent || "claude";
  expandModel.value = sessionDefaults.value.model || "";
  expandVariant.value = sessionDefaults.value.variant || "";
  expandVerbosity.value = sessionDefaults.value.verbosity || "trace";
  expandNoUserSettings.value = !sessionDefaults.value.userSettings;
  expandApplyHooks.value = sessionDefaults.value.applyHooks ?? false;
  expandStarting.value = false;
  // Fetch models for the current agent
  fetchExpandModels(expandAgent.value);
  expandDialogVisible.value = true;
  // Re-enable watcher resets after the 'pre' flush watchers have run.
  nextTick(() => { skipExpandWatcherResets = false; });
}

async function onExpandSubmit() {
  if (!expandCanSubmit.value || !task.value) return;
  expandStarting.value = true;
  try {
    const opts: { agent: string; model?: string; variant?: string; verbosity?: string; userSettings?: boolean; applyHooks?: boolean } = {
      agent: expandAgent.value,
      model: expandModel.value || undefined,
      variant: expandVariant.value || undefined,
      verbosity: expandVerbosity.value,
      userSettings: !expandNoUserSettings.value,
      applyHooks: expandApplyHooks.value || undefined,
    };
    await expandStore.start(String(task.value.id), opts);
    // Persist defaults on successful start
    sessionDefaults.value = {
      agent: expandAgent.value,
      model: expandModel.value,
      variant: expandVariant.value,
      verbosity: expandVerbosity.value,
      userSettings: !expandNoUserSettings.value,
      applyHooks: expandApplyHooks.value,
    };
    expandDialogVisible.value = false;
  } catch (e) {
    const reason = expandStore.reason;
    const reasonText = startReasonDisplayText(reason);
    toast.add({
      severity: "error",
      summary: "Expand failed",
      detail: reasonText || String(e),
      life: 5000,
    });
  } finally {
    expandStarting.value = false;
  }
}

function handleExpandStop() {
  if (!task.value) return;
  expandStore.stop(String(task.value.id)).catch((e) => {
    toast.add({ severity: "error", summary: "Stop failed", detail: String(e), life: 5000 });
  });
}

function handleExpandDismiss() {
  expandStore.clearExpand();
}

// Watch for file-writing expand outcomes — auto-reload task to show new subtasks.
//
// Dedup guard: `lastReloadedOutcomeRef` stores a serialised fingerprint of the
// last outcome that triggered a reload. This prevents duplicate reloads when the
// same outcome object triggers the watcher more than once (e.g. WS reconnect
// replaying the same expand:finished event).
const lastReloadedOutcomeRef = ref("");

watch(() => expandStore.outcome, (outcome) => {
  if (!shouldReloadAfterExpand(outcome, currentTaskId.value)) return;

  // Non-null assertion is safe: shouldReloadAfterExpand returns false for null.
  const o = outcome!;

  // Dedup: build a fingerprint from outcome fields that uniquely identify it
  const fingerprint = `${o.taskId}:${o.status}:${o.subtaskCount}:${"reason" in o ? o.reason : ""}`;
  if (fingerprint === lastReloadedOutcomeRef.value) return;
  lastReloadedOutcomeRef.value = fingerprint;

  loadTask();

  // Show a warning toast for commit_failed_after_write so the user knows
  // subtasks are on disk but not committed to git.
  if (o.status === "failure" && o.reason === "commit_failed_after_write") {
    toast.add({
      severity: "warn",
      summary: "Git commit failed",
      detail: "Subtasks were saved to tasks.json but the git commit failed. A manual commit may be needed.",
      life: 8000,
    });
  }
});

</script>

<template>
  <div class="page-content">
    <div v-if="loading">Loading...</div>
    <div v-else-if="!task">
      <p>Task not found.</p>
      <Button label="Back" @click="router.push('/')" />
    </div>
    <div v-else>
    <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem;">
      <Button label="&#8592; Back" text @click="router.push('/')" />
      <Button v-if="hasRemoteUpdate" label="Refresh" icon="pi pi-refresh" severity="info" size="small" @click="refreshTask" />
      <Button label="Save" icon="pi pi-check" @click="save" :disabled="!isDirty" :loading="saving" severity="success" size="small" />
      <Button
        v-if="showExpandButton"
        label="Expand"
        icon="pi pi-sitemap"
        severity="secondary"
        size="small"
        :disabled="expandDisabled"
        :title="expandTooltip ?? undefined"
        @click="openExpandDialog"
        data-testid="expand-launch-button"
      />
    </div>

    <div class="task-header">
      <span class="task-id">#{{ task.id }}</span>
      <InputText v-model="draft.title" style="flex: 1; font-size: 1.25rem; font-weight: 600;" />
      <Select v-model="draft.status" :options="statusOptions" optionLabel="label" optionValue="value" />
      <Select v-model="draft.priority" :options="priorityOptions" optionLabel="label" optionValue="value" placeholder="Priority" />
    </div>

    <div class="field-group">
      <label>Description</label>
      <Textarea v-model="draft.description" rows="3" autoResize style="width: 100%;" />
    </div>

    <div class="field-group">
      <label>Implementation Details</label>
      <Textarea v-model="draft.details" rows="5" autoResize style="width: 100%;" />
    </div>

    <div class="field-group">
      <label>Test Strategy</label>
      <Textarea v-model="draft.testStrategy" rows="3" autoResize style="width: 100%;" />
    </div>

    <div v-if="task.metadata?.runAttempts" class="field-group">
      <label>Execution Attempts</label>
      <span>{{ task.metadata.runAttempts }}</span>
    </div>

    <!-- Expand progress (inline, shown when expand active/completed for this task) -->
    <div v-if="showExpandProgress" class="expand-progress-section" data-testid="expand-progress-section">
      <ExpandProgress
        :messages="expandStore.messages"
        :state="expandStore.state"
        :outcome="expandStore.outcome"
        :sessionInfo="expandStore.sessionInfo"
        :contextUsage="expandStore.contextUsage"
        @stop="handleExpandStop"
        @dismiss="handleExpandDismiss"
      />
    </div>

    <!-- Subtasks -->
    <div class="subtasks-section">
      <h2 style="margin-bottom: 0.5rem;">Subtasks ({{ task.subtasks?.length ?? 0 }})</h2>

      <DataTable v-if="task.subtasks?.length" :value="task.subtasks" class="p-datatable-sm clickable-rows" @row-click="goToSubtask">
        <Column field="id" header="ID" style="width: 4rem" />
        <Column field="title" header="Title" />
        <Column field="status" header="Status" style="width: 8rem">
          <template #body="{ data: sub }">
            <Select
              v-model="sub.status"
              :options="subtaskStatusOptions"
              optionLabel="label"
              optionValue="value"
              @change="trackSubtaskChange(String(sub.id), 'status', sub.status)"
              @click.stop
              size="small"
            />
          </template>
        </Column>
      </DataTable>
    </div>

    <!-- Report -->
    <ReportSection :unitId="String(task.id)" />

    <!-- Expand launch dialog -->
    <Dialog
      v-model:visible="expandDialogVisible"
      header="Expand Task"
      :modal="true"
      :closable="true"
      :draggable="false"
      class="expand-dialog"
      data-testid="expand-dialog"
    >
      <div class="expand-dialog__form" data-testid="expand-dialog-form">
        <div class="expand-dialog__field">
          <label>Agent</label>
          <Select
            v-model="expandAgent"
            :options="expandAgentOptions"
            optionLabel="label"
            optionValue="value"
            class="expand-dialog__select"
            data-testid="expand-agent-select"
          />
        </div>

        <div class="expand-dialog__field">
          <label>Model</label>
          <Select
            v-model="expandModel"
            :options="expandModels"
            optionLabel="name"
            optionValue="id"
            :loading="expandModelsLoading"
            placeholder="Default (auto)"
            showClear
            filter
            filterPlaceholder="Search models..."
            class="expand-dialog__select"
            :virtualScrollerOptions="expandModels.length > 30 ? { itemSize: 38 } : undefined"
            data-testid="expand-model-select"
          />
          <small v-if="expandFetchError" class="expand-dialog__error">
            Failed to load models.
            <a href="#" class="expand-dialog__retry" @click.prevent="retryExpandModels">Retry</a>
          </small>
        </div>

        <div v-if="expandVariantOptions.length > 0" class="expand-dialog__field">
          <label>{{ expandAgent === 'claude' || expandAgent === 'ccs' ? 'Effort' : 'Variant' }}</label>
          <Select
            v-model="expandVariant"
            :options="[{ label: 'Default', value: '' }, ...expandVariantOptions.map(v => ({ label: v, value: v }))]"
            optionLabel="label"
            optionValue="value"
            class="expand-dialog__select"
            data-testid="expand-variant-select"
          />
        </div>

        <div class="expand-dialog__field">
          <label>Verbosity</label>
          <Select
            v-model="expandVerbosity"
            :options="expandVerbosityOptions"
            optionLabel="label"
            optionValue="value"
            class="expand-dialog__select"
            data-testid="expand-verbosity-select"
          />
        </div>

        <label v-if="expandAgent === 'claude' || expandAgent === 'ccs'" class="expand-dialog__checkbox">
          <Checkbox v-model="expandNoUserSettings" :binary="true" />
          No user settings
        </label>
        <label v-if="expandAgent === 'ccs'" class="expand-dialog__checkbox">
          <Checkbox v-model="expandApplyHooks" :binary="true" />
          Apply hooks
        </label>

        <Button
          :label="expandSubmitLabel"
          :icon="expandStarting ? 'pi pi-spinner pi-spin' : 'pi pi-play'"
          :disabled="!expandCanSubmit"
          :loading="expandStarting"
          @click="onExpandSubmit"
          class="expand-dialog__submit"
          data-testid="expand-submit-button"
        />
      </div>
    </Dialog>
    </div>
  </div>
</template>

<style scoped>
.page-content { padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
.task-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; }
.task-id { font-size: 1.25rem; font-weight: 600; color: #666; }
.field-group { margin-bottom: 1.25rem; }
.field-group label { display: block; font-weight: 600; margin-bottom: 0.25rem; color: #555; }
.subtasks-section { margin-top: 2rem; }
.clickable-rows :deep(tr) { cursor: pointer; transition: background-color 0.15s; }
.clickable-rows :deep(tr:hover td) { background-color: var(--p-highlight-background) !important; }

/* Expand progress section */
.expand-progress-section {
  margin: 1.5rem 0;
  border: 1px solid #3c3c3c;
  border-radius: 8px;
  overflow: hidden;
  height: 500px;
  display: flex;
  flex-direction: column;
}

/* Expand dialog */
.expand-dialog__form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 400px;
}

.expand-dialog__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.expand-dialog__field label {
  font-size: 0.75rem;
  font-weight: 600;
  color: #666;
  text-transform: uppercase;
}

.expand-dialog__select {
  width: 100%;
}

.expand-dialog__submit {
  width: 100%;
  margin-top: 0.5rem;
}

.expand-dialog__error {
  color: #e74c3c;
  font-size: 0.75rem;
}

.expand-dialog__retry {
  color: #3498db;
  text-decoration: underline;
  cursor: pointer;
  font-size: 0.75rem;
}

.expand-dialog__retry:hover {
  color: #2980b9;
}

.expand-dialog__checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: #555;
  cursor: pointer;
}
</style>
