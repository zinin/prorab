import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ensureLockNotTracked } from "../core/git.js";
import { LOCK_FILENAME, ensureLockInGitignore } from "../core/lock.js";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "prorab-git-test-"));
  git(["init"], dir);
  git(["config", "user.email", "test@test.com"], dir);
  git(["config", "user.name", "Test"], dir);
  mkdirSync(join(dir, ".taskmaster"), { recursive: true });
  // Initial commit so HEAD exists
  writeFileSync(join(dir, "README.md"), "init");
  git(["add", "README.md"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

describe("ensureLockNotTracked", () => {
  let repo: string;
  const lockRel = `.taskmaster/${LOCK_FILENAME}`;

  beforeEach(() => {
    repo = makeGitRepo();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("restores .gitignore pattern if agent removed it", () => {
    // Set up .gitignore with pattern, then remove it (simulating agent)
    ensureLockInGitignore(repo);
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    expect(readFileSync(join(repo, ".gitignore"), "utf-8")).not.toContain(LOCK_FILENAME);

    ensureLockNotTracked(repo);
    expect(readFileSync(join(repo, ".gitignore"), "utf-8")).toContain(LOCK_FILENAME);
  });

  it("stages lock file removal if agent committed it", () => {
    // Simulate agent committing the lock file
    const lockPath = join(repo, lockRel);
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    git(["add", "-f", lockRel], repo);
    git(["commit", "-m", "agent committed lock"], repo);

    // Verify it's tracked
    const tracked = git(["ls-files", lockRel], repo);
    expect(tracked).toContain(LOCK_FILENAME);

    ensureLockNotTracked(repo);

    // Should have staged a deletion (git rm --cached)
    const staged = git(["diff", "--cached", "--name-only", "--diff-filter=D"], repo);
    expect(staged).toContain(LOCK_FILENAME);

    // After committing the deletion, file should no longer be tracked
    git(["commit", "-m", "remove lock from tracking"], repo);
    const trackedAfter = git(["ls-files", lockRel], repo);
    expect(trackedAfter).toBe("");
  });

  it("unstages lock file if agent staged it", () => {
    const lockPath = join(repo, lockRel);
    writeFileSync(lockPath, JSON.stringify({ pid: 1, startedAt: "x" }));
    git(["add", "-f", lockRel], repo);

    // Verify it's staged
    const staged = git(["diff", "--cached", "--name-only"], repo);
    expect(staged).toContain(LOCK_FILENAME);

    ensureLockNotTracked(repo);

    // Should no longer be staged
    const stagedAfter = git(["diff", "--cached", "--name-only"], repo);
    expect(stagedAfter).not.toContain(LOCK_FILENAME);
  });

  it("is idempotent — safe to call when lock is already clean", () => {
    ensureLockInGitignore(repo);
    expect(() => ensureLockNotTracked(repo)).not.toThrow();
  });
});
