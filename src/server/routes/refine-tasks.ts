import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentTypeSchema, AgentStepSchema } from "../../types.js";
import type { QuestionAnswers } from "../../core/drivers/types.js";
import type { RefineTasksManager } from "../refine-tasks-manager.js";
import {
  RefineTasksSessionActiveError,
  RefineTasksNotReadyError,
  RefineTasksQuestionMismatchError,
} from "../refine-tasks-manager.js";
import { checkTasksFile } from "../../core/project-state.js";

// --- Zod schemas for Refine-Tasks API endpoints ---

export const StartRefineTasksBodySchema = z
  .object({
    steps: z.array(AgentStepSchema).min(1).max(20),
    verbosity: z.enum(["quiet", "info", "debug", "trace"]).default("trace"),
    responseLanguage: z
      .string()
      .trim()
      .max(50)
      .regex(/^[\p{L}\p{N}\s\-()]+$/u, "Invalid language name")
      .optional(),
    userSettings: z.boolean().default(false),
    applyHooks: z.boolean().default(false),
  })
  .strict();

export const ReplyBodySchema = z
  .object({
    questionId: z.string().min(1),
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
    message: z.string().min(1).max(10000).optional(),
  })
  .strict()
  .refine((data) => (data.answers != null) !== (data.message != null), {
    message: "Exactly one of 'answers' or 'message' must be provided",
  });

// --- Reason codes for 409 responses ---

/** Machine-readable reason codes returned in 409 responses. */
export type RefineTasksConflictReason =
  | "active_session"
  | "tasks_file_missing"
  | "tasks_file_invalid"
  | "no_active_session"
  | "no_pending_question";

// --- Refine-Tasks REST endpoints ---

export function refineTasksRoutes(
  refineTasksManager: RefineTasksManager,
  cwd: string,
  isAnySessionActive?: () => boolean,
  isBatchExpandActive?: () => boolean,
) {
  return async function (fastify: FastifyInstance): Promise<void> {
    // POST /api/refine-tasks — start a new refine-tasks pipeline
    fastify.post("/api/refine-tasks", async (request, reply) => {
      // Check ALL session types for conflicts
      if (isAnySessionActive?.()) {
        return reply.code(409).send({
          error: "Another session is active",
          reason: "active_session" satisfies RefineTasksConflictReason,
        });
      }
      if (isBatchExpandActive?.()) {
        return reply.code(409).send({
          error: "Batch expand is active",
          reason: "active_session" satisfies RefineTasksConflictReason,
        });
      }

      const parseResult = StartRefineTasksBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      // Precondition: tasks.json must exist and be valid
      const tasksState = checkTasksFile(cwd);
      if (!tasksState.hasTasksFile) {
        return reply.code(409).send({
          error: "Tasks file not found",
          reason: "tasks_file_missing" satisfies RefineTasksConflictReason,
        });
      }
      if (!tasksState.hasValidTasks) {
        return reply.code(409).send({
          error: "Tasks file is invalid",
          reason: "tasks_file_invalid" satisfies RefineTasksConflictReason,
        });
      }

      try {
        await refineTasksManager.start(parseResult.data);
      } catch (err) {
        if (err instanceof RefineTasksSessionActiveError) {
          return reply.code(409).send({
            error: err.message,
            reason: "active_session" satisfies RefineTasksConflictReason,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          error: "Failed to start refine-tasks",
          message,
        });
      }

      return { started: true, sessionId: refineTasksManager.getSession()!.id };
    });

    // DELETE /api/refine-tasks — stop the active refine-tasks pipeline
    fastify.delete("/api/refine-tasks", async (_request, reply) => {
      if (refineTasksManager.getState() === "idle") {
        return reply.code(409).send({
          error: "No active refine-tasks session",
          reason: "no_active_session" satisfies RefineTasksConflictReason,
        });
      }
      try {
        await refineTasksManager.stop();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          error: "Failed to stop refine-tasks",
          message,
        });
      }
      return { stopped: true };
    });

    // POST /api/refine-tasks/reply — reply to an agent question
    fastify.post("/api/refine-tasks/reply", async (request, reply) => {
      const parseResult = ReplyBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      const { questionId, answers, message } = parseResult.data;

      try {
        if (answers) {
          await refineTasksManager.replyQuestion(questionId, answers as QuestionAnswers);
        } else if (message) {
          // Plain-text reply — pack as answers with the question text as key
          // This follows the same convention as AskUserQuestion: { questionText: answer }
          await refineTasksManager.replyQuestion(questionId, { "0": message });
        }
      } catch (err) {
        if (err instanceof RefineTasksNotReadyError) {
          return reply.code(409).send({
            error: err.message,
            reason: "no_pending_question" satisfies RefineTasksConflictReason,
          });
        }
        if (err instanceof RefineTasksQuestionMismatchError) {
          return reply.code(400).send({
            error: err.message,
            reason: "question_mismatch",
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          error: "Failed to reply",
          message: msg,
        });
      }

      return { replied: true };
    });
  };
}
