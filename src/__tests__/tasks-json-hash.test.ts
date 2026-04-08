import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  snapshotTasksJsonHash,
  verifyTasksJsonHash,
} from "../core/tasks-json-hash.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tasksJsonPath(cwd: string): string {
  return join(cwd, ".taskmaster", "tasks", "tasks.json");
}

function sha256(content: string): string {
  return createHash("sha256").update(Buffer.from(content)).digest("hex");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("tasks-json-hash", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prorab-hash-test-"));
    mkdirSync(join(tmpDir, ".taskmaster", "tasks"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // snapshotTasksJsonHash
  // =========================================================================

  describe("snapshotTasksJsonHash", () => {
    it("returns SHA-256 hex digest of file content", () => {
      const content = '{"tasks":[],"metadata":{}}';
      writeFileSync(tasksJsonPath(tmpDir), content);

      const hash = snapshotTasksJsonHash(tmpDir);
      expect(hash).toBe(sha256(content));
    });

    it("returns null when file does not exist", () => {
      // Don't write anything — file is missing
      const hash = snapshotTasksJsonHash(tmpDir);
      expect(hash).toBeNull();
    });

    it("returns different hash for different content", () => {
      writeFileSync(tasksJsonPath(tmpDir), '{"tasks":[]}');
      const hash1 = snapshotTasksJsonHash(tmpDir);

      writeFileSync(tasksJsonPath(tmpDir), '{"tasks":[], "metadata":{}}');
      const hash2 = snapshotTasksJsonHash(tmpDir);

      expect(hash1).not.toBe(hash2);
    });

    it("returns same hash for identical content", () => {
      const content = '{"tasks":[{"id":1,"title":"Test"}]}';
      writeFileSync(tasksJsonPath(tmpDir), content);
      const hash1 = snapshotTasksJsonHash(tmpDir);

      // Write same content again
      writeFileSync(tasksJsonPath(tmpDir), content);
      const hash2 = snapshotTasksJsonHash(tmpDir);

      expect(hash1).toBe(hash2);
    });

    it("detects whitespace-only changes", () => {
      writeFileSync(tasksJsonPath(tmpDir), '{"tasks":[]}');
      const hash1 = snapshotTasksJsonHash(tmpDir);

      writeFileSync(tasksJsonPath(tmpDir), '{ "tasks": [] }');
      const hash2 = snapshotTasksJsonHash(tmpDir);

      expect(hash1).not.toBe(hash2);
    });

    it("detects trailing newline addition", () => {
      writeFileSync(tasksJsonPath(tmpDir), '{"tasks":[]}');
      const hash1 = snapshotTasksJsonHash(tmpDir);

      writeFileSync(tasksJsonPath(tmpDir), '{"tasks":[]}\n');
      const hash2 = snapshotTasksJsonHash(tmpDir);

      expect(hash1).not.toBe(hash2);
    });

    it("produces 64-character hex string", () => {
      writeFileSync(tasksJsonPath(tmpDir), "{}");
      const hash = snapshotTasksJsonHash(tmpDir);

      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("handles large file content correctly", () => {
      const bigContent = JSON.stringify({
        tasks: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1,
          title: `Task ${i + 1}`,
          description: "A".repeat(1000),
          status: "pending",
        })),
      });
      writeFileSync(tasksJsonPath(tmpDir), bigContent);

      const hash = snapshotTasksJsonHash(tmpDir);
      expect(hash).toBe(sha256(bigContent));
    });

    it("handles multi-tag format content", () => {
      const multiTagContent = JSON.stringify({
        master: {
          tasks: [{ id: 1, title: "Master task" }],
          metadata: {},
        },
        feature: {
          tasks: [{ id: 1, title: "Feature task" }],
          metadata: {},
        },
      });
      writeFileSync(tasksJsonPath(tmpDir), multiTagContent);

      const hash = snapshotTasksJsonHash(tmpDir);
      expect(hash).toBe(sha256(multiTagContent));
    });

    it("detects changes in inactive tag of multi-tag file", () => {
      const content1 = JSON.stringify({
        master: { tasks: [{ id: 1, title: "Active" }], metadata: {} },
        feature: { tasks: [{ id: 1, title: "Old title" }], metadata: {} },
      });
      writeFileSync(tasksJsonPath(tmpDir), content1);
      const hash1 = snapshotTasksJsonHash(tmpDir);

      const content2 = JSON.stringify({
        master: { tasks: [{ id: 1, title: "Active" }], metadata: {} },
        feature: { tasks: [{ id: 1, title: "Changed title" }], metadata: {} },
      });
      writeFileSync(tasksJsonPath(tmpDir), content2);
      const hash2 = snapshotTasksJsonHash(tmpDir);

      expect(hash1).not.toBe(hash2);
    });
  });

  // =========================================================================
  // verifyTasksJsonHash
  // =========================================================================

  describe("verifyTasksJsonHash", () => {
    it("returns true when file unchanged", () => {
      const content = '{"tasks":[]}';
      writeFileSync(tasksJsonPath(tmpDir), content);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(true);
    });

    it("returns false when file content changed", () => {
      const content = '{"tasks":[]}';
      writeFileSync(tasksJsonPath(tmpDir), content);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // Modify the file
      writeFileSync(tasksJsonPath(tmpDir), '{"tasks":[{"id":1}]}');

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("returns false when file is deleted", () => {
      const content = '{"tasks":[]}';
      writeFileSync(tasksJsonPath(tmpDir), content);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // Delete the file
      rmSync(tasksJsonPath(tmpDir));

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("returns false for a wrong hash value", () => {
      writeFileSync(tasksJsonPath(tmpDir), '{"tasks":[]}');

      expect(
        verifyTasksJsonHash(tmpDir, "0000000000000000000000000000000000000000000000000000000000000000"),
      ).toBe(false);
    });

    it("detects whitespace change between snapshot and verify", () => {
      writeFileSync(tasksJsonPath(tmpDir), '{"tasks":[]}');
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // Change only whitespace
      writeFileSync(tasksJsonPath(tmpDir), '{ "tasks" : [] }');

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("simulates concurrent mutation: content changed between snapshot and verify", () => {
      // Simulate the expand pipeline scenario:
      // 1. Snapshot hash before agent session
      const originalContent = JSON.stringify({
        tasks: [
          { id: 1, title: "Task 1", status: "pending" },
          { id: 2, title: "Task 2", status: "pending" },
        ],
        metadata: {},
      });
      writeFileSync(tasksJsonPath(tmpDir), originalContent);
      const snapshotHash = snapshotTasksJsonHash(tmpDir)!;

      // 2. Simulate a concurrent mutation (another user/process changes a task)
      const modifiedContent = JSON.stringify({
        tasks: [
          { id: 1, title: "Task 1", status: "done" },
          { id: 2, title: "Task 2", status: "pending" },
        ],
        metadata: {},
      });
      writeFileSync(tasksJsonPath(tmpDir), modifiedContent);

      // 3. Verify before write — should detect the conflict
      expect(verifyTasksJsonHash(tmpDir, snapshotHash)).toBe(false);
    });

    it("simulates concurrent mutation in multi-tag inactive tag", () => {
      const original = JSON.stringify({
        master: {
          tasks: [{ id: 1, title: "Master task", status: "pending" }],
          metadata: {},
        },
        dev: {
          tasks: [{ id: 1, title: "Dev task", status: "pending" }],
          metadata: {},
        },
      });
      writeFileSync(tasksJsonPath(tmpDir), original);
      const snapshotHash = snapshotTasksJsonHash(tmpDir)!;

      // Another process modifies an inactive tag
      const modified = JSON.stringify({
        master: {
          tasks: [{ id: 1, title: "Master task", status: "pending" }],
          metadata: {},
        },
        dev: {
          tasks: [{ id: 1, title: "Dev task CHANGED", status: "pending" }],
          metadata: {},
        },
      });
      writeFileSync(tasksJsonPath(tmpDir), modified);

      expect(verifyTasksJsonHash(tmpDir, snapshotHash)).toBe(false);
    });
  });
});
