import { readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILENAME = "prorab.lock";

function lockPath(cwd: string): string {
  return join(cwd, ".taskmaster", LOCK_FILENAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but belongs to another user
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

export function acquireLock(cwd: string): void {
  const path = lockPath(cwd);

  if (existsSync(path)) {
    let data: { pid: number; startedAt: string } | undefined;
    try {
      const raw = readFileSync(path, "utf-8");
      data = JSON.parse(raw) as { pid: number; startedAt: string };
    } catch {
      console.warn("Warning: removing corrupt lock file.");
    }

    if (data) {
      if (isProcessAlive(data.pid)) {
        throw new Error(
          `Another prorab instance is already running (PID ${data.pid}, started ${data.startedAt}).\n` +
          `Stop it first or remove .taskmaster/${LOCK_FILENAME} if the process is dead.`
        );
      }

      console.warn(`Warning: removing stale lock (PID was ${data.pid}).`);
    }
  }

  writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

  ensureLockInGitignore(cwd);
}

const GITIGNORE_PATTERN = `.taskmaster/${LOCK_FILENAME}`;

/** Ensure .taskmaster/prorab.lock is listed in the target project's .gitignore. */
export function ensureLockInGitignore(cwd: string): void {
  const gitignorePath = join(cwd, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (content.includes(GITIGNORE_PATTERN)) return;
    const newline = content.endsWith("\n") ? "" : "\n";
    appendFileSync(gitignorePath, `${newline}${GITIGNORE_PATTERN}\n`);
  } else {
    writeFileSync(gitignorePath, `${GITIGNORE_PATTERN}\n`);
  }
}

export function releaseLock(cwd: string): void {
  const path = lockPath(cwd);

  if (!existsSync(path)) return;

  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as { pid: number; startedAt: string };
    if (data.pid !== process.pid) return;
  } catch {
    // Corrupt lock file — safe to remove
  }

  try {
    unlinkSync(path);
  } catch {
    // File may have been removed between check and unlink — ignore
  }
}
