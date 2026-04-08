<script setup lang="ts">
import { useTasksStore } from "../stores/tasks";
import { useChatStore } from "../stores/chat";
import type { QuestionAnswers } from "../stores/chat";
import { useParsePrdStore } from "../stores/parse-prd";
import { useBatchExpandStore } from "../stores/batchExpand";
import { useRefinePrdStore } from "../stores/refinePrd";
import { useRefineTasksStore } from "../stores/refineTasks";
import { useExpandStore } from "../stores/expand";
import { useExecutionStore } from "../stores/execution";
import { useRouter } from "vue-router";
import { useToast } from "primevue/usetoast";
import DataTable from "primevue/datatable";
import Column from "primevue/column";
import Tag from "primevue/tag";
import InputText from "primevue/inputtext";
import Select from "primevue/select";
import Dialog from "primevue/dialog";
import Button from "primevue/button";
import Checkbox from "primevue/checkbox";
import AgentWizard from "../components/AgentWizard.vue";
import AgentChatPanel from "../components/AgentChatPanel.vue";
import ParsePrdProgress from "../components/ParsePrdProgress.vue";
import RefinePrdProgress from "../components/RefinePrdProgress.vue";
import RefineTasksProgress from "../components/RefineTasksProgress.vue";
import BatchExpandProgress from "../components/BatchExpandProgress.vue";
import { IDEA_TO_PRD_PROMPT } from "../constants/prompts";
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { computeViewMode } from "./task-list-view-mode";
import { canShowExpandAllButton } from "../composables/batch-expand-launch-helpers";
import {
  computeVariantOptions,
  createModelsFetcher,
  type ModelEntry,
} from "../components/agent-wizard-logic";
import { useSessionDefaults } from "../composables/useSessionDefaults";

const tasksStore = useTasksStore();
const chatStore = useChatStore();
const parsePrdStore = useParsePrdStore();
const batchExpandStore = useBatchExpandStore();
const refinePrdStore = useRefinePrdStore();
const refineTasksStore = useRefineTasksStore();
const expandStore = useExpandStore();
const executionStore = useExecutionStore();
const router = useRouter();
const toast = useToast();
const wizardStarting = ref(false);

const searchQuery = ref("");
const statusFilter = ref<string | null>(null);

const statuses = [
  { label: "All", value: null },
  { label: "Pending", value: "pending" },
  { label: "In Progress", value: "in-progress" },
  { label: "Done", value: "done" },
  { label: "Review", value: "review" },
  { label: "Rework", value: "rework" },
  { label: "Blocked", value: "blocked" },
  { label: "Closed", value: "closed" },
];

const filteredTasks = computed(() => {
  let result = tasksStore.tasks;
  if (statusFilter.value) {
    result = result.filter((t) => t.status === statusFilter.value);
  }
  if (searchQuery.value) {
    const q = searchQuery.value.toLowerCase();
    result = result.filter((t) => t.title.toLowerCase().includes(q));
  }
  return result;
});

/**
 * Single explicit view-mode state machine — replaces scattered boolean
 * computed properties (showInlineChat, showParsePrdPanel, showWizard).
 * Priority chain is encoded in computeViewMode(); see task-list-view-mode.ts.
 */
const viewMode = computed(() =>
  computeViewMode({
    wsInitialized: tasksStore.wsInitialized,
    hasTasksFile: tasksStore.hasTasksFile,
    hasValidTasks: tasksStore.hasValidTasks,
    hasPrd: tasksStore.hasPrd,
    loading: tasksStore.loading,
    chatState: chatStore.state,
    refinePrdState: refinePrdStore.state,
    parsePrdState: parsePrdStore.state,
    refineTasksState: refineTasksStore.state,
    batchExpandState: batchExpandStore.state,
  }),
);

/** Wizard component mode derived from viewMode (only relevant when viewMode is wizard-*) */
const wizardMode = computed(() => (viewMode.value === "wizard-parse-prd" ? "parse-prd" : "chat"));

