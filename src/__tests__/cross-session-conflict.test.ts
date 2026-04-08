/**
 * Integration tests: cross-session conflict normalization.
 *
 * Verifies that competing session types (chat, parse-prd, execute)
 * all return a consistent `409 { reason: "active_session" }` response
 * when another session is already holding the file lock.
 *
 * Uses real SessionCore instances with real file locks (no lock mocks)
 * but mocks DriverRunner / git / validate-parse-prd to prevent real
 * agent sessions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { ParsePrdManager } from "../server/parse-prd-manager.js";
import { ChatManager } from "../server/chat-manager.js";
import { ExecutionManager } from "../server/execution-manager.js";
import { SessionCore } from "../server/session/session-core.js";
import { WsBroadcaster } from "../server/session/ws-broadcaster.js";
import { executionRoutes } from "../server/routes/execution.js";
import { parsePrdRoutes } from "../server/routes/parse-prd.js";
import { chatRoutes } from "../server/routes/chat.js";
import { acquireLock, releaseLock } from "../core/lock.js";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

// --- Mock git ---
vi.mock("../core/git.js", () => ({
  commitTaskmaster: vi.fn(),
  hasUncommittedChangesExcluding: vi.fn(() => false),
  getHeadSha: vi.fn(() => "abc123"),
}));

// --- Mock project-state for parse-prd preconditions ---
vi.mock("../core/project-state.js", () => ({
  getProjectState: vi.fn(() => ({
    hasPrd: true,
    hasTasksFile: false,
    hasValidTasks: false,
  })),
}));

describe("cross-session conflict: normalized active_session responses", () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let chatSessionCore: SessionCore;
  let parsePrdSessionCore: SessionCore;
  let executionManager: ExecutionManager;
  let chatManager: ChatManager;
  let parsePrdManager: ParsePrdManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "prorab-cross-session-conflict-"));
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });

    fastify = Fastify({ logger: false });

    // Create managers with shared cwd (same lock file)
    executionManager = new ExecutionManager(cwd);
    const broadcaster = new WsBroadcaster();
    executionManager.setBroadcaster(broadcaster);

    chatSessionCore = new SessionCore(cwd);
    chatManager = new ChatManager(cwd, chatSessionCore, broadcaster);

    parsePrdSessionCore = new SessionCore(cwd);
    parsePrdManager = new ParsePrdManager(cwd, parsePrdSessionCore, broadcaster);

    // Register routes
    await fastify.register(executionRoutes(executionManager, cwd));
    await fastify.register(chatRoutes(chatManager, cwd));
    await fastify.register(parsePrdRoutes(parsePrdManager, cwd));
  });

  afterEach(async () => {
    // Release any held locks
    try { chatSessionCore.release(); } catch { /* may not be held */ }
    try { parsePrdSessionCore.release(); } catch { /* may not be held */ }
    try { releaseLock(cwd); } catch { /* may not be held */ }
    await fastify.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  // ---- Chat blocks other sessions ----

  it("chat active → execute returns 409 active_session", async () => {
    chatSessionCore.acquire();

    const res = await fastify.inject({
      method: "POST",
      url: "/api/execute",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(typeof body.message).toBe("string");
  });

  it("chat active → parse-prd returns 409 active_session", async () => {
    chatSessionCore.acquire();

    const res = await fastify.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(typeof body.message).toBe("string");
  });

  // ---- Parse-PRD blocks other sessions ----

  it("parse-prd active → execute returns 409 active_session", async () => {
    parsePrdSessionCore.acquire();

    const res = await fastify.inject({
      method: "POST",
      url: "/api/execute",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(typeof body.message).toBe("string");
  });

  it("parse-prd active → chat returns 409 active_session", async () => {
    parsePrdSessionCore.acquire();

    const res = await fastify.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(typeof body.message).toBe("string");
  });

  // ---- Execute blocks other sessions (simulated via direct lock) ----

  it("execute active → chat returns 409 active_session", async () => {
    acquireLock(cwd);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(typeof body.message).toBe("string");
  });

  it("execute active → parse-prd returns 409 active_session", async () => {
    acquireLock(cwd);

    const res = await fastify.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(typeof body.message).toBe("string");
  });

  // ---- Cleanup and re-acquire ----

  it("lock released after chat cleanup → parse-prd can acquire", async () => {
    // 1. Chat acquires lock
    chatSessionCore.acquire();

    // 2. Parse-prd should fail via route
    const res1 = await fastify.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });
    expect(res1.statusCode).toBe(409);
    expect(res1.json().reason).toBe("active_session");

    // 3. Chat releases lock
    chatSessionCore.release();

    // 4. After cleanup, parse-prd's SessionCore can acquire the lock
    //    (verifies no manual lock cleanup is needed)
    expect(() => parsePrdSessionCore.acquire()).not.toThrow();
    expect(parsePrdSessionCore.state).toBe("active");
  });

  it("lock released after execute cleanup → chat can acquire", async () => {
    // 1. Execute acquires lock
    acquireLock(cwd);

    // 2. Chat should fail via route
    const res1 = await fastify.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude" },
    });
    expect(res1.statusCode).toBe(409);
    expect(res1.json().reason).toBe("active_session");

    // 3. Execute releases lock
    releaseLock(cwd);

    // 4. After cleanup, chat's SessionCore can acquire the lock
    expect(() => chatSessionCore.acquire()).not.toThrow();
    expect(chatSessionCore.state).toBe("active");
  });

  // ---- Uniform shape ----

  it("all active_session 409 responses share { error, reason, message } shape", async () => {
    // Use chat lock to block execute and parse-prd
    chatSessionCore.acquire();

    const execRes = await fastify.inject({
      method: "POST",
      url: "/api/execute",
      payload: { agent: "claude" },
    });

    const parsePrdRes = await fastify.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    // Release chat, use parsePrd to block chat
    chatSessionCore.release();
    parsePrdSessionCore.acquire();

    const chatRes = await fastify.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude" },
    });

    // All must be 409 with uniform shape
    for (const res of [execRes, parsePrdRes, chatRes]) {
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.reason).toBe("active_session");
      expect(body.error).toBe("Another session is active");
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
    }
  });
});
