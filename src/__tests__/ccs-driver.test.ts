import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentDriver } from "../core/drivers/types.js";

// Mock node:fs/promises before importing the module under test
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

// Mock ClaudeDriver so we don't need the real SDK
vi.mock("../core/drivers/claude.js", () => {
  const MockClaudeDriver = vi.fn(function (this: any) {
    this.setup = vi.fn().mockResolvedValue(undefined);
    this.teardown = vi.fn().mockResolvedValue(undefined);
    this.runSession = vi.fn().mockResolvedValue({ signal: { type: "complete" } });
    this.startChat = vi.fn();
    this.sendMessage = vi.fn();
    this.replyQuestion = vi.fn();
    this.abortChat = vi.fn();
  });
  return { ClaudeDriver: MockClaudeDriver };
});

import { readdir, readFile } from "node:fs/promises";
import { CcsDriver } from "../core/drivers/ccs.js";
import { ClaudeDriver } from "../core/drivers/claude.js";

const mockReaddir = vi.mocked(readdir);
const mockReadFile = vi.mocked(readFile);

describe("CcsDriver", () => {
  // Save original env so we can restore after each test
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original env to prevent test pollution
    process.env = originalEnv;
  });

  describe("constructor", () => {
    it("creates driver without profile (for listModels-only usage)", () => {
      const driver = new CcsDriver();
      expect(driver).toBeDefined();
    });

    it("creates driver with profile", () => {
      const driver = new CcsDriver("my-profile");
      expect(driver).toBeDefined();
    });
  });

  describe("setup()", () => {
    it("throws when profile is missing", async () => {
      const driver = new CcsDriver();
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        "CCS agent requires a profile name",
      );
    });

    it("builds per-session env from profile settings (no process.env mutation)", async () => {
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://custom.api.example.com",
          CUSTOM_VAR: "custom-value",
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile");
      await driver.setup({ verbosity: "info" });

      // process.env must NOT be mutated
      expect(process.env.ANTHROPIC_API_KEY).toBe(originalApiKey);

      // Verify env is injected into inner driver calls
      const mockInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "test", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      const calledOpts = mockInstance.runSession.mock.calls[0][0];
      expect(calledOpts.env).toBeDefined();
      // ANTHROPIC_AUTH_TOKEN mapped to ANTHROPIC_API_KEY
      expect(calledOpts.env.ANTHROPIC_API_KEY).toBe("sk-test-token");
      expect(calledOpts.env.ANTHROPIC_BASE_URL).toBe("https://custom.api.example.com");
      expect(calledOpts.env.CUSTOM_VAR).toBe("custom-value");

      // ClaudeDriver should be created with the model from settings
      expect(ClaudeDriver).toHaveBeenCalledWith("claude-sonnet-4-20250514", false);

      await driver.teardown();
    });

    it("calls inner driver setup", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile");
      await driver.setup({ verbosity: "info" });

      // The inner ClaudeDriver's setup should have been called
      const mockInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      expect(mockInstance.setup).toHaveBeenCalled();
    });
  });

  describe("teardown()", () => {
    it("clears session env on teardown (no env injection after teardown)", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://custom.api.example.com",
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile");
      await driver.setup({ verbosity: "info" });
      await driver.teardown();

      // After teardown, inner driver is null, so runSession should throw
      expect(() => driver.runSession({} as any)).toThrow("CCS driver not initialized");
    });

    it("calls inner driver teardown", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile");
      await driver.setup({ verbosity: "info" });

      const mockInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.teardown();

      expect(mockInstance.teardown).toHaveBeenCalled();
    });
  });

  describe("delegation methods", () => {
    it("throws if inner driver not initialized", () => {
      const driver = new CcsDriver("test-profile");
      // runSession calls requireDriver() synchronously, which throws
      expect(() => (driver as AgentDriver).runSession({} as any)).toThrow(
        "CCS driver not initialized",
      );
    });
  });

  describe("hooks bridge", () => {
    it("builds sdkHooks when applyHooks=true and profile has hooks", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
        hooks: {
          preToolUse: [
            {
              matcher: "Write",
              hooks: [
                { type: "command", command: "echo '{\"continue\":true}'" },
                { type: "command", command: "echo '{\"decision\":\"approve\"}'", timeout: 30 },
              ],
            },
            {
              hooks: [{ type: "command", command: "echo '{}'" }],
            },
          ],
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile", false, true);
      await driver.setup({ verbosity: "info" });

      // Verify inner driver's runSession receives hooks
      const mockInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "test",
        systemPrompt: "sys",
        cwd: "/tmp",
        maxTurns: 1,
        verbosity: "info",
        unitId: "u1",
      });

      expect(mockInstance.runSession).toHaveBeenCalledWith(
        expect.objectContaining({
          hooks: expect.objectContaining({
            preToolUse: expect.arrayContaining([
              expect.objectContaining({
                matcher: "Write",
                hooks: expect.any(Array),
              }),
            ]),
          }),
        }),
      );

      // Verify hooks are arrays of functions
      const calledOpts = mockInstance.runSession.mock.calls[0][0];
      const preToolUse = calledOpts.hooks.preToolUse;
      expect(preToolUse).toHaveLength(2);
      expect(preToolUse[0].matcher).toBe("Write");
      expect(preToolUse[0].hooks).toHaveLength(2);
      expect(typeof preToolUse[0].hooks[0]).toBe("function");
      expect(typeof preToolUse[0].hooks[1]).toBe("function");
      // Second matcher has no matcher field
      expect(preToolUse[1].matcher).toBeUndefined();
      expect(preToolUse[1].hooks).toHaveLength(1);

      await driver.teardown();
    });

    it("does not build sdkHooks when applyHooks=false (but still injects env)", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
        hooks: {
          preToolUse: [{ hooks: [{ type: "command", command: "echo '{}'" }] }],
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile", false, false);
      await driver.setup({ verbosity: "info" });

      const mockInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "test",
        systemPrompt: "sys",
        cwd: "/tmp",
        maxTurns: 1,
        verbosity: "info",
        unitId: "u1",
      });

      // Should delegate without hooks but WITH env
      const calledOpts = mockInstance.runSession.mock.calls[0][0];
      expect(calledOpts.hooks).toBeUndefined();
      expect(calledOpts.env).toBeDefined();
      expect(calledOpts.env.ANTHROPIC_API_KEY).toBe("sk-test-token");

      await driver.teardown();
    });

    it("does not build sdkHooks when profile has no hooks", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile", false, true);
      await driver.setup({ verbosity: "info" });

      const mockInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "test",
        systemPrompt: "sys",
        cwd: "/tmp",
        maxTurns: 1,
        verbosity: "info",
        unitId: "u1",
      });

      const calledOpts = mockInstance.runSession.mock.calls[0][0];
      expect(calledOpts.hooks).toBeUndefined();

      await driver.teardown();
    });

    it("filters out non-command hook types", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
        hooks: {
          preToolUse: [
            {
              hooks: [
                { type: "command", command: "echo '{}'" },
                { type: "unknown", command: "should-be-filtered" },
                { type: "command", command: "echo '{\"ok\":true}'" },
              ],
            },
          ],
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile", false, true);
      await driver.setup({ verbosity: "info" });

      const mockInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "test",
        systemPrompt: "sys",
        cwd: "/tmp",
        maxTurns: 1,
        verbosity: "info",
        unitId: "u1",
      });

      const calledOpts = mockInstance.runSession.mock.calls[0][0];
      // Only 2 command-type hooks should remain (non-command filtered out)
      expect(calledOpts.hooks.preToolUse[0].hooks).toHaveLength(2);

      await driver.teardown();
    });

    it("injects hooks into startChat", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
        hooks: {
          preToolUse: [{ hooks: [{ type: "command", command: "echo '{}'" }] }],
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile", false, true);
      await driver.setup({ verbosity: "info" });

      const mockInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      driver.startChat({ cwd: "/tmp", verbosity: "info" });

      expect(mockInstance.startChat).toHaveBeenCalledWith(
        expect.objectContaining({
          hooks: expect.objectContaining({
            preToolUse: expect.any(Array),
          }),
        }),
      );

      await driver.teardown();
    });

    it("clears sdkHooks on teardown", async () => {
      const settings = {
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-token",
          ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
          ANTHROPIC_BASE_URL: "https://api.example.com",
        },
        hooks: {
          preToolUse: [{ hooks: [{ type: "command", command: "echo '{}'" }] }],
        },
      };

      mockReadFile.mockResolvedValueOnce(JSON.stringify(settings));

      const driver = new CcsDriver("test-profile", false, true);
      await driver.setup({ verbosity: "info" });

      // After teardown, inner is null, so runSession should throw
      await driver.teardown();
      expect(() => driver.runSession({} as any)).toThrow("CCS driver not initialized");
    });
  });

  describe("listModels()", () => {
    it("returns profiles from ~/.ccs", async () => {
      mockReaddir.mockResolvedValueOnce([
        "profile-a.settings.json",
        "profile-b.settings.json",
        "unrelated-file.txt",
      ] as any);

      mockReadFile
        .mockResolvedValueOnce(
          JSON.stringify({
            env: {
              ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
              ANTHROPIC_BASE_URL: "https://api-a.example.com",
            },
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            env: {
              ANTHROPIC_MODEL: "claude-opus-4-20250514",
              ANTHROPIC_BASE_URL: "https://api-b.example.com",
            },
          }),
        );

      const driver = new CcsDriver();
      const models = await driver.listModels();

      expect(models).toEqual([
        {
          id: "profile-a",
          name: "profile-a (claude-sonnet-4-20250514)",
          variants: ["low", "medium", "high", "max"],
        },
        {
          id: "profile-b",
          name: "profile-b (claude-opus-4-20250514)",
          variants: ["low", "medium", "high", "max"],
        },
      ]);
    });

    it("filters out profiles without ANTHROPIC_BASE_URL (CLIProxy profiles)", async () => {
      mockReaddir.mockResolvedValueOnce([
        "api-profile.settings.json",
        "cliproxy-profile.settings.json",
      ] as any);

      mockReadFile
        .mockResolvedValueOnce(
          JSON.stringify({
            env: {
              ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
              ANTHROPIC_BASE_URL: "https://api.example.com",
            },
          }),
        )
        .mockResolvedValueOnce(
          JSON.stringify({
            env: {
              ANTHROPIC_MODEL: "claude-sonnet-4-20250514",
              // No ANTHROPIC_BASE_URL — this is a CLIProxy profile
            },
          }),
        );

      const driver = new CcsDriver();
      const models = await driver.listModels();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("api-profile");
    });

    it("returns empty array when ~/.ccs doesn't exist", async () => {
      const error = new Error("ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      mockReaddir.mockRejectedValueOnce(error);

      const driver = new CcsDriver();
      const models = await driver.listModels();

      expect(models).toEqual([]);
    });
  });
});
