import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexDriver } from "../core/drivers/codex.js";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("node:fs/promises");
vi.mock("node:os");

const MOCK_CACHE = {
  fetched_at: "2026-03-16T00:00:00Z",
  models: [
    {
      slug: "gpt-5.4",
      display_name: "gpt-5.4",
      visibility: "list",
      priority: 0,
      context_window: 272000,
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
      ],
    },
    {
      slug: "gpt-5.1-codex",
      display_name: "gpt-5.1-codex",
      visibility: "hide",
      priority: 5,
      context_window: 272000,
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
      ],
    },
    {
      slug: "gpt-5.1-codex-mini",
      display_name: "gpt-5.1-codex-mini",
      visibility: "list",
      priority: 10,
      context_window: 272000,
      supported_reasoning_levels: [
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
      ],
    },
  ],
};

describe("CodexDriver.listModels", () => {
  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue("/home/testuser");
  });

  it("returns visible models sorted by priority with variants", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(MOCK_CACHE));
    const driver = new CodexDriver();
    const models = await driver.listModels!();

    expect(models).toEqual([
      { id: "gpt-5.4", name: "gpt-5.4", variants: ["low", "medium", "high", "xhigh"] },
      { id: "gpt-5.1-codex-mini", name: "gpt-5.1-codex-mini", variants: ["medium", "high"] },
    ]);

    expect(fs.readFile).toHaveBeenCalledWith(
      path.join("/home/testuser", ".codex", "models_cache.json"),
      "utf-8",
    );
  });

  it("filters out models with visibility !== 'list'", async () => {
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(MOCK_CACHE));
    const driver = new CodexDriver();
    const models = await driver.listModels!();

    const ids = models.map(m => m.id);
    expect(ids).not.toContain("gpt-5.1-codex");
  });

  it("returns empty array when cache file does not exist", async () => {
    const enoent = new Error("ENOENT") as NodeJS.ErrnoException;
    enoent.code = "ENOENT";
    vi.mocked(fs.readFile).mockRejectedValue(enoent);

    const driver = new CodexDriver();
    const models = await driver.listModels!();
    expect(models).toEqual([]);
  });

  it("re-throws non-ENOENT errors", async () => {
    vi.mocked(fs.readFile).mockRejectedValue(new Error("permission denied"));

    const driver = new CodexDriver();
    await expect(driver.listModels!()).rejects.toThrow("permission denied");
  });

  it("returns empty array on invalid JSON in cache file", async () => {
    vi.mocked(fs.readFile).mockResolvedValue("{ invalid json");
    const driver = new CodexDriver();
    const models = await driver.listModels!();
    expect(models).toEqual([]);
  });
});
