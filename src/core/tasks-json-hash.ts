/**
 * Hash-based conflict detection for tasks.json.
 *
 * Provides functions to snapshot and verify the SHA-256 hash of the entire
 * tasks.json file. Used by ExpandManager (and potentially other pipelines)
 * to detect concurrent mutations between a read phase and a write phase.
 *
 * Design decisions:
 * - Operates on the raw file content (Buffer), not the parsed JSON.
 *   This ensures that whitespace changes, key reordering, or edits in
 *   inactive tags of a multi-tag file are all detected.
 * - Uses `crypto.createHash("sha256")` per the spec — no mtime heuristics.
 * - Returns `null` (not throw) when the file doesn't exist, so callers
 *   can distinguish "file missing" from "file changed".
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { getTasksPath } from "./tasks-json.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the SHA-256 hex digest of the raw tasks.json file.
 *
 * @param cwd - Project root directory.
 * @returns Hex digest string, or `null` if the file does not exist.
 */
export function snapshotTasksJsonHash(cwd: string): string | null {
  try {
    const buf = readFileSync(getTasksPath(cwd));
    return createHash("sha256").update(buf).digest("hex");
  } catch (err: unknown) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Verify that the current tasks.json hash matches a previously captured snapshot.
 *
 * @param cwd - Project root directory.
 * @param expectedHash - The hash captured at snapshot time.
 * @returns `true` if the file exists and its hash matches `expectedHash`.
 *          `false` if the hash differs or the file no longer exists.
 */
export function verifyTasksJsonHash(
  cwd: string,
  expectedHash: string,
): boolean {
  const currentHash = snapshotTasksJsonHash(cwd);
  if (currentHash === null) return false; // file deleted → conflict
  return currentHash === expectedHash;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
