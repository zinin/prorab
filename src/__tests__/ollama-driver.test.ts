import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentDriver } from "../core/drivers/types.js";

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

import { OllamaDriver } from "../core/drivers/ollama.js";
import { ClaudeDriver } from "../core/drivers/claude.js";

describe("OllamaDriver", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  function mockOllamaWith(modelId: string): void {
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
      if (u.includes("/v1/models/")) {
        const id = decodeURIComponent(u.replace(/.*\/v1\/models\//, ""));
        return new Response(JSON.stringify({ id }), { status: id === modelId ? 200 : 404 });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as typeof fetch;
  }

  describe("setup()", () => {
    it("throws when model is missing", async () => {
      const driver = new OllamaDriver();
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        "Ollama agent requires a model",
      );
    });

    it("rejects non-cloud models", async () => {
      // No fetch mock needed — cloud guard runs before any HTTP call.
      globalThis.fetch = vi.fn();
      const driver = new OllamaDriver("llama3.2:3b");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /supports only cloud models.*llama3\.2:3b/,
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("throws when daemon /api/version fetch rejects", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /daemon is not reachable.*ollama serve/,
      );
    });

    it("throws when daemon /api/version returns non-OK", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("err", { status: 500 }),
      );
      const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /daemon is not reachable/,
      );
    });

    it("throws 'not available / signin' when /v1/models/<id> returns 404", async () => {
      globalThis.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        if (u.includes("/v1/models/")) return new Response(JSON.stringify({}), { status: 404 });
        return new Response("nope", { status: 404 });
      }) as unknown as typeof fetch;

      const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /Model 'deepseek-v4-pro:cloud\[1m\]' is not available.*ollama signin/,
      );
    });

    it("throws 'transient daemon issue' when /v1/models/<id> returns 5xx", async () => {
      globalThis.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        if (u.includes("/v1/models/")) return new Response("upstream gone", { status: 503 });
        return new Response("nope", { status: 404 });
      }) as unknown as typeof fetch;

      const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /failed to verify model.*transiently overloaded|daemon at .* failed to verify/,
      );
    });

    it("throws 'transient daemon issue' when /v1/models/<id> fetch rejects", async () => {
      globalThis.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        if (u.includes("/v1/models/")) throw new Error("ECONNRESET");
        return new Response("nope", { status: 404 });
      }) as unknown as typeof fetch;

      const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /failed to verify model/,
      );
    });

    it("builds session env with required Anthropic + Claude Code vars", async () => {
      mockOllamaWith("deepseek-v4-pro:cloud[1m]");
      const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      const calledOpts = innerInstance.runSession.mock.calls[0][0];

      expect(calledOpts.env).toBeDefined();
      expect(calledOpts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:11434");
      expect(calledOpts.env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");
      expect(calledOpts.env.ANTHROPIC_API_KEY).toBe("");
      expect(calledOpts.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-pro:cloud[1m]");
      expect(calledOpts.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-v4-pro:cloud[1m]");
      expect(calledOpts.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-pro:cloud[1m]");
      expect(calledOpts.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-pro:cloud[1m]");
      expect(calledOpts.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");

      await driver.teardown();
    });

    it("strips parent ANTHROPIC_*/CLAUDE_CODE_* leakage", async () => {
      // Parent process has a real key set; it must NOT survive into the inner SDK env.
      process.env.ANTHROPIC_API_KEY = "sk-ant-real-parent-key";
      process.env.ANTHROPIC_RETRY = "9";
      process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "999";

      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      const env = innerInstance.runSession.mock.calls[0][0].env;

      expect(env.ANTHROPIC_API_KEY).toBe("");                  // stripped + re-set to ""
      expect(env.ANTHROPIC_RETRY).toBeUndefined();             // stripped, no override
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined(); // model has no [Nm]/[Nk] suffix → stripped, no re-set

      await driver.teardown();
    });

    it("strips opts.variant before delegating to inner ClaudeDriver", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
        variant: "high",                                        // must NOT reach inner
      } as any);
      const calledOpts = innerInstance.runSession.mock.calls[0][0];
      expect(calledOpts.variant).toBeUndefined();

      await driver.teardown();
    });

    it("merges caller opts.env with sessionEnv (caller wins for unmanaged keys)", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
        env: { CUSTOM_USER_VAR: "value-from-caller", ANTHROPIC_AUTH_TOKEN: "should-be-overridden" } as Record<string, string>,
      } as any);
      const env = innerInstance.runSession.mock.calls[0][0].env;
      expect(env.CUSTOM_USER_VAR).toBe("value-from-caller");          // caller key preserved
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");                 // our override wins

      await driver.teardown();
    });

    it("env ANTHROPIC_BASE_URL honors OLLAMA_HOST (host:port → http://...)", async () => {
      process.env.OLLAMA_HOST = "192.168.1.10:11434";
      mockOllamaWith("deepseek-v4-pro:cloud[1m]");
      const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      expect(innerInstance.runSession.mock.calls[0][0].env.ANTHROPIC_BASE_URL).toBe("http://192.168.1.10:11434");

      await driver.teardown();
    });

    it("env ANTHROPIC_BASE_URL preserves OLLAMA_HOST URL form (no double slash)", async () => {
      process.env.OLLAMA_HOST = "https://my-ollama.example.com/";       // trailing slash
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      expect(innerInstance.runSession.mock.calls[0][0].env.ANTHROPIC_BASE_URL).toBe("https://my-ollama.example.com");

      await driver.teardown();
    });

    it("setup() throws when OLLAMA_HOST is unix-socket form", async () => {
      process.env.OLLAMA_HOST = "/var/run/ollama.sock";
      globalThis.fetch = vi.fn();                                        // never reached
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(/Unix-socket/);
    });

    it("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from [1m] suffix", async () => {
      mockOllamaWith("deepseek-v4-pro:cloud[1m]");
      const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      const calledOpts = innerInstance.runSession.mock.calls[0][0];
      expect(calledOpts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");

      await driver.teardown();
    });

    it("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from [200k] suffix", async () => {
      mockOllamaWith("foo-model:cloud[200k]");
      const driver = new OllamaDriver("foo-model:cloud[200k]");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      const calledOpts = innerInstance.runSession.mock.calls[0][0];
      expect(calledOpts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");

      await driver.teardown();
    });

    it("omits CLAUDE_CODE_AUTO_COMPACT_WINDOW when no [Nk]/[Nm] suffix", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      const calledOpts = innerInstance.runSession.mock.calls[0][0];
      expect(calledOpts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();

      await driver.teardown();
    });

    it("ignores decimal suffix [1.5m] (regex matches integers only)", async () => {
      // Custom mock: probe must match the exact id including the suffix.
      globalThis.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        if (u.includes("/v1/models/")) {
          const id = decodeURIComponent(u.replace(/.*\/v1\/models\//, ""));
          return new Response(JSON.stringify({ id }), { status: id === "weird-model:cloud[1.5m]" ? 200 : 404 });
        }
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;

      const driver = new OllamaDriver("weird-model:cloud[1.5m]");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      expect(innerInstance.runSession.mock.calls[0][0].env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();

      await driver.teardown();
    });
  });

  describe("startChat()", () => {
    it("forwards sessionEnv to the inner ClaudeDriver", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      driver.startChat({ cwd: "/tmp", verbosity: "info" });

      expect(innerInstance.startChat).toHaveBeenCalledTimes(1);
      const calledOpts = innerInstance.startChat.mock.calls[0][0];
      expect(calledOpts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:11434");
      expect(calledOpts.env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");

      await driver.teardown();
    });

    it("strips opts.variant before delegating", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      driver.startChat({ cwd: "/tmp", verbosity: "info", variant: "high" } as any);

      expect(innerInstance.startChat.mock.calls[0][0].variant).toBeUndefined();

      await driver.teardown();
    });

    it("merges caller opts.env (caller wins for unmanaged keys)", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      driver.startChat({
        cwd: "/tmp",
        verbosity: "info",
        env: { CUSTOM_USER_VAR: "x", ANTHROPIC_AUTH_TOKEN: "should-be-overridden" } as Record<string, string>,
      } as any);

      const env = innerInstance.startChat.mock.calls[0][0].env;
      expect(env.CUSTOM_USER_VAR).toBe("x");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");

      await driver.teardown();
    });
  });

  describe("chat delegation", () => {
    it("sendMessage / replyQuestion / abortChat delegate to inner driver", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;

      driver.sendMessage("hello");
      expect(innerInstance.sendMessage).toHaveBeenCalledWith("hello");

      driver.replyQuestion("q-1", { answer: "yes" });
      expect(innerInstance.replyQuestion).toHaveBeenCalledWith("q-1", { answer: "yes" });

      driver.abortChat();
      expect(innerInstance.abortChat).toHaveBeenCalledTimes(1);

      await driver.teardown();
    });

    it("delegation methods throw when setup() has not been called", () => {
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      expect(() => driver.sendMessage("hi")).toThrow(/not initialized/);
      expect(() => driver.replyQuestion("q", {})).toThrow(/not initialized/);
      expect(() => driver.abortChat()).toThrow(/not initialized/);
    });
  });

  describe("teardown()", () => {
    it("clears inner driver and sessionEnv; subsequent calls throw", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });
      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.teardown();

      expect(innerInstance.teardown).toHaveBeenCalledTimes(1);
      expect(() => driver.runSession({} as any)).toThrow(/not initialized/);
      expect(() => driver.sendMessage("x")).toThrow(/not initialized/);
    });
  });

  describe("listModels()", () => {
    it("returns [] when daemon /api/version rejects", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const models = await new OllamaDriver().listModels();
      expect(models).toEqual([]);
    });

    it("returns [] when daemon /api/version returns non-OK", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
      const models = await new OllamaDriver().listModels();
      expect(models).toEqual([]);
    });

    it("probes each catalog entry via /v1/models/<id> and keeps only HTTP-200 ones", async () => {
      const accessible = new Set(["deepseek-v4-pro:cloud[1m]", "kimi-k2.6:cloud", "minimax-m2.7:cloud"]);
      globalThis.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        const m = u.match(/\/v1\/models\/(.+)$/);
        if (m) {
          const decoded = decodeURIComponent(m[1]);
          return new Response(JSON.stringify({ id: decoded }), { status: accessible.has(decoded) ? 200 : 404 });
        }
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;

      const models = await new OllamaDriver().listModels();
      const ids = models.map((x) => x.id).sort();
      expect(ids).toEqual(["deepseek-v4-pro:cloud[1m]", "kimi-k2.6:cloud", "minimax-m2.7:cloud"]);
      // ModelEntry must NOT carry a `variants` field — UI hides effort dropdown via that.
      for (const m of models) expect(m).not.toHaveProperty("variants");
    });

    it("URL-encodes catalog ids when probing (square brackets do not break the URL)", async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        return new Response("", { status: 404 });          // all 404 — only checking call shape
      }) as unknown as typeof fetch;
      globalThis.fetch = fetchMock;

      await new OllamaDriver().listModels();
      const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
      // No raw `[` should leak into the URL — encodeURIComponent turns it into %5B.
      for (const c of calls) {
        if (c.includes("/v1/models/")) expect(c).not.toMatch(/\[/);
      }
    });

    it("uses OLLAMA_HOST (host:port form)", async () => {
      process.env.OLLAMA_HOST = "192.168.1.10:11434";
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      globalThis.fetch = fetchMock;

      await new OllamaDriver().listModels();
      const versionCalls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.endsWith("/api/version"));
      expect(versionCalls[0]).toBe("http://192.168.1.10:11434/api/version");
    });

    it("uses OLLAMA_HOST (https URL form, kept verbatim)", async () => {
      process.env.OLLAMA_HOST = "https://my-ollama.example.com";
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      globalThis.fetch = fetchMock;

      await new OllamaDriver().listModels();
      const versionCalls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.endsWith("/api/version"));
      expect(versionCalls[0]).toBe("https://my-ollama.example.com/api/version");
    });

    it("strips trailing slash from OLLAMA_HOST", async () => {
      process.env.OLLAMA_HOST = "http://127.0.0.1:11434/";
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;
      globalThis.fetch = fetchMock;

      await new OllamaDriver().listModels();
      const versionCalls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.endsWith("/api/version"));
      // No double slash anywhere in the path.
      expect(versionCalls[0]).toBe("http://127.0.0.1:11434/api/version");
      for (const c of versionCalls) expect(c).not.toMatch(/[^:]\/\//);
    });

    it("returns [] (does not throw) when OLLAMA_HOST is unix-socket form", async () => {
      process.env.OLLAMA_HOST = "/var/run/ollama.sock";
      const models = await new OllamaDriver().listModels();
      expect(models).toEqual([]);
    });

    it("returns [] when OLLAMA_HOST contains internal whitespace", async () => {
      process.env.OLLAMA_HOST = "192.168.1.10 :11434";
      const models = await new OllamaDriver().listModels();
      expect(models).toEqual([]);
    });
  });
});
