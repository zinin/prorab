import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitParsePrdResult } from "../core/git.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "prorab-git-parse-prd-"));
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

function writeGitignore(cwd: string, content: string): void {
  writeFileSync(join(cwd, ".gitignore"), content, "utf-8");
}

describe("commitParsePrdResult", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupGitRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("commits both .gitignore and tasks.json when both are new", () => {
    writeGitignore(cwd, ".taskmaster/prorab.lock\n");
    writeTasksJson(cwd, '{"tasks":[]}');

    const result = commitParsePrdResult(cwd);

    expect(result).toBe(true);
    const log = git(["log", "--oneline", "-1"], cwd);
    expect(log).toContain("prorab: initialize tasks from PRD");
    const tracked = git(["ls-files"], cwd);
    expect(tracked).toContain(".gitignore");
    expect(tracked).toContain(".taskmaster/tasks/tasks.json");
  });

  it("commits only tasks.json when .gitignore is already tracked and unchanged", () => {
    writeGitignore(cwd, "node_modules/\n");
    git(["add", ".gitignore"], cwd);
    git(["commit", "-m", "add gitignore"], cwd);

    writeTasksJson(cwd, '{"tasks":[]}');

    const result = commitParsePrdResult(cwd);

    expect(result).toBe(true);
    const diff = git(["diff", "--name-only", "HEAD~1", "HEAD"], cwd);
    expect(diff).toContain(".taskmaster/tasks/tasks.json");
    expect(diff).not.toContain(".gitignore");
  });

  it("commits both when .gitignore is tracked but modified", () => {
    writeGitignore(cwd, "node_modules/\n");
    git(["add", ".gitignore"], cwd);
    git(["commit", "-m", "add gitignore"], cwd);

    writeGitignore(cwd, "node_modules/\n.taskmaster/prorab.lock\n");
    writeTasksJson(cwd, '{"tasks":[]}');

    const result = commitParsePrdResult(cwd);

    expect(result).toBe(true);
    const diff = git(["diff", "--name-only", "HEAD~1", "HEAD"], cwd);
    expect(diff).toContain(".gitignore");
    expect(diff).toContain(".taskmaster/tasks/tasks.json");
  });

  it("does not commit unrelated staged files", () => {
    writeGitignore(cwd, ".taskmaster/prorab.lock\n");
    writeTasksJson(cwd, '{"tasks":[]}');
    writeFileSync(join(cwd, "unrelated.txt"), "data");
    git(["add", "unrelated.txt"], cwd);

    commitParsePrdResult(cwd);

    const status = git(["status", "--porcelain"], cwd);
    expect(status).toContain("unrelated.txt");
  });

  it("returns false when nothing to commit", () => {
    writeGitignore(cwd, ".taskmaster/prorab.lock\n");
    writeTasksJson(cwd, '{"tasks":[]}');
    git(["add", "."], cwd);
    git(["commit", "-m", "already committed"], cwd);

    const result = commitParsePrdResult(cwd);
    expect(result).toBe(false);
  });

  it("commits only tasks.json when .gitignore does not exist", () => {
    // No .gitignore created — simulates fresh project without ensureLockInGitignore
    writeTasksJson(cwd, '{"tasks":[]}');

    const result = commitParsePrdResult(cwd);

    expect(result).toBe(true);
    const diff = git(["diff", "--name-only", "HEAD~1", "HEAD"], cwd);
    expect(diff).toContain(".taskmaster/tasks/tasks.json");
    expect(diff).not.toContain(".gitignore");
  });

  it("unstages files on commit failure", () => {
    // Install a pre-commit hook that always rejects to force commit failure
    const hooksDir = join(cwd, ".git", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    writeGitignore(cwd, ".taskmaster/prorab.lock\n");
    writeTasksJson(cwd, '{"tasks":[]}');

    const result = commitParsePrdResult(cwd);

    expect(result).toBe(false);
    // Files should NOT remain staged — otherwise isPathDirty blocks expand
    const staged = git(["diff", "--cached", "--name-only"], cwd);
    expect(staged).toBe("");
  });

  it("returns false in non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "prorab-non-git-"));
    writeFileSync(join(nonGit, ".gitignore"), ".taskmaster/prorab.lock\n");
    const dir = join(nonGit, ".taskmaster", "tasks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.json"), '{"tasks":[]}');

    const result = commitParsePrdResult(nonGit);

    expect(result).toBe(false);
    rmSync(nonGit, { recursive: true, force: true });
  });
});
