import type { QuestionData } from "./core/drivers/types.js";

/**
 * Terminal outcome for the refine-prd pipeline.
 */
export type RefinePrdManagerOutcome =
  | { status: "success"; stepsCompleted: number; hasNextStep?: boolean }
  | { status: "failure"; stepIndex: number; error: string }
  | { status: "cancelled" };

export interface RefinePrdStartedEvent {
  type: "refine-prd:started";
  channel: "refine-prd";
  sessionId: string;
  steps: Array<{ agent: string; model?: string; variant?: string }>;
  currentStepIndex: number;
}

export interface RefinePrdStepStartedEvent {
  type: "refine-prd:step_started";
  channel: "refine-prd";
  stepIndex: number;
  agent: string;
  model?: string;
}

export interface RefinePrdStepFinishedEvent {
  type: "refine-prd:step_finished";
  channel: "refine-prd";
  stepIndex: number;
  stepOutcome: "success" | "error";
}

export interface RefinePrdQuestionEvent {
  type: "refine-prd:question";
  channel: "refine-prd";
  stepIndex: number;
  questionId: string;
  questions: QuestionData[];
  source: "claude" | "opencode";
}

export interface RefinePrdErrorEvent {
  type: "refine-prd:error";
  channel: "refine-prd";
  stepIndex?: number;
  message: string;
}

export interface RefinePrdFinishedEvent {
  type: "refine-prd:finished";
  channel: "refine-prd";
  outcome: RefinePrdManagerOutcome;
}

export type RefinePrdWsEvent =
  | RefinePrdStartedEvent
  | RefinePrdStepStartedEvent
  | RefinePrdStepFinishedEvent
  | RefinePrdQuestionEvent
  | RefinePrdErrorEvent
  | RefinePrdFinishedEvent;
