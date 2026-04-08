/**
 * E2E integration tests for the OpenCode chat flow through ChatManager.
 *
 * Simulates the wizard → chat → PRD scenario:
 * 1. ChatManager.start() with agent="opencode" — creates session, sets up driver
 * 2. ChatManager.sendMessage() — sends initial user idea
 * 3. Agent responds with text, tools, and questions (AskUserQuestion)
 * 4. ChatManager.replyQuestion() — user answers
 * 5. Agent continues → generates PRD → session.idle
 * 6. ChatManager.stop() — teardown
 *
 * Also covers edge cases:
 * - Abort during pending question
 * - Session error mid-flow
 * - Concurrent chat and execution conflict (409)
 * - WS event broadcast verification for all chat event types
 * - Claude vs OpenCode behavioral parity through ChatManager
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ChatManager, ChatSessionActiveError, ChatNotReadyError, QuestionMismatchError } from "../server/chat-manager.js";
import type { ChatStartOptions } from "../server/chat-manager.js";
import type { SessionCore } from "../server/session/session-core.js";
import type { WsBroadcaster, WsEvent } from "../server/session/ws-broadcaster.js";
import type { ChatEvent, QuestionData } from "../core/drivers/types.js";

// ---------------------------------------------------------------------------
// Mock DriverRunner — wires into ChatManager's `new DriverRunner(...)` call
// ---------------------------------------------------------------------------

let mockStartChatIterable: AsyncIterable<ChatEvent>;
let mockSendMessage: ReturnType<typeof vi.fn>;
let mockReplyQuestion: ReturnType<typeof vi.fn>;
let mockAbortChat: ReturnType<typeof vi.fn>;

const driverRunnerSetup = vi.fn(async () => {});
const driverRunnerTeardown = vi.fn(async () => {});

vi.mock("../server/session/driver-runner.js", () => {
  return {
    DriverRunner: class MockDriverRunner {
      constructor(public agent: string, public model?: string) {}
      setup = driverRunnerSetup;
      teardown = driverRunnerTeardown;
      getDriver = () => ({
        startChat: () => mockStartChatIterable,
        sendMessage: mockSendMessage,
        replyQuestion: mockReplyQuestion,
        abortChat: mockAbortChat,
        runSession: vi.fn(),
      });
      setOnLog = vi.fn();
      runSession = vi.fn();
      get setupDone() { return true; }
      get userSettings() { return false; }
      listModels = vi.fn(async () => []);
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mockSessionCore(overrides: Partial<SessionCore> = {}): SessionCore {
  return {
    state: "idle",
    cwd: "/tmp",
    isIdle: () => true,
    isActive: () => false,
    isStopping: () => false,
    acquire: vi.fn(),
    release: vi.fn(),
    abort: vi.fn(),
    getAbortSignal: () => new AbortController().signal,
    registerAbortHandler: () => () => {},
    ...overrides,
  } as unknown as SessionCore;
}

function mockBroadcaster(): WsBroadcaster & { events: WsEvent[] } {
  const events: WsEvent[] = [];
  return {
    events,
    broadcast: vi.fn(),
    broadcastWithChannel: vi.fn((event: WsEvent) => { events.push(event); }),
    replay: vi.fn(),
    clearBuffer: vi.fn(),
  } as unknown as WsBroadcaster & { events: WsEvent[] };
}

/** Create a controllable async iterable that yields events on demand. */
function createEventStream(): {
  push: (event: ChatEvent) => void;
  close: () => void;
  iterable: AsyncIterable<ChatEvent>;
} {
  let resolve: ((value: IteratorResult<ChatEvent>) => void) | null = null;
  const queue: ChatEvent[] = [];
  let closed = false;

  const iterable: AsyncIterable<ChatEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<ChatEvent>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as unknown as ChatEvent, done: true });
          }
          return new Promise<IteratorResult<ChatEvent>>((r) => { resolve = r; });
        },
        return(): Promise<IteratorResult<ChatEvent>> {
          closed = true;
          if (resolve) resolve({ value: undefined as unknown as ChatEvent, done: true });
          return Promise.resolve({ value: undefined as unknown as ChatEvent, done: true });
        },
      };
    },
  };

  return {
    push(event: ChatEvent) {
      if (resolve) {
        const r = resolve;
        resolve = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    close() {
      closed = true;
      if (resolve) {
        resolve({ value: undefined as unknown as ChatEvent, done: true });
        resolve = null;
      }
    },
    iterable,
  };
}

const defaultStartOpts: ChatStartOptions = {
  agent: "opencode",
  model: "anthropic/claude-sonnet-4-6",
  variant: "default",
  systemPrompt: "You are an idea-to-PRD assistant.",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenCode chat E2E through ChatManager", () => {
  let stream: ReturnType<typeof createEventStream>;

  beforeEach(() => {
    vi.clearAllMocks();
    stream = createEventStream();
    mockStartChatIterable = stream.iterable;
    mockSendMessage = vi.fn();
    mockReplyQuestion = vi.fn();
    mockAbortChat = vi.fn();
  });

  afterEach(() => {
    stream.close();
  });

  // =========================================================================
  // 1. Full wizard → chat → PRD flow
  // =========================================================================

  describe("full wizard → chat → PRD flow", () => {
    it("completes the full discovery flow: start → message → questions → PRD → idle", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      // Step 1: Wizard starts a session (POST /api/chat/start)
      await cm.start(defaultStartOpts);
      expect(cm.getState()).toBe("active");
      expect(cm.getSession()?.agent).toBe("opencode");
      expect(cm.getSession()?.model).toBe("anthropic/claude-sonnet-4-6");

      // Verify chat:started was broadcast
      const startedEvent = bc.events.find((e) => (e as any).type === "chat:started");
      expect(startedEvent).toBeDefined();
      expect((startedEvent as any).agent).toBe("opencode");
      await tick();

      // Step 2: User sends initial idea (POST /api/chat/message)
      await cm.sendMessage("I want to build a task management app with real-time collaboration");
      expect(mockSendMessage).toHaveBeenCalledWith(
        "I want to build a task management app with real-time collaboration",
      );

      // Step 3: Agent responds with text
      stream.push({ type: "text", content: "Great idea! Let me explore your requirements." });
      await tick();

      const textEvent = bc.events.find((e) => (e as any).type === "agent:text");
      expect(textEvent).toBeDefined();
      expect((textEvent as any).text).toBe("Great idea! Let me explore your requirements.");

      // Step 4: Agent uses a tool
      stream.push({
        type: "tool",
        name: "WebSearch",
        input: { query: "real-time collaboration task management architecture" },
      });
      await tick();

      const toolEvent = bc.events.find((e) => (e as any).type === "agent:tool");
      expect(toolEvent).toBeDefined();
      expect((toolEvent as any).name).toBe("WebSearch");

      // Step 5: Tool result
      stream.push({
        type: "tool_result",
        name: "WebSearch",
        output: "Found relevant architecture patterns...",
      });
      await tick();

      const toolResultEvent = bc.events.find((e) => (e as any).type === "agent:tool_result");
      expect(toolResultEvent).toBeDefined();

      // Step 6: Agent asks a discovery question (AskUserQuestion)
      stream.push({
        type: "question",
        questionId: "oq-1234567890-1",
        questions: [
          {
            question: "What is the primary platform for your task management app?",
            header: "Platform",
            options: [
              { label: "Web only", description: "Browser-based SPA" },
              { label: "Web + Mobile", description: "Progressive web app with mobile apps" },
              { label: "Desktop + Web", description: "Electron app with web version" },
            ],
            multiSelect: false,
          },
        ],
        source: "opencode",
      });
      await tick();

      // Verify question state
      expect(cm.getState()).toBe("question_pending");
      expect(cm.getSession()?.pendingQuestionId).toBe("oq-1234567890-1");

      const questionEvent = bc.events.find((e) => (e as any).type === "chat:question");
      expect(questionEvent).toBeDefined();
      expect((questionEvent as any).questionId).toBe("oq-1234567890-1");
      expect((questionEvent as any).source).toBe("opencode");

      // Step 7: User answers the question (POST /api/chat/question/:id/reply)
      await cm.replyQuestion("oq-1234567890-1", {
        "What is the primary platform for your task management app?": "Web + Mobile",
      });
      expect(mockReplyQuestion).toHaveBeenCalledWith("oq-1234567890-1", {
        "What is the primary platform for your task management app?": "Web + Mobile",
      });

      // After reply, state transitions
      expect(cm.getState()).toBe("active");
      expect(cm.getSession()?.pendingQuestionId).toBeNull();

      // Step 8: Agent asks another multi-select question
      stream.push({
        type: "question",
        questionId: "oq-1234567891-2",
        questions: [
          {
            question: "Which features should be included in the MVP?",
            header: "Features",
            options: [
              { label: "Task CRUD", description: "Basic task creation, reading, updating, deletion" },
              { label: "Real-time sync", description: "Live updates across clients" },
              { label: "User auth", description: "Registration and login" },
              { label: "File attachments", description: "Upload files to tasks" },
            ],
            multiSelect: true,
          },
        ],
        source: "opencode",
      });
      await tick();

      expect(cm.getState()).toBe("question_pending");

      // User selects multiple features
      await cm.replyQuestion("oq-1234567891-2", {
        "Which features should be included in the MVP?": ["Task CRUD", "Real-time sync", "User auth"],
      });
      expect(cm.getState()).toBe("active");

      // Step 9: Agent generates PRD text
      stream.push({
        type: "text",
        content: "# Product Requirements Document\n\n## Task Management App with Real-time Collaboration\n\n...",
      });
      await tick();

      // Step 10: Context usage report
      stream.push({
        type: "context_usage",
        usage: {
          inputTokens: 5000,
          outputTokens: 3000,
          reasoningTokens: 1000,
          cacheReadTokens: 2000,
          cacheWriteTokens: 500,
          costUsd: 0.25,
        },
      });
      await tick();

      const usageEvent = bc.events.find((e) => (e as any).type === "agent:context_usage");
      expect(usageEvent).toBeDefined();

      // Step 11: Agent goes idle (PRD generation complete)
      stream.push({ type: "idle" });
      await tick();

      const idleEvent = bc.events.find((e) => (e as any).type === "chat:idle");
      expect(idleEvent).toBeDefined();
      expect(cm.getState()).toBe("active");
      expect(cm.getSession()?.awaitingUserInput).toBe(true);

      // Step 12: User stops the session
      await cm.stop();
      expect(cm.getState()).toBe("idle");
      expect(cm.getSession()).toBeNull();

      // Verify cleanup
      expect(mockAbortChat).toHaveBeenCalled();
      expect(driverRunnerTeardown).toHaveBeenCalled();
      expect(sc.release).toHaveBeenCalled();

      // Verify chat:finished was broadcast
      const finishedEvent = bc.events.find((e) => (e as any).type === "chat:finished");
      expect(finishedEvent).toBeDefined();
    });

    it("handles the PRD flow with variant parameter", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start({
        agent: "opencode",
        model: "anthropic/claude-opus-4-6",
        variant: "high",
        systemPrompt: "Generate a detailed PRD.",
      });

      expect(cm.getSession()?.variant).toBe("high");
      expect(cm.getSession()?.model).toBe("anthropic/claude-opus-4-6");

      stream.close();
      await tick();
    });
  });

  // =========================================================================
  // 2. Abort during pending question
  // =========================================================================

  describe("abort during pending question", () => {
    it("stop() during question_pending broadcasts chat:finished and cleans up", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      // Agent asks a question
      stream.push({
        type: "question",
        questionId: "oq-abort-1",
        questions: [
          {
            question: "Continue?",
            header: "Confirm",
            options: [{ label: "Yes", description: "Proceed" }],
            multiSelect: false,
          },
        ],
        source: "opencode",
      });
      await tick();

      expect(cm.getState()).toBe("question_pending");

      // User clicks Stop instead of answering
      await cm.stop();

      expect(cm.getState()).toBe("idle");
      expect(mockAbortChat).toHaveBeenCalled();
      expect(driverRunnerTeardown).toHaveBeenCalled();

      const finishedEvents = bc.events.filter((e) => (e as any).type === "chat:finished");
      expect(finishedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it("cannot reply to question after stop()", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      stream.push({
        type: "question",
        questionId: "oq-post-stop-1",
        questions: [
          {
            question: "Pick?",
            header: "Pick",
            options: [{ label: "A", description: "a" }],
            multiSelect: false,
          },
        ],
        source: "opencode",
      });
      await tick();

      await cm.stop();

      // Attempting to reply after stop should fail
      await expect(
        cm.replyQuestion("oq-post-stop-1", { "Pick?": "A" }),
      ).rejects.toThrow(ChatNotReadyError);
    });
  });

  // =========================================================================
  // 3. Session error mid-flow
  // =========================================================================

  describe("session error mid-flow", () => {
    it("broadcasts chat:error and chat:finished on session error", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      await cm.sendMessage("Start generating PRD");
      await tick();

      // Agent produces some text
      stream.push({ type: "text", content: "Analyzing requirements..." });
      await tick();

      // Session error occurs
      stream.push({
        type: "error",
        message: "Session error: context window exceeded",
      });
      await tick();
      await sleep(50); // Allow cleanup to propagate

      const errorEvent = bc.events.find((e) => (e as any).type === "chat:error");
      expect(errorEvent).toBeDefined();
      expect((errorEvent as any).message).toContain("context window exceeded");

      // chat:finished should follow (cleanup in consumeChatStream finally)
      const finishedEvent = bc.events.find((e) => (e as any).type === "chat:finished");
      expect(finishedEvent).toBeDefined();
    });
  });

  // =========================================================================
  // 4. Conflict with execution session
  // =========================================================================

  describe("session conflict handling", () => {
    it("throws ChatSessionActiveError when session is already active", async () => {
      const sc = mockSessionCore({ isIdle: () => false, state: "active" as any });
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await expect(cm.start(defaultStartOpts)).rejects.toThrow(ChatSessionActiveError);
    });

    it("can start a new session after previous session finishes", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      // First session
      await cm.start(defaultStartOpts);
      await tick();
      await cm.stop();

      // Reset mocks for second session
      vi.clearAllMocks();
      stream = createEventStream();
      mockStartChatIterable = stream.iterable;

      // Second session should work
      await cm.start(defaultStartOpts);
      expect(cm.getState()).toBe("active");

      stream.close();
      await tick();
    });
  });

  // =========================================================================
  // 5. WS broadcast verification for all event types
  // =========================================================================

  describe("WS broadcast events match expected format", () => {
    it("broadcasts all event types with channel='chat'", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      await cm.sendMessage("Test");

      // Emit all event types
      stream.push({ type: "text", content: "Hello" });
      stream.push({ type: "tool", name: "Read", input: { file_path: "/tmp/x.ts" } });
      stream.push({ type: "tool_result", name: "Read", output: "file contents" });
      stream.push({
        type: "context_usage",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.01,
        },
      });
      stream.push({
        type: "question",
        questionId: "oq-ws-1",
        questions: [{
          question: "Test?",
          header: "T",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
        source: "opencode",
      });
      await tick();

      await cm.replyQuestion("oq-ws-1", { "Test?": "A" });

      stream.push({ type: "idle" });
      await tick();

      // Verify all broadcast calls used broadcastWithChannel
      expect(bc.broadcastWithChannel).toHaveBeenCalled();

      // Verify all calls pass "chat" channel
      const calls = (bc.broadcastWithChannel as any).mock.calls;
      for (const call of calls) {
        expect(call[1]).toBe("chat");
      }

      // Verify event types present
      const types = bc.events.map((e: any) => e.type);
      expect(types).toContain("chat:started");
      expect(types).toContain("agent:text");
      expect(types).toContain("agent:tool");
      expect(types).toContain("agent:tool_result");
      expect(types).toContain("agent:context_usage");
      expect(types).toContain("chat:question");
      expect(types).toContain("chat:idle");

      stream.close();
      await tick();
    });
  });

  // =========================================================================
  // 6. OpenCode question ID format verification
  // =========================================================================

  describe("OpenCode question ID handling", () => {
    it("accepts OpenCode-format question IDs (oq-{timestamp}-{counter})", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      const openCodeQuestionId = `oq-${Date.now()}-1`;

      stream.push({
        type: "question",
        questionId: openCodeQuestionId,
        questions: [{
          question: "Choose?",
          header: "Choice",
          options: [{ label: "X", description: "x" }],
          multiSelect: false,
        }],
        source: "opencode",
      });
      await tick();

      expect(cm.getSession()?.pendingQuestionId).toBe(openCodeQuestionId);

      // Reply with matching ID
      await cm.replyQuestion(openCodeQuestionId, { "Choose?": "X" });
      expect(mockReplyQuestion).toHaveBeenCalledWith(openCodeQuestionId, { "Choose?": "X" });
      expect(cm.getState()).toBe("active");

      stream.close();
      await tick();
    });

    it("rejects mismatched question IDs", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      stream.push({
        type: "question",
        questionId: "oq-12345-1",
        questions: [{
          question: "Q?",
          header: "Q",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
        source: "opencode",
      });
      await tick();

      // Wrong ID should throw QuestionMismatchError
      await expect(
        cm.replyQuestion("oq-99999-99", { "Q?": "A" }),
      ).rejects.toThrow(QuestionMismatchError);

      stream.close();
      await tick();
    });
  });

  // =========================================================================
  // 7. State machine edge cases
  // =========================================================================

  describe("state machine edge cases", () => {
    it("cannot send message while question is pending", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      // Put chat in question_pending state
      stream.push({
        type: "question",
        questionId: "oq-state-1",
        questions: [{
          question: "Pick?",
          header: "P",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
        source: "opencode",
      });
      await tick();

      expect(cm.getState()).toBe("question_pending");

      // Sending message should fail
      await expect(cm.sendMessage("text")).rejects.toThrow(ChatNotReadyError);

      stream.close();
      await tick();
    });

    it("cannot send message before agent becomes idle", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      // First message works (awaitingUserInput is true after start)
      await cm.sendMessage("First message");

      // Second message should fail (awaitingUserInput is now false)
      await expect(cm.sendMessage("Second message")).rejects.toThrow(ChatNotReadyError);

      stream.close();
      await tick();
    });

    it("can send message after agent goes idle", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      await cm.sendMessage("First message");

      // Agent processes and goes idle
      stream.push({ type: "text", content: "Response" });
      stream.push({ type: "idle" });
      await tick();

      expect(cm.getSession()?.awaitingUserInput).toBe(true);

      // Second message should now work
      await cm.sendMessage("Follow-up message");
      expect(mockSendMessage).toHaveBeenCalledTimes(2);

      stream.close();
      await tick();
    });

    it("stop() is idempotent — safe to call multiple times", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();

      await cm.stop();
      expect(cm.getState()).toBe("idle");

      // Second stop should be a no-op
      await cm.stop();
      expect(cm.getState()).toBe("idle");

      // Third stop should also be a no-op
      await cm.stop();
      expect(cm.getState()).toBe("idle");
    });
  });

  // =========================================================================
  // 8. Multiple questions interleaved with text (PRD discovery flow)
  // =========================================================================

  describe("multi-question discovery flow", () => {
    it("handles alternating text and questions (typical PRD discovery)", async () => {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      await cm.start(defaultStartOpts);
      await tick();
      await cm.sendMessage("Build a social media analytics dashboard");

      // Round 1: Text → Question → Answer
      stream.push({ type: "text", content: "Let me understand your requirements." });
      stream.push({
        type: "question",
        questionId: "oq-disc-1",
        questions: [{
          question: "Target audience?",
          header: "Audience",
          options: [
            { label: "Small business", description: "SMB owners" },
            { label: "Enterprise", description: "Large corporations" },
          ],
          multiSelect: false,
        }],
        source: "opencode",
      });
      await tick();

      await cm.replyQuestion("oq-disc-1", { "Target audience?": "Enterprise" });

      // Round 2: Text → Question → Answer
      stream.push({ type: "text", content: "Great, enterprise focus. Next question:" });
      stream.push({
        type: "question",
        questionId: "oq-disc-2",
        questions: [{
          question: "Which social platforms to support?",
          header: "Platforms",
          options: [
            { label: "Twitter/X", description: "Twitter analytics" },
            { label: "LinkedIn", description: "LinkedIn analytics" },
            { label: "Instagram", description: "Instagram analytics" },
          ],
          multiSelect: true,
        }],
        source: "opencode",
      });
      await tick();

      await cm.replyQuestion("oq-disc-2", {
        "Which social platforms to support?": ["Twitter/X", "LinkedIn"],
      });

      // Round 3: Text → Question → Answer
      stream.push({ type: "text", content: "Twitter and LinkedIn. One more question:" });
      stream.push({
        type: "question",
        questionId: "oq-disc-3",
        questions: [{
          question: "Authentication method?",
          header: "Auth",
          options: [
            { label: "OAuth 2.0", description: "Standard OAuth" },
            { label: "SSO/SAML", description: "Enterprise SSO" },
          ],
          multiSelect: false,
        }],
        source: "opencode",
      });
      await tick();

      await cm.replyQuestion("oq-disc-3", { "Authentication method?": "SSO/SAML" });

      // Final: PRD generation → idle
      stream.push({
        type: "text",
        content: "# PRD: Social Media Analytics Dashboard\n\n## Overview\n...",
      });
      stream.push({ type: "idle" });
      await tick();

      // Verify all 3 question-answer cycles completed
      expect(mockReplyQuestion).toHaveBeenCalledTimes(3);

      // Verify broadcast events have correct sequence
      const questionEvents = bc.events.filter((e: any) => e.type === "chat:question");
      const idleEvents = bc.events.filter((e: any) => e.type === "chat:idle");
      expect(questionEvents).toHaveLength(3);
      expect(idleEvents).toHaveLength(1);

      // Verify question sources are all "opencode"
      for (const qe of questionEvents) {
        expect((qe as any).source).toBe("opencode");
      }

      stream.close();
      await tick();
    });
  });
});

