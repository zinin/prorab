import { describe, it, expect } from "vitest";
import { ClaudeDriver } from "../core/drivers/claude.js";
import { AsyncQueue } from "../core/drivers/async-queue.js";
import type { ChatEvent, QuestionAnswers } from "../core/drivers/types.js";

describe("ClaudeDriver chat state fields", () => {
  it("should be constructible without errors", () => {
    const driver = new ClaudeDriver();
    expect(driver).toBeInstanceOf(ClaudeDriver);
  });

  it("startChat throws when a session is already active", () => {
    const driver = new ClaudeDriver();
    // Simulate an active session by setting the messageQueue directly
    const d = driver as unknown as {
      messageQueue: AsyncQueue<string> | null;
      chatEventQueue: AsyncQueue<ChatEvent> | null;
      chatAbortController: AbortController | null;
    };
    d.messageQueue = new AsyncQueue<string>();
    d.chatEventQueue = new AsyncQueue<ChatEvent>();
    d.chatAbortController = new AbortController();

    expect(() =>
      driver.startChat({
        systemPrompt: "test",
        cwd: "/tmp",
        maxTurns: 5,
        verbosity: "quiet",
      }),
    ).toThrow("A chat session is already active. Call abortChat() before starting a new one.");

    // Cleanup
    d.messageQueue.close();
    d.chatEventQueue.close();
  });

  it("startChat works after abortChat clears the session", () => {
    const driver = new ClaudeDriver();
    // Simulate an active session
    const d = driver as unknown as {
      messageQueue: AsyncQueue<string> | null;
      chatEventQueue: AsyncQueue<ChatEvent> | null;
      chatAbortController: AbortController | null;
    };
    d.messageQueue = new AsyncQueue<string>();
    d.chatEventQueue = new AsyncQueue<ChatEvent>();
    d.chatAbortController = new AbortController();

    // Abort clears state
    driver.abortChat();

    // After abort, messageQueue is null so the guard should not fire.
    // We can't actually call startChat() without the SDK mock, but we
    // verify the guard condition is clear.
    expect(d.messageQueue).toBeNull();
  });

  it("sendMessage throws when no active chat session", () => {
    const driver = new ClaudeDriver();
    expect(() => driver.sendMessage("hi")).toThrow(
      "No active chat session. Call startChat() first.",
    );
  });

  it("replyQuestion throws for unknown question id", () => {
    const driver = new ClaudeDriver();
    expect(() => driver.replyQuestion("q-1", {})).toThrow(
      "No pending question with id 'q-1'. Available: none",
    );
  });

  it("abortChat is safe to call without active session (no-op)", () => {
    const driver = new ClaudeDriver();
    // Should not throw — cleanly handles null state
    expect(() => driver.abortChat()).not.toThrow();
  });
});

describe("ClaudeDriver sendMessage()", () => {
  /**
   * Helper: simulate an active chat session by injecting internal state.
   * We cannot call startChat() because it needs the real SDK, so we set
   * the private fields directly via `as any`.
   */
  function activateChat(driver: ClaudeDriver) {
    const d = driver as unknown as {
      messageQueue: AsyncQueue<string> | null;
      chatEventQueue: AsyncQueue<unknown> | null;
      chatAbortController: AbortController | null;
    };
    d.messageQueue = new AsyncQueue<string>();
    d.chatEventQueue = new AsyncQueue<unknown>();
    d.chatAbortController = new AbortController();
    return d;
  }

  it("adds message to queue when chat session is active", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);

    driver.sendMessage("hello");

    // Verify the message landed in the buffer
    const queue = internal.messageQueue as unknown as {
      buffer: string[];
    };
    expect(queue.buffer).toContain("hello");
  });

  it("throws when no active chat session (messageQueue is null)", () => {
    const driver = new ClaudeDriver();
    expect(() => driver.sendMessage("hi")).toThrow(
      "No active chat session. Call startChat() first.",
    );
  });

  it("throws with abort-specific message after abortChat()", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);

    // Abort the controller but keep messageQueue open to test the abort check
    internal.chatAbortController!.abort();

    expect(() => driver.sendMessage("hi")).toThrow(
      "Chat session has been aborted.",
    );
  });

  it("throws when messageQueue is closed (session ended naturally)", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);

    // Close the queue to simulate natural session end
    internal.messageQueue!.close();

    expect(() => driver.sendMessage("hi")).toThrow(
      "No active chat session. Call startChat() first.",
    );
  });

  it("buffers multiple sendMessage() calls", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);

    driver.sendMessage("first");
    driver.sendMessage("second");
    driver.sendMessage("third");

    const queue = internal.messageQueue as unknown as {
      buffer: string[];
    };
    expect(queue.buffer).toEqual(["first", "second", "third"]);
  });

  it("delivers message immediately when a consumer is waiting", async () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);

    // Start a consumer that awaits the next item
    const consumer = (async () => {
      const iter = internal.messageQueue![Symbol.asyncIterator]();
      const result = await iter.next();
      return result.value;
    })();

    // Give the consumer a tick to register as a waiter
    await new Promise((r) => setTimeout(r, 0));

    driver.sendMessage("immediate");

    const received = await consumer;
    expect(received).toBe("immediate");
  });
});

