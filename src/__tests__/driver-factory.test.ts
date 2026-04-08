import { describe, it, expect } from "vitest";
import { createDriver } from "../core/drivers/factory.js";
import { CcsDriver } from "../core/drivers/ccs.js";
import { ClaudeDriver } from "../core/drivers/claude.js";
import { CodexDriver } from "../core/drivers/codex.js";
import { OpenCodeDriver } from "../core/drivers/opencode.js";

describe("createDriver", () => {
  it("returns ClaudeDriver for 'claude'", () => {
    const driver = createDriver("claude");
    expect(driver).toBeInstanceOf(ClaudeDriver);
  });

  it("returns OpenCodeDriver for 'opencode'", () => {
    const driver = createDriver("opencode");
    expect(driver).toBeInstanceOf(OpenCodeDriver);
  });

  it("creates CcsDriver for 'ccs'", () => {
    const driver = createDriver("ccs");
    expect(driver).toBeInstanceOf(CcsDriver);
  });

  it("creates CodexDriver for 'codex'", () => {
    const driver = createDriver("codex");
    expect(driver).toBeInstanceOf(CodexDriver);
  });

  it("throws for unknown agent type", () => {
    expect(() => createDriver("unknown" as any)).toThrow("Unknown agent type");
  });
});
