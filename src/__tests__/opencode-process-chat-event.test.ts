/**
 * Direct unit tests for OpenCodeDriver.processChatEvent().
 *
 * Tests the private method directly (via type cast) to verify SSE → ChatEvent
 * translation in isolation, without the full startChat() async generator setup.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { OpenCodeDriver } from "../core/drivers/opencode.js";
import type { ChatEvent } from "../core/drivers/types.js";

// ---------------------------------------------------------------------------
// Type cast for accessing private fields and methods
// ---------------------------------------------------------------------------

type DriverInternals = {
  chatSessionId: string | null;
  pendingQuestions: Map<string, { requestID: string }>;
  chatReportedTools: Set<string>;
  questionIdCounter: number;
  processChatEvent(event: unknown): ChatEvent[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createDriver(sessionId = "sess-1"): DriverInternals {
  const driver = new OpenCodeDriver("anthropic/claude-sonnet-4-6");
  const internals = driver as unknown as DriverInternals;
  internals.chatSessionId = sessionId;
  return internals;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenCodeDriver.processChatEvent()", () => {
  let driver: ReturnType<typeof createDriver>;

  beforeEach(() => {
    driver = createDriver("sess-1");
  });

  // ---- question.asked ----

  describe("question.asked", () => {
    it("creates ChatEvent question and stores requestID in pendingQuestions", () => {
      const events = driver.processChatEvent({
        type: "question.asked",
        properties: {
          id: "req-42",
          sessionID: "sess-1",
          questions: [
            {
              question: "Which framework?",
              header: "Framework",
              options: [
                { label: "React", description: "React.js library" },
                { label: "Vue", description: "Vue.js framework" },
              ],
              multiple: false,
            },
          ],
        },
      });

      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev.type).toBe("question");
      if (ev.type === "question") {
        expect(ev.questionId).toMatch(/^oq-\d+-1$/);
        expect(ev.source).toBe("opencode");
        expect(ev.questions).toHaveLength(1);
        expect(ev.questions[0]).toEqual({
          question: "Which framework?",
          header: "Framework",
          options: [
            { label: "React", description: "React.js library" },
            { label: "Vue", description: "Vue.js framework" },
          ],
          multiSelect: false,
        });

        // Verify requestID stored in pendingQuestions
        const pending = driver.pendingQuestions.get(ev.questionId);
        expect(pending).toBeDefined();
        expect(pending!.requestID).toBe("req-42");
      }
    });

    it("maps multiple=true to multiSelect=true", () => {
      const events = driver.processChatEvent({
        type: "question.asked",
        properties: {
          id: "req-multi",
          sessionID: "sess-1",
          questions: [
            {
              question: "Select features",
              header: "Features",
              options: [{ label: "Auth", description: "auth" }],
              multiple: true,
            },
          ],
        },
      });

      expect(events).toHaveLength(1);
      if (events[0].type === "question") {
        expect(events[0].questions[0].multiSelect).toBe(true);
      }
    });

    it("defaults multiSelect to false when multiple is undefined", () => {
      const events = driver.processChatEvent({
        type: "question.asked",
        properties: {
          id: "req-default",
          sessionID: "sess-1",
          questions: [
            {
              question: "Pick one",
              header: "Choice",
              options: [{ label: "A", description: "option A" }],
            },
          ],
        },
      });

      expect(events).toHaveLength(1);
      if (events[0].type === "question") {
        expect(events[0].questions[0].multiSelect).toBe(false);
      }
    });

    it("handles multiple questions in a single event", () => {
      const events = driver.processChatEvent({
        type: "question.asked",
        properties: {
          id: "req-multi-q",
          sessionID: "sess-1",
          questions: [
            {
              question: "Q1?",
              header: "H1",
              options: [{ label: "A", description: "a" }],
            },
            {
              question: "Q2?",
              header: "H2",
              options: [{ label: "B", description: "b" }],
              multiple: true,
            },
          ],
        },
      });

      expect(events).toHaveLength(1);
      if (events[0].type === "question") {
        expect(events[0].questions).toHaveLength(2);
        expect(events[0].questions[0].question).toBe("Q1?");
        expect(events[0].questions[1].question).toBe("Q2?");
        expect(events[0].questions[1].multiSelect).toBe(true);
      }
    });

    it("generates incrementing question IDs", () => {
      const ev1 = driver.processChatEvent({
        type: "question.asked",
        properties: {
          id: "req-1",
          sessionID: "sess-1",
          questions: [{ question: "Q1", header: "H", options: [] }],
        },
      });
      const ev2 = driver.processChatEvent({
        type: "question.asked",
        properties: {
          id: "req-2",
          sessionID: "sess-1",
          questions: [{ question: "Q2", header: "H", options: [] }],
        },
      });

      if (ev1[0].type === "question" && ev2[0].type === "question") {
        expect(ev1[0].questionId).toMatch(/^oq-\d+-1$/);
        expect(ev2[0].questionId).toMatch(/^oq-\d+-2$/);
        expect(ev1[0].questionId).not.toBe(ev2[0].questionId);
      }
    });

    it("ignores question.asked for a different session", () => {
      const events = driver.processChatEvent({
        type: "question.asked",
        properties: {
          id: "req-other",
          sessionID: "other-session",
          questions: [
            { question: "Not for us", header: "X", options: [] },
          ],
        },
      });

      expect(events).toHaveLength(0);
      expect(driver.pendingQuestions.size).toBe(0);
    });
  });

  // ---- session.idle ----

  describe("session.idle", () => {
    it("creates ChatEvent idle for our session", () => {
      const events = driver.processChatEvent({
        type: "session.idle",
        properties: { sessionID: "sess-1" },
      });

      expect(events).toEqual([{ type: "idle" }]);
    });

    it("ignores session.idle for a different session", () => {
      const events = driver.processChatEvent({
        type: "session.idle",
        properties: { sessionID: "other-session" },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ---- session.error ----

  describe("session.error", () => {
    it("creates ChatEvent error for our session", () => {
      const events = driver.processChatEvent({
        type: "session.error",
        properties: {
          sessionID: "sess-1",
          error: { message: "rate limit exceeded" },
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: "error",
        message: 'Session error: {"message":"rate limit exceeded"}',
      });
    });

    it("creates ChatEvent error when sessionID is missing (assumes ours)", () => {
      const events = driver.processChatEvent({
        type: "session.error",
        properties: { error: "global failure" },
      });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("error");
    });

    it("uses 'unknown session error' when error is not provided", () => {
      const events = driver.processChatEvent({
        type: "session.error",
        properties: { sessionID: "sess-1" },
      });

      expect(events).toHaveLength(1);
      if (events[0].type === "error") {
        expect(events[0].message).toContain("unknown session error");
      }
    });

    it("ignores session.error for a different session", () => {
      const events = driver.processChatEvent({
        type: "session.error",
        properties: {
          sessionID: "other-session",
          error: "not ours",
        },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ---- message.part.updated (text) ----

  describe("message.part.updated (text)", () => {
    it("creates ChatEvent text from text part", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "sess-1",
            id: "text-1",
            text: "Hello, world!",
          },
        },
      });

      expect(events).toEqual([{ type: "text", content: "Hello, world!" }]);
    });

    it("skips empty text parts", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "sess-1",
            id: "text-1",
            text: "",
          },
        },
      });

      expect(events).toHaveLength(0);
    });

    it("skips text parts without text property", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "sess-1",
            id: "text-1",
          },
        },
      });

      expect(events).toHaveLength(0);
    });

    it("ignores text part from a different session", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "other-session",
            id: "text-1",
            text: "not for us",
          },
        },
      });

      expect(events).toHaveLength(0);
    });

    it("deduplicates text already streamed via deltas", () => {
      // First, send deltas for "Hello "
      driver.processChatEvent({
        type: "message.part.delta",
        properties: { sessionID: "sess-1", partID: "txt-dedup", field: "text", delta: "Hello " },
      });

      // Then message.part.updated with full text — only the new portion should emit
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "txt-dedup", text: "Hello world!" },
        },
      });

      expect(events).toEqual([{ type: "text", content: "world!" }]);
    });

    it("emits nothing when updated text matches delta length exactly", () => {
      driver.processChatEvent({
        type: "message.part.delta",
        properties: { sessionID: "sess-1", partID: "txt-exact", field: "text", delta: "done" },
      });

      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "txt-exact", text: "done" },
        },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ---- message.part.updated (tool) ----

  describe("message.part.updated (tool)", () => {
    it("creates ChatEvent tool when tool starts running with input", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-1",
            tool: "Read",
            state: {
              status: "running",
              input: { file_path: "/tmp/test.ts" },
            },
          },
        },
      });

      expect(events).toEqual([
        { type: "tool", name: "Read", input: { file_path: "/tmp/test.ts" } },
      ]);
    });

    it("creates both tool and tool_result when tool completes with input and output", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-1",
            tool: "Bash",
            state: {
              status: "completed",
              input: { command: "ls" },
              output: "file1.ts\nfile2.ts",
            },
          },
        },
      });

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: "tool",
        name: "Bash",
        input: { command: "ls" },
      });
      expect(events[1]).toEqual({
        type: "tool_result",
        name: "Bash",
        output: "file1.ts\nfile2.ts",
      });
    });

    it("deduplicates tool dispatch events for the same part ID", () => {
      // First call: running → yields tool event
      const events1 = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-1",
            tool: "Read",
            state: {
              status: "running",
              input: { file_path: "/tmp/test.ts" },
            },
          },
        },
      });
      expect(events1).toHaveLength(1);
      expect(events1[0].type).toBe("tool");

      // Second call: same part, still running → no tool event (dedup)
      const events2 = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-1",
            tool: "Read",
            state: {
              status: "running",
              input: { file_path: "/tmp/test.ts" },
            },
          },
        },
      });
      expect(events2).toHaveLength(0);

      // Third call: completed → yields only tool_result (dispatch already reported)
      const events3 = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-1",
            tool: "Read",
            state: {
              status: "completed",
              input: { file_path: "/tmp/test.ts" },
              output: "file contents",
            },
          },
        },
      });
      expect(events3).toHaveLength(1);
      expect(events3[0]).toEqual({
        type: "tool_result",
        name: "Read",
        output: "file contents",
      });
    });

    it("creates tool_result with ERROR prefix for tool errors", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-err",
            tool: "Bash",
            state: {
              status: "error",
              error: "command not found",
            },
          },
        },
      });

      expect(events).toEqual([
        {
          type: "tool_result",
          name: "Bash",
          output: "ERROR: command not found",
        },
      ]);
    });

    it("uses 'unknown' as tool name when tool field is missing", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-no-name",
            state: {
              status: "running",
              input: { key: "value" },
            },
          },
        },
      });

      expect(events).toHaveLength(1);
      if (events[0].type === "tool") {
        expect(events[0].name).toBe("unknown");
      }
    });

    it("skips tool events without state", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-no-state",
            tool: "Read",
          },
        },
      });

      expect(events).toHaveLength(0);
    });

    it("skips tool dispatch when input is empty object", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "sess-1",
            id: "tool-empty-input",
            tool: "Read",
            state: {
              status: "running",
              input: {},
            },
          },
        },
      });

      expect(events).toHaveLength(0);
    });

    it("ignores tool parts from a different session", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "other-session",
            id: "tool-other",
            tool: "Read",
            state: {
              status: "running",
              input: { file_path: "/tmp/test.ts" },
            },
          },
        },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ---- message.part.updated (step-finish) → context_usage ----

  describe("message.part.updated (step-finish)", () => {
    it("creates context_usage event from step-finish with tokens", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "step-finish",
            sessionID: "sess-1",
            id: "sf-1",
            reason: "end_turn",
            tokens: {
              input: 1000,
              output: 500,
              reasoning: 200,
              cache: { read: 300, write: 100 },
            },
            cost: 0.05,
          },
        },
      });

      expect(events).toEqual([
        {
          type: "context_usage",
          usage: {
            contextTokens: 1400,
            contextWindow: 200_000,
            model: "anthropic/claude-sonnet-4-6",
          },
        },
      ]);
    });

    it("normalizes context_usage from step-finish without cache tokens", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "step-finish",
            sessionID: "sess-1",
            id: "sf-2",
            reason: "end_turn",
            tokens: {
              input: 500,
              output: 200,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
      });

      expect(events).toHaveLength(1);
      if (events[0].type === "context_usage") {
        expect(events[0].usage).toMatchObject({
          contextTokens: 500,
          contextWindow: 200_000,
          model: "anthropic/claude-sonnet-4-6",
        });
      }
    });

    it("skips step-finish without tokens", () => {
      const events = driver.processChatEvent({
        type: "message.part.updated",
        properties: {
          part: {
            type: "step-finish",
            sessionID: "sess-1",
            id: "sf-3",
            reason: "end_turn",
          },
        },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ---- message.part.delta ----

  describe("message.part.delta", () => {
    it("creates ChatEvent text from text field delta", () => {
      const events = driver.processChatEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "sess-1",
          messageID: "msg-1",
          partID: "part-1",
          field: "text",
          delta: "Hello ",
        },
      });

      expect(events).toEqual([{ type: "text", content: "Hello " }]);
    });

    it("skips non-text field deltas", () => {
      const events = driver.processChatEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "sess-1",
          messageID: "msg-1",
          partID: "part-1",
          field: "tool_input",
          delta: '{"key": "value"}',
        },
      });

      expect(events).toHaveLength(0);
    });

    it("skips empty deltas", () => {
      const events = driver.processChatEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "sess-1",
          messageID: "msg-1",
          partID: "part-1",
          field: "text",
          delta: "",
        },
      });

      expect(events).toHaveLength(0);
    });

    it("ignores deltas from a different session", () => {
      const events = driver.processChatEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "other-session",
          messageID: "msg-1",
          partID: "part-1",
          field: "text",
          delta: "not for us",
        },
      });

      expect(events).toHaveLength(0);
    });
  });

  // ---- Unknown events ----

  describe("unknown event types", () => {
    it("returns empty array for unknown event types", () => {
      const events = driver.processChatEvent({
        type: "installation.updated",
        properties: { version: "2.0.0" },
      });

      expect(events).toHaveLength(0);
    });

    it("returns empty array for completely unrecognized events", () => {
      const events = driver.processChatEvent({
        type: "custom.event",
        properties: {},
      });

      expect(events).toHaveLength(0);
    });
  });

  // ---- Session filtering ----

  describe("session filtering", () => {
    it("filters all event types by chatSessionId", () => {
      const otherSessionId = "other-session-999";

      // Each event type with wrong session → should all be empty
      const results = [
        driver.processChatEvent({
          type: "question.asked",
          properties: {
            id: "r1",
            sessionID: otherSessionId,
            questions: [{ question: "Q", header: "H", options: [] }],
          },
        }),
        driver.processChatEvent({
          type: "session.idle",
          properties: { sessionID: otherSessionId },
        }),
        driver.processChatEvent({
          type: "message.part.updated",
          properties: {
            part: { type: "text", sessionID: otherSessionId, id: "p1", text: "hi" },
          },
        }),
        driver.processChatEvent({
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              sessionID: otherSessionId,
              id: "t1",
              tool: "Read",
              state: { status: "running", input: { x: 1 } },
            },
          },
        }),
        driver.processChatEvent({
          type: "message.part.delta",
          properties: {
            sessionID: otherSessionId,
            field: "text",
            delta: "hello",
          },
        }),
      ];

      for (const events of results) {
        expect(events).toHaveLength(0);
      }
    });
  });
});