/** Fullscreen layout for chat, parse-prd-progress, and batch-expand-progress panels */
const isFullscreen = computed(() =>
  viewMode.value === "inline-chat"
  || viewMode.value === "refine-prd-progress"
  || viewMode.value === "parse-prd-progress"
  || viewMode.value === "refine-tasks-progress"
  || viewMode.value === "batch-expand-progress",
);

// --- Refine tasks dialog ---
const refineTasksDialogVisible = ref(false);
const refineTasksStarting = ref(false);

// --- Batch expand dialog ---
const batchExpandDialogVisible = ref(false);
const batchExpandStarting = ref(false);

const sessionDefaults = useSessionDefaults();

const batchAgent = ref("claude");
const batchModel = ref("");
const batchVariant = ref("");
const batchModels = ref<ModelEntry[]>([]);
const batchModelsLoading = ref(false);
const batchFetchError = ref(false);
const batchVerbosity = ref("trace");
const batchNoUserSettings = ref(true);
const batchApplyHooks = ref(false);
const batchVerbosityOptions = [
  { label: "Trace", value: "trace" },
  { label: "Debug", value: "debug" },
  { label: "Info", value: "info" },
  { label: "Quiet", value: "quiet" },
];
const batchAgentOptions = [
  { label: "Claude", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "CCS", value: "ccs" },
  { label: "Codex", value: "codex" },
];

const batchVariantOptions = computed(() =>
  computeVariantOptions(batchModels.value, batchModel.value),
);

const batchCanSubmit = computed(() => {
  if (batchModelsLoading.value || batchExpandStarting.value) return false;
  return true;
});

const fetchBatchModelsImpl = createModelsFetcher(fetch.bind(globalThis));

async function fetchBatchModels(agentValue: string) {
  batchModelsLoading.value = true;
  batchFetchError.value = false;
  batchModels.value = [];
  const result = await fetchBatchModelsImpl(agentValue);
  if (!result.superseded) {
    batchModels.value = result.models;
    batchFetchError.value = !!result.error;
    batchModelsLoading.value = false;
  }
}

let skipBatchWatcherResets = false;

watch(batchAgent, (newAgent) => {
  if (skipBatchWatcherResets) return;
  batchModel.value = "";
  batchVariant.value = "";
  fetchBatchModels(newAgent);
});

watch(batchModel, () => {
  if (skipBatchWatcherResets) return;
  batchVariant.value = "";
});

watch(batchVariantOptions, (opts) => {
  if (opts.length > 0 && !batchVariant.value) {
    batchVariant.value = opts[opts.length - 1];
  }
});

function retryBatchModels() {
  fetchBatchModels(batchAgent.value);
}

// --- Gating logic ---
const showExpandAll = computed(() => canShowExpandAllButton(tasksStore.tasks));

const hasAnyActiveSession = computed(() => {
  if (executionStore.state !== "idle") return true;
  if (chatStore.state !== "idle") return true;
  if (parsePrdStore.state !== "idle") return true;
  if (refinePrdStore.state !== "idle") return true;
  if (refineTasksStore.state !== "idle") return true;
  if (expandStore.isRunning) return true;
  if (batchExpandStore.isRunning) return true;
  return false;
});

// --- Refine tasks dialog open/submit handlers ---
function openRefineTasksDialog() {
  refineTasksStarting.value = false;
  refineTasksDialogVisible.value = true;
}

async function onRefineTasksWizardStart(config: { refineTasksSteps?: { agent: string; model?: string; variant?: string }[]; verbosity?: string; responseLanguage?: string; userSettings?: boolean; applyHooks?: boolean }) {
  if (!config.refineTasksSteps?.length) return;
  refineTasksStarting.value = true;
  try {
    await refineTasksStore.start({
      steps: config.refineTasksSteps,
      verbosity: config.verbosity,
      responseLanguage: config.responseLanguage,
      userSettings: config.userSettings,
      applyHooks: config.applyHooks,
    });
    refineTasksDialogVisible.value = false;
    // refineTasksStore.state is now active — viewMode switches to refine-tasks-progress
  } catch (e) {
    toast.add({
      severity: "error",
      summary: "Refine tasks failed",
      detail: String(e),
      life: 5000,
    });
  } finally {
    refineTasksStarting.value = false;
  }
}

