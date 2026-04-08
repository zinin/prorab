import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import { PRD_PATH, TASKS_PATH } from "../prompts/parse-prd.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from "node:fs";
import { hasPrd, checkTasksFile, getProjectState } from "../core/project-state.js";

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const CWD = "/test/project";
const FULL_PRD_PATH = join(CWD, PRD_PATH);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hasPrd", () => {
  it("returns false when the PRD file does not exist", () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(hasPrd(CWD)).toBe(false);
    expect(mockReadFileSync).toHaveBeenCalledWith(
      FULL_PRD_PATH,
      "utf-8",
    );
  });

  it("returns false when the PRD file is empty", () => {
    mockReadFileSync.mockReturnValue("");

    expect(hasPrd(CWD)).toBe(false);
  });

  it("returns false when the PRD file contains only whitespace", () => {
    mockReadFileSync.mockReturnValue("   \n\t\n   \n");

    expect(hasPrd(CWD)).toBe(false);
  });

  it("returns false when the PRD file contains only newlines", () => {
    mockReadFileSync.mockReturnValue("\n\n\n");

    expect(hasPrd(CWD)).toBe(false);
  });

  it("returns true when the PRD file contains meaningful markdown", () => {
    mockReadFileSync.mockReturnValue("# My PRD\n\nSome content here.\n");

    expect(hasPrd(CWD)).toBe(true);
  });

  it("returns true when the PRD file has leading whitespace before content", () => {
    mockReadFileSync.mockReturnValue("\n\n  Hello\n");

    expect(hasPrd(CWD)).toBe(true);
  });

  it("returns true for a single non-whitespace character", () => {
    mockReadFileSync.mockReturnValue("x");

    expect(hasPrd(CWD)).toBe(true);
  });

  it("returns false when readFileSync throws an error", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    expect(hasPrd(CWD)).toBe(false);
  });

  it("constructs the correct path from cwd and PRD_PATH", () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    hasPrd("/custom/root");

    expect(mockReadFileSync).toHaveBeenCalledWith(
      join("/custom/root", PRD_PATH),
      "utf-8",
    );
  });
});

const FULL_TASKS_PATH = join(CWD, TASKS_PATH);

/** Minimal valid tasks.json content (standard format). */
const VALID_TASKS_JSON = JSON.stringify({
  tasks: [
    {
      id: 1,
      title: "Test task",
      status: "pending",
      dependencies: [],
      subtasks: [],
    },
  ],
  metadata: {},
});

/** Minimal valid multi-tag tasks.json content. */
const VALID_MULTI_TAG_JSON = JSON.stringify({
  master: {
    tasks: [
      {
        id: 1,
        title: "Test task",
        status: "pending",
        dependencies: [],
        subtasks: [],
      },
    ],
    metadata: {},
  },
});

describe("checkTasksFile", () => {
  it("returns hasTasksFile=false, hasValidTasks=false when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: false, hasValidTasks: false });
    expect(mockExistsSync).toHaveBeenCalledWith(FULL_TASKS_PATH);
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });

  it("returns hasTasksFile=true, hasValidTasks=false for invalid JSON", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not valid json {{{");

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });

  it("returns hasTasksFile=true, hasValidTasks=false for valid JSON with wrong structure", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ foo: "bar" }));

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });

  it("returns hasTasksFile=true, hasValidTasks=false when tasks is not an array", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ tasks: "not-an-array", metadata: {} }),
    );

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });

  it("returns hasTasksFile=true, hasValidTasks=false for a JSON array (non-object)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("[1, 2, 3]");

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });

  it("returns hasTasksFile=true, hasValidTasks=false when tasks array has invalid task schema", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        tasks: [{ id: 1 }], // missing required fields: title, status, etc.
        metadata: {},
      }),
    );

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });

  it("returns hasTasksFile=true, hasValidTasks=true for valid standard format", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_TASKS_JSON);

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: true });
  });

  it("returns hasTasksFile=true, hasValidTasks=true for valid multi-tag format", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(VALID_MULTI_TAG_JSON);

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: true });
  });

  it("returns hasTasksFile=true, hasValidTasks=false when readFileSync throws", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });

  it("returns hasTasksFile=true, hasValidTasks=false for empty string content", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("");

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });

  it("constructs the correct path from cwd and TASKS_PATH", () => {
    mockExistsSync.mockReturnValue(false);

    checkTasksFile("/custom/root");

    expect(mockExistsSync).toHaveBeenCalledWith(
      join("/custom/root", TASKS_PATH),
    );
  });

  it("returns hasTasksFile=true, hasValidTasks=false for missing metadata", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        tasks: [
          { id: 1, title: "t", status: "pending", dependencies: [], subtasks: [] },
        ],
        // missing metadata
      }),
    );

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });

  it("returns hasValidTasks=true when optional fields are null (null → undefined normalization)", () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        tasks: [
          {
            id: 1,
            title: "Test task",
            status: "pending",
            dependencies: [],
            subtasks: [],
            description: null,
            details: null,
            prd: null,
          },
        ],
        metadata: {},
      }),
    );

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: true });
  });

  it("returns hasValidTasks=false in multi-tag format when first tag is invalid (matches readTasksFile)", () => {
    mockExistsSync.mockReturnValue(true);
    // Only the first tag is checked — matches readTasksFile() which reads tagNames[0].
    // If the first tag is invalid, hasValidTasks is false even if a later tag is valid.
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        alpha: {
          tasks: [{ id: 1 }], // invalid — missing required fields
          metadata: {},
        },
        beta: {
          tasks: [
            { id: 1, title: "Test", status: "pending", dependencies: [], subtasks: [] },
          ],
          metadata: {},
        },
      }),
    );

    const result = checkTasksFile(CWD);

    expect(result).toEqual({ hasTasksFile: true, hasValidTasks: false });
  });
});

