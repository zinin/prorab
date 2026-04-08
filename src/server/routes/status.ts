import type { FastifyInstance } from "fastify";
import type { ExecutionManager } from "../execution-manager.js";
import { getProjectState } from "../../core/project-state.js";

export function statusRoutes(executionManager: ExecutionManager, cwd: string) {
  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get("/api/status", async () => {
      const state = getProjectState(cwd);

      return {
        cwd,
        // New granular fields from project-state helper
        hasPrd: state.hasPrd,
        hasTasksFile: state.hasTasksFile,
        hasValidTasks: state.hasValidTasks,
        // Backward-compatible alias — frontend reads hasTasksJson
        hasTasksJson: state.hasTasksFile,
        executionState: executionManager.state,
      };
    });
  };
}
