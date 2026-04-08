/**
 * Standalone scripted harness for chat-wizard browser smoke tests.
 *
 * Starts a Fastify server that serves the Vue SPA with project state:
 *   - No PRD (hasPrd=false)
 *   - No tasks.json (hasTasksFile=false, hasValidTasks=false)
 *
 * This triggers the "wizard-chat" view mode — the user sees a chat wizard
 * with "No tasks yet" and "Describe your idea below..." messaging.
 *
 * Does NOT require a live LLM — no session endpoints implemented.
 *
 * Usage:
 *   npx tsx src/__tests__/harness/chat-wizard-smoke-server.ts
 *
 * The server prints HARNESS_PORT=<port> and HARNESS_URL=<url> on stdout.
 * Send SIGTERM to shut down cleanly (cleans up temp directory).
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDistPath = join(__dirname, "..", "..", "..", "ui", "dist");

// ---------------------------------------------------------------------------
// Fixture: temp directory with neither PRD nor tasks.json
// ---------------------------------------------------------------------------

const cwd = mkdtempSync(join(tmpdir(), "chat-wizard-smoke-"));
// Empty fixture — no .taskmaster directory at all

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function buildConnectedMessage() {
  return {
    type: "connected",
    state: "idle",
    currentUnit: null,
    iterationCurrent: null,
    iterationTotal: null,
    hasPrd: false,
    hasTasksFile: false,
    hasValidTasks: false,
    hasTasksJson: false,
    chatSession: null,
    parsePrdSession: null,
    parsePrdOutcome: null,
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
  // Send connected message with no-PRD, no-tasks state
  socket.send(JSON.stringify(buildConnectedMessage()));

  // Send replay:complete sentinel
  socket.send(JSON.stringify({ type: "replay:complete" }));
});

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

// GET /api/status — project state: no PRD, no tasks
fastify.get("/api/status", async () => ({
  state: "idle",
  hasPrd: false,
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

// GET /api/tasks — no tasks
fastify.get("/api/tasks", async () => ({ tasks: [] }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

await fastify.listen({ port: 0, host: "127.0.0.1" });
const addr = fastify.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;

console.log(`HARNESS_PORT=${port}`);
console.log(`HARNESS_URL=http://127.0.0.1:${port}`);
console.log(`HARNESS_CWD=${cwd}`);
console.log("Chat-wizard smoke harness ready. Send SIGTERM to shut down.");

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

function cleanup() {
  fastify.close().then(() => {
    rmSync(cwd, { recursive: true, force: true });
    process.exit(0);
  });
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
