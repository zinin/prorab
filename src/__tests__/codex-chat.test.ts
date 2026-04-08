import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexDriver } from "../core/drivers/codex.js";
import type { ChatOptions, ChatEvent } from "../core/drivers/types.js";

let mockThread: { runStreamed: ReturnType<typeof vi.fn> };
let mockStartThread: ReturnType<typeof vi.fn>;

vi.mock("@openai/codex-sdk", () => {
  const MockCodex = vi.fn(function (this: any) {
    this.startThread = (...args: any[]) => mockStartThread(...args);
  });
  return { Codex: MockCodex };
});

function makeChatOpts(overrides: Partial<ChatOptions> = {}): ChatOptions {
  return {
    cwd: "/tmp/test",
    verbosity: "quiet",
    ...overrides,
  };
}

async function collectEvents(
  iter: AsyncIterable<ChatEvent>,
  count: number,
): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const ev of iter) {
    events.push(ev);
    if (events.length >= count) break;
  }
  return events;
}

describe("CodexDriver chat", () => {
  let mockEvents: Array<{ type: string; [key: string]: unknown }>;

  beforeEach(() => {
    // Stub readLastTokenUsage to avoid real filesystem access
    vi.spyOn(CodexDriver.prototype as any, "readLastTokenUsage").mockResolvedValue({
      inputTokens: 100,
      contextWindow: 272000,
    });

    mockEvents = [
      { type: "thread.started", thread_id: "test-thread-123" },
      { type: "turn.started" },
      {
        type: "item.started",
        item: {
          id: "1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "command_execution",
          command: "ls",
          aggregated_output: "file.txt",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: { id: "2", type: "agent_message", text: "Here are the files." },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 10,
          output_tokens: 50,
        },
      },
    ];

    mockThread = {
      runStreamed: vi.fn().mockResolvedValue({
        events: (async function* () {
          for (const ev of mockEvents) yield ev;
        })(),
      }),
    };
    mockStartThread = vi.fn().mockReturnValue(mockThread);
  });

  it("emits tool, tool_result, text, context_usage, idle events in order", async () => {
    const driver = new CodexDriver();
    const iter = driver.startChat(makeChatOpts());
    const eventsPromise = collectEvents(iter, 5);
    driver.sendMessage("list files");
    const events = await eventsPromise;

    expect(events[0]).toEqual({
      type: "tool",
      name: "command",
      input: { command: "ls" },
    });
    expect(events[1]).toEqual({
      type: "tool_result",
      name: "command",
      output: "file.txt",
    });
    expect(events[2]).toEqual({
      type: "text",
      content: "Here are the files.",
    });
    expect(events[3].type).toBe("context_usage");
    expect(events[4]).toEqual({ type: "idle" });
  });

  it("emits finished event on abortChat", async () => {
    const driver = new CodexDriver();
    const iter = driver.startChat(makeChatOpts());
    const eventsPromise = collectEvents(iter, 1);
    driver.abortChat();
    const events = await eventsPromise;
    expect(events[0]).toEqual({ type: "finished" });
  });

  it("replyQuestion is a no-op", () => {
    const driver = new CodexDriver();
    driver.replyQuestion("q1", { answer: "yes" });
  });

  it("passes thread options from ChatOptions", async () => {
    const driver = new CodexDriver("gpt-5.4");
    const iter = driver.startChat(makeChatOpts({ variant: "high" }));
    const eventsPromise = collectEvents(iter, 5);
    driver.sendMessage("hello");
    await eventsPromise;

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.4",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        networkAccessEnabled: true,
        modelReasoningEffort: "high",
      }),
    );
  });

  it("maps file_change events to tool/tool_result", async () => {
    mockEvents = [
      {
        type: "item.started",
        item: {
          id: "1",
          type: "file_change",
          changes: [{ path: "src/index.ts", kind: "update" }],
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "file_change",
          changes: [{ path: "src/index.ts", kind: "update" }],
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 50,
          cached_input_tokens: 0,
          output_tokens: 20,
        },
      },
    ];
    mockThread.runStreamed.mockResolvedValue({
      events: (async function* () {
        for (const ev of mockEvents) yield ev;
      })(),
    });

    const driver = new CodexDriver();
    const iter = driver.startChat(makeChatOpts());
    const eventsPromise = collectEvents(iter, 4);
    driver.sendMessage("update file");
    const events = await eventsPromise;

    expect(events[0]).toEqual({
      type: "tool",
      name: "file_change",
      input: { changes: [{ path: "src/index.ts", kind: "update" }] },
    });
    expect(events[1]).toEqual({
      type: "tool_result",
      name: "file_change",
      output: "update: src/index.ts",
    });
  });

  it("maps mcp_tool_call events to tool/tool_result", async () => {
    mockEvents = [
      {
        type: "item.started",
        item: {
          id: "1",
          type: "mcp_tool_call",
          server: "test-server",
          tool: "search",
          arguments: { query: "hello" },
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "1",
          type: "mcp_tool_call",
          server: "test-server",
          tool: "search",
          arguments: { query: "hello" },
          result: { content: [], structured_content: { answer: "world" } },
          status: "completed",
        },
      },
      {
        type: "turn.completed",
        usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 20 },
      },
    ];
    mockThread.runStreamed.mockResolvedValue({
      events: (async function* () {
        for (const ev of mockEvents) yield ev;
      })(),
    });

    const driver = new CodexDriver();
    const iter = driver.startChat(makeChatOpts());
    const eventsPromise = collectEvents(iter, 4);
    driver.sendMessage("search something");
    const events = await eventsPromise;

    expect(events[0]).toEqual({
      type: "tool",
      name: "search",
      input: { query: "hello" },
    });
    expect(events[1]).toEqual({
      type: "tool_result",
      name: "search",
      output: JSON.stringify({ content: [], structured_content: { answer: "world" } }),
    });
  });

  it("emits error event on stream-level error", async () => {
    mockEvents = [{ type: "error", message: "fatal stream error" }];
    mockThread.runStreamed.mockResolvedValue({
      events: (async function* () {
        for (const ev of mockEvents) yield ev;
      })(),
    });

    const driver = new CodexDriver();
    const iter = driver.startChat(makeChatOpts());
    const eventsPromise = collectEvents(iter, 1);
    driver.sendMessage("hello");
    const events = await eventsPromise;
    expect(events[0]).toEqual({ type: "error", message: "fatal stream error" });
  });

  it("emits error event on turn.failed", async () => {
    mockEvents = [{ type: "turn.failed", error: { message: "rate limited" } }];
    mockThread.runStreamed.mockResolvedValue({
      events: (async function* () {
        for (const ev of mockEvents) yield ev;
      })(),
    });

    const driver = new CodexDriver();
    const iter = driver.startChat(makeChatOpts());
    const eventsPromise = collectEvents(iter, 1);
    driver.sendMessage("hello");
    const events = await eventsPromise;
    expect(events[0]).toEqual({ type: "error", message: "rate limited" });
  });

  it("throws on double startChat", () => {
    const driver = new CodexDriver();
    driver.startChat(makeChatOpts());
    expect(() => driver.startChat(makeChatOpts())).toThrow("already active");
  });

  it("throws on sendMessage without active session", () => {
    const driver = new CodexDriver();
    expect(() => driver.sendMessage("hello")).toThrow("No active chat session");
  });

  it("prepends system prompt to first message only", async () => {
    const driver = new CodexDriver();
    const iter = driver.startChat(
      makeChatOpts({ systemPrompt: "Be helpful" }),
    );
    const eventsPromise = collectEvents(iter, 5);
    driver.sendMessage("first msg");
    await eventsPromise;

    const firstCall = mockThread.runStreamed.mock.calls[0][0];
    expect(firstCall).toContain("Be helpful");
    expect(firstCall).toContain("first msg");
    expect(firstCall).toContain("---");
    expect(firstCall).not.toContain("<system>");
  });
});
