import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentTypeSchema, AgentStepSchema } from "../../types.js";
import type { QuestionAnswers } from "../../core/drivers/types.js";
import type { RefinePrdManager } from "../refine-prd-manager.js";
import {
  RefinePrdSessionActiveError,
  RefinePrdNotReadyError,
  RefinePrdQuestionMismatchError,
} from "../refine-prd-manager.js";
import { getProjectState } from "../../core/project-state.js";

// --- Zod schemas for Refine-PRD API endpoints ---

const StartRefinePrdBodySchema = z
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
    parsePrdOptions: z
      .object({
        agent: AgentTypeSchema,
        model: z.string().optional(),
        variant: z.string().optional(),
        responseLanguage: z
          .string()
          .trim()
          .max(50)
          .regex(/^[\p{L}\p{N}\s\-()]+$/u, "Invalid language name")
          .optional(),
        verbosity: z.enum(["quiet", "info", "debug", "trace"]).default("trace"),
        userSettings: z.boolean().default(false),
        applyHooks: z.boolean().default(false),
        refineTasksOptions: z
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
          .strict()
          .nullable()
          .default(null),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

const ReplyBodySchema = z
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
export type RefinePrdConflictReason =
  | "active_session"
  | "prd_missing"
  | "no_active_session"
  | "no_pending_question";

// --- Refine-PRD REST endpoints ---

export function refinePrdRoutes(
  refinePrdManager: RefinePrdManager,
  cwd: string,
  isAnySessionActive?: () => boolean,
  isBatchExpandActive?: () => boolean,
) {
  return async function (fastify: FastifyInstance): Promise<void> {
    // POST /api/refine-prd — start a new refine-prd pipeline
    fastify.post("/api/refine-prd", async (request, reply) => {
      // Check ALL session types for conflicts
      if (isAnySessionActive?.()) {
        return reply.code(409).send({
          error: "Another session is active",
          reason: "active_session" satisfies RefinePrdConflictReason,
        });
      }
      if (isBatchExpandActive?.()) {
        return reply.code(409).send({
          error: "Batch expand is active",
          reason: "active_session" satisfies RefinePrdConflictReason,
        });
      }

      const parseResult = StartRefinePrdBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      // Precondition: PRD must exist
      const projectState = getProjectState(cwd);
      if (!projectState.hasPrd) {
        return reply.code(409).send({
          error: "PRD file is missing or empty",
          reason: "prd_missing" satisfies RefinePrdConflictReason,
        });
      }

      try {
        await refinePrdManager.start(parseResult.data);
      } catch (err) {
        if (err instanceof RefinePrdSessionActiveError) {
          return reply.code(409).send({
            error: err.message,
            reason: "active_session" satisfies RefinePrdConflictReason,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          error: "Failed to start refine-prd",
          message,
        });
      }

      return { started: true, sessionId: refinePrdManager.getSession()!.id };
    });

    // DELETE /api/refine-prd — stop the active refine-prd pipeline
    fastify.delete("/api/refine-prd", async (_request, reply) => {
      if (refinePrdManager.getState() === "idle") {
        return reply.code(409).send({
          error: "No active refine-prd session",
          reason: "no_active_session" satisfies RefinePrdConflictReason,
        });
      }
      try {
        await refinePrdManager.stop();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          error: "Failed to stop refine-prd",
          message,
        });
      }
      return { stopped: true };
    });

    // POST /api/refine-prd/reply — reply to an agent question
    fastify.post("/api/refine-prd/reply", async (request, reply) => {
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
          await refinePrdManager.replyQuestion(questionId, answers as QuestionAnswers);
        } else if (message) {
          // Plain-text reply — pack as answers with the question text as key
          // This follows the same convention as AskUserQuestion: { questionText: answer }
          await refinePrdManager.replyQuestion(questionId, { "0": message });
        }
      } catch (err) {
        if (err instanceof RefinePrdNotReadyError) {
          return reply.code(409).send({
            error: err.message,
            reason: "no_pending_question" satisfies RefinePrdConflictReason,
          });
        }
        if (err instanceof RefinePrdQuestionMismatchError) {
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
