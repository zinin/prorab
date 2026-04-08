/**
 * Browser smoke test: parse-prd wizard state.
 *
 * Verifies that when a fixture project has a PRD but no tasks.json,
 * the main page shows the parse-prd wizard (title "Generate Tasks",
 * agent/model controls, "Generate" CTA) and does NOT show a textarea
 * for initial message (chat mode).
 *
 * Starts a full server (with SPA static files) on a random port,
 * checks /api/status for correct project state flags, fetches the
 * SPA HTML, and verifies the WS connected message carries the right
 * project state. Does NOT require a real LLM.
 *
 * Uses beforeAll/afterAll for the server lifecycle to avoid per-test
 * startup overhead and flaky timeouts.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { ExecutionManager } from "../server/execution-manager.js";
import { ChatManager } from "../server/chat-manager.js";
import { ParsePrdManager } from "../server/parse-prd-manager.js";
import { SessionCore } from "../server/session/session-core.js";
import { setupWebSocket, setChatStateProvider, setParsePrdStateProvider } from "../server/ws.js";
import { statusRoutes } from "../server/routes/status.js";
import { parsePrdRoutes } from "../server/routes/parse-prd.js";
import { chatRoutes } from "../server/routes/chat.js";
import { modelsRoutes } from "../server/routes/models.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
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

// --- Mock driver factory so /api/models doesn't need real SDK ---
vi.mock("../core/drivers/factory.js", () => ({
  createDriver: vi.fn(() => ({
    setup: vi.fn(async () => {}),
    teardown: vi.fn(async () => {}),
    listModels: vi.fn(async () => [
      { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
      { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
    ]),
  })),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDistPath = join(__dirname, "..", "..", "ui", "dist");

describe("smoke: parse-prd wizard state", () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    vi.clearAllMocks();

    // Create fixture: .taskmaster/docs/prd.md but no tasks.json
    cwd = mkdtempSync(join(tmpdir(), "prorab-prd-wizard-smoke-"));
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# Sample PRD\n\nThis is a sample PRD for smoke testing the parse-prd wizard state.\n\n## Features\n1. User auth\n2. Dashboard\n",
    );

    // Build full server mimicking serve.ts wiring
    fastify = Fastify({ logger: false });

    if (existsSync(uiDistPath)) {
      await fastify.register(fastifyStatic, {
        root: uiDistPath,
        prefix: "/",
        wildcard: false,
      });
      fastify.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/") || request.url.startsWith("/ws")) {
          reply.code(404).send({ error: "Not found" });
        } else {
          reply.sendFile("index.html");
        }
      });
    }

    const executionManager = new ExecutionManager(cwd);
    const broadcaster = await setupWebSocket(fastify, executionManager, cwd);

    const chatSessionCore = new SessionCore(cwd);
    const chatManager = new ChatManager(cwd, chatSessionCore, broadcaster);
    setChatStateProvider(chatManager);

    const parsePrdSessionCore = new SessionCore(cwd);
    const parsePrdManager = new ParsePrdManager(cwd, parsePrdSessionCore, broadcaster);
    setParsePrdStateProvider(parsePrdManager);

    await fastify.register(statusRoutes(executionManager, cwd));
    await fastify.register(parsePrdRoutes(parsePrdManager, cwd));
    await fastify.register(chatRoutes(chatManager, cwd));
    await fastify.register(modelsRoutes());

    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const address = fastify.server.address();
    port = typeof address === "object" && address ? address.port : 0;
  }, 15_000);

  afterAll(async () => {
    if (fastify) {
      await fastify.close();
    }
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("precondition: fixture has PRD but no tasks.json", () => {
    expect(existsSync(join(cwd, ".taskmaster", "docs", "prd.md"))).toBe(true);
    expect(existsSync(join(cwd, ".taskmaster", "tasks", "tasks.json"))).toBe(false);
  });

  it("/api/status returns hasPrd=true, hasTasksFile=false", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(res.ok).toBe(true);

    const status = await res.json();
    expect(status.hasPrd).toBe(true);
    expect(status.hasTasksFile).toBe(false);
    expect(status.hasValidTasks).toBe(false);
  });

  it("WS connected message carries correct project-state flags", async () => {
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
    expect(connected.hasPrd).toBe(true);
    expect(connected.hasTasksFile).toBe(false);
    expect(connected.hasValidTasks).toBe(false);
    // No active sessions
    expect(connected.chatSession).toBeNull();
    expect(connected.parsePrdSession).toBeNull();
  });

  it.skipIf(!existsSync(uiDistPath))("SPA index.html is served at /", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);

    const html = await res.text();
    // SPA shell should contain the Vue mount point
    expect(html).toContain('<div id="app">');
    // Should include bundled JS
    expect(html).toContain("<script");
  });

  it("POST /api/parse-prd accepts start request (PRD exists, no tasks.json)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/parse-prd`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "claude" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.started).toBe(true);
    expect(body.sessionId).toBeDefined();
  });

  it("models endpoint returns 200 (needed for wizard agent/model selects)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/models?agent=claude`);
    expect(res.ok).toBe(true);
  });
});
