import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeComplexityFields, readTasksFile } from "../core/tasks-json.js";

function setupTasksJson(cwd: string, tasks: unknown[]): void {
  const dir = join(cwd, ".taskmaster", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({ tasks, metadata: {} }, null, 2));
}

describe("writeComplexityFields", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "wc-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("writes all four complexity fields to the task", () => {
    setupTasksJson(cwd, [{ id: 1, title: "Task 1", status: "pending", subtasks: [] }]);

    writeComplexityFields(cwd, "1", {
      complexityScore: 7,
      recommendedSubtasks: 5,
      expansionPrompt: "Break into pieces",
      reasoning: "Complex task",
    });

    const data = readTasksFile(cwd);
    const task = data.tasks.find((t) => String(t.id) === "1")!;
    expect(task.complexity).toBe(7);
    expect(task.recommendedSubtasks).toBe(5);
    expect(task.expansionPrompt).toBe("Break into pieces");
    expect(task.complexityReasoning).toBe("Complex task");
  });

  it("does not modify other tasks", () => {
    setupTasksJson(cwd, [
      { id: 1, title: "Task 1", status: "pending", subtasks: [] },
      { id: 2, title: "Task 2", status: "pending", subtasks: [] },
    ]);

    writeComplexityFields(cwd, "1", {
      complexityScore: 5,
      recommendedSubtasks: 3,
      expansionPrompt: "Split it",
      reasoning: "Medium",
    });

    const after = readTasksFile(cwd);
    const task2 = after.tasks.find((t) => String(t.id) === "2")!;
    expect(task2.complexity).toBeUndefined();
  });

  it("preserves long expansionPrompt and reasoning without truncation", () => {
    setupTasksJson(cwd, [{ id: 1, title: "Task 1", status: "pending", subtasks: [] }]);
    const longStr = "x".repeat(5000);

    writeComplexityFields(cwd, "1", {
      complexityScore: 5,
      recommendedSubtasks: 3,
      expansionPrompt: longStr,
      reasoning: longStr,
    });

    const data = readTasksFile(cwd);
    const task = data.tasks.find((t) => String(t.id) === "1")!;
    expect(task.expansionPrompt!.length).toBe(5000);
    expect(task.complexityReasoning!.length).toBe(5000);
  });

  it("preserves multi-tag format", () => {
    const dir = join(cwd, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "tasks.json"),
      JSON.stringify({
        "project-alpha": { tasks: [{ id: 1, title: "T1", status: "pending", subtasks: [] }], metadata: {} },
      }, null, 2),
    );

    writeComplexityFields(cwd, "1", {
      complexityScore: 3,
      recommendedSubtasks: 2,
      expansionPrompt: "Simple split",
      reasoning: "Easy",
    });

    const raw = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf-8"));
    expect(raw["project-alpha"]).toBeDefined();
    expect(raw["project-alpha"].tasks[0].complexity).toBe(3);
  });
});
