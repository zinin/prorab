import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentTypeSchema } from "../../types.js";
import { checkTasksFile } from "../../core/project-state.js";
import { readTasksFile } from "../../core/tasks-json.js";
import type { ExpandStartReasonCode } from "../../prompts/expand.js";
import type { ExpandManager } from "../expand-manager.js";
import {
  ExpandSessionActiveError,
  ExpandPreflightError,
} from "../expand-manager.js";

// --- Zod schemas for Expand API endpoints ---

export const StartExpandBodySchema = z
  .object({
    agent: AgentTypeSchema,
    model: z.string().optional(),
    variant: z.string().optional(),
    verbosity: z.enum(["quiet", "info", "debug", "trace"]).default("trace"),
    userSettings: z.boolean().default(false),
    applyHooks: z.boolean().optional().default(false),
  })
  .strict();

const ExpandParamsSchema = z.object({
  id: z.string().min(1),
});

// --- Reason codes for 409 responses ---

/**
 * Machine-readable reason codes returned in 409 responses.
 * Includes all ExpandStartReasonCode values (git preflight failures, task
 * precondition failures) plus route-specific conflict reasons.
 */
export type ExpandConflictReason =
  | ExpandStartReasonCode
  | "no_active_session"
  | "task_mismatch";

// --- Expand REST endpoints ---

export function expandRoutes(expandManager: ExpandManager, cwd: string, isBatchExpandActive?: () => boolean) {
  return async function (fastify: FastifyInstance): Promise<void> {
    // POST /api/tasks/:id/expand — start a new expand session for the given task
    fastify.post("/api/tasks/:id/expand", async (request, reply) => {
      if (isBatchExpandActive?.()) {
        return reply.code(409).send({ error: "Batch expand is active", reason: "active_session" });
      }

      const paramsResult = ExpandParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "Invalid task id parameter",
          details: paramsResult.error.issues,
        });
      }
      const { id: taskId } = paramsResult.data;

      const parseResult = StartExpandBodySchema.safeParse(request.body ?? {});
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      const body = parseResult.data;

      // --- Route-level eligibility checks (before calling manager.start) ---

      // 1. tasks.json must exist and be valid
      const tasksFileCheck = checkTasksFile(cwd);
      if (!tasksFileCheck.hasTasksFile) {
        return reply.code(409).send({
          error: "tasks.json does not exist",
          reason: "tasks_file_missing" satisfies ExpandConflictReason,
        });
      }
      if (!tasksFileCheck.hasValidTasks) {
        return reply.code(409).send({
          error: "tasks.json is invalid or does not conform to the expected schema",
          reason: "tasks_file_invalid" satisfies ExpandConflictReason,
        });
      }

      // 2. Task must exist among top-level tasks
      let task;
      try {
        const data = readTasksFile(cwd);
        task = data.tasks.find((t) => String(t.id) === taskId);
      } catch {
        // readTasksFile can throw on corrupted/invalid file — treat as invalid
        return reply.code(409).send({
          error: "tasks.json could not be read",
          reason: "tasks_file_invalid" satisfies ExpandConflictReason,
        });
      }

      if (!task) {
        return reply.code(404).send({
          error: `Task ${taskId} not found`,
          reason: "task_not_found" satisfies ExpandConflictReason,
        });
      }

      // 3. Task must be in pending status
      if (task.status !== "pending") {
        return reply.code(409).send({
          error: `Task ${taskId} has status "${task.status}", expected "pending"`,
          reason: "task_not_pending" satisfies ExpandConflictReason,
        });
      }

      // 4. Task must not already have subtasks
      if (task.subtasks && task.subtasks.length > 0) {
        return reply.code(409).send({
          error: `Task ${taskId} already has ${task.subtasks.length} subtask(s)`,
          reason: "task_has_subtasks" satisfies ExpandConflictReason,
        });
      }

      // --- Delegate to manager (git preflight + session lifecycle) ---

      try {
        await expandManager.start(taskId, {
          agent: body.agent,
          model: body.model,
          variant: body.variant,
          verbosity: body.verbosity,
          userSettings: body.userSettings,
          applyHooks: body.applyHooks,
        });
      } catch (err) {
        if (err instanceof ExpandSessionActiveError) {
          const message = err.message;
          return reply.code(409).send({
            error: "Another session is active",
            reason: "active_session" satisfies ExpandConflictReason,
            message,
          });
        }
        if (err instanceof ExpandPreflightError) {
          const message = err.message;
          return reply.code(409).send({
            error: message,
            reason: err.reason satisfies ExpandConflictReason,
            message,
          });
        }
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(500).send({
          error: "Failed to start expand session",
          message,
        });
      }

      const session = expandManager.getSession();
      return { started: true, sessionId: session!.id, taskId };
    });

    // DELETE /api/tasks/:id/expand — stop the active expand session for the given task
    fastify.delete("/api/tasks/:id/expand", async (request, reply) => {
      const paramsResult = ExpandParamsSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "Invalid task id parameter",
          details: paramsResult.error.issues,
        });
      }
      const { id: taskId } = paramsResult.data;

      const result = await expandManager.stop(taskId);

      switch (result.status) {
        case "stopped":
          return { stopped: true };
        case "no_active_session":
          return reply.code(409).send({
            error: "No active expand session",
            reason: "no_active_session" satisfies ExpandConflictReason,
          });
        case "task_mismatch":
          return reply.code(409).send({
            error: `Active expand session is for task ${result.activeTaskId}, not ${taskId}`,
            reason: "task_mismatch" satisfies ExpandConflictReason,
            activeTaskId: result.activeTaskId,
          });
      }
    });

    // GET /api/expand — get current expand state, session info, and outcome
    fastify.get("/api/expand", async () => {
      return {
        state: expandManager.getState(),
        session: expandManager.getSession(),
        outcome: expandManager.getOutcome(),
      };
    });
  };
}
