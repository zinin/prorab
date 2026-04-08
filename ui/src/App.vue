<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useWebSocket } from "./composables/useWebSocket";
import { useTasksStore } from "./stores/tasks";
import { useExecutionStore } from "./stores/execution";
import Toast from "primevue/toast";

const { connect, connected } = useWebSocket();
const tasksStore = useTasksStore();
const execStore = useExecutionStore();

const showNavbar = computed(() => tasksStore.wsInitialized && tasksStore.hasTasksFile);

const iterationBadge = computed(() => {
  const cur = execStore.iterationCurrent;
  if (cur === null) return null;
  const total = execStore.iterationTotal;
  return total !== null ? `${cur}/${total}` : `${cur}`;
});

onMounted(() => {
  connect();
  tasksStore.fetchTasks();
});
</script>

<template>
  <div class="app" :class="{ 'no-navbar': !showNavbar }">
    <Toast />
    <nav v-if="showNavbar" class="app-nav">
      <router-link to="/">Tasks</router-link>
      <router-link to="/execution" class="exec-link">
        Execution
        <span v-if="iterationBadge" class="iter-badge">{{ iterationBadge }}</span>
        <span v-if="execStore.state === 'running'" class="exec-indicator" />
      </router-link>
      <span class="connection-status" :class="{ connected }">
        {{ connected ? "Connected" : "Disconnected" }}
      </span>
    </nav>
    <span v-if="!showNavbar && !connected && tasksStore.wsInitialized" class="connection-banner">Disconnected</span>
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>

<style>
body { margin: 0; font-family: system-ui, sans-serif; }
.app { --app-content-height: calc(100vh - 60px); }
.app.no-navbar { --app-content-height: 100vh; }
.app-nav { display: flex; gap: 1rem; padding: 0.75rem 1.5rem; background: #f5f5f5; border-bottom: 1px solid #ddd; align-items: center; }
.app-nav a { text-decoration: none; color: #333; font-weight: 500; }
.app-nav a.router-link-active { color: #3b82f6; }
.exec-link { display: flex; align-items: center; gap: 0.4rem; }
.exec-indicator { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; animation: pulse 1.5s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
.connection-status { margin-left: auto; font-size: 0.8rem; color: #999; }
.connection-status.connected { color: #22c55e; }
.iter-badge { font-size: 0.75rem; background: #e0e0e0; color: #555; padding: 1px 7px; border-radius: 10px; font-weight: 400; }
.connection-banner { display: block; text-align: center; padding: 0.3rem; background: #fee2e2; color: #b91c1c; font-size: 0.8rem; }
.app-main { padding: 0; }
</style>
