import { describe, it, expect, vi, beforeEach } from "vitest";
import { CodexDriver } from "../core/drivers/codex.js";
import { MaxTurnsExceededError } from "../core/drivers/types.js";
import type { SessionOptions } from "../core/drivers/types.js";

/**
 * Helper: create an async generator from an array of events,
 * mimicking thread.runStreamed().events.
 */
async function* eventsFrom(events: Array<Record<string, unknown>>) {
  for (const e of events) yield e;
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

function threadStarted() {
  return { type: "thread.started", thread_id: "t1" };
}
function toolStartedCmd() {
  return { type: "item.started", item: { type: "command_execution", command: "echo" } };
}
function toolCompletedCmd() {
  return {
    type: "item.completed",
    item: { type: "command_execution", aggregated_output: "" },
  };
}
function reasoning() {
  return { type: "item.completed", item: { type: "reasoning", text: "thinking" } };
}
function agentMessage(text = "ok") {
  return { type: "item.completed", item: { type: "agent_message", text } };
}
function turnCompleted(
  usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number } = {
    input_tokens: 0,
    output_tokens: 0,
    cached_input_tokens: 0,
  },
) {
  return { type: "turn.completed", usage };
}

describe("CodexDriver — maxTurns enforcement", () => {
  beforeEach(() => {
    mockThread = {
      runStreamed: vi.fn(),
    };
    mockStartThread = vi.fn().mockReturnValue(mockThread);
    // Avoid filesystem access for context window reads
    vi.spyOn(CodexDriver.prototype as any, "readLastTokenUsage").mockResolvedValue(null);
  });

  it("counts only tool-call items, not reasoning or agent messages", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        threadStarted(),
        reasoning(),
        agentMessage("text"),
        toolStartedCmd(),
        toolCompletedCmd(),
        toolStartedCmd(),
        toolCompletedCmd(),
        turnCompleted(),
      ]),
    });
    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts({ maxTurns: 10 }));
    expect(result.signal.type).not.toBe("error");
    expect(result.numTurns).toBe(2);
  });

  it("aborts and returns signal:none with marker when limit reached", async () => {
    const ac = new AbortController();
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        threadStarted(),
        toolStartedCmd(),
        toolCompletedCmd(),
        toolStartedCmd(),
        toolCompletedCmd(),
        // 3rd tool call — loop should break before counting it
        toolStartedCmd(),
        toolCompletedCmd(),
        turnCompleted(),
      ]),
    });
    const driver = new CodexDriver();
    const result = await driver.runSession(
      makeOpts({ maxTurns: 2, abortController: ac }),
    );
    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(2\)/);
    expect(result.numTurns).toBe(2);
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBeInstanceOf(MaxTurnsExceededError);
  });

  it("treats maxTurns === 0 as unlimited", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        threadStarted(),
        toolStartedCmd(),
        toolCompletedCmd(),
        toolStartedCmd(),
        toolCompletedCmd(),
        toolStartedCmd(),
        toolCompletedCmd(),
        turnCompleted(),
      ]),
    });
    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts({ maxTurns: 0 }));
    expect(result.signal.type).not.toBe("error");
    expect(result.resultText).not.toMatch(/Max turns exceeded/);
    expect(result.numTurns).toBe(3);
  });

  it("breaches without abortController — top-of-loop guard exits the for-await", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        threadStarted(),
        toolStartedCmd(),
        toolCompletedCmd(),
        toolStartedCmd(),
        toolCompletedCmd(),
        // 3rd tool call — guard must break loop before counting it,
        // even without an abortController to abort.
        toolStartedCmd(),
        toolCompletedCmd(),
        turnCompleted(),
      ]),
    });
    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts({ maxTurns: 2 }));
    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(2\)/);
    expect(result.numTurns).toBe(2);
  });

  it("external AbortController abort with non-maxTurns reason keeps error path", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));
    mockThread.runStreamed.mockRejectedValue(new Error("user cancelled"));
    const driver = new CodexDriver();
    const result = await driver.runSession(
      makeOpts({ maxTurns: 10, abortController: ac }),
    );
    expect(result.signal.type).toBe("error");
    if (result.signal.type === "error") {
      expect(result.signal.message).not.toMatch(/Max turns exceeded/);
    }
  });

  it("aborts on the very first tool-call when maxTurns === 1 (boundary N=1)", async () => {
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        threadStarted(),
        toolStartedCmd(),
        toolCompletedCmd(),
        toolStartedCmd(),
        toolCompletedCmd(),
        turnCompleted(),
      ]),
    });
    const driver = new CodexDriver();
    const result = await driver.runSession(makeOpts({ maxTurns: 1 }));
    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(1\)/);
    expect(result.numTurns).toBe(1);
  });

  it("preserves token usage from turn.completed arriving after breach", async () => {
    // Regression: the top-of-loop guard used to break unconditionally on
    // maxTurnsExceeded, skipping turn.completed and zeroing token metrics.
    // Now we consume the terminal event for its `usage` before breaking.
    const ac = new AbortController();
    mockThread.runStreamed.mockResolvedValue({
      events: eventsFrom([
        threadStarted(),
        toolStartedCmd(),
        toolCompletedCmd(),
        toolStartedCmd(),
        toolCompletedCmd(),
        // Post-breach extra tool-call (should be dropped) +
        // terminal turn.completed with real usage (must be preserved).
        toolStartedCmd(),
        toolCompletedCmd(),
        turnCompleted({ input_tokens: 4200, output_tokens: 910, cached_input_tokens: 128 }),
      ]),
    });
    const driver = new CodexDriver();
    const result = await driver.runSession(
      makeOpts({ maxTurns: 2, abortController: ac }),
    );
    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(2\)/);
    expect(result.numTurns).toBe(2);
    expect(result.inputTokens).toBe(4200);
    expect(result.outputTokens).toBe(910);
    expect(result.cacheReadTokens).toBe(128);
  });

  it("SDK surfaces abort as DOMException AbortError — still classified as breach", async () => {
    // When abortController.abort(MaxTurnsExceededError) is called, some SDK
    // versions wrap it: the for-await throws a standard AbortError while
    // signal.reason still carries our MaxTurnsExceededError instance. The
    // catch block must recognize this via `maxTurnsExceeded` flag or via
    // `signal.reason instanceof MaxTurnsExceededError` and return the
    // fail-soft signal:none result.
    const ac = new AbortController();
    mockThread.runStreamed.mockImplementation(async () => {
      return {
        events: (async function* () {
          yield threadStarted();
          yield toolStartedCmd();
          yield toolCompletedCmd();
          yield toolStartedCmd();
          yield toolCompletedCmd();
          // 3rd tool-call triggers our abort; simulate the SDK reacting by
          // throwing a synthetic AbortError on the next iteration instead of
          // respecting the flag guard.
          yield toolStartedCmd();
          const abortErr = new Error("The operation was aborted");
          abortErr.name = "AbortError";
          throw abortErr;
        })(),
      };
    });
    const driver = new CodexDriver();
    const result = await driver.runSession(
      makeOpts({ maxTurns: 2, abortController: ac }),
    );
    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(2\)/);
    expect(ac.signal.reason).toBeInstanceOf(MaxTurnsExceededError);
  });
});
