import { execFileSync } from "node:child_process";
import { LOCK_FILENAME, ensureLockInGitignore } from "./lock.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
}

/** Get current HEAD revision (full SHA). Returns null on failure (e.g. git error). */
export function getHeadRev(cwd: string): string | null {
  try {
    return git(["rev-parse", "HEAD"], cwd);
  } catch {
    return null;
  }
}

/**
 * Get list of commits from `fromRev` (exclusive) to HEAD (inclusive).
 * Returns array of "shortsha message" strings, oldest first.
 * Returns empty array on failure (e.g. git error).
 */
export function getCommitsBetween(cwd: string, fromRev: string): string[] {
  try {
    const output = git(
      ["log", "--oneline", "--reverse", `${fromRev}..HEAD`],
      cwd,
    );
    if (!output) return [];
    return output.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

export function isGitRepo(cwd: string): boolean {
  try {
    git(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

export function isTrackedByGit(filePath: string, cwd: string): boolean {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", filePath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function hasUncommittedChangesExcluding(
  cwd: string,
  excludePattern: string,
): boolean {
  const output = git(["status", "--porcelain"], cwd);
  const lines = output.split("\n").filter((l) => l.trim() !== "");
  const relevant = lines.filter(
    (line) => !line.substring(3).startsWith(excludePattern),
  );
  return relevant.length > 0;
}

export function autoCommit(cwd: string, title: string): boolean {
  if (!hasUncommittedChangesExcluding(cwd, ".taskmaster/")) {
    return false;
  }
  git(["add", "."], cwd);
  // Unstage .taskmaster/ if staged
  try {
    git(["reset", "HEAD", "--", ".taskmaster/"], cwd);
  } catch {
    // .taskmaster/ might not be staged, ignore
  }
  // Check if anything remains staged
  const staged = git(["diff", "--cached", "--name-only"], cwd);
  if (!staged) {
    return false;
  }
  git(
    ["commit", "-m", `prorab: auto-commit for task "${title}"`],
    cwd,
  );
  return true;
}

/**
 * Post-agent guard: ensure the lock file is not tracked, staged, or missing from .gitignore.
 * Call after agent session but before autoCommit/commitTaskmaster.
 */
export function ensureLockNotTracked(cwd: string): void {
  const lockRel = `.taskmaster/${LOCK_FILENAME}`;

  // 1. Restore .gitignore pattern if agent removed it
  ensureLockInGitignore(cwd);

  // 2. Remove from git tracking if agent committed it
  if (isTrackedByGit(lockRel, cwd)) {
    try {
      git(["rm", "--cached", "--", lockRel], cwd);
    } catch {
      // may fail if file doesn't exist on disk — that's fine
    }
    return; // git rm --cached stages deletion; don't reset it
  }

  // 3. Unstage if agent staged it (but not yet committed)
  try {
    git(["reset", "HEAD", "--", lockRel], cwd);
  } catch {
    // not staged — ignore
  }
}

/**
 * Check if the agent modified .taskmaster/ files in its commits.
 * If so, restore .taskmaster/ to the state it was at `beforeRev` and
 * amend the commits to exclude those changes.
 *
 * Strategy: check if .taskmaster/ differs between beforeRev and HEAD.
 * If it does, restore .taskmaster/ from beforeRev and commit the restoration.
 * This is simpler and safer than rewriting history.
 */
export function restoreTaskmasterIfTouched(cwd: string, beforeRev: string): boolean {
  try {
    // Check if .taskmaster/ was changed between beforeRev and HEAD
    const diff = git(
      ["diff", "--name-only", beforeRev, "HEAD", "--", ".taskmaster/"],
      cwd,
    );
    if (!diff) return false;

    const changedFiles = diff.split("\n").filter((l) => l.trim() !== "");
    if (changedFiles.length === 0) return false;

    // Restore .taskmaster/ from beforeRev
    git(["checkout", beforeRev, "--", ".taskmaster/"], cwd);

    // Commit the restoration
    git(["add", ".taskmaster/"], cwd);
    const staged = git(["diff", "--cached", "--name-only", "--", ".taskmaster/"], cwd);
    if (staged) {
      git(
        ["commit", "-m", "prorab: revert agent modifications to .taskmaster/"],
        cwd,
      );
    }

    console.error(
      `  [warning] Agent modified .taskmaster/ files (${changedFiles.join(", ")}). Changes reverted.`,
    );
    return true;
  } catch {
    return false;
  }
}

export function commitTaskmaster(cwd: string, message: string): boolean {
  // Stage all .taskmaster/ changes (reports, tasks.json, etc.)
  try {
    git(["add", ".taskmaster/"], cwd);
  } catch {
    return false;
  }
  // Unstage lock file — it's a runtime artifact, must never be committed
  try {
    git(["reset", "HEAD", "--", `.taskmaster/${LOCK_FILENAME}`], cwd);
  } catch {
    // Lock file might not be staged — ignore
  }
  const staged = git(["diff", "--cached", "--name-only", "--", ".taskmaster/"], cwd);
  if (!staged) {
    return false;
  }
  git(["commit", "-m", message, "--", ".taskmaster/"], cwd);
  return true;
}

/**
 * Commit only .taskmaster/tasks/tasks.json with the given message.
 * Used by the web UI after task edits to keep git clean.
 * Returns false if nothing to commit or not a git repo.
 */
export function commitTasksJson(cwd: string, message: string): boolean {
  try {
    const tasksFile = ".taskmaster/tasks/tasks.json";
    git(["add", "--", tasksFile], cwd);
    const staged = git(["diff", "--cached", "--name-only", "--", tasksFile], cwd);
    if (!staged) return false;
    git(["commit", "-m", message, "--", tasksFile], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit `.gitignore` and `.taskmaster/tasks/tasks.json` after a successful
 * parse-prd session.  Best-effort: returns false on any git failure.
 *
 * Stages each file separately because `git add` is atomic per invocation —
 * if one pathspec fails, nothing in that call gets staged.
 *
 * Builds commit pathspec dynamically from staged output so that an
 * unstaged/untracked `.gitignore` does not cause `git commit` to fail.
 * On any commit failure, unstages both files to prevent `isPathDirty()`
 * from blocking downstream operations (e.g. expand).
 */
export function commitParsePrdResult(cwd: string): boolean {
  try {
    try { git(["add", "--", ".gitignore"], cwd); } catch { /* .gitignore may not exist */ }
    git(["add", "--", ".taskmaster/tasks/tasks.json"], cwd);
    const staged = git(["diff", "--cached", "--name-only", "--", ".gitignore", ".taskmaster/tasks/tasks.json"], cwd);
    if (!staged) return false;
    const paths = staged.split("\n").filter(Boolean);
    git(["commit", "-m", "prorab: initialize tasks from PRD", "--", ...paths], cwd);
    return true;
  } catch {
    try { git(["reset", "HEAD", "--", ".gitignore", ".taskmaster/tasks/tasks.json"], cwd); } catch { /* ignore */ }
    return false;
  }
}

/**
 * Check if git user identity (user.name and user.email) is configured.
 * Both must be set and non-empty for git commit to succeed.
 */
export function hasGitIdentity(cwd: string): boolean {
  try {
    const name = git(["config", "user.name"], cwd);
    const email = git(["config", "user.email"], cwd);
    return name.length > 0 && email.length > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a specific path has staged or unstaged changes.
 * Uses `git status --porcelain -- <path>` for a targeted single-path check.
 */
export function isPathDirty(filePath: string, cwd: string): boolean {
  try {
    const output = git(["status", "--porcelain", "--", filePath], cwd);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Commit only `.taskmaster/tasks/tasks.json` after a successful expand write.
 *
 * Unlike `commitTasksJson()` which silently returns false on failure,
 * this function **throws** on git errors so the caller can distinguish
 * a write-success + commit-failure scenario (reason: "commit_failed_after_write").
 *
 * Does nothing if the file has no staged diff after `git add` (should not
 * happen when subtasks are non-empty, but guards defensively).
 */
export function commitExpandedTask(
  cwd: string,
  taskId: string,
  subtaskCount: number,
): void {
  const tasksFile = ".taskmaster/tasks/tasks.json";
  git(["add", "--", tasksFile], cwd);
  const staged = git(
    ["diff", "--cached", "--name-only", "--", tasksFile],
    cwd,
  );
  if (!staged) return; // nothing to commit
  git(
    [
      "commit",
      "-m",
      `prorab: expand task ${taskId} into ${subtaskCount} subtasks`,
      "--",
      tasksFile,
    ],
    cwd,
  );
}

/**
 * Commit `.taskmaster/tasks/tasks.json` after writing complexity fields.
 *
 * Similar to `commitExpandedTask()` — throws on git errors so the caller
 * can detect commit failures. Used inside `withTasksMutex` in the batch
 * pipeline to prevent git index.lock collisions between parallel workers.
 */
export function commitComplexityFields(
  cwd: string,
  taskId: string,
): void {
  const tasksFile = ".taskmaster/tasks/tasks.json";
  git(["add", "--", tasksFile], cwd);
  const staged = git(
    ["diff", "--cached", "--name-only", "--", tasksFile],
    cwd,
  );
  if (!staged) return; // nothing to commit
  git(
    [
      "commit",
      "-m",
      `prorab: complexity analysis for task ${taskId}`,
      "--",
      tasksFile,
    ],
    cwd,
  );
}
