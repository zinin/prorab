/**
 * Route-level test: POST /api/execute defaults and validates `reviewMaxTurns`.
 *
 * Confirms ExecuteBodySchema:
 *  - defaults reviewMaxTurns to 100 when omitted
 *  - forwards an explicit positive value to ExecutionManager.start
 *  - rejects non-positive values with HTTP 400
 *
 * Mocks lock/git/tasks-json modules so the route doesn't touch the real
 * filesystem and can reach the executionManager.start() call cleanly.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { executionRoutes } from "../server/routes/execution.js";
import type { ExecutionManager } from "../server/execution-manager.js";

vi.mock("../core/lock.js", () => ({
  acquireLock: vi.fn(() => {}),
  releaseLock: vi.fn(() => {}),
}));

vi.mock("../core/git.js", () => ({
  hasUncommittedChangesExcluding: vi.fn(() => false),
}));

vi.mock("../core/tasks-json.js", () => ({
  findNextAction: vi.fn(() => ({
    type: "execute",
    task: { id: "1", title: "stub", status: "pending", subtasks: [] },
  })),
}));

function createMockManager(): ExecutionManager {
  return {
    state: "idle",
    gracefulStop: false,
    currentUnit: null,
    iterationCurrent: 0,
    iterationTotal: null,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    requestGracefulStop: vi.fn(),
    cancelGracefulStop: vi.fn(),
  } as unknown as ExecutionManager;
}

describe("POST /api/execute — reviewMaxTurns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defaults reviewMaxTurns to 100 when omitted", async () => {
    const manager = createMockManager();
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, "/tmp"));

    const res = await fastify.inject({
      method: "POST",
      url: "/api/execute",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const passedOpts = (manager.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passedOpts.reviewMaxTurns).toBe(100);
    await fastify.close();
  });

  it("accepts explicit reviewMaxTurns", async () => {
    const manager = createMockManager();
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, "/tmp"));

    const res = await fastify.inject({
      method: "POST",
      url: "/api/execute",
      payload: { reviewMaxTurns: 42 },
    });

    expect(res.statusCode).toBe(200);
    const passedOpts = (manager.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passedOpts.reviewMaxTurns).toBe(42);
    await fastify.close();
  });

  it("rejects non-positive reviewMaxTurns with 400", async () => {
    const manager = createMockManager();
    const fastify = Fastify();
    await fastify.register(executionRoutes(manager, "/tmp"));

    const res = await fastify.inject({
      method: "POST",
      url: "/api/execute",
      payload: { reviewMaxTurns: 0 },
    });

    expect(res.statusCode).toBe(400);
    expect(manager.start).not.toHaveBeenCalled();
    await fastify.close();
  });
});
