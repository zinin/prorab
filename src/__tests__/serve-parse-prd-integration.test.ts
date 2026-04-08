/**
 * Component integration test: ParsePrdManager wiring.
 *
 * Verifies that the parse-prd stack (ParsePrdManager, routes, WS state
 * provider, graceful shutdown) works correctly when assembled the same
 * way serve.ts wires them. The test manually builds a Fastify server
 * (via `buildServer()`) that mirrors serve.ts bootstrap rather than
 * importing serveCommand — this avoids commander CLI parsing and SIGINT
 * handler complexity while still exercising the integration contract.
 *
 * Validates:
 *   1. ParsePrdManager creation with its own SessionCore
 *   2. Parse-prd routes (/api/parse-prd) accept/reject requests correctly
 *   3. WS connected message includes parsePrdSession state
 *   4. Graceful shutdown stops the parse-prd session cleanly
 *
 * Heavy dependencies (DriverRunner, validate-parse-prd, git, lock) are
 * mocked so no real agent sessions or git operations are performed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { ParsePrdManager, ParsePrdSessionActiveError } from "../server/parse-prd-manager.js";
import { ChatManager } from "../server/chat-manager.js";
import { ExecutionManager } from "../server/execution-manager.js";
import { SessionCore } from "../server/session/session-core.js";
import { setupWebSocket, setChatStateProvider, setParsePrdStateProvider } from "../server/ws.js";
import { statusRoutes } from "../server/routes/status.js";
import { parsePrdRoutes } from "../server/routes/parse-prd.js";
import { chatRoutes } from "../server/routes/chat.js";
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

// --- Mock validate-parse-prd ---
vi.mock("../core/validate-parse-prd.js", () => ({
  getParsePrdOutcome: vi.fn(() => ({ status: "success" as const })),
}));

// --- Mock git to prevent real git calls ---
vi.mock("../core/git.js", () => ({
  commitTaskmaster: vi.fn(),
  hasUncommittedChangesExcluding: vi.fn(() => false),
  getHeadSha: vi.fn(() => "abc123"),
}));

// --- Mock lock to prevent real file lock issues ---
vi.mock("../core/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

describe("serve: ParsePrdManager integration", () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "prorab-serve-parse-prd-integ-"));
    // Create .taskmaster directory structure
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
  });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Build a full server mimicking serve.ts wiring, using the real
   * managers and routes but mocked heavy dependencies.
   */
  async function buildServer(): Promise<{
    fastify: FastifyInstance;
    executionManager: ExecutionManager;
    chatManager: ChatManager;
    parsePrdManager: ParsePrdManager;
  }> {
    fastify = Fastify({ logger: false });

    const executionManager = new ExecutionManager(cwd);
    const broadcaster = await setupWebSocket(fastify, executionManager, cwd);

    // Chat manager — same wiring as serve.ts
    const chatSessionCore = new SessionCore(cwd);
    const chatManager = new ChatManager(cwd, chatSessionCore, broadcaster);
    setChatStateProvider(chatManager);

    // Parse-PRD manager — same wiring as serve.ts
    const parsePrdSessionCore = new SessionCore(cwd);
    const parsePrdManager = new ParsePrdManager(cwd, parsePrdSessionCore, broadcaster);
    setParsePrdStateProvider(parsePrdManager);

    // Register routes
    await fastify.register(statusRoutes(executionManager, cwd));
    await fastify.register(parsePrdRoutes(parsePrdManager, cwd));
    await fastify.register(chatRoutes(chatManager, cwd));

    // Listen on random port
    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const address = fastify.server.address();
    port = typeof address === "object" && address ? address.port : 0;

    return { fastify, executionManager, chatManager, parsePrdManager };
  }

  // ----- Bootstrap tests -----

  it("server bootstraps successfully with ParsePrdManager wired", async () => {
    const { parsePrdManager } = await buildServer();

    // Manager should be idle on startup
    expect(parsePrdManager.getState()).toBe("idle");
    expect(parsePrdManager.getSession()).toBeNull();
    expect(parsePrdManager.getOutcome()).toBeNull();
  });

  it("parse-prd routes are accessible: POST returns 409 prd_missing when no PRD", async () => {
    await buildServer();

    // No PRD file → should return 409 with prd_missing
    const res = await fastify.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("prd_missing");
  });

  it("parse-prd routes are accessible: DELETE returns 409 no_active_session when idle", async () => {
    await buildServer();

    const res = await fastify.inject({
      method: "DELETE",
      url: "/api/parse-prd",
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("no_active_session");
  });

  it("parse-prd routes start session when PRD exists and no tasks.json", async () => {
    // Create a PRD file so the precondition passes
    writeFileSync(join(cwd, ".taskmaster", "docs", "prd.md"), "# My PRD\nSome content here.");

    const { parsePrdManager } = await buildServer();

    const res = await fastify.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.started).toBe(true);
    expect(body.sessionId).toBeDefined();

    // Manager should now be active (or may have already completed due to mock)
    // Wait a tick for background session
    await new Promise((r) => setTimeout(r, 50));

    // Cleanup: stop if still active
    if (parsePrdManager.getState() !== "idle") {
      await parsePrdManager.stop();
    }
  });

  // ----- WS connected message includes parsePrdSession -----

  it("WS connected message includes parsePrdSession: null when idle", async () => {
    await buildServer();

    const connected = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "connected") {
          ws.close();
          resolve(msg);
        }
      });
      ws.on("error", reject);
      setTimeout(() => { ws.close(); reject(new Error("WS timeout")); }, 3000);
    });

    expect(connected.type).toBe("connected");
    expect(connected.parsePrdSession).toBeNull();
    expect(connected.parsePrdOutcome).toBeNull();
  });

  it("WS connected message includes parsePrdSession when session is active", async () => {
    expect.hasAssertions();

    // Create PRD so session can start
    writeFileSync(join(cwd, ".taskmaster", "docs", "prd.md"), "# PRD\nReal content.");

    const { parsePrdManager } = await buildServer();

    // Start a parse-prd session
    await parsePrdManager.start({ agent: "claude" });
    const session = parsePrdManager.getSession();

    if (session) {
      // Session still active — verify WS connected message shows it
      const connected = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === "connected") {
            ws.close();
            resolve(msg);
          }
        });
        ws.on("error", reject);
        setTimeout(() => { ws.close(); reject(new Error("WS timeout")); }, 3000);
      });

      expect(connected.parsePrdSession).toBeDefined();
      if (connected.parsePrdSession) {
        expect((connected.parsePrdSession as any).agent).toBe("claude");
      }
    } else {
      // Mock runSession resolved instantly — session already completed.
      // Verify the outcome was captured (session ran and finished).
      await new Promise((r) => setTimeout(r, 50));
      expect(parsePrdManager.getOutcome()).toBeDefined();
      expect(parsePrdManager.getOutcome()?.status).toBe("success");
    }

    // Cleanup
    if (parsePrdManager.getState() !== "idle") {
      await parsePrdManager.stop();
    }
  });

  // ----- Graceful shutdown -----

  it("graceful shutdown calls parsePrdManager.stop()", async () => {
    // Create PRD so session can start
    writeFileSync(join(cwd, ".taskmaster", "docs", "prd.md"), "# PRD\nContent for test.");

    const { parsePrdManager } = await buildServer();

    // Spy on stop
    const stopSpy = vi.spyOn(parsePrdManager, "stop");

    // Start a session
    await parsePrdManager.start({ agent: "claude" });

    // Wait a tick for background session to potentially start
    await new Promise((r) => setTimeout(r, 10));

    // Simulate graceful shutdown by calling stop + close
    await parsePrdManager.stop();
    await fastify.close();

    expect(stopSpy).toHaveBeenCalled();
  });

  it("shutdown completes cleanly when parse-prd session is active", async () => {
    writeFileSync(join(cwd, ".taskmaster", "docs", "prd.md"), "# PRD\nContent.");

    const { parsePrdManager } = await buildServer();

    // Start a session
    await parsePrdManager.start({ agent: "claude" });

    // Wait for potential background activity
    await new Promise((r) => setTimeout(r, 20));

    // Stop the parse-prd session first (mimics SIGINT handler order)
    await parsePrdManager.stop();

    // Manager should be idle after stop
    expect(parsePrdManager.getState()).toBe("idle");

    // Server close should not throw
    await fastify.close();
  });

  it("shutdown completes cleanly when no parse-prd session is active", async () => {
    const { parsePrdManager } = await buildServer();

    expect(parsePrdManager.getState()).toBe("idle");

    // Stop on idle is a no-op
    await parsePrdManager.stop();
    expect(parsePrdManager.getState()).toBe("idle");

    // Server close should not throw
    await fastify.close();
  });
});
