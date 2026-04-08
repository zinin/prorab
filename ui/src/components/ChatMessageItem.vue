<script setup lang="ts">
import type { ChatMessage } from "../stores/chat";
import { truncate, formatContextUsage, formatAnswers } from "./chat-message-logic";

const props = defineProps<{
  message: ChatMessage;
}>();

/** Format timestamp as HH:MM:SS */
function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
</script>

<template>
  <div
    class="chat-message"
    :class="[
      `chat-message--${message.type}`,
      { 'chat-message--right': message.type === 'user' || message.type === 'question_answer' },
    ]"
  >
    <!-- User message -->
    <template v-if="message.type === 'user'">
      <div class="chat-bubble chat-bubble--user">
        <span class="chat-bubble__text">{{ message.content }}</span>
        <span class="chat-timestamp">{{ formatTime(message.timestamp) }}</span>
      </div>
    </template>

    <!-- Agent text -->
    <template v-else-if="message.type === 'text'">
      <div class="chat-bubble chat-bubble--text">
        <span class="event-prefix">[agent]</span>
        <span class="chat-bubble__text">{{ message.content }}</span>
        <span class="chat-timestamp">{{ formatTime(message.timestamp) }}</span>
      </div>
    </template>

    <!-- Reasoning (collapsible) -->
    <template v-else-if="message.type === 'reasoning'">
      <details class="tool-details">
        <summary class="tool-summary tool-summary--reasoning">
          <span class="chat-tool-icon pi pi-lightbulb"></span>
          [reasoning] ({{ message.content.length }} chars)
          <span class="chat-timestamp-inline">{{ formatTime(message.timestamp) }}</span>
        </summary>
        <pre class="tool-body tool-body--reasoning">{{ message.content }}</pre>
      </details>
    </template>

    <!-- Tool call -->
    <template v-else-if="message.type === 'tool'">
      <details class="tool-details">
        <summary class="tool-summary tool-summary--call">
          <span class="chat-tool-icon pi pi-code"></span>
          [{{ message.toolName ?? "tool" }}]
          <span class="chat-timestamp-inline">{{ formatTime(message.timestamp) }}</span>
        </summary>
        <pre v-if="message.content" class="tool-body">{{ message.content }}</pre>
      </details>
    </template>

    <!-- Tool result -->
    <template v-else-if="message.type === 'tool_result'">
      <details class="tool-details">
        <summary class="tool-summary tool-summary--result">
          [result]
          <span class="chat-timestamp-inline">{{ formatTime(message.timestamp) }}</span>
        </summary>
        <pre v-if="message.content" class="tool-body tool-body--result">{{ message.content }}</pre>
      </details>
    </template>

    <!-- Question placeholder (rendered by AskUserQuestion in parent) -->
    <template v-else-if="message.type === 'question'">
      <div class="chat-bubble chat-bubble--question">
        <span class="chat-tool-icon pi pi-question-circle"></span>
        <span class="chat-bubble__text">Agent is asking a question...</span>
        <span class="chat-timestamp">{{ formatTime(message.timestamp) }}</span>
      </div>
    </template>

    <!-- Question answer -->
    <template v-else-if="message.type === 'question_answer'">
      <div class="chat-bubble chat-bubble--answer">
        <span class="chat-bubble__text">{{ formatAnswers(message) }}</span>
        <span class="chat-timestamp">{{ formatTime(message.timestamp) }}</span>
      </div>
    </template>

    <!-- Context usage -->
    <template v-else-if="message.type === 'context_usage'">
      <div class="chat-bubble chat-bubble--context">
        <span class="chat-tool-icon pi pi-chart-bar"></span>
        <span class="chat-bubble__text">{{ formatContextUsage(message.content) }}</span>
      </div>
    </template>

    <!-- System prompt (collapsible, matches ExecutionView EventLogEntry style) -->
    <template v-else-if="message.type === 'system_prompt'">
      <details class="prompt-details">
        <summary class="prompt-summary">
          [system-prompt] ({{ message.content.length }} chars)
        </summary>
        <pre class="prompt-body">{{ message.content }}</pre>
      </details>
    </template>

    <!-- Error -->
    <template v-else-if="message.type === 'error'">
      <div class="chat-bubble chat-bubble--error">
        <span class="chat-tool-icon pi pi-exclamation-triangle"></span>
        <span class="chat-bubble__text">{{ message.content }}</span>
        <span class="chat-timestamp">{{ formatTime(message.timestamp) }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* ---- Layout ---- */
.chat-message {
  display: flex;
  padding: 2px 0;
}
.chat-message--right {
  justify-content: flex-end;
}

/* ---- Bubble base ---- */
.chat-bubble {
  position: relative;
  max-width: 85%;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  font-family: monospace;
  font-size: 0.8rem;
  line-height: 1.4;
  white-space: pre-wrap;
  word-break: break-word;
}

.chat-bubble__text {
  vertical-align: middle;
}

/* ---- Type-specific styles (colours via shared chat.css variables) ---- */

/* User: right-aligned, light blue (chat-style) */
.chat-bubble--user {
  background: var(--chat-bg-user);
  color: var(--chat-text-user);
}

/* Agent text: left-aligned, dark gray (terminal-style) */
.chat-bubble--text {
  background: var(--chat-bg-surface);
  color: var(--chat-text-primary);
}

/* Tool call: blue tint (matches .event-line.tool in ExecutionView) */
.chat-bubble--tool {
  background: var(--chat-bg-tool);
  color: var(--chat-tool-color);
}

/* Tool result: green tint (matches .event-line.tool_result) */
.chat-bubble--tool-result {
  background: var(--chat-bg-result);
  color: var(--chat-result-color);
}

/* Question placeholder */
.chat-bubble--question {
  background: var(--chat-bg-question);
  color: var(--chat-question-color);
  font-style: italic;
}

/* User answer: right-aligned, muted blue */
.chat-bubble--answer {
  background: var(--chat-bg-answer);
  color: var(--chat-text-answer);
}

/* Context usage: compact inline */
.chat-bubble--context {
  background: transparent;
  color: var(--chat-text-muted);
  font-size: 0.7rem;
  padding: 1px 0;
  max-width: 100%;
}

/* Error: red background */
.chat-bubble--error {
  background: var(--chat-bg-error);
  color: var(--chat-error-color);
}

/* ---- Shared sub-elements ---- */

/* Prefix label (reuses EventLogEntry pattern) */
.event-prefix {
  color: var(--chat-prefix-color);
  margin-right: 0.5rem;
  font-weight: 600;
}

/* Tool / status icon */
.chat-tool-icon {
  margin-right: 0.35rem;
  font-size: 0.75rem;
  vertical-align: middle;
}

/* Pre block for tool results */
.chat-pre {
  margin: 0.25rem 0 0;
  padding: 0.35rem 0.5rem;
  background: rgba(26, 42, 26, 0.6);
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
  font-size: 0.75rem;
  white-space: pre-wrap;
  word-break: break-word;
}

/* Tool call / result collapsible blocks */
.tool-details {
  margin: 2px 0;
  font-family: monospace;
  font-size: 0.8rem;
}
.tool-summary {
  cursor: pointer;
  user-select: none;
  font-weight: 600;
}
.tool-summary--call {
  color: var(--chat-tool-color);
}
.tool-summary--result {
  color: var(--chat-result-color);
}
.tool-summary--reasoning {
  color: #b39ddb;
}
.tool-body--reasoning {
  background: rgba(50, 30, 70, 0.4);
  color: #ce93d8;
}
.tool-summary:hover {
  opacity: 0.8;
}
.tool-body {
  color: var(--chat-text-primary);
  background: var(--chat-bg-tool);
  padding: 0.5rem;
  margin: 0.25rem 0 0;
  border-radius: 4px;
  max-height: 300px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.75rem;
}
.tool-body--result {
  background: var(--chat-bg-result);
}
.chat-timestamp-inline {
  font-size: 0.6rem;
  color: var(--chat-text-muted);
  margin-left: 0.5rem;
  opacity: 0.7;
  font-weight: 400;
}

/* Prompt collapsible blocks (mirrors ExecutionView EventLogEntry style) */
.prompt-details {
  margin: 2px 0;
  font-family: monospace;
  font-size: 0.8rem;
}
.prompt-summary {
  color: var(--chat-prefix-color);
  cursor: pointer;
  user-select: none;
}
.prompt-summary:hover {
  color: #e0a98a;
}
.prompt-body {
  color: var(--chat-prompt-color);
  background: var(--chat-bg-surface);
  padding: 0.5rem;
  margin: 0.25rem 0 0;
  border-radius: 4px;
  max-height: 400px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.75rem;
}

/* Timestamp */
.chat-timestamp {
  display: block;
  text-align: right;
  font-size: 0.6rem;
  color: var(--chat-text-muted);
  margin-top: 2px;
  opacity: 0.7;
}
</style>
