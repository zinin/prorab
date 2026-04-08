import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WsBroadcaster,
  MAX_BUFFER_SIZE,
  type WsEvent,
} from "../server/session/ws-broadcaster.js";

/** Minimal mock socket compatible with BroadcastSocket interface. */
function mockSocket(readyState = 1) {
  return { readyState, send: vi.fn() };
}

describe("WsBroadcaster", () => {
  let clients: Set<ReturnType<typeof mockSocket>>;
  let broadcaster: WsBroadcaster;

  beforeEach(() => {
    clients = new Set();
    // Cast is safe: mockSocket satisfies BroadcastSocket
    broadcaster = new WsBroadcaster(clients as unknown as Set<{ readyState: number; send(data: string): void }>);
  });

  // ---------- broadcast() ----------

  it("sends event to all OPEN clients", () => {
    const open1 = mockSocket(1);
    const open2 = mockSocket(1);
    const closed = mockSocket(3); // CLOSED
    clients.add(open1);
    clients.add(open2);
    clients.add(closed);

    broadcaster.broadcast({ type: "test" });

    expect(open1.send).toHaveBeenCalledOnce();
    expect(open2.send).toHaveBeenCalledOnce();
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("adds timestamp if missing (without mutating original)", () => {
    const now = Date.now();
    const event: WsEvent = { type: "test" };
    broadcaster.broadcast(event);

    // Original event must NOT be mutated
    expect(event.timestamp).toBeUndefined();

    // Buffered copy must have the timestamp
    const buffered = broadcaster.buffer[0];
    expect(buffered.timestamp).toBeTypeOf("number");
    expect(buffered.timestamp!).toBeGreaterThanOrEqual(now);
  });

  it("preserves existing timestamp", () => {
    const event: WsEvent = { type: "test", timestamp: 12345 };
    broadcaster.broadcast(event);

    expect(event.timestamp).toBe(12345);
    expect(broadcaster.buffer[0].timestamp).toBe(12345);
  });

  it("adds event to buffer", () => {
    broadcaster.broadcast({ type: "a" });
    broadcaster.broadcast({ type: "b" });

    expect(broadcaster.buffer).toHaveLength(2);
    expect(broadcaster.buffer[0].type).toBe("a");
    expect(broadcaster.buffer[1].type).toBe("b");
  });

  it("trims buffer to MAX_BUFFER_SIZE when exceeded", () => {
    for (let i = 0; i < MAX_BUFFER_SIZE + 1; i++) {
      broadcaster.broadcast({ type: `evt-${i}` });
    }

    expect(broadcaster.buffer).toHaveLength(MAX_BUFFER_SIZE);
    // The oldest event (evt-0) should be evicted; first in buffer is evt-1
    expect(broadcaster.buffer[0].type).toBe("evt-1");
    expect(broadcaster.buffer[broadcaster.buffer.length - 1].type).toBe(
      `evt-${MAX_BUFFER_SIZE}`,
    );
  });

  it("serializes event as JSON when sending", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    broadcaster.broadcast({ type: "hello", data: 42 });

    const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(sent.type).toBe("hello");
    expect(sent.data).toBe(42);
    expect(sent.timestamp).toBeTypeOf("number");
  });

  // ---------- broadcastWithChannel() ----------

  it("adds channel field and delegates to broadcast()", () => {
    const sock = mockSocket(1);
    clients.add(sock);

    broadcaster.broadcastWithChannel({ type: "msg" }, "chat");

    const sent = JSON.parse(sock.send.mock.calls[0][0] as string);
    expect(sent.channel).toBe("chat");
    expect(sent.type).toBe("msg");
  });

  it("supports execute channel", () => {
    broadcaster.broadcastWithChannel({ type: "run" }, "execute");

    expect(broadcaster.buffer).toHaveLength(1);
    expect(broadcaster.buffer[0].channel).toBe("execute");
  });

  // ---------- replay() ----------

  it("replays all buffered events to a single socket", () => {
    broadcaster.broadcast({ type: "a" });
    broadcaster.broadcast({ type: "b" });
    broadcaster.broadcast({ type: "c" });

    const newSock = mockSocket(1);
    broadcaster.replay(newSock);

    expect(newSock.send).toHaveBeenCalledTimes(3);

    const msgs = newSock.send.mock.calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string).type,
    );
    expect(msgs).toEqual(["a", "b", "c"]);
  });

  it("replay on empty buffer sends nothing", () => {
    const sock = mockSocket(1);
    broadcaster.replay(sock);
    expect(sock.send).not.toHaveBeenCalled();
  });

  it("replay checks readyState and skips non-OPEN socket", () => {
    broadcaster.broadcast({ type: "a" });
    broadcaster.broadcast({ type: "b" });

    const closedSock = mockSocket(3); // CLOSED
    broadcaster.replay(closedSock);
    expect(closedSock.send).not.toHaveBeenCalled();
  });

  it("replay stops sending if socket closes mid-replay", () => {
    broadcaster.broadcast({ type: "a" });
    broadcaster.broadcast({ type: "b" });
    broadcaster.broadcast({ type: "c" });

    const sock = mockSocket(1);
    // After first send, change readyState to CLOSED
    sock.send.mockImplementation(() => {
      sock.readyState = 3;
    });
    broadcaster.replay(sock);
    // Only the first event should be sent (readyState checked before each send)
    expect(sock.send).toHaveBeenCalledTimes(1);
  });

  it("buffer remains unchanged after replay", () => {
    broadcaster.broadcast({ type: "a" });
    broadcaster.broadcast({ type: "b" });

    const bufferBefore = [...broadcaster.buffer];

    const sock = mockSocket(1);
    broadcaster.replay(sock);

    expect(broadcaster.buffer).toHaveLength(bufferBefore.length);
    expect(broadcaster.buffer[0]).toBe(bufferBefore[0]);
    expect(broadcaster.buffer[1]).toBe(bufferBefore[1]);
  });

  // ---------- bufferSize ----------

  it("bufferSize reflects current buffer length", () => {
    expect(broadcaster.bufferSize).toBe(0);
    broadcaster.broadcast({ type: "a" });
    expect(broadcaster.bufferSize).toBe(1);
    broadcaster.broadcast({ type: "b" });
    expect(broadcaster.bufferSize).toBe(2);
    broadcaster.clearBuffer();
    expect(broadcaster.bufferSize).toBe(0);
  });

  // ---------- clearBuffer() ----------

  it("clears the buffer", () => {
    broadcaster.broadcast({ type: "x" });
    broadcaster.broadcast({ type: "y" });
    expect(broadcaster.buffer).toHaveLength(2);

    broadcaster.clearBuffer();
    expect(broadcaster.buffer).toHaveLength(0);
  });

  it("buffer works normally after clear", () => {
    broadcaster.broadcast({ type: "before" });
    broadcaster.clearBuffer();
    broadcaster.broadcast({ type: "after" });

    expect(broadcaster.buffer).toHaveLength(1);
    expect(broadcaster.buffer[0].type).toBe("after");
  });
});
