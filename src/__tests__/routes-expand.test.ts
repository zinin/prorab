import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { expandRoutes } from "../server/routes/expand.js";
import type {
  ExpandManager,
  ExpandSession,
  ExpandState,
  ExpandStopResult,
} from "../server/expand-manager.js";
import {
  ExpandSessionActiveError,
  ExpandPreflightError,
} from "../server/expand-manager.js";

// --- Mock project-state ---

vi.mock("../core/project-state.js", () => ({
  checkTasksFile: vi.fn(() => ({
    hasTasksFile: true,
    hasValidTasks: true,
  })),
}));

import { checkTasksFile } from "../core/project-state.js";
const mockCheckTasksFile = vi.mocked(checkTasksFile);

// --- Mock tasks-json ---

vi.mock("../core/tasks-json.js", () => ({
  readTasksFile: vi.fn(),
}));

import { readTasksFile } from "../core/tasks-json.js";
const mockReadTasksFile = vi.mocked(readTasksFile);

/** Default tasks data returned by readTasksFile mock. */
const DEFAULT_TASKS_DATA = {
  tasks: [
    {
      id: 1,
      title: "Test task",
      description: "A pending task for expand",
      status: "pending",
      dependencies: [],
      subtasks: [],
    },
    {
      id: 2,
      title: "Done task",
      description: "A completed task",
      status: "done",
      dependencies: [],
      subtasks: [],
    },
    {
      id: 3,
      title: "Task with subtasks",
      description: "Already expanded",
      status: "pending",
      dependencies: [],
      subtasks: [
        { id: 1, title: "Sub 1", status: "pending", dependencies: [] },
      ],
    },
  ],
  metadata: {},
} as any;

// --- Mock ExpandManager ---

function mockExpandManager(
  overrides: Partial<ExpandManager> = {},
): ExpandManager {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async (): Promise<ExpandStopResult> => ({ status: "stopped" })),
    getState: vi.fn((): ExpandState => "idle"),
    getSession: vi.fn((): ExpandSession | null => null),
    getOutcome: vi.fn(() => null),
    ...overrides,
  } as unknown as ExpandManager;
}

const defaultSession: ExpandSession = {
  id: "test-expand-session-123",
  taskId: "1",
  agent: "claude",
  model: undefined,
  variant: undefined,
  state: "active",
  tasksJsonHash: "abc123",
};

// ============================================================================
// POST /api/tasks/:id/expand
// ============================================================================

