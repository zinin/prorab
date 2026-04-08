import type { QuestionData } from "./core/drivers/types.js";

/**
 * Terminal outcome for the refine-tasks pipeline.
 */
export type RefineTasksManagerOutcome =
  | { status: "success"; stepsCompleted: number }
  | { status: "failure"; stepIndex: number; error: string }
  | { status: "cancelled" };

export interface RefineTasksStartedEvent {
  type: "refine-tasks:started";
  channel: "refine-tasks";
  sessionId: string;
  steps: Array<{ agent: string; model?: string; variant?: string }>;
  currentStepIndex: number;
}

export interface RefineTasksStepStartedEvent {
  type: "refine-tasks:step_started";
  channel: "refine-tasks";
  stepIndex: number;
  agent: string;
  model?: string;
}

export interface RefineTasksStepFinishedEvent {
  type: "refine-tasks:step_finished";
  channel: "refine-tasks";
  stepIndex: number;
  stepOutcome: "success" | "error";
}

export interface RefineTasksQuestionEvent {
  type: "refine-tasks:question";
  channel: "refine-tasks";
  stepIndex: number;
  questionId: string;
  questions: QuestionData[];
  source: "claude" | "opencode";
}

export interface RefineTasksErrorEvent {
  type: "refine-tasks:error";
  channel: "refine-tasks";
  stepIndex?: number;
  message: string;
}

export interface RefineTasksFinishedEvent {
  type: "refine-tasks:finished";
  channel: "refine-tasks";
  outcome: RefineTasksManagerOutcome;
}

export type RefineTasksWsEvent =
  | RefineTasksStartedEvent
  | RefineTasksStepStartedEvent
  | RefineTasksStepFinishedEvent
  | RefineTasksQuestionEvent
  | RefineTasksErrorEvent
  | RefineTasksFinishedEvent;
