import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentTypeSchema, AgentStepSchema } from "../../types.js";
import { getProjectState } from "../../core/project-state.js";
import type { ParsePrdManager } from "../parse-prd-manager.js";
import { ParsePrdSessionActiveError } from "../parse-prd-manager.js";

// --- Zod schemas for Parse-PRD API endpoints ---

export const StartParsePrdBodySchema = z
  .object({
    agent: AgentTypeSchema,
    model: z.string().optional(),
    variant: z.string().optional(),
    responseLanguage: z.string().trim().max(50).regex(/^[\p{L}\p{N}\s\-()]+$/u, "Invalid language name").optional(),
    verbosity: z.enum(["quiet", "info", "debug", "trace"]).default("trace"),
    userSettings: z.boolean().default(false),
    applyHooks: z.boolean().optional().default(false),
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
  .strict();

// --- Reason codes for 409 responses ---

/** Machine-readable reason codes returned in 409 responses. */
export type ParsePrdConflictReason =
  | "active_session"
  | "prd_missing"
  | "tasks_file_exists"
  | "no_active_session";

// --- Parse-PRD REST endpoints ---

export function parsePrdRoutes(parsePrdManager: ParsePrdManager, cwd: string, isBatchExpandActive?: () => boolean) {
  return async function (fastify: FastifyInstance): Promise<void> {
    // POST /api/parse-prd — start a new parse-prd session
    fastify.post("/api/parse-prd", async (request, reply) => {
      if (isBatchExpandActive?.()) {
        return reply.code(409).send({ error: "Batch expand is active", reason: "active_session" });
      }

      const parseResult = StartParsePrdBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      const body = parseResult.data;

      // Precondition: PRD must exist
      const projectState = getProjectState(cwd);
      if (!projectState.hasPrd) {
        return reply.code(409).send({
          error: "PRD file is missing or empty",
          reason: "prd_missing" satisfies ParsePrdConflictReason,
        });
      }

      // Precondition: tasks.json must not already exist
      if (projectState.hasTasksFile) {
        return reply.code(409).send({
          error: "tasks.json already exists",
          reason: "tasks_file_exists" satisfies ParsePrdConflictReason,
        });
      }

      try {
        await parsePrdManager.start({
          agent: body.agent,
          model: body.model,
          variant: body.variant,
          responseLanguage: body.responseLanguage,
          verbosity: body.verbosity,
          userSettings: body.userSettings,
          applyHooks: body.applyHooks,
        });
      } catch (err) {
        if (err instanceof ParsePrdSessionActiveError) {
          const message = err.message;
          return reply.code(409).send({
            error: "Another session is active",
            reason: "active_session" satisfies ParsePrdConflictReason,
            message,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          error: "Failed to start parse-prd session",
          message,
        });
      }

      const session = parsePrdManager.getSession();
      return { started: true, sessionId: session!.id };
    });

    // DELETE /api/parse-prd — stop the active parse-prd session
    fastify.delete("/api/parse-prd", async (_request, reply) => {
      if (parsePrdManager.getState() === "idle") {
        return reply.code(409).send({
          error: "No active parse-prd session",
          reason: "no_active_session" satisfies ParsePrdConflictReason,
        });
      }
      try {
        await parsePrdManager.stop();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          error: "Failed to stop parse-prd session",
          message,
        });
      }
      return { stopped: true };
    });
  };
}
