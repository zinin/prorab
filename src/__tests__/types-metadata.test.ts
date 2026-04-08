import { describe, it, expect } from "vitest";
import { TaskSchema, SubtaskSchema } from "../types.js";

describe("TaskSchema metadata field", () => {
  it("parses task with metadata", () => {
    const result = TaskSchema.parse({
      id: 1,
      title: "T",
      status: "pending",
      metadata: { runAttempts: 2, custom: "value" },
    });
    expect(result.metadata).toEqual({ runAttempts: 2, custom: "value" });
  });

  it("parses task without metadata", () => {
    const result = TaskSchema.parse({
      id: 1,
      title: "T",
      status: "pending",
    });
    expect(result.metadata).toBeUndefined();
  });
});

describe("SubtaskSchema metadata field", () => {
  it("parses subtask with metadata", () => {
    const result = SubtaskSchema.parse({
      id: 1,
      title: "S",
      status: "pending",
      metadata: { runAttempts: 5 },
    });
    expect(result.metadata).toEqual({ runAttempts: 5 });
  });
});
