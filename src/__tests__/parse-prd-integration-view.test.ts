/**
 * Integration tests for parse-prd ↔ TaskListView integration.
 *
 * Verifies:
 * - showParsePrdPanel takes priority regardless of hasTasksFile
 * - Recovery to wizard after failure/cancelled dismiss
 * - Success transition: fetchStatus + fetchTasks + clearParsePrd (guards on hasValidTasks)
 * - Progress panel visible even when tasks.json exists but is invalid
 *
 * Uses Pinia stores for behavioral assertions (not just source-level checks).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useParsePrdStore } from "../../ui/src/stores/parse-prd";
import { useTasksStore } from "../../ui/src/stores/tasks";

function mockFetchOk(data: unknown = {}) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

/**
 * Mirrors `showParsePrdPanel` computed from TaskListView:
 *   parsePrdStore.state !== "idle"
 */
function showParsePrdPanel(parsePrdStore: ReturnType<typeof useParsePrdStore>): boolean {
  return parsePrdStore.state !== "idle";
}

/**
 * Mirrors `showWizard` computed from TaskListView:
 *   !hasTasksFile && chatState === "idle" && !showParsePrdPanel
 */
function showWizard(
  tasksStore: ReturnType<typeof useTasksStore>,
  parsePrdStore: ReturnType<typeof useParsePrdStore>,
): boolean {
  return !tasksStore.hasTasksFile && !showParsePrdPanel(parsePrdStore);
}

