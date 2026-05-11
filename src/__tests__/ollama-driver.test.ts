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
import { getContextWindow, _resetContextWindowCache } from "../core/drivers/context-window.js";

describe("OllamaDriver", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    // Isolate the shared context-window cache across tests. setContextWindow()
    // is a module-level cache shared by every driver in the worker — without
    // resetting, a value set in one test would leak into the next.
    _resetContextWindowCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  /**
   * Mock the daemon so /api/version returns 200 and /v1/models/<id> returns
   * 200 only for the ids in `accessible`. Defaults to a single id.
   */
  function mockOllamaWith(...accessibleIds: string[]): void {
    const accept = new Set(accessibleIds);
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
      if (u.includes("/v1/models/")) {
        const id = decodeURIComponent(u.replace(/.*\/v1\/models\//, ""));
        return new Response(JSON.stringify({ id }), { status: accept.has(id) ? 200 : 404 });
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

    it("accepts -cloud variant in model id (id outside catalog still passes guard)", async () => {
      // The cloud-only guard accepts ':cloud' OR '-cloud' substring. The model
      // does not have to be in OLLAMA_CLOUD_CATALOG; preflight will probe it.
      mockOllamaWith("fake:99b-cloud");
      const driver = new OllamaDriver("fake:99b-cloud");
      await expect(driver.setup({ verbosity: "info" })).resolves.toBeUndefined();
    });

    it("throws when daemon /api/version fetch rejects", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /daemon is not reachable.*ollama serve/,
      );
    });

    it("throws when daemon /api/version returns non-OK", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response("err", { status: 500 }),
      );
      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
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

      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /Model 'deepseek-v4-pro:cloud' is not available.*ollama signin/,
      );
    });

    it.each([401, 403])(
      "throws 'not available / signin' when /v1/models/<id> returns %i (auth-side)",
      async (status) => {
        globalThis.fetch = vi.fn(async (url: string) => {
          const u = String(url);
          if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
          if (u.includes("/v1/models/")) return new Response("auth", { status });
          return new Response("nope", { status: 404 });
        }) as unknown as typeof fetch;

        const driver = new OllamaDriver("kimi-k2.6:cloud");
        await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
          /Model 'kimi-k2.6:cloud' is not available.*ollama signin/,
        );
      },
    );

    it.each([400, 422])(
      "throws 'invalid format' when /v1/models/<id> returns %i (malformed id)",
      async (status) => {
        globalThis.fetch = vi.fn(async (url: string) => {
          const u = String(url);
          if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
          if (u.includes("/v1/models/")) return new Response("invalid model name", { status });
          return new Response("nope", { status: 404 });
        }) as unknown as typeof fetch;

        const driver = new OllamaDriver("kimi-k2.6:cloud");
        await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
          /rejected model id 'kimi-k2.6:cloud'.*invalid format/,
        );
      },
    );

    it("throws when setup() called twice without teardown() between", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /already initialized.*teardown/,
      );
      await driver.teardown();
      // After teardown, setup() works again.
      await expect(driver.setup({ verbosity: "info" })).resolves.toBeUndefined();
      await driver.teardown();
    });

    it("throws 'transient daemon issue' when /v1/models/<id> returns 5xx", async () => {
      globalThis.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        if (u.includes("/v1/models/")) return new Response("upstream gone", { status: 503 });
        return new Response("nope", { status: 404 });
      }) as unknown as typeof fetch;

      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
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

      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
      await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
        /failed to verify model/,
      );
    });

    it("builds session env with required Anthropic + Claude Code vars (model id verbatim)", async () => {
      mockOllamaWith("deepseek-v4-pro:cloud");
      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
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
      expect(calledOpts.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-pro:cloud");
      expect(calledOpts.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-v4-pro:cloud");
      expect(calledOpts.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-pro:cloud");
      expect(calledOpts.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-pro:cloud");
      expect(calledOpts.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");

      await driver.teardown();
    });

    it("strips parent ANTHROPIC_*/CLAUDE_CODE_* leakage", async () => {
      // Parent process has a real key set; it must NOT survive into the inner SDK env.
      process.env.ANTHROPIC_API_KEY = "sk-ant-real-parent-key";
      process.env.ANTHROPIC_RETRY = "9";
      // Set a parent-process value that buildEnv must strip; the model is in
      // the catalog so the driver re-sets the var to the catalog value (256K),
      // proving the strip-then-set order.
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

      expect(env.ANTHROPIC_API_KEY).toBe("");                       // stripped + re-set to ""
      expect(env.ANTHROPIC_RETRY).toBeUndefined();                  // stripped, no override
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("256000");   // stripped then re-set from catalog

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

    it("strips caller ANTHROPIC_*/CLAUDE_CODE_* keys (mirrors parent-process strip)", async () => {
      // A caller-supplied CLAUDE_CODE_AUTO_COMPACT_WINDOW must not override
      // the value derived from the catalog. ANTHROPIC_RETRY is not in
      // sessionEnv (not one of our managed overrides); without the strip it
      // would leak through.
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
        env: {
          CUSTOM_USER_VAR: "kept",
          ANTHROPIC_RETRY: "should-be-stripped",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "999999",
        } as Record<string, string>,
      } as any);
      const env = innerInstance.runSession.mock.calls[0][0].env;
      expect(env.CUSTOM_USER_VAR).toBe("kept");
      expect(env.ANTHROPIC_RETRY).toBeUndefined();
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("256000");    // catalog value wins

      await driver.teardown();
    });

    it("env ANTHROPIC_BASE_URL honors OLLAMA_HOST (host:port → http://...)", async () => {
      process.env.OLLAMA_HOST = "192.168.1.10:11434";
      mockOllamaWith("deepseek-v4-pro:cloud");
      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
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

    it("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from catalog contextWindow (1M for deepseek-v4-pro:cloud)", async () => {
      mockOllamaWith("deepseek-v4-pro:cloud");
      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
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

    it("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from catalog contextWindow (198K for glm-5.1:cloud, sub-200K case)", async () => {
      // glm-5.1:cloud has 198K — below the 200K default. The catalog value
      // must still propagate (the UI guard relaxation in context-window.ts
      // accepts sub-200K values for models unknown to the substring table).
      mockOllamaWith("glm-5.1:cloud");
      const driver = new OllamaDriver("glm-5.1:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      expect(innerInstance.runSession.mock.calls[0][0].env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("198000");

      await driver.teardown();
    });

    it("omits CLAUDE_CODE_AUTO_COMPACT_WINDOW for models not in the catalog", async () => {
      // Cloud-only guard accepts any ':cloud' / '-cloud' id; if the daemon
      // serves it, setup() succeeds. But buildEnv must NOT invent a number —
      // CLAUDE_CODE_AUTO_COMPACT_WINDOW is omitted and Claude Code uses its
      // default. UI also falls back to 200K (no setContextWindow call).
      mockOllamaWith("custom:cloud");
      const driver = new OllamaDriver("custom:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      await driver.runSession({
        prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
        maxTurns: 1, verbosity: "info", unitId: "u1",
      });
      expect(innerInstance.runSession.mock.calls[0][0].env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();

      await driver.teardown();
    });

    it("publishes contextWindow to the context-window cache for catalog models (UI lookup)", async () => {
      // Regression for the UI showing "/ 200K" for a 1M model. Without
      // setContextWindow(), getContextWindow("deepseek-v4-pro:cloud") falls
      // back to DEFAULT (200K) because no substring in CONTEXT_WINDOWS
      // matches Ollama-cloud ids.
      mockOllamaWith("deepseek-v4-pro:cloud");
      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
      await driver.setup({ verbosity: "info" });

      expect(getContextWindow("deepseek-v4-pro:cloud")).toBe(1_000_000);

      await driver.teardown();
    });

    it("publishes sub-default contextWindow (glm-5.1:cloud → 198K) to the cache", async () => {
      mockOllamaWith("glm-5.1:cloud");
      const driver = new OllamaDriver("glm-5.1:cloud");
      await driver.setup({ verbosity: "info" });

      expect(getContextWindow("glm-5.1:cloud")).toBe(198_000);

      await driver.teardown();
    });

    it("does NOT publish contextWindow for models outside the catalog", async () => {
      mockOllamaWith("custom:cloud");
      const driver = new OllamaDriver("custom:cloud");
      await driver.setup({ verbosity: "info" });

      // No cache entry → getContextWindow falls through to the 200K default.
      expect(getContextWindow("custom:cloud")).toBe(200_000);

      await driver.teardown();
    });

    it("passes the model id verbatim to the inner ClaudeDriver constructor", async () => {
      // Regression: an earlier iteration stripped a `[Nm]/[Nk]` suffix before
      // forwarding to ClaudeDriver. With the explicit-catalog scheme the id
      // has no decoration and must reach the constructor as-is.
      mockOllamaWith("deepseek-v4-pro:cloud");
      const driver = new OllamaDriver("deepseek-v4-pro:cloud");
      await driver.setup({ verbosity: "info" });

      const ctorArgs = vi.mocked(ClaudeDriver).mock.calls[0];
      expect(ctorArgs[0]).toBe("deepseek-v4-pro:cloud");

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
      expect(calledOpts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("256000");

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

    it("strips caller ANTHROPIC_*/CLAUDE_CODE_* keys (mirrors parent-process strip)", async () => {
      mockOllamaWith("kimi-k2.6:cloud");
      const driver = new OllamaDriver("kimi-k2.6:cloud");
      await driver.setup({ verbosity: "info" });

      const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
      driver.startChat({
        cwd: "/tmp",
        verbosity: "info",
        env: {
          CUSTOM_USER_VAR: "kept",
          ANTHROPIC_RETRY: "should-be-stripped",
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: "999999",
        } as Record<string, string>,
      } as any);

      const env = innerInstance.startChat.mock.calls[0][0].env;
      expect(env.CUSTOM_USER_VAR).toBe("kept");
      expect(env.ANTHROPIC_RETRY).toBeUndefined();
      expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("256000");      // catalog wins

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
      const accessible = new Set([
        "deepseek-v4-pro:cloud",
        "kimi-k2.6:cloud",
        "minimax-m2.7:cloud",
      ]);
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
      expect(ids).toEqual(["deepseek-v4-pro:cloud", "kimi-k2.6:cloud", "minimax-m2.7:cloud"]);
      // ModelEntry must NOT carry a `variants` field — UI hides effort dropdown via that.
      for (const m of models) expect(m).not.toHaveProperty("variants");
    });

    it("returns all 6 catalog entries when every probe succeeds", async () => {
      globalThis.fetch = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
        const m = u.match(/\/v1\/models\/(.+)$/);
        if (m) {
          const decoded = decodeURIComponent(m[1]);
          return new Response(JSON.stringify({ id: decoded }), { status: 200 });
        }
        return new Response("", { status: 404 });
      }) as unknown as typeof fetch;

      const models = await new OllamaDriver().listModels();
      expect(models.map((x) => x.id).sort()).toEqual([
        "deepseek-v4-flash:cloud",
        "deepseek-v4-pro:cloud",
        "glm-5.1:cloud",
        "kimi-k2.6:cloud",
        "minimax-m2.7:cloud",
        "qwen3.5:cloud",
      ]);
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
