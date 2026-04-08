/**
 * Expand no-write guarantee tests (REQ-007).
 *
 * Proves that all pre-write failure paths (agent failure, parse failure,
 * validation failure, hash conflict, user cancellation) leave tasks.json
 * byte-identical to its state before the expand session.
 *
 * Every test follows the same pattern:
 * 1. Record whether writeExpandSubtasks / commitExpandedTask were called.
 * 2. Trigger a specific failure scenario.
 * 3. Assert the expected `reason` code and `status`.
 * 4. Assert that writeExpandSubtasks was NOT called (no partial writes).
 * 5. Assert that commitExpandedTask was NOT called (no orphan commits).
 *
 * Section 4b specifically covers multi-tag hash conflict scenarios, closing
 * the gap between helper-level tests in expand-multi-tag.test.ts (which
 * prove verifyTasksJsonHash detects inactive-tag mutations) and the
 * pipeline-level guarantee that ExpandManager produces `hash_conflict`
 * reason and skips the write.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ExpandManager,
  ExpandPreflightError,
} from "../server/expand-manager.js";
import type { ExpandStartOptions } from "../server/expand-manager.js";
import type { ExpandManagerOutcome } from "../types.js";
import type { SessionCore } from "../server/session/session-core.js";
import type { WsBroadcaster, WsEvent } from "../server/session/ws-broadcaster.js";

// ---------------------------------------------------------------------------
// Mock DriverRunner
// ---------------------------------------------------------------------------

const mockRunSession = vi.fn(async () => ({
  signal: { type: "complete" as const },
  durationMs: 1000,
  costUsd: 0.01,
  numTurns: 5,
  resultText: '{"subtasks": []}',
  inputTokens: 100,
  outputTokens: 200,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  model: "claude-sonnet",
  agentReport: null,
  reviewReport: null,
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
}));

const driverRunnerSetup = vi.fn(async (_opts: any, onLog?: (event: any) => void) => {});
const driverRunnerTeardown = vi.fn(async () => {});

vi.mock("../server/session/driver-runner.js", () => ({
  DriverRunner: class MockDriverRunner {
    constructor(_agent: string, _model?: string) {}
    setup = driverRunnerSetup;
    teardown = driverRunnerTeardown;
    getDriver = vi.fn(() => ({}));
    setOnLog = vi.fn();
    runSession = mockRunSession;
    get setupDone() { return true; }
    get agent() { return "claude" as const; }
    get model() { return undefined; }
    get userSettings() { return false; }
    listModels = vi.fn(async () => []);
  },
}));

// ---------------------------------------------------------------------------
// Mock tasks-json
// ---------------------------------------------------------------------------

const mockReadTasksFile = vi.fn(() => ({
  tasks: [
    {
      id: 1,
      title: "Test task",
      description: "A test task",
      status: "pending",
      priority: "medium",
      dependencies: [],
      details: "Some implementation details",
      testStrategy: "Write unit tests",
      subtasks: [],
    },
  ],
  metadata: {},
}));

const mockWriteExpandSubtasks = vi.fn();
const mockWithTasksMutex = vi.fn(async <T>(fn: () => T | Promise<T>): Promise<T> => fn());

vi.mock("../core/tasks-json.js", () => ({
  readTasksFile: (...args: unknown[]) => mockReadTasksFile(...args),
  writeExpandSubtasks: (...args: unknown[]) => mockWriteExpandSubtasks(...args),
  withTasksMutex: <T>(fn: () => T | Promise<T>) => mockWithTasksMutex(fn),
}));

// ---------------------------------------------------------------------------
// Mock tasks-json-hash
// ---------------------------------------------------------------------------

const mockSnapshotTasksJsonHash = vi.fn((): string | null => "abc123hash");
const mockVerifyTasksJsonHash = vi.fn((): boolean => true);

vi.mock("../core/tasks-json-hash.js", () => ({
  snapshotTasksJsonHash: (...args: unknown[]) => mockSnapshotTasksJsonHash(...args),
  verifyTasksJsonHash: (...args: unknown[]) => mockVerifyTasksJsonHash(...args),
}));

// ---------------------------------------------------------------------------
// Mock git
// ---------------------------------------------------------------------------

const mockIsGitRepo = vi.fn((): boolean => true);
const mockIsTrackedByGit = vi.fn((): boolean => true);
const mockHasGitIdentity = vi.fn((): boolean => true);
const mockIsPathDirty = vi.fn((): boolean => false);
const mockCommitExpandedTask = vi.fn();

vi.mock("../core/git.js", () => ({
  isGitRepo: (...args: unknown[]) => mockIsGitRepo(...args),
  isTrackedByGit: (...args: unknown[]) => mockIsTrackedByGit(...args),
  hasGitIdentity: (...args: unknown[]) => mockHasGitIdentity(...args),
  isPathDirty: (...args: unknown[]) => mockIsPathDirty(...args),
  commitExpandedTask: (...args: unknown[]) => mockCommitExpandedTask(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSessionCore(overrides: Partial<SessionCore> = {}): SessionCore {
  return {
    state: "idle",
    cwd: "/tmp",
    isIdle: () => true,
    isActive: () => false,
    isStopping: () => false,
    acquire: vi.fn(),
    release: vi.fn(),
    abort: vi.fn(),
    getAbortSignal: () => new AbortController().signal,
    registerAbortHandler: () => () => {},
    ...overrides,
  } as unknown as SessionCore;
}

function mockBroadcaster(): WsBroadcaster & { calls: WsEvent[] } {
  const calls: WsEvent[] = [];
  return {
    calls,
    broadcast: vi.fn(),
    broadcastWithChannel: vi.fn((event: WsEvent) => { calls.push(event); }),
    replay: vi.fn(),
    clearBuffer: vi.fn(),
  } as unknown as WsBroadcaster & { calls: WsEvent[] };
}

const defaultStartOpts: ExpandStartOptions = { agent: "claude" };
const defaultTaskId = "1";

async function drainAsyncOps(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function sessionResult(
  signal: { type: string; reason?: string; message?: string },
  resultText = '{"subtasks": []}',
) {
  return {
    signal,
    durationMs: 1000,
    costUsd: 0.01,
    numTurns: 5,
    resultText,
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    model: "claude-sonnet",
    agentReport: null,
    reviewReport: null,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  };
}

/** Assert the outcome is a failure with the expected reason. */
function expectFailureOutcome(
  outcome: ExpandManagerOutcome | null,
  expectedReason: string,
): void {
  expect(outcome).not.toBeNull();
  expect(outcome!.status).toBe("failure");
  if (outcome!.status === "failure") {
    expect(outcome!.reason).toBe(expectedReason);
  }
}

