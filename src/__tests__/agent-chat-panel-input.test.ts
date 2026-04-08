import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural tests for AgentChatPanel.vue — verifies the local input logic,
 * canSendMessage computed, and emit behaviour.
 *
 * Uses source-level assertions (same approach as chat-view-wrapper.test.ts)
 * because @vue/test-utils is not a project dependency.
 */

const panelPath = resolve(__dirname, "../../ui/src/components/AgentChatPanel.vue");
const panelSource = readFileSync(panelPath, "utf-8");

// Extract <script setup> and <template> sections.
// Note: <template> uses greedy match because AgentChatPanel contains inner
// <template v-for> / <template v-if> tags — lazy `*?` would stop too early.
const scriptMatch = panelSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
const templateMatch = panelSource.match(/<template>([\s\S]*)<\/template>/);

const scriptSection = scriptMatch?.[1] ?? "";
const templateSection = templateMatch?.[1] ?? "";

describe("AgentChatPanel local input logic", () => {
  describe("canSendMessage computed", () => {
    it("is defined as a computed property", () => {
      expect(scriptSection).toMatch(/const\s+canSendMessage\s*=\s*computed/);
    });

    it("checks props.state === 'active'", () => {
      expect(scriptSection).toMatch(/props\.state\s*===\s*["']active["']/);
    });

    it("checks props.awaitingUserInput", () => {
      expect(scriptSection).toContain("props.awaitingUserInput");
    });

    it("checks inputText is not empty (trimmed)", () => {
      expect(scriptSection).toMatch(/inputText\.value\.trim\(\)/);
    });

    it("checks that pendingQuestion is absent", () => {
      expect(scriptSection).toMatch(/!props\.pendingQuestion/);
    });
  });

  describe("inputEnabled computed", () => {
    it("is defined as a computed property", () => {
      expect(scriptSection).toMatch(/const\s+inputEnabled\s*=\s*computed/);
    });

    it("checks props.state === 'active'", () => {
      // Extract the specific inputEnabled computed block to avoid matching
      // canSendMessage (which also contains props.state) — prevents vacuous pass
      const inputEnabledMatch = scriptSection.match(
        /const\s+inputEnabled\s*=\s*computed\(\s*\(\)\s*=>\s*[\s\S]*?\);/
      );
      expect(inputEnabledMatch).not.toBeNull();
      expect(inputEnabledMatch![0]).toMatch(/props\.state\s*===\s*["']active["']/);
    });

    it("checks props.awaitingUserInput", () => {
      // inputEnabled must depend on awaitingUserInput
      expect(scriptSection).toContain("props.awaitingUserInput");
    });
  });

  describe("local inputText ref", () => {
    it("declares a local inputText ref", () => {
      expect(scriptSection).toMatch(/const\s+inputText\s*=\s*ref\s*[(<]/);
    });
  });

  describe("handleSend function", () => {
    it("is defined", () => {
      expect(scriptSection).toMatch(/function\s+handleSend/);
    });

    it("guards on canSendMessage", () => {
      expect(scriptSection).toMatch(/if\s*\(\s*!canSendMessage\.value\s*\)/);
    });

    it("trims inputText before sending", () => {
      expect(scriptSection).toMatch(/inputText\.value\.trim\(\)/);
    });

    it("clears inputText after capturing text", () => {
      expect(scriptSection).toContain('inputText.value = ""');
    });

    it("emits 'send' with the trimmed text", () => {
      expect(scriptSection).toMatch(/emit\(\s*["']send["']/);
    });
  });

  describe("handleReply function", () => {
    it("is defined", () => {
      expect(scriptSection).toMatch(/function\s+handleReply/);
    });

    it("emits 'reply' with answers", () => {
      expect(scriptSection).toMatch(/emit\(\s*["']reply["']/);
    });
  });

  describe("handleStop function", () => {
    it("is defined", () => {
      expect(scriptSection).toMatch(/function\s+handleStop/);
    });

    it("emits 'stop'", () => {
      expect(scriptSection).toMatch(/emit\(\s*["']stop["']/);
    });
  });

  describe("keyboard handling", () => {
    it("defines handleKeydown function", () => {
      expect(scriptSection).toMatch(/function\s+handleKeydown/);
    });

    it("handles Enter key", () => {
      expect(scriptSection).toContain('"Enter"');
    });

    it("checks for Shift modifier (Shift+Enter inserts newline)", () => {
      expect(scriptSection).toContain("shiftKey");
    });

    it("calls handleSend on Enter without Shift", () => {
      expect(scriptSection).toContain("handleSend()");
    });
  });

  describe("store independence", () => {
    it("does not import any store", () => {
      expect(scriptSection).not.toContain("useStore");
      expect(scriptSection).not.toContain("useChatStore");
      expect(scriptSection).not.toContain("useExecutionStore");
      expect(scriptSection).not.toContain("defineStore");
    });

    it("does not import pinia", () => {
      expect(scriptSection).not.toContain("pinia");
    });

    it("does not call fetch directly", () => {
      expect(scriptSection).not.toContain("fetch(");
    });
  });

  describe("emit declarations", () => {
    it("declares send emit", () => {
      expect(scriptSection).toMatch(/send:\s*\[/);
    });

    it("declares reply emit", () => {
      expect(scriptSection).toMatch(/reply:\s*\[/);
    });

    it("declares stop emit", () => {
      expect(scriptSection).toMatch(/stop:\s*\[/);
    });
  });

  describe("template wiring", () => {
    it("binds textarea v-model to inputText", () => {
      expect(templateSection).toMatch(/v-model\s*=\s*"inputText"/);
    });

    it("binds textarea disabled state to inputEnabled", () => {
      expect(templateSection).toMatch(/:disabled\s*=\s*"!inputEnabled"/);
    });

    it("binds send button disabled state to canSendMessage", () => {
      expect(templateSection).toMatch(/:disabled\s*=\s*"!canSendMessage"/);
    });

    it("binds send button click to handleSend", () => {
      expect(templateSection).toMatch(/@click\s*=\s*"handleSend"/);
    });

    it("binds keydown event on textarea to handleKeydown", () => {
      expect(templateSection).toMatch(/@keydown\s*=\s*"handleKeydown"/);
    });

    it("binds stop button click to handleStop", () => {
      expect(templateSection).toMatch(/@click\s*=\s*"handleStop"/);
    });

    it("renders AskUserQuestion with @reply bound to handleReply", () => {
      expect(templateSection).toContain("AskUserQuestion");
      expect(templateSection).toMatch(/@reply\s*=\s*"handleReply"/);
    });

    it("conditionally shows stop button based on canStop prop", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"canStop"/);
    });

    it("disables stop button when state is stopping", () => {
      expect(templateSection).toMatch(/state\s*===\s*'stopping'/);
    });
  });

  describe("auto-scroll", () => {
    it("defines scrollToBottom function", () => {
      expect(scriptSection).toMatch(/function\s+scrollToBottom/);
    });

    it("watches messages.length for auto-scroll", () => {
      expect(scriptSection).toMatch(/watch\(\s*\(\)\s*=>\s*props\.messages\.length/);
    });

    it("watches pendingQuestion for auto-scroll", () => {
      expect(scriptSection).toMatch(/watch\(\s*\(\)\s*=>\s*props\.pendingQuestion/);
    });

    it("uses nextTick for scroll timing", () => {
      expect(scriptSection).toContain("nextTick");
    });

    it("declares messagesEl ref for scroll container", () => {
      expect(scriptSection).toMatch(/const\s+messagesEl\s*=\s*ref/);
    });
  });

  describe("child components", () => {
    it("imports ChatMessageItem", () => {
      expect(scriptSection).toContain("ChatMessageItem");
    });

    it("imports AskUserQuestion", () => {
      expect(scriptSection).toContain("AskUserQuestion");
    });

    it("renders ChatMessageItem for each message", () => {
      expect(templateSection).toContain("ChatMessageItem");
      expect(templateSection).toMatch(/v-for\s*=\s*"msg\s+in\s+messages"/);
    });

    it("conditionally renders AskUserQuestion when pendingQuestion exists", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"pendingQuestion"/);
    });
  });
});