// --- Dialog open/submit/stop/dismiss handlers ---
function openBatchExpandDialog() {
  skipBatchWatcherResets = true;
  batchAgent.value = sessionDefaults.value.agent || "claude";
  batchModel.value = sessionDefaults.value.model || "";
  batchVariant.value = sessionDefaults.value.variant || "";
  batchVerbosity.value = sessionDefaults.value.verbosity || "trace";
  batchNoUserSettings.value = !sessionDefaults.value.userSettings;
  batchApplyHooks.value = sessionDefaults.value.applyHooks ?? false;
  batchExpandStarting.value = false;
  fetchBatchModels(batchAgent.value);
  batchExpandDialogVisible.value = true;
  nextTick(() => { skipBatchWatcherResets = false; });
}

async function onBatchExpandSubmit() {
  if (!batchCanSubmit.value) return;
  batchExpandStarting.value = true;
  try {
    const result = await batchExpandStore.start({
      agent: batchAgent.value,
      model: batchModel.value || undefined,
      variant: batchVariant.value || undefined,
      verbosity: batchVerbosity.value,
      userSettings: !batchNoUserSettings.value,
      applyHooks: batchApplyHooks.value || undefined,
    });
    sessionDefaults.value = {
      agent: batchAgent.value,
      model: batchModel.value,
      variant: batchVariant.value,
      verbosity: batchVerbosity.value,
      userSettings: !batchNoUserSettings.value,
      applyHooks: batchApplyHooks.value,
    };
    batchExpandDialogVisible.value = false;
    if (result && !result.started) {
      toast.add({
        severity: "info",
        summary: "No eligible tasks",
        detail: "No pending tasks without subtasks found",
        life: 5000,
      });
    }
  } catch (e) {
    toast.add({
      severity: "error",
      summary: "Batch expand failed",
      detail: String(e),
      life: 5000,
    });
  } finally {
    batchExpandStarting.value = false;
  }
}

function handleBatchExpandStop() {
  batchExpandStore.stop().catch((e) => {
    toast.add({ severity: "error", summary: "Stop failed", detail: String(e), life: 5000 });
  });
}

function handleBatchExpandDismiss() {
  batchExpandStore.clear();
}

function handleBatchExpandSelectTask(taskId: number) {
  batchExpandStore.togglePinToTask(taskId);
}

// --- Batch expand outcome → reload tasks ---
watch(() => batchExpandStore.outcome, (newOutcome) => {
  if (newOutcome) {
    tasksStore.fetchTasks();
  }
});

// --- Lifecycle ---
onMounted(() => {
  tasksStore.fetchTasks();
});

onUnmounted(() => {
  fetchBatchModelsImpl.abort();
});

function statusSeverity(status: string) {
  const map: Record<string, string> = {
    pending: "warn",
    "in-progress": "info",
    done: "success",
    blocked: "danger",
    review: "info",
    rework: "warn",
    closed: "success",
  };
  return (map[status] ?? "info") as any;
}

function subtasksSummary(task: any) {
  const subs = task.subtasks || [];
  if (subs.length === 0) return "\u2014";
  const done = subs.filter((s: any) => s.status === "done").length;
  return `${done}/${subs.length}`;
}

function goToTask(event: any) {
  router.push(`/tasks/${event.data.id}`);
}

