import { describe, it, expect } from "vitest";
import {
  buildExpandSystemPrompt,
  buildExpandTaskPrompt,
  ExpandResultSchema,
  ExpandSubtaskResultSchema,
  EXPAND_START_REASON_CODES,
  EXPAND_FAILURE_REASON_CODES,
  type ExpandTaskContext,
} from "../prompts/expand.js";

// ---------------------------------------------------------------------------
// buildExpandSystemPrompt
// ---------------------------------------------------------------------------

describe("buildExpandSystemPrompt", () => {
  it("includes working directory", () => {
    const prompt = buildExpandSystemPrompt("/my/project");
    expect(prompt).toContain("/my/project");
  });

  it("forbids looking outside project directory", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toMatch(/Do NOT look for project files outside/i);
  });

  it("enforces read-only access", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toMatch(/read-only/i);
    expect(prompt).toContain("MUST NOT modify");
    expect(prompt).toContain("git add");
    expect(prompt).toContain("git commit");
  });

  it("requires JSON-only last message (no prose)", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toMatch(/LAST textual message MUST contain ONLY/i);
    expect(prompt).toMatch(/no prose/i);
  });

  it("forbids markdown fences around JSON", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toMatch(/Do NOT wrap the JSON in markdown code fences/i);
  });

  it("forbids XML tags in output", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toMatch(/Do NOT use XML tags/i);
    expect(prompt).toContain("<task-complete>");
    expect(prompt).toContain("<task-blocked>");
  });

  it("describes subtask schema fields", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toContain('"id"');
    expect(prompt).toContain('"title"');
    expect(prompt).toContain('"description"');
    expect(prompt).toContain('"details"');
    expect(prompt).toContain('"dependencies"');
    expect(prompt).toContain("`testStrategy`");
  });

  it("specifies sequential 1..N IDs", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toContain("1..N");
  });

  it("allows empty subtasks array as valid no-op", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toContain('"subtasks": []');
  });

  it("restricts dependencies to local subtask IDs only", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    expect(prompt).toMatch(/ONLY local subtask IDs/i);
  });

  it("does not include related-task context or user prompt placeholder", () => {
    const prompt = buildExpandSystemPrompt("/tmp");
    // No related tasks, no user-supplied prompt injection point
    expect(prompt).not.toContain("related task");
    expect(prompt).not.toContain("user prompt");
    expect(prompt).not.toContain("additional context");
  });
});

// ---------------------------------------------------------------------------
// buildExpandTaskPrompt
// ---------------------------------------------------------------------------

describe("buildExpandTaskPrompt", () => {
  const fullTask: ExpandTaskContext = {
    id: 5,
    title: "Add authentication",
    description: "Implement JWT-based auth",
    details: "Use jsonwebtoken library, add middleware",
    dependencies: [1, 3],
    testStrategy: "Unit tests for middleware, integration tests for flow",
  };

  it("includes task id and title", () => {
    const prompt = buildExpandTaskPrompt(fullTask);
    expect(prompt).toContain("Task 5");
    expect(prompt).toContain("Add authentication");
  });

  it("includes description", () => {
    const prompt = buildExpandTaskPrompt(fullTask);
    expect(prompt).toContain("Implement JWT-based auth");
  });

  it("includes implementation details", () => {
    const prompt = buildExpandTaskPrompt(fullTask);
    expect(prompt).toContain("Use jsonwebtoken library");
  });

  it("includes dependencies", () => {
    const prompt = buildExpandTaskPrompt(fullTask);
    expect(prompt).toContain("1, 3");
  });

  it("includes test strategy", () => {
    const prompt = buildExpandTaskPrompt(fullTask);
    expect(prompt).toContain("Unit tests for middleware");
  });

  it("handles minimal task (only required fields)", () => {
    const minimal: ExpandTaskContext = { id: 1, title: "Setup project" };
    const prompt = buildExpandTaskPrompt(minimal);
    expect(prompt).toContain("Task 1");
    expect(prompt).toContain("Setup project");
    expect(prompt).not.toContain("## Description");
    expect(prompt).not.toContain("## Implementation Details");
    expect(prompt).not.toContain("## Dependencies");
    expect(prompt).not.toContain("## Test Strategy");
  });

  it("does not include undefined in output", () => {
    const minimal: ExpandTaskContext = { id: 2, title: "Minimal" };
    const prompt = buildExpandTaskPrompt(minimal);
    expect(prompt).not.toContain("undefined");
  });

  it("omits dependencies section when array is empty", () => {
    const task: ExpandTaskContext = {
      id: 3,
      title: "Task",
      dependencies: [],
    };
    const prompt = buildExpandTaskPrompt(task);
    expect(prompt).not.toContain("## Dependencies");
  });
});

