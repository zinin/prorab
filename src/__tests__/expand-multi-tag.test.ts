/**
 * Expand multi-tag format preservation tests (Task 20).
 *
 * Validates that expand correctly handles multi-tag tasks.json files:
 *
 * 1. Write preservation — expand modifies only the active (first) tag,
 *    preserves top-level wrapper and leaves inactive tags byte-identical.
 * 2. Hash conflict detection — hash covers the entire file, so mutations
 *    in inactive tags or wrapper structure trigger hash_conflict.
 * 3. No-op — `{ subtasks: [] }` leaves a multi-tag file byte-identical.
 * 4. Serialization consistency — JSON re-serialization does not alter
 *    field values or ordering in inactive tags.
 * 5. First-tag selection — the active tag is the first key in actual JSON
 *    key order, not alphabetical.
 *
 * All tests use real file I/O on temp directories — no mocks for hash,
 * validation, or file operations.
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
import { writeExpandSubtasks, readTasksFile } from "../core/tasks-json.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Multi-tag tasks.json with 3 tags.
 * "master" is the first key → active tag.
 * "feature-x" and "hotfix" are inactive tags that should never be modified.
 *
 * IMPORTANT: The active tag's metadata fields must be in FileMetadataSchema
 * field order (version, lastModified, taskCount, completedCount, projectName,
 * description, tags, created, updated) because Zod `.passthrough()` re-emits
 * known keys in schema definition order. Without this, a no-op write through
 * mutateTasksFile (which Zod-parses the active tag) would reorder keys and
 * break byte-identical comparisons.
 *
 * Inactive tags are NOT Zod-parsed, so their field order doesn't matter.
 */
function makeMultiTagJson() {
  return {
    master: {
      tasks: [
        {
          id: 1,
          title: "Master task one",
          description: "First task in master tag",
          status: "pending",
          priority: "high",
          dependencies: [],
          details: "Master task details here",
          testStrategy: "Unit tests for master",
          subtasks: [],
        },
        {
          id: 2,
          title: "Master task two",
          description: "Second task in master tag",
          status: "done",
          priority: "medium",
          dependencies: ["1"],
          details: "Already completed work",
          testStrategy: "Integration tests",
          subtasks: [
            {
              id: 1,
              title: "Existing subtask",
              description: "Pre-existing subtask",
              status: "done",
              dependencies: [],
            },
          ],
        },
      ],
      metadata: {
        // Field order matches FileMetadataSchema definition for byte-stable no-op
        version: "1.0.0",
        taskCount: 2,
        completedCount: 1,
        projectName: "master-project",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-02-15T12:00:00Z",
      },
    },
    "feature-x": {
      tasks: [
        {
          id: 1,
          title: "Feature X task",
          description: "Work on feature X",
          status: "in-progress",
          priority: "critical",
          dependencies: [],
          details: "Feature X implementation details",
          testStrategy: "E2E tests for feature X",
          subtasks: [
            {
              id: 1,
              title: "Sub A",
              description: "Subtask A",
              status: "pending",
              dependencies: [],
            },
            {
              id: 2,
              title: "Sub B",
              description: "Subtask B",
              status: "in-progress",
              dependencies: [1],
            },
          ],
        },
      ],
      metadata: {
        projectName: "feature-x-project",
        description: "Feature X branch tasks",
        created: "2026-02-01T00:00:00Z",
        updated: "2026-02-20T10:00:00Z",
      },
    },
    hotfix: {
      tasks: [
        {
          id: 1,
          title: "Hotfix task",
          description: "Critical hotfix",
          status: "pending",
          priority: "critical",
          dependencies: [],
          details: "Fix production issue",
          testStrategy: "Smoke tests",
          subtasks: [],
        },
      ],
      metadata: {
        projectName: "hotfix-project",
        created: "2026-03-01T00:00:00Z",
        updated: "2026-03-01T00:00:00Z",
      },
    },
  };
}