async function onWizardStart(config: { agent: string; model?: string; variant?: string; initialMessage?: string; responseLanguage?: string; verbosity?: string; userSettings?: boolean; applyHooks?: boolean; refinePrdSteps?: { agent: string; model?: string }[]; refineTasksSteps?: { agent: string; model?: string; variant?: string }[] }) {
  wizardStarting.value = true;
  try {
    if (wizardMode.value === "parse-prd") {
      // Build refine-tasks options when steps are configured
      const refineTasksOptions = config.refineTasksSteps?.length
        ? {
            steps: config.refineTasksSteps,
            verbosity: config.verbosity,
            responseLanguage: config.responseLanguage,
            userSettings: config.userSettings,
            applyHooks: config.applyHooks,
          }
        : null;

      if (config.refinePrdSteps && config.refinePrdSteps.length > 0) {
        // Start refine-prd pipeline (auto-launches parse-prd on success)
        await refinePrdStore.start({
          steps: config.refinePrdSteps,
          verbosity: config.verbosity,
          responseLanguage: config.responseLanguage,
          userSettings: config.userSettings,
          applyHooks: config.applyHooks,
          parsePrdOptions: {
            agent: config.agent,
            model: config.model,
            variant: config.variant,
            responseLanguage: config.responseLanguage,
            verbosity: config.verbosity,
            userSettings: config.userSettings,
            applyHooks: config.applyHooks,
            refineTasksOptions,
          },
        });
      } else {
        // Direct parse-prd (current behavior)
        await parsePrdStore.start({
          agent: config.agent,
          model: config.model,
          variant: config.variant,
          responseLanguage: config.responseLanguage,
          verbosity: config.verbosity,
          userSettings: config.userSettings,
          applyHooks: config.applyHooks,
          refineTasksOptions,
        });
      }
      // Parse-prd or refine-prd session is now active — viewMode switches accordingly
    } else {
      await chatStore.startFlow(
        {
          agent: config.agent,
          model: config.model,
          variant: config.variant,
          systemPrompt: IDEA_TO_PRD_PROMPT,
          userSettings: config.userSettings,
          applyHooks: config.applyHooks,
        },
        config.initialMessage ?? "",
      );
      // Chat is now active — viewMode switches to inline-chat
    }
  } catch (err: unknown) {
    // If session was already started (409) or partial success — session is active,
    // so suppress the error toast. parsePrdStore.start() handles errors internally
    // and shouldn't rethrow, but the guard is kept for defensive resilience.
    if (chatStore.state !== "idle") return;
    if (parsePrdStore.state === "active") return;
    if (refinePrdStore.state === "active") return;
    if (refineTasksStore.state === "active") return;
    toast.add({
      severity: "error",
      summary: "Start Error",
      detail: err instanceof Error ? err.message : String(err),
      life: 5000,
    });
  } finally {
    wizardStarting.value = false;
  }
}

async function handleSend(text: string) {
  try {
    await chatStore.sendMessage(text);
  } catch (err: unknown) {
    toast.add({ severity: "error", summary: "Send Error", detail: err instanceof Error ? err.message : String(err), life: 5000 });
  }
}

async function handleReply(answers: QuestionAnswers) {
  try {
    await chatStore.replyQuestion(answers);
  } catch (err: unknown) {
    toast.add({ severity: "error", summary: "Reply Error", detail: err instanceof Error ? err.message : String(err), life: 5000 });
  }
}

async function handleStop() {
  try {
    await chatStore.stopChat();
  } catch (err: unknown) {
    toast.add({ severity: "error", summary: "Stop Error", detail: err instanceof Error ? err.message : String(err), life: 5000 });
  }
}

async function handleParsePrdStop() {
  try {
    await parsePrdStore.stop();
  } catch (err: unknown) {
    toast.add({ severity: "error", summary: "Stop Error", detail: err instanceof Error ? err.message : String(err), life: 5000 });
  }
}

/**
 * Dismiss the parse-prd progress panel after failure/cancelled.
 *
 * Resets the parse-prd store back to idle so the wizard reappears
 * (since hasTasksFile is still false).
 */