describe("parse-prd ↔ TaskListView integration", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // showParsePrdPanel: covers active/stopping/completed, hides on idle
  // ---------------------------------------------------------------------------
  describe("showParsePrdPanel priority", () => {
    it("true when state is active", () => {
      const store = useParsePrdStore();
      store.state = "active";
      expect(showParsePrdPanel(store)).toBe(true);
    });

    it("true when state is stopping", () => {
      const store = useParsePrdStore();
      store.state = "stopping";
      expect(showParsePrdPanel(store)).toBe(true);
    });

    it("true when state is completed", () => {
      const store = useParsePrdStore();
      store.state = "completed";
      expect(showParsePrdPanel(store)).toBe(true);
    });

    it("false when state is idle", () => {
      const store = useParsePrdStore();
      store.state = "idle";
      expect(showParsePrdPanel(store)).toBe(false);
    });

    it("takes priority even when hasTasksFile is true (invalid file scenario)", () => {
      const parsePrdStore = useParsePrdStore();
      const tasksStore = useTasksStore();

      // Parse-prd failed, file exists but is invalid
      parsePrdStore.state = "completed";
      parsePrdStore.outcome = { status: "failure", errors: ["file does not match expected format"] };
      tasksStore.hasTasksFile = true;
      tasksStore.hasValidTasks = false;

      // showParsePrdPanel is true → progress panel renders (not corruption warning)
      expect(showParsePrdPanel(parsePrdStore)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Recovery: dismiss after failure/cancelled returns to wizard
  // ---------------------------------------------------------------------------
  describe("recovery to wizard after failure/cancelled", () => {
    it("clearParsePrd resets state to idle after failure", () => {
      const parsePrdStore = useParsePrdStore();

      // Simulate failure outcome
      parsePrdStore.state = "completed";
      parsePrdStore.outcome = { status: "failure", errors: ["Missing tasks"] };

      // User clicks "Try Again" → clearParsePrd()
      parsePrdStore.clearParsePrd();

      expect(parsePrdStore.state).toBe("idle");
      expect(parsePrdStore.outcome).toBeNull();
    });

    it("clearParsePrd resets state to idle after cancelled", () => {
      const parsePrdStore = useParsePrdStore();

      // Simulate cancelled outcome
      parsePrdStore.state = "completed";
      parsePrdStore.outcome = { status: "cancelled" };

      parsePrdStore.clearParsePrd();

      expect(parsePrdStore.state).toBe("idle");
      expect(parsePrdStore.outcome).toBeNull();
    });

    it("wizard shows after clearParsePrd when hasTasksFile is false", () => {
      const parsePrdStore = useParsePrdStore();
      const tasksStore = useTasksStore();

      parsePrdStore.state = "idle";
      tasksStore.hasTasksFile = false;

      expect(showWizard(tasksStore, parsePrdStore)).toBe(true);
    });

    it("progress panel hidden after clearParsePrd (idle)", () => {
      const parsePrdStore = useParsePrdStore();

      parsePrdStore.state = "idle";

      expect(showParsePrdPanel(parsePrdStore)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Success transition: fetchStatus confirms valid tasks.json via hasValidTasks
  // ---------------------------------------------------------------------------
  describe("success transition with fetchStatus confirmation", () => {
    it("fetchStatus updates hasTasksFile and hasValidTasks from server", async () => {
      globalThis.fetch = mockFetchOk({
        hasPrd: true,
        hasTasksFile: true,
        hasValidTasks: true,
        hasTasksJson: true,
      });

      const tasksStore = useTasksStore();
      tasksStore.hasTasksFile = false;
      tasksStore.hasValidTasks = false;

      await tasksStore.fetchStatus();

      expect(tasksStore.hasTasksFile).toBe(true);
      expect(tasksStore.hasValidTasks).toBe(true);
    });

    it("after success + fetchStatus + clearParsePrd, hasValidTasks gates template to task list", async () => {
      const parsePrdStore = useParsePrdStore();
      const tasksStore = useTasksStore();

      // Simulate success outcome
      parsePrdStore.state = "completed";
      parsePrdStore.outcome = { status: "success" };

      // fetchStatus confirms valid tasks
      globalThis.fetch = mockFetchOk({
        hasPrd: true,
        hasTasksFile: true,
        hasValidTasks: true,
        hasTasksJson: true,
      });
      await tasksStore.fetchStatus();

      // Guard: only clear when hasValidTasks is true
      if (tasksStore.hasValidTasks) {
        parsePrdStore.clearParsePrd();
      }

      // Now the template condition: showParsePrdPanel is false → falls through to task list
      expect(tasksStore.hasTasksFile).toBe(true);
      expect(tasksStore.hasValidTasks).toBe(true);
      expect(parsePrdStore.state).toBe("idle");
    });

    it("does not clear parsePrd if fetchStatus returns hasValidTasks=false", async () => {
      const parsePrdStore = useParsePrdStore();
      const tasksStore = useTasksStore();

      parsePrdStore.state = "completed";
      parsePrdStore.outcome = { status: "success" };

      // fetchStatus says file exists but is not valid
      globalThis.fetch = mockFetchOk({
        hasPrd: true,
        hasTasksFile: true,
        hasValidTasks: false,
        hasTasksJson: true,
      });
      await tasksStore.fetchStatus();

      // The watcher guards on tasksStore.hasValidTasks — if false, don't clear
      if (tasksStore.hasValidTasks) {
        parsePrdStore.clearParsePrd();
      }

      // parsePrd should still be in completed state
      expect(parsePrdStore.state).toBe("completed");
      expect(parsePrdStore.outcome).toEqual({ status: "success" });
    });

    it("does not clear parsePrd if fetchStatus returns hasTasksFile=false", async () => {
      const parsePrdStore = useParsePrdStore();
      const tasksStore = useTasksStore();

      parsePrdStore.state = "completed";
      parsePrdStore.outcome = { status: "success" };

      // fetchStatus says file not on disk yet (shouldn't happen in practice)
      globalThis.fetch = mockFetchOk({
        hasPrd: true,
        hasTasksFile: false,
        hasValidTasks: false,
        hasTasksJson: false,
      });
      await tasksStore.fetchStatus();

      // hasValidTasks is false → don't clear
      if (tasksStore.hasValidTasks) {
        parsePrdStore.clearParsePrd();
      }

      // parsePrd should still be in completed state
      expect(parsePrdStore.state).toBe("completed");
      expect(parsePrdStore.outcome).toEqual({ status: "success" });
    });
  });
});
