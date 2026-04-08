import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { parsePrdRoutes } from "../server/routes/parse-prd.js";
import type {
  ParsePrdManager,
  ParsePrdSession,
  ParsePrdState,
} from "../server/parse-prd-manager.js";
import { ParsePrdSessionActiveError } from "../server/parse-prd-manager.js";

// --- Mock project-state ---

vi.mock("../core/project-state.js", () => ({
  getProjectState: vi.fn(() => ({
    hasPrd: true,
    hasTasksFile: false,
    hasValidTasks: false,
  })),
}));

// Need to import AFTER vi.mock so we can control return values
import { getProjectState } from "../core/project-state.js";
const mockGetProjectState = vi.mocked(getProjectState);

// --- Mock ParsePrdManager ---

function mockParsePrdManager(
  overrides: Partial<ParsePrdManager> = {},
): ParsePrdManager {
  return {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getState: vi.fn((): ParsePrdState => "idle"),
    getSession: vi.fn((): ParsePrdSession | null => null),
    getOutcome: vi.fn(() => null),
    ...overrides,
  } as unknown as ParsePrdManager;
}

const defaultSession: ParsePrdSession = {
  id: "test-parse-prd-session",
  agent: "claude",
  model: undefined,
  variant: undefined,
  state: "active",
};

describe("POST /api/parse-prd", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: PRD exists, no tasks file
    mockGetProjectState.mockReturnValue({
      hasPrd: true,
      hasTasksFile: false,
      hasValidTasks: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 with sessionId on valid start", async () => {
    const pm = mockParsePrdManager({
      start: vi.fn(async () => {}),
      getSession: vi.fn(() => defaultSession),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.started).toBe(true);
    expect(body.sessionId).toBe("test-parse-prd-session");
    expect(pm.start).toHaveBeenCalledWith({
      agent: "claude",
      model: undefined,
      variant: undefined,
      verbosity: "trace",
      userSettings: false,
      applyHooks: false,
    });
  });

  it("passes optional model and variant to manager", async () => {
    const pm = mockParsePrdManager({
      start: vi.fn(async () => {}),
      getSession: vi.fn(() => ({
        ...defaultSession,
        model: "opus",
        variant: "high",
      })),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude", model: "opus", variant: "high" },
    });

    expect(res.statusCode).toBe(200);
    expect(pm.start).toHaveBeenCalledWith({
      agent: "claude",
      model: "opus",
      variant: "high",
      verbosity: "trace",
      userSettings: false,
      applyHooks: false,
    });
  });

  it("returns 400 on invalid body (missing agent)", async () => {
    const pm = mockParsePrdManager();
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { model: "opus" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(pm.start).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid agent type", async () => {
    const pm = mockParsePrdManager();
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "gpt" },
    });

    expect(res.statusCode).toBe(400);
    expect(pm.start).not.toHaveBeenCalled();
  });

  it("returns 400 when body has extra fields (strict schema)", async () => {
    const pm = mockParsePrdManager();
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude", extraField: "unexpected" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(pm.start).not.toHaveBeenCalled();
  });

  it("returns 409 with reason prd_missing when PRD does not exist", async () => {
    mockGetProjectState.mockReturnValue({
      hasPrd: false,
      hasTasksFile: false,
      hasValidTasks: false,
    });
    const pm = mockParsePrdManager();
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("prd_missing");
    expect(body.error).toBe("PRD file is missing or empty");
    expect(pm.start).not.toHaveBeenCalled();
  });

  it("returns 409 with reason tasks_file_exists when tasks.json exists", async () => {
    mockGetProjectState.mockReturnValue({
      hasPrd: true,
      hasTasksFile: true,
      hasValidTasks: true,
    });
    const pm = mockParsePrdManager();
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("tasks_file_exists");
    expect(body.error).toBe("tasks.json already exists");
    expect(pm.start).not.toHaveBeenCalled();
  });

  it("returns 409 with reason active_session when session already active", async () => {
    const pm = mockParsePrdManager({
      start: vi.fn(async () => {
        throw new ParsePrdSessionActiveError(
          "Cannot start parse-prd: session is active",
        );
      }),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(body.message).toBeDefined();
  });

  it("returns 500 on unexpected error", async () => {
    const pm = mockParsePrdManager({
      start: vi.fn(async () => {
        throw new Error("Driver exploded");
      }),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Failed to start parse-prd session");
  });

  it("checks prd_missing before tasks_file_exists (priority order)", async () => {
    // Both conditions are true: no PRD AND tasks file exists
    mockGetProjectState.mockReturnValue({
      hasPrd: false,
      hasTasksFile: true,
      hasValidTasks: true,
    });
    const pm = mockParsePrdManager();
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/parse-prd",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    // prd_missing should be checked first
    expect(res.json().reason).toBe("prd_missing");
  });
});

describe("DELETE /api/parse-prd", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => vi.clearAllMocks());

  afterEach(async () => {
    await app.close();
  });

  it("returns 200 and calls stop() when session is active", async () => {
    const pm = mockParsePrdManager({
      getState: vi.fn(() => "active" as ParsePrdState),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/parse-prd",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true });
    expect(pm.stop).toHaveBeenCalledOnce();
  });

  it("returns 200 when session is stopping", async () => {
    const pm = mockParsePrdManager({
      getState: vi.fn(() => "stopping" as ParsePrdState),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/parse-prd",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true });
    expect(pm.stop).toHaveBeenCalledOnce();
  });

  it("cancel response does not contain false-success fields", async () => {
    // Explicit guard: the DELETE response must clearly indicate cancellation,
    // not success. Verifies no `started`, `success`, or `sessionId` fields
    // that could be mistaken for a successful operation.
    const pm = mockParsePrdManager({
      getState: vi.fn(() => "active" as ParsePrdState),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/parse-prd",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Must contain explicit cancel indicator
    expect(body.stopped).toBe(true);
    // Must NOT contain any success-like fields
    expect(body).not.toHaveProperty("started");
    expect(body).not.toHaveProperty("success");
    expect(body).not.toHaveProperty("sessionId");
    // Exact shape — no extra fields
    expect(Object.keys(body)).toEqual(["stopped"]);
  });

  it("returns 409 with reason no_active_session when idle", async () => {
    const pm = mockParsePrdManager({
      getState: vi.fn(() => "idle" as ParsePrdState),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/parse-prd",
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("no_active_session");
    expect(body.error).toBe("No active parse-prd session");
    expect(pm.stop).not.toHaveBeenCalled();
  });

  it("returns 500 when stop() throws", async () => {
    const pm = mockParsePrdManager({
      getState: vi.fn(() => "active" as ParsePrdState),
      stop: vi.fn(async () => {
        throw new Error("Teardown failed");
      }),
    });
    app = Fastify();
    await app.register(parsePrdRoutes(pm, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/parse-prd",
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("Failed to stop parse-prd session");
    expect(body.message).toBe("Teardown failed");
  });
});
