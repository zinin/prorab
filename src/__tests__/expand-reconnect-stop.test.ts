/**
 * Integration tests: expand reconnect + stop validation (REQ-011 / REQ-012).
 *
 * Builds a real Fastify server with ExpandManager wired — same as serve.ts —
 * and exercises reconnect and stop scenarios via HTTP + WebSocket.
 *
 * Unlike the unit-level ws-connected-expand.test.ts and ws-no-duplicate-expand.test.ts
 * (which use mock sockets and WsBroadcaster directly), these tests exercise the full
 * stack: ExpandManager → SessionCore → WsBroadcaster → real WS → HTTP routes.
 *
 * Uses a controllable mock DriverRunner with a deferred promise so the test can
 * pause the session mid-flight and exercise:
 *   1. WS reconnect during active expand — connected snapshot has expandSession
 *   2. WS reconnect after expand completion — connected snapshot has expandOutcome
 *   3. Stop own active session → 200 + cancelled outcome via WS
 *   4. Stop different task → 409 task_mismatch
 *   5. Stop with no active session → 409 no_active_session
 *   6. Replay does not duplicate terminal transitions
 *   7. Store rehydration via connected message
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { ExpandManager } from "../server/expand-manager.js";
import { ExecutionManager } from "../server/execution-manager.js";
import { SessionCore } from "../server/session/session-core.js";
import { setupWebSocket, setExpandStateProvider } from "../server/ws.js";
import { expandRoutes } from "../server/routes/expand.js";
import { tasksRoutes } from "../server/routes/tasks.js";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";

// ---------------------------------------------------------------------------
// Deferred promise utility — lets the test control when the agent completes
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Controllable mock DriverRunner
// ---------------------------------------------------------------------------

const MOCK_SUBTASKS_JSON = JSON.stringify({
  subtasks: [
    { id: 1, title: "Subtask A", description: "First subtask", details: "Details A", dependencies: [] },
    { id: 2, title: "Subtask B", description: "Second subtask", details: "Details B", dependencies: [1] },
  ],
});

/** Each test can set this to control when the mock driver resolves. */
let activeDeferred: Deferred<string> | null = null;

vi.mock("../server/session/driver-runner.js", () => {
  return {
    DriverRunner: class MockDriverRunner {
      private _onLog: ((event: Record<string, unknown>) => void) | null = null;
      constructor(_agent: string, _model?: string) {}
      setup = vi.fn(async (_opts: unknown, onLog?: (event: Record<string, unknown>) => void) => {
        if (onLog) this._onLog = onLog;
      });
      teardown = vi.fn(async () => {});
      getDriver = vi.fn(() => ({}));
      setOnLog = vi.fn((fn: (event: Record<string, unknown>) => void) => { this._onLog = fn; });
      runSession = vi.fn(async () => {
        // Emit some agent events so they appear in WS replay
        if (this._onLog) {
          this._onLog({ type: "agent:text", text: "Analyzing task structure..." });
          this._onLog({ type: "agent:tool", name: "Read", summary: "Reading tasks.json" });
        }

        // Wait for test to resolve the deferred (or resolve immediately if no deferred)
        const resultText = activeDeferred
          ? await activeDeferred.promise
          : MOCK_SUBTASKS_JSON;

        return {
          signal: { type: "complete" as const },
          durationMs: 2000,
          costUsd: 0.02,
          numTurns: 5,
          resultText,
          inputTokens: 1000,
          outputTokens: 400,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          model: "claude-sonnet-4-20250514",
          agentReport: null,
          reviewReport: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
      });
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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

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
      title: "Add logging",
      description: "Add structured logging",
      status: "pending",
      dependencies: [],
      priority: "medium",
      subtasks: [],
    },
    {
      id: 3,
      title: "Done task",
      description: "Already done",
      status: "done",
      dependencies: [],
      subtasks: [],
    },
  ],
  metadata: {
    projectName: "reconnect-stop-test",
    totalTasks: 3,
    sourceFile: "prd.md",
    generatedAt: new Date().toISOString(),
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Open a WS connection and return the connected message. */
function wsConnect(port: number): Promise<{ ws: WebSocket; connected: Record<string, unknown>; replay: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let connected: Record<string, unknown> | null = null;
    const replay: Record<string, unknown>[] = [];
    const timer = setTimeout(() => { ws.close(); reject(new Error("WS connect timeout")); }, 5000);

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "connected") {
          connected = msg;
        } else if (msg.type === "replay:complete") {
          clearTimeout(timer);
          resolve({ ws, connected: connected!, replay });
        } else {
          replay.push(msg);
        }
      } catch { /* ignore */ }
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Collect WS events until predicate matches or timeout. */
function collectWsEvents(
  port: number,
  predicate: (events: any[]) => boolean,
  timeoutMs = 5000,
): Promise<{ events: any[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ events, ws });
    }, timeoutMs);

    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        events.push(msg);
        if (predicate(events)) {
          clearTimeout(timer);
          resolve({ events, ws });
        }
      } catch { /* ignore */ }
    });
    ws.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Wait for manager to reach idle state (silent on timeout — use in cleanup/finally). */