// ---------------------------------------------------------------------------
// getProjectState — full matrix
// ---------------------------------------------------------------------------

describe("getProjectState", () => {
  /**
   * Helper that sets up the mock so that:
   * - `existsSync` returns true/false per path (PRD / tasks.json)
   * - `readFileSync` returns the given content per path
   */
  function setupMocks(opts: {
    prdExists: boolean;
    prdContent?: string;
    tasksExists: boolean;
    tasksContent?: string;
  }) {
    const prdPath = join(CWD, PRD_PATH);
    const tasksPath = join(CWD, TASKS_PATH);

    mockExistsSync.mockImplementation((p: unknown) => {
      if (p === prdPath) return opts.prdExists;
      if (p === tasksPath) return opts.tasksExists;
      return false;
    });

    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === prdPath) {
        if (!opts.prdExists) throw new Error("ENOENT");
        return opts.prdContent ?? "";
      }
      if (p === tasksPath) {
        if (!opts.tasksExists) throw new Error("ENOENT");
        return opts.tasksContent ?? "";
      }
      throw new Error("ENOENT");
    });
  }

  // State 1: Fresh project — nothing set up
  it("fresh project: no PRD, no tasks file", () => {
    setupMocks({ prdExists: false, tasksExists: false });

    expect(getProjectState(CWD)).toEqual({
      hasPrd: false,
      hasTasksFile: false,
      hasValidTasks: false,
    });
  });

  // State 2: tasks.json exists but is invalid, no PRD
  it("no PRD, tasks.json present but invalid JSON", () => {
    setupMocks({
      prdExists: false,
      tasksExists: true,
      tasksContent: "not json {{{",
    });

    expect(getProjectState(CWD)).toEqual({
      hasPrd: false,
      hasTasksFile: true,
      hasValidTasks: false,
    });
  });

  // State 3: Valid tasks, no PRD
  it("no PRD, valid tasks.json (standard format)", () => {
    setupMocks({
      prdExists: false,
      tasksExists: true,
      tasksContent: VALID_TASKS_JSON,
    });

    expect(getProjectState(CWD)).toEqual({
      hasPrd: false,
      hasTasksFile: true,
      hasValidTasks: true,
    });
  });

  // State 4: PRD written, no tasks.json yet — parse-prd precondition
  it("has PRD, no tasks file — ready for parse-prd", () => {
    setupMocks({
      prdExists: true,
      prdContent: "# PRD\n\nSome meaningful content.\n",
      tasksExists: false,
    });

    expect(getProjectState(CWD)).toEqual({
      hasPrd: true,
      hasTasksFile: false,
      hasValidTasks: false,
    });
  });

  // State 5: PRD exists, tasks.json present but invalid
  it("has PRD, tasks.json present but schema-invalid", () => {
    setupMocks({
      prdExists: true,
      prdContent: "# PRD\nContent\n",
      tasksExists: true,
      tasksContent: JSON.stringify({ foo: "bar" }),
    });

    expect(getProjectState(CWD)).toEqual({
      hasPrd: true,
      hasTasksFile: true,
      hasValidTasks: false,
    });
  });

  // State 6: Fully initialised — PRD + valid tasks
  it("has PRD, valid tasks.json — fully initialised project", () => {
    setupMocks({
      prdExists: true,
      prdContent: "# PRD\nDetailed requirements.\n",
      tasksExists: true,
      tasksContent: VALID_TASKS_JSON,
    });

    expect(getProjectState(CWD)).toEqual({
      hasPrd: true,
      hasTasksFile: true,
      hasValidTasks: true,
    });
  });

  // Multi-tag format variant
  it("has PRD, valid tasks.json (multi-tag format)", () => {
    setupMocks({
      prdExists: true,
      prdContent: "# PRD\n",
      tasksExists: true,
      tasksContent: VALID_MULTI_TAG_JSON,
    });

    expect(getProjectState(CWD)).toEqual({
      hasPrd: true,
      hasTasksFile: true,
      hasValidTasks: true,
    });
  });

  // Edge: whitespace-only PRD treated as absent
  it("whitespace-only PRD treated as no PRD", () => {
    setupMocks({
      prdExists: true,
      prdContent: "   \n\t\n   \n",
      tasksExists: true,
      tasksContent: VALID_TASKS_JSON,
    });

    expect(getProjectState(CWD)).toEqual({
      hasPrd: false,
      hasTasksFile: true,
      hasValidTasks: true,
    });
  });
});