// ---------------------------------------------------------------------------
// ExpandSubtaskResultSchema
// ---------------------------------------------------------------------------

describe("ExpandSubtaskResultSchema", () => {
  it("accepts a valid subtask", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "Create module",
      description: "Create the auth module",
      details: "Add src/auth/index.ts with passport config",
      dependencies: [],
    });
    expect(result.success).toBe(true);
  });

  it("accepts subtask with optional testStrategy", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 2,
      title: "Add tests",
      description: "Write unit tests for auth",
      details: "Use vitest, test middleware",
      dependencies: [1],
      testStrategy: "Run vitest on auth module",
    });
    expect(result.success).toBe(true);
    expect(result.data!.testStrategy).toBe("Run vitest on auth module");
  });

  it("rejects unknown fields (strict mode)", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "Create module",
      description: "desc",
      details: "details",
      dependencies: [],
      extraField: "should fail",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required field (title)", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required field (description)", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "title",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing required field (details)", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "title",
      description: "desc",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer id", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1.5,
      title: "title",
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero id", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 0,
      title: "title",
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative id", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: -1,
      title: "title",
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty title", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "",
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty description", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "title",
      description: "",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty details", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "title",
      description: "desc",
      details: "",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects string id", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: "1",
      title: "title",
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer dependency ids", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 2,
      title: "title",
      description: "desc",
      details: "details",
      dependencies: [1.5],
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero dependency id", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 2,
      title: "title",
      description: "desc",
      details: "details",
      dependencies: [0],
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only title", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "   ",
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only description", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "title",
      description: "  \n  ",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only details", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "title",
      description: "desc",
      details: "  \t  ",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects title exceeding 80 chars", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "A".repeat(81),
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts title at exactly 80 chars", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "A".repeat(80),
      description: "desc",
      details: "details",
      dependencies: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty testStrategy string", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "title",
      description: "desc",
      details: "details",
      dependencies: [],
      testStrategy: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only testStrategy", () => {
    const result = ExpandSubtaskResultSchema.safeParse({
      id: 1,
      title: "title",
      description: "desc",
      details: "details",
      dependencies: [],
      testStrategy: "   ",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExpandResultSchema
// ---------------------------------------------------------------------------

describe("ExpandResultSchema", () => {
  it("accepts valid result with subtasks", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [
        {
          id: 1,
          title: "Step 1",
          description: "First step",
          details: "Do X in src/foo.ts",
          dependencies: [],
        },
        {
          id: 2,
          title: "Step 2",
          description: "Second step",
          details: "Do Y in src/bar.ts",
          dependencies: [1],
          testStrategy: "Run tests",
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data!.subtasks).toHaveLength(2);
  });

  it("accepts empty subtasks (valid no-op)", () => {
    const result = ExpandResultSchema.safeParse({ subtasks: [] });
    expect(result.success).toBe(true);
    expect(result.data!.subtasks).toHaveLength(0);
  });

  it("rejects unknown top-level fields (strict mode)", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [],
      extra: "nope",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing subtasks field", () => {
    const result = ExpandResultSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects when subtask has unknown fields", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [
        {
          id: 1,
          title: "Step 1",
          description: "desc",
          details: "details",
          dependencies: [],
          priority: "high",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-array subtasks", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: "not an array",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-sequential IDs", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [
        {
          id: 1,
          title: "Step 1",
          description: "desc",
          details: "details",
          dependencies: [],
        },
        {
          id: 5,
          title: "Step 2",
          description: "desc",
          details: "details",
          dependencies: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects IDs not starting from 1", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [
        {
          id: 2,
          title: "Step",
          description: "desc",
          details: "details",
          dependencies: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects self-referential dependencies", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [
        {
          id: 1,
          title: "Step 1",
          description: "desc",
          details: "details",
          dependencies: [1],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects dependency on non-existent subtask id", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [
        {
          id: 1,
          title: "Step 1",
          description: "desc",
          details: "details",
          dependencies: [99],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects forward references in dependencies", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [
        {
          id: 1,
          title: "Step 1",
          description: "desc",
          details: "details",
          dependencies: [2],
        },
        {
          id: 2,
          title: "Step 2",
          description: "desc",
          details: "details",
          dependencies: [],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid sequential IDs with backward dependencies", () => {
    const result = ExpandResultSchema.safeParse({
      subtasks: [
        {
          id: 1,
          title: "Step 1",
          description: "desc",
          details: "details",
          dependencies: [],
        },
        {
          id: 2,
          title: "Step 2",
          description: "desc",
          details: "details",
          dependencies: [1],
        },
        {
          id: 3,
          title: "Step 3",
          description: "desc",
          details: "details",
          dependencies: [1, 2],
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

describe("EXPAND_START_REASON_CODES", () => {
  const expectedCodes = [
    "task_not_found",
    "tasks_file_missing",
    "tasks_file_invalid",
    "task_not_pending",
    "task_has_subtasks",
    "git_not_repo",
    "tasks_file_untracked",
    "git_identity_missing",
    "tasks_file_dirty",
    "active_session",
  ] as const;

  it("contains all expected start-time codes", () => {
    for (const code of expectedCodes) {
      expect(EXPAND_START_REASON_CODES).toContain(code);
    }
  });

  it("has exactly the expected number of codes", () => {
    expect(EXPAND_START_REASON_CODES).toHaveLength(expectedCodes.length);
  });

  it("matches the contract exactly (same order)", () => {
    expect([...EXPAND_START_REASON_CODES]).toEqual([...expectedCodes]);
  });
});

describe("EXPAND_FAILURE_REASON_CODES", () => {
  const expectedCodes = [
    "agent_failed",
    "result_parse_failed",
    "validation_failed",
    "hash_conflict",
    "commit_failed_after_write",
  ] as const;

  it("contains all expected failure codes", () => {
    for (const code of expectedCodes) {
      expect(EXPAND_FAILURE_REASON_CODES).toContain(code);
    }
  });

  it("has exactly the expected number of codes", () => {
    expect(EXPAND_FAILURE_REASON_CODES).toHaveLength(expectedCodes.length);
  });

  it("matches the contract exactly (same order)", () => {
    expect([...EXPAND_FAILURE_REASON_CODES]).toEqual([...expectedCodes]);
  });
});

// ---------------------------------------------------------------------------
// buildExpandTaskPrompt with complexity fields
// ---------------------------------------------------------------------------

describe("buildExpandTaskPrompt with complexity fields", () => {
  it("includes expansionPrompt section when present", () => {
    const prompt = buildExpandTaskPrompt({
      id: 1,
      title: "Test task",
      expansionPrompt: "Break into: auth, validation, API",
    });
    expect(prompt).toContain("Expansion Guidance");
    expect(prompt).toContain("Break into: auth, validation, API");
  });

  it("includes recommended subtask count when present and > 0", () => {
    const prompt = buildExpandTaskPrompt({
      id: 1,
      title: "Test task",
      recommendedSubtasks: 5,
    });
    expect(prompt).toContain("approximately 5 subtasks");
  });

  it("omits recommended count when 0", () => {
    const prompt = buildExpandTaskPrompt({
      id: 1,
      title: "Test task",
      recommendedSubtasks: 0,
    });
    expect(prompt).not.toContain("Recommended Subtask Count");
  });

  it("omits sections when fields absent", () => {
    const prompt = buildExpandTaskPrompt({
      id: 1,
      title: "Test task",
    });
    expect(prompt).not.toContain("Expansion Guidance");
    expect(prompt).not.toContain("Recommended Subtask Count");
  });
});
