import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getHeadRev, getCommitsBetween } from "../core/git.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("getHeadRev", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prorab-git-test-"));
    git(["init"], tempDir);
    git(["config", "user.email", "test@test.com"], tempDir);
    git(["config", "user.name", "Test"], tempDir);
    writeFileSync(join(tempDir, "file.txt"), "init");
    git(["add", "."], tempDir);
    git(["commit", "-m", "initial"], tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns current HEAD sha", () => {
    const rev = getHeadRev(tempDir);
    const expected = git(["rev-parse", "HEAD"], tempDir);
    expect(rev).toBe(expected);
    expect(rev).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns null for non-git directory", () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "prorab-non-git-"));
    expect(getHeadRev(nonGitDir)).toBeNull();
    rmSync(nonGitDir, { recursive: true, force: true });
  });
});

describe("getCommitsBetween", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "prorab-git-test-"));
    git(["init"], tempDir);
    git(["config", "user.email", "test@test.com"], tempDir);
    git(["config", "user.name", "Test"], tempDir);
    writeFileSync(join(tempDir, "file.txt"), "init");
    git(["add", "."], tempDir);
    git(["commit", "-m", "initial commit"], tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns commits between two revisions", () => {
    const before = git(["rev-parse", "HEAD"], tempDir);
    writeFileSync(join(tempDir, "a.txt"), "a");
    git(["add", "."], tempDir);
    git(["commit", "-m", "feat: add file a"], tempDir);
    writeFileSync(join(tempDir, "b.txt"), "b");
    git(["add", "."], tempDir);
    git(["commit", "-m", "feat: add file b"], tempDir);

    const commits = getCommitsBetween(tempDir, before);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatch(/^[0-9a-f]{7,} feat: add file a$/);
    expect(commits[1]).toMatch(/^[0-9a-f]{7,} feat: add file b$/);
  });

  it("returns empty array when no new commits", () => {
    const before = git(["rev-parse", "HEAD"], tempDir);
    const commits = getCommitsBetween(tempDir, before);
    expect(commits).toEqual([]);
  });
});
