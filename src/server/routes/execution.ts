import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExecutionManager } from "../execution-manager.js";
import { AgentTypeSchema } from "../../types.js";
import { ReviewersArraySchema } from "../../core/reviewer-utils.js";
import { acquireLock, releaseLock } from "../../core/lock.js";
import { hasUncommittedChangesExcluding } from "../../core/git.js";
import { findNextAction } from "../../core/tasks-json.js";

const ExecuteBodySchema = z
  .object({
    agent: AgentTypeSchema.default("claude"),
    model: z.string().optional(),
    maxRetries: z.number().int().positive().default(3),
    maxTurns: z.number().int().positive().default(200),
    reviewMaxTurns: z.number().int().positive().default(100),
    maxIterations: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.number().int().positive().optional(),
    ),
    review: z.boolean().default(true),
    debug: z.boolean().default(false),
    trace: z.boolean().default(false),
    quiet: z.boolean().default(false),
    allowDirty: z.boolean().default(false),
    userSettings: z.boolean().default(false),
    applyHooks: z.boolean().optional().default(false),
    variant: z.string().optional(),
    reviewers: ReviewersArraySchema,
    reviewRounds: z.number().int().min(1).max(10).default(1),
    reviewContext: z.boolean().default(false),
  })
  .strict();

export function executionRoutes(executionManager: ExecutionManager, cwd: string, isBatchExpandActive?: () => boolean) {
  return async function (fastify: FastifyInstance): Promise<void> {
    // POST /api/execute — start execution
    fastify.post("/api/execute", async (request, reply) => {
      if (executionManager.state !== "idle") {
        return reply.code(409).send({
          error: "Another session is active",
          reason: "active_session",
          message: `Execution session is currently ${executionManager.state}`,
          state: executionManager.state,
        });
      }

      if (isBatchExpandActive?.()) {
        return reply.code(409).send({ error: "Batch expand is active", reason: "active_session" });
      }

      const parseResult = ExecuteBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }
      const body = parseResult.data;

      // [N8] Acquire lock BEFORE sending HTTP response so client
      // immediately knows if lock acquisition failed
      try {
        acquireLock(cwd);
      } catch (err) {
        return reply.code(409).send({
          error: "Another session is active",
          reason: "active_session",
          message: err instanceof Error ? err.message : String(err),
        });
      }

      // Preflight: check dirty tree synchronously before fire-and-forget start()
      if (!body.allowDirty) {
        if (hasUncommittedChangesExcluding(cwd, ".taskmaster/")) {
          releaseLock(cwd);
          return reply.code(409).send({
            error: "Working directory has uncommitted changes. Commit or stash them, or enable 'Allow dirty'.",
          });
        }
      }

      // Preflight: check if there are any tasks to execute
      const nextAction = findNextAction(cwd, body.review);
      if (!nextAction) {
        releaseLock(cwd);
        return reply.code(409).send({
          error: "No tasks to execute. All tasks are either closed or there are no tasks.",
        });
      }

      // Start execution in background (don't await).
      // Lock already acquired — route owns lock lifecycle via .finally().
      executionManager
        .start({
          agent: body.agent,
          model: body.model,
          maxRetries: body.maxRetries,
          maxTurns: body.maxTurns,
          reviewMaxTurns: body.reviewMaxTurns,
          maxIterations: body.maxIterations,
          review: body.review,
          lockAlreadyAcquired: true,
          debug: body.debug,
          trace: body.trace,
          quiet: body.quiet,
          allowDirty: body.allowDirty,
          userSettings: body.userSettings,
          applyHooks: body.applyHooks,
          variant: body.variant,
          reviewers: body.reviewers,
          reviewRounds: body.reviewRounds,
          reviewContext: body.reviewContext,
        })
        .catch((err) => {
          console.error("Execution error:", err);
        })
        .finally(() => {
          releaseLock(cwd);
        });

      return { started: true, state: executionManager.state };
    });

    // DELETE /api/execute — stop execution
    fastify.delete("/api/execute", async (_request, reply) => {
      if (executionManager.state !== "running") {
        return reply.code(409).send({
          error: "No execution running",
          state: executionManager.state,
        });
      }
      executionManager.stop();
      return { stopping: true };
    });

    // POST /api/execute/graceful-stop — request graceful stop
    fastify.post("/api/execute/graceful-stop", async (_request, reply) => {
      if (executionManager.state !== "running") {
        return reply.code(409).send({
          error: "No execution running",
          state: executionManager.state,
        });
      }
      if (executionManager.gracefulStop) {
        return reply.code(409).send({
          error: "Graceful stop already active",
        });
      }
      executionManager.requestGracefulStop();
      return { gracefulStop: true };
    });

    // DELETE /api/execute/graceful-stop — cancel graceful stop
    fastify.delete("/api/execute/graceful-stop", async (_request, reply) => {
      if (executionManager.state !== "running") {
        return reply.code(409).send({
          error: "No execution running",
          state: executionManager.state,
        });
      }
      if (!executionManager.gracefulStop) {
        return reply.code(409).send({
          error: "Graceful stop not active",
        });
      }
      executionManager.cancelGracefulStop();
      return { gracefulStop: false };
    });

    // GET /api/execute — current execution state
    fastify.get("/api/execute", async () => {
      const unit = executionManager.currentUnit;
      return {
        state: executionManager.state,
        currentUnit: unit
          ? {
              type: unit.type,
              taskId: unit.taskId,
              subtaskId: unit.subtaskId,
              title: unit.title,
            }
          : null,
      };
    });
  };
}
