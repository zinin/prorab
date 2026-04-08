/**
 * Tests based on real captured SSE events from OpenCode driver.
 * Fixtures in src/__tests__/fixtures/ contain minimized data from actual runs
 * with 5 different models (anthropic, gemini, minimax, openai, glm-4.7).
 *
 * These tests verify that the processing logic in OpenCodeDriver.runSession()
 * correctly aggregates tokens, extracts model/cost/duration, and parses signals.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSignal } from "../core/drivers/types.js";

// --- Fixture loading ---

interface StepFinishPart {
  type: "step-finish";
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

interface TextPart {
  id: string;
  sessionID: string;
  type: "text";
  text: string;
}

interface ToolPart {
  id: string;
  type: "tool";
  tool: string;
  state: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
  };
}

interface AssistantMessageInfo {
  role: "assistant";
  providerID: string;
  modelID: string;
  cost: number;
  time: { created: number; completed?: number };
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
}

interface Fixture {
  model: string;
  totalSseEvents: number;
  stepFinishEvents: Array<{
    type: "message.part.updated";
    properties: { part: StepFinishPart };
  }>;
  sampleTextParts: Array<{
    type: "message.part.updated";
    properties: { part: TextPart; delta?: string };
  }>;
  sampleToolParts: Array<{
    type: "message.part.updated";
    properties: { part: ToolPart };
  }>;
  sessionEvents: Array<{ type: string; properties: Record<string, unknown> }>;
  assistantMessages: Array<{
    info: AssistantMessageInfo;
    parts: Array<{ type: string; text?: string }>;
  }>;
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

function loadFixture(slug: string): Fixture {
  const raw = readFileSync(join(FIXTURES_DIR, `opencode-${slug}.json`), "utf8");
  return JSON.parse(raw);
}

const MODELS = [
  "anthropic-claude-sonnet-4-6",
  "google-vertex-gemini-3.1-pro-preview",
  "minimax-MiniMax-M2.5",
  "openai-gpt-5.3-codex",
  "zai-coding-plan-glm-4.7",
];

// --- Tests ---

describe("OpenCode real data: step-finish token aggregation", () => {
  for (const slug of MODELS) {
    describe(slug, () => {
      const fixture = loadFixture(slug);

      it("step-finish events sum to iterationResult token counts", () => {
        let inputTokens = 0;
        let outputTokens = 0;
        let reasoningTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;

        for (const ev of fixture.stepFinishEvents) {
          const t = ev.properties.part.tokens;
          inputTokens += t.input;
          outputTokens += t.output;
          reasoningTokens += t.reasoning;
          cacheReadTokens += t.cache.read;
          cacheWriteTokens += t.cache.write;
        }

        expect(inputTokens).toBe(fixture.iterationResult.inputTokens);
        expect(outputTokens).toBe(fixture.iterationResult.outputTokens);
        expect(reasoningTokens).toBe(fixture.iterationResult.reasoningTokens);
        expect(cacheReadTokens).toBe(fixture.iterationResult.cacheReadTokens);
        expect(cacheWriteTokens).toBe(fixture.iterationResult.cacheWriteTokens);
      });

      it("step-finish count matches or exceeds numTurns (turns = max of step count and message count)", () => {
        const stepCount = fixture.stepFinishEvents.length;
        const msgCount = fixture.assistantMessages.length;
        // numTurns = Math.max(numTurns_from_steps, assistantMsgs.length)
        expect(fixture.iterationResult.numTurns).toBe(
          Math.max(stepCount, msgCount),
        );
      });

      it("each step-finish has valid token structure", () => {
        for (const ev of fixture.stepFinishEvents) {
          const part = ev.properties.part;
          expect(part.type).toBe("step-finish");
          expect(part.tokens).toBeDefined();
          expect(part.tokens.input).toBeGreaterThanOrEqual(0);
          expect(part.tokens.output).toBeGreaterThanOrEqual(0);
          expect(part.tokens.reasoning).toBeGreaterThanOrEqual(0);
          expect(part.tokens.cache.read).toBeGreaterThanOrEqual(0);
          expect(part.tokens.cache.write).toBeGreaterThanOrEqual(0);
          expect(part.cost).toBeGreaterThanOrEqual(0);
        }
      });
    });
  }
});

describe("OpenCode real data: session.messages() model extraction", () => {
  for (const slug of MODELS) {
    describe(slug, () => {
      const fixture = loadFixture(slug);

      it("last assistant message has providerID and modelID", () => {
        const msgs = fixture.assistantMessages;
        expect(msgs.length).toBeGreaterThan(0);
        const last = msgs[msgs.length - 1].info;
        expect(last.providerID).toBeTruthy();
        expect(last.modelID).toBeTruthy();
      });

      it("model in iterationResult matches providerID/modelID from messages", () => {
        const msgs = fixture.assistantMessages;
        const last = msgs[msgs.length - 1].info;
        const expected = `${last.providerID}/${last.modelID}`;
        expect(fixture.iterationResult.model).toBe(expected);
      });
    });
  }
});

describe("OpenCode real data: cost from session.messages()", () => {
  it("anthropic reports zero cost across all messages", () => {
    const fixture = loadFixture("anthropic-claude-sonnet-4-6");
    const totalCost = fixture.assistantMessages.reduce(
      (sum, m) => sum + m.info.cost,
      0,
    );
    expect(totalCost).toBe(0);
    expect(fixture.iterationResult.costUsd).toBe(0);
  });

  it("gemini reports non-zero cost summed from messages", () => {
    const fixture = loadFixture("google-vertex-gemini-3.1-pro-preview");
    const totalCost = fixture.assistantMessages.reduce(
      (sum, m) => sum + m.info.cost,
      0,
    );
    expect(totalCost).toBeGreaterThan(0);
    // Cost from messages overrides step-finish cost
    expect(fixture.iterationResult.costUsd).toBeCloseTo(totalCost, 4);
  });

  it("openai reports zero cost", () => {
    const fixture = loadFixture("openai-gpt-5.3-codex");
    expect(fixture.iterationResult.costUsd).toBe(0);
  });
});

describe("OpenCode real data: duration from session.messages()", () => {
  for (const slug of MODELS) {
    it(`${slug}: duration is positive and matches first.created → last.completed`, () => {
      const fixture = loadFixture(slug);
      const msgs = fixture.assistantMessages;
      const first = msgs[0].info;
      const last = msgs[msgs.length - 1].info;

      const createdMs = first.time.created;
      const completedMs = last.time.completed ?? last.time.created;
      const expectedDuration = Math.max(0, completedMs - createdMs);

      expect(fixture.iterationResult.durationMs).toBe(expectedDuration);
      expect(fixture.iterationResult.durationMs).toBeGreaterThan(0);
    });
  }
});

describe("OpenCode real data: parseSignal on real resultText", () => {
  for (const slug of MODELS) {
    it(`${slug}: resultText contains <task-complete> and parseSignal returns complete`, () => {
      const fixture = loadFixture(slug);
      const signal = parseSignal(fixture.iterationResult.resultText);
      expect(signal.type).toBe("complete");
      expect(fixture.iterationResult.signal.type).toBe("complete");
    });
  }
});

describe("OpenCode real data: provider-specific token semantics", () => {
  it("anthropic: inputTokens is non-cached only (very low), cache tokens are high", () => {
    const fixture = loadFixture("anthropic-claude-sonnet-4-6");
    const ir = fixture.iterationResult;
    // Anthropic reports input as only non-cached tokens
    expect(ir.inputTokens).toBeLessThan(100);
    // But cache read + write should be substantial
    expect(ir.cacheReadTokens + ir.cacheWriteTokens).toBeGreaterThan(10000);
  });

  it("minimax: no cache support (all zeros)", () => {
    const fixture = loadFixture("minimax-MiniMax-M2.5");
    const ir = fixture.iterationResult;
    expect(ir.cacheReadTokens).toBe(0);
    expect(ir.cacheWriteTokens).toBe(0);
    expect(ir.reasoningTokens).toBe(0);
  });

  it("openai: has reasoning tokens and cache reads but no cache writes", () => {
    const fixture = loadFixture("openai-gpt-5.3-codex");
    const ir = fixture.iterationResult;
    expect(ir.reasoningTokens).toBeGreaterThan(0);
    expect(ir.cacheReadTokens).toBeGreaterThan(0);
    expect(ir.cacheWriteTokens).toBe(0);
  });

  it("gemini: has reasoning tokens and cache reads, reports per-step cost", () => {
    const fixture = loadFixture("google-vertex-gemini-3.1-pro-preview");
    const ir = fixture.iterationResult;
    expect(ir.reasoningTokens).toBeGreaterThan(0);
    expect(ir.cacheReadTokens).toBeGreaterThan(0);
    expect(ir.costUsd).toBeGreaterThan(0);
  });

  it("glm-4.7: has reasoning tokens and cache reads", () => {
    const fixture = loadFixture("zai-coding-plan-glm-4.7");
    const ir = fixture.iterationResult;
    expect(ir.reasoningTokens).toBeGreaterThan(0);
    expect(ir.cacheReadTokens).toBeGreaterThan(0);
  });
});

describe("OpenCode real data: SSE event structure", () => {
  for (const slug of MODELS) {
    describe(slug, () => {
      const fixture = loadFixture(slug);

      it("has session.idle event", () => {
        const idle = fixture.sessionEvents.find(
          (e) => e.type === "session.idle",
        );
        expect(idle).toBeDefined();
        expect(idle!.properties).toHaveProperty("sessionID");
      });

      it("text parts have id, sessionID, and text fields", () => {
        for (const ev of fixture.sampleTextParts) {
          const part = ev.properties.part;
          expect(part.id).toBeTruthy();
          expect(part.sessionID).toBeTruthy();
          expect(part.type).toBe("text");
          expect(typeof part.text).toBe("string");
        }
      });

      it("tool parts have tool name and state with status", () => {
        for (const ev of fixture.sampleToolParts) {
          const part = ev.properties.part;
          expect(part.type).toBe("tool");
          expect(part.tool).toBeTruthy();
          expect(part.state).toBeDefined();
          expect(typeof part.state.status).toBe("string");
        }
      });
    });
  }
});

describe("OpenCode real data: text formatting edge cases", () => {
  it("all models produce non-empty resultText", () => {
    for (const slug of MODELS) {
      const fixture = loadFixture(slug);
      expect(fixture.iterationResult.resultText.length).toBeGreaterThan(0);
    }
  });

  it("resultText contains task-complete signal for all completed runs", () => {
    for (const slug of MODELS) {
      const fixture = loadFixture(slug);
      expect(fixture.iterationResult.resultText).toMatch(
        /<task-complete>/i,
      );
    }
  });
});
