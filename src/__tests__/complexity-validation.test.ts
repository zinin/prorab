// src/__tests__/complexity-validation.test.ts
import { describe, it, expect } from "vitest";
import {
  parseComplexityResult,
  validateComplexityResult,
  type ComplexityValidationSuccess,
  type ComplexityValidationFailure,
} from "../core/complexity-validation.js";

function expectSuccess(
  outcome: ReturnType<typeof parseComplexityResult>,
): asserts outcome is ComplexityValidationSuccess {
  expect(outcome.ok).toBe(true);
}

function expectFailure(
  outcome: ReturnType<typeof parseComplexityResult>,
  reason: string,
): asserts outcome is ComplexityValidationFailure {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.reason).toBe(reason);
}

const VALID = {
  complexityScore: 7,
  recommendedSubtasks: 5,
  expansionPrompt: "Break into: setup, core, integration, tests, docs",
  reasoning: "Requires multiple integrations and careful error handling",
};

describe("parseComplexityResult", () => {
  it("parses valid result", () => {
    const outcome = parseComplexityResult(JSON.stringify(VALID));
    expectSuccess(outcome);
    expect(outcome.data.complexityScore).toBe(7);
    expect(outcome.data.recommendedSubtasks).toBe(5);
  });

  it("handles surrounding whitespace", () => {
    const outcome = parseComplexityResult(`  \n  ${JSON.stringify(VALID)}  \n  `);
    expectSuccess(outcome);
  });

  it("accepts recommendedSubtasks: 0", () => {
    const outcome = parseComplexityResult(JSON.stringify({ ...VALID, recommendedSubtasks: 0 }));
    expectSuccess(outcome);
    expect(outcome.data.recommendedSubtasks).toBe(0);
  });

  it("rejects null input", () => {
    expectFailure(parseComplexityResult(null), "result_parse_failed");
  });

  it("rejects empty string", () => {
    expectFailure(parseComplexityResult(""), "result_parse_failed");
  });

  it("rejects invalid JSON", () => {
    expectFailure(parseComplexityResult("{not json}"), "result_parse_failed");
  });
});

describe("validateComplexityResult", () => {
  it("rejects score below 1", () => {
    expectFailure(
      validateComplexityResult({ ...VALID, complexityScore: 0 }),
      "validation_failed",
    );
  });

  it("rejects score above 10", () => {
    expectFailure(
      validateComplexityResult({ ...VALID, complexityScore: 11 }),
      "validation_failed",
    );
  });

  it("rejects non-integer score", () => {
    expectFailure(
      validateComplexityResult({ ...VALID, complexityScore: 5.5 }),
      "validation_failed",
    );
  });

  it("rejects negative recommendedSubtasks", () => {
    expectFailure(
      validateComplexityResult({ ...VALID, recommendedSubtasks: -1 }),
      "validation_failed",
    );
  });

  it("accepts empty expansionPrompt (atomic tasks have recommendedSubtasks: 0)", () => {
    const outcome = validateComplexityResult({ ...VALID, expansionPrompt: "" });
    expectSuccess(outcome);
  });

  it("rejects empty reasoning", () => {
    expectFailure(
      validateComplexityResult({ ...VALID, reasoning: "" }),
      "validation_failed",
    );
  });

  it("accepts unknown fields (no strict mode for LLM output)", () => {
    const outcome = validateComplexityResult({ ...VALID, extra: "nope" });
    expectSuccess(outcome);
  });

  it("rejects missing required fields", () => {
    const { complexityScore: _, ...rest } = VALID;
    expectFailure(validateComplexityResult(rest), "validation_failed");
  });
});
