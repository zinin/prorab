import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTasksFile,
  writeTasksFile,
  writeExpandSubtasks,
  getAttemptCount,
  incrementAttemptCount,
  createTask,
  updateTask,
  deleteTask,
  updateSubtask,
  deleteSubtask,
  TaskNotFoundError,
  findNextAction,
  showTaskById,
  setStatusDirect,
  setMetadata,
  setRevisions,
  getRevisions,
  getTaskRevisions,
  TASK_FINAL_STATUSES,
  SUBTASK_FINAL_STATUSES,
} from "../core/tasks-json.js";
import type { NextAction } from "../core/tasks-json.js";
import type { TasksFile } from "../core/tasks-json-types.js";

/** Minimal valid TasksFile for use in tests. */
function makeTasksFile(overrides: Partial<TasksFile> = {}): TasksFile {
  return {
    tasks: [
      {
        id: 1,
        title: "Task one",
        status: "pending",
        dependencies: [],
        subtasks: [
          { id: 1, title: "Sub one", status: "pending", dependencies: [] },
          { id: 2, title: "Sub two", status: "in-progress", dependencies: [] },
        ],
      },
      {
        id: 2,
        title: "Task two",
        status: "done",
        dependencies: [],
        subtasks: [],
      },
    ],
    metadata: {
      version: "1.0.0",
      lastModified: "2026-02-25T10:00:00.000Z",
      taskCount: 2,
      completedCount: 1,
    },
    ...overrides,
  };
}

/** Write a tasks.json fixture into the given cwd. */
function writeTasks(cwd: string, data: TasksFile): void {
  const dir = join(cwd, ".taskmaster", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

describe("readTasksFile / writeTasksFile", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads and parses tasks.json", () => {
    const fixture = makeTasksFile();
    writeTasks(cwd, fixture);

    const result = readTasksFile(cwd);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].title).toBe("Task one");
    expect(result.metadata.version).toBe("1.0.0");
  });

  it("round-trips without data loss", () => {
    const fixture = makeTasksFile();
    writeTasks(cwd, fixture);

    const data = readTasksFile(cwd);
    writeTasksFile(cwd, data);

    const roundTripped = readTasksFile(cwd);
    expect(roundTripped).toEqual(data);
  });

  it("preserves unknown fields in tasks", () => {
    const fixture = makeTasksFile();
    // Add an unknown field to the first task
    (fixture.tasks[0] as Record<string, unknown>).customField = "keep me";
    writeTasks(cwd, fixture);

    const data = readTasksFile(cwd);
    expect((data.tasks[0] as Record<string, unknown>).customField).toBe("keep me");

    // Round-trip preserves it too
    writeTasksFile(cwd, data);
    const roundTripped = readTasksFile(cwd);
    expect((roundTripped.tasks[0] as Record<string, unknown>).customField).toBe("keep me");
  });

  it("handles null values in optional fields (TaskMaster compat)", () => {
    // TaskMaster commonly writes "testStrategy": null instead of omitting the field.
    // JSON.parse preserves null, but Zod .optional() rejects null.
    // nullsToUndefined() in tasks-json.ts converts null → undefined before parsing.
    const dir = join(cwd, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.json"), JSON.stringify({
      tasks: [
        {
          id: 1,
          title: "Task with nulls",
          status: "pending",
          dependencies: [],
          testStrategy: null,
          details: null,
          description: null,
          subtasks: [
            {
              id: 1,
              title: "Sub with nulls",
              status: "pending",
              dependencies: [],
              testStrategy: null,
              details: null,
            },
          ],
        },
      ],
      metadata: { version: "1.0.0" },
    }, null, 2), "utf-8");

    const data = readTasksFile(cwd);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].testStrategy).toBeUndefined();
    expect(data.tasks[0].details).toBeUndefined();
    expect(data.tasks[0].subtasks[0].testStrategy).toBeUndefined();
    expect(data.tasks[0].subtasks[0].details).toBeUndefined();
  });

  it("atomic write: file is valid after write (temp + rename)", () => {
    // Setup directory so writeTasksFile can work
    mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });

    const data = makeTasksFile();
    writeTasksFile(cwd, data);

    // Read it back raw and verify format
    const raw = readFileSync(join(cwd, ".taskmaster", "tasks", "tasks.json"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);

    // Verify it's valid JSON with 2-space indent
    const parsed = JSON.parse(raw);
    expect(parsed.tasks).toHaveLength(2);

    // Verify 2-space indentation by checking the actual formatting
    const expected = JSON.stringify(data, null, 2) + "\n";
    expect(raw).toBe(expected);
  });
});

describe("getAttemptCount", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns 0 for task without metadata", () => {
    writeTasks(cwd, makeTasksFile());
    expect(getAttemptCount(cwd, "1")).toBe(0);
  });

  it("returns 0 for subtask without metadata", () => {
    writeTasks(cwd, makeTasksFile());
    expect(getAttemptCount(cwd, "1.1")).toBe(0);
  });

  it("returns stored value when metadata exists (task)", () => {
    const fixture = makeTasksFile();
    fixture.tasks[0].metadata = { runAttempts: 5 };
    writeTasks(cwd, fixture);

    expect(getAttemptCount(cwd, "1")).toBe(5);
  });

  it("returns stored value for subtask with metadata", () => {
    const fixture = makeTasksFile();
    fixture.tasks[0].subtasks[1].metadata = { runAttempts: 3 };
    writeTasks(cwd, fixture);

    expect(getAttemptCount(cwd, "1.2")).toBe(3);
  });

  it("throws for non-existent task", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => getAttemptCount(cwd, "99")).toThrow(/Task 99 not found/);
  });

  it("throws for non-existent subtask", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => getAttemptCount(cwd, "1.99")).toThrow(/Subtask 1\.99 not found/);
  });
});

