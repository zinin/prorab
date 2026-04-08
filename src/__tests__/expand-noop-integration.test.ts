/**
 * Expand no-op integration tests (REQ-005, Part 2).
 *
 * Separated from `expand-noop-success.test.ts` so that its top-level
 * `vi.mock("../core/tasks-json-hash.js")` does not leak into these tests.
 *
 * Everything here uses real production code — no mocks for hash, validation,
 * or file I/O:
 *
 * 1. Real `snapshotTasksJsonHash` / `verifyTasksJsonHash` (SHA-256 on disk).
 * 2. Real `parseExpandResult` / `validateExpandResult` (Zod schema).
 * 3. Real `writeExpandSubtasks` with empty subtasks on disk.
 * 4. Raw `Buffer` comparison for byte-identical verification.
 *
 * Follows the pattern established by `expand-no-write-integration.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  snapshotTasksJsonHash,
  verifyTasksJsonHash,
} from "../core/tasks-json-hash.js";
import {
  parseExpandResult,
  validateExpandResult,
} from "../core/expand-validation.js";
import { writeExpandSubtasks } from "../core/tasks-json.js";

// ---------------------------------------------------------------------------
// A realistic tasks.json fixture.
// Uses trailing newline (`+ "\n"`) to match `mutateTasksFile`'s output format,
// so byte comparison after writeExpandSubtasks is meaningful.
// ---------------------------------------------------------------------------

const sampleTasksJson =
  JSON.stringify(
    {
      tasks: [
        {
          id: 1,
          title: "Test task for no-op expand",
          description: "A task that is atomic and cannot be decomposed",
          status: "pending",
          priority: "medium",
          dependencies: [],
          details: "This task is already atomic",
          testStrategy: "Direct testing",
          subtasks: [],
        },
      ],
      metadata: {},
    },
    null,
    2,
  ) + "\n";

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Expand no-op integration (real file I/O, no mocks)", () => {
  let tmpDir: string;
  let tasksJsonPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prorab-noop-int-"));
    const tasksDir = join(tmpDir, ".taskmaster", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    tasksJsonPath = join(tasksDir, "tasks.json");
    writeFileSync(tasksJsonPath, sampleTasksJson);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. Validation pipeline: { subtasks: [] } passes real Zod schema
  // =========================================================================

  describe("validation pipeline with real functions", () => {
    it("parseExpandResult accepts { subtasks: [] } (real Zod)", () => {
      const result = parseExpandResult('{"subtasks": []}');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.subtasks).toEqual([]);
      }
    });

    it("validateExpandResult accepts { subtasks: [] } (real Zod)", () => {
      const result = validateExpandResult({ subtasks: [] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.subtasks).toEqual([]);
      }
    });

    it("validation result has no failure fields (distinct from failure)", () => {
      const result = parseExpandResult('{"subtasks": []}');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result).not.toHaveProperty("reason");
        expect(result).not.toHaveProperty("errors");
      }
    });
  });

  // =========================================================================
  // 2. Hash functions on real files (no mocks)
  // =========================================================================

  describe("real SHA-256 hash functions on disk", () => {
    it("hash snapshot + verify round-trips correctly", () => {
      const hash = snapshotTasksJsonHash(tmpDir);
      expect(hash).not.toBeNull();
      expect(verifyTasksJsonHash(tmpDir, hash!)).toBe(true);
    });

    it("consecutive snapshots produce identical hashes (no file mutation)", () => {
      const hash1 = snapshotTasksJsonHash(tmpDir);
      const hash2 = snapshotTasksJsonHash(tmpDir);
      expect(hash2).toBe(hash1);
    });

    it("hash changes when file is mutated externally", () => {
      const hash = snapshotTasksJsonHash(tmpDir);
      writeFileSync(tasksJsonPath, sampleTasksJson + " ");
      expect(verifyTasksJsonHash(tmpDir, hash!)).toBe(false);
    });
  });

  // =========================================================================
  // 3. writeExpandSubtasks with empty array on real file
  // =========================================================================

  describe("writeExpandSubtasks with [] on real file", () => {
    it("file is byte-identical after writeExpandSubtasks(cwd, '1', [])", () => {
      const contentBefore = readFileSync(tasksJsonPath);
      const hash = snapshotTasksJsonHash(tmpDir);

      // Call the real writeExpandSubtasks with empty subtasks.
      // This exercises the actual production code path: mutateTasksFile
      // reads the file, sets task.subtasks = [], and writes back.
      // Since subtasks was already [], the serialized output should be
      // byte-identical.
      writeExpandSubtasks(tmpDir, "1", []);

      const contentAfter = readFileSync(tasksJsonPath);
      expect(Buffer.compare(contentBefore, contentAfter)).toBe(0);
      // Hash still matches — file content hasn't changed
      expect(verifyTasksJsonHash(tmpDir, hash!)).toBe(true);
    });

    it("task data is unchanged after writeExpandSubtasks with []", () => {
      writeExpandSubtasks(tmpDir, "1", []);

      const content = readFileSync(tasksJsonPath, "utf-8");
      const data = JSON.parse(content);
      const task = data.tasks[0];

      expect(task.subtasks).toEqual([]);
      expect(task.status).toBe("pending");
      expect(task.id).toBe(1);
      // No marker fields injected
      expect(task).not.toHaveProperty("expanded");
      expect(task).not.toHaveProperty("expandedAt");
      expect(task).not.toHaveProperty("expandResult");
    });

    it("hash is stable across validation + write with empty subtasks", () => {
      // Full no-op pipeline: validate → check hash → write (empty) → verify hash
      const hash = snapshotTasksJsonHash(tmpDir);

      // Step 1: validate the agent result (real Zod)
      const parseResult = parseExpandResult('{"subtasks": []}');
      expect(parseResult.ok).toBe(true);

      // Step 2: write empty subtasks (real file I/O)
      if (parseResult.ok) {
        writeExpandSubtasks(tmpDir, "1", parseResult.data.subtasks);
      }

      // Step 3: verify hash still matches (real SHA-256)
      expect(verifyTasksJsonHash(tmpDir, hash!)).toBe(true);

      // Step 4: file content is byte-identical
      const contentAfter = readFileSync(tasksJsonPath, "utf-8");
      expect(contentAfter).toBe(sampleTasksJson);
    });
  });

  // =========================================================================
  // 4. Re-expand eligibility: file state after no-op allows another expand
  // =========================================================================

  describe("re-expand eligibility after no-op (real file state)", () => {
    it("task remains pending with empty subtasks — eligible for re-expand", () => {
      writeExpandSubtasks(tmpDir, "1", []);

      const data = JSON.parse(readFileSync(tasksJsonPath, "utf-8"));
      const task = data.tasks[0];

      expect(task.status).toBe("pending");
      expect(task.subtasks).toEqual([]);
      // Route-level eligibility checks: status === "pending" && no subtasks
    });

    it("hash snapshot after no-op works for the next expand session", () => {
      // First session: no-op
      const hash1 = snapshotTasksJsonHash(tmpDir);
      writeExpandSubtasks(tmpDir, "1", []);
      expect(verifyTasksJsonHash(tmpDir, hash1!)).toBe(true);

      // Second session: can snapshot and verify again
      const hash2 = snapshotTasksJsonHash(tmpDir);
      expect(hash2).toBe(hash1); // Same content → same hash
      expect(verifyTasksJsonHash(tmpDir, hash2!)).toBe(true);
    });
  });
});