/** Write a multi-tag JSON to the tasks.json path under cwd. */
function writeMultiTagFile(cwd: string, data: Record<string, unknown>): string {
  const tasksDir = join(cwd, ".taskmaster", "tasks");
  mkdirSync(tasksDir, { recursive: true });
  const filePath = join(tasksDir, "tasks.json");
  const content = JSON.stringify(data, null, 2) + "\n";
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

function tasksJsonPath(cwd: string): string {
  return join(cwd, ".taskmaster", "tasks", "tasks.json");
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Expand multi-tag format preservation (real file I/O)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prorab-multi-tag-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // 1. Multi-tag write preservation
  // =========================================================================

  describe("write preservation", () => {
    it("preserves top-level wrapper structure after expand", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      // Expand task 1 in the active (master) tag with 2 subtasks
      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "Subtask Alpha",
          description: "First decomposed subtask",
          details: "Alpha details",
          dependencies: [],
        },
        {
          id: 2,
          title: "Subtask Beta",
          description: "Second decomposed subtask",
          details: "Beta details",
          dependencies: [1],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));

      // Top-level wrapper must still have exactly the same keys
      expect(Object.keys(raw)).toEqual(["master", "feature-x", "hotfix"]);
      // Each value must be an object with tasks array
      expect(Array.isArray(raw.master.tasks)).toBe(true);
      expect(Array.isArray(raw["feature-x"].tasks)).toBe(true);
      expect(Array.isArray(raw.hotfix.tasks)).toBe(true);
    });

    it("inactive tags are field-by-field identical after expand", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "New subtask",
          description: "Desc",
          details: "Details",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));

      // feature-x tag: field-by-field deep equality
      expect(raw["feature-x"]).toEqual(original["feature-x"]);
      // feature-x tasks
      expect(raw["feature-x"].tasks).toHaveLength(1);
      expect(raw["feature-x"].tasks[0].title).toBe("Feature X task");
      expect(raw["feature-x"].tasks[0].status).toBe("in-progress");
      expect(raw["feature-x"].tasks[0].subtasks).toHaveLength(2);
      expect(raw["feature-x"].tasks[0].subtasks[0].title).toBe("Sub A");
      expect(raw["feature-x"].tasks[0].subtasks[1].title).toBe("Sub B");
      // feature-x metadata
      expect(raw["feature-x"].metadata.projectName).toBe("feature-x-project");
      expect(raw["feature-x"].metadata.description).toBe("Feature X branch tasks");

      // hotfix tag: field-by-field deep equality
      expect(raw.hotfix).toEqual(original.hotfix);
      expect(raw.hotfix.tasks[0].title).toBe("Hotfix task");
      expect(raw.hotfix.tasks[0].status).toBe("pending");
      expect(raw.hotfix.metadata.projectName).toBe("hotfix-project");
    });

    it("only the target task in the active tag receives new subtasks", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "Decomposed step 1",
          description: "Step 1",
          details: "Step 1 details",
          dependencies: [],
          testStrategy: "Test step 1",
        },
        {
          id: 2,
          title: "Decomposed step 2",
          description: "Step 2",
          details: "Step 2 details",
          dependencies: [1],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));

      // Task 1 in master: should have new subtasks
      const task1 = raw.master.tasks.find((t: { id: number }) => t.id === 1);
      expect(task1.subtasks).toHaveLength(2);
      expect(task1.subtasks[0].title).toBe("Decomposed step 1");
      expect(task1.subtasks[0].status).toBe("pending");
      expect(task1.subtasks[0].testStrategy).toBe("Test step 1");
      expect(task1.subtasks[1].title).toBe("Decomposed step 2");
      expect(task1.subtasks[1].dependencies).toEqual([1]);
      // testStrategy omitted from subtask 2 → field absent
      expect(task1.subtasks[1]).not.toHaveProperty("testStrategy");

      // Task 2 in master: existing subtasks are untouched
      const task2 = raw.master.tasks.find((t: { id: number }) => t.id === 2);
      expect(task2.subtasks).toHaveLength(1);
      expect(task2.subtasks[0].title).toBe("Existing subtask");
      expect(task2.subtasks[0].status).toBe("done");
    });

    it("readTasksFile returns only the active tag data", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      const result = readTasksFile(tmpDir);
      // Should return master tag data
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].title).toBe("Master task one");
      expect(result.metadata.projectName).toBe("master-project");
    });

    it("master metadata is preserved after expand", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "S1",
          description: "D1",
          details: "Details1",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));
      expect(raw.master.metadata).toEqual(original.master.metadata);
    });
  });

  // =========================================================================
  // 2. Multi-tag hash conflict detection (helper level)
  //
  // These tests prove that verifyTasksJsonHash() detects multi-tag mutations.
  // Pipeline-level tests (ExpandManager produces reason: "hash_conflict" and
  // skips the write when an inactive tag is mutated during a session) are in
  // expand-no-write-guarantee.test.ts section "4b. Hash conflict — multi-tag".
  // =========================================================================

  describe("hash conflict detection", () => {
    it("hash covers the entire file (all tags)", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      const hash = snapshotTasksJsonHash(tmpDir);
      expect(hash).not.toBeNull();
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("modification in inactive tag causes hash conflict", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // External process modifies the "feature-x" tag (inactive)
      const modified = JSON.parse(JSON.stringify(original));
      modified["feature-x"].tasks[0].title = "MODIFIED BY EXTERNAL PROCESS";
      writeFileSync(
        tasksJsonPath(tmpDir),
        JSON.stringify(modified, null, 2) + "\n",
      );

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("modification in inactive tag metadata causes hash conflict", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // External process modifies metadata in the "hotfix" tag
      const modified = JSON.parse(JSON.stringify(original));
      modified.hotfix.metadata.updated = "2026-03-09T00:00:00Z";
      writeFileSync(
        tasksJsonPath(tmpDir),
        JSON.stringify(modified, null, 2) + "\n",
      );

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("adding a new tag to the wrapper causes hash conflict", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // External process adds a new tag
      const modified = JSON.parse(JSON.stringify(original));
      (modified as Record<string, unknown>)["new-tag"] = {
        tasks: [],
        metadata: {},
      };
      writeFileSync(
        tasksJsonPath(tmpDir),
        JSON.stringify(modified, null, 2) + "\n",
      );

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("removing a tag from the wrapper causes hash conflict", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // External process removes the "hotfix" tag
      const modified = JSON.parse(JSON.stringify(original));
      delete (modified as Record<string, unknown>).hotfix;
      writeFileSync(
        tasksJsonPath(tmpDir),
        JSON.stringify(modified, null, 2) + "\n",
      );

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("reordering keys in wrapper JSON causes hash conflict", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // External process writes keys in different order
      const reordered = {
        hotfix: original.hotfix,
        master: original.master,
        "feature-x": original["feature-x"],
      };
      writeFileSync(
        tasksJsonPath(tmpDir),
        JSON.stringify(reordered, null, 2) + "\n",
      );

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("adding a subtask to inactive tag causes hash conflict", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // External process adds a subtask to the "feature-x" tag
      const modified = JSON.parse(JSON.stringify(original));
      modified["feature-x"].tasks[0].subtasks.push({
        id: 3,
        title: "Externally added subtask",
        description: "Added concurrently",
        status: "pending",
        dependencies: [],
      });
      writeFileSync(
        tasksJsonPath(tmpDir),
        JSON.stringify(modified, null, 2) + "\n",
      );

      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(false);
    });

    it("hash is stable when file is not modified externally", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      const hash1 = snapshotTasksJsonHash(tmpDir)!;
      const hash2 = snapshotTasksJsonHash(tmpDir)!;

      expect(hash1).toBe(hash2);
      expect(verifyTasksJsonHash(tmpDir, hash1)).toBe(true);
    });
  });

  // =========================================================================
  // 3. Multi-tag no-op (empty subtasks)
  // =========================================================================

  describe("no-op with empty subtasks", () => {
    it("file is byte-identical after writeExpandSubtasks with []", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const contentBefore = readFileSync(tasksJsonPath(tmpDir));
      const hash = snapshotTasksJsonHash(tmpDir)!;

      writeExpandSubtasks(tmpDir, "1", []);

      const contentAfter = readFileSync(tasksJsonPath(tmpDir));
      expect(Buffer.compare(contentBefore, contentAfter)).toBe(0);
      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(true);
    });

    it("all tags remain unchanged after no-op", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      writeExpandSubtasks(tmpDir, "1", []);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));
      expect(raw.master).toEqual(original.master);
      expect(raw["feature-x"]).toEqual(original["feature-x"]);
      expect(raw.hotfix).toEqual(original.hotfix);
    });

    it("hash remains valid through validation + no-op write pipeline", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const hash = snapshotTasksJsonHash(tmpDir)!;

      // Step 1: Write empty subtasks
      writeExpandSubtasks(tmpDir, "1", []);

      // Step 2: Verify hash
      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(true);

      // Step 3: Second no-op write also stable
      writeExpandSubtasks(tmpDir, "1", []);
      expect(verifyTasksJsonHash(tmpDir, hash)).toBe(true);
    });

    it("no-op does not change active tag task status or fields", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      writeExpandSubtasks(tmpDir, "1", []);

      const data = readTasksFile(tmpDir);
      const task = data.tasks.find((t) => String(t.id) === "1");
      expect(task).toBeDefined();
      expect(task!.status).toBe("pending");
      expect(task!.title).toBe("Master task one");
      expect(task!.subtasks).toEqual([]);
      // No marker fields injected
      expect(task!).not.toHaveProperty("expanded");
      expect(task!).not.toHaveProperty("expandedAt");
    });
  });

  // =========================================================================
  // 3b. Zod key reordering: active tag metadata NOT in schema order
  //
  // NOTE: This section documents a writeExpandSubtasks-level behavior.
  // In the real ExpandManager pipeline, empty subtasks ([]) cause an early
  // return BEFORE writeExpandSubtasks is called (expand-manager.ts line 465),
  // so Zod key reordering never affects actual no-op expand sessions.
  // The byte difference documented here only applies when writeExpandSubtasks
  // is called with a non-empty subtask array on a file whose active tag has
  // metadata keys in non-schema order.
  //
  // Pipeline-level hash_conflict coverage (with multi-tag fixtures) is in
  // expand-no-write-guarantee.test.ts section "4b. Hash conflict — multi-tag".
  // =========================================================================

  describe("Zod key reordering in active tag", () => {
    it("non-schema-ordered metadata in active tag causes byte difference on no-op", () => {
      // FileMetadataSchema defines fields as: version, lastModified, taskCount,
      // completedCount, projectName, description, tags, created, updated.
      // If the active tag's metadata has keys in a DIFFERENT order, Zod's
      // .passthrough() re-emits known keys in schema order, changing the file.
      const data = {
        active: {
          tasks: [
            {
              id: 1,
              title: "Task",
              description: "D",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {
            // Deliberately NOT in schema order: projectName before version
            projectName: "my-project",
            version: "1.0.0",
            created: "2026-01-01T00:00:00Z",
          },
        },
      };

      writeMultiTagFile(tmpDir, data);
      const contentBefore = readFileSync(tasksJsonPath(tmpDir));

      writeExpandSubtasks(tmpDir, "1", []);

      const contentAfter = readFileSync(tasksJsonPath(tmpDir));
      // Byte-level difference because Zod reorders metadata keys
      expect(Buffer.compare(contentBefore, contentAfter)).not.toBe(0);

      // But logically still equal
      const rawBefore = JSON.parse(contentBefore.toString());
      const rawAfter = JSON.parse(contentAfter.toString());
      expect(rawAfter.active.metadata.projectName).toBe("my-project");
      expect(rawAfter.active.metadata.version).toBe("1.0.0");

      // Verify the reordering: version now comes before projectName
      const afterStr = contentAfter.toString();
      const versionIdx = afterStr.indexOf('"version"');
      const projectNameIdx = afterStr.indexOf('"projectName"');
      expect(versionIdx).toBeLessThan(projectNameIdx);
    });

    it("inactive tags are NOT affected by Zod key reordering", () => {
      const data = {
        active: {
          tasks: [
            {
              id: 1,
              title: "Task",
              description: "D",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {
            // Schema order for active tag (byte-stable)
            version: "1.0.0",
            projectName: "project",
          },
        },
        inactive: {
          tasks: [
            {
              id: 1,
              title: "Inactive",
              description: "I",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {
            // NON-schema order — but it's inactive, so it should be preserved as-is
            projectName: "inactive-project",
            version: "2.0.0",
            created: "2026-01-01T00:00:00Z",
          },
        },
      };

      writeMultiTagFile(tmpDir, data);
      const contentBefore = readFileSync(tasksJsonPath(tmpDir), "utf-8");

      writeExpandSubtasks(tmpDir, "1", []);

      const contentAfter = readFileSync(tasksJsonPath(tmpDir), "utf-8");
      // Extract the inactive tag's serialization from both versions
      const parsedBefore = JSON.parse(contentBefore);
      const parsedAfter = JSON.parse(contentAfter);

      // Inactive tag metadata order is preserved (projectName before version)
      const inactiveBefore = JSON.stringify(parsedBefore.inactive, null, 2);
      const inactiveAfter = JSON.stringify(parsedAfter.inactive, null, 2);
      expect(inactiveAfter).toBe(inactiveBefore);

      // Verify key order in inactive tag: projectName before version
      const inactiveStr = JSON.stringify(parsedAfter.inactive);
      expect(inactiveStr.indexOf("projectName")).toBeLessThan(
        inactiveStr.indexOf("version"),
      );
    });
  });

  // =========================================================================
  // 4. JSON re-serialization consistency
  // =========================================================================

  describe("serialization consistency", () => {
    it("re-serialization preserves field values in inactive tags", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      // Trigger a write (modifies active tag)
      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "New sub",
          description: "New desc",
          details: "New details",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));

      // Verify every field in feature-x is value-identical
      const fx = raw["feature-x"];
      expect(fx.tasks[0].id).toBe(1);
      expect(fx.tasks[0].title).toBe("Feature X task");
      expect(fx.tasks[0].description).toBe("Work on feature X");
      expect(fx.tasks[0].status).toBe("in-progress");
      expect(fx.tasks[0].priority).toBe("critical");
      expect(fx.tasks[0].dependencies).toEqual([]);
      expect(fx.tasks[0].details).toBe("Feature X implementation details");
      expect(fx.tasks[0].testStrategy).toBe("E2E tests for feature X");
      expect(fx.tasks[0].subtasks[0].id).toBe(1);
      expect(fx.tasks[0].subtasks[0].title).toBe("Sub A");
      expect(fx.tasks[0].subtasks[1].id).toBe(2);
      expect(fx.tasks[0].subtasks[1].title).toBe("Sub B");
      expect(fx.tasks[0].subtasks[1].dependencies).toEqual([1]);

      // Verify metadata
      expect(fx.metadata.projectName).toBe("feature-x-project");
      expect(fx.metadata.description).toBe("Feature X branch tasks");
      expect(fx.metadata.created).toBe("2026-02-01T00:00:00Z");
      expect(fx.metadata.updated).toBe("2026-02-20T10:00:00Z");

      // Verify hotfix is also preserved
      const hf = raw.hotfix;
      expect(hf.tasks[0].id).toBe(1);
      expect(hf.tasks[0].title).toBe("Hotfix task");
      expect(hf.tasks[0].priority).toBe("critical");
      expect(hf.metadata.projectName).toBe("hotfix-project");
    });

    it("formatting is consistent (2-space indent + trailing newline)", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "S",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const content = readFileSync(tasksJsonPath(tmpDir), "utf-8");
      // Ends with newline
      expect(content.endsWith("\n")).toBe(true);
      // Uses 2-space indentation (check first indented line)
      const lines = content.split("\n");
      const firstIndented = lines.find((l) => l.startsWith("  "));
      expect(firstIndented).toBeDefined();
      // No tabs
      expect(content.includes("\t")).toBe(false);
    });

    it("numeric dependencies in inactive tags remain numeric", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "S",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));
      // feature-x subtask 2 has dependency [1] — should stay numeric
      expect(raw["feature-x"].tasks[0].subtasks[1].dependencies).toEqual([1]);
      expect(typeof raw["feature-x"].tasks[0].subtasks[1].dependencies[0]).toBe("number");
    });

    it("string dependencies in active tag remain strings", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "S",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));
      // Master task 2 has dependencies: ["1"] — should stay string
      expect(raw.master.tasks[1].dependencies).toEqual(["1"]);
      expect(typeof raw.master.tasks[1].dependencies[0]).toBe("string");
    });

    it("key order within inactive tags is preserved", () => {
      // Create a file where hotfix metadata keys appear in a specific order
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const contentBefore = readFileSync(tasksJsonPath(tmpDir), "utf-8");

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "S",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const contentAfter = readFileSync(tasksJsonPath(tmpDir), "utf-8");

      // Extract the "feature-x" section from both files to compare serialized form
      // Since JSON.stringify preserves insertion order, the inactive tags
      // should have identical serialized representations
      const parsedBefore = JSON.parse(contentBefore);
      const parsedAfter = JSON.parse(contentAfter);

      const fxBefore = JSON.stringify(parsedBefore["feature-x"], null, 2);
      const fxAfter = JSON.stringify(parsedAfter["feature-x"], null, 2);
      expect(fxAfter).toBe(fxBefore);

      const hfBefore = JSON.stringify(parsedBefore.hotfix, null, 2);
      const hfAfter = JSON.stringify(parsedAfter.hotfix, null, 2);
      expect(hfAfter).toBe(hfBefore);
    });
  });

  // =========================================================================
  // 5. First-tag selection
  // =========================================================================

  describe("first-tag selection", () => {
    it("first key in JSON key order is the active tag, not alphabetical", () => {
      // "beta" comes after "alpha" alphabetically, but is first in JSON
      const data = {
        beta: {
          tasks: [
            {
              id: 1,
              title: "Beta task",
              description: "Task in beta",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
        alpha: {
          tasks: [
            {
              id: 1,
              title: "Alpha task",
              description: "Task in alpha",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
      };

      writeMultiTagFile(tmpDir, data);

      // readTasksFile should return the beta tag (first key)
      const result = readTasksFile(tmpDir);
      expect(result.tasks[0].title).toBe("Beta task");
    });

    it("expand modifies the first tag, not alphabetically first", () => {
      const data = {
        zebra: {
          tasks: [
            {
              id: 1,
              title: "Zebra task",
              description: "Z",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
        alpha: {
          tasks: [
            {
              id: 1,
              title: "Alpha task",
              description: "A",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
      };

      writeMultiTagFile(tmpDir, data);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "New subtask for first tag",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));

      // zebra (first key) gets the subtask
      expect(raw.zebra.tasks[0].subtasks).toHaveLength(1);
      expect(raw.zebra.tasks[0].subtasks[0].title).toBe("New subtask for first tag");

      // alpha (second key, alphabetically first) stays untouched
      expect(raw.alpha.tasks[0].subtasks).toEqual([]);
    });

    it("non-tag keys (no tasks array) are skipped in tag selection", () => {
      const data = {
        config: {
          version: "2.0",
          // No tasks array — not a valid tag
        },
        actual: {
          tasks: [
            {
              id: 1,
              title: "Actual task",
              description: "Real",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
      };

      writeMultiTagFile(tmpDir, data as Record<string, unknown>);

      const result = readTasksFile(tmpDir);
      expect(result.tasks[0].title).toBe("Actual task");

      // Expand should modify "actual" tag (the first valid tag)
      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "Decomposed",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));
      expect(raw.actual.tasks[0].subtasks).toHaveLength(1);
      // config key should be preserved
      expect((raw.config as { version: string }).version).toBe("2.0");
    });

    it("with single tag, it becomes the active tag", () => {
      const data = {
        "only-tag": {
          tasks: [
            {
              id: 1,
              title: "Solo task",
              description: "Only one tag",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
      };

      writeMultiTagFile(tmpDir, data);

      const result = readTasksFile(tmpDir);
      expect(result.tasks[0].title).toBe("Solo task");

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "Sub",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));
      expect(raw["only-tag"].tasks[0].subtasks).toHaveLength(1);
      // Wrapper structure preserved
      expect(Object.keys(raw)).toEqual(["only-tag"]);
    });
  });

  // =========================================================================
  // 6. Combined scenarios: expand + hash + verify
  // =========================================================================

  describe("combined expand + hash pipeline on multi-tag", () => {
    it("successful expand changes hash (active tag modified)", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const hashBefore = snapshotTasksJsonHash(tmpDir)!;

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "Decomposed",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const hashAfter = snapshotTasksJsonHash(tmpDir)!;
      expect(hashAfter).not.toBe(hashBefore);
      expect(verifyTasksJsonHash(tmpDir, hashBefore)).toBe(false);
    });

    it("concurrent inactive-tag mutation detected between snapshot and verify", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      // Phase 1: ExpandManager snapshots hash before agent run
      const snapshotHash = snapshotTasksJsonHash(tmpDir)!;

      // Phase 2: External process modifies an inactive tag during agent run
      const modified = JSON.parse(JSON.stringify(original));
      modified.hotfix.tasks[0].status = "done";
      writeFileSync(
        tasksJsonPath(tmpDir),
        JSON.stringify(modified, null, 2) + "\n",
      );

      // Phase 3: ExpandManager verifies hash before write → conflict
      expect(verifyTasksJsonHash(tmpDir, snapshotHash)).toBe(false);
    });

    it("concurrent wrapper modification detected between snapshot and verify", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);
      const snapshotHash = snapshotTasksJsonHash(tmpDir)!;

      // External process adds a tag
      const modified = JSON.parse(JSON.stringify(original));
      (modified as Record<string, unknown>)["emergency"] = {
        tasks: [],
        metadata: {},
      };
      writeFileSync(
        tasksJsonPath(tmpDir),
        JSON.stringify(modified, null, 2) + "\n",
      );

      expect(verifyTasksJsonHash(tmpDir, snapshotHash)).toBe(false);
    });

    it("expand then re-snapshot works for the next session", () => {
      const original = makeMultiTagJson();
      writeMultiTagFile(tmpDir, original);

      // First expand session
      const hash1 = snapshotTasksJsonHash(tmpDir)!;
      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "S1",
          description: "D1",
          details: "Det1",
          dependencies: [],
        },
      ]);

      // Hash changed
      expect(verifyTasksJsonHash(tmpDir, hash1)).toBe(false);

      // Second session can re-snapshot
      const hash2 = snapshotTasksJsonHash(tmpDir)!;
      expect(hash2).not.toBe(hash1);
      expect(verifyTasksJsonHash(tmpDir, hash2)).toBe(true);
    });
  });

  // =========================================================================
  // 7. Edge cases
  // =========================================================================

  describe("edge cases", () => {
    it("two-tag file with both tags having expandable tasks", () => {
      const data = {
        main: {
          tasks: [
            {
              id: 1,
              title: "Main expandable",
              description: "Can be expanded",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
        dev: {
          tasks: [
            {
              id: 1,
              title: "Dev expandable",
              description: "Could also be expanded",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
      };

      writeMultiTagFile(tmpDir, data);

      // Expand should target task 1 in "main" (first tag)
      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "Main subtask",
          description: "Expanded from main",
          details: "Details",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));
      expect(raw.main.tasks[0].subtasks).toHaveLength(1);
      expect(raw.main.tasks[0].subtasks[0].title).toBe("Main subtask");
      // Dev tag untouched
      expect(raw.dev.tasks[0].subtasks).toEqual([]);
    });

    it("multi-tag file with special characters in tag names", () => {
      const data = {
        "release/v2.0": {
          tasks: [
            {
              id: 1,
              title: "Release task",
              description: "V2 release",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
        "bugfix/PROJ-123": {
          tasks: [
            {
              id: 1,
              title: "Bugfix task",
              description: "Fix bug",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
      };

      writeMultiTagFile(tmpDir, data);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "Release subtask",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));
      // First tag (release/v2.0) gets the subtask
      expect(raw["release/v2.0"].tasks[0].subtasks).toHaveLength(1);
      // Second tag preserved
      expect(raw["bugfix/PROJ-123"].tasks[0].subtasks).toEqual([]);
      expect(raw["bugfix/PROJ-123"].tasks[0].title).toBe("Bugfix task");
    });

    it("inactive tag with complex nested structures preserved", () => {
      const complexTag = {
        tasks: [
          {
            id: 1,
            title: "Complex task",
            description: "Has many fields",
            status: "pending",
            priority: "high",
            dependencies: [],
            details: "Detailed implementation plan",
            testStrategy: "Comprehensive testing",
            subtasks: [
              {
                id: 1,
                title: "Deep subtask",
                description: "With metadata",
                status: "pending",
                dependencies: [],
                metadata: {
                  runAttempts: 3,
                  customField: "custom-value",
                  nested: { a: 1, b: [2, 3] },
                },
              },
            ],
            metadata: {
              runAttempts: 5,
              notes: "Important notes",
            },
            relevantFiles: [
              {
                path: "src/foo.ts",
                description: "Main file",
                action: "modify",
              },
            ],
            tags: ["backend", "api"],
          },
        ],
        metadata: {
          projectName: "complex-project",
          tags: ["v2", "migration"],
          version: "2.0.0",
        },
      };

      const data = {
        active: {
          tasks: [
            {
              id: 1,
              title: "Active task",
              description: "Simple",
              status: "pending",
              dependencies: [],
              subtasks: [],
            },
          ],
          metadata: {},
        },
        complex: complexTag,
      };

      writeMultiTagFile(tmpDir, data);

      writeExpandSubtasks(tmpDir, "1", [
        {
          id: 1,
          title: "Sub",
          description: "D",
          details: "Det",
          dependencies: [],
        },
      ]);

      const raw = JSON.parse(readFileSync(tasksJsonPath(tmpDir), "utf-8"));

      // Complex inactive tag should be perfectly preserved
      expect(raw.complex).toEqual(complexTag);
      // Deep check specific nested values
      // Task-level metadata
      expect(raw.complex.tasks[0].metadata.runAttempts).toBe(5);
      expect(raw.complex.tasks[0].metadata.notes).toBe("Important notes");
      // Subtask-level metadata (with deeply nested structure)
      expect(raw.complex.tasks[0].subtasks[0].metadata.nested).toEqual({ a: 1, b: [2, 3] });
      expect(raw.complex.tasks[0].subtasks[0].metadata.customField).toBe("custom-value");
      expect(raw.complex.tasks[0].subtasks[0].metadata.runAttempts).toBe(3);
      // Task-level extra fields
      expect(raw.complex.tasks[0].relevantFiles[0].path).toBe("src/foo.ts");
      expect(raw.complex.tasks[0].tags).toEqual(["backend", "api"]);
      expect(raw.complex.metadata.tags).toEqual(["v2", "migration"]);
    });
  });
});
