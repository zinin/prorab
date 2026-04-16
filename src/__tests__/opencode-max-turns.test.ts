/**
 * OpenCodeDriver — maxTurns enforcement.
 *
 * Verifies that `runSession()` aborts the OpenCode session when the configured
 * `maxTurns` ceiling is reached, suppresses post-abort SSE events, and returns
 * an `IterationResult` with `signal: { type: "none" }` plus a "Max turns
 * exceeded (N)" marker prepended to `resultText` while preserving accumulated
 * metrics (tokens, cost, numTurns).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenCodeDriver } from "../core/drivers/opencode.js";
import type { SessionOptions } from "../core/drivers/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface MockClient {
  event: { subscribe: ReturnType<typeof vi.fn> };
  session: {
    create: ReturnType<typeof vi.fn>;
    promptAsync: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    messages: ReturnType<typeof vi.fn>;
  };
  config: {
    providers: ReturnType<typeof vi.fn>;
  };
  _abortSpy: ReturnType<typeof vi.fn>;
}

function makeMockClient(streamFactory: () => AsyncIterable<unknown>): MockClient {
  const abortSpy = vi.fn().mockResolvedValue({});
  return {
    event: {
      subscribe: vi.fn().mockResolvedValue({ stream: streamFactory() }),
    },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "s1" } }),
      promptAsync: vi.fn().mockResolvedValue({}),
      abort: abortSpy,
      delete: vi.fn().mockResolvedValue({}),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
    config: {
      providers: vi.fn().mockResolvedValue({
        data: { providers: [], default: {} },
      }),
    },
    _abortSpy: abortSpy,
  };
}

async function* sseFromArray(events: unknown[]): AsyncIterable<unknown> {
  for (const e of events) {
    yield e;
  }
}

function stepFinish(): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-finish",
        sessionID: "s1",
        messageID: "m1",
        id: `sf-${Math.random()}`,
        reason: "stop",
        cost: 0.001,
        tokens: {
          input: 100,
          output: 10,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    },
  };
}

function idle(): Record<string, unknown> {
  return { type: "session.idle", properties: { sessionID: "s1" } };
}

/**
 * OpenCode server emits session.error synthetically in some versions after a
 * client-initiated session.abort(). The breach branch in runSession must
 * short-circuit BEFORE handleSessionError sets ctx.errorResult, otherwise we
 * return signal:error instead of the fail-soft signal:none.
 */
function sessionError(message = "aborted"): Record<string, unknown> {
  return {
    type: "session.error",
    properties: { sessionID: "s1", error: { message } },
  };
}

const baseOpts: SessionOptions = {
  prompt: "test",
  systemPrompt: "sys",
  cwd: "/tmp",
  maxTurns: 0,
  verbosity: "quiet",
  unitId: "u1",
};

// Silence the console.error("!!! Max turns exceeded ...") line that the driver
// emits on breach — it's expected output but pollutes the test report.
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenCodeDriver — maxTurns enforcement", () => {
  it("completes normally when step count is below maxTurns", async () => {
    const driver = new OpenCodeDriver();
    const client = makeMockClient(() =>
      sseFromArray([stepFinish(), stepFinish(), idle()]),
    );
    (driver as unknown as { client: MockClient }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 10 });

    expect(client._abortSpy).not.toHaveBeenCalled();
    expect(result.signal.type).not.toBe("error");
    expect(result.numTurns).toBe(2);
  });

  it("aborts and returns signal:none when maxTurns reached", async () => {
    const driver = new OpenCodeDriver();
    const client = makeMockClient(() =>
      sseFromArray([stepFinish(), stepFinish(), stepFinish(), idle()]),
    );
    (driver as unknown as { client: MockClient }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 2 });

    expect(client._abortSpy).toHaveBeenCalledTimes(1);
    expect(client._abortSpy).toHaveBeenCalledWith({ sessionID: "s1" });
    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(2\)/);
    expect(result.numTurns).toBeGreaterThanOrEqual(2);
    // Metrics preserved (NOT zeroed by errorResult)
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("ignores post-abort events (no double abort, no counter drift)", async () => {
    const driver = new OpenCodeDriver();
    const client = makeMockClient(() =>
      sseFromArray([
        stepFinish(),
        stepFinish(),
        // These four arrive AFTER abort and must be ignored:
        stepFinish(),
        stepFinish(),
        stepFinish(),
        idle(),
      ]),
    );
    (driver as unknown as { client: MockClient }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 2 });

    expect(client._abortSpy).toHaveBeenCalledTimes(1);
    expect(result.numTurns).toBe(2);
  });

  it("breach wins race over session.error emitted after our abort", async () => {
    const driver = new OpenCodeDriver();
    // After the 2nd step-finish the driver calls session.abort(). The mocked
    // server then emits session.error BEFORE session.idle — this is what real
    // OpenCode servers do in some versions. Without the maxTurnsExceeded
    // guard in runSession, ctx.errorResult would win and we'd return
    // signal:error instead of signal:none.
    const client = makeMockClient(() =>
      sseFromArray([stepFinish(), stepFinish(), sessionError(), idle()]),
    );
    (driver as unknown as { client: MockClient }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 2 });

    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(2\)/);
    expect(result.numTurns).toBe(2);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it("treats maxTurns === 0 as unlimited", async () => {
    const driver = new OpenCodeDriver();
    const client = makeMockClient(() =>
      sseFromArray([stepFinish(), stepFinish(), stepFinish(), idle()]),
    );
    (driver as unknown as { client: MockClient }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 0 });

    expect(client._abortSpy).not.toHaveBeenCalled();
    expect(result.signal.type).not.toBe("error");
    expect(result.numTurns).toBe(3);
  });
});
