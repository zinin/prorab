import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { executionRoutes } from "../server/routes/execution.js";
import type { ExecutionManager } from "../server/execution-manager.js";

function createMockManager(overrides: Partial<Record<string, any>> = {}): ExecutionManager {
  return {
    state: "idle",
    gracefulStop: false,
    currentUnit: null,
    iterationCurrent: 0,
    iterationTotal: null,
    start: vi.fn(),
    stop: vi.fn(),
    requestGracefulStop: vi.fn(),
    cancelGracefulStop: vi.fn(),
    ...overrides,
  } as unknown as ExecutionManager;
}

describe("POST /api/execute/graceful-stop", () => {
  it("returns 200 when running and gracefulStop is false", async () => {
    const manager = createMockManager({ state: "running", gracefulStop: false });
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, process.cwd()));

    const res = await fastify.inject({
      method: "POST",
      url: "/api/execute/graceful-stop",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gracefulStop: true });
    expect(manager.requestGracefulStop).toHaveBeenCalledOnce();
  });

  it("returns 409 when not running", async () => {
    const manager = createMockManager({ state: "idle" });
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, process.cwd()));

    const res = await fastify.inject({
      method: "POST",
      url: "/api/execute/graceful-stop",
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when gracefulStop already active", async () => {
    const manager = createMockManager({ state: "running", gracefulStop: true });
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, process.cwd()));

    const res = await fastify.inject({
      method: "POST",
      url: "/api/execute/graceful-stop",
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("DELETE /api/execute/graceful-stop", () => {
  it("returns 200 when running and gracefulStop is active", async () => {
    const manager = createMockManager({ state: "running", gracefulStop: true });
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, process.cwd()));

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/execute/graceful-stop",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ gracefulStop: false });
    expect(manager.cancelGracefulStop).toHaveBeenCalledOnce();
  });

  it("returns 409 when not running", async () => {
    const manager = createMockManager({ state: "idle" });
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, process.cwd()));

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/execute/graceful-stop",
    });
    expect(res.statusCode).toBe(409);
  });

  it("returns 409 when gracefulStop not active", async () => {
    const manager = createMockManager({ state: "running", gracefulStop: false });
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, process.cwd()));

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/execute/graceful-stop",
    });
    expect(res.statusCode).toBe(409);
  });
});
