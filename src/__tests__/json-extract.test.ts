import { describe, it, expect } from "vitest";
import { extractJsonFromResult } from "../core/json-extract.js";

describe("extractJsonFromResult", () => {
  // --- Happy path ---

  it("returns trimmed text when it is a single valid JSON object", () => {
    const json = '{"a": 1, "b": "hello"}';
    expect(extractJsonFromResult(`  ${json}  `)).toBe(json);
  });

  it("extracts JSON from text with leading prose", () => {
    const input = 'Here is the result:\n{"score": 7, "reason": "complex"}';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ score: 7, reason: "complex" });
  });

  it("extracts JSON from text with trailing prose", () => {
    const input = '{"score": 7}\nDone!';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ score: 7 });
  });

  it("extracts JSON wrapped in markdown fences", () => {
    const input = '```json\n{"score": 7}\n```';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ score: 7 });
  });

  it("extracts the last top-level JSON block when multiple exist", () => {
    const input = '{"first": 1}\nsome text\n{"second": 2}';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ second: 2 });
  });

  // --- Nested objects ---

  it("handles nested objects correctly", () => {
    const json = '{"outer": {"inner": {"deep": true}}, "val": 1}';
    expect(extractJsonFromResult(json)).toBe(json);
  });

  // --- Braces inside strings ---

  it("ignores braces inside JSON string values", () => {
    const json = '{"title": "Fix {config} handling", "score": 5}';
    expect(extractJsonFromResult(json)).toBe(json);
  });

  it("handles escaped quotes inside strings", () => {
    const json = '{"msg": "He said \\"hello\\"", "n": 1}';
    expect(extractJsonFromResult(json)).toBe(json);
  });

  // --- Stray braces in surrounding text ---

  it("handles stray closing brace before the JSON block", () => {
    const input = 'Some text with } stray brace\n{"score": 7}';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ score: 7 });
  });

  it("handles multiple stray closing braces before JSON", () => {
    const input = '}} some text }}\n{"result": true}';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ result: true });
  });

  it("handles stray opening brace in prose (unmatched)", () => {
    // The scanner will see the first { as a block start, but it won't close properly.
    // The last valid block should still be extracted.
    const input = 'Look at this { broken thing\n{"valid": 1}';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ valid: 1 });
  });

  // --- Edge cases ---

  it("returns null for empty string", () => {
    expect(extractJsonFromResult("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(extractJsonFromResult("   \n  ")).toBeNull();
  });

  it("returns null for text with no JSON", () => {
    expect(extractJsonFromResult("No JSON here at all")).toBeNull();
  });

  it("returns null for null/undefined input", () => {
    expect(extractJsonFromResult(null as unknown as string)).toBeNull();
    expect(extractJsonFromResult(undefined as unknown as string)).toBeNull();
  });

  // --- Fast path validation (multi-object blobs) ---

  it("does not return invalid multi-object blob via fast path", () => {
    const input = '{"a":1}\n{"b":2}';
    const result = extractJsonFromResult(input);
    // Should extract the last valid block, not the whole blob
    expect(JSON.parse(result!)).toEqual({ b: 2 });
  });

  // --- Nested objects in prose (regression: must not extract innermost) ---

  it("extracts outermost object when nested JSON is embedded in prose", () => {
    const input = 'Result:\n{"outer": {"inner": 1}, "val": 2}';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ outer: { inner: 1 }, val: 2 });
  });

  it("extracts last top-level block with nested objects among multiple blocks", () => {
    const input = '{"first": 1}\ntext\n{"outer": {"nested": true}}';
    const result = extractJsonFromResult(input);
    expect(JSON.parse(result!)).toEqual({ outer: { nested: true } });
  });
});