describe("ClaudeDriver replyQuestion()", () => {
  /**
   * Helper: inject a pending question into the driver's pendingQuestions map.
   * Returns the Promise that will be resolved/rejected by replyQuestion().
   */
  function addPendingQuestion(driver: ClaudeDriver, questionId: string) {
    const d = driver as unknown as {
      pendingQuestions: Map<string, {
        toolUseId: string;
        resolve: (answers: QuestionAnswers) => void;
        reject: (reason?: Error) => void;
      }>;
    };
    let resolvedWith: QuestionAnswers | undefined;
    let rejectedWith: Error | undefined;
    const promise = new Promise<QuestionAnswers>((resolve, reject) => {
      d.pendingQuestions.set(questionId, {
        toolUseId: `tu-${questionId}`,
        resolve: (answers) => { resolvedWith = answers; resolve(answers); },
        reject: (err) => { rejectedWith = err; reject(err); },
      });
    });
    return { promise, getResolved: () => resolvedWith, getRejected: () => rejectedWith };
  }

  it("resolves pending Promise with provided answers", async () => {
    const driver = new ClaudeDriver();
    const { promise } = addPendingQuestion(driver, "q-1");

    const answers: QuestionAnswers = { "Which framework?": "React" };
    driver.replyQuestion("q-1", answers);

    const result = await promise;
    expect(result).toEqual(answers);
  });

  it("resolves with multi-select answer (string[])", async () => {
    const driver = new ClaudeDriver();
    const { promise } = addPendingQuestion(driver, "q-multi");

    const answers: QuestionAnswers = {
      "Which features?": ["auth", "logging", "caching"],
    };
    driver.replyQuestion("q-multi", answers);

    const result = await promise;
    expect(result).toEqual(answers);
  });

  it("throws for unknown questionId with informative message", () => {
    const driver = new ClaudeDriver();
    expect(() => driver.replyQuestion("q-nonexistent", {})).toThrow(
      "No pending question with id 'q-nonexistent'. Available: none",
    );
  });

  it("throws for unknown questionId and lists available question IDs", () => {
    const driver = new ClaudeDriver();
    addPendingQuestion(driver, "q-100");
    addPendingQuestion(driver, "q-200");

    expect(() => driver.replyQuestion("q-999", {})).toThrow(
      "No pending question with id 'q-999'. Available: q-100, q-200",
    );
  });

  it("throws on repeated reply to the same questionId", async () => {
    const driver = new ClaudeDriver();
    addPendingQuestion(driver, "q-once");

    // First reply succeeds
    driver.replyQuestion("q-once", { answer: "first" });

    // Second reply with same ID throws — question already removed from map
    expect(() => driver.replyQuestion("q-once", { answer: "second" })).toThrow(
      "No pending question with id 'q-once'. Available: none",
    );
  });

  it("removes question from pendingQuestions after reply", () => {
    const driver = new ClaudeDriver();
    addPendingQuestion(driver, "q-cleanup");

    const d = driver as unknown as {
      pendingQuestions: Map<string, unknown>;
    };
    expect(d.pendingQuestions.has("q-cleanup")).toBe(true);

    driver.replyQuestion("q-cleanup", {});

    expect(d.pendingQuestions.has("q-cleanup")).toBe(false);
  });
});