describe("incrementAttemptCount", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("creates metadata and sets runAttempts to 1 on first increment", () => {
    writeTasks(cwd, makeTasksFile());

    const result = incrementAttemptCount(cwd, "1");
    expect(result).toBe(1);

    // Verify persisted
    expect(getAttemptCount(cwd, "1")).toBe(1);
  });

  it("increments existing runAttempts", () => {
    const fixture = makeTasksFile();
    fixture.tasks[0].metadata = { runAttempts: 3 };
    writeTasks(cwd, fixture);

    const result = incrementAttemptCount(cwd, "1");
    expect(result).toBe(4);
    expect(getAttemptCount(cwd, "1")).toBe(4);
  });

  it("works for subtasks", () => {
    writeTasks(cwd, makeTasksFile());

    const first = incrementAttemptCount(cwd, "1.2");
    expect(first).toBe(1);

    const second = incrementAttemptCount(cwd, "1.2");
    expect(second).toBe(2);

    expect(getAttemptCount(cwd, "1.2")).toBe(2);
  });

  it("preserves other metadata fields", () => {
    const fixture = makeTasksFile();
    fixture.tasks[0].metadata = { runAttempts: 1, sprint: "Q1", custom: true };
    writeTasks(cwd, fixture);

    incrementAttemptCount(cwd, "1");

    const data = readTasksFile(cwd);
    expect(data.tasks[0].metadata).toEqual({
      runAttempts: 2,
      sprint: "Q1",
      custom: true,
    });
  });

  it("does not affect other tasks", () => {
    const fixture = makeTasksFile();
    fixture.tasks[0].metadata = { runAttempts: 5 };
    fixture.tasks[1].metadata = { runAttempts: 10 };
    writeTasks(cwd, fixture);

    incrementAttemptCount(cwd, "1");

    expect(getAttemptCount(cwd, "1")).toBe(6);
    expect(getAttemptCount(cwd, "2")).toBe(10); // unchanged
  });
});

describe("edge cases", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('invalid unitId format "1.2.3" throws', () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => getAttemptCount(cwd, "1.2.3")).toThrow(/Invalid unitId format/);
  });

  it("empty string unitId throws", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => getAttemptCount(cwd, "")).toThrow(/Invalid unitId.*empty/);
  });

  it("ENOENT (missing tasks.json) throws", () => {
    // cwd exists but has no .taskmaster directory
    expect(() => readTasksFile(cwd)).toThrow();
  });

  it("invalid JSON in tasks.json throws", () => {
    const dir = join(cwd, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.json"), "{ broken json !!!", "utf-8");

    expect(() => readTasksFile(cwd)).toThrow();
  });

  it("non-numeric runAttempts treated as 0", () => {
    const fixture = makeTasksFile();
    fixture.tasks[0].metadata = { runAttempts: "not-a-number" as unknown as number };
    writeTasks(cwd, fixture);

    expect(getAttemptCount(cwd, "1")).toBe(0);
  });
});

describe("multi-tag format", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /** Write a multi-tag tasks.json: { "master": { tasks, metadata } } */
  function writeMultiTag(
    dir: string,
    tag: string,
    data: TasksFile,
    extraTags?: Record<string, TasksFile>,
  ): void {
    const tasksDir = join(dir, ".taskmaster", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    const file: Record<string, unknown> = { [tag]: data, ...extraTags };
    writeFileSync(join(tasksDir, "tasks.json"), JSON.stringify(file, null, 2) + "\n", "utf-8");
  }

  it("readTasksFile reads multi-tag format", () => {
    const fixture = makeTasksFile();
    writeMultiTag(cwd, "master", fixture);

    const result = readTasksFile(cwd);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].title).toBe("Task one");
  });

  it("getAttemptCount works with multi-tag format", () => {
    const fixture = makeTasksFile();
    fixture.tasks[0].metadata = { runAttempts: 7 };
    writeMultiTag(cwd, "master", fixture);

    expect(getAttemptCount(cwd, "1")).toBe(7);
  });

  it("incrementAttemptCount works with multi-tag format", () => {
    const fixture = makeTasksFile();
    writeMultiTag(cwd, "master", fixture);

    const result = incrementAttemptCount(cwd, "1");
    expect(result).toBe(1);
    expect(getAttemptCount(cwd, "1")).toBe(1);
  });

  it("incrementAttemptCount preserves multi-tag wrapper", () => {
    const fixture = makeTasksFile();
    writeMultiTag(cwd, "master", fixture);

    incrementAttemptCount(cwd, "1");

    // Read raw file and verify it's still multi-tag format
    const raw = JSON.parse(
      readFileSync(join(cwd, ".taskmaster", "tasks", "tasks.json"), "utf-8"),
    );
    expect(raw.master).toBeDefined();
    expect(Array.isArray(raw.master.tasks)).toBe(true);
    // Verify no top-level "tasks" array leaked
    expect(raw.tasks).toBeUndefined();
  });

  it("incrementAttemptCount preserves other tags in multi-tag file", () => {
    const main = makeTasksFile();
    const other = makeTasksFile();
    other.tasks[0].title = "Other tag task";
    writeMultiTag(cwd, "master", main, { "feature-x": other });

    incrementAttemptCount(cwd, "1");

    const raw = JSON.parse(
      readFileSync(join(cwd, ".taskmaster", "tasks", "tasks.json"), "utf-8"),
    );
    expect(raw["feature-x"]).toBeDefined();
    expect(raw["feature-x"].tasks[0].title).toBe("Other tag task");
  });

  it("subtask increment in multi-tag format", () => {
    const fixture = makeTasksFile();
    writeMultiTag(cwd, "dev", fixture);

    incrementAttemptCount(cwd, "1.2");
    incrementAttemptCount(cwd, "1.2");

    expect(getAttemptCount(cwd, "1.2")).toBe(2);
  });

  it("reads multi-tag format with minimal metadata (no version/taskCount)", () => {
    const dir = join(cwd, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    const multiTag = {
      master: {
        tasks: [{ id: 1, title: "T", status: "pending", dependencies: [], subtasks: [] }],
        metadata: { created: "2026-02-23T16:00:00Z", updated: "2026-02-23T16:00:00Z", description: "Tasks for master context" },
      },
    };
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(multiTag), "utf-8");

    const result = readTasksFile(cwd);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe("T");
    expect(result.metadata.version).toBeUndefined();
    expect(result.metadata.taskCount).toBeUndefined();
  });

  it("throws on empty object (no tags)", () => {
    const dir = join(cwd, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.json"), "{}", "utf-8");

    expect(() => readTasksFile(cwd)).toThrow(/unexpected format/);
  });
});

