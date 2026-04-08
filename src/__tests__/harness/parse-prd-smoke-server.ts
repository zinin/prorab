/**
 * Standalone scripted harness for parse-prd browser smoke tests.
 *
 * Starts a Fastify server that serves the Vue SPA and implements the minimum
 * API surface for the parse-prd workflow (status, models, parse-prd CRUD, WS).
 * Does NOT require a live LLM — events are scripted/simulated.
 *
 * Usage:
 *   npx tsx src/__tests__/harness/parse-prd-smoke-server.ts
 *
 * The server prints HARNESS_PORT=<port> and HARNESS_URL=<url> on stdout.
 * It creates a temp fixture directory with a PRD but no tasks.json.
 *
 * Send SIGTERM to shut down cleanly (cleans up temp directory).
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDistPath = join(__dirname, "..", "..", "..", "ui", "dist");

// ---------------------------------------------------------------------------
// Fixture: temp directory with PRD but no tasks.json
// ---------------------------------------------------------------------------

const cwd = mkdtempSync(join(tmpdir(), "pprd-smoke-"));
mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
writeFileSync(
  join(cwd, ".taskmaster", "docs", "prd.md"),
  "# Sample PRD\n\nThis is a sample PRD for browser smoke testing.\n\n## Features\n1. User authentication\n2. Dashboard analytics\n3. Report generation\n",
);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type SessionState = "idle" | "active" | "stopping";

let sessionState: SessionState = "idle";
let sessionId: string | null = null;
let sessionTimer: ReturnType<typeof setInterval> | null = null;
let completedOutcome: { status: string; errors?: string[] } | null = null;

interface WsClient {
  readyState: number;
  send(data: string): void;
}

const clients = new Set<WsClient>();

function broadcast(event: Record<string, unknown>) {
  const data = JSON.stringify(event);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function buildConnectedMessage() {
  return {
    type: "connected",
    state: "idle",
    currentUnit: null,
    iterationCurrent: null,
    iterationTotal: null,
    hasPrd: true,
    hasTasksFile: false,
    hasValidTasks: false,
    hasTasksJson: false,
    chatSession: null,
    parsePrdSession:
      sessionState !== "idle"
        ? { sessionId, agent: "claude", model: undefined, variant: undefined, state: sessionState }
        : null,
    parsePrdOutcome: completedOutcome,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const fastify = Fastify({ logger: false });

// Serve SPA
if (!existsSync(uiDistPath)) {
  console.error(`UI dist not found at ${uiDistPath} — run 'npm run build:ui' first.`);
  process.exit(1);
}

await fastify.register(fastifyStatic, {
  root: uiDistPath,
  prefix: "/",
  wildcard: false,
});

fastify.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/") || request.url.startsWith("/ws")) {
    reply.code(404).send({ error: "Not found" });
  } else {
    reply.sendFile("index.html");
  }
});

// WebSocket
await fastify.register(fastifyWebsocket);

fastify.get("/ws", { websocket: true }, (socket) => {
  clients.add(socket as unknown as WsClient);

  // Send connected message
  socket.send(JSON.stringify(buildConnectedMessage()));

  // Send replay:complete sentinel (no events to replay in this harness)
  socket.send(JSON.stringify({ type: "replay:complete" }));

  socket.on("close", () => {
    clients.delete(socket as unknown as WsClient);
  });

  socket.on("error", () => {
    clients.delete(socket as unknown as WsClient);
  });
});

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

// GET /api/status — project state
fastify.get("/api/status", async () => ({
  state: "idle",
  hasPrd: true,
  hasTasksFile: false,
  hasValidTasks: false,
  hasTasksJson: false,
}));

// GET /api/models — available models for wizard
fastify.get("/api/models", async () => ({
  models: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
  ],
}));

// GET /api/tasks — needed in case frontend tries to fetch
fastify.get("/api/tasks", async () => ({ tasks: [] }));

// POST /api/parse-prd — start a scripted parse-prd session
//
// Query parameters:
//   ?mode=failure — terminate after scripted steps with a failure outcome
//                   (default: run indefinitely until DELETE cancellation)
fastify.post("/api/parse-prd", async (request, reply) => {
  if (sessionState !== "idle") {
    return reply.code(409).send({
      error: "Another session is active",
      reason: "active_session",
    });
  }

  const query = request.query as Record<string, string>;
  const mode = query.mode ?? "default";

  sessionId = randomUUID();
  sessionState = "active";
  completedOutcome = null;

  // Broadcast parse-prd:started
  broadcast({
    type: "parse-prd:started",
    channel: "parse-prd",
    sessionId,
    agent: "claude",
  });

  // Broadcast a system prompt event
  broadcast({
    type: "agent:system_prompt",
    channel: "parse-prd",
    text: "You are a PRD parser. Read the PRD and create tasks.",
  });

  // Simulate agent work — emit text events periodically
  let step = 0;
  const steps = [
    "Reading PRD document...\n",
    "Analyzing project requirements...\n",
    "Identifying feature areas...\n",
    "Generating task breakdown...\n",
    "Structuring dependencies...\n",
  ];

  sessionTimer = setInterval(() => {
    if (sessionState !== "active") {
      if (sessionTimer) clearInterval(sessionTimer);
      return;
    }

    if (step < steps.length) {
      broadcast({
        type: "agent:text",
        channel: "parse-prd",
        text: steps[step],
      });
    } else if (mode === "failure") {
      // In failure mode, terminate after scripted steps with a failure outcome
      if (sessionTimer) clearInterval(sessionTimer);
      sessionTimer = null;

      const failureOutcome = {
        status: "failure" as const,
        errors: [
          "tasks array is empty — at least one task is required",
          "file does not match expected standard format",
        ],
      };
      sessionState = "idle";
      completedOutcome = failureOutcome;

      broadcast({
        type: "parse-prd:finished",
        channel: "parse-prd",
        outcome: failureOutcome,
      });

      sessionId = null;
      return;
    } else {
      // Default mode: continue with generic progress indefinitely
      broadcast({
        type: "agent:text",
        channel: "parse-prd",
        text: `Processing step ${step + 1}...\n`,
      });
    }

    // Also send a tool event periodically for visual variety
    if (step === 1) {
      broadcast({
        type: "agent:tool",
        channel: "parse-prd",
        name: "Read",
        summary: "Reading .taskmaster/docs/prd.md",
      });
      broadcast({
        type: "agent:tool_result",
        channel: "parse-prd",
        summary: "File read successfully (342 bytes)",
      });
    }

    step++;
  }, 800);

  return { started: true, sessionId };
});

// DELETE /api/parse-prd — cancel the active session
fastify.delete("/api/parse-prd", async (_request, reply) => {
  if (sessionState === "idle") {
    return reply.code(409).send({
      error: "No active parse-prd session",
      reason: "no_active_session",
    });
  }

  // Clear the simulation timer
  if (sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }

  sessionState = "idle";
  const cancelledOutcome = { status: "cancelled" as const };
  completedOutcome = cancelledOutcome;

  // Broadcast finished with cancelled outcome
  broadcast({
    type: "parse-prd:finished",
    channel: "parse-prd",
    outcome: cancelledOutcome,
  });

  sessionId = null;

  return { stopped: true };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

await fastify.listen({ port: 0, host: "127.0.0.1" });
const addr = fastify.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;

console.log(`HARNESS_PORT=${port}`);
console.log(`HARNESS_URL=http://127.0.0.1:${port}`);
console.log(`HARNESS_CWD=${cwd}`);
console.log("Smoke harness ready. Send SIGTERM to shut down.");

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function cleanup() {
  if (sessionTimer) clearInterval(sessionTimer);
  fastify.close().then(() => {
    rmSync(cwd, { recursive: true, force: true });
    process.exit(0);
  });
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
