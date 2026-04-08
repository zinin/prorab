import { describe, it, expect } from "vitest";
import { applyDefaultChannel } from "../server/ws.js";
import type { WsEvent } from "../server/session/ws-broadcaster.js";

describe("applyDefaultChannel", () => {
  // --- agent:* events without channel get default 'execute' ---

  it("adds channel='execute' to agent:text without channel", () => {
    const event: WsEvent = { type: "agent:text", text: "hello" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("execute");
    expect(result.type).toBe("agent:text");
    expect(result).toHaveProperty("text", "hello");
  });

  it("adds channel='execute' to agent:tool without channel", () => {
    const event: WsEvent = { type: "agent:tool", name: "Read", summary: "Read file" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("execute");
    expect(result.type).toBe("agent:tool");
  });

  it("adds channel='execute' to agent:tool_result without channel", () => {
    const event: WsEvent = { type: "agent:tool_result", summary: "ok" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("execute");
  });

  it("adds channel='execute' to agent:context_usage without channel", () => {
    const event: WsEvent = {
      type: "agent:context_usage",
      contextTokens: 1000,
      contextWindow: 200000,
      model: "claude-sonnet",
      unitId: "1",
    };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("execute");
  });

  it("adds channel='execute' to agent:system_prompt without channel", () => {
    const event: WsEvent = { type: "agent:system_prompt", text: "You are..." };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("execute");
  });

  // --- agent:* events with existing channel are preserved ---

  it("preserves channel='chat' on agent:text", () => {
    const event: WsEvent = { type: "agent:text", text: "hello", channel: "chat" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("chat");
    // Should return the same object (no copy)
    expect(result).toBe(event);
  });

  it("preserves channel='execute' on agent:tool", () => {
    const event: WsEvent = { type: "agent:tool", name: "Bash", summary: "run", channel: "execute" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("execute");
    expect(result).toBe(event);
  });

  // --- Non-agent events are passed through unchanged ---

  it("does not add channel to execution:state events", () => {
    const event: WsEvent = { type: "execution:state", state: "running" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBeUndefined();
    expect(result).toBe(event);
  });

  it("does not add channel to tasks:updated events", () => {
    const event: WsEvent = { type: "tasks:updated" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBeUndefined();
    expect(result).toBe(event);
  });

  it("does not add channel to chat:* events", () => {
    const event: WsEvent = { type: "chat:started", sessionId: "s1", channel: "chat" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("chat");
    expect(result).toBe(event);
  });

  // --- parse-prd channel is preserved ---

  it("preserves channel='parse-prd' on agent:text", () => {
    const event: WsEvent = { type: "agent:text", text: "Analyzing PRD...", channel: "parse-prd" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("parse-prd");
    // Should return the same object (no copy)
    expect(result).toBe(event);
  });

  it("preserves channel='parse-prd' on agent:tool", () => {
    const event: WsEvent = { type: "agent:tool", name: "Read", summary: "Read prd.md", channel: "parse-prd" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("parse-prd");
    expect(result).toBe(event);
  });

  it("preserves channel='parse-prd' on agent:tool_result", () => {
    const event: WsEvent = { type: "agent:tool_result", summary: "ok", channel: "parse-prd" };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("parse-prd");
    expect(result).toBe(event);
  });

  it("preserves channel='parse-prd' on agent:context_usage", () => {
    const event: WsEvent = {
      type: "agent:context_usage",
      contextTokens: 500,
      contextWindow: 200000,
      model: "claude-sonnet",
      unitId: "parse-prd-1",
      channel: "parse-prd",
    };
    const result = applyDefaultChannel(event);

    expect(result.channel).toBe("parse-prd");
    expect(result).toBe(event);
  });

  it("does not add channel to parse-prd:* lifecycle events", () => {
    const started: WsEvent = { type: "parse-prd:started", sessionId: "s1", agent: "claude", channel: "parse-prd" };
    const finished: WsEvent = { type: "parse-prd:finished", outcome: { status: "success" }, channel: "parse-prd" };
    const error: WsEvent = { type: "parse-prd:error", message: "fail", channel: "parse-prd" };

    expect(applyDefaultChannel(started)).toBe(started);
    expect(applyDefaultChannel(finished)).toBe(finished);
    expect(applyDefaultChannel(error)).toBe(error);

    expect(applyDefaultChannel(started).channel).toBe("parse-prd");
    expect(applyDefaultChannel(finished).channel).toBe("parse-prd");
    expect(applyDefaultChannel(error).channel).toBe("parse-prd");
  });

  // --- Immutability ---

  it("does not mutate the original event", () => {
    const event: WsEvent = { type: "agent:text", text: "hello" };
    const result = applyDefaultChannel(event);

    // Original is not mutated
    expect(event.channel).toBeUndefined();
    // Result is a new object
    expect(result).not.toBe(event);
    expect(result.channel).toBe("execute");
  });
});
