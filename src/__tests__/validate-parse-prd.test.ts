import { describe, it, expect } from "vitest";
import { validateParsePrdResult } from "../core/validate-parse-prd.js";

/** Minimal valid parse-prd result: one pending task, empty subtasks. */
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

describe("validateParsePrdResult", () => {
  // --- accept valid standard format ---

  it("accepts a minimal valid standard top-level file", () => {
    const result = validateParsePrdResult(makeValid());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts multiple tasks with valid inter-dependencies", () => {
    const data = {
      tasks: [
        { id: 1, title: "Task 1", description: "a", status: "pending", dependencies: [], subtasks: [] },
        { id: 2, title: "Task 2", description: "b", status: "pending", dependencies: [1], subtasks: [] },
        { id: 3, title: "Task 3", description: "c", status: "pending", dependencies: [1, 2], subtasks: [] },
      ],
      metadata: { version: "1.0.0" },
    };
    const result = validateParsePrdResult(data);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts tasks with null optional fields (TaskMaster compat)", () => {
    const data = {
      tasks: [
        {
          id: 1,
          title: "Task 1",
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
    const result = validateParsePrdResult(data);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  // --- reject multi-tag format ---

  it("rejects multi-tag format", () => {
    const multiTag = {
      master: {
        tasks: [
          { id: 1, title: "T", description: "d", status: "pending", dependencies: [], subtasks: [] },
        ],
        metadata: { version: "1.0.0" },
      },
    };
    const result = validateParsePrdResult(multiTag);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/multi-tag/i);
  });

  it("rejects multi-tag format with multiple tags", () => {
    const multiTag = {
      master: {
        tasks: [{ id: 1, title: "T", description: "d", status: "pending", dependencies: [], subtasks: [] }],
        metadata: {},
      },
      feature: {
        tasks: [{ id: 1, title: "F", description: "d", status: "pending", dependencies: [], subtasks: [] }],
        metadata: {},
      },
    };
    const result = validateParsePrdResult(multiTag);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/multi-tag/i);
    expect(result.errors[0]).toContain("master");
    expect(result.errors[0]).toContain("feature");
  });

  // --- reject non-object inputs ---

  it("rejects null", () => {
    const result = validateParsePrdResult(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/JSON object/);
  });

  it("rejects an array", () => {
    const result = validateParsePrdResult([{ id: 1 }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/JSON object/);
  });

  it("rejects a string", () => {
    const result = validateParsePrdResult("hello");
    expect(result.valid).toBe(false);
  });

  // --- reject missing tasks ---

  it("rejects empty tasks array", () => {
    const data = { tasks: [], metadata: { version: "1.0.0" } };
    const result = validateParsePrdResult(data);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/at least one task/);
  });

  // --- reject non-pending statuses ---

  it("rejects tasks with status other than pending", () => {
    for (const status of ["in-progress", "done", "review", "rework", "blocked", "closed"]) {
      const result = validateParsePrdResult(makeValid({ status }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("pending"))).toBe(true);
    }
  });

  // --- reject non-empty subtasks ---

  it("rejects tasks with non-empty subtasks", () => {
    const data = makeValid({
      subtasks: [
        { id: "1.1", title: "Sub", status: "pending", dependencies: [] },
      ],
    });
    const result = validateParsePrdResult(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("subtasks must be empty"))).toBe(true);
  });

  // --- reject empty id ---

  it("rejects tasks with empty string id", () => {
    const result = validateParsePrdResult(makeValid({ id: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("id must be non-empty"))).toBe(true);
  });

  it("rejects tasks with whitespace-only string id", () => {
    const result = validateParsePrdResult(makeValid({ id: "   " }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("id must be non-empty"))).toBe(true);
  });

  it("accepts tasks with numeric id 0", () => {
    // Numeric 0 is a valid ID — "non-empty" only applies to string IDs
    const result = validateParsePrdResult(makeValid({ id: 0 }));
    expect(result.valid).toBe(true);
  });

  // --- reject empty title ---

  it("rejects tasks with empty title", () => {
    const result = validateParsePrdResult(makeValid({ title: "" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("title must be non-empty"))).toBe(true);
  });

  it("rejects tasks with whitespace-only title", () => {
    const result = validateParsePrdResult(makeValid({ title: "   " }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("title must be non-empty"))).toBe(true);
  });

  // --- reject invalid dependencies ---

  it("rejects dependencies referencing non-existent task IDs", () => {
    const data = {
      tasks: [
        { id: 1, title: "T1", description: "a", status: "pending", dependencies: [99], subtasks: [] },
      ],
      metadata: { version: "1.0.0" },
    };
    const result = validateParsePrdResult(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("dependency 99"))).toBe(true);
  });

  it("accepts dependencies with number→string coercion (numeric id, string dependency)", () => {
    // Task ID is number 2, dependency references string "2" — coercion path should match
    const data = {
      tasks: [
        { id: 1, title: "T1", description: "a", status: "pending", dependencies: [], subtasks: [] },
        { id: 2, title: "T2", description: "b", status: "pending", dependencies: ["1"], subtasks: [] },
      ],
      metadata: { version: "1.0.0" },
    };
    const result = validateParsePrdResult(data);
    expect(result.valid).toBe(true);
  });

  it("accepts dependencies with string→number coercion (string id, numeric dependency)", () => {
    // Task ID is string "2", dependency references number 2 — coercion path should match
    const data = {
      tasks: [
        { id: "1", title: "T1", description: "a", status: "pending", dependencies: [], subtasks: [] },
        { id: "2", title: "T2", description: "b", status: "pending", dependencies: [1], subtasks: [] },
      ],
      metadata: { version: "1.0.0" },
    };
    const result = validateParsePrdResult(data);
    expect(result.valid).toBe(true);
  });

  // --- multiple errors ---

  it("reports multiple errors at once", () => {
    const data = {
      tasks: [
        { id: 1, title: "", description: "a", status: "done", dependencies: [99], subtasks: [{ id: "1.1", title: "S", status: "pending", dependencies: [] }] },
      ],
      metadata: { version: "1.0.0" },
    };
    const result = validateParsePrdResult(data);
    expect(result.valid).toBe(false);
    // Should have errors for: empty title, non-pending status, non-empty subtasks, bad dependency
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  // --- missing top-level tasks key with unrelated object ---

  it("rejects object without tasks key and without multi-tag shape", () => {
    const result = validateParsePrdResult({ foo: "bar", metadata: {} });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Missing top-level.*tasks/);
  });
});
