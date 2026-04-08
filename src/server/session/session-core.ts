import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, releaseLock } from "../../core/lock.js";

/** Session lifecycle states. */
export type SessionState = "idle" | "active" | "stopping";

/** Options for acquiring a session. */
export interface AcquireOptions {
  /** When true, skip file-lock acquisition (e.g. if the caller already holds the lock). */
  skipLock?: boolean;
}

/** Public contract for SessionCore — useful for testing and dependency injection. */
export interface SessionCoreInterface {
  readonly state: SessionState;
  readonly cwd: string;
  acquire(options?: AcquireOptions): void;
  release(): void;
  abort(): void;
  isActive(): boolean;
  isStopping(): boolean;
  isIdle(): boolean;
  getAbortSignal(): AbortSignal | undefined;
  registerAbortHandler(fn: () => void): () => void;
}

/**
 * Manages session lifecycle: state machine (idle → active → stopping),
 * file-based mutex via acquireLock/releaseLock, and AbortController.
 *
 * Guarantees only one active session at a time — acquire() throws if
 * the session is not idle.
 */
export class SessionCore implements SessionCoreInterface {
  private _state: SessionState = "idle";
  private abortController: AbortController | null = null;
  readonly cwd: string;
  private lockAcquired = false;
  private _pendingAbortHandlers: Array<() => void> = [];

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  get state(): SessionState {
    return this._state;
  }

  /**
   * Transition to active state: bootstrap .taskmaster/ directory,
   * acquire the file lock (unless skipLock), and create a fresh AbortController.
   *
   * @param options.skipLock — when true, skip file-lock acquisition
   *   (e.g. if the caller already holds the lock).
   * @throws if the session is not idle or the lock is held by another process.
   */
  acquire(options?: AcquireOptions): void {
    if (this._state !== "idle") {
      throw new Error(`Cannot acquire: session is ${this._state}`);
    }

    if (!options?.skipLock) {
      // Bootstrap .taskmaster/ so the lock file can be written
      const taskmasterDir = join(this.cwd, ".taskmaster");
      if (!existsSync(taskmasterDir)) {
        mkdirSync(taskmasterDir, { recursive: true });
      }

      acquireLock(this.cwd);
      this.lockAcquired = true;
    }

    this._state = "active";
    this.abortController = new AbortController();

    // Register any handlers that were queued before the session was active
    for (const fn of this._pendingAbortHandlers) {
      this.abortController.signal.addEventListener("abort", fn, { once: true });
    }
    this._pendingAbortHandlers = [];
  }

  /**
   * Release the file lock (if held) and reset to idle.
   */
  release(): void {
    if (this.lockAcquired) {
      releaseLock(this.cwd);
      this.lockAcquired = false;
    }
    this._state = "idle";
    this.abortController = null;
  }

  /**
   * Signal abort and transition to stopping.
   *
   * Safe to call in any state — designed for signal handlers (e.g. SIGINT)
   * that may fire regardless of session lifecycle:
   *
   * - **active**: signals the AbortController, transitions to stopping.
   * - **idle**: transitions to stopping without side-effects (no controller
   *   to signal, no lock to release). Caller must invoke `release()` to
   *   return to idle.
   * - **stopping**: no-op (already stopping).
   */
  abort(): void {
    this._state = "stopping";
    this.abortController?.abort();
  }

  isActive(): boolean {
    return this._state === "active";
  }

  isStopping(): boolean {
    return this._state === "stopping";
  }

  isIdle(): boolean {
    return this._state === "idle";
  }

  /**
   * Returns the AbortSignal for the current session, or undefined if idle.
   */
  getAbortSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }

  /**
   * Register a callback to be invoked when the session is aborted.
   *
   * Returns a cleanup function that removes the handler — callers should
   * invoke it when the handler is no longer needed (e.g. after a task
   * completes normally) to prevent listener accumulation across iterations.
   *
   * - **Active session (not yet aborted):** handler is registered immediately
   *   on the AbortController's signal.
   * - **Stopping session (already aborted):** handler is invoked synchronously,
   *   since the abort event has already fired and won't replay.
   * - **Idle session (no AbortController):** handler is queued and will be
   *   registered when acquire() creates a new AbortController.
   */
  registerAbortHandler(fn: () => void): () => void {
    if (this.abortController) {
      if (this.abortController.signal.aborted) {
        // Signal already aborted (stopping state) — invoke immediately
        // so the handler is not silently lost.
        fn();
        return () => {}; // already fired, nothing to clean up
      } else {
        this.abortController.signal.addEventListener("abort", fn, { once: true });
        const signal = this.abortController.signal;
        return () => { signal.removeEventListener("abort", fn); };
      }
    } else {
      this._pendingAbortHandlers.push(fn);
      return () => {
        const idx = this._pendingAbortHandlers.indexOf(fn);
        if (idx !== -1) this._pendingAbortHandlers.splice(idx, 1);
      };
    }
  }
}
