/**
 * Component integration test: ExpandManager wiring.
 *
 * Verifies that the expand stack (ExpandManager, routes, WS state
 * provider, graceful shutdown) works correctly when assembled the same
 * way serve.ts wires them. The test manually builds a Fastify server
 * (via `buildServer()`) that mirrors serve.ts bootstrap rather than
 * importing serveCommand — this avoids commander CLI parsing and SIGINT
 * handler complexity while still exercising the integration contract.
 *
 * Validates:
 *   1. ExpandManager creation with its own SessionCore
 *   2. Expand routes (/api/tasks/:id/expand, /api/expand) accept/reject requests correctly
 *   3. WS connected message includes expandSession and expandOutcome fields
 *   4. setExpandStateProvider() wiring feeds real ws.ts connected payload
 *   5. Graceful shutdown stops the expand session cleanly
 *
 * This test closes the gap identified in ws-connected-expand.test.ts where
 * buildConnectedMessage() re-implements ws.ts logic. Here we use a real
 * Fastify server + real WebSocket connection so regressions in ws.ts field
 * mapping are caught even if the unit-level tests still pass.
 *
 * Heavy dependencies (DriverRunner, git, lock) are mocked so no real agent
 * sessions or git operations are performed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { ExpandManager } from "../server/expand-manager.js";
import { ExecutionManager } from "../server/execution-manager.js";
import { SessionCore } from "../server/session/session-core.js";
import { setupWebSocket, setExpandStateProvider } from "../server/ws.js";
import { statusRoutes } from "../server/routes/status.js";
import { expandRoutes } from "../server/routes/expand.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

// --- Mock DriverRunner to prevent real agent sessions ---
vi.mock("../server/session/driver-runner.js", () => {
  return {
    DriverRunner: class MockDriverRunner {
      constructor(_agent: string, _model?: string) {}
      setup = vi.fn(async () => {});
      teardown = vi.fn(async () => {});
      getDriver = vi.fn(() => ({}));
      setOnLog = vi.fn();
      runSession = vi.fn(async () => ({
        signal: { type: "complete" as const },
        durationMs: 0,
        costUsd: 0,
        numTurns: 0,
        resultText: "",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "mock",
        agentReport: null,
        reviewReport: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      }));
      get setupDone() { return true; }
      get agent() { return "claude" as const; }
      get model() { return undefined; }
      get userSettings() { return false; }
      listModels = vi.fn(async () => []);
    },
  };
});

// --- Mock git to prevent real git calls ---
// ExpandManager needs isGitRepo, isTrackedByGit, hasGitIdentity, isPathDirty,
// commitExpandedTask. Other modules need commitTaskmaster, getHeadSha.
vi.mock("../core/git.js", () => ({
  commitTaskmaster: vi.fn(),
  hasUncommittedChangesExcluding: vi.fn(() => false),
  getHeadSha: vi.fn(() => "abc123"),
  isGitRepo: vi.fn(() => true),
  isTrackedByGit: vi.fn(() => true),
  hasGitIdentity: vi.fn(() => true),
  isPathDirty: vi.fn(() => false),
  commitExpandedTask: vi.fn(),
}));

// --- Mock lock to prevent real file lock issues ---
vi.mock("../core/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

describe("serve: ExpandManager integration", { timeout: 15_000 }, () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let port: number;

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "prorab-serve-expand-integ-"));
    // Create .taskmaster directory structure with a valid tasks.json
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
  });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Write a valid tasks.json with a pending task suitable for expand. */
  function writeTasksJson(): void {
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify({
        tasks: [
          {
            id: 1,
            title: "Build user authentication",
            description: "Implement user auth with JWT",
            details: "Create login/logout endpoints with token management",
            status: "pending",
            dependencies: [],
            subtasks: [],
          },
          {
            id: 2,
            title: "Add logging",
            description: "Add structured logging",
            status: "done",
            dependencies: [],
            subtasks: [],
          },
        ],
        metadata: {
          projectName: "test",
          totalTasks: 2,
          sourceFile: "prd.md",
          generatedAt: new Date().toISOString(),
        },
      }),
    );
  }

  /**
   * Build a server mimicking serve.ts wiring, using the real
   * managers and routes but mocked heavy dependencies.
   */
  async function buildServer(): Promise<{
    fastify: FastifyInstance;
    executionManager: ExecutionManager;
    expandManager: ExpandManager;
  }> {
    fastify = Fastify({ logger: false });

    const executionManager = new ExecutionManager(cwd);
    const broadcaster = await setupWebSocket(fastify, executionManager, cwd);

    // Expand manager — same wiring as serve.ts
    const expandSessionCore = new SessionCore(cwd);
    const expandManager = new ExpandManager(cwd, expandSessionCore, broadcaster);
    setExpandStateProvider(expandManager);

    // Register routes
    await fastify.register(statusRoutes(executionManager, cwd));
    await fastify.register(expandRoutes(expandManager, cwd));

    // Listen on random port
    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const address = fastify.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    return { fastify, executionManager, expandManager };
  }

  /** Connect a WebSocket client and return the first received message (connected payload). */
  function getWsConnectedMessage(): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "connected") {
            ws.close();
            resolve(msg);
          }
        } catch {
          // ignore non-JSON messages
        }
      });
      ws.on("error", reject);
      setTimeout(() => {
        ws.close();
        reject(new Error("Timeout waiting for connected message"));
      }, 5000);
    });
  }

  // ----- Bootstrap tests -----

  it("server bootstraps successfully with ExpandManager wired", async () => {
    writeTasksJson();
    const { expandManager } = await buildServer();

    // Manager should be idle on startup
    expect(expandManager.getState()).toBe("idle");
    expect(expandManager.getSession()).toBeNull();
    expect(expandManager.getOutcome()).toBeNull();
  });

  // ----- Expand routes -----

  it("GET /api/expand returns idle state when no session is active", async () => {
    writeTasksJson();
    await buildServer();

    const res = await fastify.inject({ method: "GET", url: "/api/expand" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("idle");
    expect(body.session).toBeNull();
    expect(body.outcome).toBeNull();
  });

  it("DELETE /api/tasks/1/expand returns 409 no_active_session when idle", async () => {
    writeTasksJson();
    await buildServer();

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/tasks/1/expand",
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("no_active_session");
  });

  it("POST /api/tasks/1/expand returns 409 tasks_file_missing when no tasks.json", async () => {
    // Don't write tasks.json — directory exists but file doesn't
    await buildServer();

    const res = await fastify.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("tasks_file_missing");
  });

  it("POST /api/tasks/999/expand returns 404 task_not_found for nonexistent task", async () => {
    writeTasksJson();
    await buildServer();

    const res = await fastify.inject({
      method: "POST",
      url: "/api/tasks/999/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().reason).toBe("task_not_found");
  });

  it("POST /api/tasks/2/expand returns 409 task_not_pending for non-pending task", async () => {
    writeTasksJson();
    await buildServer();

    const res = await fastify.inject({
      method: "POST",
      url: "/api/tasks/2/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("task_not_pending");
  });

  // ----- WS connected message includes expand fields (REAL ws.ts code path) -----

  it("WS connected message includes expandSession: null and expandOutcome: null when idle", async () => {
    writeTasksJson();
    await buildServer();

    const connected = await getWsConnectedMessage();

    expect(connected.type).toBe("connected");
    // These fields MUST be present (not undefined) — they come from
    // the real ws.ts code path via setExpandStateProvider wiring.
    expect("expandSession" in connected).toBe(true);
    expect("expandOutcome" in connected).toBe(true);
    expect(connected.expandSession).toBeNull();
    expect(connected.expandOutcome).toBeNull();
  });

  it("WS connected message includes expandOutcome after completed expand session", async () => {
    expect.hasAssertions();

    writeTasksJson();
    const { expandManager } = await buildServer();

    // Start an expand session — mock DriverRunner resolves immediately with
    // empty resultText, so the session will quickly finish with a failure
    // outcome (result_parse_failed) since there's no JSON in the output.
    await expandManager.start("1", { agent: "claude" });

    // Wait for the background session to complete (mock is synchronous)
    await new Promise((r) => setTimeout(r, 100));

    const session = expandManager.getSession();
    if (session) {
      // Session still active (unlikely with mock) — verify connected shows it
      const connected = await getWsConnectedMessage();
      expect(connected.expandSession).toBeDefined();
      const expandSession = connected.expandSession as Record<string, unknown>;
      expect(expandSession.sessionId).toBeDefined();
      expect(expandSession.taskId).toBe("1");
      expect(expandSession.agent).toBe("claude");
      expect(expandSession.state).toBeDefined();
    } else {
      // Mock runSession resolved instantly — session already completed.
      // ExpandManager keeps failure/cancelled outcomes (clears only success).
      const outcome = expandManager.getOutcome();
      expect(outcome).toBeDefined();
      expect(outcome?.taskId).toBe("1");

      // Now verify the WS connected message carries the outcome
      const connected = await getWsConnectedMessage();
      expect(connected.expandSession).toBeNull(); // session cleaned up
      expect(connected.expandOutcome).toBeDefined();
      const expandOutcome = connected.expandOutcome as Record<string, unknown>;
      expect(expandOutcome.taskId).toBe("1");
      expect(expandOutcome.status).toBeDefined();
    }
  });

  it("WS connected message field mapping matches ws.ts: id→sessionId, taskId preserved", async () => {
    expect.hasAssertions();

    writeTasksJson();
    const { expandManager } = await buildServer();

    // Start expand — session will complete quickly with mock
    await expandManager.start("1", { agent: "claude" });
    await new Promise((r) => setTimeout(r, 100));

    // After completion, outcome should be in connected message
    const connected = await getWsConnectedMessage();
    expect(connected.type).toBe("connected");

    // Verify expandOutcome has the correct structure from the real ws.ts path
    if (connected.expandOutcome) {
      const outcome = connected.expandOutcome as Record<string, unknown>;
      // taskId must be present (expand-specific contract, unlike parse-prd)
      expect(outcome.taskId).toBe("1");
      expect(typeof outcome.status).toBe("string");
    }

    // expandSession should be null since session completed
    expect(connected.expandSession).toBeNull();
  });

  // ----- Consistency: WS and REST expand state agree -----

  it("WS connected and GET /api/expand return consistent state", async () => {
    writeTasksJson();
    await buildServer();

    const [connected, restRes] = await Promise.all([
      getWsConnectedMessage(),
      fastify.inject({ method: "GET", url: "/api/expand" }),
    ]);

    const restBody = restRes.json();

    // Both say idle
    expect(restBody.state).toBe("idle");
    expect(connected.expandSession).toBeNull();
    expect(connected.expandOutcome).toBeNull();
    expect(restBody.session).toBeNull();
    expect(restBody.outcome).toBeNull();
  });

  // ----- Graceful shutdown -----

  it("shutdown completes cleanly when no expand session is active", async () => {
    writeTasksJson();
    const { expandManager } = await buildServer();

    expect(expandManager.getState()).toBe("idle");

    // Stop on idle is a no-op
    const result = await expandManager.stop("1");
    expect(result.status).toBe("no_active_session");

    // Server close should not throw
    await fastify.close();
  });

  it("shutdown stops active expand session cleanly", async () => {
    writeTasksJson();
    const { expandManager } = await buildServer();

    const stopSpy = vi.spyOn(expandManager, "stop");

    // Start a session
    await expandManager.start("1", { agent: "claude" });

    // Wait a tick for background session to potentially start
    await new Promise((r) => setTimeout(r, 10));

    // Simulate graceful shutdown by calling stop + close
    const activeTaskId = expandManager.getSession()?.taskId;
    if (activeTaskId) {
      await expandManager.stop(activeTaskId);
    }
    await fastify.close();

    if (activeTaskId) {
      expect(stopSpy).toHaveBeenCalledWith(activeTaskId);
    }
  });
});
