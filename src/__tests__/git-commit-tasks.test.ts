import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitTasksJson } from "../core/git.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "prorab-git-commit-tasks-"));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "init");
  git(["add", "."], dir);
  git(["commit", "-m", "initial"], dir);
  return dir;
}

function writeTasksJson(cwd: string, content: string): void {
  const dir = join(cwd, ".taskmaster", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tasks.json"), content, "utf-8");
}

describe("commitTasksJson", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupGitRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("commits tasks.json with given message", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    const result = commitTasksJson(cwd, "task(1): update title");
    expect(result).toBe(true);
    const log = git(["log", "--oneline", "-1"], cwd);
    expect(log).toContain("task(1): update title");
  });

  it("returns false when tasks.json has no changes", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    git(["add", "."], cwd);
    git(["commit", "-m", "committed"], cwd);
    const result = commitTasksJson(cwd, "no-op");
    expect(result).toBe(false);
  });

  it("does not commit non-taskmaster files", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    writeFileSync(join(cwd, "unrelated.txt"), "data");
    commitTasksJson(cwd, "task(1): update");
    const status = git(["status", "--porcelain"], cwd);
    expect(status).toContain("unrelated.txt");
  });

  it("returns false in non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "prorab-non-git-"));
    writeTasksJson(nonGit, '{"tasks":[]}');
    const result = commitTasksJson(nonGit, "msg");
    expect(result).toBe(false);
    rmSync(nonGit, { recursive: true, force: true });
  });
});
