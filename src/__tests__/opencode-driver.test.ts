import { describe, it, expect } from "vitest";
import { parseModelString, parseServerUrl, OpenCodeDriver } from "../core/drivers/opencode.js";

describe("OpenCodeDriver", () => {
  describe("parseModelString", () => {
    it("splits simple provider/model", () => {
      expect(parseModelString("anthropic/claude-opus-4-6")).toEqual({
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
      });
    });

    it("handles nested paths (google-vertex/deepseek-ai/deepseek-v3.1-maas)", () => {
      expect(parseModelString("google-vertex/deepseek-ai/deepseek-v3.1-maas")).toEqual({
        providerID: "google-vertex",
        modelID: "deepseek-ai/deepseek-v3.1-maas",
      });
    });

    it("throws on string without /", () => {
      expect(() => parseModelString("invalid")).toThrow();
    });

    it("throws on empty provider (/model)", () => {
      expect(() => parseModelString("/claude-opus-4-6")).toThrow();
    });

    it("throws on empty model (provider/)", () => {
      expect(() => parseModelString("anthropic/")).toThrow();
    });
  });

  describe("chat state fields initialization", () => {
    // Access private fields via type cast for testing
    type DriverInternals = {
      chatSessionId: string | null;
      pendingQuestions: Map<string, { requestID: string }>;
      chatAbortController: AbortController | null;
      questionIdCounter: number;
    };

    it("initializes chatSessionId to null", () => {
      const driver = new OpenCodeDriver() as unknown as DriverInternals;
      expect(driver.chatSessionId).toBeNull();
    });

    it("initializes pendingQuestions as empty Map", () => {
      const driver = new OpenCodeDriver() as unknown as DriverInternals;
      expect(driver.pendingQuestions).toBeInstanceOf(Map);
      expect(driver.pendingQuestions.size).toBe(0);
    });

    it("initializes chatAbortController to null", () => {
      const driver = new OpenCodeDriver() as unknown as DriverInternals;
      expect(driver.chatAbortController).toBeNull();
    });

    it("initializes questionIdCounter to 0", () => {
      const driver = new OpenCodeDriver() as unknown as DriverInternals;
      expect(driver.questionIdCounter).toBe(0);
    });

    it("generateChatQuestionId returns unique IDs with oq- prefix", () => {
      const driver = new OpenCodeDriver() as unknown as DriverInternals & {
        generateChatQuestionId(): string;
      };
      const id1 = driver.generateChatQuestionId();
      const id2 = driver.generateChatQuestionId();
      expect(id1).toMatch(/^oq-\d+-1$/);
      expect(id2).toMatch(/^oq-\d+-2$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe("parseServerUrl", () => {
    it("parses URL from ready line", () => {
      expect(parseServerUrl("opencode server listening on http://127.0.0.1:4096")).toBe(
        "http://127.0.0.1:4096",
      );
    });

    it("returns null for non-ready lines", () => {
      expect(parseServerUrl("starting server...")).toBeNull();
      expect(parseServerUrl("")).toBeNull();
    });

    it("parses https URL", () => {
      expect(parseServerUrl("opencode server listening on https://localhost:8080")).toBe(
        "https://localhost:8080",
      );
    });

    it("throws when ready prefix found but URL missing", () => {
      expect(() => parseServerUrl("opencode server listening")).toThrow(
        "Ready line found but URL not parsed",
      );
    });
  });
});