function handleParsePrdDismiss() {
  parsePrdStore.clearParsePrd();
}

/**
 * Watch for chat session finish → refresh project state.
 *
 * The idea-to-PRD chat flow creates a PRD file during the session.
 * When the session ends (state transitions to "idle"), we refresh
 * project state so `hasPrd` reflects the newly created PRD and
 * viewMode transitions from "wizard-chat" to "wizard-parse-prd".
 */
watch(
  () => chatStore.state,
  async (newState, oldState) => {
    if (newState === "idle" && oldState && oldState !== "idle") {
      try {
        await tasksStore.fetchStatus();
      } catch {
        // Non-critical — silently ignore
      }
    }
  },
);

/**
 * Watch for parse-prd success → confirm valid tasks.json before transitioning.
 *
 * When the outcome is `success`, the server has already validated the file
 * (post-validation passed). We refresh project state via `fetchStatus()`
 * to get authoritative `hasTasksFile` and `hasValidTasks` flags, then
 * fetch the task list and clean up the parse-prd store.
 *
 * The guard uses `hasValidTasks` (not just `hasTasksFile`) to ensure
 * we only transition to the task list when the file is actually valid.
 * The template naturally switches to the task list once `hasValidTasks`
 * becomes true and the parse-prd store is idle.
 */
watch(
  () => parsePrdStore.outcome,
  async (outcome) => {
    if (outcome?.status === "success") {
      // When refine-tasks will take over (hasNextStep flag from server),
      // skip the fetchTasks/clearParsePrd — let refine-tasks handle it.
      if (outcome.hasNextStep) {
        parsePrdStore.clearParsePrd();
        return;
      }
      try {
        await tasksStore.fetchStatus();
        if (tasksStore.hasValidTasks) {
          await tasksStore.fetchTasks();
        }
      } catch (err: unknown) {
        toast.add({
          severity: "error",
          summary: "Refresh Error",
          detail: err instanceof Error ? err.message : String(err),
          life: 5000,
        });
      } finally {
        parsePrdStore.clearParsePrd();
      }
    }
  },
);

/**
 * Watch for refine-tasks outcome → reload tasks when successful.
 *
 * On success, the refine-tasks pipeline has modified tasks.json.
 * Refresh project state and task list, then clear the store.
 */
watch(() => refineTasksStore.outcome, async (outcome) => {
  if (outcome?.status === "success") {
    try {
      await tasksStore.fetchStatus();
      if (tasksStore.hasValidTasks) {
        await tasksStore.fetchTasks();
      }
    } catch (err: unknown) {
      toast.add({
        severity: "error",
        summary: "Refresh Error",
        detail: err instanceof Error ? err.message : String(err),
        life: 5000,
      });
    } finally {
      refineTasksStore.clearRefineTasks();
    }
  }
});

/**
 * Watch for refine-prd outcome → clear state when parse-prd takes over.
 *
 * On success, the server auto-launches parse-prd. Clear refine state only
 * when parse-prd actually starts (reactive, not timeout-based).
 */
watch(() => refinePrdStore.outcome, (oc) => {
  if (oc?.status === "success") {
    // When parse-prd will take over (hasNextStep flag from server),
    // clear refine-prd state so parse-prd-progress can show.
    if (oc.hasNextStep) {
      refinePrdStore.clearRefinePrd();
      return;
    }
    // No downstream step — just clear the completed state
    refinePrdStore.clearRefinePrd();
  }
});
</script>