describe("POST /api/tasks/:id/expand", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: tasks.json exists and is valid, tasks include a pending one
    mockCheckTasksFile.mockReturnValue({
      hasTasksFile: true,
      hasValidTasks: true,
    });
    mockReadTasksFile.mockReturnValue(DEFAULT_TASKS_DATA);
  });

  afterEach(async () => {
    await app.close();
  });

  // --- Success ---

  it("returns 200 with sessionId and taskId on valid start", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {}),
      getSession: vi.fn(() => defaultSession),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.started).toBe(true);
    expect(body.sessionId).toBe("test-expand-session-123");
    expect(body.taskId).toBe("1");
    expect(em.start).toHaveBeenCalledWith("1", {
      agent: "claude",
      model: undefined,
      variant: undefined,
      verbosity: "trace",
      userSettings: false,
      applyHooks: false,
    });
  });

  it("passes optional model and variant to manager", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {}),
      getSession: vi.fn(() => ({
        ...defaultSession,
        model: "opus",
        variant: "high",
      })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude", model: "opus", variant: "high" },
    });

    expect(res.statusCode).toBe(200);
    expect(em.start).toHaveBeenCalledWith("1", {
      agent: "claude",
      model: "opus",
      variant: "high",
      verbosity: "trace",
      userSettings: false,
      applyHooks: false,
    });
  });

  it("does not block waiting for background agent session", async () => {
    // The manager.start() returns a promise that resolves after setup,
    // but before the background agent session completes.
    // We verify that the route returns 200 while start() itself resolves quickly.
    let startResolved = false;
    const backgroundPromise = new Promise<void>((resolve) => {
      // Simulate long-running background work that never resolves during test
      setTimeout(() => {
        startResolved = true;
        resolve();
      }, 10_000);
    });

    const em = mockExpandManager({
      start: vi.fn(async () => {
        // Fire-and-forget: start returns quickly, background work continues
        void backgroundPromise;
      }),
      getSession: vi.fn(() => defaultSession),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    // Route returns immediately
    expect(res.statusCode).toBe(200);
    expect(res.json().started).toBe(true);
    // Background promise is still pending
    expect(startResolved).toBe(false);
  });

  // --- 400: Invalid body ---

  it("returns 400 on missing body", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      // no payload
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(em.start).not.toHaveBeenCalled();
  });

  it("returns 400 on missing agent", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { model: "opus" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(em.start).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid agent type", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "gpt" },
    });

    expect(res.statusCode).toBe(400);
    expect(em.start).not.toHaveBeenCalled();
  });

  it("returns 400 when body has extra/unknown fields (strict schema)", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude", extraField: "unexpected" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(res.json().details).toBeDefined();
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- 409: tasks_file_missing ---

  it("returns 409 with reason tasks_file_missing when tasks.json does not exist", async () => {
    mockCheckTasksFile.mockReturnValue({
      hasTasksFile: false,
      hasValidTasks: false,
    });
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("tasks_file_missing");
    expect(body.error).toMatch(/does not exist/);
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- 409: tasks_file_invalid ---

  it("returns 409 with reason tasks_file_invalid when tasks.json is malformed", async () => {
    mockCheckTasksFile.mockReturnValue({
      hasTasksFile: true,
      hasValidTasks: false,
    });
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("tasks_file_invalid");
    expect(em.start).not.toHaveBeenCalled();
  });

  it("returns 409 tasks_file_invalid when readTasksFile throws", async () => {
    mockReadTasksFile.mockImplementation(() => {
      throw new Error("Corrupted JSON");
    });
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("tasks_file_invalid");
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- 404: task_not_found ---

  it("returns 404 with reason task_not_found when task does not exist", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/999/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.reason).toBe("task_not_found");
    expect(body.error).toMatch(/999/);
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- 409: task_not_pending ---

  it("returns 409 with reason task_not_pending when task status is not pending", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    // Task 2 has status "done"
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/2/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("task_not_pending");
    expect(body.error).toMatch(/done/);
    expect(body.error).toMatch(/pending/);
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- 409: task_has_subtasks ---

  it("returns 409 with reason task_has_subtasks when task already has subtasks", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    // Task 3 is pending but has subtasks
    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/3/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("task_has_subtasks");
    expect(body.error).toMatch(/1 subtask/);
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- 409: active_session (from manager) ---

  it("returns 409 with reason active_session when another session is active", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandSessionActiveError(
          "Cannot start expand: session is active",
        );
      }),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(typeof body.message).toBe("string");
  });

  // --- 409: git preflight failures (from manager) ---

  it("returns 409 with reason git_not_repo on git preflight failure", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError(
          "git_not_repo",
          "Cannot expand: not a git repository",
        );
      }),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("git_not_repo");
    expect(body.error).toMatch(/not a git repository/);
  });

  it("returns 409 with reason tasks_file_dirty on dirty tasks.json", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError(
          "tasks_file_dirty",
          "Cannot expand: .taskmaster/tasks/tasks.json has uncommitted changes",
        );
      }),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("tasks_file_dirty");
  });

  it("returns 409 with reason tasks_file_untracked when not tracked by git", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError(
          "tasks_file_untracked",
          "Cannot expand: .taskmaster/tasks/tasks.json is not tracked by git",
        );
      }),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("tasks_file_untracked");
  });

  it("returns 409 with reason git_identity_missing when git identity not configured", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError(
          "git_identity_missing",
          "Cannot expand: git user identity is not configured",
        );
      }),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("git_identity_missing");
  });

  // --- 500: unexpected errors ---

  it("returns 500 on unexpected error from manager", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new Error("Driver exploded");
      }),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("Failed to start expand session");
    expect(body.message).toBe("Driver exploded");
  });

  // --- Check order: body validation before eligibility ---

  it("checks body validation before task eligibility", async () => {
    // Even if task does not exist, invalid body returns 400 first
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/999/expand",
      payload: { agent: "invalid-agent" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("checks tasks_file_missing before task lookup", async () => {
    mockCheckTasksFile.mockReturnValue({
      hasTasksFile: false,
      hasValidTasks: false,
    });
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/999/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("tasks_file_missing");
    // readTasksFile should NOT have been called
    expect(mockReadTasksFile).not.toHaveBeenCalled();
  });

  // --- Does not block on unmet dependencies ---

  it("does not block expand due to unmet task dependencies", async () => {
    // Task 1 may have dependencies on other tasks that are not done yet.
    // The route should NOT check dependencies — only status and subtasks.
    mockReadTasksFile.mockReturnValue({
      tasks: [
        {
          id: 5,
          title: "Task with deps",
          description: "Has deps on undone tasks",
          status: "pending",
          dependencies: [99, 100], // These tasks don't exist or aren't done
          subtasks: [],
        },
      ],
      metadata: {} as any,
    });
    const em = mockExpandManager({
      start: vi.fn(async () => {}),
      getSession: vi.fn(() => ({
        ...defaultSession,
        taskId: "5",
      })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/5/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(200);
    expect(em.start).toHaveBeenCalled();
  });
});

// ============================================================================
// DELETE /api/tasks/:id/expand
// ============================================================================

describe("DELETE /api/tasks/:id/expand", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with stopped: true on successful stop", async () => {
    const em = mockExpandManager({
      stop: vi.fn(async () => ({ status: "stopped" as const })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/1/expand",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true });
    expect(em.stop).toHaveBeenCalledWith("1");
  });

  it("cancel response does not contain false-success fields", async () => {
    const em = mockExpandManager({
      stop: vi.fn(async () => ({ status: "stopped" as const })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/1/expand",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stopped).toBe(true);
    expect(body).not.toHaveProperty("started");
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("sessionId");
    expect(Object.keys(body)).toEqual(["stopped"]);
  });

  it("returns 409 with reason no_active_session when no expand session", async () => {
    const em = mockExpandManager({
      stop: vi.fn(async () => ({ status: "no_active_session" as const })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/1/expand",
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("no_active_session");
    expect(body.error).toBe("No active expand session");
  });

  it("returns 409 no_active_session even when other session types are active", async () => {
    // The route only checks expand sessions, not chat/parse-prd/execute
    const em = mockExpandManager({
      stop: vi.fn(async () => ({ status: "no_active_session" as const })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/1/expand",
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("no_active_session");
  });

  it("returns 409 with reason task_mismatch when expand session is for different task", async () => {
    const em = mockExpandManager({
      stop: vi.fn(async () => ({
        status: "task_mismatch" as const,
        activeTaskId: "42",
      })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/tasks/1/expand",
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("task_mismatch");
    expect(body.activeTaskId).toBe("42");
    expect(body.error).toMatch(/task 42/);
    expect(body.error).toMatch(/not 1/);
  });
});

// ============================================================================
// GET /api/expand
// ============================================================================

describe("GET /api/expand", () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app.close();
  });

  it("returns current state, session, and outcome", async () => {
    const em = mockExpandManager({
      getState: vi.fn(() => "active" as ExpandState),
      getSession: vi.fn(() => defaultSession),
      getOutcome: vi.fn(() => null),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "GET",
      url: "/api/expand",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("active");
    expect(body.session).toEqual(defaultSession);
    expect(body.outcome).toBeNull();
  });

  it("returns idle state when no session active", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "GET",
      url: "/api/expand",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("idle");
    expect(body.session).toBeNull();
    expect(body.outcome).toBeNull();
  });
});

// ============================================================================
// Error response shapes
// ============================================================================

describe("error response shapes", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckTasksFile.mockReturnValue({
      hasTasksFile: true,
      hasValidTasks: true,
    });
    mockReadTasksFile.mockReturnValue(DEFAULT_TASKS_DATA);
  });

  afterEach(async () => {
    await app.close();
  });

  it("400 responses have { error, details } shape", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "invalid" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("details");
  });

  it("404 responses have { error, reason } shape", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/999/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("reason");
    expect(body.reason).toBe("task_not_found");
  });

  it("409 responses have { error, reason } shape with optional message", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError(
          "git_not_repo",
          "Cannot expand: not a git repository",
        );
      }),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toHaveProperty("error");
    expect(body).toHaveProperty("reason");
    // Preflight errors also include message
    expect(body).toHaveProperty("message");
  });
});
