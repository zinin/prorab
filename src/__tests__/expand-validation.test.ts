import { describe, it, expect } from "vitest";
import {
  parseExpandResult,
  validateExpandResult,
  type ExpandValidationSuccess,
  type ExpandValidationFailure,
} from "../core/expand-validation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid subtask. */
function subtask(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: `Subtask ${id}`,
    description: `Description for subtask ${id}`,
    details: `Details for subtask ${id}`,
    dependencies: [],
    ...overrides,
  };
}

/** Shorthand to assert success outcome. */
function expectSuccess(
  outcome: ReturnType<typeof parseExpandResult>,
): asserts outcome is ExpandValidationSuccess {
  expect(outcome.ok).toBe(true);
}

/** Shorthand to assert failure outcome with given reason. */
function expectFailure(
  outcome: ReturnType<typeof parseExpandResult>,
  reason: string,
): asserts outcome is ExpandValidationFailure {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toBe(reason);
  }
}

// ===========================================================================
// parseExpandResult
// ===========================================================================

describe("parseExpandResult", () => {
  // -------------------------------------------------------------------------
  // Positive cases
  // -------------------------------------------------------------------------

  describe("positive cases", () => {
    it("parses valid result with subtasks", () => {
      const json = JSON.stringify({
        subtasks: [subtask(1), subtask(2, { dependencies: [1] })],
      });
      const outcome = parseExpandResult(json);
      expectSuccess(outcome);
      expect(outcome.data.subtasks).toHaveLength(2);
      expect(outcome.data.subtasks[0].id).toBe(1);
      expect(outcome.data.subtasks[1].id).toBe(2);
      expect(outcome.data.subtasks[1].dependencies).toEqual([1]);
    });

    it("parses valid empty subtasks array", () => {
      const outcome = parseExpandResult('{"subtasks": []}');
      expectSuccess(outcome);
      expect(outcome.data.subtasks).toHaveLength(0);
    });

    it("handles surrounding whitespace", () => {
      const json = `  \n  {"subtasks": []}  \n  `;
      const outcome = parseExpandResult(json);
      expectSuccess(outcome);
    });

    it("accepts optional testStrategy field", () => {
      const json = JSON.stringify({
        subtasks: [subtask(1, { testStrategy: "Run unit tests" })],
      });
      const outcome = parseExpandResult(json);
      expectSuccess(outcome);
      expect(outcome.data.subtasks[0].testStrategy).toBe("Run unit tests");
    });

    it("trims string fields (title, description, details, testStrategy)", () => {
      const json = JSON.stringify({
        subtasks: [
          subtask(1, {
            title: "  Trimmed title  ",
            description: "  Trimmed desc  ",
            details: "  Trimmed details  ",
            testStrategy: "  Trimmed strategy  ",
          }),
        ],
      });
      const outcome = parseExpandResult(json);
      expectSuccess(outcome);
      expect(outcome.data.subtasks[0].title).toBe("Trimmed title");
      expect(outcome.data.subtasks[0].description).toBe("Trimmed desc");
      expect(outcome.data.subtasks[0].details).toBe("Trimmed details");
      expect(outcome.data.subtasks[0].testStrategy).toBe("Trimmed strategy");
    });

    it("accepts multiple subtasks with valid dependencies", () => {
      const json = JSON.stringify({
        subtasks: [
          subtask(1),
          subtask(2, { dependencies: [1] }),
          subtask(3, { dependencies: [1, 2] }),
        ],
      });
      const outcome = parseExpandResult(json);
      expectSuccess(outcome);
      expect(outcome.data.subtasks).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: empty / missing message
  // -------------------------------------------------------------------------

  describe("empty or missing message", () => {
    it("rejects null message", () => {
      const outcome = parseExpandResult(null);
      expectFailure(outcome, "result_parse_failed");
      expect(outcome.errors[0]).toMatch(/empty or missing/i);
    });

    it("rejects undefined message", () => {
      const outcome = parseExpandResult(undefined);
      expectFailure(outcome, "result_parse_failed");
      expect(outcome.errors[0]).toMatch(/empty or missing/i);
    });

    it("rejects empty string", () => {
      const outcome = parseExpandResult("");
      expectFailure(outcome, "result_parse_failed");
      expect(outcome.errors[0]).toMatch(/empty or missing/i);
    });

    it("rejects whitespace-only string", () => {
      const outcome = parseExpandResult("   \n\t  ");
      expectFailure(outcome, "result_parse_failed");
      expect(outcome.errors[0]).toMatch(/empty or missing/i);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: not valid JSON
  // -------------------------------------------------------------------------

  describe("invalid JSON", () => {
    it("rejects non-JSON text", () => {
      const outcome = parseExpandResult("This is not JSON");
      expectFailure(outcome, "result_parse_failed");
      expect(outcome.errors[0]).toMatch(/Failed to parse agent output as JSON/);
    });

    it("rejects truncated JSON", () => {
      const outcome = parseExpandResult('{"subtasks": [');
      expectFailure(outcome, "result_parse_failed");
      expect(outcome.errors[0]).toMatch(/Failed to parse agent output as JSON/);
    });

    it("rejects JSON with trailing comma", () => {
      const outcome = parseExpandResult('{"subtasks": [1,]}');
      expectFailure(outcome, "result_parse_failed");
      expect(outcome.errors[0]).toMatch(/Failed to parse agent output as JSON/);
    });

    it("includes technical details from JSON.parse error", () => {
      const outcome = parseExpandResult("{bad json}");
      expectFailure(outcome, "result_parse_failed");
      // The error message should contain the JSON.parse error detail
      expect(outcome.errors[0]).toMatch(/Failed to parse agent output as JSON:/);
      expect(outcome.errors[0].length).toBeGreaterThan(
        "Failed to parse agent output as JSON: ".length,
      );
    });

    it("does NOT extract JSON from prose wrapping", () => {
      const json = JSON.stringify({ subtasks: [] });
      const wrapped = `Here is the result:\n${json}\nDone!`;
      const outcome = parseExpandResult(wrapped);
      expectFailure(outcome, "result_parse_failed");
    });

    it("does NOT extract JSON from markdown fences", () => {
      const json = JSON.stringify({ subtasks: [] });
      const fenced = "```json\n" + json + "\n```";
      const outcome = parseExpandResult(fenced);
      expectFailure(outcome, "result_parse_failed");
    });
  });

  // -------------------------------------------------------------------------
  // Negative: schema / validation failures (delegated to validateExpandResult)
  // -------------------------------------------------------------------------

  describe("schema validation failures via parseExpandResult", () => {
    it("rejects JSON array (not an object)", () => {
      const outcome = parseExpandResult("[]");
      expectFailure(outcome, "validation_failed");
    });

    it("rejects JSON string", () => {
      const outcome = parseExpandResult('"hello"');
      expectFailure(outcome, "validation_failed");
    });

    it("rejects JSON number", () => {
      const outcome = parseExpandResult("42");
      expectFailure(outcome, "validation_failed");
    });

    it("rejects object without subtasks key", () => {
      const outcome = parseExpandResult('{"tasks": []}');
      expectFailure(outcome, "validation_failed");
    });
  });
});

// ===========================================================================
// validateExpandResult
// ===========================================================================

describe("validateExpandResult", () => {
  // -------------------------------------------------------------------------
  // Positive cases
  // -------------------------------------------------------------------------

  describe("positive cases", () => {
    it("accepts valid result with subtasks", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1), subtask(2, { dependencies: [1] })],
      });
      expectSuccess(outcome);
      expect(outcome.data.subtasks).toHaveLength(2);
    });

    it("accepts empty subtasks array", () => {
      const outcome = validateExpandResult({ subtasks: [] });
      expectSuccess(outcome);
      expect(outcome.data.subtasks).toHaveLength(0);
    });

    it("accepts single subtask with no dependencies", () => {
      const outcome = validateExpandResult({ subtasks: [subtask(1)] });
      expectSuccess(outcome);
    });

    it("accepts subtask without testStrategy alongside one that has it", () => {
      // Verify that testStrategy is truly optional per-subtask:
      // subtask 1 has testStrategy, subtask 2 does not.
      const outcome = validateExpandResult({
        subtasks: [
          subtask(1, { testStrategy: "Unit tests" }),
          subtask(2, { dependencies: [1] }),
        ],
      });
      expectSuccess(outcome);
      expect(outcome.data.subtasks[0].testStrategy).toBe("Unit tests");
      expect(outcome.data.subtasks[1].testStrategy).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Negative: top-level shape
  // -------------------------------------------------------------------------

  describe("top-level shape", () => {
    it("rejects null", () => {
      const outcome = validateExpandResult(null);
      expectFailure(outcome, "validation_failed");
    });

    it("rejects undefined", () => {
      const outcome = validateExpandResult(undefined);
      expectFailure(outcome, "validation_failed");
    });

    it("rejects array", () => {
      const outcome = validateExpandResult([]);
      expectFailure(outcome, "validation_failed");
    });

    it("rejects number", () => {
      const outcome = validateExpandResult(42);
      expectFailure(outcome, "validation_failed");
    });

    it("rejects string", () => {
      const outcome = validateExpandResult("hello");
      expectFailure(outcome, "validation_failed");
    });

    it("rejects object without subtasks", () => {
      const outcome = validateExpandResult({ tasks: [] });
      expectFailure(outcome, "validation_failed");
      expect(outcome.errors.some((e) => e.includes("subtasks"))).toBe(true);
    });

    it("rejects extra top-level fields (strict mode)", () => {
      const outcome = validateExpandResult({
        subtasks: [],
        extraField: "nope",
      });
      expectFailure(outcome, "validation_failed");
      expect(
        outcome.errors.some((e) => /unrecognized/i.test(e)),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: extra fields on subtasks
  // -------------------------------------------------------------------------

  describe("extra subtask fields", () => {
    it("rejects unknown fields in subtask (strict mode)", () => {
      const outcome = validateExpandResult({
        subtasks: [{ ...subtask(1), priority: "high" }],
      });
      expectFailure(outcome, "validation_failed");
      expect(
        outcome.errors.some((e) => /unrecognized/i.test(e)),
      ).toBe(true);
    });

    it("rejects multiple unknown fields", () => {
      const outcome = validateExpandResult({
        subtasks: [{ ...subtask(1), priority: "high", status: "done" }],
      });
      expectFailure(outcome, "validation_failed");
    });
  });

  // -------------------------------------------------------------------------
  // Negative: sequential ID violations
  // -------------------------------------------------------------------------

  describe("sequential ID violations", () => {
    it("rejects IDs starting from 0", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(0), subtask(1)],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects IDs starting from 2 (gap at beginning)", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(2), subtask(3)],
      });
      expectFailure(outcome, "validation_failed");
      expect(
        outcome.errors.some((e) => /sequential/i.test(e) || /expected/i.test(e)),
      ).toBe(true);
    });

    it("rejects gap in IDs (1, 3)", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1), subtask(3)],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects duplicate IDs", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1), subtask(1)],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects out-of-order IDs (2, 1)", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(2), subtask(1)],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects negative IDs", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(-1)],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects non-integer IDs (float)", () => {
      const outcome = validateExpandResult({
        subtasks: [{ ...subtask(1), id: 1.5 }],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects string IDs", () => {
      const outcome = validateExpandResult({
        subtasks: [{ ...subtask(1), id: "1" }],
      });
      expectFailure(outcome, "validation_failed");
    });
  });

  // -------------------------------------------------------------------------
  // Negative: empty strings after trim
  // -------------------------------------------------------------------------

  describe("empty strings after trim", () => {
    it("rejects empty title", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { title: "" })],
      });
      expectFailure(outcome, "validation_failed");
      expect(outcome.errors.some((e) => e.includes("title") || e.includes("String"))).toBe(true);
    });

    it("rejects whitespace-only title", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { title: "   " })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects empty description", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { description: "" })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects whitespace-only description", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { description: "  \t\n  " })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects empty details", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { details: "" })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects whitespace-only details", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { details: "   " })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects empty testStrategy when present", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { testStrategy: "" })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects whitespace-only testStrategy", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { testStrategy: "   " })],
      });
      expectFailure(outcome, "validation_failed");
    });
  });

  // -------------------------------------------------------------------------
  // Negative: dependency violations
  // -------------------------------------------------------------------------

  describe("dependency violations", () => {
    it("rejects forward dependency", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { dependencies: [2] }), subtask(2)],
      });
      expectFailure(outcome, "validation_failed");
      expect(
        outcome.errors.some((e) => /forward reference/i.test(e)),
      ).toBe(true);
    });

    it("rejects self-dependency", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { dependencies: [1] })],
      });
      expectFailure(outcome, "validation_failed");
      expect(
        outcome.errors.some((e) => /cannot depend on itself/i.test(e)),
      ).toBe(true);
    });

    it("rejects dependency referencing non-existent subtask", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { dependencies: [99] })],
      });
      expectFailure(outcome, "validation_failed");
      expect(
        outcome.errors.some((e) => /non-existent/i.test(e)),
      ).toBe(true);
    });

    it("rejects negative dependency ID", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { dependencies: [-1] })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects zero dependency ID", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { dependencies: [0] })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects non-integer dependency (float)", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1), subtask(2, { dependencies: [1.5] })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects string dependency", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1), subtask(2, { dependencies: ["1"] })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects dependencies as non-array", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { dependencies: 1 })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects implicit cycle (mutual forward reference detected by forward-ref rule)", () => {
      // Since forward references are banned, A→B and B→A is impossible
      // within sequential IDs. But let's test that if B references A which
      // references a higher ID, it's caught.
      const outcome = validateExpandResult({
        subtasks: [
          subtask(1, { dependencies: [2] }),
          subtask(2, { dependencies: [1] }),
        ],
      });
      expectFailure(outcome, "validation_failed");
      // Subtask 1 referencing 2 is a forward reference
      expect(
        outcome.errors.some((e) => /forward reference/i.test(e)),
      ).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Negative: type violations
  // -------------------------------------------------------------------------

  describe("type violations", () => {
    it("rejects subtasks as object instead of array", () => {
      const outcome = validateExpandResult({ subtasks: {} });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects subtasks as string", () => {
      const outcome = validateExpandResult({ subtasks: "[]" });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects subtasks as null", () => {
      const outcome = validateExpandResult({ subtasks: null });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects title as number", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { title: 42 })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects description as number", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { description: 42 })],
      });
      expectFailure(outcome, "validation_failed");
    });

    it("rejects details as array", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { details: ["step 1"] })],
      });
      expectFailure(outcome, "validation_failed");
    });
  });

  // -------------------------------------------------------------------------
  // Error reporting
  // -------------------------------------------------------------------------

  describe("error reporting", () => {
    it("collects multiple errors in a single validation", () => {
      // Multiple violations: gaps in IDs, self-ref, empty title
      const outcome = validateExpandResult({
        subtasks: [
          { ...subtask(1), title: "   ", dependencies: [1] },
          subtask(3), // gap: expected id=2, got id=3
        ],
      });
      expectFailure(outcome, "validation_failed");
      // Should have errors about both title and dependencies and ID
      expect(outcome.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("includes path in error messages", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { title: "" })],
      });
      expectFailure(outcome, "validation_failed");
      // Error path should reference subtasks.0.title
      expect(
        outcome.errors.some((e) => e.includes("subtasks") && e.includes("title")),
      ).toBe(true);
    });

    it("errors array is never empty on failure", () => {
      const outcome = validateExpandResult({ wrongKey: [] });
      expectFailure(outcome, "validation_failed");
      expect(outcome.errors.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Title max length
  // -------------------------------------------------------------------------

  describe("title max length", () => {
    it("accepts title at exactly 80 characters", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { title: "A".repeat(80) })],
      });
      expectSuccess(outcome);
    });

    it("rejects title exceeding 80 characters", () => {
      const outcome = validateExpandResult({
        subtasks: [subtask(1, { title: "A".repeat(81) })],
      });
      expectFailure(outcome, "validation_failed");
    });
  });
});
