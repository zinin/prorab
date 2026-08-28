/**
 * Tests for ClaudeDriver.listModels().
 *
 * The SDK reports `supportedEffortLevels` per model, and not every model has
 * them — Haiku exposes no effort knob. listModels() must therefore carry each
 * model's own levels rather than a union applied to all of them, while still
 * producing a list the wizard can derive an agent-wide Effort field from.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { computeVariantOptions } from "../../ui/src/components/agent-wizard-logic.js";

let supportedModelsFixture: Array<{
  value: string;
  displayName: string;
  supportedEffortLevels?: string[];
}> = [];

const returnSpy = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(() => {
    const gen = (async function* () {})();
    return Object.assign(gen, {
      supportedModels: vi.fn(async () => supportedModelsFixture),
      return: returnSpy,
    });
  }),
}));

/** The shape the installed SDK/CLI actually returns (claude-agent-sdk 0.3.x). */
const REAL_SHAPE = [
  { value: "default", displayName: "Default (recommended)", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "opus[1m]", displayName: "Opus (1M context)", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "claude-fable-5[1m]", displayName: "Fable", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", displayName: "Sonnet", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "haiku", displayName: "Haiku" },
];

describe("ClaudeDriver.listModels", () => {
  beforeEach(() => {
    returnSpy.mockClear();
    supportedModelsFixture = REAL_SHAPE.map(m => ({ ...m }));
  });

  it("carries each model's own effort levels", async () => {
    const { ClaudeDriver } = await import("../core/drivers/claude.js");
    const models = await new ClaudeDriver().listModels();

    expect(models.map(m => m.id)).toEqual([
      "default", "opus[1m]", "claude-fable-5[1m]", "sonnet", "haiku",
    ]);
    for (const id of ["default", "opus[1m]", "claude-fable-5[1m]", "sonnet"]) {
      expect(models.find(m => m.id === id)?.variants).toEqual(["low", "medium", "high", "xhigh"]);
    }
  });

  it("omits variants entirely for a model with no effort levels", async () => {
    const { ClaudeDriver } = await import("../core/drivers/claude.js");
    const models = await new ClaudeDriver().listModels();

    const haiku = models.find(m => m.id === "haiku")!;
    expect(haiku.variants).toBeUndefined();
    expect(haiku).not.toHaveProperty("variants");
  });

  it("filters out 'max' — not available to Claude.ai subscribers", async () => {
    const { ClaudeDriver } = await import("../core/drivers/claude.js");
    const models = await new ClaudeDriver().listModels();

    for (const m of models) {
      expect(m.variants ?? []).not.toContain("max");
    }
  });

  it("keeps the wizard's agent-wide Effort field available", async () => {
    // Regression guard: per-model levels make `variants` non-uniform across
    // the list. If computeVariantOptions treated a variant-less model as
    // "not uniform", the Effort field would vanish from the default,
    // no-model-selected state and effort would be unreachable.
    const { ClaudeDriver } = await import("../core/drivers/claude.js");
    const models = await new ClaudeDriver().listModels();

    expect(computeVariantOptions(models, "")).toEqual(["low", "medium", "high", "xhigh"]);
    expect(computeVariantOptions(models, "haiku")).toEqual([]);
    expect(computeVariantOptions(models, "sonnet")).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("closes the probe session even though it is never iterated", async () => {
    const { ClaudeDriver } = await import("../core/drivers/claude.js");
    await new ClaudeDriver().listModels();
    expect(returnSpy).toHaveBeenCalled();
  });

  it("returns an empty list when the SDK reports no models", async () => {
    supportedModelsFixture = [];
    const { ClaudeDriver } = await import("../core/drivers/claude.js");
    expect(await new ClaudeDriver().listModels()).toEqual([]);
  });
});

describe("ClaudeDriver variant handling", () => {
  it("constructor accepts model and variant parameters", async () => {
    const { ClaudeDriver } = await import("../core/drivers/claude.js");
    const driver = new ClaudeDriver("sonnet", true);
    expect(driver).toBeDefined();
  });
});
