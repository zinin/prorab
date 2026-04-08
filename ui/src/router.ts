import { createRouter, createWebHistory } from "vue-router";
import { useChatStore } from "./stores/chat";
import { useTasksStore } from "./stores/tasks";

const routes = [
  { path: "/", component: () => import("./views/TaskListView.vue") },
  {
    path: "/execution",
    component: () => import("./views/ExecutionView.vue"),
    beforeEnter: async () => {
      const tasksStore = useTasksStore();
      if (!tasksStore.hasTasksFile) return "/";
      // On hard refresh the store starts with optimistic default (true)
      // before WS connected message arrives. Check the server to be sure.
      try {
        const res = await fetch("/api/status");
        if (res.ok) {
          const data = await res.json();
          // Use granular fields (with backward-compatible fallback)
          const hasFile = data.hasTasksFile ?? data.hasTasksJson ?? true;
          if (!hasFile) {
            tasksStore.hasTasksFile = false;
            tasksStore.hasValidTasks = false;
            tasksStore.hasTasksJson = false;
            if (data.hasPrd !== undefined) tasksStore.hasPrd = data.hasPrd;
            return "/";
          }
        }
      } catch {
        // Network error — allow navigation
      }
    },
  },
  {
    path: "/chat",
    component: () => import("./views/ChatView.vue"),
    beforeEnter: async () => {
      const chatStore = useChatStore();
      // Local store already knows about an active session (e.g. just started)
      if (chatStore.state !== "idle") {
        return;
      }
      // On hard refresh the local store starts as idle before WS rehydration.
      // Check the server to avoid a false redirect.
      try {
        const res = await fetch("/api/chat");
        if (res.ok) {
          const data = await res.json();
          if (data.state && data.state !== "idle") {
            return; // server has an active session — allow navigation
          }
        }
      } catch {
        // Network error — fall through to redirect
      }
      return "/";
    },
  },
  { path: "/tasks/:id", component: () => import("./views/TaskDetailView.vue") },
  { path: "/tasks/:taskId/subtasks/:subId", component: () => import("./views/SubtaskDetailView.vue") },
  { path: "/reports", redirect: "/" },
];

export default createRouter({
  history: createWebHistory(),
  routes,
});
