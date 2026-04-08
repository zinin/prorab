<script setup lang="ts">
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useTasksStore } from "../stores/tasks";
import { useToast } from "primevue/usetoast";
import InputText from "primevue/inputtext";
import Textarea from "primevue/textarea";
import Select from "primevue/select";
import Button from "primevue/button";
import ReportSection from "../components/ReportSection.vue";

const route = useRoute();
const router = useRouter();
const tasksStore = useTasksStore();
const toast = useToast();

const parentTask = ref<any>(null);
const subtask = ref<any>(null);
const loading = ref(true);

interface SubtaskDraft {
  title: string;
  status: string;
  priority: string;
  description: string;
  details: string;
  testStrategy: string;
}

const draft = ref<SubtaskDraft>({
  title: "", status: "pending", priority: "", description: "", details: "", testStrategy: "",
});
const snapshot = ref<SubtaskDraft>({
  title: "", status: "pending", priority: "", description: "", details: "", testStrategy: "",
});
const saving = ref(false);

const isDirty = computed(() =>
  JSON.stringify(draft.value) !== JSON.stringify(snapshot.value)
);

const statusOptions = [
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

const taskId = computed(() => String(route.params.taskId));
const subId = computed(() => String(route.params.subId));
const subtaskLabel = computed(() => `${taskId.value}.${subId.value}`);

function syncDraft() {
  if (!subtask.value) return;
  const d: SubtaskDraft = {
    title: subtask.value.title ?? "",
    status: subtask.value.status ?? "pending",
    priority: subtask.value.priority ?? "",
    description: subtask.value.description ?? "",
    details: subtask.value.details ?? "",
    testStrategy: subtask.value.testStrategy ?? "",
  };
  draft.value = { ...d };
  snapshot.value = { ...d };
  // Update last-known server state for remote change detection
  const storeTask = tasksStore.tasks.find((t) => String(t.id) === taskId.value);
  if (storeTask) {
    const storeSub = storeTask.subtasks?.find((s: any) => String(s.id) === subId.value);
    if (storeSub) lastKnownJson.value = JSON.stringify(storeSub);
  }
}

async function loadSubtask() {
  loading.value = true;
  parentTask.value = await tasksStore.fetchTask(taskId.value);
  if (parentTask.value) {
    subtask.value = parentTask.value.subtasks?.find(
      (s: any) => String(s.id) === subId.value
    ) ?? null;
  } else {
    subtask.value = null;
  }
  loading.value = false;
  syncDraft();
}

onMounted(loadSubtask);
watch(() => [route.params.taskId, route.params.subId], loadSubtask);

// Remote update detection (same pattern as TaskDetailView)
const hasRemoteUpdate = ref(false);
const lastKnownJson = ref("");
watch(() => tasksStore.tasks, () => {
  if (!subtask.value || saving.value) return;
  const storeTask = tasksStore.tasks.find((t) => String(t.id) === taskId.value);
  if (!storeTask) return;
  const storeSub = storeTask.subtasks?.find((s: any) => String(s.id) === subId.value);
  if (!storeSub) return;
  const foundJson = JSON.stringify(storeSub);
  if (lastKnownJson.value && foundJson !== lastKnownJson.value) {
    hasRemoteUpdate.value = true;
    toast.add({ severity: "info", summary: "Subtask updated", detail: "This subtask was updated externally. Click Refresh to load changes.", life: 5000 });
  }
  lastKnownJson.value = foundJson;
}, { deep: true });

function refreshSubtask() {
  hasRemoteUpdate.value = false;
  loadSubtask();
}

async function save() {
  if (!subtask.value || !isDirty.value) return;
  saving.value = true;
  try {
    const updates: Record<string, unknown> = {};
    for (const key of Object.keys(draft.value) as (keyof SubtaskDraft)[]) {
      if (draft.value[key] !== snapshot.value[key]) {
        const val = draft.value[key];
        updates[key] = key === "priority" && val === "" ? null : val;
      }
    }
    if (Object.keys(updates).length > 0) {
      await tasksStore.updateSubtask(taskId.value, subId.value, updates);
    }
    await loadSubtask();
    toast.add({ severity: "success", summary: "Saved", life: 2000 });
  } catch (e) {
    toast.add({ severity: "error", summary: "Save failed", detail: String(e), life: 5000 });
  } finally {
    saving.value = false;
  }
}

const dependenciesDisplay = computed(() => {
  if (!subtask.value?.dependencies?.length) return "";
  return subtask.value.dependencies.join(", ");
});
</script>

<template>
  <div class="page-content">
    <div v-if="loading">Loading...</div>
    <div v-else-if="!parentTask">
      <p>Task {{ taskId }} not found.</p>
      <Button label="Back to Tasks" @click="router.push('/')" />
    </div>
    <div v-else-if="!subtask">
      <p>Subtask {{ subtaskLabel }} not found.</p>
      <Button :label="`Back to Task #${taskId}`" @click="router.push(`/tasks/${taskId}`)" />
    </div>
    <div v-else>
    <div style="display: flex; gap: 0.5rem; margin-bottom: 0.75rem;">
      <Button :label="`\u2190 Task #${taskId}`" text @click="router.push(`/tasks/${taskId}`)" />
      <Button v-if="hasRemoteUpdate" label="Refresh" icon="pi pi-refresh" severity="info" size="small" @click="refreshSubtask" />
      <Button label="Save" icon="pi pi-check" @click="save" :disabled="!isDirty" :loading="saving" severity="success" size="small" />
    </div>

    <div class="subtask-header">
      <span class="subtask-id">#{{ subtaskLabel }}</span>
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

    <div v-if="dependenciesDisplay" class="field-group">
      <label>Dependencies</label>
      <span>{{ dependenciesDisplay }}</span>
    </div>

    <div v-if="subtask.metadata?.runAttempts" class="field-group">
      <label>Execution Attempts</label>
      <span>{{ subtask.metadata.runAttempts }}</span>
    </div>

    <!-- Report -->
    <ReportSection :unitId="subtaskLabel" />
    </div>
  </div>
</template>

<style scoped>
.page-content { padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
.subtask-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.5rem; }
.subtask-id { font-size: 1.25rem; font-weight: 600; color: #666; }
.field-group { margin-bottom: 1.25rem; }
.field-group label { display: block; font-weight: 600; margin-bottom: 0.25rem; color: #555; }
</style>
