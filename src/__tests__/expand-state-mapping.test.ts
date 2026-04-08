/**
 * Tests for expand-state-mapping.ts — pure functions for mapping
 * server expand state to the expand store.
 *
 * Modeled on parse-prd-state-mapping tests inline in parse-prd-store-ws-handlers.test.ts,
 * but extracted as a dedicated test file for the mapping composable.
 */
import { describe, it, expect, vi } from "vitest";
import {
  applyConnectedExpandState,
  type ExpandStateStore,
} from "../../ui/src/composables/expand-state-mapping";

/**
 * Creates a minimal mock store for testing the mapping function.
 */
function createMockStore(): ExpandStateStore & { setRehydratingCalls: boolean[] } {
  const calls: boolean[] = [];
  return {
    state: "idle" as const,
    sessionInfo: null,
    outcome: null,
    setRehydrating(v: boolean) {
      calls.push(v);
    },
    setRehydratingCalls: calls,
  };
}

describe("applyConnectedExpandState", () => {
  describe("active session (expandSession present)", () => {
    it("sets state from expandSession.state", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-1",
          taskId: "7",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      });

      expect(store.state).toBe("active");
    });

    it("defaults state to active when expandSession.state is missing", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-2",
          taskId: "7",
          agent: "claude",
        },
      });

      expect(store.state).toBe("active");
    });

    it("sets stopping state from expandSession", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-3",
          taskId: "7",
          agent: "claude",
          state: "stopping",
        },
      });

      expect(store.state).toBe("stopping");
    });

    it("sets sessionInfo with all fields", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-4",
          taskId: "42",
          agent: "opencode",
          model: "gpt-4",
          variant: "high",
          state: "active",
        },
      });

      expect(store.sessionInfo).toEqual({
        sessionId: "exp-4",
        taskId: "42",
        agent: "opencode",
        model: "gpt-4",
        variant: "high",
      });
    });

    it("handles optional model/variant being undefined", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-5",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
      });

      expect(store.sessionInfo?.model).toBeUndefined();
      expect(store.sessionInfo?.variant).toBeUndefined();
    });

    it("clears outcome when session is active", () => {
      const store = createMockStore();
      store.outcome = { status: "success", taskId: "old", subtaskCount: 2 };

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-6",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
      });

      expect(store.outcome).toBeNull();
    });

    it("enables rehydrating", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-7",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
      });

      expect(store.setRehydratingCalls).toEqual([true]);
    });

    it("expandSession takes priority over expandOutcome", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-8",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 3 },
      });

      expect(store.state).toBe("active");
      expect(store.outcome).toBeNull(); // session wins, outcome cleared
      expect(store.sessionInfo?.taskId).toBe("7");
    });
  });

  describe("terminal outcome (expandOutcome present, no session)", () => {
    it("sets state to completed", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      });

      expect(store.state).toBe("completed");
    });

    it("clears sessionInfo", () => {
      const store = createMockStore();
      store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude" };

      applyConnectedExpandState(store, {
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      });

      expect(store.sessionInfo).toBeNull();
    });

    it("sets success outcome", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      });

      expect(store.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
    });

    it("sets failure outcome with all fields", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandOutcome: {
          status: "failure",
          taskId: "7",
          reason: "hash_conflict",
          errors: ["tasks.json modified"],
          message: "tasks.json modified",
          subtaskCount: 0,
        },
      });

      expect(store.outcome).toEqual({
        status: "failure",
        taskId: "7",
        reason: "hash_conflict",
        errors: ["tasks.json modified"],
        message: "tasks.json modified",
        subtaskCount: 0,
      });
    });

    it("sets cancelled outcome", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandOutcome: { status: "cancelled", taskId: "7", subtaskCount: 0 },
      });

      expect(store.outcome).toEqual({ status: "cancelled", taskId: "7", subtaskCount: 0 });
    });

    it("enables rehydrating", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      });

      expect(store.setRehydratingCalls).toEqual([true]);
    });
  });

  describe("neither present (reset to idle)", () => {
    it("sets state to idle", () => {
      const store = createMockStore();
      store.state = "completed";

      applyConnectedExpandState(store, {});

      expect(store.state).toBe("idle");
    });

    it("clears sessionInfo", () => {
      const store = createMockStore();
      store.sessionInfo = { sessionId: "s1", taskId: "7", agent: "claude" };

      applyConnectedExpandState(store, {});

      expect(store.sessionInfo).toBeNull();
    });

    it("clears outcome", () => {
      const store = createMockStore();
      store.outcome = { status: "success", taskId: "7", subtaskCount: 4 };

      applyConnectedExpandState(store, {});

      expect(store.outcome).toBeNull();
    });

    it("enables rehydrating even when no expand data is present", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {});

      // Always enable rehydrating to guard against stale replay events
      expect(store.setRehydratingCalls).toEqual([true]);
    });

    it("handles null expandSession gracefully", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: null,
        expandOutcome: null,
      });

      expect(store.state).toBe("idle");
      expect(store.sessionInfo).toBeNull();
      expect(store.outcome).toBeNull();
    });

    it("handles empty object as expandSession (falsy check)", () => {
      const store = createMockStore();

      // Empty object is truthy but has no required fields
      applyConnectedExpandState(store, {
        expandSession: {},
      });

      // expandSession is truthy and an object, so it enters the session branch
      // But with missing fields, it will set undefined values
      expect(store.state).toBe("active"); // defaults via ?? "active"
    });
  });

  describe("state whitelist validation", () => {
    it("falls back to 'active' when expandSession.state is an unknown value", () => {
      const store = createMockStore();

      applyConnectedExpandState(store, {
        expandSession: {
          sessionId: "exp-bad-state",
          taskId: "7",
          agent: "claude",
          state: "bogus_state",
        },
      });

      // Unknown state should fall back to "active" instead of passing through
      expect(store.state).toBe("active");
    });

    it("accepts all known valid states without fallback", () => {
      for (const validState of ["idle", "active", "stopping", "completed"]) {
        const store = createMockStore();

        applyConnectedExpandState(store, {
          expandSession: {
            sessionId: "exp-valid",
            taskId: "7",
            agent: "claude",
            state: validState,
          },
        });

        expect(store.state).toBe(validState);
      }
    });
  });

  describe("edge cases", () => {
    it("does not crash on completely empty data object", () => {
      const store = createMockStore();

      expect(() => applyConnectedExpandState(store, {})).not.toThrow();
      expect(store.state).toBe("idle");
    });

    it("does not crash on data with unrelated fields", () => {
      const store = createMockStore();

      expect(() =>
        applyConnectedExpandState(store, {
          chatSession: { agent: "claude" },
          parsePrdOutcome: { status: "success" },
        }),
      ).not.toThrow();
      expect(store.state).toBe("idle");
    });
  });
});
