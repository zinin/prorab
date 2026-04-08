/**
 * Full-server smoke test: expand (task decomposition) flow.
 *
 * Builds a real Fastify server with ExpandManager wired — same wiring as
 * serve.ts — and exercises the expand lifecycle via fetch + ws.  Uses the
 * scripted DriverRunner mock (agent returns structured JSON with 3 subtasks)
 * so no real LLM is needed.
 *
 * Coverage:
 *   1. /api/status returns correct project-state flags (hasTasksFile, hasPrd)
 *   2. WS connected message includes expandSession/expandOutcome fields
 *   3. POST /api/tasks/1/expand → 200, starts session, triggers WS events
 *   4. expand:started, agent:*, tasks:updated, expand:finished WS events flow
 *   5. After completion: GET /api/expand returns idle, file has subtasks
 *   6. GET /api/tasks lists task with new subtasks
 *   7. SPA shell served at / (if ui/dist exists)
 *   8. WS /ws endpoint accessible
 *   9. GET /api/tasks/:id returns single expanded task
 *
 * NOTE: active_session conflict (concurrent POST) is not tested here because the
 * mocked driver resolves instantly — covered in expand-no-write-guarantee.test.ts.
 *
 * Uses beforeAll/afterAll for the server lifecycle to avoid per-test overhead.
 * Tests within the suite run sequentially (vitest default); post-expand
 * verification tests depend on the happy-path test having completed.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { ExpandManager } from "../server/expand-manager.js";
import { ExecutionManager } from "../server/execution-manager.js";
import { SessionCore } from "../server/session/session-core.js";
import { setupWebSocket, setExpandStateProvider } from "../server/ws.js";
import { statusRoutes } from "../server/routes/status.js";
import { expandRoutes } from "../server/routes/expand.js";
import { tasksRoutes } from "../server/routes/tasks.js";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

// --- Structured subtask result ---

const MOCK_SUBTASKS_JSON = JSON.stringify({
  subtasks: [
    {
      id: 1,
      title: "Set up auth module",
      description: "Create auth module with JWT management",
      details: "Implement JWT token generation, validation, refresh",
      dependencies: [] as number[],
      testStrategy: "Unit tests for token ops",
    },
    {
      id: 2,
      title: "Implement login endpoint",
      description: "POST /api/auth/login with credential validation",
      details: "Validate email/password, issue JWT, return token",
      dependencies: [1],
    },
    {
      id: 3,
      title: "Add logout and cleanup",
      description: "Implement logout and token revocation",
      details: "Token blacklist for revoked tokens, blacklist middleware",
      dependencies: [1, 2],
    },
  ],
});

// --- Mock DriverRunner ---

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
        durationMs: 3000,
        costUsd: 0.03,
        numTurns: 8,
        resultText: MOCK_SUBTASKS_JSON,
        inputTokens: 1500,
        outputTokens: 600,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        model: "claude-sonnet-4-20250514",
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

// --- Mock git ---

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

// --- Mock lock ---

vi.mock("../core/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

const __dirname_test = dirname(fileURLToPath(import.meta.url));
const uiDistPath = join(__dirname_test, "..", "..", "ui", "dist");

// --- Fixture data ---

const FIXTURE_TASKS = {
  tasks: [
    {
      id: 1,
      title: "Build user authentication",
      description: "Implement user auth with JWT",
      details: "Create login/logout endpoints with token management",
      status: "pending",
      dependencies: [],
      priority: "high",
      subtasks: [],
    },
    {
      id: 2,
      title: "Add structured logging",
      description: "Add structured logging throughout the app",
      status: "done",
      dependencies: [],
      priority: "medium",
      subtasks: [],
    },
  ],
  metadata: {
    projectName: "expand-smoke",
    totalTasks: 2,
    sourceFile: "prd.md",
    generatedAt: new Date().toISOString(),
  },
};

// ---------------------------------------------------------------------------

describe("smoke: expand full-server flow", { timeout: 20_000 }, () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let port: number;
  let expandManager: ExpandManager;

  /** Set by the happy-path test; guards dependent post-expand tests. */
  let happyPathCompleted = false;

  beforeAll(async () => {
    vi.clearAllMocks();

    cwd = mkdtempSync(join(tmpdir(), "prorab-expand-smoke-"));
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });

    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# PRD\n\nExpand smoke test.\n",
    );
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify(FIXTURE_TASKS),
    );

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

    const expandSessionCore = new SessionCore(cwd);
    expandManager = new ExpandManager(cwd, expandSessionCore, broadcaster);
    setExpandStateProvider(expandManager);

    await fastify.register(statusRoutes(executionManager, cwd));
    await fastify.register(expandRoutes(expandManager, cwd));
    await fastify.register(tasksRoutes(cwd));

    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const address = fastify.server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    if (fastify) {
      await fastify.close();
    }
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // --- Helpers ---

  function getWsEvents(
    predicate: (events: any[]) => boolean,
    timeoutMs = 5000,
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const events: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => {
        ws.close();
        resolve(events);
      }, timeoutMs);

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          events.push(msg);
          if (predicate(events)) {
            clearTimeout(timer);
            ws.close();
            resolve(events);
          }
        } catch { /* ignore */ }
      });
      ws.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }

  async function waitForIdle(maxMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (expandManager.getState() === "idle") return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // --- Precondition tests ---

  it("fixture: tasks.json and PRD exist", () => {
    expect(existsSync(join(cwd, ".taskmaster", "tasks", "tasks.json"))).toBe(true);
    expect(existsSync(join(cwd, ".taskmaster", "docs", "prd.md"))).toBe(true);
  });

  it("/api/status returns hasTasksFile=true, hasPrd=true", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.hasTasksFile).toBe(true);
    expect(body.hasPrd).toBe(true);
    expect(body.hasValidTasks).toBe(true);
  });

  // --- WS connected message ---

  it("WS connected message includes expand fields (initially null)", async () => {
    const events = await getWsEvents((evts) =>
      evts.some((e) => e.type === "connected"),
    );

    const connected = events.find((e) => e.type === "connected");
    expect(connected).toBeDefined();
    expect("expandSession" in connected).toBe(true);
    expect("expandOutcome" in connected).toBe(true);
    expect(connected.expandSession).toBeNull();
    expect(connected.expandOutcome).toBeNull();
  });

  it("WS connected message also includes replay:complete sentinel", async () => {
    const events = await getWsEvents((evts) =>
      evts.some((e) => e.type === "replay:complete"),
    );

    const replayComplete = events.find((e) => e.type === "replay:complete");
    expect(replayComplete).toBeDefined();
  });

  // --- Expand happy path ---

  it("POST /api/tasks/1/expand → expand:started → expand:finished(success) flow", async () => {
    // Start collecting WS events
    const eventsPromise = getWsEvents((events) =>
      events.some((e) => e.type === "expand:finished"),
    );

    // Trigger expand via HTTP
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "claude" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.started).toBe(true);
    expect(body.sessionId).toBeDefined();
    expect(body.taskId).toBe("1");

    // Wait for background session
    await waitForIdle();

    // Collect WS events
    const events = await eventsPromise;

    // expand:started
    const started = events.find((e: any) => e.type === "expand:started");
    expect(started).toBeDefined();
    expect(started.taskId).toBe("1");
    expect(started.agent).toBe("claude");

    // expand:finished with success
    const finished = events.find((e: any) => e.type === "expand:finished");
    expect(finished).toBeDefined();
    expect(finished.outcome.status).toBe("success");
    expect(finished.outcome.taskId).toBe("1");
    expect(finished.outcome.subtaskCount).toBe(3);

    // tasks:updated broadcast
    const tasksUpdated = events.find((e: any) => e.type === "tasks:updated");
    expect(tasksUpdated).toBeDefined();

    happyPathCompleted = true;
  });

  // --- Post-expand state verification (depend on happy-path) ---

  it("GET /api/expand returns idle after successful expand", async () => {
    expect(happyPathCompleted, "happy-path test must pass first").toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/expand`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.state).toBe("idle");
    expect(body.session).toBeNull();
  });

  it("GET /api/tasks shows expanded subtasks on task 1", async () => {
    expect(happyPathCompleted, "happy-path test must pass first").toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    const task1 = body.tasks.find((t: any) => t.id === 1);
    expect(task1).toBeDefined();
    expect(task1.subtasks).toHaveLength(3);

    // Verify subtask structure
    expect(task1.subtasks[0].id).toBe(1);
    expect(task1.subtasks[0].title).toBe("Set up auth module");
    expect(task1.subtasks[0].status).toBe("pending");
    expect(task1.subtasks[0].dependencies).toEqual([]);

    expect(task1.subtasks[1].id).toBe(2);
    expect(task1.subtasks[1].dependencies).toEqual([1]);

    expect(task1.subtasks[2].id).toBe(3);
    expect(task1.subtasks[2].dependencies).toEqual([1, 2]);

    // Parent status unchanged
    expect(task1.status).toBe("pending");

    // Other tasks unchanged
    const task2 = body.tasks.find((t: any) => t.id === 2);
    expect(task2.status).toBe("done");
    expect(task2.subtasks).toHaveLength(0);
  });

  it("GET /api/tasks/1 returns single expanded task", async () => {
    expect(happyPathCompleted, "happy-path test must pass first").toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/1`);
    expect(res.ok).toBe(true);
    const body = await res.json();

    expect(body.task).toBeDefined();
    expect(body.task.id).toBe(1);
    expect(body.task.title).toBe("Build user authentication");
    expect(body.task.status).toBe("pending");
    expect(body.task.subtasks).toHaveLength(3);
    expect(body.task.subtasks[0].title).toBe("Set up auth module");
    expect(body.task.subtasks[0].status).toBe("pending");
    expect(body.task.subtasks[2].dependencies).toEqual([1, 2]);
  });

  it("tasks.json on disk matches API response", async () => {
    expect(happyPathCompleted, "happy-path test must pass first").toBe(true);
    const data = JSON.parse(
      readFileSync(join(cwd, ".taskmaster", "tasks", "tasks.json"), "utf8"),
    );
    const task1 = data.tasks.find((t: any) => t.id === 1);
    expect(task1.subtasks).toHaveLength(3);
    expect(task1.subtasks.every((s: any) => s.status === "pending")).toBe(true);
  });

  // --- Error cases ---

  it("POST /api/tasks/1/expand returns 409 task_has_subtasks (already expanded)", async () => {
    expect(happyPathCompleted, "happy-path test must pass first").toBe(true);
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "claude" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("task_has_subtasks");
  });

  it("POST /api/tasks/2/expand returns 409 task_not_pending (status=done)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/2/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "claude" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("task_not_pending");
  });

  it("POST /api/tasks/999/expand returns 404 task_not_found", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/999/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "claude" }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("task_not_found");
  });

  it("DELETE /api/tasks/1/expand returns 409 no_active_session when idle", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("no_active_session");
  });

  // --- SPA shell ---

  it.skipIf(!existsSync(uiDistPath))("SPA index.html is served at /", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html).toContain('<div id="app">');
    expect(html).toContain("<script");
  });

  // --- WS /ws endpoint accessible ---

  it("/ws endpoint is accessible and returns connected message", async () => {
    const connected = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "connected") {
            ws.close();
            resolve(msg);
          }
        } catch { /* ignore */ }
      });
      ws.on("error", reject);
      setTimeout(() => { ws.close(); reject(new Error("WS timeout")); }, 3000);
    });
    expect(connected.type).toBe("connected");
    expect(connected.state).toBe("idle");
  });
});
