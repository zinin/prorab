<script setup lang="ts">
import { ref } from "vue";
import { useToast } from "primevue/usetoast";
import { useChatStore } from "../stores/chat";
import type { QuestionAnswers } from "../stores/chat";
import { IDEA_TO_PRD_PROMPT } from "../constants/prompts";
import AgentChatPanel from "../components/AgentChatPanel.vue";
import AgentWizard from "../components/AgentWizard.vue";

const chatStore = useChatStore();
const toast = useToast();

const startingChat = ref(false);

async function handleWizardStart(config: {
  agent: string;
  model?: string;
  variant?: string;
  initialMessage?: string;
  userSettings?: boolean;
  applyHooks?: boolean;
}) {
  startingChat.value = true;
  try {
    // Two-step orchestration: start session with systemPrompt, then send the initial message.
    // The parent injects systemPrompt — the wizard only provides user configuration.
    // TODO: support selecting different skills/chat modes (e.g. task refinement, code review)
    //       instead of always using the idea-to-prd prompt.
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
  } catch (err: unknown) {
    toast.add({ severity: "error", summary: "Start Error", detail: err instanceof Error ? err.message : String(err), life: 5000 });
  } finally {
    startingChat.value = false;
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
</script>

<template>
  <div class="chat-view">
    <AgentWizard
      v-if="chatStore.state === 'idle'"
      :starting="startingChat"
      @start="handleWizardStart"
    />
    <AgentChatPanel
      v-else
      :messages="chatStore.messages"
      :state="chatStore.state"
      :awaiting-user-input="chatStore.awaitingUserInput"
      :pending-question="chatStore.pendingQuestion"
      :can-stop="chatStore.state !== 'idle'"
      @send="handleSend"
      @reply="handleReply"
      @stop="handleStop"
    />
  </div>
</template>

<style scoped>
.chat-view {
  display: flex;
  flex-direction: column;
  height: var(--app-content-height, 100vh);
}
</style>