<template>
  <div :class="isFullscreen ? 'chat-fullscreen' : 'page-content'">
    <!-- loading: WS not yet connected — blank until state is known -->
    <template v-if="viewMode === 'loading'">
      <!-- Intentionally blank — content appears once WS connected confirms project state -->
    </template>

    <!-- inline-chat: idea-to-PRD chat flow (no tasks file, chat active) -->
    <AgentChatPanel
      v-else-if="viewMode === 'inline-chat'"
      :messages="chatStore.messages"
      :state="chatStore.state"
      :awaiting-user-input="chatStore.awaitingUserInput"
      :pending-question="chatStore.pendingQuestion"
      :can-stop="chatStore.state !== 'idle'"
      @send="handleSend"
      @reply="handleReply"
      @stop="handleStop"
    />

    <!-- refine-prd-progress: active/stopping/completed refine-prd session -->
    <RefinePrdProgress
      v-else-if="viewMode === 'refine-prd-progress'"
      :messages="refinePrdStore.messages"
      :state="refinePrdStore.state"
      :outcome="refinePrdStore.outcome"
      :session-info="refinePrdStore.sessionInfo"
      :context-usage="refinePrdStore.contextUsage"
      :pending-question="refinePrdStore.pendingQuestion"
      @stop="refinePrdStore.stop()"
      @dismiss="refinePrdStore.clearRefinePrd()"
      @reply="(qid: string, answers?: QuestionAnswers) => answers && refinePrdStore.replyToQuestion(qid, answers)"
    />

    <!-- parse-prd-progress: active/stopping/completed parse-prd session.
         Shown regardless of hasTasksFile — terminal outcome banners and "Try Again"
         recovery must be visible even when tasks.json exists but is invalid. -->
    <ParsePrdProgress
      v-else-if="viewMode === 'parse-prd-progress'"
      :messages="parsePrdStore.messages"
      :state="parsePrdStore.state"
      :outcome="parsePrdStore.outcome"
      :contextUsage="parsePrdStore.contextUsage"
      @stop="handleParsePrdStop"
      @dismiss="handleParsePrdDismiss"
    />

    <!-- refine-tasks-progress: active/stopping/completed refine-tasks session -->
    <RefineTasksProgress
      v-else-if="viewMode === 'refine-tasks-progress'"
      :messages="refineTasksStore.messages"
      :state="refineTasksStore.state"
      :outcome="refineTasksStore.outcome"
      :session-info="refineTasksStore.sessionInfo"
      :context-usage="refineTasksStore.contextUsage"
      :pending-question="refineTasksStore.pendingQuestion"
      @stop="refineTasksStore.stop()"
      @dismiss="refineTasksStore.clearRefineTasks()"
      @reply="(qid: string, answers?: Record<string, string | string[]>) => answers && refineTasksStore.replyToQuestion(qid, answers)"
    />

    <!-- batch-expand-progress: active/stopping/completed batch expand session -->
    <BatchExpandProgress
      v-else-if="viewMode === 'batch-expand-progress'"
      :state="batchExpandStore.state"
      :slots="batchExpandStore.slots"
      :summary="batchExpandStore.summary"
      :progress="batchExpandStore.progress"
      :outcome="batchExpandStore.outcome"
      :active-slot-index="batchExpandStore.effectiveSlotIndex"
      :focused-task-id="batchExpandStore.focusedTaskId"
      :error="batchExpandStore.error"
      :context-usage="batchExpandStore.activeContextUsage"
      :pinned="batchExpandStore.isPinned"
      @stop="handleBatchExpandStop"
      @dismiss="handleBatchExpandDismiss"
      @select-task="handleBatchExpandSelectTask"
    />

    <!-- wizard-chat / wizard-parse-prd: no tasks file, no active sessions -->
    <template v-else-if="viewMode === 'wizard-chat' || viewMode === 'wizard-parse-prd'">
      <div class="wizard-intro">
        <h2>No tasks yet</h2>
        <p v-if="wizardMode === 'parse-prd'">PRD found. Generate tasks from your requirements document.</p>
        <p v-else>Describe your idea below. The agent will turn it into a PRD and a task list you can execute.</p>
      </div>
      <div class="wizard-container">
        <AgentWizard :mode="wizardMode" :starting="wizardStarting" @start="onWizardStart" />
      </div>
    </template>

    <!-- error: tasks.json exists but is corrupted / invalid.
         No parse-prd CTA — the user must fix or remove the file manually.
         Offering "regenerate" would silently overwrite a file the user may want to repair. -->
    <div v-else-if="viewMode === 'error'" data-testid="invalid-tasks-error">
      <h1 data-testid="invalid-tasks-heading">Invalid tasks file</h1>
      <div class="error-state" data-testid="invalid-tasks-body">
        <p class="error-state__icon">⚠</p>
        <p class="error-state__message">
          <code>.taskmaster/tasks/tasks.json</code> exists but could not be parsed.
        </p>
        <p class="error-state__hint">
          Fix the JSON manually or delete the file, then reload the page.
        </p>
      </div>
    </div>

    <!-- task-list: valid tasks.json (empty or populated) -->
    <template v-else-if="viewMode === 'task-list'">
      <h1>Tasks</h1>
      <template v-if="!tasksStore.loading && tasksStore.tasks.length === 0">
        <div class="empty-state">
          <p>No tasks found.</p>
        </div>
      </template>
      <template v-else>
        <div class="task-toolbar">
          <InputText v-model="searchQuery" placeholder="Search tasks..." />
          <Select v-model="statusFilter" :options="statuses" optionLabel="label" optionValue="value" placeholder="Filter by status" />
          <Button
            label="Refine Tasks"
            icon="pi pi-sparkles"
            :disabled="hasAnyActiveSession"
            severity="secondary"
            size="small"
            @click="openRefineTasksDialog"
            data-testid="refine-tasks-button"
          />
          <Button
            v-if="showExpandAll"
            label="Expand All"
            icon="pi pi-expand"
            :disabled="hasAnyActiveSession"
            severity="secondary"
            size="small"
            @click="openBatchExpandDialog"
            data-testid="expand-all-button"
          />
        </div>

        <DataTable :value="filteredTasks" @row-click="goToTask" selectionMode="single" class="p-datatable-sm" stripedRows>
          <Column field="id" header="ID" style="width: 4rem" />
          <Column field="title" header="Title" />
          <Column field="status" header="Status" style="width: 8rem">
            <template #body="{ data }">
              <Tag :value="data.status" :severity="statusSeverity(data.status)" />
            </template>
          </Column>
          <Column header="Subtasks" style="width: 6rem">
            <template #body="{ data }">
              {{ subtasksSummary(data) }}
            </template>
          </Column>
          <Column field="priority" header="Priority" style="width: 6rem" />
        </DataTable>
      </template>

      <!-- Batch expand launch dialog -->
      <Dialog
        v-model:visible="batchExpandDialogVisible"
        header="Expand All Tasks"
        :modal="true"
        :closable="true"
        :draggable="false"
        class="batch-expand-dialog"
        :style="{ minWidth: '36rem' }"
        data-testid="batch-expand-dialog"
      >
        <div class="expand-dialog__form">
          <div class="expand-dialog__field">
            <label>Agent</label>
            <Select
              v-model="batchAgent"
              :options="batchAgentOptions"
              optionLabel="label"
              optionValue="value"
              class="expand-dialog__select"
            />
          </div>
          <div class="expand-dialog__field">
            <label>Model</label>
            <Select
              v-model="batchModel"
              :options="batchModels"
              optionLabel="name"
              optionValue="id"
              :loading="batchModelsLoading"
              placeholder="Default (auto)"
              showClear
              filter
              filterPlaceholder="Search models..."
              class="expand-dialog__select"
              :virtualScrollerOptions="batchModels.length > 30 ? { itemSize: 38 } : undefined"
            />
            <small v-if="batchFetchError" class="expand-dialog__error">
              Failed to load models.
              <a href="#" class="expand-dialog__retry" @click.prevent="retryBatchModels">Retry</a>
            </small>
          </div>
          <div v-if="batchVariantOptions.length > 0" class="expand-dialog__field">
            <label>{{ batchAgent === 'claude' || batchAgent === 'ccs' ? 'Effort' : 'Variant' }}</label>
            <Select
              v-model="batchVariant"
              :options="[{ label: 'Default', value: '' }, ...batchVariantOptions.map(v => ({ label: v, value: v }))]"
              optionLabel="label"
              optionValue="value"
              class="expand-dialog__select"
            />
          </div>
          <div class="expand-dialog__field">
            <label>Verbosity</label>
            <Select
              v-model="batchVerbosity"
              :options="batchVerbosityOptions"
              optionLabel="label"
              optionValue="value"
              class="expand-dialog__select"
            />
          </div>
          <label v-if="batchAgent === 'claude' || batchAgent === 'ccs'" class="expand-dialog__checkbox">
            <Checkbox v-model="batchNoUserSettings" :binary="true" />
            No user settings
          </label>
          <label v-if="batchAgent === 'ccs'" class="expand-dialog__checkbox">
            <Checkbox v-model="batchApplyHooks" :binary="true" />
            Apply hooks
          </label>
          <Button
            :label="batchExpandStarting ? 'Starting...' : 'Start'"
            :icon="batchExpandStarting ? 'pi pi-spinner pi-spin' : 'pi pi-play'"
            :disabled="!batchCanSubmit"
            :loading="batchExpandStarting"
            @click="onBatchExpandSubmit"
            class="expand-dialog__submit"
          />
        </div>
      </Dialog>

      <!-- Refine tasks launch dialog -->
      <Dialog
        v-model:visible="refineTasksDialogVisible"
        header="Refine Tasks"
        :modal="true"
        :closable="true"
        :draggable="false"
        class="refine-tasks-dialog"
        :style="{ minWidth: '48rem' }"
        data-testid="refine-tasks-dialog"
      >
        <AgentWizard mode="refine-tasks" :starting="refineTasksStarting" @start="onRefineTasksWizardStart" />
      </Dialog>
    </template>
  </div>