// ---------------------------------------------------------------------------
// Claude vs OpenCode behavioral parity
// ---------------------------------------------------------------------------

describe("Claude vs OpenCode behavioral parity through ChatManager", () => {
  let stream: ReturnType<typeof createEventStream>;

  beforeEach(() => {
    vi.clearAllMocks();
    stream = createEventStream();
    mockStartChatIterable = stream.iterable;
    mockSendMessage = vi.fn();
    mockReplyQuestion = vi.fn();
    mockAbortChat = vi.fn();
  });

  afterEach(() => {
    stream.close();
  });

  it("ChatManager produces identical WS events regardless of agent type", async () => {
    // Test with opencode agent
    const scOpencode = mockSessionCore();
    const bcOpencode = mockBroadcaster();
    const cmOpencode = new ChatManager("/tmp/project", scOpencode, bcOpencode);

    await cmOpencode.start({ agent: "opencode", systemPrompt: "Test" });
    await tick();
    await cmOpencode.sendMessage("Hello");

    stream.push({ type: "text", content: "Response" });
    stream.push({
      type: "question",
      questionId: "oq-parity-1",
      questions: [{
        question: "Q?",
        header: "H",
        options: [{ label: "A", description: "a" }],
        multiSelect: false,
      }],
      source: "opencode",
    });
    await tick();

    await cmOpencode.replyQuestion("oq-parity-1", { "Q?": "A" });
    stream.push({ type: "idle" });
    await tick();

    // Stop OpenCode session to capture all events including chat:finished
    await cmOpencode.stop();
    await tick();

    // Now test with claude agent — reset stream
    stream = createEventStream();
    mockStartChatIterable = stream.iterable;
    mockSendMessage = vi.fn();
    mockReplyQuestion = vi.fn();
    mockAbortChat = vi.fn();

    const scClaude = mockSessionCore();
    const bcClaude = mockBroadcaster();
    const cmClaude = new ChatManager("/tmp/project", scClaude, bcClaude);

    await cmClaude.start({ agent: "claude", systemPrompt: "Test" });
    await tick();
    await cmClaude.sendMessage("Hello");

    stream.push({ type: "text", content: "Response" });
    stream.push({
      type: "question",
      questionId: "q-uuid-123",
      questions: [{
        question: "Q?",
        header: "H",
        options: [{ label: "A", description: "a" }],
        multiSelect: false,
      }],
      source: "claude",
    });
    await tick();

    await cmClaude.replyQuestion("q-uuid-123", { "Q?": "A" });
    stream.push({ type: "idle" });
    await tick();

    // Stop Claude session to capture all events including chat:finished
    await cmClaude.stop();
    await tick();

    // Compare WS event types — both should produce identical sets
    const opencodeTypes = bcOpencode.events.map((e: any) => e.type).sort();
    const claudeTypes = bcClaude.events.map((e: any) => e.type).sort();
    expect(opencodeTypes).toEqual(claudeTypes);

    // Both should have same event type set
    expect(opencodeTypes).toContain("chat:started");
    expect(opencodeTypes).toContain("agent:text");
    expect(opencodeTypes).toContain("chat:question");
    expect(opencodeTypes).toContain("chat:idle");
    expect(opencodeTypes).toContain("chat:finished");

    // Verify the question event source differs (as expected)
    const ocQuestion = bcOpencode.events.find((e: any) => e.type === "chat:question");
    const clQuestion = bcClaude.events.find((e: any) => e.type === "chat:question");
    expect((ocQuestion as any).source).toBe("opencode");
    expect((clQuestion as any).source).toBe("claude");

    // But the question structure is identical
    expect((ocQuestion as any).questions).toEqual((clQuestion as any).questions);

    stream.close();
    await tick();
  });

  it("both agents follow the same state machine transitions", async () => {
    for (const agent of ["opencode", "claude"] as const) {
      const sc = mockSessionCore();
      const bc = mockBroadcaster();
      const cm = new ChatManager("/tmp/project", sc, bc);

      // Reset stream for each agent
      stream.close();
      stream = createEventStream();
      mockStartChatIterable = stream.iterable;
      mockSendMessage = vi.fn();
      mockReplyQuestion = vi.fn();
      mockAbortChat = vi.fn();

      // Idle → Active
      expect(cm.getState()).toBe("idle");
      await cm.start({ agent, systemPrompt: "Test" });
      expect(cm.getState()).toBe("active");
      await tick();

      // Active → (send message) → Active (awaiting=false)
      await cm.sendMessage("Hi");
      expect(cm.getSession()?.awaitingUserInput).toBe(false);

      // Active → question_pending
      stream.push({
        type: "question",
        questionId: `${agent}-q1`,
        questions: [{
          question: "Q?",
          header: "H",
          options: [{ label: "A", description: "a" }],
          multiSelect: false,
        }],
        source: agent,
      });
      await tick();
      expect(cm.getState()).toBe("question_pending");

      // question_pending → Active (via reply)
      await cm.replyQuestion(`${agent}-q1`, { "Q?": "A" });
      expect(cm.getState()).toBe("active");

      // Active → Active (idle event, awaitingUserInput=true)
      stream.push({ type: "idle" });
      await tick();
      expect(cm.getState()).toBe("active");
      expect(cm.getSession()?.awaitingUserInput).toBe(true);

      // Stop → Idle
      await cm.stop();
      expect(cm.getState()).toBe("idle");
    }
  });
});
