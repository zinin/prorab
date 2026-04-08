/**
 * Tests based on real captured SDK messages from Claude Code driver.
 * Fixture in src/__tests__/fixtures/claude-opus-4-6.json contains minimized data
 * from an actual prorab run with claude-opus-4-6 (primary) + claude-haiku-4-5 (sub-agents).
 *
 * These tests verify that the processing logic in ClaudeDriver.runSession()
 * correctly aggregates tokens, extracts model/cost/duration, and parses signals.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSignal } from "../core/drivers/types.js";

// --- Fixture types ---

interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}

interface ResultMessage {
  type: "result";
  subtype: string;
  duration_ms: number;
  duration_api_ms: number;
  total_cost_usd: number;
  num_turns: number;
  session_id: string;
  is_error: boolean;
  modelUsage: Record<string, ModelUsageEntry>;
  usage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    service_tier: string;
  };
  result: string;
}

interface InitMessage {
  type: "system";
  subtype: "init";
  model: string;
  session_id: string;
  tools_count: number;
}

interface TaskStartedMessage {
  type: "system";
  subtype: "task_started";
  description: string;
  task_id: string;
}

interface Fixture {
  model: string;
  driver: string;
  totalSdkMessages: number;
  messageCounts: Record<string, number>;
  initMessage: InitMessage;
  sampleTextBlocks: Array<{
    type: "assistant";
    content_block: { type: "text"; text: string };
  }>;
  sampleToolUseBlocks: Array<{
    type: "assistant";
    content_block: {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    };
  }>;
  taskStartedMessages: TaskStartedMessage[];
  rateLimitEvents: Array<{ type: string; rate_limit_info: Record<string, unknown> }>;
  resultMessage: ResultMessage;
  iterationResult: {
    signal: { type: string; reason?: string };
    numTurns: number;
    durationMs: number;
    costUsd: number;
    resultText: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    model: string;
  };
}

const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");

function loadFixture(): Fixture {
  const raw = readFileSync(join(FIXTURES_DIR, "claude-opus-4-6.json"), "utf8");
  return JSON.parse(raw);
}

// --- Tests ---

describe("Claude real data: token aggregation from modelUsage", () => {
  const fixture = loadFixture();
  const { modelUsage } = fixture.resultMessage;
  const ir = fixture.iterationResult;

  it("modelUsage contains opus and haiku models", () => {
    const models = Object.keys(modelUsage);
    expect(models).toContain("claude-opus-4-6");
    expect(models).toContain("claude-haiku-4-5-20251001");
    expect(models.length).toBe(2);
  });

  it("inputTokens sums inputTokens across all models", () => {
    let sum = 0;
    for (const usage of Object.values(modelUsage)) {
      sum += usage.inputTokens;
    }
    expect(ir.inputTokens).toBe(sum);
  });

  it("outputTokens sums outputTokens across all models", () => {
    let sum = 0;
    for (const usage of Object.values(modelUsage)) {
      sum += usage.outputTokens;
    }
    expect(ir.outputTokens).toBe(sum);
  });

  it("cacheReadTokens sums cacheReadInputTokens across all models", () => {
    let sum = 0;
    for (const usage of Object.values(modelUsage)) {
      sum += usage.cacheReadInputTokens;
    }
    expect(ir.cacheReadTokens).toBe(sum);
  });

  it("cacheWriteTokens sums cacheCreationInputTokens across all models", () => {
    let sum = 0;
    for (const usage of Object.values(modelUsage)) {
      sum += usage.cacheCreationInputTokens;
    }
    expect(ir.cacheWriteTokens).toBe(sum);
  });

  it("reasoningTokens is 0 (Claude SDK does not report reasoning tokens)", () => {
    expect(ir.reasoningTokens).toBe(0);
  });
});

describe("Claude real data: model extraction from init", () => {
  const fixture = loadFixture();

  it("init message has model name", () => {
    expect(fixture.initMessage.model).toBe("claude-opus-4-6");
  });

  it("iterationResult.model matches init model", () => {
    expect(fixture.iterationResult.model).toBe(fixture.initMessage.model);
  });

  it("init message has tools count", () => {
    expect(fixture.initMessage.tools_count).toBeGreaterThan(0);
  });
});

describe("Claude real data: cost and duration from result message", () => {
  const fixture = loadFixture();
  const result = fixture.resultMessage;
  const ir = fixture.iterationResult;

  it("costUsd matches total_cost_usd from result", () => {
    expect(ir.costUsd).toBe(result.total_cost_usd);
  });

  it("costUsd equals sum of per-model costUSD", () => {
    let sum = 0;
    for (const usage of Object.values(result.modelUsage)) {
      sum += usage.costUSD;
    }
    expect(ir.costUsd).toBeCloseTo(sum, 4);
  });

  it("cost is non-zero (Claude always reports cost)", () => {
    expect(ir.costUsd).toBeGreaterThan(0);
  });

  it("durationMs matches duration_ms from result", () => {
    expect(ir.durationMs).toBe(result.duration_ms);
  });

  it("durationMs is positive", () => {
    expect(ir.durationMs).toBeGreaterThan(0);
  });

  it("numTurns matches num_turns from result", () => {
    expect(ir.numTurns).toBe(result.num_turns);
  });
});

describe("Claude real data: parseSignal on real resultText", () => {
  const fixture = loadFixture();

  it("resultText contains <task-complete> and parseSignal returns complete", () => {
    const signal = parseSignal(fixture.iterationResult.resultText);
    expect(signal.type).toBe("complete");
    expect(fixture.iterationResult.signal.type).toBe("complete");
  });

  it("resultText is non-empty", () => {
    expect(fixture.iterationResult.resultText.length).toBeGreaterThan(0);
  });

  it("resultText contains <task-complete>DONE</task-complete>", () => {
    expect(fixture.iterationResult.resultText).toContain(
      "<task-complete>DONE</task-complete>",
    );
  });
});

describe("Claude real data: Anthropic token semantics", () => {
  const fixture = loadFixture();
  const ir = fixture.iterationResult;
  const opusUsage = fixture.resultMessage.modelUsage["claude-opus-4-6"];

  it("opus inputTokens is very low (non-cached only)", () => {
    // Anthropic reports inputTokens as only non-cached tokens
    expect(opusUsage.inputTokens).toBeLessThan(100);
  });

  it("opus has substantial cache read tokens", () => {
    expect(opusUsage.cacheReadInputTokens).toBeGreaterThan(100_000);
  });

  it("opus has cache write tokens", () => {
    expect(opusUsage.cacheCreationInputTokens).toBeGreaterThan(0);
  });

  it("total cache tokens vastly exceed inputTokens", () => {
    const totalCache = ir.cacheReadTokens + ir.cacheWriteTokens;
    expect(totalCache).toBeGreaterThan(ir.inputTokens * 100);
  });
});

describe("Claude real data: multi-model usage (sub-agents)", () => {
  const fixture = loadFixture();
  const { modelUsage } = fixture.resultMessage;

  it("haiku was used for sub-agent tasks", () => {
    // task_started messages confirm sub-agent usage
    expect(fixture.taskStartedMessages.length).toBeGreaterThan(0);
    const haiku = modelUsage["claude-haiku-4-5-20251001"];
    expect(haiku).toBeDefined();
    expect(haiku.outputTokens).toBeGreaterThan(0);
  });

  it("opus cost dominates total cost", () => {
    const opus = modelUsage["claude-opus-4-6"];
    const haiku = modelUsage["claude-haiku-4-5-20251001"];
    expect(opus.costUSD).toBeGreaterThan(haiku.costUSD * 10);
  });

  it("haiku has its own cache tokens (separate context)", () => {
    const haiku = modelUsage["claude-haiku-4-5-20251001"];
    expect(haiku.cacheReadInputTokens).toBeGreaterThan(0);
    expect(haiku.cacheCreationInputTokens).toBeGreaterThan(0);
  });
});

describe("Claude real data: SDK message structure", () => {
  const fixture = loadFixture();

  it("has expected message type distribution", () => {
    expect(fixture.messageCounts.assistant).toBeGreaterThan(0);
    expect(fixture.messageCounts.user).toBeGreaterThan(0);
    expect(fixture.messageCounts.system).toBeGreaterThan(0);
    expect(fixture.messageCounts.result).toBe(1);
  });

  it("text blocks have type and text fields", () => {
    for (const block of fixture.sampleTextBlocks) {
      expect(block.type).toBe("assistant");
      expect(block.content_block.type).toBe("text");
      expect(typeof block.content_block.text).toBe("string");
      expect(block.content_block.text.length).toBeGreaterThan(0);
    }
  });

  it("tool_use blocks have id, name, and input", () => {
    for (const block of fixture.sampleToolUseBlocks) {
      expect(block.type).toBe("assistant");
      expect(block.content_block.type).toBe("tool_use");
      expect(block.content_block.id).toBeTruthy();
      expect(block.content_block.name).toBeTruthy();
      expect(block.content_block.input).toBeDefined();
    }
  });

  it("tool_use blocks use recognized tool names", () => {
    const knownTools = new Set([
      "Read", "Write", "Edit", "Glob", "Grep", "Bash",
      "Task", "TaskOutput", "TodoWrite", "WebSearch", "WebFetch",
      "AskUserQuestion", "Skill", "EnterPlanMode", "EnterWorktree",
    ]);
    for (const block of fixture.sampleToolUseBlocks) {
      // Tool name should be known or an MCP tool (mcp__*)
      const name = block.content_block.name;
      expect(
        knownTools.has(name) || name.startsWith("mcp__"),
      ).toBe(true);
    }
  });

  it("result message has subtype 'success'", () => {
    expect(fixture.resultMessage.subtype).toBe("success");
    expect(fixture.resultMessage.is_error).toBe(false);
  });

  it("task_started messages have description and task_id", () => {
    for (const msg of fixture.taskStartedMessages) {
      expect(msg.subtype).toBe("task_started");
      expect(msg.description).toBeTruthy();
      expect(msg.task_id).toBeTruthy();
    }
  });
});

describe("Claude real data: rate_limit_event handling", () => {
  const fixture = loadFixture();

  it("rate_limit_event has rate_limit_info", () => {
    expect(fixture.rateLimitEvents.length).toBeGreaterThan(0);
    const ev = fixture.rateLimitEvents[0];
    expect(ev.type).toBe("rate_limit_event");
    expect(ev.rate_limit_info).toBeDefined();
    expect(ev.rate_limit_info.status).toBe("allowed");
  });
});