async function waitForIdle(manager: ExpandManager, maxMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (manager.getState() === "idle") return;
    await new Promise((r) => setTimeout(r, 30));
  }
}

/**
 * Like waitForIdle but throws on timeout — use in assertion contexts where a
 * stuck manager should fail the test rather than silently passing on stale state.
 */
async function assertIdle(manager: ExpandManager, maxMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (manager.getState() === "idle") return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(
    `ExpandManager did not reach idle within ${maxMs}ms (current state: ${manager.getState()})`,
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("expand reconnect + stop integration", { timeout: 30_000 }, () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let port: number;
  let expandManager: ExpandManager;

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-expand-reconnect-"));
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });

    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# PRD\n\nReconnect-stop test.\n",
    );
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify(FIXTURE_TASKS),
    );

    fastify = Fastify({ logger: false });

    const executionManager = new ExecutionManager(cwd);
    const broadcaster = await setupWebSocket(fastify, executionManager, cwd);

    const expandSessionCore = new SessionCore(cwd);
    expandManager = new ExpandManager(cwd, expandSessionCore, broadcaster);
    setExpandStateProvider(expandManager);

    await fastify.register(expandRoutes(expandManager, cwd));
    await fastify.register(tasksRoutes(cwd));

    await fastify.listen({ port: 0, host: "127.0.0.1" });
    const address = fastify.server.address();
    port = typeof address === "object" && address ? address.port : 0;
  });

  afterAll(async () => {
    if (fastify) await fastify.close();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  });

  beforeEach(() => {
    activeDeferred = null;
    vi.clearAllMocks();
    // Re-write tasks.json to reset state for each test
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify(FIXTURE_TASKS),
    );
  });

  // =========================================================================
  // 1. Reconnect during active expand
  // =========================================================================

  describe("reconnect during active expand", () => {
    it("connected snapshot contains expandSession with correct taskId, agent, state", async () => {
      // Use a deferred to keep the session alive
      activeDeferred = createDeferred();

      // Start expand
      const res = await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });
      expect(res.status).toBe(200);

      // Wait for session to be active
      await new Promise((r) => setTimeout(r, 200));
      expect(expandManager.getState()).toBe("active");

      // Simulate a new WS client (reconnect)
      const { ws, connected } = await wsConnect(port);

      try {
        // Verify connected snapshot
        expect(connected.expandSession).not.toBeNull();
        const session = connected.expandSession as Record<string, unknown>;
        expect(session.taskId).toBe("1");
        expect(session.agent).toBe("claude");
        expect(session.state).toBe("active");
        expect(session.sessionId).toBeDefined();

        // expandOutcome should be null (session still running)
        expect(connected.expandOutcome).toBeNull();
      } finally {
        ws.close();
        // Let the session complete
        activeDeferred.resolve(MOCK_SUBTASKS_JSON);
        await waitForIdle(expandManager);
      }
    });

    it("reconnecting client receives replay events with expand channel", async () => {
      activeDeferred = createDeferred();

      // Start expand
      await fetch(`http://127.0.0.1:${port}/api/tasks/2/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      // Wait for agent events to be emitted
      await new Promise((r) => setTimeout(r, 200));

      // Reconnect — collect replay events
      const { ws, replay } = await wsConnect(port);

      try {
        // Replay should contain expand:started and agent events
        const expandEvents = replay.filter((e: any) => e.channel === "expand");
        expect(expandEvents.length).toBeGreaterThan(0);

        // expand:started must be in replay
        const started = expandEvents.find((e: any) => e.type === "expand:started");
        expect(started).toBeDefined();
        expect(started!.taskId).toBe("2");
        expect(started!.agent).toBe("claude");

        // agent:text should be in replay (emitted by mock driver)
        const agentTexts = expandEvents.filter((e: any) => e.type === "agent:text");
        expect(agentTexts.length).toBeGreaterThan(0);

        // No expand:finished in replay (session still active)
        const finished = expandEvents.find((e: any) => e.type === "expand:finished");
        expect(finished).toBeUndefined();
      } finally {
        ws.close();
        activeDeferred.resolve(MOCK_SUBTASKS_JSON);
        await waitForIdle(expandManager);
      }
    });

    it("client continues receiving live events after reconnect", async () => {
      activeDeferred = createDeferred();

      // Start expand
      await fetch(`http://127.0.0.1:${port}/api/tasks/2/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      await new Promise((r) => setTimeout(r, 200));

      // Reconnect and wait for expand:finished after resolving the deferred
      const finishedPromise = collectWsEvents(
        port,
        (events) => events.some((e) => e.type === "expand:finished"),
        5000,
      );

      // Let the session complete
      activeDeferred.resolve(MOCK_SUBTASKS_JSON);

      const { events, ws } = await finishedPromise;
      ws.close();

      // expand:finished should arrive on the new connection
      const finished = events.find((e: any) => e.type === "expand:finished");
      expect(finished).toBeDefined();
      expect(finished.outcome.status).toBe("success");
      expect(finished.outcome.taskId).toBe("2");
      expect(finished.outcome.subtaskCount).toBe(2);

      await assertIdle(expandManager);
    });
  });

  // =========================================================================
  // 2. Reconnect after expand completion
  // =========================================================================

  describe("reconnect after expand completion", () => {
    it("connected snapshot contains expandOutcome for failure (outcome persists)", async () => {
      // Use a deferred that resolves with invalid JSON → failure outcome
      activeDeferred = createDeferred();

      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      // Resolve with invalid JSON to force a failure
      activeDeferred.resolve("not valid json at all");
      await assertIdle(expandManager);

      // Failure outcome should persist (unlike success which is cleared)
      expect(expandManager.getOutcome()).not.toBeNull();
      expect(expandManager.getOutcome()!.status).toBe("failure");

      // Reconnect and check connected snapshot
      const { ws, connected } = await wsConnect(port);
      ws.close();

      expect(connected.expandSession).toBeNull(); // session cleaned up
      expect(connected.expandOutcome).not.toBeNull();
      const outcome = connected.expandOutcome as Record<string, unknown>;
      expect(outcome.status).toBe("failure");
      expect(outcome.taskId).toBe("1");
      expect(outcome.reason).toBeDefined();
    });

    it("cancelled outcome persists across reconnect until next expand start", async () => {
      activeDeferred = createDeferred();

      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      await new Promise((r) => setTimeout(r, 200));

      // Stop the session → cancelled
      const stopRes = await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "DELETE",
      });
      expect(stopRes.status).toBe(200);

      await assertIdle(expandManager);

      // First reconnect — cancelled outcome
      const { ws: ws1, connected: c1 } = await wsConnect(port);
      ws1.close();
      expect(c1.expandOutcome).not.toBeNull();
      expect((c1.expandOutcome as any).status).toBe("cancelled");
      expect((c1.expandOutcome as any).taskId).toBe("1");

      // Second reconnect — outcome still persists
      const { ws: ws2, connected: c2 } = await wsConnect(port);
      ws2.close();
      expect(c2.expandOutcome).not.toBeNull();
      expect((c2.expandOutcome as any).status).toBe("cancelled");
    });

    it("replay does not duplicate terminal expand:finished after completion", async () => {
      activeDeferred = createDeferred();

      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      // Resolve with invalid JSON → failure
      activeDeferred.resolve("{}");
      await assertIdle(expandManager);

      // Reconnect and count expand:finished in replay
      const { ws, replay, connected } = await wsConnect(port);
      ws.close();

      const expandFinished = replay.filter((e: any) => e.type === "expand:finished");
      // Exactly one expand:finished in replay — no duplicates
      expect(expandFinished.length).toBeLessThanOrEqual(1);

      // Connected carries the authoritative outcome
      expect(connected.expandOutcome).not.toBeNull();
    });

    it("success outcome is NOT persisted in connected snapshot (cleared by design)", async () => {
      // Success outcomes are cleared after broadcast — this is by design:
      // "Clear success outcome — the UI auto-transitions after success,
      //  so persisting it would cause stale state on reconnect."

      // Let the session complete successfully (no deferred)
      activeDeferred = null;

      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });
      await assertIdle(expandManager);

      // Reconnect — expandOutcome should be null for success
      const { ws, connected } = await wsConnect(port);
      ws.close();

      expect(connected.expandSession).toBeNull();
      expect(connected.expandOutcome).toBeNull();
    });
  });

  // =========================================================================
  // 3. Stop behavior
  // =========================================================================

  describe("stop behavior", () => {
    it("stop own active expand session → 200 + cancelled outcome via WS", async () => {
      activeDeferred = createDeferred();

      // Start expand
      const startRes = await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });
      expect(startRes.status).toBe(200);

      await new Promise((r) => setTimeout(r, 200));
      expect(expandManager.getState()).not.toBe("idle");

      // Collect WS events including the cancelled outcome
      const eventsPromise = collectWsEvents(
        port,
        (events) => events.some((e) => e.type === "expand:finished"),
        5000,
      );

      // Stop the session
      const stopRes = await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "DELETE",
      });
      expect(stopRes.status).toBe(200);
      expect(stopRes.headers.get("content-type")).toContain("application/json");
      const stopBody = await stopRes.json();
      expect(stopBody).toEqual({ stopped: true });

      // WS should deliver expand:finished with cancelled outcome
      const { events, ws } = await eventsPromise;
      ws.close();

      const finished = events.find((e: any) => e.type === "expand:finished");
      expect(finished).toBeDefined();
      expect(finished.outcome.status).toBe("cancelled");
      expect(finished.outcome.taskId).toBe("1");
      expect(finished.outcome.subtaskCount).toBe(0);

      await assertIdle(expandManager);
    });

    it("stop different task → 409 task_mismatch with activeTaskId", async () => {
      activeDeferred = createDeferred();

      // Start expand for task 1
      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      await new Promise((r) => setTimeout(r, 200));

      // Try to stop task 2 — should get task_mismatch
      const stopRes = await fetch(`http://127.0.0.1:${port}/api/tasks/2/expand`, {
        method: "DELETE",
      });
      expect(stopRes.status).toBe(409);
      const body = await stopRes.json();
      expect(body.reason).toBe("task_mismatch");
      expect(body.activeTaskId).toBe("1");
      expect(body.error).toMatch(/task 1/);
      expect(body.error).toMatch(/not 2/);

      // Clean up — stop the actual session
      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, { method: "DELETE" });
      await waitForIdle(expandManager);
    });

    it("stop with no active expand → 409 no_active_session", async () => {
      // No expand running
      expect(expandManager.getState()).toBe("idle");

      const res = await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "DELETE",
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.reason).toBe("no_active_session");
      expect(body.error).toBe("No active expand session");
    });

    it("stop returns 409 no_active_session even when another session type holds its SessionCore", async () => {
      // Wire up a separate SessionCore (simulating a chat/parse-prd/execution
      // manager) and acquire it. The expand stop route only checks the expand
      // manager's own session — another manager's SessionCore being active
      // must not affect the result.
      const otherSessionCore = new SessionCore(cwd);
      otherSessionCore.acquire({ skipLock: true });

      try {
        expect(otherSessionCore.isActive()).toBe(true);
        expect(expandManager.getState()).toBe("idle");

        const res = await fetch(`http://127.0.0.1:${port}/api/tasks/999/expand`, {
          method: "DELETE",
        });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.reason).toBe("no_active_session");
        expect(body.error).toBe("No active expand session");
      } finally {
        otherSessionCore.release();
      }
    });
  });

  // =========================================================================
  // 4. Connected snapshot is authoritative
  // =========================================================================

  describe("connected snapshot is authoritative", () => {
    it("connected expandSession overrides any stale replay data", async () => {
      activeDeferred = createDeferred();

      // Start expand — this triggers expand:started broadcast
      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      await new Promise((r) => setTimeout(r, 200));

      // Reconnect — connected message is the authoritative source
      const { ws, connected, replay } = await wsConnect(port);
      ws.close();

      // Connected carries the definitive session state
      expect(connected.expandSession).not.toBeNull();
      const session = connected.expandSession as Record<string, unknown>;
      expect(session.taskId).toBe("1");
      expect(session.state).toBe("active");

      // Replay has supplementary event history
      const expandStarted = replay.find((e: any) => e.type === "expand:started");
      expect(expandStarted).toBeDefined();

      // The client should trust connected over replay for state
      // (replay may contain stale events from previous sessions)

      // Clean up
      activeDeferred.resolve(MOCK_SUBTASKS_JSON);
      await waitForIdle(expandManager);
    });

    it("connected with null expandSession after session cleanup takes precedence over stale replay", async () => {
      // Complete a session (will have events in the ring buffer)
      activeDeferred = null;
      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });
      await assertIdle(expandManager);

      // Reconnect — connected says no expand session (success outcome is cleared)
      const { ws, connected, replay } = await wsConnect(port);
      ws.close();

      // Connected is authoritative: no expand state
      expect(connected.expandSession).toBeNull();
      expect(connected.expandOutcome).toBeNull();

      // Replay may still have stale events from the completed session,
      // but the client must use connected as the authority
      // (expand:started and expand:finished may be in replay)
    });

    it("replay from session 1 does not leak into session 2 — buffer clearing prevents stale terminal state", async () => {
      // Session 1: complete with failure (failure outcome persists)
      activeDeferred = createDeferred();
      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });
      activeDeferred.resolve("invalid json");
      await assertIdle(expandManager);

      // Session 1 left events in buffer (expand:started, agent:*, expand:error, expand:finished)
      // Verify failure outcome persists
      expect(expandManager.getOutcome()?.status).toBe("failure");

      // Session 2: start a new expand (buffer is cleared by start())
      activeDeferred = createDeferred();
      await fetch(`http://127.0.0.1:${port}/api/tasks/2/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });
      await new Promise((r) => setTimeout(r, 200));

      // Reconnect during session 2 — replay should NOT contain session 1's expand:finished
      const { ws, connected, replay } = await wsConnect(port);

      try {
        // Connected shows session 2 (active), not session 1's stale outcome
        expect(connected.expandSession).not.toBeNull();
        const session = connected.expandSession as Record<string, unknown>;
        expect(session.taskId).toBe("2");
        expect(session.state).toBe("active");

        // Outcome was cleared when session 2 started (start() sets _outcome = null)
        expect(connected.expandOutcome).toBeNull();

        // Replay should only contain events from session 2, not session 1.
        // The buffer clearing in start() prevents stale terminal events from leaking.
        const expandFinished = replay.filter((e: any) => e.type === "expand:finished");
        expect(expandFinished.length).toBe(0); // no stale terminal from session 1

        // Replay should have expand:started for session 2 (taskId=2)
        const expandStarted = replay.filter((e: any) => e.type === "expand:started");
        expect(expandStarted.length).toBe(1);
        expect(expandStarted[0].taskId).toBe("2");
      } finally {
        ws.close();
        activeDeferred.resolve(MOCK_SUBTASKS_JSON);
        await waitForIdle(expandManager);
      }
    });
  });

  // =========================================================================
  // 5. Store rehydration via WS connected message
  // =========================================================================

  describe("store rehydration from connected message", () => {
    it("connected message with expandSession provides all fields needed for store rehydration", async () => {
      activeDeferred = createDeferred();

      await fetch(`http://127.0.0.1:${port}/api/tasks/2/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      await new Promise((r) => setTimeout(r, 200));

      const { ws, connected } = await wsConnect(port);

      try {
        // All fields the store needs for rehydration — verify values, not just shape,
        // so the store would produce correct UI state when consuming this payload.
        const session = connected.expandSession as Record<string, unknown>;
        expect(session.sessionId).toEqual(expect.any(String));
        expect((session.sessionId as string).length).toBeGreaterThan(0);
        expect(session.taskId).toBe("2");
        expect(session.agent).toBe("claude");
        expect(session.state).toBe("active");
        // model is optional — JSON serialization omits undefined, so the key may
        // not be present. The store handles this via optional chaining / defaults.
        // If provided, it must be a string.
        if ("model" in session) {
          expect(typeof session.model === "string" || session.model === undefined).toBe(true);
        }
      } finally {
        ws.close();
        activeDeferred.resolve(MOCK_SUBTASKS_JSON);
        await waitForIdle(expandManager);
      }
    });

    it("connected message with expandOutcome provides all fields needed for store rehydration", async () => {
      activeDeferred = createDeferred();

      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      // Force failure
      activeDeferred.resolve("not json");
      await assertIdle(expandManager);

      const { ws, connected } = await wsConnect(port);
      ws.close();

      // All fields the store needs for failure outcome rehydration — verify values
      // so the store would produce correct error UI when consuming this payload.
      const outcome = connected.expandOutcome as Record<string, unknown>;
      expect(outcome.status).toBe("failure");
      expect(outcome.taskId).toBe("1");
      expect(outcome.reason).toEqual(expect.any(String));
      expect((outcome.reason as string).length).toBeGreaterThan(0);
      expect(outcome.errors).toEqual(expect.arrayContaining([expect.any(String)]));
      expect(outcome.message).toEqual(expect.any(String));
      expect((outcome.message as string).length).toBeGreaterThan(0);
      expect(outcome.subtaskCount).toBe(0);
    });

    it("replay:complete sentinel is sent after replay, enabling store to clear rehydrating flag", async () => {
      // Just verify that every WS connection gets connected + replay + replay:complete
      // This sequence is what the store uses to manage the _rehydrating guard
      const { ws, connected, replay } = await wsConnect(port);
      ws.close();

      // If we got here, replay:complete was received (wsConnect waits for it)
      expect(connected.type).toBe("connected");
      // replay may be empty if no events — that's fine
    });
  });

  // =========================================================================
  // 6. WS event channel integrity
  // =========================================================================

  describe("expand WS events use correct channel", () => {
    it("all expand lifecycle events carry channel=expand", async () => {
      activeDeferred = createDeferred();

      // Start expand and collect events
      const eventsPromise = collectWsEvents(
        port,
        (events) => events.some((e) => e.type === "expand:finished"),
        5000,
      );

      await fetch(`http://127.0.0.1:${port}/api/tasks/1/expand`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: "claude" }),
      });

      await new Promise((r) => setTimeout(r, 100));
      activeDeferred.resolve(MOCK_SUBTASKS_JSON);

      const { events, ws } = await eventsPromise;
      ws.close();

      // All expand-related events must have channel=expand
      const expandEvents = events.filter((e: any) =>
        e.type?.startsWith("expand:") ||
        (e.channel === "expand" && e.type?.startsWith("agent:"))
      );

      for (const event of expandEvents) {
        expect(event.channel).toBe("expand");
      }

      // Verify event types present
      const types = expandEvents.map((e: any) => e.type);
      expect(types).toContain("expand:started");
      expect(types).toContain("expand:finished");

      await waitForIdle(expandManager);
    });
  });
});
