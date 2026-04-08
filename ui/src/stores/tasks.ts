import { defineStore } from "pinia";
import { ref } from "vue";

interface Task {
  id: string | number;
  title: string;
  description?: string;
  status: string;
  dependencies: (string | number)[];
  details?: string;
  testStrategy?: string;
  priority?: string;
  subtasks: Subtask[];
  metadata?: Record<string, unknown>;
}

interface Subtask {
  id: string | number;
  title: string;
  description?: string;
  status: string;
  dependencies: (string | number)[];
  details?: string;
  testStrategy?: string;
  priority?: string;
  metadata?: Record<string, unknown>;
}

export const useTasksStore = defineStore("tasks", () => {
  const tasks = ref<Task[]>([]);
  const loading = ref(false);
  const hasTasksJson = ref(true); // optimistic default — avoids navbar flash
  const wsInitialized = ref(false); // true after first WS connected message

  // Granular project-state flags — populated from GET /api/status and WS connected payload.
  // These are the primary contract; hasTasksJson above is a backward-compatible alias.
  const hasPrd = ref(false);
  const hasTasksFile = ref(true); // optimistic default — mirrors hasTasksJson
  const hasValidTasks = ref(true); // optimistic default

  /**
   * Refresh project-state flags from the server (`GET /api/status`).
   *
   * Sets `hasPrd`, `hasTasksFile`, `hasValidTasks`, and `hasTasksJson`
   * authoritatively — unlike the optimistic `tasks:updated` path which
   * only sets `hasTasksFile`.
   *
   * Called after parse-prd success to confirm that a valid `tasks.json`
   * has appeared on disk before transitioning to the task list.
   */
  async function fetchStatus() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) return;
      const data = await res.json();
      hasPrd.value = (data.hasPrd as boolean) ?? false;
      hasTasksFile.value = (data.hasTasksFile as boolean) ?? ((data.hasTasksJson as boolean) ?? true);
      hasValidTasks.value =
        (data.hasValidTasks as boolean) ?? ((data.hasTasksFile as boolean) ?? ((data.hasTasksJson as boolean) ?? true));
      hasTasksJson.value = (data.hasTasksJson as boolean) ?? true;
    } catch {
      // Silently fail — status will be refreshed on next WS connected
    }
  }

  async function fetchTasks() {
    loading.value = true;
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) return;
      const data = await res.json();
      tasks.value = data.tasks ?? [];
    } finally {
      loading.value = false;
    }
  }

  async function fetchTask(id: string): Promise<Task | null> {
    const res = await fetch(`/api/tasks/${id}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.task;
  }

  async function updateTask(id: string, updates: Partial<Task>) {
    const res = await fetch(`/api/tasks/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Failed to update task ${id}`);
    }
    await fetchTasks();
  }

  async function deleteTask(id: string) {
    const res = await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Failed to delete task ${id}`);
    }
    await fetchTasks();
  }

  async function updateSubtask(taskId: string, subId: string, updates: Partial<Subtask>) {
    const res = await fetch(`/api/tasks/${taskId}/subtasks/${subId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error ?? `Failed to update subtask ${subId}`);
    }
    await fetchTasks();
  }

  return { tasks, loading, hasTasksJson, hasPrd, hasTasksFile, hasValidTasks, wsInitialized, fetchStatus, fetchTasks, fetchTask, updateTask, deleteTask, updateSubtask };
});
