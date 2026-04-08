/**
 * Standalone scripted harness for task-list browser smoke tests.
 *
 * Starts a Fastify server that serves the Vue SPA with project state:
 *   - Valid tasks.json with sample tasks
 *   - PRD present (hasPrd=true)
 *   - hasTasksFile=true, hasValidTasks=true
 *
 * This triggers the "task-list" view mode — the user sees a table of tasks.
 *
 * Does NOT require a live LLM — all data is static.
 *
 * Usage:
 *   npx tsx src/__tests__/harness/task-list-smoke-server.ts
 *
 * The server prints HARNESS_PORT=<port> and HARNESS_URL=<url> on stdout.
 * Send SIGTERM to shut down cleanly (cleans up temp directory).
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
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
// Fixture: temp directory with valid tasks.json and PRD
// ---------------------------------------------------------------------------

const cwd = mkdtempSync(join(tmpdir(), "task-list-smoke-"));
mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });

// Write a PRD
writeFileSync(
  join(cwd, ".taskmaster", "docs", "prd.md"),
  "# Sample PRD\n\nThis is a sample PRD for browser smoke testing.\n",
);

// Write a valid tasks.json
const sampleTasks = {
  tasks: [
    {
      id: 1,
      title: "Set up project scaffolding",
      description: "Create the initial project structure with necessary configuration.",
      status: "done",
      dependencies: [],
      priority: "high",
      subtasks: [],
    },
    {
      id: 2,
      title: "Implement user authentication",
      description: "Add login and registration with JWT tokens.",
      status: "in-progress",
      dependencies: [1],
      priority: "high",
      subtasks: [
        { id: 1, title: "Create login form", status: "done" },
        { id: 2, title: "Add JWT middleware", status: "in-progress" },
      ],
    },
    {
      id: 3,
      title: "Build dashboard analytics",
      description: "Create analytics dashboard with charts and metrics.",
      status: "pending",
      dependencies: [1, 2],
      priority: "medium",
      subtasks: [],
    },
    {
      id: 4,
      title: "Add report generation",
      description: "Implement PDF and CSV report generation for admin users.",
      status: "pending",
      dependencies: [3],
      priority: "low",
      subtasks: [],
    },
  ],
  metadata: {
    projectName: "Smoke Test Project",
    totalTasks: 4,
    sourceFile: "prd.md",
    generatedAt: "2026-03-08T10:00:00.000Z",
  },
};

writeFileSync(
  join(cwd, ".taskmaster", "tasks", "tasks.json"),
  JSON.stringify(sampleTasks, null, 2),
);

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
    hasPrd: true,
    hasTasksFile: true,
    hasValidTasks: true,
    hasTasksJson: true,
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
  // Send connected message with valid tasks state
  socket.send(JSON.stringify(buildConnectedMessage()));

  // Send replay:complete sentinel
  socket.send(JSON.stringify({ type: "replay:complete" }));
});

// ---------------------------------------------------------------------------
// API endpoints
// ---------------------------------------------------------------------------

// GET /api/status — project state: valid tasks
fastify.get("/api/status", async () => ({
  state: "idle",
  hasPrd: true,
  hasTasksFile: true,
  hasValidTasks: true,
  hasTasksJson: true,
}));

// GET /api/models — available models
fastify.get("/api/models", async () => ({
  models: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
  ],
}));

// GET /api/tasks — return the sample tasks
fastify.get("/api/tasks", async () => sampleTasks);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

await fastify.listen({ port: 0, host: "127.0.0.1" });
const addr = fastify.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;

console.log(`HARNESS_PORT=${port}`);
console.log(`HARNESS_URL=http://127.0.0.1:${port}`);
console.log(`HARNESS_CWD=${cwd}`);
console.log("Task-list smoke harness ready. Send SIGTERM to shut down.");

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