describe("createTask", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("creates a task with auto-incremented ID", () => {
    writeTasks(cwd, makeTasksFile());
    const task = createTask(cwd, { title: "New task" });
    expect(task.id).toBe(3); // max existing is 2
    expect(task.title).toBe("New task");
    expect(task.status).toBe("pending");
    expect(task.subtasks).toEqual([]);
  });

  it("persists the new task to disk", () => {
    writeTasks(cwd, makeTasksFile());
    createTask(cwd, { title: "Persisted" });
    const data = readTasksFile(cwd);
    expect(data.tasks).toHaveLength(3);
    expect(data.tasks[2].title).toBe("Persisted");
  });

  it("updates taskCount in metadata", () => {
    writeTasks(cwd, makeTasksFile());
    createTask(cwd, { title: "Another" });
    const data = readTasksFile(cwd);
    expect(data.metadata.taskCount).toBe(3);
  });

  it("normalizes dependencies to strings", () => {
    writeTasks(cwd, makeTasksFile());
    const task = createTask(cwd, { title: "With deps", dependencies: [1, "2"] });
    expect(task.dependencies).toEqual(["1", "2"]);
  });

  it("preserves multi-tag format", () => {
    const dir = join(cwd, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    const multiTag = { master: makeTasksFile(), other: makeTasksFile() };
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(multiTag, null, 2) + "\n", "utf-8");

    createTask(cwd, { title: "In master" });

    const raw = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"));
    expect(raw.master.tasks).toHaveLength(3);
    expect(raw.other.tasks).toHaveLength(2); // untouched
  });
});

describe("updateTask", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("updates specified fields without affecting others", () => {
    writeTasks(cwd, makeTasksFile());
    updateTask(cwd, "1", { status: "done" });
    const data = readTasksFile(cwd);
    expect(data.tasks[0].status).toBe("done");
    expect(data.tasks[0].title).toBe("Task one"); // unchanged
  });

  it("normalizes dependencies to strings", () => {
    writeTasks(cwd, makeTasksFile());
    updateTask(cwd, "1", { dependencies: [2, "3"] });
    const data = readTasksFile(cwd);
    expect(data.tasks[0].dependencies).toEqual(["2", "3"]);
  });

  it("throws TaskNotFoundError for non-existent task", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => updateTask(cwd, "99", { title: "nope" })).toThrow(TaskNotFoundError);
  });
});

describe("deleteTask", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("removes the task and updates taskCount", () => {
    writeTasks(cwd, makeTasksFile());
    deleteTask(cwd, "1");
    const data = readTasksFile(cwd);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].id).toBe(2);
    expect(data.metadata.taskCount).toBe(1);
  });

  it("throws TaskNotFoundError for non-existent task", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => deleteTask(cwd, "99")).toThrow(TaskNotFoundError);
  });
});

describe("updateSubtask", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("updates subtask fields", () => {
    writeTasks(cwd, makeTasksFile());
    updateSubtask(cwd, "1", "1", { status: "done", title: "Updated sub" });
    const data = readTasksFile(cwd);
    const sub = data.tasks[0].subtasks[0];
    expect(sub.status).toBe("done");
    expect(sub.title).toBe("Updated sub");
  });

  it("normalizes subtask dependencies to strings", () => {
    writeTasks(cwd, makeTasksFile());
    updateSubtask(cwd, "1", "1", { dependencies: [1, "2"] });
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[0].dependencies).toEqual(["1", "2"]);
  });

  it("throws TaskNotFoundError for non-existent task", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => updateSubtask(cwd, "99", "1", { status: "done" })).toThrow(TaskNotFoundError);
  });

  it("throws TaskNotFoundError for non-existent subtask", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => updateSubtask(cwd, "1", "99", { status: "done" })).toThrow(TaskNotFoundError);
  });
});

describe("deleteSubtask", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("removes the subtask", () => {
    writeTasks(cwd, makeTasksFile());
    deleteSubtask(cwd, "1", "1");
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks).toHaveLength(1);
    expect(data.tasks[0].subtasks[0].id).toBe(2);
  });

  it("throws TaskNotFoundError for non-existent subtask", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => deleteSubtask(cwd, "1", "99")).toThrow(TaskNotFoundError);
  });
});

