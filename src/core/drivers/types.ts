import type { AgentSignal, IterationResult, ModelEntry, OnLogCallback, Verbosity } from "../../types.js";

export interface SetupOptions {
  verbosity: Verbosity;
  abortSignal?: AbortSignal;
}

export interface SessionOptions {
  prompt: string;
  systemPrompt: string;
  cwd: string;
  maxTurns: number;
  abortController?: AbortController;
  verbosity: Verbosity;
  onLog?: OnLogCallback;
  variant?: string;
  unitId: string;
  /** SDK hook configuration, passed through to query(). Used by CcsDriver. */
  hooks?: Record<string, unknown[]>;
  /** Environment variables passed to the SDK query(). Overrides process.env per-session. Used by CcsDriver. */
  env?: Record<string, string | undefined>;
}

// --- Interactive chat types ---

export interface ChatOptions {
  systemPrompt?: string;
  cwd: string;
  /** Maximum agentic turns. When omitted, the driver uses its default (unlimited). */
  maxTurns?: number;
  verbosity: Verbosity;
  onLog?: OnLogCallback;
  variant?: string;
  hooks?: Record<string, unknown[]>;
  env?: Record<string, string | undefined>;
}

export interface QuestionData {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export type QuestionAnswerValue = string | string[];
export type QuestionAnswers = Record<string, QuestionAnswerValue>;

export type ChatEvent =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool"; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; name: string; output: string }
  | { type: "context_usage"; usage: Record<string, unknown> }
  | { type: "question"; questionId: string; questions: QuestionData[]; source: "claude" | "opencode" }
  | { type: "question_answer"; questionId: string; answers: QuestionAnswers }
  | { type: "idle" }
  | { type: "finished" }
  | { type: "error"; message: string };

export interface AgentDriver {
  runSession(opts: SessionOptions): Promise<IterationResult>;
  setup?(opts: SetupOptions): Promise<void>;
  teardown?(): Promise<void>;
  listModels?(): Promise<ModelEntry[]>;

  // Interactive chat methods
  startChat(opts: ChatOptions): AsyncIterable<ChatEvent>;
  sendMessage(text: string): void;
  replyQuestion(questionId: string, answers: QuestionAnswers): void;
  abortChat(): void;
}

// "No nested same-tag" pattern: content between opening and closing tags must
// NOT contain another opening tag of the same type. This prevents false matches
// when models quote XML signal tags from the system prompt in their reasoning.
// E.g. "Before writing <task-report> and signaling..." won't pair with the real
// </task-report> because the real <task-report> sits between them.
const COMPLETE_REGEX = /<task-complete>((?:(?!<task-complete>)[\s\S])*?)<\/task-complete>/i;
const BLOCKED_REGEX = /<task-blocked>((?:(?!<task-blocked>)[\s\S])*?)<\/task-blocked>/i;
const REPORT_MAX_LENGTH = 5000;

export function parseReport(text: string): string | null {
  const matches = [...text.matchAll(/<task-report>((?:(?!<task-report>)[\s\S])*?)<\/task-report>/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1][1].trim();
  if (!last) return null;
  return last.length > REPORT_MAX_LENGTH ? last.slice(0, REPORT_MAX_LENGTH) : last;
}

export function parseReviewReport(text: string): string | null {
  const matches = [...text.matchAll(/<review-report>((?:(?!<review-report>)[\s\S])*?)<\/review-report>/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1][1].trim();
  if (!last) return null;
  return last.length > REPORT_MAX_LENGTH ? last.slice(0, REPORT_MAX_LENGTH) : last;
}

/**
 * Checks whether `<prd-ready>true</prd-ready>` is the final non-whitespace
 * content in the accumulated assistant-turn buffer.
 *
 * Used by chat-flow auto-finish: only a **terminal** occurrence counts —
 * the tag must appear on its own line or be the entire buffer content.
 * Quoted, intermediate, inline, or mid-text tags are ignored.
 *
 * @param text - Accumulated assistant-turn buffer (concatenated chunks).
 * @returns `true` if the tag is the terminal content (on its own line or as
 *   the entire buffer).
 */
const PRD_READY_REGEX = /(?:^|\n)\s*<prd-ready>\s*true\s*<\/prd-ready>\s*$/i;

export function parsePrdReadySignal(text: string): boolean {
  return PRD_READY_REGEX.test(text);
}

export function parseSignal(text: string): AgentSignal {
  const blockedMatch = text.match(BLOCKED_REGEX);
  if (blockedMatch) {
    return { type: "blocked", reason: blockedMatch[1].trim() };
  }
  const completeMatch = text.match(COMPLETE_REGEX);
  if (completeMatch) {
    return { type: "complete" };
  }
  return { type: "none" };
}
