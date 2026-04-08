import { describe, it, expect } from "vitest";
import { computeViewMode, type ViewModeFlags } from "../../ui/src/views/task-list-view-mode";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Unit tests for the pure computeViewMode() state machine.
 *
 * The function maps project-state flags + session states to exactly one
 * ViewMode string. Tests verify:
 *   - Each mode is reachable under the correct conditions
 *   - Priority ordering is correct (higher-priority modes shadow lower ones)
 *   - No tasks.length / tasks array heuristic is used for mode selection
 */

/** Baseline: WS connected, no tasks file, no sessions, no PRD */
const base: ViewModeFlags = {
  wsInitialized: true,
  hasTasksFile: false,
  hasValidTasks: false,
  hasPrd: false,
  loading: false,
  chatState: "idle",
  parsePrdState: "idle",
  refinePrdState: "idle",
  refineTasksState: "idle",
  batchExpandState: "idle",
};

/** Helper: merge overrides into the base flags */
function flags(overrides: Partial<ViewModeFlags> = {}): ViewModeFlags {
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Basic mode reachability
// ---------------------------------------------------------------------------
describe("computeViewMode — basic modes", () => {
  it("returns 'loading' when WS not initialized", () => {
    expect(computeViewMode(flags({ wsInitialized: false }))).toBe("loading");
  });

  it("returns 'inline-chat' when no tasks file and chat is active", () => {
    expect(computeViewMode(flags({ chatState: "active" }))).toBe("inline-chat");
  });

  it("returns 'inline-chat' when chat is in question_pending state", () => {
    expect(computeViewMode(flags({ chatState: "question_pending" }))).toBe("inline-chat");
  });

  it("returns 'inline-chat' when chat is stopping", () => {
    expect(computeViewMode(flags({ chatState: "stopping" }))).toBe("inline-chat");
  });

  it("returns 'parse-prd-progress' when parse-prd is active", () => {
    expect(computeViewMode(flags({ parsePrdState: "active" }))).toBe("parse-prd-progress");
  });

  it("returns 'parse-prd-progress' when parse-prd is stopping", () => {
    expect(computeViewMode(flags({ parsePrdState: "stopping" }))).toBe("parse-prd-progress");
  });

  it("returns 'parse-prd-progress' when parse-prd is completed", () => {
    expect(computeViewMode(flags({ parsePrdState: "completed" }))).toBe("parse-prd-progress");
  });

  it("returns 'error' when tasks file exists but is invalid", () => {
    expect(computeViewMode(flags({ hasTasksFile: true, hasValidTasks: false }))).toBe("error");
  });

  it("returns 'task-list' when tasks file is valid", () => {
    expect(computeViewMode(flags({ hasTasksFile: true, hasValidTasks: true }))).toBe("task-list");
  });

  it("returns 'wizard-chat' when no tasks file and no PRD", () => {
    expect(computeViewMode(flags())).toBe("wizard-chat");
  });

  it("returns 'wizard-parse-prd' when no tasks file but has PRD", () => {
    expect(computeViewMode(flags({ hasPrd: true }))).toBe("wizard-parse-prd");
  });
});

// ---------------------------------------------------------------------------
// Priority: active parse-prd beats wizard
// ---------------------------------------------------------------------------
describe("priority: active parse-prd > wizard", () => {
  it("parse-prd active wins over wizard-chat conditions", () => {
    expect(computeViewMode(flags({ parsePrdState: "active" }))).toBe("parse-prd-progress");
  });

  it("parse-prd active wins over wizard-parse-prd conditions", () => {
    expect(computeViewMode(flags({ hasPrd: true, parsePrdState: "active" }))).toBe("parse-prd-progress");
  });

  it("parse-prd stopping wins over wizard", () => {
    expect(computeViewMode(flags({ parsePrdState: "stopping" }))).toBe("parse-prd-progress");
  });

  it("parse-prd completed wins over wizard", () => {
    expect(computeViewMode(flags({ parsePrdState: "completed" }))).toBe("parse-prd-progress");
  });
});

// ---------------------------------------------------------------------------
// Priority: invalid tasks.json beats parse-prd wizard
// ---------------------------------------------------------------------------
describe("priority: error > wizard-parse-prd", () => {
  it("error shown when tasks file is invalid even with PRD present", () => {
    expect(
      computeViewMode(flags({ hasTasksFile: true, hasValidTasks: false, hasPrd: true })),
    ).toBe("error");
  });

  it("error shown when tasks file is invalid even without PRD", () => {
    expect(
      computeViewMode(flags({ hasTasksFile: true, hasValidTasks: false, hasPrd: false })),
    ).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Priority: active parse-prd beats error
// ---------------------------------------------------------------------------
describe("priority: parse-prd-progress > error", () => {
  it("parse-prd active shown even when tasks file is invalid", () => {
    expect(
      computeViewMode(flags({ hasTasksFile: true, hasValidTasks: false, parsePrdState: "active" })),
    ).toBe("parse-prd-progress");
  });

  it("parse-prd completed shown even when tasks file is invalid", () => {
    expect(
      computeViewMode(flags({ hasTasksFile: true, hasValidTasks: false, parsePrdState: "completed" })),
    ).toBe("parse-prd-progress");
  });
});

// ---------------------------------------------------------------------------
// Error state is never a wizard — no parse-prd CTA possible
// ---------------------------------------------------------------------------
describe("error state is distinct from wizard modes (no parse-prd CTA)", () => {
  it("error mode is returned regardless of hasPrd value", () => {
    // With PRD present — must NOT return wizard-parse-prd
    expect(
      computeViewMode(flags({ hasTasksFile: true, hasValidTasks: false, hasPrd: true })),
    ).toBe("error");
    // Without PRD — must NOT return wizard-chat
    expect(
      computeViewMode(flags({ hasTasksFile: true, hasValidTasks: false, hasPrd: false })),
    ).toBe("error");
  });

  it("error mode never equals any wizard mode", () => {
    const cases: Partial<ViewModeFlags>[] = [
      { hasTasksFile: true, hasValidTasks: false, hasPrd: true },
      { hasTasksFile: true, hasValidTasks: false, hasPrd: false },
      { hasTasksFile: true, hasValidTasks: false, hasPrd: true, chatState: "idle" },
      { hasTasksFile: true, hasValidTasks: false, hasPrd: false, chatState: "idle" },
    ];
    for (const overrides of cases) {
      const mode = computeViewMode(flags(overrides));
      expect(mode).not.toBe("wizard-chat");
      expect(mode).not.toBe("wizard-parse-prd");
    }
  });

  it("error mode is stable across all parsePrdState=idle combinations", () => {
    // When parsePrdState is idle and tasks file is invalid, it must be 'error'
    // regardless of hasPrd or chatState (as long as chatState is idle + hasTasksFile)
    const mode = computeViewMode(
      flags({
        hasTasksFile: true,
        hasValidTasks: false,
        hasPrd: true,
        chatState: "idle",
        parsePrdState: "idle",
      }),
    );
    expect(mode).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Priority: valid tasks.json beats empty state — no tasks.length heuristic
// ---------------------------------------------------------------------------
describe("priority: task-list covers both empty and populated states", () => {
  it("valid tasks.json always produces task-list mode (no tasks.length input)", () => {
    // The computeViewMode function receives NO information about the task count.
    // Both "zero tasks" and "many tasks" result in the same mode.
    expect(computeViewMode(flags({ hasTasksFile: true, hasValidTasks: true }))).toBe("task-list");
  });

  it("task-list mode is independent of loading state when valid", () => {
    // Even while still loading, valid tasks.json → task-list
    expect(
      computeViewMode(flags({ hasTasksFile: true, hasValidTasks: true, loading: true })),
    ).toBe("task-list");
  });
});

// ---------------------------------------------------------------------------
// No tasks.length / tasks array in the ViewModeFlags interface
// ---------------------------------------------------------------------------
describe("no tasks.length heuristic", () => {
  it("ViewModeFlags does not accept tasks array or count", () => {
    const f = flags();
    // The interface should not contain any tasks-array-related properties
    expect(f).not.toHaveProperty("tasks");
    expect(f).not.toHaveProperty("tasksLength");
    expect(f).not.toHaveProperty("tasksCount");
    expect(f).not.toHaveProperty("taskCount");
  });

  it("computeViewMode source does not reference tasks.length or tasks array", () => {
    const src = readFileSync(
      resolve(__dirname, "../../ui/src/views/task-list-view-mode.ts"),
      "utf-8",
    );
    // The pure function body should not contain tasks.length or array checks
    expect(src).not.toContain("tasks.length");
    expect(src).not.toContain("tasksCount");
    expect(src).not.toMatch(/\btasks\s*\.\s*length\b/);
  });
});

// ---------------------------------------------------------------------------
// Loading edge cases
// ---------------------------------------------------------------------------
describe("loading edge cases", () => {
  it("returns error when loading and hasTasksFile but invalid — loading does not mask error", () => {
    // hasTasksFile true, hasValidTasks false, loading true → error
    // Once wsInitialized, validity is authoritative from the server.
    expect(
      computeViewMode(flags({ hasTasksFile: true, hasValidTasks: false, loading: true })),
    ).toBe("error");
  });

  it("loading does not affect wizard modes", () => {
    // Loading flag is irrelevant when hasTasksFile is false
    expect(computeViewMode(flags({ loading: true }))).toBe("wizard-chat");
    expect(computeViewMode(flags({ loading: true, hasPrd: true }))).toBe("wizard-parse-prd");
  });
});

// ---------------------------------------------------------------------------
// WS not initialized overrides everything
// ---------------------------------------------------------------------------
describe("loading overrides all", () => {
  it("returns 'loading' even if chat is active", () => {
    expect(computeViewMode(flags({ wsInitialized: false, chatState: "active" }))).toBe("loading");
  });

  it("returns 'loading' even if parse-prd is active", () => {
    expect(computeViewMode(flags({ wsInitialized: false, parsePrdState: "active" }))).toBe("loading");
  });

  it("returns 'loading' even if tasks file is valid", () => {
    expect(
      computeViewMode(flags({ wsInitialized: false, hasTasksFile: true, hasValidTasks: true })),
    ).toBe("loading");
  });

  it("returns 'loading' even if error conditions are met", () => {
    expect(
      computeViewMode(flags({ wsInitialized: false, hasTasksFile: true, hasValidTasks: false })),
    ).toBe("loading");
  });
});

// ---------------------------------------------------------------------------
// Inline-chat requires !hasTasksFile (chat on main page is idea-to-PRD only)
// ---------------------------------------------------------------------------
describe("inline-chat gate on !hasTasksFile", () => {
  it("does NOT return inline-chat when tasks file exists even if chat is active", () => {
    // When tasks file exists, chat goes to /chat route, not inline
    const mode = computeViewMode(
      flags({ hasTasksFile: true, hasValidTasks: true, chatState: "active" }),
    );
    expect(mode).not.toBe("inline-chat");
    expect(mode).toBe("task-list");
  });
});

// ---------------------------------------------------------------------------
// batch-expand-progress mode
// ---------------------------------------------------------------------------
describe("computeViewMode — batch-expand-progress", () => {
  it("returns 'batch-expand-progress' when batchExpandState is active", () => {
    expect(computeViewMode(flags({ hasTasksFile: true, hasValidTasks: true, batchExpandState: "active" }))).toBe("batch-expand-progress");
  });

  it("returns 'batch-expand-progress' when batchExpandState is stopping", () => {
    expect(computeViewMode(flags({ hasTasksFile: true, hasValidTasks: true, batchExpandState: "stopping" }))).toBe("batch-expand-progress");
  });

  it("returns 'batch-expand-progress' when batchExpandState is completed", () => {
    expect(computeViewMode(flags({ hasTasksFile: true, hasValidTasks: true, batchExpandState: "completed" }))).toBe("batch-expand-progress");
  });

  it("returns 'task-list' when batchExpandState is idle", () => {
    expect(computeViewMode(flags({ hasTasksFile: true, hasValidTasks: true, batchExpandState: "idle" }))).toBe("task-list");
  });
});

describe("priority: parse-prd-progress > batch-expand-progress", () => {
  it("parse-prd wins when both are active", () => {
    expect(computeViewMode(flags({
      parsePrdState: "active",
      batchExpandState: "active",
    }))).toBe("parse-prd-progress");
  });
});

describe("priority: batch-expand-progress > error", () => {
  it("batch-expand active shown even when tasks file is invalid", () => {
    expect(computeViewMode(flags({
      hasTasksFile: true,
      hasValidTasks: false,
      batchExpandState: "active",
    }))).toBe("batch-expand-progress");
  });
});

// ---------------------------------------------------------------------------
// Exhaustive: all ten ViewMode values are reachable
// ---------------------------------------------------------------------------
describe("all ViewMode values are reachable", () => {
  const reachable = new Set<string>();

  const scenarios: [string, Partial<ViewModeFlags>][] = [
    ["loading", { wsInitialized: false }],
    ["inline-chat", { chatState: "active" }],
    ["refine-prd-progress", { refinePrdState: "active" }],
    ["parse-prd-progress", { parsePrdState: "active" }],
    ["refine-tasks-progress", { refineTasksState: "active" }],
    ["batch-expand-progress", { hasTasksFile: true, hasValidTasks: true, batchExpandState: "active" }],
    ["error", { hasTasksFile: true, hasValidTasks: false }],
    ["task-list", { hasTasksFile: true, hasValidTasks: true }],
    ["wizard-chat", {}],
    ["wizard-parse-prd", { hasPrd: true }],
  ];

  for (const [expected, overrides] of scenarios) {
    it(`can reach '${expected}'`, () => {
      const result = computeViewMode(flags(overrides));
      expect(result).toBe(expected);
      reachable.add(result);
    });
  }

  it("all ten modes are covered by the scenarios above", () => {
    // Run all scenarios first to populate the set
    for (const [, overrides] of scenarios) {
      reachable.add(computeViewMode(flags(overrides)));
    }
    expect(reachable.size).toBe(10);
  });
});
