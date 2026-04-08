<script setup lang="ts">
defineProps<{
  context: {
    task: Record<string, unknown>;
    subtask: Record<string, unknown> | null;
  };
}>();

const statusColors: Record<string, string> = {
  pending: "#888",
  "in-progress": "#3b82f6",
  done: "#22c55e",
  blocked: "#ef4444",
  review: "#f59e0b",
  rework: "#f97316",
  closed: "#6b7280",
};
</script>

<template>
  <div class="task-context-panel">
    <!-- Header -->
    <div class="panel-header">
      <template v-if="context.subtask">
        <span class="unit-label">Subtask #{{ context.task.id }}.{{ context.subtask.id }}</span>
        <h3 class="unit-title">{{ context.subtask.title }}</h3>
      </template>
      <template v-else>
        <span class="unit-label">Task #{{ context.task.id }}</span>
        <h3 class="unit-title">{{ context.task.title }}</h3>
      </template>
    </div>

    <!-- Description -->
    <section v-if="(context.subtask?.description ?? context.task.description)" class="panel-section">
      <h4>Description</h4>
      <p class="section-text">{{ context.subtask?.description ?? context.task.description }}</p>
    </section>

    <!-- Details -->
    <section v-if="(context.subtask?.details ?? context.task.details)" class="panel-section">
      <h4>Details</h4>
      <div class="section-text scrollable">{{ context.subtask?.details ?? context.task.details }}</div>
    </section>

    <!-- Test Strategy -->
    <section v-if="(context.subtask?.testStrategy ?? context.task.testStrategy)" class="panel-section">
      <h4>Test Strategy</h4>
      <p class="section-text">{{ context.subtask?.testStrategy ?? context.task.testStrategy }}</p>
    </section>

    <!-- Parent Task (when executing a subtask) -->
    <section v-if="context.subtask" class="panel-section">
      <h4>Parent Task #{{ context.task.id }}</h4>
      <p class="section-text parent-title">{{ context.task.title }}</p>
      <p v-if="context.task.description" class="section-text dimmed">{{ context.task.description }}</p>
    </section>

    <!-- Subtasks list -->
    <section v-if="(context.task.subtasks as unknown[])?.length" class="panel-section">
      <h4>Subtasks</h4>
      <ul class="subtask-list">
        <li
          v-for="st in (context.task.subtasks as Record<string, unknown>[])"
          :key="String(st.id)"
          class="subtask-item"
          :class="{ current: context.subtask && String(st.id) === String(context.subtask.id) }"
        >
          <span
            class="status-dot"
            :style="{ backgroundColor: statusColors[String(st.status)] || '#888' }"
            :title="String(st.status)"
          />
          <span class="subtask-id">#{{ context.task.id }}.{{ st.id }}</span>
          <span class="subtask-title">{{ st.title }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.task-context-panel {
  font-size: 0.85rem;
}
.panel-header {
  margin-bottom: 1rem;
}
.unit-label {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: #3b82f6;
  letter-spacing: 0.05em;
}
.unit-title {
  margin: 0.25rem 0 0;
  font-size: 1rem;
  font-weight: 600;
  color: #1e293b;
}
.panel-section {
  margin-bottom: 1rem;
}
.panel-section h4 {
  margin: 0 0 0.35rem;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: #94a3b8;
  letter-spacing: 0.05em;
}
.section-text {
  margin: 0;
  color: #334155;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.section-text.scrollable {
  max-height: 200px;
  overflow-y: auto;
}
.section-text.parent-title {
  font-weight: 600;
}
.section-text.dimmed {
  color: #64748b;
  font-size: 0.8rem;
  margin-top: 0.25rem;
}
.subtask-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.subtask-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.3rem 0.4rem;
  border-radius: 4px;
  font-size: 0.8rem;
}
.subtask-item.current {
  background: #eff6ff;
  font-weight: 600;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.subtask-id {
  color: #64748b;
  flex-shrink: 0;
}
.subtask-title {
  color: #334155;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
