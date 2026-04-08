import type { FastifyInstance } from "fastify";
import { readReport, readReviewReport, readReworkReport } from "../../core/reporter.js";
import { getReviewRoundInfo } from "../../core/tasks-json.js";

/** Validate unitId format: digits with optional dot-separated sub-id (e.g. "3", "3.1") */
function isValidUnitId(id: string): boolean {
  return /^\d+(\.\d+)?$/.test(id);
}

export function reportsRoutes(cwd: string) {
  return async function (fastify: FastifyInstance): Promise<void> {

  // GET /api/reports/:unitId — single report (markdown)
  fastify.get<{ Params: { unitId: string } }>(
    "/api/reports/:unitId",
    async (request, reply) => {
      if (!isValidUnitId(request.params.unitId)) {
        return reply.code(400).send({ error: "Invalid unitId format" });
      }
      const content = readReport(cwd, request.params.unitId);
      if (content === null) {
        return reply.code(404).send({ error: `Report for ${request.params.unitId} not found` });
      }
      return { unitId: request.params.unitId, content };
    },
  );

  // GET /api/reports/:taskId/review?round=N
  fastify.get<{ Params: { taskId: string }; Querystring: { round?: string } }>(
    "/api/reports/:taskId/review",
    async (request, reply) => {
      const { taskId } = request.params;
      if (!isValidUnitId(taskId)) {
        return reply.code(400).send({ error: "Invalid task ID" });
      }
      const roundParam = request.query.round;
      if (roundParam !== undefined) {
        const round = Number(roundParam);
        if (!Number.isInteger(round) || round < 1) {
          return reply.code(400).send({ error: "Invalid round parameter" });
        }
        const content = readReviewReport(cwd, taskId, round);
        if (!content) {
          return reply.code(404).send({ error: "Review report not found" });
        }
        return { taskId, round, content };
      }
      // No round specified: try default (no-round) report first
      const content = readReviewReport(cwd, taskId);
      if (content) {
        return { taskId, content };
      }
      // Fallback: find latest existing round
      let reviewRound: number | undefined;
      try {
        ({ reviewRound } = getReviewRoundInfo(taskId, cwd));
      } catch {
        return reply.code(404).send({ error: "Review report not found" });
      }
      for (let r = reviewRound ?? 1; r >= 1; r--) {
        const roundContent = readReviewReport(cwd, taskId, r);
        if (roundContent) {
          return { taskId, round: r, content: roundContent };
        }
      }
      return reply.code(404).send({ error: "Review report not found" });
    },
  );

  // GET /api/reports/:taskId/rework?round=N
  fastify.get<{ Params: { taskId: string }; Querystring: { round?: string } }>(
    "/api/reports/:taskId/rework",
    async (request, reply) => {
      const { taskId } = request.params;
      if (!isValidUnitId(taskId)) {
        return reply.code(400).send({ error: "Invalid task ID" });
      }
      const roundParam = request.query.round;
      if (roundParam !== undefined) {
        const round = Number(roundParam);
        if (!Number.isInteger(round) || round < 1) {
          return reply.code(400).send({ error: "Invalid round parameter" });
        }
        const content = readReworkReport(cwd, taskId, round);
        if (!content) {
          return reply.code(404).send({ error: "Rework report not found" });
        }
        return { taskId, round, content };
      }
      // No round specified: try default (no-round) report first
      const content = readReworkReport(cwd, taskId);
      if (content) {
        return { taskId, content };
      }
      // Fallback: find latest existing round
      let reviewRound: number | undefined;
      try {
        ({ reviewRound } = getReviewRoundInfo(taskId, cwd));
      } catch {
        return reply.code(404).send({ error: "Rework report not found" });
      }
      for (let r = reviewRound ?? 1; r >= 1; r--) {
        const roundContent = readReworkReport(cwd, taskId, r);
        if (roundContent) {
          return { taskId, round: r, content: roundContent };
        }
      }
      return reply.code(404).send({ error: "Rework report not found" });
    },
  );
  };
}
