/**
 * Pure logic for the AskUserQuestion component.
 *
 * Extracted into a separate module so it can be unit-tested without
 * DOM rendering or @vue/test-utils.
 */
import type { QuestionData, QuestionAnswers } from "../stores/chat";

/**
 * Check whether every question in the list has an answer.
 *
 * An answer is considered present when:
 * - `useCustom[i]` is true AND `customTexts[i]` is a non-empty (trimmed) string, OR
 * - `useCustom[i]` is falsy AND `selectedOptions[i]` is a non-empty string (single-select)
 *   or a non-empty array (multi-select).
 */
export function isAllAnswered(
  questions: QuestionData[],
  selectedOptions: Record<number, string | string[]>,
  customTexts: Record<number, string>,
  useCustom: Record<number, boolean>,
): boolean {
  return questions.every((_q, i) => {
    if (useCustom[i]) {
      return (customTexts[i] ?? "").trim().length > 0;
    }
    const sel = selectedOptions[i];
    if (sel === undefined || sel === null) return false;
    if (Array.isArray(sel)) return sel.length > 0;
    return sel !== "";
  });
}

/**
 * Assemble a `QuestionAnswers` map from the component state.
 *
 * Keys are the question texts. Values:
 * - If `useCustom[i]`, the trimmed custom text (always a string).
 * - Otherwise, `selectedOptions[i]` — a string for single-select or
 *   a `string[]` for multi-select.
 */
export function assembleAnswers(
  questions: QuestionData[],
  selectedOptions: Record<number, string | string[]>,
  customTexts: Record<number, string>,
  useCustom: Record<number, boolean>,
): QuestionAnswers {
  const answers: QuestionAnswers = {};
  questions.forEach((q, i) => {
    const key = q.question;
    if (useCustom[i]) {
      answers[key] = customTexts[i]?.trim() ?? "";
    } else {
      answers[key] = selectedOptions[i] ?? (q.multiSelect ? [] : "");
    }
  });
  return answers;
}
