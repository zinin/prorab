import { describe, it, expect } from "vitest";
import {
  buildParsePrdSystemPrompt,
  buildParsePrdTaskPrompt,
  PRD_PATH,
  TASKS_PATH,
} from "../prompts/parse-prd.js";

describe("buildParsePrdSystemPrompt", () => {
  it("includes working directory", () => {
    const prompt = buildParsePrdSystemPrompt("/my/project");
    expect(prompt).toContain("/my/project");
  });

  it("references PRD path", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain(PRD_PATH);
  });

  it("references tasks.json path", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain(TASKS_PATH);
  });

  it("includes task-complete signal", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain("<task-complete>");
  });

  it("includes task-blocked signal", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain("<task-blocked>");
  });

  it("requires pending status for all tasks", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain('"pending"');
  });

  it("explicitly forbids non-pending statuses", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    for (const forbidden of ["done", "in-progress", "review", "rework", "blocked", "closed"]) {
      expect(prompt).toContain(`\`${forbidden}\``);
    }
    expect(prompt).toMatch(/forbidden.*initial task list/i);
  });

  it("requires empty subtasks array", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain('"subtasks": []');
  });

  it("forbids overwriting existing tasks.json", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain("already exists");
    expect(prompt).toMatch(/do NOT overwrite/i);
  });

  it("states it does not modify statuses of existing tasks", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toMatch(/does NOT modify statuses/i);
  });

  it("does not contain multi-tag format instructions", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).not.toContain("<prd-ready>");
    expect(prompt).not.toContain("<parse-prd-success>");
    expect(prompt).not.toContain("multi-tag format");
  });

  it("uses standard top-level format only", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain("standard top-level format");
  });

  it("includes tasks.json schema description", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain('"tasks"');
    expect(prompt).toContain('"metadata"');
    expect(prompt).toContain('"version"');
    expect(prompt).toContain('"lastModified"');
    expect(prompt).toContain('"taskCount"');
  });

  it("forbids committing", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain("Do NOT commit");
    expect(prompt).toContain("git add");
    expect(prompt).toContain("git commit");
  });

  it("requires at least one task", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toMatch(/at least one task/i);
  });

  it("includes task-report instruction", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain("<task-report>");
    expect(prompt).toContain("</task-report>");
  });

  it("forbids looking outside project directory", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toMatch(/Do NOT look for project files outside/i);
  });

  it("includes priority values", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).toContain('"low"');
    expect(prompt).toContain('"medium"');
    expect(prompt).toContain('"high"');
    expect(prompt).toContain('"critical"');
  });

  it("appends language requirement section when responseLanguage is provided", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp", "Russian");
    expect(prompt).toContain("## Language Requirement");
    expect(prompt).toContain("MUST write ALL task content in **Russian**");
    expect(prompt).toContain("`title`");
    expect(prompt).toContain("`description`");
    expect(prompt).toContain("`details`");
    expect(prompt).toContain("`testStrategy`");
    expect(prompt).toContain("must also be in Russian");
  });

  it("does not include language section when responseLanguage is omitted", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp");
    expect(prompt).not.toContain("Language Requirement");
  });

  it("does not include language section when responseLanguage is undefined", () => {
    const prompt = buildParsePrdSystemPrompt("/tmp", undefined);
    expect(prompt).not.toContain("Language Requirement");
  });
});

describe("buildParsePrdTaskPrompt", () => {
  it("references PRD path", () => {
    const prompt = buildParsePrdTaskPrompt();
    expect(prompt).toContain(PRD_PATH);
  });

  it("references tasks.json path", () => {
    const prompt = buildParsePrdTaskPrompt();
    expect(prompt).toContain(TASKS_PATH);
  });
});

describe("constants", () => {
  it("PRD_PATH is the conventional location", () => {
    expect(PRD_PATH).toBe(".taskmaster/docs/prd.md");
  });

  it("TASKS_PATH is the conventional location", () => {
    expect(TASKS_PATH).toBe(".taskmaster/tasks/tasks.json");
  });
});
