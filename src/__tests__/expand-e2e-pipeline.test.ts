/**
 * End-to-end expand pipeline integration test.
 *
 * Validates the primary happy-path: a pending top-level task is successfully
 * decomposed into subtasks through the full expand pipeline — from HTTP POST
 * through the mocked agent session, JSON validation, file write, git commit,
 * and WS event broadcasts — with the resulting state verified both via REST
 * and WS.
 *
 * This test builds a **real Fastify server** (mirroring serve.ts wiring) with
 * mocked heavy dependencies (DriverRunner, git, lock), so the ExpandManager,
 * routes, WS state provider, and file I/O exercise actual code paths while
 * avoiding external services.
 *
 * Coverage:
 *   1. POST /api/tasks/:id/expand → manager.start → background session
 *   2. Mocked driver returns valid structured JSON with 3 subtasks
 *   3. Terminal success outcome: subtasks written, sequential IDs, status=pending
 *   4. File content verified: subtasks match agent output, parent status unchanged
 *   5. Git commit called with correct taskId/subtaskCount
 *   6. WS events: expand:started, agent:*, expand:finished with correct outcome
 *   7. tasks:updated broadcast after file write
 *   8. REST /api/expand returns idle after completion
 *   9. GET /api/tasks/:id shows new subtasks
 *  10. Frontend store handles WS events and reaches completed state
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { ExpandManager } from "../server/expand-manager.js";
import { ExecutionManager } from "../server/execution-manager.js";
import { SessionCore } from "../server/session/session-core.js";
import { setupWebSocket, setExpandStateProvider, broadcastTasksUpdated } from "../server/ws.js";
import { statusRoutes } from "../server/routes/status.js";
import { expandRoutes } from "../server/routes/expand.js";
import { tasksRoutes } from "../server/routes/tasks.js";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

// --- Structured agent result: 3 subtasks ---

const MOCK_EXPAND_SUBTASKS = {
  subtasks: [
    {
      id: 1,
      title: "Set up authentication module",
      description: "Create the auth module with JWT token management",
      details: "Implement JWT token generation, validation, and refresh logic using jsonwebtoken library",
      dependencies: [] as number[],
      testStrategy: "Unit tests for token generation and validation",
    },
    {
      id: 2,
      title: "Implement login endpoint",
      description: "Create POST /api/auth/login with credential validation",
      details: "Validate email/password, issue JWT, return token in response body",
      dependencies: [1],
      testStrategy: "Integration tests with mock database",
    },
    {
      id: 3,
      title: "Add logout and session cleanup",
      description: "Implement logout endpoint and token revocation",
      details: "Maintain a token blacklist for revoked tokens, add middleware to check blacklist",
      dependencies: [1, 2],
    },
  ],
};

const MOCK_EXPAND_JSON = JSON.stringify(MOCK_EXPAND_SUBTASKS);

// --- Mock DriverRunner to return structured expand result ---

const mockRunSession = vi.fn(async () => ({
  signal: { type: "complete" as const },
  durationMs: 5000,
  costUsd: 0.05,
  numTurns: 12,
  resultText: MOCK_EXPAND_JSON,
  inputTokens: 2000,
  outputTokens: 800,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  model: "claude-sonnet-4-20250514",
  agentReport: null,
  reviewReport: null,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
}));

const mockSetup = vi.fn(async (_opts: any, onLog?: (event: any) => void) => {
  // Store onLog for agent event broadcasting
  (mockSetup as any).__onLog = onLog;
});

vi.mock("../server/session/driver-runner.js", () => {
  return {
    DriverRunner: class MockDriverRunner {
      constructor(_agent: string, _model?: string) {}
      setup = mockSetup;
      teardown = vi.fn(async () => {});
      getDriver = vi.fn(() => ({}));
      setOnLog = vi.fn();
      runSession = mockRunSession;
      get setupDone() { return true; }
      get agent() { return "claude" as const; }
      get model() { return undefined; }
      get userSettings() { return false; }
      listModels = vi.fn(async () => []);
    },
  };
});

// --- Mock git: all preflight passes, commit succeeds ---

const mockCommitExpandedTask = vi.fn();

vi.mock("../core/git.js", () => ({
  commitTaskmaster: vi.fn(),
  hasUncommittedChangesExcluding: vi.fn(() => false),
  getHeadSha: vi.fn(() => "abc123"),
  isGitRepo: vi.fn(() => true),
  isTrackedByGit: vi.fn(() => true),
  hasGitIdentity: vi.fn(() => true),
  isPathDirty: vi.fn(() => false),
  commitExpandedTask: (...args: unknown[]) => mockCommitExpandedTask(...args),
}));

// --- Mock lock ---

vi.mock("../core/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TASKS_JSON_FIXTURE = {
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
    {
      id: 3,
      title: "Write API documentation",
      description: "Document all REST endpoints",
      status: "pending",
      dependencies: [2],
      priority: "low",
      subtasks: [],
    },
  ],
  metadata: {
    projectName: "test-project",
    totalTasks: 3,
    sourceFile: "prd.md",
    generatedAt: new Date().toISOString(),
  },
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Expand E2E pipeline: happy path", { timeout: 20_000 }, () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let port: number;
  let expandManager: ExpandManager;

  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "prorab-expand-e2e-"));
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
  });

  afterEach(async () => {
    if (fastify) {
      await fastify.close();
    }
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Write the fixture tasks.json. */
  function writeTasksJson(): void {
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify(TASKS_JSON_FIXTURE),
    );
  }

  /** Read and parse the current tasks.json from disk. */
  function readTasksJsonFromDisk(): typeof TASKS_JSON_FIXTURE {
    return JSON.parse(
      readFileSync(join(cwd, ".taskmaster", "tasks", "tasks.json"), "utf8"),
    );
  }

  /** Build a full server mimicking serve.ts wiring. */
  async function buildServer(): Promise<void> {
    fastify = Fastify({ logger: false });

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
  }

  /** Collect WS events until a predicate matches or timeout. */
  function collectWsEvents(
    predicate: (events: any[]) => boolean,
    timeoutMs = 5000,
  ): Promise<any[]> {
    return new Promise((resolve, reject) => {
      const events: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);

      const timer = setTimeout(() => {
        ws.close();
        // Return what we have even on timeout
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
        } catch {
          // Ignore non-JSON
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Wait for the background session to complete (mock resolves quickly). */
  async function waitForSessionComplete(maxMs = 3000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (expandManager.getState() === "idle") return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // ==========================================================================
  // Test 1: Full happy path — POST → agent → write → commit → broadcast
  // ==========================================================================

  it("decomposes a pending task into subtasks through the full pipeline", async () => {
    writeTasksJson();
    await buildServer();

    // Start collecting WS events BEFORE triggering the expand
    const eventsPromise = collectWsEvents((events) =>
      events.some((e) => e.type === "expand:finished"),
    );

    // --- Trigger expand via HTTP ---
    const startRes = await fastify.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });
    expect(startRes.statusCode).toBe(200);
    const startBody = startRes.json();
    expect(startBody.started).toBe(true);
    expect(startBody.taskId).toBe("1");
    expect(startBody.sessionId).toBeDefined();

    // --- Wait for the background session to complete ---
    await waitForSessionComplete();

    // --- Verify manager returned to idle ---
    expect(expandManager.getState()).toBe("idle");

    // --- Verify file was written correctly ---
    const data = readTasksJsonFromDisk();

    // Task 1 now has 3 subtasks
    const task1 = data.tasks.find((t: any) => t.id === 1)!;
    expect(task1).toBeDefined();
    expect(task1.subtasks).toHaveLength(3);

    // Subtask IDs are sequential 1, 2, 3
    const subtaskIds = task1.subtasks.map((s: any) => s.id);
    expect(subtaskIds).toEqual([1, 2, 3]);

    // Each subtask has status: "pending"
    for (const st of task1.subtasks) {
      expect(st.status).toBe("pending");
    }

    // Subtask fields match the mock agent output
    expect(task1.subtasks[0].title).toBe("Set up authentication module");
    expect(task1.subtasks[0].description).toContain("auth module");
    expect(task1.subtasks[0].details).toContain("jsonwebtoken");
    expect(task1.subtasks[0].dependencies).toEqual([]);
    expect(task1.subtasks[0].testStrategy).toBe("Unit tests for token generation and validation");

    expect(task1.subtasks[1].title).toBe("Implement login endpoint");
    expect(task1.subtasks[1].dependencies).toEqual([1]);

    expect(task1.subtasks[2].title).toBe("Add logout and session cleanup");
    expect(task1.subtasks[2].dependencies).toEqual([1, 2]);
    // testStrategy not present on subtask 3 — should be absent or undefined
    expect(task1.subtasks[2].testStrategy).toBeUndefined();

    // --- Parent task status unchanged ---
    expect(task1.status).toBe("pending");

    // --- Other tasks unchanged ---
    const task2 = data.tasks.find((t: any) => t.id === 2)!;
    expect(task2.status).toBe("done");
    expect(task2.subtasks).toHaveLength(0);

    const task3 = data.tasks.find((t: any) => t.id === 3)!;
    expect(task3.status).toBe("pending");
    expect(task3.subtasks).toHaveLength(0);

    // --- Git commit called with correct arguments ---
    expect(mockCommitExpandedTask).toHaveBeenCalledOnce();
    expect(mockCommitExpandedTask).toHaveBeenCalledWith(cwd, "1", 3);

    // --- Verify WS events ---
    const events = await eventsPromise;

    // expand:started event
    const startedEvent = events.find((e: any) => e.type === "expand:started");
    expect(startedEvent).toBeDefined();
    expect(startedEvent.taskId).toBe("1");
    expect(startedEvent.agent).toBe("claude");

    // expand:finished with success outcome
    const finishedEvent = events.find((e: any) => e.type === "expand:finished");
    expect(finishedEvent).toBeDefined();
    expect(finishedEvent.outcome.status).toBe("success");
    expect(finishedEvent.outcome.taskId).toBe("1");
    expect(finishedEvent.outcome.subtaskCount).toBe(3);

    // tasks:updated broadcast was sent (from explicit broadcastTasksUpdated call)
    const tasksUpdated = events.find((e: any) => e.type === "tasks:updated");
    expect(tasksUpdated).toBeDefined();

    // --- REST /api/expand returns idle after completion ---
    const stateRes = await fastify.inject({ method: "GET", url: "/api/expand" });
    expect(stateRes.statusCode).toBe(200);
    const stateBody = stateRes.json();
    expect(stateBody.state).toBe("idle");
    // Success outcome is cleared after broadcast
    expect(stateBody.session).toBeNull();
  });

  // ==========================================================================
  // Test 2: GET /api/tasks lists task with new subtasks after expand
  // ==========================================================================

  it("GET /api/tasks returns expanded subtasks after successful expand", async () => {
    writeTasksJson();
    await buildServer();

    // Trigger expand
    const startRes = await fastify.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });
    expect(startRes.statusCode).toBe(200);

    await waitForSessionComplete();

    // Fetch all tasks via API
    const taskRes = await fastify.inject({
      method: "GET",
      url: "/api/tasks",
    });
    expect(taskRes.statusCode).toBe(200);
    const body = taskRes.json();
    const task1 = body.tasks.find((t: any) => t.id === 1);
    expect(task1).toBeDefined();
    expect(task1.subtasks).toHaveLength(3);
    expect(task1.subtasks[0].title).toBe("Set up authentication module");
    expect(task1.subtasks[0].status).toBe("pending");
    expect(task1.subtasks[2].dependencies).toEqual([1, 2]);
  });

  // ==========================================================================
  // Test 3: WS connected message after expand reflects completion
  // ==========================================================================

  it("WS connected message reflects idle state after successful expand", async () => {
    writeTasksJson();
    await buildServer();

    await expandManager.start("1", { agent: "claude" });
    await waitForSessionComplete();

    // Connect a fresh WS client — should get idle state
    const connectedMsg = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("message", (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "connected") {
          ws.close();
          resolve(msg);
        }
      });
      ws.on("error", reject);
      setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, 5000);
    });

    expect(connectedMsg.expandSession).toBeNull();
    // Success outcome is cleared — null in connected message
    expect(connectedMsg.expandOutcome).toBeNull();
  });

  // ==========================================================================
  // Test 4: Dependency normalization
  // ==========================================================================

  it("subtask dependencies reference only existing subtask IDs", async () => {
    writeTasksJson();
    await buildServer();

    const startRes = await fastify.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });
    expect(startRes.statusCode).toBe(200);

    await waitForSessionComplete();

    const data = readTasksJsonFromDisk();
    const task1 = data.tasks.find((t: any) => t.id === 1)!;
    const subtaskIds = new Set(task1.subtasks.map((s: any) => s.id));

    // Every dependency references a valid subtask ID
    for (const st of task1.subtasks) {
      for (const dep of st.dependencies) {
        expect(subtaskIds.has(dep)).toBe(true);
      }
      // No forward references (dep < own id)
      for (const dep of st.dependencies) {
        expect(dep).toBeLessThan(st.id);
      }
    }
  });

  // ==========================================================================
  // Test 5: WS event ordering — started before finished
  // ==========================================================================

  it("expand:started arrives before expand:finished in WS stream", async () => {
    writeTasksJson();
    await buildServer();

    const eventsPromise = collectWsEvents((events) =>
      events.some((e) => e.type === "expand:finished"),
    );

    await fastify.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    const events = await eventsPromise;

    const startedIdx = events.findIndex((e: any) => e.type === "expand:started");
    const finishedIdx = events.findIndex((e: any) => e.type === "expand:finished");

    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(finishedIdx).toBeGreaterThan(startedIdx);
  });

  // ==========================================================================
  // Test 6: Metadata/other fields preserved after expand
  // ==========================================================================

  it("preserves metadata and other task fields after expand", async () => {
    writeTasksJson();
    await buildServer();

    await fastify.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    await waitForSessionComplete();

    const data = readTasksJsonFromDisk();

    // Metadata preserved
    expect(data.metadata.projectName).toBe("test-project");
    expect(data.metadata.totalTasks).toBe(3);

    // Task 1 still has all original fields
    const task1 = data.tasks.find((t: any) => t.id === 1)!;
    expect(task1.title).toBe("Build user authentication");
    expect(task1.description).toBe("Implement user auth with JWT");
    expect(task1.priority).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Frontend integration: expand store + WS event routing
// ---------------------------------------------------------------------------

describe("Expand E2E: frontend store + WS event handling", () => {
  it("expand store transitions idle → active → completed through WS events", async () => {
    // This test simulates the same WS event sequence the real server sends
    // and verifies the store reaches the correct terminal state.
    const { setActivePinia, createPinia } = await import("pinia");
    const { useExpandStore } = await import("../../ui/src/stores/expand");

    setActivePinia(createPinia());
    const store = useExpandStore();

    expect(store.state).toBe("idle");
    expect(store.hasSession).toBe(false);

    // Simulate expand:started (sent by the server after POST succeeds)
    store.handleWsEvent({
      type: "expand:started",
      channel: "expand",
      sessionId: "test-session-1",
      taskId: "1",
      agent: "claude",
      model: "claude-sonnet-4-20250514",
    });

    expect(store.state).toBe("active");
    expect(store.sessionInfo).not.toBeNull();
    expect(store.sessionInfo!.taskId).toBe("1");
    expect(store.sessionInfo!.agent).toBe("claude");
    expect(store.isActive).toBe(true);

    // Simulate agent:text events
    store.handleWsEvent({
      type: "agent:text",
      channel: "expand",
      text: "Analyzing task structure...",
    });

    expect(store.messages).toHaveLength(1);
    expect(store.messages[0].type).toBe("text");
    expect(store.messages[0].content).toContain("Analyzing");

    // Simulate agent:tool event
    store.handleWsEvent({
      type: "agent:tool",
      channel: "expand",
      name: "Read",
      summary: "Reading src/index.ts",
    });

    expect(store.messages).toHaveLength(2);
    expect(store.messages[1].type).toBe("tool");
    expect(store.messages[1].toolName).toBe("Read");

    // Simulate agent:tool_result event
    store.handleWsEvent({
      type: "agent:tool_result",
      channel: "expand",
      summary: "File read successfully (1024 bytes)",
    });

    expect(store.messages).toHaveLength(3);

    // Simulate expand:finished with success
    store.handleWsEvent({
      type: "expand:finished",
      channel: "expand",
      outcome: {
        status: "success",
        taskId: "1",
        subtaskCount: 3,
      },
    });

    expect(store.state).toBe("completed");
    expect(store.isCompleted).toBe(true);
    expect(store.outcome).not.toBeNull();
    expect(store.outcome!.status).toBe("success");
    expect(store.outcome!.subtaskCount).toBe(3);
    expect(store.sessionInfo).toBeNull(); // Cleared after finished

    // isFileWritingOutcome should be true for success with subtaskCount > 0
    expect(store.isFileWritingOutcome).toBe(true);

    // belongsToTask should match via outcome.taskId
    expect(store.belongsToTask("1")).toBe(true);
    expect(store.belongsToTask("99")).toBe(false);
  });

  it("store rehydrates correctly from WS connected message with active session", async () => {
    const { setActivePinia, createPinia } = await import("pinia");
    const { useExpandStore } = await import("../../ui/src/stores/expand");

    setActivePinia(createPinia());
    const store = useExpandStore();

    // Simulate receiving a WS connected message with an active expand session
    store.rehydrateFromConnected({
      type: "connected",
      expandSession: {
        sessionId: "sess-123",
        taskId: "1",
        agent: "claude",
        model: "claude-sonnet-4-20250514",
        state: "active",
      },
      expandOutcome: null,
    });

    expect(store.state).toBe("active");
    expect(store.sessionInfo).not.toBeNull();
    expect(store.sessionInfo!.sessionId).toBe("sess-123");
    expect(store.sessionInfo!.taskId).toBe("1");
    expect(store.outcome).toBeNull();
  });

  it("store rehydrates correctly from WS connected message with terminal outcome", async () => {
    const { setActivePinia, createPinia } = await import("pinia");
    const { useExpandStore } = await import("../../ui/src/stores/expand");

    setActivePinia(createPinia());
    const store = useExpandStore();

    // Simulate connected with failure outcome (persisted because failure is not cleared)
    store.rehydrateFromConnected({
      type: "connected",
      expandSession: null,
      expandOutcome: {
        status: "failure",
        taskId: "1",
        reason: "agent_failed",
        errors: ["SDK error"],
        message: "SDK error",
        subtaskCount: 0,
      },
    });

    expect(store.state).toBe("completed");
    expect(store.sessionInfo).toBeNull();
    expect(store.outcome).not.toBeNull();
    expect(store.outcome!.status).toBe("failure");
  });

  it("auto-refresh predicate: shouldReloadAfterExpand returns true for success with subtasks", async () => {
    const { shouldReloadAfterExpand } = await import(
      "../../ui/src/composables/expand-launch-helpers"
    );

    // Success with subtaskCount > 0 → reload
    expect(
      shouldReloadAfterExpand(
        { status: "success", taskId: "1", subtaskCount: 3 },
        "1",
      ),
    ).toBe(true);

    // Success with subtaskCount === 0 → no reload (no file change)
    expect(
      shouldReloadAfterExpand(
        { status: "success", taskId: "1", subtaskCount: 0 },
        "1",
      ),
    ).toBe(false);

    // Success but different taskId → no reload
    expect(
      shouldReloadAfterExpand(
        { status: "success", taskId: "2", subtaskCount: 3 },
        "1",
      ),
    ).toBe(false);

    // commit_failed_after_write → reload (file was written)
    expect(
      shouldReloadAfterExpand(
        {
          status: "failure",
          taskId: "1",
          reason: "commit_failed_after_write",
          errors: ["git error"],
          message: "git error",
          subtaskCount: 1,
        },
        "1",
      ),
    ).toBe(true);

    // Other failures → no reload
    expect(
      shouldReloadAfterExpand(
        {
          status: "failure",
          taskId: "1",
          reason: "agent_failed",
          errors: ["error"],
          message: "error",
          subtaskCount: 0,
        },
        "1",
      ),
    ).toBe(false);

    // Cancelled → no reload
    expect(
      shouldReloadAfterExpand(
        { status: "cancelled", taskId: "1", subtaskCount: 0 },
        "1",
      ),
    ).toBe(false);
  });
});