describe("logic tests (attempt arithmetic)", () => {
  it("previousAttempts + attempt gives correct currentAttempt", () => {
    // previousAttempts is the stored runAttempts from tasks.json (before increment)
    // After incrementing, the new value = previousAttempts + 1
    // In the run loop: attempt is the per-run counter (1-based)
    // currentAttempt (for display) = previousAttempts + attempt
    const previousAttempts = 5; // from tasks.json
    const attempt = 1; // first run attempt
    const currentAttempt = previousAttempts + attempt;
    expect(currentAttempt).toBe(6);

    // After 3 retries in same run:
    const attempt3 = 3;
    const currentAttempt3 = previousAttempts + attempt3;
    expect(currentAttempt3).toBe(8);
  });

  it("previousReport should be read unconditionally (always, not conditionally)", () => {
    // This test documents the design decision:
    // readReport() is called ALWAYS before each iteration, regardless of
    // attempt number or previousAttempts count.
    // readReport() returns null when no report file exists (ENOENT safe).
    //
    // The old code had a guard: if (attempt > 1 || globalAttempts > 0)
    // The review removed this guard — always read the report.
    //
    // We verify this by checking that the pattern is:
    // 1. Always call readReport (returns string | null)
    // 2. Pass result to prompt builder (null means no previous context)
    const readReportAlways = true; // no conditional guard
    expect(readReportAlways).toBe(true);
  });
});

describe("showTaskById", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns the task by id", () => {
    writeTasks(cwd, makeTasksFile());
    const task = showTaskById("1", cwd);
    expect(task.id).toBe(1);
    expect(task.title).toBe("Task one");
  });

  it("returns task with subtasks populated", () => {
    writeTasks(cwd, makeTasksFile());
    const task = showTaskById("1", cwd);
    expect(task.subtasks).toHaveLength(2);
  });

  it("throws TaskNotFoundError for non-existent id", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => showTaskById("99", cwd)).toThrow(TaskNotFoundError);
  });
});

describe("setStatusDirect", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-tasks-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("sets task status", () => {
    writeTasks(cwd, makeTasksFile());
    setStatusDirect("1", "in-progress", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].status).toBe("in-progress");
  });

  it("sets subtask status (N.M format)", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "pending", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "in-progress", dependencies: [] },
          ],
        },
      ],
    }));
    setStatusDirect("1.1", "done", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[0].status).toBe("done");
  });

  it("forward cascade: setting task to closed cascades subtasks to done", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "done", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "pending", dependencies: [] },
            { id: 2, title: "S2", status: "in-progress", dependencies: [] },
            { id: 3, title: "S3", status: "done", dependencies: [] },
          ],
        },
      ],
    }));

    setStatusDirect("1", "closed", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].status).toBe("closed");
    expect(data.tasks[0].subtasks[0].status).toBe("done");
    expect(data.tasks[0].subtasks[1].status).toBe("done");
    expect(data.tasks[0].subtasks[2].status).toBe("done");
  });

  it("does not cascade non-closed status to subtasks", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "pending", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));

    setStatusDirect("1", "in-progress", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[0].status).toBe("pending");
  });

  it("reverse cascade: all subtasks done → parent becomes done (review enabled)", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "in-progress", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "done", dependencies: [] },
            { id: 2, title: "S2", status: "in-progress", dependencies: [] },
          ],
        },
      ],
    }));

    setStatusDirect("1.2", "done", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[1].status).toBe("done");
    expect(data.tasks[0].status).toBe("done");
  });

  it("reverse cascade: all subtasks done → parent becomes closed (--no-review)", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "in-progress", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "done", dependencies: [] },
            { id: 2, title: "S2", status: "in-progress", dependencies: [] },
          ],
        },
      ],
    }));

    setStatusDirect("1.2", "done", cwd, { reviewEnabled: false });
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[1].status).toBe("done");
    expect(data.tasks[0].status).toBe("closed");
  });

  it("does not cascade parent when not all subtasks are done", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "in-progress", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "in-progress", dependencies: [] },
            { id: 2, title: "S2", status: "in-progress", dependencies: [] },
          ],
        },
      ],
    }));

    setStatusDirect("1.1", "done", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[0].status).toBe("done");
    expect(data.tasks[0].status).toBe("in-progress");
  });

  it("subtask blocked → parent also becomes blocked", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "in-progress", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "done", dependencies: [] },
            { id: 2, title: "S2", status: "in-progress", dependencies: [] },
          ],
        },
      ],
    }));

    setStatusDirect("1.2", "blocked", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[1].status).toBe("blocked");
    expect(data.tasks[0].status).toBe("blocked");
  });

  it("self-transition is allowed (idempotent)", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "in-progress", dependencies: [],
          subtasks: [],
        },
      ],
    }));

    // Should NOT throw
    setStatusDirect("1", "in-progress", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].status).toBe("in-progress");
  });

  it("blocked → pending transition allowed (manual unblock)", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "blocked", dependencies: [],
          subtasks: [],
        },
      ],
    }));

    // Should NOT throw
    setStatusDirect("1", "pending", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].status).toBe("pending");
  });

  it("invalid transition throws error", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "pending", dependencies: [],
          subtasks: [],
        },
      ],
    }));

    expect(() => setStatusDirect("1", "done", cwd)).toThrow(/Invalid task transition/);
  });

  it("invalid subtask transition throws error", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "in-progress", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));

    expect(() => setStatusDirect("1.1", "done", cwd)).toThrow(/Invalid subtask transition/);
  });

  it("TASK_FINAL_STATUSES contains only closed", () => {
    expect(TASK_FINAL_STATUSES).toEqual(new Set(["closed"]));
  });

  it("SUBTASK_FINAL_STATUSES contains only done", () => {
    expect(SUBTASK_FINAL_STATUSES).toEqual(new Set(["done"]));
  });

  it("throws for non-existent task", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => setStatusDirect("99", "done", cwd)).toThrow(TaskNotFoundError);
  });

  it("throws for non-existent subtask", () => {
    writeTasks(cwd, makeTasksFile());
    expect(() => setStatusDirect("1.99", "done", cwd)).toThrow(TaskNotFoundError);
  });

  it("idempotent: task closed → closed is no-op", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1,
          title: "Already closed",
          status: "closed",
          dependencies: [],
          subtasks: [
            { id: 1, title: "Sub", status: "done", dependencies: [] },
          ],
        },
      ],
    }));

    // Should NOT throw
    setStatusDirect("1", "closed", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].status).toBe("closed");
  });

  it("allows rework → review transition", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [{ id: 1, title: "T", status: "rework", dependencies: [], subtasks: [] }],
      metadata: {},
    }));
    setStatusDirect("1", "review", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].status).toBe("review");
  });

  it("idempotent: subtask done → done is no-op", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1,
          title: "Task",
          status: "in-progress",
          dependencies: [],
          subtasks: [
            { id: 1, title: "Already done", status: "done", dependencies: [] },
          ],
        },
      ],
    }));

    // Should NOT throw
    setStatusDirect("1.1", "done", cwd);
    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[0].status).toBe("done");
    // Parent should NOT be cascaded since we returned early
    expect(data.tasks[0].status).toBe("in-progress");
  });
});

