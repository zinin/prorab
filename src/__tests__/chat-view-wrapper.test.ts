import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Structural tests for ChatView.vue — verifies it remains a thin wrapper
 * that delegates all rendering to AgentChatPanel and all state to useChatStore.
 *
 * These tests read the SFC source rather than rendering components, because
 * @vue/test-utils is not a project dependency. The tests enforce the
 * architectural constraint: ChatView must not render messages directly.
 */

const chatViewPath = resolve(__dirname, "../../ui/src/views/ChatView.vue");
const chatViewSource = readFileSync(chatViewPath, "utf-8");

// Extract <script setup> and <template> sections
const scriptMatch = chatViewSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
const templateMatch = chatViewSource.match(/<template>([\s\S]*?)<\/template>/);

const scriptSection = scriptMatch?.[1] ?? "";
const templateSection = templateMatch?.[1] ?? "";

describe("ChatView thin wrapper contract", () => {
  describe("store integration", () => {
    it("imports useChatStore", () => {
      expect(scriptSection).toContain("useChatStore");
    });

    it("instantiates chatStore from useChatStore", () => {
      expect(scriptSection).toMatch(/const\s+chatStore\s*=\s*useChatStore\(\)/);
    });
  });

  describe("props passed to AgentChatPanel", () => {
    it("passes chatStore.messages", () => {
      expect(templateSection).toMatch(/:messages\s*=\s*"chatStore\.messages"/);
    });

    it("passes chatStore.state", () => {
      expect(templateSection).toMatch(/:state\s*=\s*"chatStore\.state"/);
    });

    it("passes chatStore.awaitingUserInput", () => {
      expect(templateSection).toMatch(/:awaiting-user-input\s*=\s*"chatStore\.awaitingUserInput"/);
    });

    it("passes chatStore.pendingQuestion", () => {
      expect(templateSection).toMatch(/:pending-question\s*=\s*"chatStore\.pendingQuestion"/);
    });

    it("passes canStop derived from chatStore.state", () => {
      expect(templateSection).toMatch(/:can-stop\s*=\s*"chatStore\.state\s*!==\s*'idle'"/);
    });
  });

  describe("event handlers", () => {
    it("handles send event", () => {
      expect(templateSection).toContain("@send=");
    });

    it("handles reply event", () => {
      expect(templateSection).toContain("@reply=");
    });

    it("handles stop event", () => {
      expect(templateSection).toContain("@stop=");
    });

    it("handleSend delegates to chatStore.sendMessage", () => {
      expect(scriptSection).toMatch(/function\s+handleSend/);
      expect(scriptSection).toContain("chatStore.sendMessage");
    });

    it("handleReply delegates to chatStore.replyQuestion", () => {
      expect(scriptSection).toMatch(/function\s+handleReply/);
      expect(scriptSection).toContain("chatStore.replyQuestion");
    });

    it("handleStop delegates to chatStore.stopChat", () => {
      expect(scriptSection).toMatch(/function\s+handleStop/);
      expect(scriptSection).toContain("chatStore.stopChat");
    });
  });

  describe("wizard integration", () => {
    it("imports AgentWizard component", () => {
      expect(scriptSection).toContain("AgentWizard");
    });

    it("renders AgentWizard when chat state is idle", () => {
      expect(templateSection).toContain("AgentWizard");
      expect(templateSection).toMatch(/v-if\s*=\s*"chatStore\.state\s*===\s*'idle'"/);
    });

    it("implements two-step start orchestration via chatStore.startFlow", () => {
      expect(scriptSection).toContain("chatStore.startFlow");
    });

    it("handles wizard start event", () => {
      expect(templateSection).toContain("@start=");
    });
  });

  describe("thin wrapper constraint", () => {
    it("does not import ChatMessageItem", () => {
      expect(scriptSection).not.toContain("ChatMessageItem");
    });

    it("does not import AskUserQuestion", () => {
      expect(scriptSection).not.toContain("AskUserQuestion");
    });

    it("does not render ChatMessageItem in template", () => {
      expect(templateSection).not.toContain("ChatMessageItem");
    });

    it("does not render AskUserQuestion in template", () => {
      expect(templateSection).not.toContain("AskUserQuestion");
    });

    it("renders AgentChatPanel in template", () => {
      expect(templateSection).toContain("AgentChatPanel");
    });

    it("imports AgentChatPanel component", () => {
      expect(scriptSection).toContain("AgentChatPanel");
    });

    it("does not contain v-for for messages (delegates to AgentChatPanel)", () => {
      expect(templateSection).not.toMatch(/v-for\s*=\s*".*messages/);
    });

    it("has no local computed properties for filtering/mapping messages", () => {
      // ChatView should not have any computed properties — all derived state comes from the store
      expect(scriptSection).not.toMatch(/\bcomputed\b/);
    });

    it("does not directly watch messages", () => {
      // ChatView should not watch store properties
      expect(scriptSection).not.toMatch(/\bwatch\b/);
    });
  });
});