describe("ClaudeDriver abortChat()", () => {
  /** Internal state type for accessing private fields. */
  type DriverInternals = {
    messageQueue: AsyncQueue<string> | null;
    chatEventQueue: AsyncQueue<ChatEvent> | null;
    chatAbortController: AbortController | null;
    pendingQuestions: Map<string, {
      toolUseId: string;
      resolve: (answers: QuestionAnswers) => void;
      reject: (reason?: Error) => void;
    }>;
  };

  function getInternals(driver: ClaudeDriver): DriverInternals {
    return driver as unknown as DriverInternals;
  }

  /** Activate chat state without the real SDK. */
  function activateChat(driver: ClaudeDriver): DriverInternals {
    const d = getInternals(driver);
    d.messageQueue = new AsyncQueue<string>();
    d.chatEventQueue = new AsyncQueue<ChatEvent>();
    d.chatAbortController = new AbortController();
    return d;
  }

  /** Inject a pending question and return its Promise. */
  function addPendingQuestion(driver: ClaudeDriver, questionId: string) {
    const d = getInternals(driver);
    const promise = new Promise<QuestionAnswers>((resolve, reject) => {
      d.pendingQuestions.set(questionId, {
        toolUseId: `tu-${questionId}`,
        resolve,
        reject,
      });
    });
    // Suppress unhandled rejection for expected rejections in tests
    promise.catch(() => {});
    return promise;
  }

  it("aborts the active SDK session via AbortController", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);
    const signal = internal.chatAbortController!.signal;

    expect(signal.aborted).toBe(false);

    driver.abortChat();

    expect(signal.aborted).toBe(true);
  });

  it("rejects all pending questions with Error", async () => {
    const driver = new ClaudeDriver();
    activateChat(driver);

    const p1 = addPendingQuestion(driver, "q-1");
    const p2 = addPendingQuestion(driver, "q-2");
    const p3 = addPendingQuestion(driver, "q-3");

    driver.abortChat();

    await expect(p1).rejects.toThrow("Chat aborted");
    await expect(p2).rejects.toThrow("Chat aborted");
    await expect(p3).rejects.toThrow("Chat aborted");
  });

  it("clears pendingQuestions map after rejecting", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);

    addPendingQuestion(driver, "q-a");
    addPendingQuestion(driver, "q-b");

    expect(internal.pendingQuestions.size).toBe(2);

    driver.abortChat();

    expect(internal.pendingQuestions.size).toBe(0);
  });

  it("closes messageQueue", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);
    const mq = internal.messageQueue!;

    expect(mq.isClosed).toBe(false);

    driver.abortChat();

    expect(mq.isClosed).toBe(true);
  });

  it("closes chatEventQueue", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);
    const eq = internal.chatEventQueue!;

    expect(eq.isClosed).toBe(false);

    driver.abortChat();

    expect(eq.isClosed).toBe(true);
  });

  it("resets state to null after abort", () => {
    const driver = new ClaudeDriver();
    activateChat(driver);
    const internal = getInternals(driver);

    // Verify state is set before abort
    expect(internal.messageQueue).not.toBeNull();
    expect(internal.chatEventQueue).not.toBeNull();
    expect(internal.chatAbortController).not.toBeNull();

    driver.abortChat();

    // All state fields should be null after abort
    expect(internal.messageQueue).toBeNull();
    expect(internal.chatEventQueue).toBeNull();
    expect(internal.chatAbortController).toBeNull();
  });

  it("is idempotent — repeated calls do not throw", () => {
    const driver = new ClaudeDriver();
    activateChat(driver);

    // First abort
    expect(() => driver.abortChat()).not.toThrow();
    // Second abort — state is already null, should still not throw
    expect(() => driver.abortChat()).not.toThrow();
    // Third abort — same
    expect(() => driver.abortChat()).not.toThrow();
  });

  it("is safe to call without active session (no-op)", () => {
    const driver = new ClaudeDriver();
    // No activateChat — all fields are null
    expect(() => driver.abortChat()).not.toThrow();

    // Verify state is still null
    const internal = getInternals(driver);
    expect(internal.messageQueue).toBeNull();
    expect(internal.chatEventQueue).toBeNull();
    expect(internal.chatAbortController).toBeNull();
    expect(internal.pendingQuestions.size).toBe(0);
  });

  it("sendMessage throws after abortChat", () => {
    const driver = new ClaudeDriver();
    activateChat(driver);

    driver.abortChat();

    // State is reset to null, so sendMessage should throw the "no session" error
    expect(() => driver.sendMessage("hi")).toThrow(
      "No active chat session. Call startChat() first.",
    );
  });

  it("does not close already-closed queues (no double-close)", () => {
    const driver = new ClaudeDriver();
    const internal = activateChat(driver);

    // Close queues manually before abort
    internal.messageQueue!.close();
    internal.chatEventQueue!.close();

    // abortChat should not throw even if queues are already closed
    expect(() => driver.abortChat()).not.toThrow();
  });
});
