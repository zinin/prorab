import {
  readFileSync, writeFileSync, unlinkSync, existsSync, appendFileSync,
  readlinkSync, realpathSync,
} from "node:fs";
import { uptime as osUptime } from "node:os";
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

function getBootTime(): number | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync("/proc/stat", "utf-8");
      const m = stat.match(/^btime\s+(\d+)$/m);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      // fall through to cross-platform fallback
    }
  }
  try {
    const uptimeSec = osUptime();
    if (Number.isFinite(uptimeSec) && uptimeSec > 0) {
      return Math.floor(Date.now() / 1000 - uptimeSec);
    }
  } catch {
    // fall through to null
  }
  return null;
}

type OwnershipResult =
  | "owns"      // PID is alive, Tgid matches, cwd matches → throw (real conflict)
  | "stranger"  // PID is alive but is a thread or its cwd differs → overwrite (PID reuse)
  | "died"      // /proc/<pid>/... ENOENT after a successful kill(0) → owner exited mid-check
  | "unknown";  // non-Linux, EACCES, missing Tgid, etc. → conservative throw

function isOwningProcess(pid: number, lockedCwd: string): OwnershipResult {
  if (process.platform !== "linux") return "unknown";

  // Resolve lockedCwd up front, OUTSIDE the /proc try/catch, so an ENOENT on
  // lockedCwd itself is not misinterpreted as "/proc/<pid>/... vanished".
  let lockedReal: string;
  try {
    lockedReal = realpathSync(lockedCwd);
  } catch {
    return "unknown";
  }

  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf-8");
    const tgidMatch = status.match(/^Tgid:\s*(\d+)\s*$/m);
    if (!tgidMatch) return "unknown";                  // missing field → cannot tell
    if (Number(tgidMatch[1]) !== pid) return "stranger";  // thread, not the owning process

    // Known limitation: string-equality cwd comparison can produce
    // false negatives under bind mounts or path aliases (e.g. /projects/foo
    // bind-mounted to /srv/foo), and false positives if prorab ever calls
    // process.chdir() at runtime (currently it does not).  st_dev+st_ino
    // comparison would be more robust — left as future hardening; the
    // conservative-throw fallback ensures we never silently steal in the
    // unknown case.
    const procCwd = readlinkSync(`/proc/${pid}/cwd`);
    return procCwd === lockedReal ? "owns" : "stranger";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "died";
    return "unknown";
  }
}

const LOCK_ACQUIRE_MAX_ATTEMPTS = 3;

export function acquireLock(cwd: string): void {
  const path = lockPath(cwd);
  const newContent = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

  for (let attempt = 0; attempt < LOCK_ACQUIRE_MAX_ATTEMPTS; attempt++) {
    // Atomic exclusive create — POSIX O_EXCL via Node's "wx" flag.  Fails
    // with EEXIST if the file already exists.  This is the only point where
    // ownership of the lock is established; two concurrent acquirers cannot
    // both succeed here.
    try {
      writeFileSync(path, newContent, { flag: "wx" });
      ensureLockInGitignore(cwd);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // EEXIST — read the existing lock, classify, decide.
    let data: { pid: number; startedAt: string } | undefined;
    try {
      const raw = readFileSync(path, "utf-8");
      data = JSON.parse(raw) as { pid: number; startedAt: string };
    } catch {
      console.warn("Warning: removing corrupt lock file.");
      removeLockIgnoreMissing(path);
      continue;
    }

    // Self-pid short-circuit runs FIRST, before the btime gate, so that a
    // wall-clock jump (NTP correction, manual adjustment) cannot drag the
    // os.uptime() fallback's bootSec past our own startedAt and falsely
    // classify our own live lock as predating boot.  Trade-off: a post-reboot
    // stale lock whose dead writer's PID coincidentally matches ours (≈1/65536
    // per reboot) will now throw instead of being auto-cleaned — operators can
    // manually remove the lock file in that case.
    if (data.pid === process.pid) {
      throw new Error(
        `Another prorab instance is already running (PID ${data.pid}, started ${data.startedAt}).\n` +
        `Stop it first or remove .taskmaster/${LOCK_FILENAME} if the process is dead.`
      );
    }

    const bootSec = getBootTime();
    const startedSec = Date.parse(data.startedAt) / 1000;

    if (bootSec !== null && Number.isFinite(startedSec) && startedSec < bootSec) {
      console.warn(
        `Warning: removing stale lock (PID was ${data.pid}, predates boot — ` +
        `startedAt=${data.startedAt}, boot=${new Date(bootSec * 1000).toISOString()}).`
      );
    } else if (!isProcessAlive(data.pid)) {
      console.warn(`Warning: removing stale lock (PID was ${data.pid}, process is gone).`);
    } else {
      const ownership = isOwningProcess(data.pid, cwd);
      if (ownership === "stranger") {
        console.warn(`Warning: removing stale lock (PID was ${data.pid}, reused by non-prorab process).`);
      } else if (ownership === "died") {
        console.warn(`Warning: removing stale lock (PID was ${data.pid}, owner exited during ownership check).`);
      } else {
        // "owns" (real conflict) or "unknown" (cannot verify) → conservative throw.
        throw new Error(
          `Another prorab instance is already running (PID ${data.pid}, started ${data.startedAt}).\n` +
          `Stop it first or remove .taskmaster/${LOCK_FILENAME} if the process is dead.`
        );
      }
    }

    // Stale → remove and retry the exclusive create.  If a concurrent acquirer
    // unlinked first, our unlink ENOENTs harmlessly; if a concurrent acquirer
    // wins the next exclusive create, our retry will EEXIST and re-evaluate
    // against their fresh lock (typically resolving to "owns" → throw).
    removeLockIgnoreMissing(path);
  }

  throw new Error(
    `Failed to acquire lock at ${path} after ${LOCK_ACQUIRE_MAX_ATTEMPTS} attempts (concurrent contention).`
  );
}

function removeLockIgnoreMissing(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
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
