/**
 * WsBroadcaster — WebSocket broadcast with ring buffer for event replay.
 *
 * Extracted from ws.ts to encapsulate broadcast logic, event buffering,
 * and channel-based event routing.
 */

import type { WsChannel } from "../../types.js";

/** WebSocket readyState value for OPEN (from ws spec) */
const WS_OPEN = 1;

// Re-export WsChannel so existing imports from ws-broadcaster still work.
export type { WsChannel } from "../../types.js";

export interface WsEvent {
  type: string;
  channel?: WsChannel;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Minimal WebSocket interface used by the broadcaster.
 * Compatible with both `ws` and `@fastify/websocket` socket types.
 */
interface BroadcastSocket {
  readyState: number;
  send(data: string): void;
}

export const MAX_BUFFER_SIZE = 2000;

export class WsBroadcaster {
  private readonly clients: Set<BroadcastSocket>;
  private eventBuffer: WsEvent[] = [];

  constructor(clients: Set<BroadcastSocket>) {
    this.clients = clients;
  }

  /**
   * Broadcast an event to all connected clients with readyState === OPEN.
   * Adds a timestamp if missing, serializes to JSON, and buffers for replay.
   */
  broadcast(event: WsEvent): void {
    const stamped: WsEvent = { ...event, timestamp: event.timestamp ?? Date.now() };

    const msg = JSON.stringify(stamped);
    for (const client of this.clients) {
      if (client.readyState === WS_OPEN) {
        client.send(msg);
      }
    }

    this.eventBuffer.push(stamped);
    if (this.eventBuffer.length > MAX_BUFFER_SIZE) {
      this.eventBuffer.splice(0, this.eventBuffer.length - MAX_BUFFER_SIZE);
    }
  }

  /**
   * Broadcast an event with a channel field attached.
   * Convenience wrapper over broadcast().
   */
  broadcastWithChannel(
    event: Omit<WsEvent, "channel">,
    channel: WsChannel,
  ): void {
    this.broadcast({ ...event, channel } as WsEvent);
  }

  /**
   * Replay all buffered events to a single socket (e.g. on reconnect).
   * Checks socket readyState before each send — stops early if closed.
   */
  replay(socket: BroadcastSocket): void {
    for (const event of this.eventBuffer) {
      if (socket.readyState !== WS_OPEN) break;
      socket.send(JSON.stringify(event));
    }
  }

  /** Current number of events in the buffer. */
  get bufferSize(): number {
    return this.eventBuffer.length;
  }

  /**
   * Clear the event buffer. Typically called when a new execution session starts.
   */
  clearBuffer(): void {
    this.eventBuffer.length = 0;
  }

  /** Read-only access to the current buffer (for testing / inspection). */
  get buffer(): readonly WsEvent[] {
    return this.eventBuffer;
  }
}
