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
