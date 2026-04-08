import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { chatRoutes } from "../server/routes/chat.js";
import type { ChatManager, ChatSession, ChatState } from "../server/chat-manager.js";
import {
  ChatSessionActiveError,
  ChatNotReadyError,
  QuestionMismatchError,
} from "../server/chat-manager.js";

// --- Mock ChatManager ---

function mockChatManager(overrides: Partial<ChatManager> = {}): ChatManager {
  return {
    start: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    replyQuestion: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    getState: vi.fn((): ChatState => "idle"),
    getSession: vi.fn((): ChatSession | null => null),
    ...overrides,
  } as unknown as ChatManager;
}

const defaultSession: ChatSession = {
  id: "test-session-id",
  agent: "claude",
  model: undefined,
  variant: undefined,
  systemPrompt: "You are a helpful assistant.",
  state: "active",
  pendingQuestionId: null,
  awaitingUserInput: true,
};

describe("POST /api/chat/start", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 with sessionId on valid start", async () => {
    const cm = mockChatManager({
      start: vi.fn(async () => {}),
      getSession: vi.fn(() => defaultSession),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude", systemPrompt: "Hello" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.started).toBe(true);
    expect(body.sessionId).toBe("test-session-id");
    expect(cm.start).toHaveBeenCalledWith({
      agent: "claude",
      model: undefined,
      variant: undefined,
      systemPrompt: "Hello",
      userSettings: false,
      applyHooks: false,
    });
  });

  it("returns 200 with all optional fields passed", async () => {
    const cm = mockChatManager({
      start: vi.fn(async () => {}),
      getSession: vi.fn(() => ({ ...defaultSession, model: "opus", variant: "high" })),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude", model: "opus", variant: "high", systemPrompt: "Test" },
    });

    expect(res.statusCode).toBe(200);
    expect(cm.start).toHaveBeenCalledWith({
      agent: "claude",
      model: "opus",
      variant: "high",
      systemPrompt: "Test",
      userSettings: false,
      applyHooks: false,
    });
  });

  it("returns 409 with reason active_session when session already active", async () => {
    const cm = mockChatManager({
      start: vi.fn(async () => {
        throw new ChatSessionActiveError("Cannot start chat: session is active");
      }),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude", systemPrompt: "Hello" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.reason).toBe("active_session");
    expect(body.error).toBe("Another session is active");
    expect(body.message).toBeDefined();
  });

  it("returns 400 on invalid body (missing agent)", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { systemPrompt: "Hello" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(cm.start).not.toHaveBeenCalled();
  });

  it("returns 200 when systemPrompt is omitted (optional field)", async () => {
    const cm = mockChatManager({
      start: vi.fn(async () => {}),
      getSession: vi.fn(() => defaultSession),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude" },
    });

    expect(res.statusCode).toBe(200);
    expect(cm.start).toHaveBeenCalledWith({
      agent: "claude",
      model: undefined,
      variant: undefined,
      systemPrompt: undefined,
      userSettings: false,
      applyHooks: false,
    });
  });

  it("returns 400 on invalid agent type", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "gpt", systemPrompt: "Hello" },
    });

    expect(res.statusCode).toBe(400);
    expect(cm.start).not.toHaveBeenCalled();
  });

  it("returns 500 on unexpected start error", async () => {
    const cm = mockChatManager({
      start: vi.fn(async () => {
        throw new Error("Driver exploded");
      }),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude", systemPrompt: "Hello" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Failed to start chat session");
  });

  it("returns 400 when body has extra fields (strict schema)", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/start",
      payload: { agent: "claude", systemPrompt: "Hello", extraField: "unexpected" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(cm.start).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat/message", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 on valid message", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/message",
      payload: { text: "Hello, agent!" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sent: true });
    expect(cm.sendMessage).toHaveBeenCalledWith("Hello, agent!");
  });

  it("returns 400 when no active session", async () => {
    const cm = mockChatManager({
      sendMessage: vi.fn(async () => {
        throw new ChatNotReadyError("Cannot send message: chat is not waiting for user input");
      }),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/message",
      payload: { text: "Hello" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Cannot send message");
  });

  it("returns 500 on internal driver error", async () => {
    const cm = mockChatManager({
      sendMessage: vi.fn(async () => {
        throw new Error("Driver connection lost");
      }),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/message",
      payload: { text: "Hello" },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Internal error while sending message");
  });

  it("returns 400 on empty text", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/message",
      payload: { text: "" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(cm.sendMessage).not.toHaveBeenCalled();
  });

  it("returns 400 on missing text", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/message",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(cm.sendMessage).not.toHaveBeenCalled();
  });

  it("returns 400 when body has extra fields (strict schema)", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/message",
      payload: { text: "Hello", extra: "field" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(cm.sendMessage).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat/question/:id/reply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 on valid reply with string answers", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/question/q-abc/reply",
      payload: { answers: { "Pick a color": "Red" } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ replied: true });
    expect(cm.replyQuestion).toHaveBeenCalledWith("q-abc", { "Pick a color": "Red" });
  });

  it("returns 200 on valid reply with array answers", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/question/q-xyz/reply",
      payload: { answers: { "Select features": ["Auth", "DB"] } },
    });

    expect(res.statusCode).toBe(200);
    expect(cm.replyQuestion).toHaveBeenCalledWith("q-xyz", {
      "Select features": ["Auth", "DB"],
    });
  });

  it("returns 400 on question ID mismatch", async () => {
    const cm = mockChatManager({
      replyQuestion: vi.fn(async () => {
        throw new QuestionMismatchError("Question ID mismatch");
      }),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/question/wrong-id/reply",
      payload: { answers: { q: "a" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Question ID mismatch");
  });

  it("returns 400 when no pending question", async () => {
    const cm = mockChatManager({
      replyQuestion: vi.fn(async () => {
        throw new ChatNotReadyError("Cannot reply: no pending question");
      }),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/question/q1/reply",
      payload: { answers: { q: "a" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Cannot reply to question");
  });

  it("returns 500 on internal driver error", async () => {
    const cm = mockChatManager({
      replyQuestion: vi.fn(async () => {
        throw new Error("Driver crashed");
      }),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/question/q1/reply",
      payload: { answers: { q: "a" } },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("Internal error while replying to question");
  });

  it("returns 400 on missing answers", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/question/q1/reply",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(cm.replyQuestion).not.toHaveBeenCalled();
  });

  it("returns 400 when body has extra fields (strict schema)", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "POST",
      url: "/api/chat/question/q1/reply",
      payload: { answers: { q: "a" }, extra: "field" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid request body");
    expect(cm.replyQuestion).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/chat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 200 and calls stop()", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/chat",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: true });
    expect(cm.stop).toHaveBeenCalledOnce();
  });

  it("returns 200 even when no session is active (stop is a no-op)", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "DELETE",
      url: "/api/chat",
    });

    expect(res.statusCode).toBe(200);
    expect(cm.stop).toHaveBeenCalledOnce();
  });
});

describe("GET /api/chat", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns idle state and null session when no session active", async () => {
    const cm = mockChatManager();
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "GET",
      url: "/api/chat",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: "idle", session: null });
  });

  it("returns active state and session info when session active", async () => {
    const cm = mockChatManager({
      getState: vi.fn(() => "active" as ChatState),
      getSession: vi.fn(() => defaultSession),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "GET",
      url: "/api/chat",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("active");
    expect(body.session).toEqual(defaultSession);
  });

  it("returns question_pending state with pending question", async () => {
    const sessionWithQuestion: ChatSession = {
      ...defaultSession,
      state: "question_pending",
      pendingQuestionId: "q-abc",
      awaitingUserInput: false,
    };
    const cm = mockChatManager({
      getState: vi.fn(() => "question_pending" as ChatState),
      getSession: vi.fn(() => sessionWithQuestion),
    });
    const app = Fastify();
    await app.register(chatRoutes(cm, "/fake/cwd"));

    const res = await app.inject({
      method: "GET",
      url: "/api/chat",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.state).toBe("question_pending");
    expect(body.session.pendingQuestionId).toBe("q-abc");
  });
});
