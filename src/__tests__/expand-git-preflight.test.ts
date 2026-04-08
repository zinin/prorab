/**
 * Git preflight validation tests for expand (REQ-008).
 *
 * Builds a real Fastify server with ExpandManager wired — same wiring as
 * serve.ts — and exercises all git precondition checks through HTTP requests.
 *
 * Coverage:
 *   1. Rejection: not a git repo -> 409 git_not_repo
 *   2. Rejection: tasks.json not tracked -> 409 tasks_file_untracked
 *   3. Rejection: missing git identity (user.name or user.email) -> 409 git_identity_missing
 *   4. Rejection: tasks.json has uncommitted changes (staged or unstaged) -> 409 tasks_file_dirty
 *   5. Allowance: other files staged, tasks.json clean -> expand starts
 *   6. Allowance: other files unstaged, tasks.json clean -> expand starts
 *   7. Allowance: untracked files present, tasks.json tracked & clean -> expand starts
 *
 * Note: hasGitIdentity() and isPathDirty() are single-boolean checks — the
 * mock layer cannot distinguish user.name vs user.email or staged vs unstaged.
 * Per-field and per-type distinctions are covered by lower-level git.ts tests.
 *
 * For each rejection: verifies HTTP 409, machine-readable reason, human-
 * readable message, and that no expand session is active after the call.
 *
 * Uses a single Fastify server (beforeAll/afterAll) with per-test git mock
 * resets (beforeEach). Mocked DriverRunner resolves instantly for allowance
 * tests so the session completes without blocking.
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

// ---------------------------------------------------------------------------
// Mock DriverRunner — resolves instantly with valid subtasks
// ---------------------------------------------------------------------------

const MOCK_SUBTASKS_JSON = JSON.stringify({
  subtasks: [
    {
      id: 1,
      title: "Subtask A",
      description: "First subtask",
      details: "Details A",
      dependencies: [] as number[],
    },
    {
      id: 2,
      title: "Subtask B",
      description: "Second subtask",
      details: "Details B",
      dependencies: [1],
    },
  ],
});

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
        durationMs: 1000,
        costUsd: 0.01,
        numTurns: 3,
        resultText: MOCK_SUBTASKS_JSON,
        inputTokens: 500,
        outputTokens: 200,
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

// ---------------------------------------------------------------------------
// Mock git — individually controllable per test
// ---------------------------------------------------------------------------

const mockIsGitRepo = vi.fn((): boolean => true);
const mockIsTrackedByGit = vi.fn((): boolean => true);
const mockHasGitIdentity = vi.fn((): boolean => true);
const mockIsPathDirty = vi.fn((): boolean => false);
const mockCommitExpandedTask = vi.fn();

vi.mock("../core/git.js", () => ({
  commitTaskmaster: vi.fn(),
  hasUncommittedChangesExcluding: vi.fn(() => false),
  getHeadSha: vi.fn(() => "abc123"),
  isGitRepo: (...args: unknown[]) => mockIsGitRepo(...(args as [string])),
  isTrackedByGit: (...args: unknown[]) => mockIsTrackedByGit(...(args as [string, string])),
  hasGitIdentity: (...args: unknown[]) => mockHasGitIdentity(...(args as [string])),
  isPathDirty: (...args: unknown[]) => mockIsPathDirty(...(args as [string, string])),
  commitExpandedTask: (...args: unknown[]) => mockCommitExpandedTask(...(args as [string, string, number])),
}));

// ---------------------------------------------------------------------------
// Mock lock
// ---------------------------------------------------------------------------

vi.mock("../core/lock.js", () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixture data
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
      title: "Add structured logging",
      description: "Add structured logging throughout the app",
      status: "done",
      dependencies: [],
      priority: "medium",
      subtasks: [],
    },
  ],
  metadata: {
    projectName: "git-preflight-test",
    totalTasks: 2,
    sourceFile: "prd.md",
    generatedAt: new Date().toISOString(),
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for ExpandManager to reach idle state.
 * Used in allowance tests where the session completes asynchronously.
 */