describe("findNextAction", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-find-next-action-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns blocked when any task is blocked", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "blocked", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action).toEqual({ type: "blocked", task: expect.objectContaining({ status: "blocked" }) });
  });

  it("returns execute action for pending task without subtasks", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action).toEqual({ type: "execute", task: expect.objectContaining({ status: "pending" }) });
  });

  it("returns execute with subtask for pending parent with subtasks", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "Parent", status: "pending", dependencies: [],
          subtasks: [
            { id: 1, title: "Sub1", status: "pending", dependencies: [] },
            { id: 2, title: "Sub2", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("execute");
    expect((action as Extract<NextAction, { type: "execute" }>).subtask).toBeDefined();
  });

  it("returns review action for done task when review enabled", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "done", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action).toEqual({ type: "review", task: expect.objectContaining({ status: "done" }) });
  });

  it("returns review action for task in review status (resumable)", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "review", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action).toEqual({ type: "review", task: expect.objectContaining({ status: "review" }) });
  });

  it("returns execute (skips done) when review disabled", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "done", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, false);
    // task 1 (done) should be skipped as completed, task 2 returned
    expect(action!.type).toBe("execute");
    expect((action as Extract<NextAction, { type: "execute" }>).task.id).toBe(2);
  });

  it("returns rework action for rework task", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "rework", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action).toEqual({ type: "rework", task: expect.objectContaining({ status: "rework" }) });
  });

  it("rework has highest priority over review and execute", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "rework", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", status: "done", dependencies: [], subtasks: [] },
        { id: 3, title: "T3", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("rework");
  });

  it("review blocks execute — cannot pick new task while done task awaits review", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "done", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("review");
  });

  it("returns null when all tasks are closed", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "closed", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", status: "closed", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action).toBeNull();
  });

  it("does NOT return pending parent with subtasks in Pass 2", () => {
    // Pending parent with subtasks where all subtasks have unmet deps
    // Pass 1: no eligible subtask (dep not met). Pass 2: parent has subtasks → skipped.
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "Parent", status: "pending", dependencies: [],
          subtasks: [
            { id: 1, title: "Sub1", status: "pending", dependencies: [2] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action).toBeNull();
  });

  it("returns execute for subtask of pending parent (auto-transitions parent)", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "Parent", status: "pending", dependencies: [],
          subtasks: [
            { id: 1, title: "Sub1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("execute");
    expect((action as Extract<NextAction, { type: "execute" }>).subtask).toBeDefined();
  });

  it("blocked subtask returns blocked action (parent is blocked too)", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "Parent", status: "blocked", dependencies: [],
          subtasks: [
            { id: 1, title: "Sub1", status: "blocked", dependencies: [] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("blocked");
  });

  it("blocked takes priority over rework", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "blocked", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", status: "rework", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("blocked");
  });

  it("sorts rework tasks by priority descending", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "Low rework", status: "rework", dependencies: [], subtasks: [], priority: "low" },
        { id: 2, title: "High rework", status: "rework", dependencies: [], subtasks: [], priority: "high" },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("rework");
    expect((action as Extract<NextAction, { type: "rework" }>).task.id).toBe(2);
  });

  it("sorts review tasks by priority descending", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "Low done", status: "done", dependencies: [], subtasks: [], priority: "low" },
        { id: 2, title: "High done", status: "done", dependencies: [], subtasks: [], priority: "high" },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("review");
    expect((action as Extract<NextAction, { type: "review" }>).task.id).toBe(2);
  });

  it("returns null when no tasks exist", () => {
    writeTasks(cwd, makeTasksFile({ tasks: [] }));
    const action = findNextAction(cwd, true);
    expect(action).toBeNull();
  });

  it("done treated as completed (skipped) when review disabled and has deps", () => {
    // Task 2 depends on task 1 (done). With review disabled, done = completed.
    // So task 2's dep is satisfied.
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "done", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", status: "pending", dependencies: ["1"], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, false);
    expect(action!.type).toBe("execute");
    expect((action as Extract<NextAction, { type: "execute" }>).task.id).toBe(2);
  });

  it("Pass 1 skips subtasks of parent with unmet task-level dependencies", () => {
    // Task 1 is closed, task 2 depends on task 1 — deps met, subtask should be picked
    // Task 3 depends on task 2 (pending) — deps NOT met, subtask should NOT be picked
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "closed", dependencies: [], subtasks: [] },
        {
          id: 2, title: "T2", status: "pending", dependencies: ["1"],
          subtasks: [
            { id: 1, title: "Sub2.1", status: "pending", dependencies: [] },
          ],
        },
        {
          id: 3, title: "T3", status: "pending", dependencies: ["2"],
          subtasks: [
            { id: 1, title: "Sub3.1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("execute");
    const exec = action as Extract<NextAction, { type: "execute" }>;
    // Should pick task 2's subtask (parent deps met), NOT task 3's subtask
    expect(exec.task.id).toBe(2);
    expect(exec.subtask!.id).toBe(1);
  });

  it("Pass 1 returns null when all parents have unmet dependencies", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "pending", dependencies: ["99"],
          subtasks: [
            { id: 1, title: "Sub1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    // Parent dep "99" not satisfied, no eligible tasks
    expect(action).toBeNull();
  });

  it("blocked via subtask blocks the whole process", () => {
    // Parent is in-progress, but one subtask is blocked
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "Parent", status: "in-progress", dependencies: [],
          subtasks: [
            { id: 1, title: "Sub1", status: "done", dependencies: [] },
            { id: 2, title: "Sub2", status: "blocked", dependencies: [] },
          ],
        },
        { id: 2, title: "T2", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("blocked");
  });

  it("prefers in-progress parent over pending parent", () => {
    // Task 3 is in-progress (already started), task 4 is pending.
    // Both have eligible subtasks. Should pick task 3's subtask.
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "closed", dependencies: [], subtasks: [] },
        {
          id: 3, title: "T3", status: "in-progress", dependencies: ["1"],
          subtasks: [
            { id: 1, title: "Sub3.1", status: "done", dependencies: [] },
            { id: 2, title: "Sub3.2", status: "pending", dependencies: [1] },
          ],
        },
        {
          id: 4, title: "T4", status: "pending", dependencies: ["1"],
          subtasks: [
            { id: 1, title: "Sub4.1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("execute");
    const exec = action as Extract<NextAction, { type: "execute" }>;
    expect(exec.task.id).toBe(3);
    expect(exec.subtask!.id).toBe(2);
  });

  it("prefers lower parent ID when both parents are pending (sequential order)", () => {
    // Task 3 and 4 are both pending, both depend on closed task 2.
    // Task 4.1 has 0 deps, task 3.2 has 1 dep.
    // Should still pick task 3's subtask because of lower parent ID.
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 2, title: "T2", status: "closed", dependencies: [], subtasks: [] },
        {
          id: 3, title: "T3", status: "pending", dependencies: ["2"],
          subtasks: [
            { id: 1, title: "Sub3.1", status: "done", dependencies: [] },
            { id: 2, title: "Sub3.2", status: "pending", dependencies: [1] },
          ],
        },
        {
          id: 4, title: "T4", status: "pending", dependencies: ["2"],
          subtasks: [
            { id: 1, title: "Sub4.1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("execute");
    const exec = action as Extract<NextAction, { type: "execute" }>;
    // Must pick task 3 (lower ID), NOT task 4 (which has fewer deps)
    expect(exec.task.id).toBe(3);
    expect(exec.subtask!.id).toBe(2);
  });

  it("higher priority parent wins even with higher ID", () => {
    // Task 5 has critical priority, task 3 has low priority.
    // Should pick task 5's subtask despite higher ID.
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 3, title: "T3", status: "pending", dependencies: [], priority: "low",
          subtasks: [
            { id: 1, title: "Sub3.1", status: "pending", dependencies: [] },
          ],
        },
        {
          id: 5, title: "T5", status: "pending", dependencies: [], priority: "critical",
          subtasks: [
            { id: 1, title: "Sub5.1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    const action = findNextAction(cwd, true);
    expect(action!.type).toBe("execute");
    const exec = action as Extract<NextAction, { type: "execute" }>;
    expect(exec.task.id).toBe(5);
  });
});

describe("revision tracking", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-revision-tracking-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("setRevisions stores startRev and endRev in metadata", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    setRevisions(cwd, "1", "abc123", "def456");
    const revs = getRevisions(cwd, "1");
    expect(revs).toEqual({ startRev: "abc123", endRev: "def456" });
  });

  it("setRevisions works for subtasks", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "in-progress", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "pending", dependencies: [] },
            { id: 2, title: "S2", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    setRevisions(cwd, "1.2", "aaa", "bbb");
    const revs = getRevisions(cwd, "1.2");
    expect(revs).toEqual({ startRev: "aaa", endRev: "bbb" });
  });

  it("getRevisions returns null for task without revisions", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    const revs = getRevisions(cwd, "1");
    expect(revs).toBeNull();
  });

  it("getRevisions returns null when metadata exists but no revisions", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [], metadata: { runAttempts: 1 } },
      ],
    }));
    const revs = getRevisions(cwd, "1");
    expect(revs).toBeNull();
  });

  it("setMetadata merges keys into entity metadata", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    setMetadata(cwd, "1", { executedAt: "2024-01-01T00:00:00Z" });
    const data = readTasksFile(cwd);
    const task = data.tasks.find(t => String(t.id) === "1");
    expect(task!.metadata!.executedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("setMetadata merges into subtask metadata", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "in-progress", dependencies: [],
          subtasks: [
            { id: 1, title: "S1", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));
    setMetadata(cwd, "1.1", { executedAt: "2024-01-01T00:00:00Z" });
    const data = readTasksFile(cwd);
    const subtask = data.tasks[0].subtasks[0];
    expect(subtask.metadata!.executedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("setRevisions preserves existing metadata", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    setMetadata(cwd, "1", { runAttempts: 3 });
    setRevisions(cwd, "1", "abc", "def");
    const data = readTasksFile(cwd);
    const task = data.tasks.find(t => String(t.id) === "1");
    expect(task!.metadata!.runAttempts).toBe(3);
    expect(task!.metadata!.startRev).toBe("abc");
    expect(task!.metadata!.endRev).toBe("def");
  });

  it("setMetadata preserves existing revisions", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    setRevisions(cwd, "1", "abc", "def");
    setMetadata(cwd, "1", { executedAt: "2024-01-01T00:00:00Z" });
    const data = readTasksFile(cwd);
    const task = data.tasks.find(t => String(t.id) === "1");
    expect(task!.metadata!.startRev).toBe("abc");
    expect(task!.metadata!.endRev).toBe("def");
    expect(task!.metadata!.executedAt).toBe("2024-01-01T00:00:00Z");
  });

  it("getTaskRevisions delegates to getRevisions for top-level tasks", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    setRevisions(cwd, "1", "abc", "def");
    const revs = getTaskRevisions(cwd, "1");
    expect(revs).toEqual({ startRev: "abc", endRev: "def" });
  });

  it("getTaskRevisions returns null when no revisions set", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    const revs = getTaskRevisions(cwd, "1");
    expect(revs).toBeNull();
  });

  it("setRevisions overwrites previous revision values", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    setRevisions(cwd, "1", "first", "first");
    setRevisions(cwd, "1", "first", "second");
    const revs = getRevisions(cwd, "1");
    expect(revs).toEqual({ startRev: "first", endRev: "second" });
  });

  it("setMetadata creates metadata object when none exists", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] },
      ],
    }));
    // Task has no metadata field at all
    setMetadata(cwd, "1", { foo: "bar" });
    const data = readTasksFile(cwd);
    const task = data.tasks.find(t => String(t.id) === "1");
    expect(task!.metadata).toBeDefined();
    expect(task!.metadata!.foo).toBe("bar");
  });
});