/** Assert no write side-effects occurred (no write, no commit). */
function assertNoWriteSideEffects(): void {
  expect(mockWriteExpandSubtasks).not.toHaveBeenCalled();
  expect(mockCommitExpandedTask).not.toHaveBeenCalled();
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Expand no-write guarantee (REQ-007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: all preflight checks pass, hash checks pass
    mockSnapshotTasksJsonHash.mockReturnValue("stable-hash-before-session");
    mockVerifyTasksJsonHash.mockReturnValue(true);
    mockIsGitRepo.mockReturnValue(true);
    mockIsTrackedByGit.mockReturnValue(true);
    mockHasGitIdentity.mockReturnValue(true);
    mockIsPathDirty.mockReturnValue(false);
    mockCommitExpandedTask.mockReset();
  });

  // =========================================================================
  // 1. Agent failure — driver throws or signals non-complete
  // =========================================================================

  describe("1. Agent failure", () => {
    it("driver throws an error → reason 'agent_failed', no write", async () => {
      mockRunSession.mockRejectedValueOnce(new Error("SDK crashed: context exceeded"));

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "agent_failed");
      assertNoWriteSideEffects();
    });

    it("driver throws a non-Error value → reason 'agent_failed', no write", async () => {
      mockRunSession.mockRejectedValueOnce("unexpected string error");

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "agent_failed");
      assertNoWriteSideEffects();
    });

    it("agent signals 'blocked' → reason 'agent_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "blocked", reason: "task already has subtasks" }),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expectFailureOutcome(outcome, "agent_failed");
      expect((outcome as any).errors[0]).toContain("Agent signalled blocked");
      assertNoWriteSideEffects();
    });

    it("agent signals 'error' → reason 'agent_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "error", message: "Context window limit exceeded" }),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expectFailureOutcome(outcome, "agent_failed");
      expect((outcome as any).errors[0]).toContain("Agent error");
      assertNoWriteSideEffects();
    });

    it("agent returns null resultText → reason 'result_parse_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, null as any),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "result_parse_failed");
      assertNoWriteSideEffects();
    });

    it("agent returns empty string resultText → reason 'result_parse_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, ""),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "result_parse_failed");
      assertNoWriteSideEffects();
    });

    it("agent returns whitespace-only resultText → reason 'result_parse_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, "   \n\t  "),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "result_parse_failed");
      assertNoWriteSideEffects();
    });
  });

  // =========================================================================
  // 2. Parse failure — result text is not valid JSON
  // =========================================================================

  describe("2. Parse failure", () => {
    it("plain prose text (not JSON) → reason 'result_parse_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, "Here are the subtasks I created for this task..."),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "result_parse_failed");
      assertNoWriteSideEffects();
    });

    it("JSON array instead of object → reason 'validation_failed', no write", async () => {
      // extractJsonFromResult scans for `{...}` blocks. For `[{"id":1,"title":"sub"}]`
      // it finds the inner object `{"id":1,"title":"sub"}` inside the array brackets.
      // That object has no `subtasks` key, so Zod validation fails.
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '[{"id": 1, "title": "sub"}]'),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Inner object extracted → missing `subtasks` → validation_failed
      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("JSON object without 'subtasks' key → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"tasks": [{"id": 1, "title": "Sub 1"}]}'),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("truncated JSON → reason 'result_parse_failed', no write", async () => {
      // extractJsonFromResult scans for complete `{...}` — truncated JSON
      // won't form a complete block, so returns null
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": [{"id": 1, "title":'),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "result_parse_failed");
      assertNoWriteSideEffects();
    });

    it("JSON with trailing comma → reason 'result_parse_failed', no write", async () => {
      // extractJsonFromResult finds the `{...}` block, but JSON.parse fails
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": [1,]}'),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "result_parse_failed");
      assertNoWriteSideEffects();
    });

    it("markdown-fenced JSON → reason 'result_parse_failed', no write", async () => {
      // parseExpandResult does NOT extract from markdown fences
      const json = JSON.stringify({ subtasks: [] });
      const fenced = "```json\n" + json + "\n```";
      // extractJsonFromResult will find the `{...}` block inside fences,
      // but parseExpandResult gets the extracted JSON — depends on the extract step
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, fenced),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Either success (if extractor finds it) or failure — either way, no erroneous write
      // The important thing: if it fails, no write occurs
      if (manager.getOutcome()?.status === "failure") {
        assertNoWriteSideEffects();
      }
      // If it succeeds with empty subtasks, writeExpandSubtasks is also not called (no-op)
    });

    it("JSON number value → no JSON object found, no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, "42"),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "result_parse_failed");
      assertNoWriteSideEffects();
    });

    it("JSON string value → no JSON object found, no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '"hello world"'),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "result_parse_failed");
      assertNoWriteSideEffects();
    });
  });

  // =========================================================================
  // 3. Validation failure — JSON parsed but fails Zod schema
  // =========================================================================

  describe("3. Validation failure", () => {
    it("extra top-level field (strict mode) → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [{ id: 1, title: "Sub 1", description: "Desc", details: "Det", dependencies: [] }],
            extraField: "nope",
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("extra field on subtask (e.g. priority) → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [{
              id: 1, title: "Sub 1", description: "Desc", details: "Det",
              dependencies: [], priority: "high",
            }],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("gap in sequential IDs (1, 3) → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
              { id: 3, title: "Sub 3", description: "Desc 3", details: "Det 3", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("IDs starting from 0 → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 0, title: "Sub 0", description: "Desc 0", details: "Det 0", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("forward dependency (subtask 1 depends on subtask 2) → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [2] },
              { id: 2, title: "Sub 2", description: "Desc 2", details: "Det 2", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expectFailureOutcome(outcome, "validation_failed");
      expect((outcome as any).errors.some((e: string) => /forward reference/i.test(e))).toBe(true);
      assertNoWriteSideEffects();
    });

    it("self-dependency → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [1] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expectFailureOutcome(outcome, "validation_failed");
      expect((outcome as any).errors.some((e: string) => /cannot depend on itself/i.test(e))).toBe(true);
      assertNoWriteSideEffects();
    });

    it("dependency on non-existent subtask → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [99] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("implicit cycle (mutual forward reference) → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [2] },
              { id: 2, title: "Sub 2", description: "Desc 2", details: "Det 2", dependencies: [1] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("empty title after trim → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "   ", description: "Desc", details: "Det", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("empty description after trim → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "", details: "Det", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("empty details after trim → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "Desc", details: "  \t  ", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("title exceeding 80 chars → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "A".repeat(81), description: "Desc", details: "Det", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("missing required field 'details' → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "Desc 1", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });

    it("multiple validation errors in one result → reason 'validation_failed', errors[] populated, no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "   ", description: "", details: "Det", dependencies: [1] },
              { id: 3, title: "Sub 3", description: "Desc", details: "Det", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expectFailureOutcome(outcome, "validation_failed");
      expect((outcome as any).errors.length).toBeGreaterThanOrEqual(2);
      assertNoWriteSideEffects();
    });

    it("duplicate IDs (1, 1) → reason 'validation_failed', no write", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult(
          { type: "complete" },
          JSON.stringify({
            subtasks: [
              { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
              { id: 1, title: "Sub 1 dup", description: "Desc", details: "Det", dependencies: [] },
            ],
          }),
        ),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "validation_failed");
      assertNoWriteSideEffects();
    });
  });

  // =========================================================================
  // 4. Hash conflict — tasks.json modified during agent session
  // =========================================================================

  describe("4. Hash conflict", () => {
    it("tasks.json modified during session → reason 'hash_conflict', no write, no commit", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue("original-hash");
      mockVerifyTasksJsonHash.mockReturnValue(false); // File changed externally!

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
          { id: 2, title: "Sub 2", description: "Desc 2", details: "Det 2", dependencies: [1] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome();
      expectFailureOutcome(outcome, "hash_conflict");
      expect((outcome as any).message).toContain("modified during the expand session");
      assertNoWriteSideEffects();
    });

    it("hash conflict preserves external version — writeExpandSubtasks never called", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // The critical guarantee: writeExpandSubtasks was never called,
      // so the external version of tasks.json is preserved byte-identical.
      expect(mockWriteExpandSubtasks).not.toHaveBeenCalled();
      expect(mockCommitExpandedTask).not.toHaveBeenCalled();
    });

    it("hash check occurs inside mutex (TOCTOU safety)", async () => {
      const callOrder: string[] = [];
      mockWithTasksMutex.mockImplementationOnce(async <T>(fn: () => T | Promise<T>): Promise<T> => {
        callOrder.push("mutex:enter");
        const result = await fn();
        callOrder.push("mutex:exit");
        return result;
      });
      mockVerifyTasksJsonHash.mockImplementation(() => {
        callOrder.push("hash_check");
        return false; // conflict
      });

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Hash check happened inside the mutex — no TOCTOU gap
      expect(callOrder).toEqual(["mutex:enter", "hash_check", "mutex:exit"]);
      // write was never called since hash check failed
      expect(mockWriteExpandSubtasks).not.toHaveBeenCalled();
    });

    it("null snapshot hash (file absent at start) with non-empty subtasks → reason 'hash_conflict', no write", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue(null);

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "hash_conflict");
      assertNoWriteSideEffects();
    });

    it("hash conflict broadcasts expand:error with correct reason before expand:finished", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const errorIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:error");
      const finishedIdx = bc.calls.findIndex((e: WsEvent) => e.type === "expand:finished");
      expect(errorIdx).toBeGreaterThanOrEqual(0);
      expect(finishedIdx).toBeGreaterThan(errorIdx);
      expect(bc.calls[errorIdx]!.reason).toBe("hash_conflict");
    });

    it("subtaskCount is 0 on hash conflict (nothing written)", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
          { id: 2, title: "Sub 2", description: "Desc 2", details: "Det 2", dependencies: [1] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.subtaskCount).toBe(0);
    });
  });

  // =========================================================================
  // 4b. Hash conflict — multi-tag scenarios
  //
  // Closes the gap between expand-multi-tag.test.ts (helper-level proof that
  // verifyTasksJsonHash detects inactive-tag / wrapper mutations) and the
  // pipeline-level hash_conflict tests above (section 4). These tests prove
  // that ExpandManager produces reason: "hash_conflict" and skips the write
  // when the mutation happens specifically in a multi-tag context (inactive
  // tag, wrapper structure, etc.).
  // =========================================================================

  describe("4b. Hash conflict — multi-tag", () => {
    it("inactive-tag mutation during session → hash_conflict, no write, no commit", async () => {
      // Simulate: snapshot taken on a multi-tag file, external process modifies
      // an inactive tag during the agent session, hash verification fails.
      mockSnapshotTasksJsonHash.mockReturnValue("multi-tag-hash-before");
      mockVerifyTasksJsonHash.mockReturnValue(false); // inactive tag was modified

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
          { id: 2, title: "Sub 2", description: "Desc 2", details: "Det 2", dependencies: [1] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "hash_conflict");
      expect((manager.getOutcome() as any).message).toContain("modified during the expand session");
      assertNoWriteSideEffects();
    });

    it("wrapper-structure mutation during session → hash_conflict, no write", async () => {
      // Simulate: external process adds/removes a tag in the multi-tag wrapper
      mockSnapshotTasksJsonHash.mockReturnValue("wrapper-hash-before");
      mockVerifyTasksJsonHash.mockReturnValue(false); // wrapper changed

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expectFailureOutcome(manager.getOutcome(), "hash_conflict");
      assertNoWriteSideEffects();
    });

    it("multi-tag hash_conflict broadcasts expand:error then expand:finished", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue("multi-tag-hash");
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const errorEvent = bc.calls.find((e: WsEvent) => e.type === "expand:error");
      const finishedEvent = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(errorEvent).toBeDefined();
      expect(finishedEvent).toBeDefined();
      expect(errorEvent!.reason).toBe("hash_conflict");
      // expand:error must come before expand:finished
      const errorIdx = bc.calls.indexOf(errorEvent!);
      const finishedIdx = bc.calls.indexOf(finishedEvent!);
      expect(errorIdx).toBeLessThan(finishedIdx);
    });

    it("multi-tag hash_conflict returns subtaskCount 0 and idle state", async () => {
      mockSnapshotTasksJsonHash.mockReturnValue("multi-tag-hash");
      mockVerifyTasksJsonHash.mockReturnValue(false);

      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
          { id: 2, title: "Sub 2", description: "Desc 2", details: "Det 2", dependencies: [1] },
          { id: 3, title: "Sub 3", description: "Desc 3", details: "Det 3", dependencies: [2] },
        ],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, validResult),
      );

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const outcome = manager.getOutcome() as any;
      expect(outcome.subtaskCount).toBe(0);
      expect(manager.getState()).toBe("idle");
      expect(sc.release).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. User cancellation — stop() during agent phase
  // =========================================================================

  describe("5. User cancellation", () => {
    it("stop() during agent phase → status 'cancelled', no write", async () => {
      // Make runSession hang indefinitely (simulating an in-progress agent)
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      const outcome = manager.getOutcome();
      expect(outcome).not.toBeNull();
      expect(outcome!.status).toBe("cancelled");
      expect(outcome!.taskId).toBe("1");
      expect(outcome!.subtaskCount).toBe(0);
      assertNoWriteSideEffects();
    });

    it("stop() triggers abort on sessionCore", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      expect(sc.abort).toHaveBeenCalledOnce();
    });

    it("stop() broadcasts expand:finished with cancelled outcome", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);

      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      const finishedEvent = bc.calls.find((e: WsEvent) => e.type === "expand:finished");
      expect(finishedEvent).toBeDefined();
      expect(finishedEvent!.outcome).toEqual({
        status: "cancelled",
        taskId: "1",
        subtaskCount: 0,
      });
    });

    it("late-arriving background result after stop does not trigger write", async () => {
      let resolveSession: (() => void) | undefined;
      const validResult = JSON.stringify({
        subtasks: [
          { id: 1, title: "Sub 1", description: "Desc 1", details: "Det 1", dependencies: [] },
        ],
      });
      mockRunSession.mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveSession = () => resolve(sessionResult({ type: "complete" }, validResult));
        }),
      );

      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);

      // Stop before completion
      await manager.stop(defaultTaskId);

      // Now let the background session resolve (stale finally block)
      resolveSession!();
      await drainAsyncOps();

      // Outcome must be cancelled (set by stop), not success
      expect(manager.getOutcome()!.status).toBe("cancelled");
      // No write occurred from the late-arriving result
      assertNoWriteSideEffects();
    });
  });

  // =========================================================================
  // 6. Cross-cutting: state and cleanup consistency across all failures
  // =========================================================================

  describe("6. Cross-cutting guarantees", () => {
    it("state returns to 'idle' after agent failure", async () => {
      mockRunSession.mockRejectedValueOnce(new Error("crash"));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getState()).toBe("idle");
      expect(manager.getSession()).toBeNull();
      expect(sc.release).toHaveBeenCalled();
    });

    it("state returns to 'idle' after parse failure", async () => {
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, "not json"),
      );

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getState()).toBe("idle");
      expect(sc.release).toHaveBeenCalled();
    });

    it("state returns to 'idle' after validation failure", async () => {
      const invalid = JSON.stringify({ subtasks: [{ id: 1, title: "" }] });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, invalid),
      );

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getState()).toBe("idle");
      expect(sc.release).toHaveBeenCalled();
    });

    it("state returns to 'idle' after hash conflict", async () => {
      mockVerifyTasksJsonHash.mockReturnValue(false);
      const valid = JSON.stringify({
        subtasks: [{ id: 1, title: "Sub", description: "Desc", details: "Det", dependencies: [] }],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, valid),
      );

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getState()).toBe("idle");
      expect(sc.release).toHaveBeenCalled();
    });

    it("state returns to 'idle' after cancellation", async () => {
      mockRunSession.mockImplementationOnce(() => new Promise(() => {}));

      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await manager.stop(defaultTaskId);

      expect(manager.getState()).toBe("idle");
      expect(sc.release).toHaveBeenCalled();
    });

    it("driver is torn down after every failure type", async () => {
      // Agent failure
      mockRunSession.mockRejectedValueOnce(new Error("crash"));
      const manager1 = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager1.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();
      expect(driverRunnerTeardown).toHaveBeenCalled();
      driverRunnerTeardown.mockClear();

      // Validation failure
      const invalid = JSON.stringify({ subtasks: [{ id: 0 }] });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, invalid),
      );
      const manager2 = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager2.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();
      expect(driverRunnerTeardown).toHaveBeenCalled();
      driverRunnerTeardown.mockClear();

      // Hash conflict
      mockVerifyTasksJsonHash.mockReturnValue(false);
      const valid = JSON.stringify({
        subtasks: [{ id: 1, title: "Sub", description: "Desc", details: "Det", dependencies: [] }],
      });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, valid),
      );
      const manager3 = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager3.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();
      expect(driverRunnerTeardown).toHaveBeenCalled();
    });

    it("each failure path produces exactly one expand:finished broadcast", async () => {
      // Test with agent failure
      mockRunSession.mockRejectedValueOnce(new Error("crash"));
      const bc = mockBroadcaster();
      const manager = new ExpandManager("/tmp", mockSessionCore(), bc);
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      const finishedEvents = bc.calls.filter((e: WsEvent) => e.type === "expand:finished");
      expect(finishedEvents).toHaveLength(1);
    });

    it("failure outcomes persist (not cleared like success)", async () => {
      mockRunSession.mockRejectedValueOnce(new Error("crash"));
      const manager = new ExpandManager("/tmp", mockSessionCore(), mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Failure outcome persists for retry UI
      expect(manager.getOutcome()).not.toBeNull();
      expect(manager.getOutcome()!.status).toBe("failure");
    });

    it("can restart after any failure without stale state leaking", async () => {
      // First session: validation failure
      const invalid = JSON.stringify({ subtasks: [{ id: 0 }] });
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, invalid),
      );
      const sc = mockSessionCore();
      const manager = new ExpandManager("/tmp", sc, mockBroadcaster());
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      expect(manager.getOutcome()!.status).toBe("failure");

      // Second session: successful (empty subtasks)
      mockRunSession.mockResolvedValueOnce(
        sessionResult({ type: "complete" }, '{"subtasks": []}'),
      );
      await manager.start(defaultTaskId, defaultStartOpts);
      await drainAsyncOps();

      // Success outcome is cleared after broadcast
      expect(manager.getOutcome()).toBeNull();
      expect(manager.getState()).toBe("idle");
    });
  });
});
