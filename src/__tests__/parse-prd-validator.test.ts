import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getParsePrdOutcome, type ParsePrdOutcome } from "../core/validate-parse-prd.js";

/** Create a temp directory for each test. */
function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "prorab-prd-outcome-"));
}

/** Write tasks.json under `.taskmaster/tasks/` in the given root. */
function writeTasksJson(root: string, content: unknown): void {
  const dir = join(root, ".taskmaster", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.json"), JSON.stringify(content, null, 2), "utf-8");
}

/** Minimal valid parse-prd tasks.json. */
function makeValid(overrides: Record<string, unknown> = {}) {
  return {
    tasks: [
      {
        id: 1,
        title: "First task",
        description: "Do something",
        status: "pending",
        dependencies: [],
        subtasks: [],
        priority: "medium",
        ...overrides,
      },
    ],
    metadata: {
      version: "1.0.0",
      projectName: "test",
    },
  };
}

describe("getParsePrdOutcome", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- success cases ----

  it("returns success for a valid single-task file", () => {
    writeTasksJson(tmpDir, makeValid());
    const outcome = getParsePrdOutcome(tmpDir);
    expect(outcome.status).toBe("success");
    expect(outcome).toEqual({ status: "success" });
  });

  it("returns success for multiple valid tasks with dependencies", () => {
    const data = {
      tasks: [
        { id: 1, title: "T1", description: "a", status: "pending", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", description: "b", status: "pending", dependencies: [1], subtasks: [] },
        { id: 3, title: "T3", description: "c", status: "pending", dependencies: [1, 2], subtasks: [] },
      ],
      metadata: { version: "1.0.0" },
    };
    writeTasksJson(tmpDir, data);
    const outcome = getParsePrdOutcome(tmpDir);
    expect(outcome.status).toBe("success");
  });

  it("returns success when optional fields are null (TaskMaster compat)", () => {
    const data = {
      tasks: [
        {
          id: 1,
          title: "T1",
          description: "a",
          status: "pending",
          dependencies: [],
          subtasks: [],
          details: null,
          testStrategy: null,
          priority: null,
        },
      ],
      metadata: { version: "1.0.0", projectName: null },
    };
    writeTasksJson(tmpDir, data);
    const outcome = getParsePrdOutcome(tmpDir);
    expect(outcome.status).toBe("success");
  });

  // ---- failure: file-level errors ----

  it("returns failure when tasks.json does not exist", () => {
    // tmpDir exists but has no .taskmaster directory
    const outcome = getParsePrdOutcome(tmpDir);
    expect(outcome.status).toBe("failure");
    assertFailure(outcome);
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(outcome.errors[0]).toMatch(/cannot read|does not exist/i);
  });

  it("returns failure when tasks.json is not valid JSON", () => {
    const dir = join(tmpDir, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.json"), "{ not json at all", "utf-8");
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    expect(outcome.errors[0]).toMatch(/not valid JSON/i);
  });

  // ---- failure: multi-tag format ----

  it("returns failure for multi-tag format", () => {
    const multiTag = {
      master: {
        tasks: [
          { id: 1, title: "T", description: "d", status: "pending", dependencies: [], subtasks: [] },
        ],
        metadata: { version: "1.0.0" },
      },
    };
    writeTasksJson(tmpDir, multiTag);
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    expect(outcome.errors[0]).toMatch(/multi-tag/i);
  });

  // ---- failure: empty tasks ----

  it("returns failure when tasks array is empty", () => {
    writeTasksJson(tmpDir, { tasks: [], metadata: { version: "1.0.0" } });
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    expect(outcome.errors[0]).toMatch(/at least one task/);
  });

  // ---- failure: non-pending status ----

  it("returns failure for non-pending status", () => {
    writeTasksJson(tmpDir, makeValid({ status: "done" }));
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    expect(outcome.errors.some((e) => e.includes("pending"))).toBe(true);
  });

  // ---- failure: non-empty subtasks ----

  it("returns failure for non-empty subtasks", () => {
    writeTasksJson(
      tmpDir,
      makeValid({
        subtasks: [{ id: "1.1", title: "Sub", status: "pending", dependencies: [] }],
      }),
    );
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    expect(outcome.errors.some((e) => e.includes("subtasks must be empty"))).toBe(true);
  });

  // ---- failure: invalid id ----

  it("returns failure for empty string id", () => {
    writeTasksJson(tmpDir, makeValid({ id: "" }));
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    expect(outcome.errors.some((e) => e.includes("id must be non-empty"))).toBe(true);
  });

  // ---- failure: empty title ----

  it("returns failure for empty title", () => {
    writeTasksJson(tmpDir, makeValid({ title: "" }));
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    expect(outcome.errors.some((e) => e.includes("title must be non-empty"))).toBe(true);
  });

  // ---- failure: bad dependency ----

  it("returns failure for dependency on non-existent task", () => {
    const data = {
      tasks: [
        { id: 1, title: "T1", description: "a", status: "pending", dependencies: [99], subtasks: [] },
      ],
      metadata: { version: "1.0.0" },
    };
    writeTasksJson(tmpDir, data);
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    expect(outcome.errors.some((e) => e.includes("dependency 99"))).toBe(true);
  });

  // ---- failure: multiple errors reported ----

  it("returns all validation errors, not just the first one", () => {
    const data = {
      tasks: [
        {
          id: 1,
          title: "",
          description: "a",
          status: "done",
          dependencies: [99],
          subtasks: [{ id: "1.1", title: "S", status: "pending", dependencies: [] }],
        },
      ],
      metadata: { version: "1.0.0" },
    };
    writeTasksJson(tmpDir, data);
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    // Should have errors for: empty title, non-pending status, non-empty subtasks, bad dependency
    expect(outcome.errors.length).toBeGreaterThanOrEqual(3);
  });

  // ---- error messages are log/UI-friendly ----

  it("produces human-readable error messages (no raw stack traces)", () => {
    writeTasksJson(tmpDir, makeValid({ status: "blocked" }));
    const outcome = getParsePrdOutcome(tmpDir);
    assertFailure(outcome);
    for (const error of outcome.errors) {
      // Messages should be plain-English strings, not stack traces or raw JSON
      expect(typeof error).toBe("string");
      expect(error.length).toBeGreaterThan(0);
      expect(error).not.toMatch(/^\s*at\s+/); // no stack trace lines
    }
  });

  // ---- outcome type narrowing ----

  it("success outcome has no errors property", () => {
    writeTasksJson(tmpDir, makeValid());
    const outcome = getParsePrdOutcome(tmpDir);
    expect(outcome.status).toBe("success");
    // TypeScript discriminated union: success has no `errors` key
    expect("errors" in outcome).toBe(false);
  });

  it("failure outcome always has non-empty errors array", () => {
    // Every failure path should include at least one error message
    const outcome = getParsePrdOutcome(tmpDir); // no file
    assertFailure(outcome);
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(outcome.errors.every((e) => typeof e === "string" && e.length > 0)).toBe(true);
  });

  // ---- cancelled is NOT produced by this helper ----

  it("never returns cancelled status (that's the manager's responsibility)", () => {
    // Even with the worst input, only "success" or "failure" is returned
    const inputs = [
      () => {}, // no file at all
      () => writeTasksJson(tmpDir, null),
      () => writeTasksJson(tmpDir, makeValid()),
      () => writeTasksJson(tmpDir, makeValid({ status: "done" })),
    ];
    for (const setup of inputs) {
      // Reset tmpDir for each input
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = makeTmpDir();
      setup();
      const outcome = getParsePrdOutcome(tmpDir);
      expect(["success", "failure"]).toContain(outcome.status);
      expect(outcome.status).not.toBe("cancelled");
    }
  });
});

/** Type guard + assertion for failure outcome. */
function assertFailure(outcome: ParsePrdOutcome): asserts outcome is { status: "failure"; errors: string[] } {
  expect(outcome.status).toBe("failure");
  if (outcome.status !== "failure") throw new Error("Expected failure outcome");
}
