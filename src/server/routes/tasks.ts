import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TaskPrioritySchema } from "../../core/tasks-json-types.js";
import {
  readTasksFile,
  updateTask,
  createTask,
  deleteTask,
  updateSubtask,
  deleteSubtask,
  TaskNotFoundError,
  withTasksMutex,
} from "../../core/tasks-json.js";
import { broadcastTasksUpdated } from "../ws.js";
import { commitTasksJson } from "../../core/git.js";

// [C4] Review: Zod schemas for all mutating endpoints
const TaskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "done",
  "blocked",
  "review",
  "rework",
  "closed",
]);

const SubtaskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "done",
  "blocked",
]);

const TaskUpdateSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    status: TaskStatusSchema.optional(),
    details: z.string().optional(),
    testStrategy: z.string().optional(),
    priority: TaskPrioritySchema.nullable().optional(),
    dependencies: z.array(z.union([z.string(), z.number()])).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const TaskCreateSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    details: z.string().optional(),
    testStrategy: z.string().optional(),
    priority: TaskPrioritySchema.optional(),
    dependencies: z.array(z.union([z.string(), z.number()])).optional(),
  })
  .strict();

const SubtaskUpdateSchema = z
  .object({
    title: z.string().optional(),
    description: z.string().optional(),
    status: SubtaskStatusSchema.optional(),
    details: z.string().optional(),
    testStrategy: z.string().optional(),
    priority: TaskPrioritySchema.nullable().optional(),
    dependencies: z.array(z.union([z.string(), z.number()])).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

function errorResponse(err: unknown): { code: number; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const code = err instanceof TaskNotFoundError ? 404 : 500;
  return { code, message: msg };
}

export function tasksRoutes(cwd: string) {
  return async function (fastify: FastifyInstance): Promise<void> {

  // GET /api/tasks — all tasks
  fastify.get("/api/tasks", async (_request, reply) => {
    try {
      const data = readTasksFile(cwd);
      return { tasks: data.tasks, metadata: data.metadata };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return { tasks: [], metadata: {} };
      }
      return reply.code(500).send({
        error: "Failed to read tasks",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // GET /api/tasks/:id — single task
  fastify.get<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      try {
        const data = readTasksFile(cwd);
        const task = data.tasks.find(
          (t) => String(t.id) === request.params.id,
        );
        if (!task) {
          return reply
            .code(404)
            .send({ error: `Task ${request.params.id} not found` });
        }
        return { task };
      } catch (err) {
        return reply.code(500).send({
          error: "Failed to read task",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // PUT /api/tasks/:id — update task fields
  fastify.put<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      const parsed = TaskUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Validation failed", details: parsed.error.format() });
      }
      try {
        const { priority: rawPriority, ...rest } = parsed.data;
        const updates = { ...rest, ...(rawPriority !== undefined ? { priority: rawPriority ?? undefined } : {}) };
        const data = await withTasksMutex(() => updateTask(cwd, request.params.id, updates));
        const task = data.tasks.find(
          (t) => String(t.id) === request.params.id,
        );
        broadcastTasksUpdated();
        const fields = Object.keys(parsed.data).join(", ");
        commitTasksJson(cwd, `task(${request.params.id}): update ${fields}`);
        return { task };
      } catch (err) {
        const { code, message } = errorResponse(err);
        return reply.code(code).send({ error: message });
      }
    },
  );

  // POST /api/tasks — create new task
  fastify.post("/api/tasks", async (request, reply) => {
    const parsed = TaskCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Validation failed", details: parsed.error.format() });
    }
    try {
      const task = await withTasksMutex(() => createTask(cwd, parsed.data));
      broadcastTasksUpdated();
      return reply.code(201).send({ task });
    } catch (err) {
      return reply
        .code(500)
        .send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/tasks/:id
  fastify.delete<{ Params: { id: string } }>(
    "/api/tasks/:id",
    async (request, reply) => {
      try {
        await withTasksMutex(() => deleteTask(cwd, request.params.id));
        broadcastTasksUpdated();
        return { deleted: true };
      } catch (err) {
        const { code, message } = errorResponse(err);
        return reply.code(code).send({ error: message });
      }
    },
  );

  // PUT /api/tasks/:taskId/subtasks/:subId — update subtask fields
  fastify.put<{ Params: { taskId: string; subId: string } }>(
    "/api/tasks/:taskId/subtasks/:subId",
    async (request, reply) => {
      const parsed = SubtaskUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "Validation failed", details: parsed.error.format() });
      }
      try {
        const { priority: rawSubPriority, ...subRest } = parsed.data;
        const subUpdates = { ...subRest, ...(rawSubPriority !== undefined ? { priority: rawSubPriority ?? undefined } : {}) };
        const data = await withTasksMutex(() => updateSubtask(
          cwd,
          request.params.taskId,
          request.params.subId,
          subUpdates,
        ));
        broadcastTasksUpdated();
        const fields = Object.keys(parsed.data).join(", ");
        commitTasksJson(cwd, `subtask(${request.params.taskId}.${request.params.subId}): update ${fields}`);
        return {
          task: data.tasks.find(
            (t) => String(t.id) === request.params.taskId,
          ),
        };
      } catch (err) {
        const { code, message } = errorResponse(err);
        return reply.code(code).send({ error: message });
      }
    },
  );

  // DELETE /api/tasks/:taskId/subtasks/:subId
  fastify.delete<{ Params: { taskId: string; subId: string } }>(
    "/api/tasks/:taskId/subtasks/:subId",
    async (request, reply) => {
      try {
        await withTasksMutex(() => deleteSubtask(cwd, request.params.taskId, request.params.subId));
        broadcastTasksUpdated();
        return { deleted: true };
      } catch (err) {
        const { code, message } = errorResponse(err);
        return reply.code(code).send({ error: message });
      }
    },
  );

  };
}
