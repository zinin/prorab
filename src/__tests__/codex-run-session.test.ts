import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexDriver } from "../core/drivers/codex.js";
import type { SessionOptions } from "../core/drivers/types.js";

/**
 * Helper: create an async generator from an array of events,
 * mimicking thread.runStreamed().events.
 */
async function* eventsFrom(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e;
}

/** Default streamed events for a successful run. */
function defaultEvents(overrides?: {
  finalText?: string;
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number };
}) {
  const text = overrides?.finalText ?? "Done. <task-complete>finished</task-complete>";
  const usage = overrides?.usage ?? { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50 };
  return [
    { type: "thread.started", thread_id: "test-thread-123" },
    { type: "item.completed", item: { type: "agent_message", text } },
    { type: "turn.completed", usage },
  ];
}

let mockThread: { runStreamed: ReturnType<typeof vi.fn> };
let mockStartThread: ReturnType<typeof vi.fn>;

vi.mock("@openai/codex-sdk", () => {
  const MockCodex = vi.fn(function (this: any) {
    this.startThread = (...args: any[]) => mockStartThread(...args);
  });
  return { Codex: MockCodex };
});

function makeOpts(overrides: Partial<SessionOptions> = {}): SessionOptions {
  return {
    prompt: "Do the task",
    systemPrompt: "You are an agent",
    cwd: "/tmp/test",
    maxTurns: 200,
    verbosity: "quiet",
    unitId: "task-1",
    ...overrides,
  };
}

describe("CodexDriver.runSession", () => {
  beforeEach(() => {
    mockThread = {
      runStreamed: vi.fn().mockResolvedValue({
        events: eventsFrom(defaultEvents()),
      }),
    };
    mockStartThread = vi.fn().mockReturnValue(mockThread);
    // Mock readLastTokenUsage to avoid filesystem access in tests
    vi.spyOn(CodexDriver.prototype as any, "readLastTokenUsage").mockResolvedValue(null);
  });

  it("returns IterationResult with parsed signal on success", async () => {
    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts());

    expect(result.signal).toEqual({ type: "complete" });
    expect(result.resultText).toBe("Done. <task-complete>finished</task-complete>");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.cacheReadTokens).toBe(10);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.reasoningTokens).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.numTurns).toBe(1);
  });

  it("passes correct thread options", async () => {
    const driver = new CodexDriver("gpt-5.4");
    await driver.runSession(makeOpts({ variant: "xhigh" }));

    expect(mockStartThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/tmp/test",
        model: "gpt-5.4",
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        networkAccessEnabled: true,
        modelReasoningEffort: "xhigh",
        skipGitRepoCheck: true,
      }),
    );
  });

  it("prepends system prompt to user prompt", async () => {
    const driver = new CodexDriver();
    await driver.runSession(makeOpts({
      systemPrompt: "Be helpful",
      prompt: "Fix the bug",
    }));

    const sentPrompt = mockThread.runStreamed.mock.calls[0][0];
    expect(sentPrompt).toContain("Be helpful");
    expect(sentPrompt).toContain("Fix the bug");
    expect(sentPrompt).toContain("---");
    expect(sentPrompt).not.toContain("<system>");
  });

  it("parses blocked signal", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom(defaultEvents({
        finalText: "<task-blocked>missing dependency</task-blocked>",
      })),
    });

    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts());
    expect(result.signal).toEqual({ type: "blocked", reason: "missing dependency" });
  });

  it("parses task report and review report", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom(defaultEvents({
        finalText: "<task-report>changes made</task-report>\n<review-report>looks good</review-report>\n<task-complete>done</task-complete>",
      })),
    });

    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts());
    expect(result.agentReport).toBe("changes made");
    expect(result.reviewReport).toBe("looks good");
  });

  it("concatenates multiple agent_message items into resultText", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        { type: "thread.started", thread_id: "t1" },
        { type: "item.completed", item: { type: "agent_message", text: "First part. " } },
        { type: "item.completed", item: { type: "agent_message", text: "<task-complete>done</task-complete>" } },
        { type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 20 } },
      ]),
    });

    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts());
    expect(result.resultText).toBe("First part. <task-complete>done</task-complete>");
    expect(result.signal).toEqual({ type: "complete" });
  });

  it("returns 'none' signal when no signal tags present", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom(defaultEvents({
        finalText: "I did some work but no signal",
      })),
    });

    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts());
    expect(result.signal).toEqual({ type: "none" });
  });

  it("passes abort signal to SDK", async () => {
    const ac = new AbortController();
    const driver = new CodexDriver();
    await driver.runSession(makeOpts({ abortController: ac }));

    expect(mockThread.runStreamed).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: ac.signal }),
    );
  });

  it("returns error signal when runStreamed throws", async () => {
    mockThread.runStreamed.mockRejectedValue(new Error("network error"));
    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts());
    expect(result.signal).toEqual({ type: "error", message: "network error" });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error signal on turn.failed event", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        { type: "thread.started", thread_id: "t1" },
        { type: "turn.failed", error: { message: "rate limit exceeded" } },
      ]),
    });

    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts());
    expect(result.signal).toEqual({ type: "error", message: "rate limit exceeded" });
  });

  it("streams tool events via onLog callback", async () => {
    const logEvents: Array<Record<string, unknown>> = [];
    const onLog = (e: Record<string, unknown>) => { logEvents.push(e); };

    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        { type: "thread.started", thread_id: "t1" },
        { type: "item.started", item: { type: "command_execution", command: "ls -la" } },
        { type: "item.completed", item: { type: "command_execution", command: "ls -la", aggregated_output: "total 0" } },
        { type: "item.completed", item: { type: "agent_message", text: "<task-complete>done</task-complete>" } },
        { type: "turn.completed", usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 20 } },
      ]),
    });

    const driver = new CodexDriver();
    await driver.runSession(makeOpts({ onLog, verbosity: "debug" }));

    const toolEvent = logEvents.find((e) => e.type === "agent:tool" && (e as any).name === "command");
    expect(toolEvent).toBeDefined();
    const resultEvent = logEvents.find((e) => e.type === "agent:tool_result");
    expect(resultEvent).toBeDefined();
  });

  it("uses session file for accurate context usage", async () => {
    vi.spyOn(CodexDriver.prototype as any, "readLastTokenUsage").mockResolvedValue({
      inputTokens: 5000,
      contextWindow: 200_000,
    });

    const logEvents: Array<Record<string, unknown>> = [];
    const onLog = (e: Record<string, unknown>) => { logEvents.push(e); };

    const driver = new CodexDriver();
    await driver.runSession(makeOpts({ onLog }));

    const ctxEvents = logEvents.filter((e) => e.type === "agent:context_usage") as any[];
    // First event: initial (contextTokens=0), last: accurate from session file
    expect(ctxEvents.length).toBeGreaterThanOrEqual(2);
    expect(ctxEvents[0].contextTokens).toBe(0); // initial
    const lastCtx = ctxEvents[ctxEvents.length - 1];
    expect(lastCtx.contextTokens).toBe(5000);
    expect(lastCtx.contextWindow).toBe(200_000);
  });
});
