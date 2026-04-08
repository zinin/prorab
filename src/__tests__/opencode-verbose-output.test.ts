import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Verbosity } from "../types.js";

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dirname!, "fixtures");
const fixture = JSON.parse(
  readFileSync(join(FIXTURES_DIR, "opencode-minimax-MiniMax-M2.5.json"), "utf8"),
);

const TEST_SESSION_ID = "test-session";
// Extract session ID from fixture to avoid hardcoding (fragile if fixture is regenerated)
const ORIGINAL_SESSION_ID: string =
  fixture.sampleTextParts[0].properties.part.sessionID;

/** Deep-replace all occurrences of the fixture sessionID with our test ID. */
function patchSessionId(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj === ORIGINAL_SESSION_ID ? TEST_SESSION_ID : obj;
  }
  if (Array.isArray(obj)) return obj.map(patchSessionId);
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = patchSessionId(v);
    }
    return result;
  }
  return obj;
}

// Freeze time relative to fixture's tool time.start for deterministic [running] logs
const FAKE_NOW = 1771972131000; // ~5.2s after fixture tool start (1771972125816)

/**
 * Build the mock event array from fixture data + synthetic events.
 * Order: text parts → synthetic delta → tool parts → synthetic tool error →
 *        synthetic retry → step-finish → session.idle
 * All sessionIDs patched to TEST_SESSION_ID.
 */
function buildMockEvents(): unknown[] {
  const events: unknown[] = [];

  // 1. Text parts
  for (const ev of fixture.sampleTextParts) {
    events.push(patchSessionId(ev));
  }

  // 2. Synthetic text part + delta event (v2 sends deltas as separate message.part.delta events)
  events.push({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_synthetic_delta",
        sessionID: TEST_SESSION_ID,
        messageID: "msg_synthetic",
        type: "text",
        text: "streaming chunk",
      },
    },
  });
  events.push({
    type: "message.part.delta",
    properties: {
      sessionID: TEST_SESSION_ID,
      messageID: "msg_synthetic",
      partID: "prt_synthetic_delta",
      field: "text",
      delta: "streaming chunk",
    },
  });

  // 3. Tool parts (pending → running → completed lifecycle)
  for (const ev of fixture.sampleToolParts) {
    events.push(patchSessionId(ev));
  }

  // 4. Synthetic tool error event
  events.push({
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_synthetic_tool_error",
        sessionID: TEST_SESSION_ID,
        messageID: "msg_synthetic",
        type: "tool",
        callID: "call_synthetic_error",
        tool: "bash",
        state: {
          status: "error",
          input: { command: "exit 1" },
          error: "Command failed with exit code 1",
        },
      },
    },
  });

  // 5. Synthetic session.status retry event
  events.push({
    type: "session.status",
    properties: {
      sessionID: TEST_SESSION_ID,
      status: {
        type: "retry",
        attempt: 1,
        message: "rate limited",
        next: 5,
      },
    },
  });

  // 6. Step-finish events
  for (const ev of fixture.stepFinishEvents) {
    events.push(patchSessionId(ev));
  }

  // 7. Session events (status busy... → idle) — session.idle MUST be last (terminates for-await loop)
  for (const ev of fixture.sessionEvents) {
    events.push(patchSessionId(ev));
  }

  return events;
}

// ---------------------------------------------------------------------------
// SDK mock
// ---------------------------------------------------------------------------

function createMockClient() {
  const events = buildMockEvents();

  return {
    event: {
      subscribe: vi.fn(async () => ({
        stream: (async function* () {
          for (const ev of events) yield ev;
        })(),
      })),
    },
    session: {
      create: vi.fn(async () => ({
        data: { id: TEST_SESSION_ID },
      })),
      promptAsync: vi.fn(async () => ({})),
      messages: vi.fn(async () => ({
        data: patchSessionId(fixture.assistantMessages),
      })),
      delete: vi.fn(async () => ({})),
      abort: vi.fn(async () => ({})),
    },
    config: {
      providers: vi.fn(async () => ({
        data: {
          providers: [{
            id: "minimax",
            models: {
              "MiniMax-M2.5": {
                limit: { context: 1_000_000, output: 16_384 },
              },
            },
          }],
          default: { minimax: "MiniMax-M2.5" },
        },
      })),
    },
  };
}

let mockClient: ReturnType<typeof createMockClient>;

vi.mock("@opencode-ai/sdk/v2", () => ({
  createOpencodeClient: vi.fn(() => mockClient),
}));

vi.mock("node:child_process", async () => {
  const { EventEmitter } = await import("node:events");
  const { Readable } = await import("node:stream");
  return {
    spawn: vi.fn((): any => {
      const proc: any = new EventEmitter();
      proc.pid = 12345;
      proc.exitCode = null;
      proc.signalCode = null;
      proc.kill = vi.fn();
      proc.stdout = new Readable({ read() {} });
      proc.stderr = new Readable({ read() {} });
      // Emit ready line on next tick (setup resolves)
      process.nextTick(() => {
        proc.stdout.push("opencode server listening on http://localhost:9999\n");
        // Set exitCode so teardown() resolves immediately under fake timers
        process.nextTick(() => { proc.exitCode = 0; });
      });
      return proc;
    }),
  };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Import AFTER mock is registered
const { OpenCodeDriver } = await import("../core/drivers/opencode.js");

describe("OpenCode console output", () => {
  let logs: string[];
  let stdoutWrites: string[];

  beforeEach(() => {
    logs = [];
    stdoutWrites = [];
    mockClient = createMockClient();
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);
    vi.spyOn(process, "kill").mockImplementation((() => true) as any);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation((data: string | Uint8Array) => {
      stdoutWrites.push(String(data));
      return true;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function runWithVerbosity(verbosity: Verbosity) {
    const driver = new OpenCodeDriver("minimax/MiniMax-M2.5");
    await driver.setup({ verbosity });
    // Clear setup logs (dynamic port numbers not in test scope)
    logs = [];
    stdoutWrites = [];
    const result = await driver.runSession({
      prompt: "test prompt",
      systemPrompt: "test system",
      cwd: "/tmp/test",
      maxTurns: 10,
      verbosity,
      unitId: "test",
    });
    await driver.teardown();
    return { result, logs: [...logs], stdoutWrites: [...stdoutWrites] };
  }

  it("debug: console.log output matches snapshot", async () => {
    const { logs, result } = await runWithVerbosity("debug");
    expect(logs).toMatchSnapshot();
    // SSE text parts don't contain <task-complete> tag; signal from full messages
    // is not used because sseText takes priority (opencode.ts:~291)
    expect(result.signal.type).toBe("none");
    expect(result.numTurns).toBeGreaterThan(0);
  });

  it("debug: stdout streaming output matches snapshot", async () => {
    const { stdoutWrites } = await runWithVerbosity("debug");
    expect(stdoutWrites).toMatchSnapshot();
  });

  it("info: console.log output matches snapshot", async () => {
    const { logs, result } = await runWithVerbosity("info");
    expect(logs).toMatchSnapshot();
    expect(result.model).toContain("MiniMax");
  });

  it("info: no stdout streaming", async () => {
    const { stdoutWrites } = await runWithVerbosity("info");
    expect(stdoutWrites).toEqual([]);
  });

  it("quiet: no console.log output", async () => {
    const { logs } = await runWithVerbosity("quiet");
    expect(logs).toEqual([]);
  });

  it("quiet: no stdout streaming", async () => {
    const { stdoutWrites } = await runWithVerbosity("quiet");
    expect(stdoutWrites).toEqual([]);
  });
});
