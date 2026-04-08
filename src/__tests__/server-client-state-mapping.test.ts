/**
 * End-to-end mapping test: server → client project-state fields.
 *
 * Verifies that hasPrd, hasTasksFile, hasValidTasks (and the backward-
 * compatible hasTasksJson alias) travel correctly from the server to
 * the client via both REST (GET /api/status) and WebSocket (connected
 * message). Uses a real Fastify server with WebSocket, temp filesystem
 * state, and a real WebSocket client — no mock for project-state
 * helpers (only heavy deps like git, lock, DriverRunner are mocked).
 *
 * Key scenarios tested:
 *   1. Empty project (no PRD, no tasks.json)
 *   2. PRD only (PRD written, parse-prd not yet run)
 *   3. tasks.json present but invalid (distinction: hasTasksFile=true,
 *      hasValidTasks=false)
 *   4. Fully initialized project (all true)
 *   5. REST and WS return consistent values for every scenario
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { ExecutionManager } from "../server/execution-manager.js";
import { setupWebSocket } from "../server/ws.js";
import { statusRoutes } from "../server/routes/status.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock git to prevent real git calls
vi.mock("../core/git.js", () => ({
  commitTaskmaster: vi.fn(),
  hasUncommittedChangesExcluding: vi.fn(() => false),
  getHeadSha: vi.fn(() => "abc123"),
}));

// Mock lock to prevent real file lock issues
vi.mock("../core/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

describe("server → client project-state mapping", { timeout: 15_000 }, () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let port: number;

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "prorab-state-mapping-"));
  });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  async function buildServer(): Promise<void> {
    fastify = Fastify({ logger: false });
    const executionManager = new ExecutionManager(cwd);
    await setupWebSocket(fastify, executionManager, cwd);
    await fastify.register(statusRoutes(executionManager, cwd));
    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const address = fastify.server.address();
    port = typeof address === "object" && address ? address.port : 0;
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

  /** Get REST /api/status response. */
  async function getRestStatus(): Promise<Record<string, unknown>> {
    const res = await fastify.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(200);
    return res.json();
  }

  // ---- Assertion helper ----

  function expectProjectState(
    data: Record<string, unknown>,
    expected: { hasPrd: boolean; hasTasksFile: boolean; hasValidTasks: boolean },
    label: string,
  ) {
    expect(data.hasPrd, `${label}: hasPrd`).toBe(expected.hasPrd);
    expect(data.hasTasksFile, `${label}: hasTasksFile`).toBe(expected.hasTasksFile);
    expect(data.hasValidTasks, `${label}: hasValidTasks`).toBe(expected.hasValidTasks);
    // Backward-compatible alias always equals hasTasksFile
    expect(data.hasTasksJson, `${label}: hasTasksJson`).toBe(expected.hasTasksFile);
  }

  // ---- Scenario 1: empty project ----

  it("empty project: both REST and WS report all false", async () => {
    // No .taskmaster directory at all
    await buildServer();

    const [restData, wsData] = await Promise.all([
      getRestStatus(),
      getWsConnectedMessage(),
    ]);

    const expected = { hasPrd: false, hasTasksFile: false, hasValidTasks: false };
    expectProjectState(restData, expected, "REST");
    expectProjectState(wsData, expected, "WS");
  });

  // ---- Scenario 2: PRD only ----

  it("PRD-only project: hasPrd=true, tasks flags false", async () => {
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# My Product\n\nA description.",
    );

    await buildServer();

    const [restData, wsData] = await Promise.all([
      getRestStatus(),
      getWsConnectedMessage(),
    ]);

    const expected = { hasPrd: true, hasTasksFile: false, hasValidTasks: false };
    expectProjectState(restData, expected, "REST");
    expectProjectState(wsData, expected, "WS");
  });

  // ---- Scenario 3: key distinction — hasTasksFile=true, hasValidTasks=false ----

  it("invalid tasks.json: hasTasksFile=true, hasValidTasks=false (key distinction)", async () => {
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      "not valid json {{{",
    );

    await buildServer();

    const [restData, wsData] = await Promise.all([
      getRestStatus(),
      getWsConnectedMessage(),
    ]);

    const expected = { hasPrd: false, hasTasksFile: true, hasValidTasks: false };
    expectProjectState(restData, expected, "REST");
    expectProjectState(wsData, expected, "WS");
  });

  it("schema-mismatch tasks.json: hasTasksFile=true, hasValidTasks=false", async () => {
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify({ notasks: true }),
    );

    await buildServer();

    const [restData, wsData] = await Promise.all([
      getRestStatus(),
      getWsConnectedMessage(),
    ]);

    const expected = { hasPrd: false, hasTasksFile: true, hasValidTasks: false };
    expectProjectState(restData, expected, "REST");
    expectProjectState(wsData, expected, "WS");
  });

  // ---- Scenario 4: fully initialized project ----

  it("fully initialized project: all flags true", async () => {
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# Product Requirements",
    );
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify({
        tasks: [
          {
            id: 1,
            title: "First task",
            description: "Do something",
            status: "pending",
            dependencies: [],
            subtasks: [],
          },
        ],
        metadata: {
          projectName: "test",
          totalTasks: 1,
          sourceFile: "prd.md",
          generatedAt: new Date().toISOString(),
        },
      }),
    );

    await buildServer();

    const [restData, wsData] = await Promise.all([
      getRestStatus(),
      getWsConnectedMessage(),
    ]);

    const expected = { hasPrd: true, hasTasksFile: true, hasValidTasks: true };
    expectProjectState(restData, expected, "REST");
    expectProjectState(wsData, expected, "WS");
  });

  // ---- Scenario 5: all fields present simultaneously ----

  it("all four fields are present simultaneously in REST response", async () => {
    await buildServer();
    const data = await getRestStatus();

    // Verify all fields exist (not undefined) — no field is omitted
    expect("hasPrd" in data).toBe(true);
    expect("hasTasksFile" in data).toBe(true);
    expect("hasValidTasks" in data).toBe(true);
    expect("hasTasksJson" in data).toBe(true);
  });

  it("all four fields are present simultaneously in WS connected message", async () => {
    await buildServer();
    const data = await getWsConnectedMessage();

    // Verify all fields exist (not undefined) — no field is omitted
    expect("hasPrd" in data).toBe(true);
    expect("hasTasksFile" in data).toBe(true);
    expect("hasValidTasks" in data).toBe(true);
    expect("hasTasksJson" in data).toBe(true);
  });

  // ---- Scenario 6: REST and WS consistency ----

  it("REST and WS return identical project-state values (consistency check)", async () => {
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# Requirements\n\nSome content.",
    );
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify({ wrongFormat: [] }), // Valid JSON but wrong schema
    );

    await buildServer();

    const [restData, wsData] = await Promise.all([
      getRestStatus(),
      getWsConnectedMessage(),
    ]);

    // Both must report identical project-state
    expect(restData.hasPrd).toBe(wsData.hasPrd);
    expect(restData.hasTasksFile).toBe(wsData.hasTasksFile);
    expect(restData.hasValidTasks).toBe(wsData.hasValidTasks);
    expect(restData.hasTasksJson).toBe(wsData.hasTasksJson);

    // And both should report the correct values
    expect(restData.hasPrd).toBe(true);
    expect(restData.hasTasksFile).toBe(true);
    expect(restData.hasValidTasks).toBe(false);
  });
});
