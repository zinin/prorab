import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AgentTypeSchema } from "../../types.js";
import type { ModelEntry } from "../../types.js";
import { createDriver } from "../../core/drivers/factory.js";

const ModelsQuerySchema = z.object({
  agent: AgentTypeSchema,
});

// Lifetime cache: key = agent type, value = models array or in-flight promise
// Using Promise dedup prevents concurrent driver.setup() on simultaneous cache misses
const cache = new Map<string, ModelEntry[] | Promise<ModelEntry[]>>();

export function modelsRoutes() {
  return async function (fastify: FastifyInstance): Promise<void> {
    fastify.get("/api/models", async (request, reply) => {
      const parseResult = ModelsQuerySchema.safeParse(request.query);
      if (!parseResult.success) {
        return reply.code(400).send({
          error: "Invalid query params",
          details: parseResult.error.issues,
        });
      }
      const { agent } = parseResult.data;

      // Check lifetime cache (resolved array or in-flight promise)
      // CCS listModels() is a pure file scan — skip cache so it always re-scans
      // Codex: cache in-flight promise but do not cache empty results (CLI may not be running yet)
      if (agent !== "ccs") {
        const cached = cache.get(agent);
        if (cached) {
          const models = await cached;
          return { models };
        }
      }

      // CCS listModels() is a pure file scan — no setup/teardown needed
      // Codex listModels() reads ~/.codex/models_cache.json — no setup/teardown needed
      const needsSetup = agent !== "ccs" && agent !== "codex";

      const promise = (async () => {
        const driver = createDriver(agent);
        if (!driver.listModels) {
          throw Object.assign(new Error(`Driver for ${agent} does not support model listing`), { statusCode: 501 });
        }

        // OpenCode needs a running server — setup() then listModels() then teardown()
        if (needsSetup && driver.setup) {
          await driver.setup({ verbosity: "quiet" });
        }
        try {
          return await driver.listModels();
        } finally {
          if (needsSetup && driver.teardown) {
            await driver.teardown();
          }
        }
      })();

      if (agent !== "ccs") {
        cache.set(agent, promise);
      }
      try {
        const models = await promise;
        if (agent !== "ccs") {
          // Codex: do not cache empty results — CLI may not be running yet (no ~/.codex/models_cache.json)
          if (agent === "codex" && models.length === 0) {
            cache.delete(agent);
          } else {
            cache.set(agent, models); // Replace promise with resolved array
          }
        }
        return { models };
      } catch (err) {
        cache.delete(agent); // Allow retry on failure
        const statusCode = (err as { statusCode?: number }).statusCode;
        return reply.code(statusCode ?? 500).send({
          error: `Failed to list models for ${agent}`,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };
}
