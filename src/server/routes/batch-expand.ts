import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { AgentTypeSchema } from "../../types.js";
import {
  BatchExpandManager,
  BatchExpandSessionActiveError,
  BatchExpandPreflightError,
} from "../batch-expand-manager.js";
import { checkTasksFile } from "../../core/project-state.js";

const StartBatchExpandBodySchema = z
  .object({
    agent: AgentTypeSchema,
    model: z.string().optional(),
    variant: z.string().optional(),
    verbosity: z.enum(["quiet", "info", "debug", "trace"]).optional(),
    userSettings: z.boolean().default(false),
    applyHooks: z.boolean().optional().default(false),
  })
  .strict();

export function batchExpandRoutes(
  manager: BatchExpandManager,
  cwd: string,
  isAnySessionActive: () => boolean,
) {
  return async function (fastify: FastifyInstance) {
    // POST /api/batch-expand — start batch expand
    fastify.post("/api/batch-expand", async (request, reply) => {
      const bodyResult = StartBatchExpandBodySchema.safeParse(request.body);
      if (!bodyResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: bodyResult.error.issues,
        });
      }

      const tasksState = checkTasksFile(cwd);
      if (!tasksState.hasTasksFile) {
        return reply.code(409).send({ error: "No tasks file", reason: "tasks_file_missing" });
      }
      if (!tasksState.hasValidTasks) {
        return reply.code(409).send({ error: "Invalid tasks file", reason: "tasks_file_invalid" });
      }

      if (isAnySessionActive()) {
        return reply.code(409).send({ error: "Another session is active", reason: "active_session" });
      }

      try {
        const result = manager.start(bodyResult.data);
        if (result === null) {
          return reply.code(200).send({ started: false, reason: "no_eligible_tasks" });
        }
        return reply.code(201).send({ started: true, taskIds: result.taskIds, slotCount: result.slotCount });
      } catch (err) {
        if (err instanceof BatchExpandSessionActiveError) {
          return reply.code(409).send({ error: err.message, reason: "batch_active" });
        }
        if (err instanceof BatchExpandPreflightError) {
          return reply.code(409).send({ error: err.message, reason: err.reason });
        }
        throw err;
      }
    });

    // DELETE /api/batch-expand — stop batch expand
    fastify.delete("/api/batch-expand", async (_request, reply) => {
      const stopped = manager.stop();
      if (!stopped) {
        return reply.code(409).send({ error: "No active batch", reason: "no_active_batch" });
      }
      return reply.send({ stopped: true });
    });

    // POST /api/batch-expand/dismiss — clear finished state so reconnect doesn't restore it
    fastify.post("/api/batch-expand/dismiss", async (_request, reply) => {
      const dismissed = manager.dismiss();
      if (!dismissed) {
        return reply.code(409).send({ error: "Not in finished state", reason: "not_finished" });
      }
      return reply.send({ dismissed: true });
    });

    // GET /api/batch-expand — get state
    fastify.get("/api/batch-expand", async (_request, reply) => {
      return reply.send(manager.getState());
    });
  };
}