</template>

<style scoped>
.page-content { padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
.empty-state { text-align: center; padding: 3rem; color: #666; }
.error-state { text-align: center; padding: 2rem 1.5rem; color: #666; }
.error-state__icon { font-size: 2.5rem; margin: 0 0 0.5rem; line-height: 1; }
.error-state__message { font-size: 1rem; margin: 0 0 0.5rem; color: #333; }
.error-state__hint { font-size: 0.9rem; color: #888; margin: 0; }
.wizard-intro { text-align: center; margin-top: 2rem; }
.wizard-intro h2 { font-size: 1.4rem; margin-bottom: 0.3rem; color: #333; }
.wizard-intro p { color: #666; font-size: 0.95rem; margin: 0; }
.wizard-container { margin-top: 0.5rem; }
.chat-fullscreen {
  display: flex;
  flex-direction: column;
  height: var(--app-content-height, 100vh);
}

.task-toolbar {
  display: flex;
  gap: 1rem;
  margin-bottom: 1rem;
  align-items: center;
}

.expand-dialog__form { display: flex; flex-direction: column; gap: 1rem; }
.expand-dialog__field label { display: block; font-weight: 600; margin-bottom: 0.25rem; }
.expand-dialog__select { width: 100%; }
.expand-dialog__submit { margin-top: 0.5rem; }
.expand-dialog__error { color: #ef5350; }
.expand-dialog__retry { color: inherit; margin-left: 0.5rem; }
.expand-dialog__checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: #555;
  cursor: pointer;
}

</style>

<!-- Unscoped overrides for AgentWizard inside the teleported PrimeVue Dialog -->
<style>
.refine-tasks-dialog .agent-wizard {
  min-height: unset;
  padding: 0;
  align-items: stretch;
}
.refine-tasks-dialog .wizard-card {
  box-shadow: none;
  padding: 0;
  max-width: unset;
}
.refine-tasks-dialog .wizard-title {
  display: none;
}
</style>
