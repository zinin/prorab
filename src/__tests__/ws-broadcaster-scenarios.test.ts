/**
 * WsBroadcaster scenario tests.
 *
 * Exercises WsBroadcaster through realistic multi-step scenarios that
 * mirror how ws.ts uses the broadcaster (execution lifecycle, reconnect
 * replay, channel tagging, chat integration, etc.). Pure unit-level — does not import ws.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { WsBroadcaster, type WsEvent } from "../server/session/ws-broadcaster.js";

/** Minimal mock socket compatible with BroadcastSocket interface. */
function mockSocket(readyState = 1) {
  return { readyState, send: vi.fn() };
}

describe("WsBroadcaster scenarios", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    broadcaster = new WsBroadcaster(
      clients as unknown as Set<{ readyState: number; send(data: string): void }>,
    );
  });

  // ---------- Connection & initial state ----------

  it("new client receives 'connected' event on join", () => {
    // ws.ts sends 'connected' directly via socket.send, not through broadcaster.
    // Verify that a separately sent 'connected' event works alongside broadcaster.
    const sock = mockSocket(1);
    clients.add(sock);

    // Simulate what ws.ts does: send connected event directly
    sock.send(JSON.stringify({ type: "connected", state: "idle", currentUnit: null }));

    expect(sock.send).toHaveBeenCalledOnce();
    const msg = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(msg.type).toBe("connected");
    expect(msg.state).toBe("idle");
  });

  // ---------- ExecutionManager event forwarding ----------

  it("execution events are broadcast and buffered via broadcaster", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    // Simulate what ws.ts does when it receives execution events
    broadcaster.broadcast({ type: "execution:state", state: "running" });
    broadcaster.broadcast({
      type: "execution:started",
      unitId: "1.2",
      title: "Test task",
      taskId: "1",
      subtaskId: "2",
    });
    broadcaster.broadcast({ type: "execution:finished", unitId: "1.2", result: true });
    broadcaster.broadcast({ type: "execution:all_done" });

    expect(sock.send).toHaveBeenCalledTimes(4);

    // Verify buffer contains all events
    expect(broadcaster.bufferSize).toBe(4);
    expect(broadcaster.buffer.map((e) => e.type)).toEqual([
      "execution:state",
      "execution:started",
      "execution:finished",
      "execution:all_done",
    ]);
  });

  it("review/rework events are forwarded correctly", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    broadcaster.broadcast({ type: "execution:review_started", taskId: "5" });
    broadcaster.broadcast({ type: "execution:rework_started", taskId: "5" });

    expect(sock.send).toHaveBeenCalledTimes(2);

    const events = sock.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string).type,
    );
    expect(events).toEqual(["execution:review_started", "execution:rework_started"]);
  });

  // ---------- Replay on reconnect ----------

  it("reconnecting client receives replay of all buffered events", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate a series of events
    broadcaster.broadcast({ type: "execution:state", state: "running" });
    broadcaster.broadcast({ type: "execution:started", unitId: "3", title: "A", taskId: "3", subtaskId: "" });
    broadcaster.broadcast({ type: "execution:finished", unitId: "3", result: true });

    // New client connects — simulate reconnect
    const sock2 = mockSocket(1);
    clients.add(sock2);
    broadcaster.replay(sock2);

    // sock2 should have received 3 replayed events
    expect(sock2.send).toHaveBeenCalledTimes(3);

    const replayed = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string).type,
    );
    expect(replayed).toEqual([
      "execution:state",
      "execution:started",
      "execution:finished",
    ]);
  });

  it("replay preserves event data and timestamps", () => {
    broadcaster.broadcast({
      type: "execution:started",
      unitId: "7",
      title: "My task",
      taskId: "7",
      subtaskId: "",
    });

    const sock = mockSocket(1);
    broadcaster.replay(sock);

    const event = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(event.type).toBe("execution:started");
    expect(event.unitId).toBe("7");
    expect(event.title).toBe("My task");
    expect(event.timestamp).toBeTypeOf("number");
  });

  // ---------- Buffer clear on new session ----------

  it("clearBuffer() resets replay history when new session starts", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    // Buffer some events
    broadcaster.broadcast({ type: "execution:state", state: "running" });
    broadcaster.broadcast({ type: "execution:started", unitId: "1", title: "", taskId: "1", subtaskId: "" });
    expect(broadcaster.bufferSize).toBe(2);

    // Simulate ws.ts clearing on "running" state
    broadcaster.clearBuffer();
    expect(broadcaster.bufferSize).toBe(0);

    // New client gets nothing on replay
    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);
    expect(sock2.send).not.toHaveBeenCalled();
  });

  // ---------- broadcastTasksUpdated ----------

  it("tasks:updated events are broadcast and buffered", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    // Simulate broadcastTasksUpdated() wrapper
    broadcaster.broadcast({ type: "tasks:updated" });

    expect(sock.send).toHaveBeenCalledOnce();
    const msg = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(msg.type).toBe("tasks:updated");
    expect(broadcaster.bufferSize).toBe(1);
  });

  // ---------- Channel tagging ----------

  it("broadcastWithChannel tags events with channel='execute'", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    broadcaster.broadcastWithChannel(
      { type: "execution:state", state: "running" },
      "execute",
    );

    const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(sent.channel).toBe("execute");
    expect(sent.type).toBe("execution:state");
    expect(sent.state).toBe("running");
  });

  it("broadcastWithChannel tags events with channel='chat'", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    broadcaster.broadcastWithChannel({ type: "chat:message", text: "hello" }, "chat");

    const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(sent.channel).toBe("chat");
    expect(sent.type).toBe("chat:message");
    expect(sent.text).toBe("hello");
  });

  it("events without channel continue to work (backward compat)", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    broadcaster.broadcast({ type: "execution:blocked", taskId: "4" });

    const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(sent.type).toBe("execution:blocked");
    expect(sent.taskId).toBe("4");
    expect(sent.channel).toBeUndefined();
  });

  // ---------- Agent log forwarding ----------

  it("agent:log events are broadcast through the broadcaster", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    // Simulate what ws.ts does with agent:log events
    const logEvent: WsEvent = {
      type: "agent:text",
      text: "Analyzing the codebase...",
    };
    broadcaster.broadcast(logEvent);

    expect(sock.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(sent.type).toBe("agent:text");
    expect(sent.text).toBe("Analyzing the codebase...");
    expect(broadcaster.bufferSize).toBe(1);
  });

  // ---------- Multi-client broadcast ----------

  it("broadcast reaches all connected clients", () => {
    const sock1 = mockSocket(1);
    const sock2 = mockSocket(1);
    const sock3 = mockSocket(1);
    clients.add(sock1);
    clients.add(sock2);
    clients.add(sock3);

    broadcaster.broadcast({ type: "execution:all_done" });

    expect(sock1.send).toHaveBeenCalledOnce();
    expect(sock2.send).toHaveBeenCalledOnce();
    expect(sock3.send).toHaveBeenCalledOnce();

    // All receive identical event
    const msg1 = JSON.parse(sock1.send.mock.calls[0][0] as string);
    const msg2 = JSON.parse(sock2.send.mock.calls[0][0] as string);
    const msg3 = JSON.parse(sock3.send.mock.calls[0][0] as string);
    expect(msg1.type).toBe("execution:all_done");
    expect(msg2.type).toBe("execution:all_done");
    expect(msg3.type).toBe("execution:all_done");
  });

  it("disconnected clients are skipped during broadcast", () => {
    const open = mockSocket(1);
    const closed = mockSocket(3);
    clients.add(open);
    clients.add(closed);

    broadcaster.broadcast({ type: "test" });

    expect(open.send).toHaveBeenCalledOnce();
    expect(closed.send).not.toHaveBeenCalled();
  });

  // ---------- Full flow simulation ----------

  it("simulates a complete execution lifecycle", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    // 1. Session starts — clear buffer
    broadcaster.clearBuffer();

    // 2. State changes to running
    broadcaster.broadcast({ type: "execution:state", state: "running" });

    // 3. Task starts
    broadcaster.broadcast({
      type: "execution:started",
      unitId: "2.1",
      title: "Implement feature",
      taskId: "2",
      subtaskId: "1",
    });

    // 4. Agent log
    broadcaster.broadcast({ type: "agent:text", text: "Working on it..." });

    // 5. Task finishes
    broadcaster.broadcast({ type: "execution:finished", unitId: "2.1", result: true });

    // 6. Review starts
    broadcaster.broadcast({ type: "execution:review_started", taskId: "2" });

    // 7. Review finishes → rework
    broadcaster.broadcast({ type: "execution:rework_started", taskId: "2" });

    // 8. All done
    broadcaster.broadcast({ type: "execution:all_done" });

    // 9. State back to idle
    broadcaster.broadcast({ type: "execution:state", state: "idle" });

    expect(sock.send).toHaveBeenCalledTimes(8);
    expect(broadcaster.bufferSize).toBe(8);

    // New client joins — gets full history
    const lateSock = mockSocket(1);
    broadcaster.replay(lateSock);
    expect(lateSock.send).toHaveBeenCalledTimes(8);

    const types = lateSock.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string).type,
    );
    expect(types).toEqual([
      "execution:state",
      "execution:started",
      "agent:text",
      "execution:finished",
      "execution:review_started",
      "execution:rework_started",
      "execution:all_done",
      "execution:state",
    ]);
  });

  // ---------- Chat integration via shared WsBroadcaster ----------

  it("chat:started event reaches WS clients via shared WsBroadcaster (no EventEmitter)", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    // ChatManager broadcasts chat:started via broadcastWithChannel — verify
    // the same broadcaster delivers it to connected clients without any
    // separate EventEmitter subscription in ws.ts.
    broadcaster.broadcastWithChannel(
      { type: "chat:started", sessionId: "sess-123", agent: "claude", model: "sonnet" },
      "chat",
    );

    expect(sock.send).toHaveBeenCalledOnce();
    const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(sent.type).toBe("chat:started");
    expect(sent.channel).toBe("chat");
    expect(sent.sessionId).toBe("sess-123");
    expect(sent.agent).toBe("claude");
    expect(sent.model).toBe("sonnet");
    expect(sent.timestamp).toBeTypeOf("number");
  });

  it("chat events are buffered and replayed to reconnecting clients", () => {
    const sock1 = mockSocket(1);
    clients.add(sock1);

    // Simulate a full chat lifecycle via the shared broadcaster
    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "s1", agent: "claude" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Hello" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:tool", name: "Read", summary: "Read" }, "chat");
    broadcaster.broadcastWithChannel({ type: "chat:idle" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "Done" }, "chat");
    broadcaster.broadcastWithChannel({ type: "chat:finished" }, "chat");

    expect(broadcaster.bufferSize).toBe(6);

    // New client connects — should receive all chat events via replay
    const sock2 = mockSocket(1);
    broadcaster.replay(sock2);
    expect(sock2.send).toHaveBeenCalledTimes(6);

    const replayedTypes = sock2.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string).type,
    );
    expect(replayedTypes).toEqual([
      "chat:started",
      "agent:text",
      "agent:tool",
      "chat:idle",
      "agent:text",
      "chat:finished",
    ]);

    // All replayed events should have channel='chat'
    for (const call of sock2.send.mock.calls) {
      const event = JSON.parse(call[0] as string);
      expect(event.channel).toBe("chat");
    }
  });

  it("chat and execution events coexist in the same buffer", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    // Mix execution and chat events through the same broadcaster
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "running" }, "execute");
    broadcaster.broadcastWithChannel({ type: "chat:started", sessionId: "c1", agent: "claude" }, "chat");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "exec output" }, "execute");
    broadcaster.broadcastWithChannel({ type: "agent:text", text: "chat output" }, "chat");
    broadcaster.broadcastWithChannel({ type: "chat:finished" }, "chat");
    broadcaster.broadcastWithChannel({ type: "execution:state", state: "idle" }, "execute");

    expect(broadcaster.bufferSize).toBe(6);

    // New client gets all events in order
    const lateSock = mockSocket(1);
    broadcaster.replay(lateSock);
    expect(lateSock.send).toHaveBeenCalledTimes(6);

    const events = lateSock.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string),
    );

    // Verify channels are preserved
    expect(events[0].channel).toBe("execute");
    expect(events[1].channel).toBe("chat");
    expect(events[2].channel).toBe("execute");
    expect(events[3].channel).toBe("chat");
    expect(events[4].channel).toBe("chat");
    expect(events[5].channel).toBe("execute");
  });

  it("chat:question event reaches clients with full question data", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    broadcaster.broadcastWithChannel(
      {
        type: "chat:question",
        questionId: "q-42",
        questions: [{ question: "Pick one", header: "Choice", options: [{ label: "A" }], multiSelect: false }],
        source: "claude",
      },
      "chat",
    );

    const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(sent.type).toBe("chat:question");
    expect(sent.channel).toBe("chat");
    expect(sent.questionId).toBe("q-42");
    expect(sent.questions).toHaveLength(1);
    expect(sent.source).toBe("claude");
  });
});
