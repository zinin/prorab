/**
 * Tests for ClaudeDriver agent:turn_count emission.
 *
 * Verifies that:
 *   1. runSession() emits an agent:turn_count event for every assistant SDK
 *      message, with a monotonically incrementing numTurns and the configured
 *      maxTurns/unitId/model.
 *   2. startChat() does NOT emit agent:turn_count events — the chat UI does
 *      not render a turns indicator and ChatOptions has no maxTurns budget.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogEvent } from "../types.js";
import type { ChatEvent } from "../core/drivers/types.js";
import { AsyncQueue } from "../core/drivers/async-queue.js";

// ---------------------------------------------------------------------------
// SDK mock — single mock that supports both runSession (queued message array)
// and startChat (AsyncQueue-backed stream).
// ---------------------------------------------------------------------------

let sdkRunMessages: unknown[] = [];
let sdkChatQueue: AsyncQueue<Record<string, unknown>> | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ prompt }: { prompt: unknown; options: Record<string, unknown> }) => {
    // startChat passes an async iterable as the prompt; runSession passes a string.
    const isChat =
      prompt !== null && typeof prompt === "object" && Symbol.asyncIterator in (prompt as object);

    if (isChat) {
      const queue = sdkChatQueue!;
      const gen = (async function* () {
        for await (const msg of queue) {
          yield msg;
        }
      })();
      return Object.assign(gen, {
        interrupt: vi.fn(),
        setPermissionMode: vi.fn(),
        setModel: vi.fn(),
        setMaxThinkingTokens: vi.fn(),
        initializationResult: vi.fn(),
        supportedCommands: vi.fn(),
        supportedModels: vi.fn(),
        mcpServerStatus: vi.fn(),
        accountInfo: vi.fn(),
        rewindFiles: vi.fn(),
        reconnectMcpServer: vi.fn(),
        toggleMcpServer: vi.fn(),
        setMcpServers: vi.fn(),
        streamInput: vi.fn(),
        stopTask: vi.fn(),
        close: vi.fn(),
      });
    }

    const messages = sdkRunMessages;
    return (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })();
  }),
}));

// Import AFTER mock is registered
const { ClaudeDriver } = await import("../core/drivers/claude.js");

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ClaudeDriver — agent:turn_count emission", () => {
  beforeEach(() => {
    sdkRunMessages = [];
    sdkChatQueue = null;
  });

  it("emits agent:turn_count per assistant message during runSession with matching maxTurns and unitId", async () => {
    // Build a fixture: init message + 3 assistant messages + result.
    sdkRunMessages = [
      { type: "system", subtype: "init", model: "claude-opus-4-6", tools: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "first" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "second" }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "third" }] } },
      {
        type: "result",
        subtype: "success",
        duration_ms: 100,
        total_cost_usd: 0,
        num_turns: 3,
        modelUsage: {},
        result: "",
      },
    ];

    const events: LogEvent[] = [];
    const driver = new ClaudeDriver();
    const result = await driver.runSession({
      prompt: "p",
      systemPrompt: "s",
      cwd: "/tmp",
      maxTurns: 50,
      verbosity: "quiet",
      unitId: "u1",
      onLog: (e) => events.push(e),
    });

    expect(result.signal.type).toBe("none");

    const turnEvents = events.filter(
      (e): e is Extract<LogEvent, { type: "agent:turn_count" }> =>
        e.type === "agent:turn_count",
    );

    expect(turnEvents.map((e) => e.numTurns)).toEqual([1, 2, 3]);
    expect(turnEvents.every((e) => e.maxTurns === 50)).toBe(true);
    expect(turnEvents.every((e) => e.unitId === "u1")).toBe(true);
    // Model is captured from init message (handleSystem runs before
    // first handleAssistant in our fixture).
    expect(turnEvents.every((e) => e.model === "claude-opus-4-6")).toBe(true);
  });

  it("returns signal:none with Max turns exceeded marker when SDK reports error_max_turns", async () => {
    // Fixture: SDK honored its built-in maxTurns and terminated the turn with
    // result.subtype === "error_max_turns". The driver must translate this
    // into the shared fail-soft contract: signal:none + prepended marker +
    // preserved metrics, so run.ts treats it as a no-signal retry candidate
    // instead of a hard error stop.
    sdkRunMessages = [
      { type: "system", subtype: "init", model: "claude-opus-4-6", tools: [] },
      { type: "assistant", message: { content: [{ type: "text", text: "partial output" }] } },
      {
        type: "result",
        subtype: "error_max_turns",
        duration_ms: 200,
        total_cost_usd: 0.05,
        num_turns: 5,
        modelUsage: {
          "claude-opus-4-6": {
            inputTokens: 1000,
            outputTokens: 200,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
        result: "truncated at the limit",
      },
    ];

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const driver = new ClaudeDriver();
    const result = await driver.runSession({
      prompt: "p",
      systemPrompt: "s",
      cwd: "/tmp",
      maxTurns: 5,
      verbosity: "quiet",
      unitId: "u1",
    });

    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(5\)/);
    // Metrics are preserved — NOT zeroed through errorResult
    expect(result.numTurns).toBe(5);
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(200);
    expect(result.costUsd).toBeCloseTo(0.05);
    consoleErrorSpy.mockRestore();
  });

  it("does NOT count sub-agent assistant messages (parent_tool_use_id !== null)", async () => {
    // SDK's maxTurns applies to the main thread only. Sub-agent messages
    // spawned by the Task tool carry parent_tool_use_id !== null — counting
    // them would overshoot the indicator (e.g. 268/200 when main thread
    // is at 200 but inner Task workers emitted extra assistants).
    sdkRunMessages = [
      { type: "system", subtype: "init", model: "claude-opus-4-6", tools: [] },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "main 1" }] } },
      { type: "assistant", parent_tool_use_id: "toolu_01", message: { content: [{ type: "text", text: "subagent A" }] } },
      { type: "assistant", parent_tool_use_id: "toolu_02", message: { content: [{ type: "text", text: "subagent B" }] } },
      { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "main 2" }] } },
      {
        type: "result", subtype: "success", duration_ms: 0, total_cost_usd: 0, num_turns: 2, modelUsage: {}, result: "",
      },
    ];

    const events: LogEvent[] = [];
    const driver = new ClaudeDriver();
    await driver.runSession({
      prompt: "p", systemPrompt: "s", cwd: "/tmp", maxTurns: 10, verbosity: "quiet", unitId: "u1",
      onLog: (e) => events.push(e),
    });

    const turns = events.filter(
      (e): e is Extract<LogEvent, { type: "agent:turn_count" }> => e.type === "agent:turn_count",
    );
    // Only the two parent_tool_use_id === null messages count.
    expect(turns.map((e) => e.numTurns)).toEqual([1, 2]);
  });

  it("does NOT emit agent:turn_count during startChat", async () => {
    sdkChatQueue = new AsyncQueue<Record<string, unknown>>();
    const events: LogEvent[] = [];
    const driver = new ClaudeDriver();

    const stream = driver.startChat({
      cwd: "/tmp",
      verbosity: "quiet",
      onLog: (e) => events.push(e),
    });

    await tick();
    driver.sendMessage("hi");
    await tick();

    // Push an assistant message to the chat stream — this would trigger
    // handleAssistant in runSession but uses sdkMessageToChatEvents in chat.
    sdkChatQueue!.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "hello back" }] },
    });
    sdkChatQueue!.close();

    // Drain the chat stream until terminal event.
    const collected: ChatEvent[] = [];
    for await (const ev of stream) {
      collected.push(ev);
      if (ev.type === "finished") break;
    }

    expect(collected.some((e) => e.type === "text" && e.content === "hello back")).toBe(true);
    expect(events.some((e) => e.type === "agent:turn_count")).toBe(false);
  });
});
