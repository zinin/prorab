// src/core/complexity-validation.ts
/**
 * Server-side parsing and validation for complexity assessment agent results.
 *
 * Two-layer design (mirrors expand-validation.ts):
 * 1. `parseComplexityResult(lastMessage)` — extract + parse JSON from raw text.
 * 2. `validateComplexityResult(parsed)` — Zod validation.
 */

import {
  ComplexityResultSchema,
  type ComplexityResult,
  type ComplexityFailureReasonCode,
} from "../prompts/complexity.js";

export interface ComplexityValidationSuccess {
  ok: true;
  data: ComplexityResult;
}

export interface ComplexityValidationFailure {
  ok: false;
  reason: ComplexityFailureReasonCode;
  errors: string[];
}

export type ComplexityValidationOutcome =
  | ComplexityValidationSuccess
  | ComplexityValidationFailure;

/**
 * Parse the agent's last textual message as a JSON complexity result.
 */
export function parseComplexityResult(
  lastMessage: string | null | undefined,
): ComplexityValidationOutcome {
  if (!lastMessage || lastMessage.trim() === "") {
    return {
      ok: false,
      reason: "result_parse_failed",
      errors: ["Agent produced no output (empty or missing last message)"],
    };
  }

  const trimmed = lastMessage.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "result_parse_failed",
      errors: [`Failed to parse agent output as JSON: ${detail}`],
    };
  }

  return validateComplexityResult(parsed);
}

/**
 * Validate a parsed JSON value against the complexity result schema.
 */
export function validateComplexityResult(
  parsed: unknown,
): ComplexityValidationOutcome {
  const result = ComplexityResultSchema.safeParse(parsed);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const prefix =
        issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return `${prefix}${issue.message}`;
    });
    return {
      ok: false,
      reason: "validation_failed",
      errors,
    };
  }

  return { ok: true, data: result.data };
}
