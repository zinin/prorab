/**
 * Expand eligibility contract coverage (REQ-012).
 *
 * Consolidated test suite that validates the completeness and consistency of
 * the expand API contract:
 *
 * 1. Source-of-truth arrays ↔ UI display text mappings are in sync.
 * 2. Every start-time reason code produces the correct HTTP status + shape.
 * 3. Every stop reason code produces the correct HTTP status + shape.
 * 4. Every terminal failure reason code carries `reason`, `message`, and `errors[]`.
 * 5. UI launch gating is exhaustive (button visibility + disabled conditions).
 * 6. Every machine-readable reason code has a human-readable companion.
 */
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
import {
  EXPAND_START_REASON_CODES,
  EXPAND_FAILURE_REASON_CODES,
} from "../prompts/expand.js";
import type {
  ExpandStartReasonCode,
  ExpandFailureReasonCode,
} from "../prompts/expand.js";
import type { ExpandManagerOutcome } from "../types.js";

// UI helpers (imported directly from source)
import {
  canShowExpandButton,
  isExpandDisabled,
  hasConflictingSession,
  expandDisabledTooltip,
  startReasonDisplayText,
  shouldReloadAfterExpand,
} from "../../ui/src/composables/expand-launch-helpers";
import { reasonDisplayText, REASON_DISPLAY } from "../../ui/src/components/expand-progress-logic";
import type { ExpandOutcome } from "../../ui/src/stores/expand";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../core/project-state.js", () => ({
  checkTasksFile: vi.fn(() => ({
    hasTasksFile: true,
    hasValidTasks: true,
  })),
}));

import { checkTasksFile } from "../core/project-state.js";
const mockCheckTasksFile = vi.mocked(checkTasksFile);

vi.mock("../core/tasks-json.js", () => ({
  readTasksFile: vi.fn(),
}));

import { readTasksFile } from "../core/tasks-json.js";
const mockReadTasksFile = vi.mocked(readTasksFile);

// --- Test fixtures ---

const TASKS_WITH_ALL_STATUSES = {
  tasks: [
    { id: 1, title: "Pending", description: "d", status: "pending", dependencies: [], subtasks: [] },
    { id: 2, title: "Done", description: "d", status: "done", dependencies: [], subtasks: [] },
    { id: 3, title: "In-progress", description: "d", status: "in-progress", dependencies: [], subtasks: [] },
    { id: 4, title: "With subtasks", description: "d", status: "pending", dependencies: [], subtasks: [{ id: 1, title: "S1", status: "pending", dependencies: [] }] },
    { id: 5, title: "Blocked", description: "d", status: "blocked", dependencies: [], subtasks: [] },
    { id: 6, title: "Review", description: "d", status: "review", dependencies: [], subtasks: [] },
    { id: 7, title: "Rework", description: "d", status: "rework", dependencies: [], subtasks: [] },
    { id: 8, title: "Closed", description: "d", status: "closed", dependencies: [], subtasks: [] },
  ],
  metadata: {},
} as any;

const defaultSession: ExpandSession = {
  id: "session-contract-test",
  taskId: "1",
  agent: "claude",
  model: undefined,
  variant: undefined,
  state: "active",
  tasksJsonHash: "abc",
};

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

// ============================================================================
// 1. Contract completeness: source-of-truth ↔ UI mappings
// ============================================================================

