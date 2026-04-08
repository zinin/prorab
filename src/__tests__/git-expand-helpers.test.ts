import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hasGitIdentity,
  isPathDirty,
  commitExpandedTask,
} from "../core/git.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "prorab-git-expand-helpers-"));
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

// ---------------------------------------------------------------------------
// hasGitIdentity
// ---------------------------------------------------------------------------

describe("hasGitIdentity", () => {
  let cwd: string;
  let savedGlobalConfig: string | undefined;
  let savedSystemConfig: string | undefined;

  beforeEach(() => {
    // Isolate from global/system git config so --unset of local config
    // truly results in missing identity (no fallback to ~/.gitconfig).
    savedGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    savedSystemConfig = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    cwd = setupGitRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    // Restore original env
    if (savedGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobalConfig;
    if (savedSystemConfig === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = savedSystemConfig;
  });

  it("returns true when both user.name and user.email are set", () => {
    expect(hasGitIdentity(cwd)).toBe(true);
  });

  it("returns false when user.name is missing", () => {
    git(["config", "--unset", "user.name"], cwd);
    expect(hasGitIdentity(cwd)).toBe(false);
  });

  it("returns false when user.email is missing", () => {
    git(["config", "--unset", "user.email"], cwd);
    expect(hasGitIdentity(cwd)).toBe(false);
  });

  it("returns false when both user.name and user.email are missing", () => {
    git(["config", "--unset", "user.name"], cwd);
    git(["config", "--unset", "user.email"], cwd);
    expect(hasGitIdentity(cwd)).toBe(false);
  });

  it("returns false for non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "prorab-non-git-"));
    expect(hasGitIdentity(nonGit)).toBe(false);
    rmSync(nonGit, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// isPathDirty
// ---------------------------------------------------------------------------

describe("isPathDirty", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupGitRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("returns false for a clean tracked file", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    git(["add", "."], cwd);
    git(["commit", "-m", "add tasks"], cwd);
    expect(isPathDirty(".taskmaster/tasks/tasks.json", cwd)).toBe(false);
  });

  it("returns true for an unstaged modification", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    git(["add", "."], cwd);
    git(["commit", "-m", "add tasks"], cwd);
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      '{"tasks":[{"id":1}]}',
    );
    expect(isPathDirty(".taskmaster/tasks/tasks.json", cwd)).toBe(true);
  });

  it("returns true for a staged modification", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    git(["add", "."], cwd);
    git(["commit", "-m", "add tasks"], cwd);
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      '{"tasks":[{"id":1}]}',
    );
    git(["add", ".taskmaster/tasks/tasks.json"], cwd);
    expect(isPathDirty(".taskmaster/tasks/tasks.json", cwd)).toBe(true);
  });

  it("returns true for an untracked file", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    expect(isPathDirty(".taskmaster/tasks/tasks.json", cwd)).toBe(true);
  });

  it("returns false when a different file is dirty but the target is clean", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    git(["add", "."], cwd);
    git(["commit", "-m", "add tasks"], cwd);
    writeFileSync(join(cwd, "other.txt"), "dirty");
    expect(isPathDirty(".taskmaster/tasks/tasks.json", cwd)).toBe(false);
  });

  it("returns false for non-git directory", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "prorab-non-git-"));
    writeTasksJson(nonGit, '{"tasks":[]}');
    expect(isPathDirty(".taskmaster/tasks/tasks.json", nonGit)).toBe(false);
    rmSync(nonGit, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// commitExpandedTask
// ---------------------------------------------------------------------------

describe("commitExpandedTask", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = setupGitRepo();
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("commits tasks.json with the expand message", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    git(["add", "."], cwd);
    git(["commit", "-m", "initial tasks"], cwd);
    // Modify the file to simulate expand write
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      '{"tasks":[{"id":1,"subtasks":[{"id":1},{"id":2},{"id":3}]}]}',
    );
    commitExpandedTask(cwd, "1", 3);

    const log = git(["log", "--oneline", "-1"], cwd);
    expect(log).toContain("prorab: expand task 1 into 3 subtasks");
  });

  it("only commits tasks.json, not other staged files", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    writeFileSync(join(cwd, "unrelated.txt"), "initial");
    git(["add", "."], cwd);
    git(["commit", "-m", "initial tasks"], cwd);
    // Modify tasks.json and stage another file
    writeFileSync(
      join(cwd, ".taskmaster", "tasks", "tasks.json"),
      '{"tasks":[{"id":1,"subtasks":[{"id":1}]}]}',
    );
    writeFileSync(join(cwd, "unrelated.txt"), "dirty data");
    git(["add", "unrelated.txt"], cwd);
    commitExpandedTask(cwd, "1", 1);

    // unrelated.txt should still be staged (not committed)
    const status = git(["status", "--porcelain"], cwd);
    expect(status).toContain("unrelated.txt");
  });

  it("does nothing when tasks.json has no changes", () => {
    writeTasksJson(cwd, '{"tasks":[]}');
    git(["add", "."], cwd);
    git(["commit", "-m", "initial tasks"], cwd);
    const logBefore = git(["log", "--oneline"], cwd);
    commitExpandedTask(cwd, "1", 0);
    const logAfter = git(["log", "--oneline"], cwd);
    expect(logAfter).toBe(logBefore);
  });

  it("throws on git error (non-git directory)", () => {
    const nonGit = mkdtempSync(join(tmpdir(), "prorab-non-git-"));
    writeTasksJson(nonGit, '{"tasks":[]}');
    expect(() => commitExpandedTask(nonGit, "1", 1)).toThrow();
    rmSync(nonGit, { recursive: true, force: true });
  });
});
