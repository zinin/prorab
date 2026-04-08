/**
 * Store-level tests for project-state flags in the tasks store.
 *
 * Verifies initial/default values and correct updates through the
 * connected message handler and tasks:updated event — the two code
 * paths that mutate hasPrd / hasTasksFile / hasValidTasks / hasTasksJson.
 *
 * Uses real Pinia stores (same approach as ws-channel-routing.test.ts).
 * Imports the same pure mapping functions that useWebSocket.ts uses,
 * ensuring tests exercise the real production code path.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useTasksStore } from "../../ui/src/stores/tasks";
import {
  applyConnectedProjectState,
  applyTasksUpdatedProjectState,
} from "../../ui/src/composables/project-state-mapping";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tasks store project-state flags", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  // ---- Initial/default values ----

  describe("initial values", () => {
    it("hasPrd defaults to false", () => {
      const store = useTasksStore();
      expect(store.hasPrd).toBe(false);
    });

    it("hasTasksFile defaults to true (optimistic)", () => {
      const store = useTasksStore();
      expect(store.hasTasksFile).toBe(true);
    });

    it("hasValidTasks defaults to true (optimistic)", () => {
      const store = useTasksStore();
      expect(store.hasValidTasks).toBe(true);
    });

    it("hasTasksJson defaults to true (optimistic, backward compat)", () => {
      const store = useTasksStore();
      expect(store.hasTasksJson).toBe(true);
    });

    it("wsInitialized defaults to false", () => {
      const store = useTasksStore();
      expect(store.wsInitialized).toBe(false);
    });

    it("tasks defaults to empty array", () => {
      const store = useTasksStore();
      expect(store.tasks).toEqual([]);
    });
  });

  // ---- Connected message: full project-state contract ----

  describe("connected message updates", () => {
    it("sets all flags for empty project (no PRD, no tasks.json)", () => {
      const store = useTasksStore();
      applyConnectedProjectState(store, {
        hasPrd: false,
        hasTasksFile: false,
        hasValidTasks: false,
        hasTasksJson: false,
      });

      expect(store.hasPrd).toBe(false);
      expect(store.hasTasksFile).toBe(false);
      expect(store.hasValidTasks).toBe(false);
      expect(store.hasTasksJson).toBe(false);
      expect(store.wsInitialized).toBe(true);
    });

    it("sets flags for PRD-only project (PRD written, parse-prd not yet run)", () => {
      const store = useTasksStore();
      applyConnectedProjectState(store, {
        hasPrd: true,
        hasTasksFile: false,
        hasValidTasks: false,
        hasTasksJson: false,
      });

      expect(store.hasPrd).toBe(true);
      expect(store.hasTasksFile).toBe(false);
      expect(store.hasValidTasks).toBe(false);
      expect(store.hasTasksJson).toBe(false);
    });

    it("sets flags for fully initialized project", () => {
      const store = useTasksStore();
      applyConnectedProjectState(store, {
        hasPrd: true,
        hasTasksFile: true,
        hasValidTasks: true,
        hasTasksJson: true,
      });

      expect(store.hasPrd).toBe(true);
      expect(store.hasTasksFile).toBe(true);
      expect(store.hasValidTasks).toBe(true);
      expect(store.hasTasksJson).toBe(true);
    });

    it("distinguishes hasTasksFile=true with hasValidTasks=false (corrupt tasks.json)", () => {
      const store = useTasksStore();
      applyConnectedProjectState(store, {
        hasPrd: true,
        hasTasksFile: true,
        hasValidTasks: false,
        hasTasksJson: true,
      });

      expect(store.hasPrd).toBe(true);
      expect(store.hasTasksFile).toBe(true);
      expect(store.hasValidTasks).toBe(false);
      expect(store.hasTasksJson).toBe(true);
    });

    it("sets wsInitialized to true", () => {
      const store = useTasksStore();
      expect(store.wsInitialized).toBe(false);

      applyConnectedProjectState(
        store,
        { hasPrd: false, hasTasksFile: false, hasValidTasks: false, hasTasksJson: false },
      );

      expect(store.wsInitialized).toBe(true);
    });

    it("overrides optimistic defaults when server reports empty project", () => {
      const store = useTasksStore();
      // Verify optimistic defaults
      expect(store.hasTasksFile).toBe(true);
      expect(store.hasValidTasks).toBe(true);
      expect(store.hasTasksJson).toBe(true);

      // Server reports no tasks file
      applyConnectedProjectState(
        store,
        { hasPrd: false, hasTasksFile: false, hasValidTasks: false, hasTasksJson: false },
      );

      expect(store.hasTasksFile).toBe(false);
      expect(store.hasValidTasks).toBe(false);
      expect(store.hasTasksJson).toBe(false);
    });
  });

  // ---- Backward compatibility: old server sends only hasTasksJson ----

  describe("backward compatibility (old server without granular fields)", () => {
    it("falls back to hasTasksJson when hasTasksFile is absent", () => {
      const store = useTasksStore();
      applyConnectedProjectState(store, {
        // Old server sends only hasTasksJson, not hasTasksFile/hasValidTasks
        hasTasksJson: true,
      });

      // hasTasksFile falls back to hasTasksJson
      expect(store.hasTasksFile).toBe(true);
      // hasValidTasks falls back through hasTasksFile → hasTasksJson
      expect(store.hasValidTasks).toBe(true);
      expect(store.hasTasksJson).toBe(true);
      // hasPrd defaults to false when absent
      expect(store.hasPrd).toBe(false);
    });

    it("falls back correctly when hasTasksJson is false", () => {
      const store = useTasksStore();
      applyConnectedProjectState(store, {
        hasTasksJson: false,
      });

      expect(store.hasTasksFile).toBe(false);
      expect(store.hasValidTasks).toBe(false);
      expect(store.hasTasksJson).toBe(false);
      expect(store.hasPrd).toBe(false);
    });

    it("defaults to true when neither hasTasksFile nor hasTasksJson present", () => {
      const store = useTasksStore();
      applyConnectedProjectState(store, {
        // No project-state fields at all (very old server)
      });

      // Fallback chain: hasTasksFile ?? (hasTasksJson ?? true) → true
      expect(store.hasTasksFile).toBe(true);
      expect(store.hasValidTasks).toBe(true);
      expect(store.hasTasksJson).toBe(true);
      // hasPrd ?? false → false
      expect(store.hasPrd).toBe(false);
    });

    it("prefers hasTasksFile over hasTasksJson when both present", () => {
      const store = useTasksStore();
      applyConnectedProjectState(store, {
        hasTasksFile: false,
        hasTasksJson: true, // disagrees with hasTasksFile
        hasValidTasks: false,
      });

      // hasTasksFile takes precedence
      expect(store.hasTasksFile).toBe(false);
      expect(store.hasValidTasks).toBe(false);
      // hasTasksJson is set independently
      expect(store.hasTasksJson).toBe(true);
    });
  });

  // ---- tasks:updated event: optimistic flag setting ----

  describe("tasks:updated event", () => {
    it("optimistically sets file-presence flags to true but leaves hasValidTasks unchanged", () => {
      const store = useTasksStore();
      // Start from empty project state
      applyConnectedProjectState(
        store,
        { hasPrd: false, hasTasksFile: false, hasValidTasks: false, hasTasksJson: false },
      );
      expect(store.hasTasksFile).toBe(false);
      expect(store.hasValidTasks).toBe(false);
      expect(store.hasTasksJson).toBe(false);

      // tasks:updated arrives (tasks.json was written)
      applyTasksUpdatedProjectState(store);

      expect(store.hasTasksFile).toBe(true);
      expect(store.hasTasksJson).toBe(true);
      // hasValidTasks is NOT set optimistically — only the server can validate
      expect(store.hasValidTasks).toBe(false);
    });

    it("does not change hasPrd (tasks:updated is about tasks.json, not PRD)", () => {
      const store = useTasksStore();
      applyConnectedProjectState(
        store,
        { hasPrd: false, hasTasksFile: false, hasValidTasks: false, hasTasksJson: false },
      );
      expect(store.hasPrd).toBe(false);

      applyTasksUpdatedProjectState(store);

      // hasPrd stays unchanged — only tasks.json-related flags are set
      expect(store.hasPrd).toBe(false);
    });

    it("does not change hasValidTasks (only server can validate)", () => {
      const store = useTasksStore();
      // Start with valid tasks
      applyConnectedProjectState(
        store,
        { hasPrd: true, hasTasksFile: true, hasValidTasks: true, hasTasksJson: true },
      );
      expect(store.hasValidTasks).toBe(true);

      applyTasksUpdatedProjectState(store);

      // hasValidTasks remains whatever it was before — not touched
      expect(store.hasValidTasks).toBe(true);
      expect(store.hasTasksFile).toBe(true);
      expect(store.hasTasksJson).toBe(true);
    });

    it("is idempotent when file-presence flags are already true", () => {
      const store = useTasksStore();
      applyConnectedProjectState(
        store,
        { hasPrd: true, hasTasksFile: true, hasValidTasks: true, hasTasksJson: true },
      );

      applyTasksUpdatedProjectState(store);

      expect(store.hasTasksFile).toBe(true);
      expect(store.hasTasksJson).toBe(true);
    });
  });

  // ---- Reconnection: second connected message corrects state ----

  describe("reconnection (second connected message)", () => {
    it("corrects state when project state changes between connections", () => {
      const store = useTasksStore();

      // First connection: empty project
      applyConnectedProjectState(
        store,
        { hasPrd: false, hasTasksFile: false, hasValidTasks: false, hasTasksJson: false },
      );
      expect(store.hasTasksFile).toBe(false);
      expect(store.hasValidTasks).toBe(false);

      // tasks:updated while connected: optimistic update (file-presence only)
      applyTasksUpdatedProjectState(store);
      expect(store.hasTasksFile).toBe(true);
      // hasValidTasks stays false — only server can confirm
      expect(store.hasValidTasks).toBe(false);

      // Reconnection: server confirms the state (including validity)
      applyConnectedProjectState(
        store,
        { hasPrd: true, hasTasksFile: true, hasValidTasks: true, hasTasksJson: true },
      );
      expect(store.hasPrd).toBe(true);
      expect(store.hasTasksFile).toBe(true);
      expect(store.hasValidTasks).toBe(true);
    });

    it("reverts optimistic update if server disagrees", () => {
      const store = useTasksStore();

      // First connection: has tasks
      applyConnectedProjectState(
        store,
        { hasPrd: true, hasTasksFile: true, hasValidTasks: true, hasTasksJson: true },
      );

      // Reconnection: tasks.json was deleted between connections
      applyConnectedProjectState(
        store,
        { hasPrd: true, hasTasksFile: false, hasValidTasks: false, hasTasksJson: false },
      );
      expect(store.hasPrd).toBe(true);
      expect(store.hasTasksFile).toBe(false);
      expect(store.hasValidTasks).toBe(false);
    });
  });

  // ---- Full project-state matrix (6 meaningful combinations) ----

  describe("project-state matrix (all 6 meaningful combinations)", () => {
    const matrix: Array<{ label: string; hasPrd: boolean; hasTasksFile: boolean; hasValidTasks: boolean }> = [
      { label: "fresh project", hasPrd: false, hasTasksFile: false, hasValidTasks: false },
      { label: "tasks.json exists but invalid", hasPrd: false, hasTasksFile: true, hasValidTasks: false },
      { label: "valid tasks, no PRD", hasPrd: false, hasTasksFile: true, hasValidTasks: true },
      { label: "PRD written, parse-prd not run", hasPrd: true, hasTasksFile: false, hasValidTasks: false },
      { label: "PRD exists, tasks.json invalid", hasPrd: true, hasTasksFile: true, hasValidTasks: false },
      { label: "fully initialized", hasPrd: true, hasTasksFile: true, hasValidTasks: true },
    ];

    for (const { label, hasPrd, hasTasksFile, hasValidTasks } of matrix) {
      it(`correctly stores: ${label}`, () => {
        const store = useTasksStore();
        applyConnectedProjectState(
          store,
          { hasPrd, hasTasksFile, hasValidTasks, hasTasksJson: hasTasksFile },
        );

        expect(store.hasPrd).toBe(hasPrd);
        expect(store.hasTasksFile).toBe(hasTasksFile);
        expect(store.hasValidTasks).toBe(hasValidTasks);
        expect(store.hasTasksJson).toBe(hasTasksFile);
      });
    }
  });
});
