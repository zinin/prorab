/**
 * Tests for GET /api/status route.
 *
 * Verifies the status route returns correct project-state flags
 * (hasPrd, hasTasksFile, hasValidTasks) across four scenarios:
 *   1. Empty project — no PRD, no tasks.json
 *   2. PRD only — PRD exists, no tasks.json
 *   3. Valid tasks — PRD exists, valid tasks.json
 *   4. Invalid tasks — tasks.json present but malformed
 *
 * Uses Fastify inject (no real HTTP) with a temp directory per test.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { statusRoutes } from "../server/routes/status.js";
import { ExecutionManager } from "../server/execution-manager.js";
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

describe("GET /api/status", { timeout: 15_000 }, () => {
  let cwd: string;
  let fastify: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "prorab-status-route-"));
  });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  async function buildServer(): Promise<FastifyInstance> {
    fastify = Fastify({ logger: false });
    const executionManager = new ExecutionManager(cwd);
    await fastify.register(statusRoutes(executionManager, cwd));
    await fastify.ready();
    return fastify;
  }

  it("returns all project-state fields for empty project", async () => {
    // No .taskmaster directory at all
    await buildServer();

    const res = await fastify.inject({ method: "GET", url: "/api/status" });
    expect(res.statusCode).toBe(200);

    const data = res.json();
    expect(data.hasPrd).toBe(false);
    expect(data.hasTasksFile).toBe(false);
    expect(data.hasValidTasks).toBe(false);
    // Backward-compatible alias
    expect(data.hasTasksJson).toBe(false);
    // Meta fields
    expect(data.cwd).toBe(cwd);
    expect(data.executionState).toBe("idle");
  });

  it("returns hasPrd=true when PRD exists, no tasks.json", async () => {
    // Create PRD but no tasks.json
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# My Product\n\nA description of the product.",
    );

    await buildServer();

    const res = await fastify.inject({ method: "GET", url: "/api/status" });
    const data = res.json();

    expect(data.hasPrd).toBe(true);
    expect(data.hasTasksFile).toBe(false);
    expect(data.hasValidTasks).toBe(false);
    expect(data.hasTasksJson).toBe(false);
  });

  it("returns all true when valid tasks.json exists with PRD", async () => {
    // Create PRD
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# Product Requirements",
    );

    // Create valid tasks.json
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

    const res = await fastify.inject({ method: "GET", url: "/api/status" });
    const data = res.json();

    expect(data.hasPrd).toBe(true);
    expect(data.hasTasksFile).toBe(true);
    expect(data.hasValidTasks).toBe(true);
    expect(data.hasTasksJson).toBe(true);
  });

  it("returns hasValidTasks=false when tasks.json is invalid JSON", async () => {
    // Create tasks directory with invalid JSON
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      "not valid json {{{",
    );

    await buildServer();

    const res = await fastify.inject({ method: "GET", url: "/api/status" });
    const data = res.json();

    expect(data.hasPrd).toBe(false);
    expect(data.hasTasksFile).toBe(true);
    expect(data.hasValidTasks).toBe(false);
    expect(data.hasTasksJson).toBe(true); // alias maps to hasTasksFile
  });

  it("returns hasValidTasks=false when tasks.json has valid JSON but wrong schema", async () => {
    // Create tasks directory with valid JSON but bad schema
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify({ notasks: true }),
    );

    await buildServer();

    const res = await fastify.inject({ method: "GET", url: "/api/status" });
    const data = res.json();

    expect(data.hasPrd).toBe(false);
    expect(data.hasTasksFile).toBe(true);
    expect(data.hasValidTasks).toBe(false);
  });

  it("returns hasPrd=false when PRD file is whitespace-only", async () => {
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    writeFileSync(join(cwd, ".taskmaster", "docs", "prd.md"), "   \n\n  ");

    await buildServer();

    const res = await fastify.inject({ method: "GET", url: "/api/status" });
    const data = res.json();

    expect(data.hasPrd).toBe(false);
  });

  it("returns valid tasks without PRD", async () => {
    // No PRD but valid tasks.json
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify({
        tasks: [
          {
            id: 1,
            title: "Task without PRD",
            description: "Manually created",
            status: "pending",
            dependencies: [],
            subtasks: [],
          },
        ],
        metadata: {
          projectName: "test",
          totalTasks: 1,
          sourceFile: "",
          generatedAt: new Date().toISOString(),
        },
      }),
    );

    await buildServer();

    const res = await fastify.inject({ method: "GET", url: "/api/status" });
    const data = res.json();

    expect(data.hasPrd).toBe(false);
    expect(data.hasTasksFile).toBe(true);
    expect(data.hasValidTasks).toBe(true);
  });
});
