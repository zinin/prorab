<script setup lang="ts">
import { ref, computed } from "vue";
import RadioButton from "primevue/radiobutton";
import Checkbox from "primevue/checkbox";
import Textarea from "primevue/textarea";
import Button from "primevue/button";
import type { QuestionData, QuestionAnswers } from "../stores/chat";
import { isAllAnswered, assembleAnswers } from "./ask-question-logic";

export interface AskUserQuestionProps {
  question: {
    questionId: string;
    questions: QuestionData[];
    source: "claude" | "opencode";
  };
}

const props = defineProps<AskUserQuestionProps>();

const emit = defineEmits<{
  reply: [answers: QuestionAnswers];
}>();

// --- State ---

/** Selected option(s) per question index: string for single-select, string[] for multi-select */
const selectedOptions = ref<Record<number, string | string[]>>({});

/** Custom free-text per question index */
const customTexts = ref<Record<number, string>>({});

/** Whether the user is using custom text instead of options for a given question */
const useCustom = ref<Record<number, boolean>>({});

// --- Computed ---

/** Whether every question has an answer (either selected option or custom text) */
const allAnswered = computed(() =>
  isAllAnswered(props.question.questions, selectedOptions.value, customTexts.value, useCustom.value),
);

// --- Actions ---

function handleSubmit() {
  if (!allAnswered.value) return;
  emit("reply", assembleAnswers(props.question.questions, selectedOptions.value, customTexts.value, useCustom.value));
}

/** Generate a stable input ID for PrimeVue components */
function inputId(questionIdx: number, optionIdx: number): string {
  return `q${props.question.questionId}-${questionIdx}-opt-${optionIdx}`;
}

/** Generate a group name for radio/checkbox groups */
function groupName(questionIdx: number): string {
  return `q${props.question.questionId}-${questionIdx}`;
}
</script>

<template>
  <div class="ask-question">
    <div
      v-for="(q, qi) in question.questions"
      :key="qi"
      class="ask-question__item"
    >
      <!-- Header chip -->
      <span v-if="q.header" class="ask-question__header">{{ q.header }}</span>

      <!-- Question text -->
      <p class="ask-question__text">{{ q.question }}</p>

      <!-- Options -->
      <div class="ask-question__options">
        <!-- Single-select: RadioButton group -->
        <template v-if="!q.multiSelect">
          <div
            v-for="(opt, oi) in q.options"
            :key="oi"
            class="ask-question__option"
            :class="{ 'ask-question__option--selected': selectedOptions[qi] === opt.label && !useCustom[qi] }"
          >
            <RadioButton
              v-model="selectedOptions[qi]"
              :inputId="inputId(qi, oi)"
              :name="groupName(qi)"
              :value="opt.label"
              :disabled="useCustom[qi]"
            />
            <label :for="inputId(qi, oi)" class="ask-question__label">
              <span class="ask-question__label-text">{{ opt.label }}</span>
              <span v-if="opt.description" class="ask-question__label-desc">{{ opt.description }}</span>
            </label>
          </div>
        </template>

        <!-- Multi-select: Checkbox group -->
        <template v-else>
          <div
            v-for="(opt, oi) in q.options"
            :key="oi"
            class="ask-question__option"
            :class="{ 'ask-question__option--selected': Array.isArray(selectedOptions[qi]) && (selectedOptions[qi] as string[]).includes(opt.label) && !useCustom[qi] }"
          >
            <Checkbox
              v-model="selectedOptions[qi]"
              :inputId="inputId(qi, oi)"
              :name="groupName(qi)"
              :value="opt.label"
              :disabled="useCustom[qi]"
            />
            <label :for="inputId(qi, oi)" class="ask-question__label">
              <span class="ask-question__label-text">{{ opt.label }}</span>
              <span v-if="opt.description" class="ask-question__label-desc">{{ opt.description }}</span>
            </label>
          </div>
        </template>
      </div>

      <!-- Custom text input -->
      <div class="ask-question__custom">
        <label class="ask-question__custom-toggle">
          <Checkbox
            v-model="useCustom[qi]"
            :binary="true"
            :inputId="`custom-toggle-${qi}`"
          />
          <span class="ask-question__custom-label">Or type your own answer...</span>
        </label>
        <Textarea
          v-if="useCustom[qi]"
          v-model="customTexts[qi]"
          class="ask-question__custom-input"
          placeholder="Type your answer..."
          autoResize
          rows="2"
        />
      </div>
    </div>

    <!-- Submit button -->
    <div class="ask-question__actions">
      <Button
        label="Submit"
        icon="pi pi-check"
        :disabled="!allAnswered"
        @click="handleSubmit"
        size="small"
        class="ask-question__submit"
      />
    </div>
  </div>
</template>

<style scoped>
.ask-question {
  background: var(--chat-ask-bg);
  border-radius: 8px;
  padding: 0.75rem;
  max-width: 85%;
  font-family: monospace;
  font-size: 0.8rem;
  line-height: 1.4;
}

.ask-question__item {
  margin-bottom: 0.75rem;
}
.ask-question__item:last-child {
  margin-bottom: 0.5rem;
}

/* Header chip/tag */
.ask-question__header {
  display: inline-block;
  background: var(--chat-ask-header-bg);
  color: var(--chat-question-color);
  padding: 0.15rem 0.5rem;
  border-radius: 10px;
  font-size: 0.7rem;
  font-weight: 600;
  margin-bottom: 0.35rem;
  letter-spacing: 0.02em;
}

/* Question text */
.ask-question__text {
  color: var(--chat-text-primary);
  margin: 0.25rem 0 0.5rem;
  font-weight: 500;
}

/* Options list */
.ask-question__options {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

/* Single option row */
.ask-question__option {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  padding: 0.3rem 0.5rem;
  border-radius: 4px;
  border: 1px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}
.ask-question__option:hover {
  background: var(--chat-ask-hover-bg);
}
.ask-question__option--selected {
  background: var(--chat-ask-selected-bg);
  border-color: var(--chat-ask-selected-border);
}

/* Option label */
.ask-question__label {
  display: flex;
  flex-direction: column;
  cursor: pointer;
  gap: 0.1rem;
}
.ask-question__label-text {
  color: var(--chat-text-primary);
}
.ask-question__label-desc {
  color: var(--chat-text-muted);
  font-size: 0.7rem;
}

/* Custom text area */
.ask-question__custom {
  margin-top: 0.5rem;
  padding-top: 0.4rem;
  border-top: 1px solid var(--chat-ask-border);
}

.ask-question__custom-toggle {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
}

.ask-question__custom-label {
  color: var(--chat-text-muted);
  font-size: 0.75rem;
  font-style: italic;
}

.ask-question__custom-input {
  width: 100%;
  max-height: 10rem !important;
  overflow-y: auto !important;
  margin-top: 0.35rem;
  font-family: monospace;
  font-size: 0.8rem;
}

/* Submit button area */
.ask-question__actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.5rem;
}
.ask-question__submit {
  font-family: monospace;
}
</style>
