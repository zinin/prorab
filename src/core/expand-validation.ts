/**
 * Server-side parsing and validation for expand (task decomposition) agent results.
 *
 * Independent of UI and file writes: takes the agent's last textual message and
 * either returns a valid `ExpandResult` or explains why the result cannot be applied.
 *
 * Two-layer design:
 * 1. `parseExpandResult(lastMessage)` — extract + parse JSON from raw text.
 * 2. `validateExpandResult(parsed)` — structural + semantic validation via Zod + business rules.
 */

import {
  ExpandResultSchema,
  type ExpandResult,
  type ExpandFailureReasonCode,
} from "../prompts/expand.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Successful parse+validate outcome carrying the validated result. */
export interface ExpandValidationSuccess {
  ok: true;
  data: ExpandResult;
}

/** Failed parse or validate outcome with machine-readable reason and error list. */
export interface ExpandValidationFailure {
  ok: false;
  reason: ExpandFailureReasonCode;
  errors: string[];
}

export type ExpandValidationOutcome =
  | ExpandValidationSuccess
  | ExpandValidationFailure;

// ---------------------------------------------------------------------------
// parseExpandResult — extract JSON from raw agent text
// ---------------------------------------------------------------------------

/**
 * Parse the agent's last textual message as a JSON expand result.
 *
 * - Empty/missing input → `result_parse_failed`.
 * - Parses the entire trimmed text as JSON (no fragment search).
 * - On `JSON.parse` failure → `result_parse_failed` with technical details.
 * - On success → delegates to `validateExpandResult` for schema validation.
 */
export function parseExpandResult(
  lastMessage: string | null | undefined,
): ExpandValidationOutcome {
  // No message or empty after trim
  if (!lastMessage) {
    return {
      ok: false,
      reason: "result_parse_failed",
      errors: ["Agent produced no output (empty or missing last message)"],
    };
  }

  const trimmed = lastMessage.trim();

  if (trimmed === "") {
    return {
      ok: false,
      reason: "result_parse_failed",
      errors: ["Agent produced no output (empty or missing last message)"],
    };
  }

  // Parse the entire text as JSON — no fragment extraction
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

  return validateExpandResult(parsed);
}

// ---------------------------------------------------------------------------
// validateExpandResult — Zod schema + business rules
// ---------------------------------------------------------------------------

/**
 * Validate a parsed JSON value against the expand result schema (REQ-004).
 *
 * Checks performed:
 * - `subtasks` must be an array (may be empty).
 * - Each subtask may only contain `id`, `title`, `description`, `details`,
 *   `dependencies`, `testStrategy` — extra fields cause explicit errors.
 * - IDs must be sequential `1..N` without gaps; array order must match `id`.
 * - `title`, `description`, `details` must be non-empty after `trim()`.
 * - `testStrategy` is optional but non-empty after `trim()` if present.
 * - `dependencies` must be an array of positive integers.
 * - Dependencies may only reference earlier subtasks (no forward refs, no self-refs).
 * - Cycles are rejected (implied by no-forward-reference + no-self-reference).
 *
 * Returns `{ ok: true, data }` on success or `{ ok: false, reason, errors }` on failure.
 */
export function validateExpandResult(
  parsed: unknown,
): ExpandValidationOutcome {
  const result = ExpandResultSchema.safeParse(parsed);

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
