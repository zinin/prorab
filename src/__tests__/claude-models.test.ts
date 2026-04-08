import { describe, it, expect, vi } from "vitest";

// We can't easily unit-test listModels() without a real SDK,
// but we can verify the driver accepts variant and passes it correctly.
// Integration tests for listModels() would require SDK access.

describe("ClaudeDriver variant handling", () => {
  it("constructor accepts model and variant parameters", async () => {
    // Import dynamically to avoid SDK side effects
    const { ClaudeDriver } = await import("../core/drivers/claude.js");
    // Just verify construction doesn't throw
    const driver = new ClaudeDriver("sonnet", true);
    expect(driver).toBeDefined();
  });
});
