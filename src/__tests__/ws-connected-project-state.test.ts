/**
 * Tests for project-state fields in the WebSocket connected message.
 *
 * Verifies that the connected payload includes the full project-state
 * contract (hasPrd, hasTasksFile, hasValidTasks) alongside the
 * backward-compatible hasTasksJson alias.
 *
 * Pure unit-level — mirrors the ws.ts connected message construction
 * without starting a real server. The message-building helper here is
 * intentionally a local replica (not extracted from ws.ts) because the
 * real connected message construction is deeply coupled to runtime state
 * (ExecutionManager, ChatManager, etc.). The real server→client path is
 * covered by the E2E tests in server-client-state-mapping.test.ts.
 */
import { describe, it, expect } from "vitest";
import type { ProjectState } from "../core/project-state.js";

/**
 * Build a connected message payload in the same shape ws.ts produces,
 * using an explicit ProjectState object (replaces getProjectState() call).
 */
function buildConnectedMessageWithProjectState(
  projectState: ProjectState,
  executionState = "idle",
) {
  return {
    type: "connected",
    state: executionState,
    currentUnit: null,
    iterationCurrent: 0,
    iterationTotal: 0,
    // Full project-state — the primary contract for UI
    hasPrd: projectState.hasPrd,
    hasTasksFile: projectState.hasTasksFile,
    hasValidTasks: projectState.hasValidTasks,
    // Backward-compatible alias
    hasTasksJson: projectState.hasTasksFile,
    chatSession: null,
    parsePrdSession: null,
    parsePrdOutcome: null,
  };
}

describe("connected message project-state fields", () => {
  it("includes all three granular fields for empty project", () => {
    const msg = buildConnectedMessageWithProjectState({
      hasPrd: false,
      hasTasksFile: false,
      hasValidTasks: false,
    });

    expect(msg.hasPrd).toBe(false);
    expect(msg.hasTasksFile).toBe(false);
    expect(msg.hasValidTasks).toBe(false);
    expect(msg.hasTasksJson).toBe(false);
  });

  it("includes hasPrd=true for PRD-only project", () => {
    const msg = buildConnectedMessageWithProjectState({
      hasPrd: true,
      hasTasksFile: false,
      hasValidTasks: false,
    });

    expect(msg.hasPrd).toBe(true);
    expect(msg.hasTasksFile).toBe(false);
    expect(msg.hasValidTasks).toBe(false);
    expect(msg.hasTasksJson).toBe(false);
  });

  it("includes all true for fully initialised project", () => {
    const msg = buildConnectedMessageWithProjectState({
      hasPrd: true,
      hasTasksFile: true,
      hasValidTasks: true,
    });

    expect(msg.hasPrd).toBe(true);
    expect(msg.hasTasksFile).toBe(true);
    expect(msg.hasValidTasks).toBe(true);
    expect(msg.hasTasksJson).toBe(true);
  });

  it("distinguishes hasTasksFile=true with hasValidTasks=false", () => {
    const msg = buildConnectedMessageWithProjectState({
      hasPrd: true,
      hasTasksFile: true,
      hasValidTasks: false,
    });

    expect(msg.hasPrd).toBe(true);
    expect(msg.hasTasksFile).toBe(true);
    expect(msg.hasValidTasks).toBe(false);
    // Backward-compatible alias maps to hasTasksFile (exists)
    expect(msg.hasTasksJson).toBe(true);
  });

  it("hasTasksJson always equals hasTasksFile (backward compat)", () => {
    // Test all combinations
    const cases: ProjectState[] = [
      { hasPrd: false, hasTasksFile: false, hasValidTasks: false },
      { hasPrd: true, hasTasksFile: false, hasValidTasks: false },
      { hasPrd: true, hasTasksFile: true, hasValidTasks: false },
      { hasPrd: true, hasTasksFile: true, hasValidTasks: true },
      { hasPrd: false, hasTasksFile: true, hasValidTasks: true },
      { hasPrd: false, hasTasksFile: true, hasValidTasks: false },
    ];

    for (const state of cases) {
      const msg = buildConnectedMessageWithProjectState(state);
      expect(msg.hasTasksJson).toBe(state.hasTasksFile);
    }
  });

  it("coexists with execution state fields", () => {
    const msg = buildConnectedMessageWithProjectState(
      { hasPrd: true, hasTasksFile: true, hasValidTasks: true },
      "running",
    );

    expect(msg.state).toBe("running");
    expect(msg.hasPrd).toBe(true);
    expect(msg.hasTasksFile).toBe(true);
    expect(msg.hasValidTasks).toBe(true);
  });
});
