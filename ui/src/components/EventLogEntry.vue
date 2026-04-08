<script setup lang="ts">
defineProps<{
  event: {
    type: "text" | "tool" | "tool_result" | "system_prompt" | "task_prompt";
    content: string;
    toolName?: string;
  };
}>();
</script>

<template>
  <template v-if="event.type === 'system_prompt' || event.type === 'task_prompt'">
    <details class="prompt-details">
      <summary class="prompt-summary">
        [{{ event.type === 'system_prompt' ? 'system-prompt' : 'task-prompt' }}] ({{ event.content.length }} chars)
      </summary>
      <pre class="prompt-body">{{ event.content }}</pre>
    </details>
  </template>
  <template v-else>
    <span v-if="event.type === 'tool'" class="event-prefix">[{{ event.toolName }}]</span>
    <span v-else-if="event.type === 'tool_result'" class="event-prefix">[result]</span>
    <span v-else-if="event.type === 'text'" class="event-prefix">[agent]</span>
    <span>{{ event.content }}</span>
  </template>
</template>