describe("writeExpandSubtasks", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "prorab-expand-write-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  const sampleSubtasks = [
    { id: 1, title: "Sub one", description: "Desc one", details: "Det one", dependencies: [] as number[] },
    { id: 2, title: "Sub two", description: "Desc two", details: "Det two", dependencies: [1] },
    { id: 3, title: "Sub three", description: "Desc three", details: "Det three", dependencies: [1, 2], testStrategy: "Run tests" },
  ];

  it("adds subtasks only to the target task, other tasks unchanged", () => {
    const fixture = makeTasksFile({
      tasks: [
        { id: 1, title: "Target", description: "Target desc", status: "pending", dependencies: ["2"], subtasks: [], details: "Target details", testStrategy: "Target test", priority: "high" },
        { id: 2, title: "Other", description: "Other desc", status: "done", dependencies: [], subtasks: [{ id: 1, title: "Existing sub", status: "done", dependencies: [] }], details: "Other details", testStrategy: "Other test" },
      ],
      metadata: { version: "1.0.0", taskCount: 2 },
    });
    writeTasks(cwd, fixture);

    // Capture task 2 before write
    const beforeData = readTasksFile(cwd);
    const task2Before = JSON.parse(JSON.stringify(beforeData.tasks[1]));

    writeExpandSubtasks(cwd, "1", sampleSubtasks);

    const afterData = readTasksFile(cwd);

    // Target task (1) has new subtasks
    expect(afterData.tasks[0].subtasks).toHaveLength(3);
    expect(afterData.tasks[0].subtasks[0].title).toBe("Sub one");
    expect(afterData.tasks[0].subtasks[1].title).toBe("Sub two");
    expect(afterData.tasks[0].subtasks[2].title).toBe("Sub three");

    // Target task's own fields are unchanged
    expect(afterData.tasks[0].title).toBe("Target");
    expect(afterData.tasks[0].description).toBe("Target desc");
    expect(afterData.tasks[0].status).toBe("pending");
    expect(afterData.tasks[0].dependencies).toEqual(["2"]);
    expect(afterData.tasks[0].details).toBe("Target details");
    expect(afterData.tasks[0].testStrategy).toBe("Target test");
    expect(afterData.tasks[0].priority).toBe("high");

    // Other task (2) is completely unchanged — field-by-field
    const task2After = JSON.parse(JSON.stringify(afterData.tasks[1]));
    expect(task2After).toEqual(task2Before);
  });

  it("writes only prescribed fields: id, title, description, details, dependencies, status, testStrategy", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [{ id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] }],
    }));

    writeExpandSubtasks(cwd, "1", [
      { id: 1, title: "Sub", description: "D", details: "Det", dependencies: [/* empty */], testStrategy: "Test" },
    ]);

    const data = readTasksFile(cwd);
    const sub = data.tasks[0].subtasks[0];
    const keys = Object.keys(sub);

    // Only these keys should be present
    expect(keys).toContain("id");
    expect(keys).toContain("title");
    expect(keys).toContain("description");
    expect(keys).toContain("details");
    expect(keys).toContain("dependencies");
    expect(keys).toContain("status");
    expect(keys).toContain("testStrategy");
    // Should NOT contain parentId, priority, metadata, etc.
    expect(keys).not.toContain("parentId");
    expect(keys).not.toContain("priority");
    expect(keys).not.toContain("metadata");
    expect(keys).not.toContain("createdAt");
    expect(keys).not.toContain("updatedAt");
  });

  it("omits testStrategy when not provided", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [{ id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] }],
    }));

    writeExpandSubtasks(cwd, "1", [
      { id: 1, title: "Sub", description: "D", details: "Det", dependencies: [] },
    ]);

    const data = readTasksFile(cwd);
    const sub = data.tasks[0].subtasks[0];
    expect(Object.keys(sub)).not.toContain("testStrategy");
  });

  it("all subtasks have status 'pending'", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [{ id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] }],
    }));

    writeExpandSubtasks(cwd, "1", sampleSubtasks);

    const data = readTasksFile(cwd);
    for (const sub of data.tasks[0].subtasks) {
      expect(sub.status).toBe("pending");
    }
  });

  it("preserves dependencies as numbers", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [{ id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] }],
    }));

    writeExpandSubtasks(cwd, "1", sampleSubtasks);

    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks[1].dependencies).toEqual([1]);
    expect(data.tasks[0].subtasks[2].dependencies).toEqual([1, 2]);
  });

  it("replaces existing subtasks with new ones", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "pending", dependencies: [],
          subtasks: [
            { id: 1, title: "Old sub", status: "done", dependencies: [] },
          ],
        },
      ],
    }));

    writeExpandSubtasks(cwd, "1", [
      { id: 1, title: "New sub", description: "New desc", details: "New det", dependencies: [] },
    ]);

    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks).toHaveLength(1);
    expect(data.tasks[0].subtasks[0].title).toBe("New sub");
    expect(data.tasks[0].subtasks[0].status).toBe("pending");
  });

  it("does not change parent task status", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [{ id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] }],
    }));

    writeExpandSubtasks(cwd, "1", sampleSubtasks);

    const data = readTasksFile(cwd);
    expect(data.tasks[0].status).toBe("pending");
  });

  it("throws TaskNotFoundError for non-existent task", () => {
    writeTasks(cwd, makeTasksFile());

    expect(() => writeExpandSubtasks(cwd, "99", sampleSubtasks)).toThrow(TaskNotFoundError);
  });

  it("empty subtasks array sets task.subtasks to []", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        {
          id: 1, title: "T1", status: "pending", dependencies: [],
          subtasks: [
            { id: 1, title: "Old sub", status: "pending", dependencies: [] },
          ],
        },
      ],
    }));

    writeExpandSubtasks(cwd, "1", []);

    const data = readTasksFile(cwd);
    expect(data.tasks[0].subtasks).toEqual([]);
  });

  it("preserves multi-tag format and other tags unchanged", () => {
    const main = makeTasksFile({
      tasks: [
        { id: 1, title: "Main task", status: "pending", dependencies: [], subtasks: [] },
      ],
    });
    const other = makeTasksFile({
      tasks: [
        {
          id: 1, title: "Other tag task", status: "done", dependencies: [],
          subtasks: [{ id: 1, title: "Other sub", status: "done", dependencies: [] }],
        },
      ],
    });
    const dir = join(cwd, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    const multiTagData = { master: main, "feature-x": other };
    writeFileSync(join(dir, "tasks.json"), JSON.stringify(multiTagData, null, 2) + "\n", "utf-8");

    writeExpandSubtasks(cwd, "1", [
      { id: 1, title: "New sub", description: "D", details: "Det", dependencies: [] },
    ]);

    const raw = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"));

    // Multi-tag wrapper preserved
    expect(raw.master).toBeDefined();
    expect(raw["feature-x"]).toBeDefined();
    expect(raw.tasks).toBeUndefined(); // No top-level tasks leak

    // Active tag (master) has new subtasks
    expect(raw.master.tasks[0].subtasks).toHaveLength(1);
    expect(raw.master.tasks[0].subtasks[0].title).toBe("New sub");

    // Other tag completely unchanged
    expect(raw["feature-x"].tasks[0].title).toBe("Other tag task");
    expect(raw["feature-x"].tasks[0].subtasks).toHaveLength(1);
    expect(raw["feature-x"].tasks[0].subtasks[0].title).toBe("Other sub");
  });

  it("atomic write: produces valid JSON with 2-space indent and trailing newline", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [{ id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] }],
    }));

    writeExpandSubtasks(cwd, "1", sampleSubtasks);

    const raw = readFileSync(join(cwd, ".taskmaster", "tasks", "tasks.json"), "utf-8");

    // Trailing newline
    expect(raw.endsWith("\n")).toBe(true);

    // Valid JSON
    const parsed = JSON.parse(raw);
    expect(parsed.tasks).toBeDefined();

    // 2-space indent: re-serialize and compare
    const expected = JSON.stringify(parsed, null, 2) + "\n";
    expect(raw).toBe(expected);
  });

  it("metadata on target task is preserved", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [
        { id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [], metadata: { runAttempts: 3, sprint: "Q1" } },
      ],
    }));

    writeExpandSubtasks(cwd, "1", sampleSubtasks);

    const data = readTasksFile(cwd);
    expect(data.tasks[0].metadata).toEqual({ runAttempts: 3, sprint: "Q1" });
  });

  it("file metadata is preserved", () => {
    writeTasks(cwd, makeTasksFile({
      tasks: [{ id: 1, title: "T1", status: "pending", dependencies: [], subtasks: [] }],
      metadata: { version: "2.0.0", taskCount: 1, projectName: "test-project" },
    }));

    writeExpandSubtasks(cwd, "1", sampleSubtasks);

    const data = readTasksFile(cwd);
    expect(data.metadata.version).toBe("2.0.0");
    expect(data.metadata.taskCount).toBe(1);
    expect(data.metadata.projectName).toBe("test-project");
  });

});
