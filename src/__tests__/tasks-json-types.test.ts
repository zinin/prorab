import { describe, it, expect } from "vitest";
import { TasksFileSchema, FullTaskSchema, FullSubtaskSchema, FullTaskStatusSchema, SubtaskStatusSchema } from "../core/tasks-json-types.js";

describe("FullTaskStatusSchema", () => {
  it("accepts new status values including rework and closed", () => {
    expect(FullTaskStatusSchema.parse("rework")).toBe("rework");
    expect(FullTaskStatusSchema.parse("closed")).toBe("closed");
  });

  it("rejects removed statuses cancelled and deferred", () => {
    expect(() => FullTaskStatusSchema.parse("cancelled")).toThrow();
    expect(() => FullTaskStatusSchema.parse("deferred")).toThrow();
  });

  it("accepts all valid task statuses", () => {
    for (const s of ["pending", "in-progress", "done", "review", "blocked", "rework", "closed"]) {
      expect(FullTaskStatusSchema.parse(s)).toBe(s);
    }
  });
});

describe("SubtaskStatusSchema", () => {
  it("accepts the four subtask statuses", () => {
    for (const s of ["pending", "in-progress", "done", "blocked"]) {
      expect(SubtaskStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects task-only statuses for subtasks", () => {
    expect(() => SubtaskStatusSchema.parse("review")).toThrow();
    expect(() => SubtaskStatusSchema.parse("rework")).toThrow();
    expect(() => SubtaskStatusSchema.parse("closed")).toThrow();
  });
});

describe("FullSubtaskSchema", () => {
  it("parses minimal subtask", () => {
    const result = FullSubtaskSchema.parse({
      id: 1,
      title: "Do something",
      status: "pending",
    });
    expect(result.id).toBe(1);
    expect(result.title).toBe("Do something");
    expect(result.status).toBe("pending");
  });

  it("parses subtask with metadata.runAttempts", () => {
    const result = FullSubtaskSchema.parse({
      id: 2,
      parentId: "1",
      title: "Sub",
      status: "in-progress",
      metadata: { runAttempts: 3 },
    });
    expect(result.metadata).toEqual({ runAttempts: 3 });
  });

  it("preserves unknown fields via passthrough", () => {
    const input = {
      id: 1,
      title: "Sub",
      status: "pending",
      someUnknownField: "keep me",
    };
    const result = FullSubtaskSchema.parse(input);
    expect((result as Record<string, unknown>).someUnknownField).toBe("keep me");
  });

  it("accepts null for optional string fields (TaskMaster compat)", () => {
    // Note: null handling is done by nullsToUndefined() in tasks-json.ts
    // before Zod parsing. This test verifies the schema itself with undefined.
    const result = FullSubtaskSchema.parse({
      id: 1,
      title: "Sub",
      status: "pending",
      testStrategy: undefined,
      details: undefined,
      description: undefined,
    });
    expect(result.testStrategy).toBeUndefined();
    expect(result.details).toBeUndefined();
  });
});

describe("FullTaskSchema", () => {
  it("parses task with all optional fields", () => {
    const result = FullTaskSchema.parse({
      id: 1,
      title: "Setup",
      description: "Init project",
      status: "done",
      priority: "high",
      dependencies: [],
      details: "npm init",
      testStrategy: "check it compiles",
      subtasks: [],
      createdAt: "2026-02-20T08:00:00.000Z",
      metadata: { runAttempts: 1, sprint: "Q1" },
    });
    expect(result.priority).toBe("high");
    expect(result.metadata).toEqual({ runAttempts: 1, sprint: "Q1" });
  });

  it("parses task with subtasks containing metadata", () => {
    const result = FullTaskSchema.parse({
      id: 2,
      title: "Auth",
      status: "in-progress",
      subtasks: [
        { id: 1, parentId: "2", title: "Model", status: "done" },
        { id: 2, parentId: "2", title: "Register", status: "pending", metadata: { runAttempts: 5 } },
      ],
    });
    expect(result.subtasks).toHaveLength(2);
    expect(result.subtasks[1].metadata).toEqual({ runAttempts: 5 });
  });

  it("preserves unknown fields via passthrough", () => {
    const input = {
      id: 1,
      title: "T",
      status: "pending",
      subtasks: [],
      someUnknownField: "keep me",
    };
    const result = FullTaskSchema.parse(input);
    expect((result as Record<string, unknown>).someUnknownField).toBe("keep me");
  });
});

describe("TasksFileSchema", () => {
  it("parses standard format", () => {
    const result = TasksFileSchema.parse({
      tasks: [
        { id: 1, title: "T", status: "pending" },
      ],
      metadata: {
        version: "1.0.0",
        lastModified: "2026-02-23T10:00:00.000Z",
        taskCount: 1,
        completedCount: 0,
      },
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.metadata.version).toBe("1.0.0");
  });

  it("parses minimal metadata (multi-tag format without version/counts)", () => {
    const result = TasksFileSchema.parse({
      tasks: [{ id: 1, title: "T", status: "pending" }],
      metadata: { created: "2026-02-23T16:00:00Z", description: "Tasks for master" },
    });
    expect(result.metadata.version).toBeUndefined();
    expect(result.metadata.taskCount).toBeUndefined();
    expect(result.metadata.completedCount).toBeUndefined();
    expect(result.metadata.lastModified).toBeUndefined();
    expect((result.metadata as Record<string, unknown>).created).toBe("2026-02-23T16:00:00Z");
  });

  it("preserves extra metadata fields", () => {
    const result = TasksFileSchema.parse({
      tasks: [],
      metadata: {
        version: "1.0.0",
        lastModified: "2026-02-23T10:00:00.000Z",
        taskCount: 0,
        completedCount: 0,
        projectName: "my-project",
        description: "A project",
      },
    });
    expect(result.metadata.projectName).toBe("my-project");
  });
});
