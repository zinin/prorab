<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import Panel from "primevue/panel";

// Local instance to avoid mutating global marked singleton
const md = new Marked({
  renderer: {
    // Links: open in new tab with noopener to prevent reverse tabnabbing
    link({ href, title, text }) {
      const titleAttr = title ? ` title="${title}"` : "";
      return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

const props = defineProps<{ unitId: string }>();

const html = ref("");
const loaded = ref(false);
let abortController: AbortController | null = null;

async function fetchReport() {
  // Cancel previous in-flight request
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const { signal } = abortController;

  loaded.value = false;
  html.value = "";
  try {
    const res = await fetch(`/api/reports/${props.unitId}`, { signal });
    if (!res.ok) return;
    const data = await res.json();
    if (typeof data.content !== "string") return;
    const raw = md.parse(data.content) as string;
    html.value = DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return;
    // Network error — hide section
  } finally {
    if (!signal.aborted) loaded.value = true;
  }
}

watch(() => props.unitId, fetchReport, { immediate: true });

onBeforeUnmount(() => {
  if (abortController) abortController.abort();
});
</script>

<template>
  <Panel v-if="loaded && html" header="Execution Report" toggleable collapsed class="report-section">
    <div class="report-content" v-html="html" />
  </Panel>
</template>

<style scoped>
.report-section { margin-top: 2rem; }
.report-content {
  background: #f5f5f5;
  padding: 1rem;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 0.85rem;
  line-height: 1.6;
}
.report-content :deep(h2) { font-size: 1.1rem; margin: 1rem 0 0.5rem; border-bottom: 1px solid #ddd; padding-bottom: 0.25rem; }
.report-content :deep(h3) { font-size: 1rem; margin: 0.75rem 0 0.25rem; }
.report-content :deep(ul), .report-content :deep(ol) { margin: 0.5rem 0; padding-left: 1.5rem; }
.report-content :deep(code) { background: #e8e8e8; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 0.82rem; }
.report-content :deep(pre) { background: #e0e0e0; padding: 0.75rem; border-radius: 4px; overflow-x: auto; }
.report-content :deep(pre code) { background: none; padding: 0; }
.report-content :deep(hr) { border: none; border-top: 2px solid #ddd; margin: 1.5rem 0; }
.report-content :deep(strong) { font-weight: 600; }
</style>