async function waitForIdle(manager: ExpandManager, maxMs = 5000): Promise<void> {
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

describe("expand git preflight (REQ-008)", { timeout: 20_000 }, () => {
  let cwd: string;
  let fastify: FastifyInstance;
  let port: number;
  let expandManager: ExpandManager;

  beforeAll(async () => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-expand-git-preflight-"));
    mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });

    writeFileSync(
      join(cwd, ".taskmaster", "docs", "prd.md"),
      "# PRD\n\nGit preflight test.\n",
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
    vi.clearAllMocks();

    // Reset git mocks to default (all preflight checks pass)
    mockIsGitRepo.mockReturnValue(true);
    mockIsTrackedByGit.mockReturnValue(true);
    mockHasGitIdentity.mockReturnValue(true);
    mockIsPathDirty.mockReturnValue(false);

    // Re-write tasks.json to reset state for each test (allowance tests mutate it)
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      JSON.stringify(FIXTURE_TASKS),
    );
  });

  /** POST helper for starting expand. */
  async function postExpand(taskId = "1"): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "claude" }),
    });
  }

  /** GET helper for expand state. */
  async function getExpandState(): Promise<Record<string, unknown>> {
    const res = await fetch(`http://127.0.0.1:${port}/api/expand`);
    return res.json() as Promise<Record<string, unknown>>;
  }

  // =========================================================================
  // 1. Rejection tests — each failing git check → 409 with reason
  // =========================================================================

  describe("rejection: not a git repository", () => {
    it("returns 409 with reason git_not_repo", async () => {
      mockIsGitRepo.mockReturnValue(false);

      const res = await postExpand();
      expect(res.status).toBe(409);

      const body = await res.json() as Record<string, unknown>;
      expect(body.reason).toBe("git_not_repo");
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
      expect(typeof body.message).toBe("string");
      expect((body.message as string).length).toBeGreaterThan(0);
    });

    it("leaves no active expand session", async () => {
      mockIsGitRepo.mockReturnValue(false);

      await postExpand();

      const state = await getExpandState();
      expect(state.state).toBe("idle");
      expect(state.session).toBeNull();
    });
  });

  describe("rejection: tasks.json not tracked by git", () => {
    it("returns 409 with reason tasks_file_untracked", async () => {
      mockIsTrackedByGit.mockReturnValue(false);

      const res = await postExpand();
      expect(res.status).toBe(409);

      const body = await res.json() as Record<string, unknown>;
      expect(body.reason).toBe("tasks_file_untracked");
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
      expect(typeof body.message).toBe("string");
    });

    it("leaves no active expand session", async () => {
      mockIsTrackedByGit.mockReturnValue(false);

      await postExpand();

      const state = await getExpandState();
      expect(state.state).toBe("idle");
      expect(state.session).toBeNull();
    });
  });

  // Note: hasGitIdentity() is a single boolean check that verifies both
  // user.name AND user.email are configured. The mock cannot distinguish
  // which field is missing — both map to the same reason code. A regression
  // where hasGitIdentity() starts checking only one field would require
  // lower-level git config mocking or a real git repo test.
  describe("rejection: missing git identity (user.name or user.email)", () => {
    it("returns 409 with reason git_identity_missing", async () => {
      mockHasGitIdentity.mockReturnValue(false);

      const res = await postExpand();
      expect(res.status).toBe(409);

      const body = await res.json() as Record<string, unknown>;
      expect(body.reason).toBe("git_identity_missing");
      expect(typeof body.error).toBe("string");
      expect((body.error as string).length).toBeGreaterThan(0);
      expect(typeof body.message).toBe("string");
      expect((body.message as string)).toMatch(/identity/i);
    });

    it("leaves no active expand session", async () => {
      mockHasGitIdentity.mockReturnValue(false);

      await postExpand();

      const state = await getExpandState();
      expect(state.state).toBe("idle");
      expect(state.session).toBeNull();
    });
  });

  // Note: isPathDirty() uses `git status --porcelain -- <path>` which reports
  // both staged and unstaged modifications in a single call. The mock cannot
  // distinguish staged vs unstaged — both map to the same reason code. A test
  // for distinct staged/unstaged code paths would require a real git repo.
  describe("rejection: tasks.json has uncommitted changes (staged or unstaged)", () => {
    it("returns 409 with reason tasks_file_dirty", async () => {
      mockIsPathDirty.mockReturnValue(true);

      const res = await postExpand();
      expect(res.status).toBe(409);

      const body = await res.json() as Record<string, unknown>;
      expect(body.reason).toBe("tasks_file_dirty");
      expect(typeof body.error).toBe("string");
      expect((body.error as string)).toMatch(/uncommitted/i);
      expect(typeof body.message).toBe("string");
      expect((body.message as string).length).toBeGreaterThan(0);
    });

    it("leaves no active expand session", async () => {
      mockIsPathDirty.mockReturnValue(true);

      await postExpand();

      const state = await getExpandState();
      expect(state.state).toBe("idle");
      expect(state.session).toBeNull();
    });
  });

  // =========================================================================
  // 2. Rejection: verify response shape contract
  // =========================================================================

  describe("rejection response contract", () => {
    it("all git preflight 409s include reason and error fields", async () => {
      const scenarios: Array<{ setup: () => void; expectedReason: string }> = [
        { setup: () => mockIsGitRepo.mockReturnValue(false), expectedReason: "git_not_repo" },
        { setup: () => mockIsTrackedByGit.mockReturnValue(false), expectedReason: "tasks_file_untracked" },
        { setup: () => mockHasGitIdentity.mockReturnValue(false), expectedReason: "git_identity_missing" },
        { setup: () => mockIsPathDirty.mockReturnValue(true), expectedReason: "tasks_file_dirty" },
      ];

      for (const { setup, expectedReason } of scenarios) {
        // Reset mocks to default before each scenario
        mockIsGitRepo.mockReturnValue(true);
        mockIsTrackedByGit.mockReturnValue(true);
        mockHasGitIdentity.mockReturnValue(true);
        mockIsPathDirty.mockReturnValue(false);

        setup();

        const res = await postExpand();
        expect(res.status).toBe(409);

        const body = await res.json() as Record<string, unknown>;
        expect(body).toHaveProperty("reason");
        expect(body).toHaveProperty("error");
        expect(body).toHaveProperty("message");
        expect(body.reason).toBe(expectedReason);
        expect(typeof body.error).toBe("string");
        expect(typeof body.message).toBe("string");
      }
    });
  });

  // =========================================================================
  // 3. Rejection: check ordering (git_not_repo takes priority)
  // =========================================================================

  describe("preflight check ordering", () => {
    it("git_not_repo takes priority over other failures", async () => {
      // All checks fail simultaneously
      mockIsGitRepo.mockReturnValue(false);
      mockIsTrackedByGit.mockReturnValue(false);
      mockHasGitIdentity.mockReturnValue(false);
      mockIsPathDirty.mockReturnValue(true);

      const res = await postExpand();
      expect(res.status).toBe(409);

      const body = await res.json() as Record<string, unknown>;
      expect(body.reason).toBe("git_not_repo");
    });

    it("tasks_file_untracked takes priority over git_identity_missing and tasks_file_dirty", async () => {
      mockIsTrackedByGit.mockReturnValue(false);
      mockHasGitIdentity.mockReturnValue(false);
      mockIsPathDirty.mockReturnValue(true);

      const res = await postExpand();
      expect(res.status).toBe(409);

      const body = await res.json() as Record<string, unknown>;
      expect(body.reason).toBe("tasks_file_untracked");
    });

    it("git_identity_missing takes priority over tasks_file_dirty", async () => {
      mockHasGitIdentity.mockReturnValue(false);
      mockIsPathDirty.mockReturnValue(true);

      const res = await postExpand();
      expect(res.status).toBe(409);

      const body = await res.json() as Record<string, unknown>;
      expect(body.reason).toBe("git_identity_missing");
    });
  });

  // =========================================================================
  // 4. Allowance tests — dirty "other files" do NOT block expand
  // =========================================================================

  describe("allowance: other files staged, tasks.json clean", () => {
    it("expand starts successfully (200) despite staged changes in other files", async () => {
      // Path-aware mock: returns dirty=true for any file EXCEPT tasks.json.
      // This proves that isPathDirty is only consulted for the tasks.json path
      // and that dirtiness of other files does not block expand.
      mockIsPathDirty.mockImplementation(
        (path: string) => path !== ".taskmaster/tasks/tasks.json",
      );

      const res = await postExpand();
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.started).toBe(true);
      expect(typeof body.sessionId).toBe("string");
      expect(body.taskId).toBe("1");

      // Verify isPathDirty was only called with the tasks.json path
      expect(mockIsPathDirty).toHaveBeenCalledWith(
        ".taskmaster/tasks/tasks.json",
        cwd,
      );
      for (const call of mockIsPathDirty.mock.calls) {
        expect(call[0]).toBe(".taskmaster/tasks/tasks.json");
      }

      // Wait for the session to complete (mock driver resolves instantly)
      await waitForIdle(expandManager);
    });
  });

  describe("allowance: other files unstaged, tasks.json clean", () => {
    it("expand starts successfully despite unstaged changes in other files", async () => {
      // Path-aware mock: all paths dirty except tasks.json
      mockIsPathDirty.mockImplementation(
        (path: string) => path !== ".taskmaster/tasks/tasks.json",
      );

      const res = await postExpand();
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.started).toBe(true);
      expect(typeof body.sessionId).toBe("string");

      // Confirm only tasks.json path was checked
      for (const call of mockIsPathDirty.mock.calls) {
        expect(call[0]).toBe(".taskmaster/tasks/tasks.json");
      }

      await waitForIdle(expandManager);
    });
  });

  describe("allowance: untracked files present, tasks.json tracked and clean", () => {
    it("expand starts successfully despite untracked files in the repo", async () => {
      // tasks.json is tracked and clean; other paths would report dirty.
      // isTrackedByGit only checks tasks.json, so the untracked files
      // elsewhere don't interfere.
      mockIsTrackedByGit.mockReturnValue(true);
      mockIsPathDirty.mockImplementation(
        (path: string) => path !== ".taskmaster/tasks/tasks.json",
      );

      const res = await postExpand();
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.started).toBe(true);

      // Confirm isTrackedByGit was only called for tasks.json
      for (const call of mockIsTrackedByGit.mock.calls) {
        expect(call[0]).toBe(".taskmaster/tasks/tasks.json");
      }

      await waitForIdle(expandManager);
    });
  });

  // =========================================================================
  // 5. Allowance: verify session was actually created
  // =========================================================================

  describe("allowance: session lifecycle", () => {
    it("creates an expand session that completes and returns to idle", async () => {
      const res = await postExpand();
      expect(res.status).toBe(200);

      // Wait for the session to complete
      await waitForIdle(expandManager);

      // Session should have completed and returned to idle
      const state = await getExpandState();
      expect(state.state).toBe("idle");
      expect(state.session).toBeNull();

      // Success outcomes are cleared by design (the UI auto-transitions after
      // success, so persisting it would cause stale state on reconnect).
      // Verify the outcome is null (success was set then cleared).
      expect(state.outcome).toBeNull();
    });

    it("isPathDirty is called with the correct tasks.json path and cwd", async () => {
      const res = await postExpand();
      expect(res.status).toBe(200);

      // Verify isPathDirty was called with the exact path
      expect(mockIsPathDirty).toHaveBeenCalledWith(
        ".taskmaster/tasks/tasks.json",
        cwd,
      );

      await waitForIdle(expandManager);
    });

    it("isGitRepo is called with the correct cwd", async () => {
      const res = await postExpand();
      expect(res.status).toBe(200);

      expect(mockIsGitRepo).toHaveBeenCalledWith(cwd);

      await waitForIdle(expandManager);
    });

    it("isTrackedByGit is called with the correct path and cwd", async () => {
      const res = await postExpand();
      expect(res.status).toBe(200);

      expect(mockIsTrackedByGit).toHaveBeenCalledWith(
        ".taskmaster/tasks/tasks.json",
        cwd,
      );

      await waitForIdle(expandManager);
    });

    it("hasGitIdentity is called with the correct cwd", async () => {
      const res = await postExpand();
      expect(res.status).toBe(200);

      expect(mockHasGitIdentity).toHaveBeenCalledWith(cwd);

      await waitForIdle(expandManager);
    });
  });
});
