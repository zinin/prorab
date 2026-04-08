import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Verbosity } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");
const fixture = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "claude-opus-4-6.json"), "utf8"),
);

/**
 * Reconstruct SDK message stream from fixture data + synthetic events.
 *
 * The SDK query() returns an async iterable of messages.
 * ClaudeDriver.dispatchMessage() switches on msg.type:
 *   "system"           → handleSystem (init, status, task_started, task_notification)
 *   "assistant"        → handleAssistant (text blocks, tool_use blocks)
 *   "tool_use_summary" → handleToolUseSummary
 *   "tool_progress"    → handleToolProgress
 *   "rate_limit_event" → handleRateLimit
 *   "result"           → handleResult (terminates loop)
 */
function buildSdkMessages(): unknown[] {
  const messages: unknown[] = [];

  // 1. Init message — must include a real `tools` array (driver reads .length)
  messages.push({
    ...fixture.initMessage,
    tools: new Array(fixture.initMessage.tools_count).fill({ name: "mock" }),
  });

  // 2. Assistant messages with text blocks
  for (const block of fixture.sampleTextBlocks) {
    messages.push({
      type: "assistant",
      message: { content: [block.content_block] },
    });
  }

  // 3. Assistant messages with tool_use blocks
  for (const block of fixture.sampleToolUseBlocks) {
    messages.push({
      type: "assistant",
      message: { content: [block.content_block] },
    });
  }

  // 4. Tool use summaries (not in fixture — hand-crafted, 2 examples)
  messages.push({
    type: "tool_use_summary",
    summary: "Read file /home/user/projects/test-app/CLAUDE.md",
  });
  messages.push({
    type: "tool_use_summary",
    summary: "Ran command: npm test -- --reporter=verbose",
  });

  // 5. Tool progress (not in fixture — hand-crafted, tests [running] output)
  messages.push({
    type: "tool_progress",
    tool_name: "Bash",
    elapsed_time_seconds: 6,
    tool_use_id: "toolu_test_progress",
  });

  // 6. System status message (not in fixture — hand-crafted)
  messages.push({
    type: "system",
    subtype: "status",
    status: "Processing tool results...",
  });

  // 7. Task started messages
  for (const msg of fixture.taskStartedMessages) {
    messages.push(msg);
  }

  // 8. Rate limit events
  for (const ev of fixture.rateLimitEvents) {
    messages.push(ev);
  }

  // 9. Result message (terminates the event loop)
  messages.push(fixture.resultMessage);

  return messages;
}

// ---------------------------------------------------------------------------
// SDK mock
// ---------------------------------------------------------------------------

let sdkMessages: unknown[];
let capturedStderr: ((data: string) => void) | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(({ options }: { prompt: string; options: Record<string, unknown> }) => {
    // Capture stderr callback for testing
    if (typeof options?.stderr === "function") {
      capturedStderr = options.stderr as (data: string) => void;
    }
    return (async function* () {
      for (const msg of sdkMessages) {
        yield msg;
        // Invoke stderr after yielding tool_progress (simulates agent stderr output)
        if (
          (msg as Record<string, unknown>).type === "tool_progress" &&
          capturedStderr
        ) {
          capturedStderr("warning: some agent stderr output\n");
        }
      }
    })();
  }),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Import AFTER mock is registered
const { ClaudeDriver } = await import("../core/drivers/claude.js");

describe("Claude console output", () => {
  let logs: string[];

  beforeEach(() => {
    logs = [];
    sdkMessages = buildSdkMessages();
    capturedStderr = null;
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function runWithVerbosity(verbosity: Verbosity) {
    const driver = new ClaudeDriver("claude-opus-4-6", false);
    const result = await driver.runSession({
      prompt: "test prompt",
      systemPrompt: "test system",
      cwd: "/tmp/test",
      maxTurns: 10,
      verbosity,
      unitId: "test",
    });
    return { result, logs: [...logs] };
  }

  it("debug: output matches snapshot", async () => {
    const { logs, result } = await runWithVerbosity("debug");
    expect(logs).toMatchSnapshot();
    // Fixture text blocks + truncated result don't contain <task-complete> tag
    expect(result.signal.type).toBe("none");
    expect(result.numTurns).toBeGreaterThan(0);
  });

  it("info: output matches snapshot", async () => {
    const { logs, result } = await runWithVerbosity("info");
    expect(logs).toMatchSnapshot();
    expect(result.model).toBe("claude-opus-4-6");
  });

  it("quiet: no output", async () => {
    const { logs } = await runWithVerbosity("quiet");
    expect(logs).toEqual([]);
  });
});
