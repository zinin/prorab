/**
 * Pure formatting logic for the ChatMessageItem component.
 *
 * Extracted into a separate module so it can be unit-tested without
 * DOM rendering or @vue/test-utils.
 */
import type { ChatMessage } from "../stores/chat";

/** Truncate long text to maxLen characters, appending ellipsis if needed. */
export function truncate(text: string, maxLen = 100): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "\u2026";
}

/** Parsed context usage data. */
export interface ContextUsageData {
  contextTokens: number;
  contextWindow: number;
  model: string;
  agent?: string;
  variant?: string;
}

/** Parse context_usage content JSON safely, returning null on failure. */
export function parseContextUsage(content: string): ContextUsageData | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/** Format context usage as a compact percentage string. */
export function formatContextUsage(content: string): string {
  const data = parseContextUsage(content);
  if (!data) return content;
  const pct = Math.round((data.contextTokens / data.contextWindow) * 100);
  // Build label: "agent/model[:variant]"
  const parts: string[] = [];
  if (data.agent) parts.push(data.agent);
  if (data.model) parts.push(data.model);
  let label = parts.join("/");
  if (data.variant) label += `:${data.variant}`;
  return `${pct}% context used (${data.contextTokens.toLocaleString()} / ${data.contextWindow.toLocaleString()} tokens) \u2014 ${label}`;
}

/** Format question_answer content for display. */
export function formatAnswers(message: ChatMessage): string {
  if (message.answers) {
    return Object.entries(message.answers)
      .map(([q, a]) => `${q}: ${Array.isArray(a) ? a.join(", ") : a}`)
      .join("\n");
  }
  // Fallback: content is JSON string
  try {
    const parsed = JSON.parse(message.content);
    return Object.entries(parsed)
      .map(([q, a]) => `${q}: ${Array.isArray(a) ? (a as string[]).join(", ") : a}`)
      .join("\n");
  } catch {
    return message.content;
  }
}