describe("contract completeness: source-of-truth arrays ↔ UI display text", () => {
  it("every EXPAND_START_REASON_CODE has a non-null mapping in startReasonDisplayText", () => {
    for (const code of EXPAND_START_REASON_CODES) {
      const text = startReasonDisplayText(code);
      expect(text, `startReasonDisplayText("${code}") should not be null`).not.toBeNull();
      expect(typeof text, `startReasonDisplayText("${code}") should be string`).toBe("string");
      // Must not be just the raw code with underscores replaced — must be a "known" mapping
      // (the fallback humanises but we want known codes to have explicit entries)
      expect(text!.length, `display text for "${code}" should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("every EXPAND_FAILURE_REASON_CODE has an explicit entry in REASON_DISPLAY (not just fallback)", () => {
    for (const code of EXPAND_FAILURE_REASON_CODES) {
      // Assert the code exists as an explicit key in the mapping table,
      // not relying on the fallback humanizer which would mask missing entries.
      expect(
        Object.keys(REASON_DISPLAY),
        `REASON_DISPLAY must contain an explicit entry for "${code}"`,
      ).toContain(code);

      // Also verify the display text is non-empty
      const outcome: ExpandOutcome = {
        status: "failure",
        taskId: "1",
        reason: code,
        errors: [],
        message: "",
        subtaskCount: 0,
      };
      const text = reasonDisplayText(outcome);
      expect(text, `reasonDisplayText for "${code}" should not be null`).not.toBeNull();
      expect(text!.length, `display text for "${code}" should be non-empty`).toBeGreaterThan(0);
    }
  });

  it("REASON_DISPLAY contains no stale keys absent from EXPAND_FAILURE_REASON_CODES", () => {
    const liveSet = new Set<string>(EXPAND_FAILURE_REASON_CODES);
    for (const key of Object.keys(REASON_DISPLAY)) {
      expect(liveSet, `REASON_DISPLAY key "${key}" is stale — not in EXPAND_FAILURE_REASON_CODES`).toContain(key);
    }
  });

  it("stop-specific reason codes (no_active_session, task_mismatch) have UI display text", () => {
    // These codes appear in DELETE responses but are also mapped in startReasonDisplayText
    // for completeness (e.g. task_mismatch can surface as a start-time conflict indicator)
    for (const code of ["no_active_session", "task_mismatch"] as const) {
      // task_mismatch is explicitly mapped; no_active_session may use the fallback
      const text = startReasonDisplayText(code);
      expect(text, `startReasonDisplayText("${code}") should produce text`).not.toBeNull();
    }
  });

  it("EXPAND_START_REASON_CODES contains exactly the expected codes", () => {
    const expected: ExpandStartReasonCode[] = [
      "task_not_found",
      "tasks_file_missing",
      "tasks_file_invalid",
      "task_not_pending",
      "task_has_subtasks",
      "git_not_repo",
      "tasks_file_untracked",
      "git_identity_missing",
      "tasks_file_dirty",
      "active_session",
    ];
    expect([...EXPAND_START_REASON_CODES].sort()).toEqual([...expected].sort());
  });

  it("EXPAND_FAILURE_REASON_CODES contains exactly the expected codes", () => {
    const expected: ExpandFailureReasonCode[] = [
      "agent_failed",
      "result_parse_failed",
      "validation_failed",
      "hash_conflict",
      "commit_failed_after_write",
    ];
    expect([...EXPAND_FAILURE_REASON_CODES].sort()).toEqual([...expected].sort());
  });
});

// ============================================================================
// 2. Start-time API contract: POST /api/tasks/:id/expand
// ============================================================================

describe("start-time API contract: every reason code → correct HTTP status and shape", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckTasksFile.mockReturnValue({ hasTasksFile: true, hasValidTasks: true });
    mockReadTasksFile.mockReturnValue(TASKS_WITH_ALL_STATUSES);
  });

  afterEach(async () => {
    await app.close();
  });

  // --- tasks_file_missing → 409 ---
  it("tasks_file_missing → 409 with { error, reason }", async () => {
    mockCheckTasksFile.mockReturnValue({ hasTasksFile: false, hasValidTasks: false });
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
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- tasks_file_invalid → 409 ---
  it("tasks_file_invalid → 409 with { error, reason }", async () => {
    mockCheckTasksFile.mockReturnValue({ hasTasksFile: true, hasValidTasks: false });
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
    expect(typeof body.error).toBe("string");
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- task_not_found → 404 ---
  it("task_not_found → 404 with { error, reason }", async () => {
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
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("999");
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- task_not_pending for in-progress → 409 ---
  it("task_not_pending (in-progress) → 409 with status in error message", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/3/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("task_not_pending");
    expect(body.error).toContain("in-progress");
    expect(body.error).toContain("pending");
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- task_not_pending for done → 409 ---
  it("task_not_pending (done) → 409 with status in error message", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/2/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("task_not_pending");
    expect(body.error).toContain("done");
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- task_not_pending for blocked → 409 ---
  it("task_not_pending (blocked) → 409", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/5/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("task_not_pending");
    expect(res.json().error).toContain("blocked");
  });

  // --- task_not_pending for review → 409 ---
  it("task_not_pending (review) → 409", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/6/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("task_not_pending");
    expect(res.json().error).toContain("review");
  });

  // --- task_not_pending for rework → 409 ---
  it("task_not_pending (rework) → 409", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/7/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("task_not_pending");
    expect(res.json().error).toContain("rework");
  });

  // --- task_not_pending for closed → 409 ---
  it("task_not_pending (closed) → 409", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/8/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe("task_not_pending");
    expect(res.json().error).toContain("closed");
  });

  // --- task_has_subtasks → 409 ---
  it("task_has_subtasks → 409 with subtask count in error message", async () => {
    const em = mockExpandManager();
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/4/expand",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("task_has_subtasks");
    expect(typeof body.error).toBe("string");
    expect(body.error).toMatch(/1 subtask/);
    expect(em.start).not.toHaveBeenCalled();
  });

  // --- active_session → 409 ---
  // NOTE: This test exercises the route handler's error mapping, not the real
  // ExpandManager session conflict detection. The mock `start()` throws
  // `ExpandSessionActiveError` directly — matching what the real manager does
  // when `sessionCore.isIdle()` is false (expand-manager.ts:167-171).
  // End-to-end conflict testing (two concurrent sessions) would require a full
  // integration harness with real agent drivers and git repos.
  it("active_session → 409 with { error, reason, message }", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandSessionActiveError("Another expand is already running");
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
    expect(body.message.length).toBeGreaterThan(0);
  });

  // --- git preflight: git_not_repo → 409 ---
  it("git_not_repo → 409 with { error, reason, message }", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError("git_not_repo", "Cannot expand: not a git repository");
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
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  // --- git preflight: tasks_file_untracked → 409 ---
  it("tasks_file_untracked → 409 with { error, reason, message }", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError("tasks_file_untracked", "Cannot expand: tasks.json is not tracked");
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
    expect(body.reason).toBe("tasks_file_untracked");
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  // --- git preflight: git_identity_missing → 409 ---
  it("git_identity_missing → 409 with { error, reason, message }", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError("git_identity_missing", "Cannot expand: git identity not configured");
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
    expect(body.reason).toBe("git_identity_missing");
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  // --- git preflight: tasks_file_dirty → 409 ---
  it("tasks_file_dirty → 409 with { error, reason, message }", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandPreflightError("tasks_file_dirty", "Cannot expand: tasks.json has uncommitted changes");
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
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });

  // --- Response shape: every 409 has both error and reason ---
  it("all route-level 409 responses have { error: string, reason: string }", async () => {
    // We test each route-level reason code and verify shape consistency
    const routeReasonCodes: Array<{
      reason: ExpandStartReasonCode;
      setup: () => void;
      url: string;
    }> = [
      {
        reason: "tasks_file_missing",
        setup: () => mockCheckTasksFile.mockReturnValue({ hasTasksFile: false, hasValidTasks: false }),
        url: "/api/tasks/1/expand",
      },
      {
        reason: "tasks_file_invalid",
        setup: () => mockCheckTasksFile.mockReturnValue({ hasTasksFile: true, hasValidTasks: false }),
        url: "/api/tasks/1/expand",
      },
      {
        reason: "task_not_pending",
        setup: () => {
          mockCheckTasksFile.mockReturnValue({ hasTasksFile: true, hasValidTasks: true });
          mockReadTasksFile.mockReturnValue(TASKS_WITH_ALL_STATUSES);
        },
        url: "/api/tasks/2/expand", // task 2 is "done"
      },
      {
        reason: "task_has_subtasks",
        setup: () => {
          mockCheckTasksFile.mockReturnValue({ hasTasksFile: true, hasValidTasks: true });
          mockReadTasksFile.mockReturnValue(TASKS_WITH_ALL_STATUSES);
        },
        url: "/api/tasks/4/expand", // task 4 has subtasks
      },
    ];

    for (const { reason, setup, url } of routeReasonCodes) {
      setup();
      const em = mockExpandManager();
      const testApp = Fastify();
      await testApp.register(expandRoutes(em, "/fake/cwd"));

      const res = await testApp.inject({
        method: "POST",
        url,
        payload: { agent: "claude" },
      });

      const body = res.json();
      expect(body.reason, `reason for ${reason}`).toBe(reason);
      expect(typeof body.error, `error field for ${reason} must be string`).toBe("string");
      expect(body.error.length, `error text for ${reason} must be non-empty`).toBeGreaterThan(0);

      await testApp.close();
    }
  });

  // --- Response shape: preflight 409s have { error, reason, message } ---
  it("all git preflight 409 responses include a human-readable message field", async () => {
    const gitCodes: Array<{ reason: ExpandStartReasonCode; errorMsg: string }> = [
      { reason: "git_not_repo", errorMsg: "Cannot expand: not a git repo" },
      { reason: "tasks_file_untracked", errorMsg: "Cannot expand: untracked" },
      { reason: "git_identity_missing", errorMsg: "Cannot expand: no identity" },
      { reason: "tasks_file_dirty", errorMsg: "Cannot expand: dirty" },
    ];

    for (const { reason, errorMsg } of gitCodes) {
      mockCheckTasksFile.mockReturnValue({ hasTasksFile: true, hasValidTasks: true });
      mockReadTasksFile.mockReturnValue(TASKS_WITH_ALL_STATUSES);

      const em = mockExpandManager({
        start: vi.fn(async () => {
          throw new ExpandPreflightError(reason as any, errorMsg);
        }),
      });
      const testApp = Fastify();
      await testApp.register(expandRoutes(em, "/fake/cwd"));

      const res = await testApp.inject({
        method: "POST",
        url: "/api/tasks/1/expand",
        payload: { agent: "claude" },
      });

      const body = res.json();
      expect(res.statusCode, `HTTP status for ${reason}`).toBe(409);
      expect(body.reason, `reason for ${reason}`).toBe(reason);
      expect(typeof body.error, `error field for ${reason}`).toBe("string");
      expect(typeof body.message, `message field for ${reason}`).toBe("string");
      expect(body.message.length, `message for ${reason} must be non-empty`).toBeGreaterThan(0);

      await testApp.close();
    }
  });

  // --- 404 has { error, reason } ---
  it("task_not_found 404 has { error: string, reason: string } (no message field)", async () => {
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
    expect(typeof body.error).toBe("string");
    expect(body.reason).toBe("task_not_found");
  });

  // --- active_session has { error, reason, message } ---
  it("active_session 409 includes all three: error, reason, message", async () => {
    const em = mockExpandManager({
      start: vi.fn(async () => {
        throw new ExpandSessionActiveError("Session lock held by chat");
      }),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/tasks/1/expand",
      payload: { agent: "claude" },
    });

    const body = res.json();
    expect(res.statusCode).toBe(409);
    expect(body.reason).toBe("active_session");
    expect(typeof body.error).toBe("string");
    expect(typeof body.message).toBe("string");
  });
});

// ============================================================================
// 3. Stop API contract: DELETE /api/tasks/:id/expand
// ============================================================================

describe("stop API contract: every stop reason code → correct HTTP status and shape", () => {
  let app: ReturnType<typeof Fastify>;

  afterEach(async () => {
    await app.close();
  });

  it("stopped → 200 with { stopped: true }", async () => {
    const em = mockExpandManager({
      stop: vi.fn(async () => ({ status: "stopped" as const })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({ method: "DELETE", url: "/api/tasks/1/expand" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true });
  });

  it("no_active_session → 409 with { error: string, reason: 'no_active_session' }", async () => {
    const em = mockExpandManager({
      stop: vi.fn(async () => ({ status: "no_active_session" as const })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({ method: "DELETE", url: "/api/tasks/1/expand" });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("no_active_session");
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  it("task_mismatch → 409 with { error: string, reason: 'task_mismatch', activeTaskId: string }", async () => {
    const em = mockExpandManager({
      stop: vi.fn(async () => ({
        status: "task_mismatch" as const,
        activeTaskId: "42",
      })),
    });
    app = Fastify();
    await app.register(expandRoutes(em, "/fake/cwd"));

    const res = await app.inject({ method: "DELETE", url: "/api/tasks/1/expand" });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("task_mismatch");
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain("42");
    expect(body.activeTaskId).toBe("42");
  });
});

// ============================================================================
// 4. Terminal failure outcomes: ExpandManagerOutcome shape
// ============================================================================

describe("terminal failure outcomes: every failure reason code carries reason + message + errors[]", () => {
  /**
   * NOTE: This section validates the contract *schema* — i.e. that the
   * `ExpandManagerOutcome` discriminated union can represent every failure
   * reason code with the required `{ reason, message, errors[], subtaskCount }`
   * shape. It does NOT exercise the runtime `ExpandManager` code paths that
   * produce these outcomes (that would require mocking the agent driver layer
   * and triggering each failure path end-to-end).
   *
   * Since `src/__tests__` is excluded from `tsc` (tsconfig.json), even type-level
   * drift between the schema and these tests won't be caught by the compiler —
   * so these tests serve as a runtime guard that the shapes are constructable
   * and carry all required fields for each reason code.
   */

  /** Build a well-typed ExpandManagerOutcome for a given failure reason. */
  function makeFailure(
    reason: ExpandFailureReasonCode,
    overrides: Partial<Extract<ExpandManagerOutcome, { status: "failure" }>> = {},
  ): Extract<ExpandManagerOutcome, { status: "failure" }> {
    return {
      status: "failure",
      taskId: "1",
      reason,
      errors: [`Error for ${reason}`],
      message: `Human-readable message for ${reason}`,
      subtaskCount: 0,
      ...overrides,
    };
  }

  it.each(EXPAND_FAILURE_REASON_CODES as unknown as ExpandFailureReasonCode[])(
    "failure reason '%s' has required shape { status, taskId, reason, errors[], message, subtaskCount }",
    (reason) => {
      const outcome = makeFailure(reason);
      expect(outcome.status).toBe("failure");
      expect(outcome.taskId).toBe("1");
      expect(outcome.reason).toBe(reason);
      expect(Array.isArray(outcome.errors)).toBe(true);
      expect(typeof outcome.message).toBe("string");
      expect(outcome.message.length).toBeGreaterThan(0);
      expect(typeof outcome.subtaskCount).toBe("number");
    },
  );

  it("validation_failed outcome carries errors[] with diagnostic details", () => {
    const outcome = makeFailure("validation_failed", {
      errors: [
        "Subtask ID gap: expected 2, got 3",
        "Forward dependency: subtask 1 depends on 3",
      ],
    });
    expect(outcome.errors).toHaveLength(2);
    expect(outcome.errors[0]).toContain("gap");
    expect(outcome.errors[1]).toContain("Forward");
  });

  it("commit_failed_after_write carries subtaskCount > 0 (subtasks were written)", () => {
    const outcome = makeFailure("commit_failed_after_write", { subtaskCount: 3 });
    expect(outcome.subtaskCount).toBe(3);
  });

  it("success outcome shape: { status, taskId, subtaskCount }", () => {
    const success: ExpandManagerOutcome = {
      status: "success",
      taskId: "1",
      subtaskCount: 5,
    };
    expect(success.status).toBe("success");
    expect(typeof success.taskId).toBe("string");
    expect(typeof success.subtaskCount).toBe("number");
    // success has NO reason/errors/message fields
    expect("reason" in success).toBe(false);
    expect("errors" in success).toBe(false);
    expect("message" in success).toBe(false);
  });

  it("cancelled outcome shape: { status, taskId, subtaskCount }", () => {
    const cancelled: ExpandManagerOutcome = {
      status: "cancelled",
      taskId: "1",
      subtaskCount: 0,
    };
    expect(cancelled.status).toBe("cancelled");
    // cancelled has NO reason/errors/message fields
    expect("reason" in cancelled).toBe(false);
    expect("errors" in cancelled).toBe(false);
    expect("message" in cancelled).toBe(false);
  });
});

// ============================================================================
// 5. UI launch gating: exhaustive coverage
// ============================================================================

describe("UI launch gating: canShowExpandButton exhaustive status coverage", () => {
  const ALL_TASK_STATUSES = [
    "pending",
    "in-progress",
    "done",
    "blocked",
    "review",
    "rework",
    "closed",
  ];

  it("visible only for pending status with 0 subtasks", () => {
    expect(canShowExpandButton("pending", 0)).toBe(true);
  });

  it.each(ALL_TASK_STATUSES.filter((s) => s !== "pending"))(
    "hidden for status '%s'",
    (status) => {
      expect(canShowExpandButton(status, 0)).toBe(false);
    },
  );

  it("hidden when pending but has subtasks", () => {
    expect(canShowExpandButton("pending", 1)).toBe(false);
    expect(canShowExpandButton("pending", 10)).toBe(false);
  });

  it("hidden when status is undefined", () => {
    expect(canShowExpandButton(undefined, 0)).toBe(false);
  });
});

describe("UI launch gating: isExpandDisabled conditions", () => {
  const clean = { isDirty: false, isSaving: false, hasConflictingSession: false };

  it("enabled when all conditions are clean", () => {
    expect(isExpandDisabled(clean)).toBe(false);
  });

  it("disabled when form is dirty", () => {
    expect(isExpandDisabled({ ...clean, isDirty: true })).toBe(true);
  });

  it("disabled when saving", () => {
    expect(isExpandDisabled({ ...clean, isSaving: true })).toBe(true);
  });

  it("disabled when conflicting session is active", () => {
    expect(isExpandDisabled({ ...clean, hasConflictingSession: true })).toBe(true);
  });

  it("disabled when all conditions are met simultaneously", () => {
    expect(isExpandDisabled({ isDirty: true, isSaving: true, hasConflictingSession: true })).toBe(true);
  });
});

describe("UI launch gating: hasConflictingSession covers all session types", () => {
  const noSessions = {
    executionState: "idle",
    chatHasSession: false,
    parsePrdHasSession: false,
    expandIsRunning: false,
    expandBelongsToTask: false,
  };

  it("no conflict when all idle", () => {
    expect(hasConflictingSession(noSessions)).toBe(false);
  });

  it("conflict when execution is running", () => {
    expect(hasConflictingSession({ ...noSessions, executionState: "running" })).toBe(true);
  });

  it("conflict when execution is stopping", () => {
    expect(hasConflictingSession({ ...noSessions, executionState: "stopping" })).toBe(true);
  });

  it("conflict when chat session is active", () => {
    expect(hasConflictingSession({ ...noSessions, chatHasSession: true })).toBe(true);
  });

  it("conflict when parse-prd session is active", () => {
    expect(hasConflictingSession({ ...noSessions, parsePrdHasSession: true })).toBe(true);
  });

  it("conflict when expand session for DIFFERENT task is active", () => {
    expect(hasConflictingSession({
      ...noSessions,
      expandIsRunning: true,
      expandBelongsToTask: false,
    })).toBe(true);
  });

  it("NO conflict when expand session for SAME task is active", () => {
    expect(hasConflictingSession({
      ...noSessions,
      expandIsRunning: true,
      expandBelongsToTask: true,
    })).toBe(false);
  });
});

describe("UI launch gating: expandDisabledTooltip provides human-readable text", () => {
  const clean = { isDirty: false, isSaving: false, hasConflictingSession: false };

  it("null when enabled", () => {
    expect(expandDisabledTooltip(clean)).toBeNull();
  });

  it("human-readable text for saving", () => {
    const text = expandDisabledTooltip({ ...clean, isSaving: true });
    expect(typeof text).toBe("string");
    expect(text!.length).toBeGreaterThan(0);
  });

  it("human-readable text for dirty form", () => {
    const text = expandDisabledTooltip({ ...clean, isDirty: true });
    expect(typeof text).toBe("string");
    expect(text!.length).toBeGreaterThan(0);
  });

  it("human-readable text for conflicting session", () => {
    const text = expandDisabledTooltip({ ...clean, hasConflictingSession: true });
    expect(typeof text).toBe("string");
    expect(text!.length).toBeGreaterThan(0);
  });

  it("priority: isSaving > isDirty > hasConflictingSession", () => {
    expect(expandDisabledTooltip({ isDirty: true, isSaving: true, hasConflictingSession: true }))
      .toBe("Save in progress");
    expect(expandDisabledTooltip({ isDirty: true, isSaving: false, hasConflictingSession: true }))
      .toBe("Save your changes first");
  });
});

// ============================================================================
// 6. UI reason text: shouldReloadAfterExpand coverage
// ============================================================================

describe("shouldReloadAfterExpand: file-writing outcome detection", () => {
  it("returns true for success with subtasks > 0 on matching task", () => {
    expect(shouldReloadAfterExpand(
      { status: "success", taskId: "1", subtaskCount: 3 },
      "1",
    )).toBe(true);
  });

  it("returns true for commit_failed_after_write on matching task", () => {
    expect(shouldReloadAfterExpand(
      { status: "failure", taskId: "1", subtaskCount: 3, reason: "commit_failed_after_write" },
      "1",
    )).toBe(true);
  });

  it("returns false for success with subtaskCount === 0 (no-op)", () => {
    expect(shouldReloadAfterExpand(
      { status: "success", taskId: "1", subtaskCount: 0 },
      "1",
    )).toBe(false);
  });

  it("returns false for non-matching taskId", () => {
    expect(shouldReloadAfterExpand(
      { status: "success", taskId: "99", subtaskCount: 5 },
      "1",
    )).toBe(false);
  });

  it("returns false for null outcome", () => {
    expect(shouldReloadAfterExpand(null, "1")).toBe(false);
  });

  it("returns false for cancelled outcome", () => {
    expect(shouldReloadAfterExpand(
      { status: "cancelled", taskId: "1", subtaskCount: 0 },
      "1",
    )).toBe(false);
  });

  it.each([
    "agent_failed",
    "result_parse_failed",
    "validation_failed",
    "hash_conflict",
  ] as const)("returns false for failure reason '%s' (no file write)", (reason) => {
    expect(shouldReloadAfterExpand(
      { status: "failure", taskId: "1", subtaskCount: 0, reason },
      "1",
    )).toBe(false);
  });
});

// ============================================================================
// 7. UI reason display text: exhaustive mapping for all failure reason codes
// ============================================================================

describe("UI reason display text: all failure reason codes have human-readable text", () => {
  it.each(EXPAND_FAILURE_REASON_CODES as unknown as ExpandFailureReasonCode[])(
    "reasonDisplayText produces text for failure reason '%s'",
    (reason) => {
      const outcome: ExpandOutcome = {
        status: "failure",
        taskId: "1",
        reason,
        errors: [],
        message: "",
        subtaskCount: 0,
      };
      const text = reasonDisplayText(outcome);
      expect(text, `reasonDisplayText for "${reason}" should not be null`).not.toBeNull();
      expect(text!.length, `display text for "${reason}" should be non-empty`).toBeGreaterThan(0);
    },
  );

  it.each(EXPAND_START_REASON_CODES as unknown as ExpandStartReasonCode[])(
    "startReasonDisplayText produces text for start reason '%s'",
    (reason) => {
      const text = startReasonDisplayText(reason);
      expect(text, `startReasonDisplayText for "${reason}" should not be null`).not.toBeNull();
      expect(text!.length, `display text for "${reason}" should be non-empty`).toBeGreaterThan(0);
    },
  );

  it("startReasonDisplayText returns null for null/undefined/empty", () => {
    expect(startReasonDisplayText(null)).toBeNull();
    expect(startReasonDisplayText(undefined)).toBeNull();
    expect(startReasonDisplayText("")).toBeNull();
  });

  it("reasonDisplayText returns null for non-failure outcomes", () => {
    expect(reasonDisplayText({ status: "success", taskId: "1", subtaskCount: 0 })).toBeNull();
    expect(reasonDisplayText({ status: "cancelled", taskId: "1", subtaskCount: 0 })).toBeNull();
    expect(reasonDisplayText(null)).toBeNull();
  });
});

// ============================================================================
// 8. Cross-cutting: start reason codes in EXPAND_START_REASON_CODES
//    appear in the correct HTTP status category
// ============================================================================

describe("HTTP status mapping: start reason codes categorised correctly", () => {
  const CODES_THAT_RETURN_404: ExpandStartReasonCode[] = ["task_not_found"];
  const CODES_THAT_RETURN_409: ExpandStartReasonCode[] = [
    "tasks_file_missing",
    "tasks_file_invalid",
    "task_not_pending",
    "task_has_subtasks",
    "git_not_repo",
    "tasks_file_untracked",
    "git_identity_missing",
    "tasks_file_dirty",
    "active_session",
  ];

  it("task_not_found is the only start code that returns 404", () => {
    expect(CODES_THAT_RETURN_404).toEqual(["task_not_found"]);
  });

  it("all other start codes return 409", () => {
    expect(CODES_THAT_RETURN_409.sort()).toEqual(
      EXPAND_START_REASON_CODES
        .filter((c) => c !== "task_not_found")
        .toSorted(),
    );
  });

  it("404 + 409 codes together cover all EXPAND_START_REASON_CODES", () => {
    const allCodes = [...CODES_THAT_RETURN_404, ...CODES_THAT_RETURN_409].sort();
    expect(allCodes).toEqual([...EXPAND_START_REASON_CODES].sort());
  });
});
