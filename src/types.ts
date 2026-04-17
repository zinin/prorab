import { z } from "zod";

// --- Task types: re-exported from tasks-json-types for backwards compatibility ---
// These were formerly slim schemas defined here. Now they point to the full schemas
// so all consumers get the complete tasks.json structure.

export {
  FullTaskStatusSchema as TaskStatusSchema,
  FullSubtaskSchema as SubtaskSchema,
  FullTaskSchema as TaskSchema,
} from "./core/tasks-json-types.js";

export type {
  FullTask as Task,
  FullSubtask as Subtask,
} from "./core/tasks-json-types.js";

import type { FullTask as Task } from "./core/tasks-json-types.js";
import type { FullTaskStatusSchema } from "./core/tasks-json-types.js";
import type { QuestionData } from "./core/drivers/types.js";

export type TaskStatus = z.infer<typeof FullTaskStatusSchema>;

// --- WebSocket channel type (shared between LogEvent and WsBroadcaster) ---

/** All supported WebSocket event channels. */
export type WsChannel = "chat" | "execute" | "parse-prd" | "expand" | "batch-expand" | "refine-prd" | "refine-tasks";

// --- Log event types (for WebSocket streaming via onLog callback) ---

export type LogEvent =
  | { type: "agent:text"; text: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:reasoning"; text: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:tool"; name: string; summary: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:tool_result"; summary: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:system_prompt"; text: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:task_prompt"; text: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:context_usage"; contextTokens: number; contextWindow: number; model: string; unitId: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:turn_count"; numTurns: number; maxTurns: number; model: string; unitId: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string };

// --- Chat WebSocket event types ---

export interface ChatStartedEvent {
  type: "chat:started";
  channel: "chat";
  sessionId: string;
  agent: string;
  model?: string;
}

export interface ChatQuestionEvent {
  type: "chat:question";
  channel: "chat";
  questionId: string;
  questions: QuestionData[];
  source: "claude" | "opencode";
}

export interface ChatIdleEvent {
  type: "chat:idle";
  channel: "chat";
}

export interface ChatErrorEvent {
  type: "chat:error";
  channel: "chat";
  message: string;
}

export interface ChatFinishedEvent {
  type: "chat:finished";
  channel: "chat";
}

export type ChatWsEvent =
  | ChatStartedEvent
  | ChatQuestionEvent
  | ChatIdleEvent
  | ChatErrorEvent
  | ChatFinishedEvent;

// --- Parse-PRD WebSocket event types ---

/**
 * Terminal outcome for the parse-prd operation.
 *
 * Three states:
 * - `success` — agent completed AND post-validation of tasks.json passed.
 * - `failure` — agent errored, signalled blocked, or post-validation failed.
 * - `cancelled` — user stopped the session or abort signal fired.
 *
 * Canonical definition — re-exported by parse-prd-manager.ts for backward compatibility.
 */
export type ParsePrdManagerOutcome =
  | { status: "success"; hasNextStep?: boolean }
  | { status: "failure"; errors: string[] }
  | { status: "cancelled" };

export interface ParsePrdStartedEvent {
  type: "parse-prd:started";
  channel: "parse-prd";
  sessionId: string;
  agent: string;
  model?: string;
  variant?: string;
}

export interface ParsePrdErrorEvent {
  type: "parse-prd:error";
  channel: "parse-prd";
  message: string;
}

export interface ParsePrdFinishedEvent {
  type: "parse-prd:finished";
  channel: "parse-prd";
  outcome: ParsePrdManagerOutcome;
}

export type ParsePrdWsEvent =
  | ParsePrdStartedEvent
  | ParsePrdErrorEvent
  | ParsePrdFinishedEvent;

// --- Expand WebSocket event types ---

import type { ExpandFailureReasonCode } from "./prompts/expand.js";

/**
 * Terminal outcome for the expand (task decomposition) operation.
 *
 * Three states:
 * - `success` — agent completed, result validated, and subtasks (if any) written + committed.
 * - `failure` — agent errored, result invalid, hash conflict, or commit failed.
 * - `cancelled` — user stopped the session or abort signal fired.
 *
 * All variants carry `taskId` and `subtaskCount` for the UI.
 * `failure` additionally carries a machine-readable `reason`, human-readable `message`,
 * and an `errors` array with detailed diagnostics.
 *
 * Canonical definition — re-exported by expand-manager.ts for backward compatibility.
 */
export type ExpandManagerOutcome =
  | { status: "success"; taskId: string; subtaskCount: number }
  | { status: "failure"; taskId: string; reason: ExpandFailureReasonCode; errors: string[]; message: string; subtaskCount: number }
  | { status: "cancelled"; taskId: string; subtaskCount: number };

export interface ExpandStartedEvent {
  type: "expand:started";
  channel: "expand";
  sessionId: string;
  taskId: string;
  agent: string;
  model?: string;
  variant?: string;
}

export interface ExpandErrorEvent {
  type: "expand:error";
  channel: "expand";
  message: string;
  reason: ExpandFailureReasonCode;
}

export interface ExpandFinishedEvent {
  type: "expand:finished";
  channel: "expand";
  outcome: ExpandManagerOutcome;
}

export type ExpandWsEvent =
  | ExpandStartedEvent
  | ExpandErrorEvent
  | ExpandFinishedEvent;

// --- Batch-expand types ---

export type BatchExpandTaskOutcome = {
  taskId: number;
  complexityScore: number | null;    // null if task failed before complexity completed
  recommendedSubtasks: number | null; // null if task failed before complexity completed
  subtaskCount: number | null;        // null if task failed before expand completed
  skipped: boolean;
  error?: string;
};

export type BatchExpandOutcome = {
  status: "success" | "cancelled";
  tasks: BatchExpandTaskOutcome[];
};

export interface BatchExpandStartedEvent {
  type: "batch_expand:started";
  channel: "batch-expand";
  taskIds: number[];
  slotCount: number;
  taskTitles: Record<number, string>;
}

export interface BatchExpandSlotStartedEvent {
  type: "batch_expand:slot_started";
  channel: "batch-expand";
  slotIndex: number;
  taskId: number;
  phase: "complexity" | "expand";
}

export interface BatchExpandComplexityDoneEvent {
  type: "batch_expand:complexity_done";
  channel: "batch-expand";
  slotIndex: number;
  taskId: number;
  score: number;
  recommendedSubtasks: number;
}

export interface BatchExpandSlotFinishedEvent {
  type: "batch_expand:slot_finished";
  channel: "batch-expand";
  slotIndex: number;
  taskId: number;
  subtaskCount: number;
  skipped: boolean;
}

export interface BatchExpandErrorEvent {
  type: "batch_expand:error";
  channel: "batch-expand";
  slotIndex?: number;
  taskId?: number;
  message: string;
  reason: string;
}

export interface BatchExpandProgressEvent {
  type: "batch_expand:progress";
  channel: "batch-expand";
  completed: number;
  total: number;
  errors: number;
  skipped: number;
}

export interface BatchExpandFinishedEvent {
  type: "batch_expand:finished";
  channel: "batch-expand";
  outcome: BatchExpandOutcome;
}

export type BatchExpandWsEvent =
  | BatchExpandStartedEvent
  | BatchExpandSlotStartedEvent
  | BatchExpandComplexityDoneEvent
  | BatchExpandSlotFinishedEvent
  | BatchExpandErrorEvent
  | BatchExpandProgressEvent
  | BatchExpandFinishedEvent;

// --- Refine-PRD WebSocket event types ---

export type {
  RefinePrdManagerOutcome,
  RefinePrdStartedEvent,
  RefinePrdStepStartedEvent,
  RefinePrdStepFinishedEvent,
  RefinePrdQuestionEvent,
  RefinePrdErrorEvent,
  RefinePrdFinishedEvent,
  RefinePrdWsEvent,
} from "./types-refine-prd.js";

// --- Refine-Tasks WebSocket event types ---

export type {
  RefineTasksManagerOutcome,
  RefineTasksStartedEvent,
  RefineTasksStepStartedEvent,
  RefineTasksStepFinishedEvent,
  RefineTasksQuestionEvent,
  RefineTasksErrorEvent,
  RefineTasksFinishedEvent,
  RefineTasksWsEvent,
} from "./types-refine-tasks.js";

export type OnLogCallback = (event: LogEvent) => void;

// --- Prorab types ---

export interface ExecutionUnit {
  type: "task" | "subtask";
  taskId: string;
  subtaskId?: string;
  title: string;
  description?: string;
  details?: string;
  testStrategy?: string;
  parentTask: Task;
}

export type AgentSignal =
  | { type: "complete" }
  | { type: "blocked"; reason: string }
  | { type: "error"; message: string }
  | { type: "none" };

export interface IterationResult {
  signal: AgentSignal;
  durationMs: number;
  costUsd: number;
  numTurns: number;
  resultText: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  model: string;
  agentReport: string | null;  // parsed from <task-report> tag
  reviewReport: string | null; // parsed from <review-report> tag
  startedAt: string;           // ISO timestamp
  finishedAt: string;          // ISO timestamp
}

export type Verbosity = "quiet" | "info" | "debug" | "trace";

export const AgentTypeSchema = z.enum(["claude", "opencode", "ccs", "codex"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

/** Shared Zod schema for a single agent step (used by refine-prd, parse-prd, refine-tasks routes). */
export const AgentStepSchema = z.object({
  agent: AgentTypeSchema,
  model: z.string().optional(),
  variant: z.string().optional(),
});

export const ReviewerSchema = z.object({
  agent: AgentTypeSchema,
  model: z.string().optional(),
  variant: z.string().optional(),
});
export type Reviewer = z.infer<typeof ReviewerSchema>;

export const AGGREGATOR_REVIEWER_ID = "aggregator" as const;

export interface ReviewResult {
  reviewer: Reviewer;
  reviewerId: string;
  signal: AgentSignal;
  reviewReport: string | null;
  iterationResult: IterationResult;
}

export interface ModelEntry {
  id: string;
  name: string;
  variants?: string[];
}

export type ExecutionEvent =
  | { type: "execution:multi_review_started"; taskId: string; reviewers: Array<{ agent: string; model?: string; variant?: string; reviewerId: string }> }
  | { type: "execution:reviewer_finished"; taskId: string; reviewerId: string; signal: AgentSignal; hasReport: boolean }
  | { type: "execution:multi_review_finished"; taskId: string; successCount: number; failCount: number };

export interface RunOptions {
  agent: AgentType;
  model?: string;
  variant?: string;
  maxRetries: number;
  maxTurns: number;
  reviewMaxTurns: number;
  allowDirty: boolean;
  quiet: boolean;
  debug: boolean;
  trace: boolean;
  maxIterations?: number;
  userSettings: boolean;
  applyHooks: boolean;
  review: boolean;
  reviewers?: Reviewer[];
  reviewRounds: number;
  reviewContext: boolean;
  onLog?: OnLogCallback;
  onExecutionEvent?: (event: ExecutionEvent) => void;
}

/** Derive verbosity level from CLI flags. --trace > --debug > --quiet > info. */
export function getVerbosity(opts: RunOptions): Verbosity {
  if (opts.trace) return "trace";
  if (opts.debug) return "debug";
  if (opts.quiet) return "quiet";
  return "info";
}
