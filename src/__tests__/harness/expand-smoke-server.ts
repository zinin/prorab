/**
 * Standalone scripted harness for expand browser smoke tests.
 *
 * Starts a Fastify server that serves the Vue SPA and implements the minimum
 * API surface for the expand workflow (status, models, tasks, expand CRUD, WS).
 * Does NOT require a live LLM — events are scripted/simulated.
 *
 * Usage:
 *   npx tsx src/__tests__/harness/expand-smoke-server.ts
 *   npx tsx src/__tests__/harness/expand-smoke-server.ts --mode=failure
 *
 * The server prints HARNESS_PORT=<port> and HARNESS_URL=<url> on stdout.
 * It creates a temp fixture directory with a valid tasks.json containing
 * a pending task suitable for expand.
 *
 * Query parameters on POST /api/tasks/:id/expand:
 *   ?mode=failure — terminate after scripted steps with a validation_failed outcome
 *                   (default: complete successfully with 3 subtasks)
 *
 * Send SIGTERM to shut down cleanly (cleans up temp directory).
 */

import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDistPath = join(__dirname, "..", "..", "..", "ui", "dist");

// Parse CLI args for mode
const cliMode = process.argv.find((a) => a.startsWith("--mode="))?.split("=")[1] ?? "default";

// ---------------------------------------------------------------------------
// Fixture: temp directory with valid tasks.json and PRD
// ---------------------------------------------------------------------------

const cwd = mkdtempSync(join(tmpdir(), "expand-smoke-"));
mkdirSync(join(cwd, ".taskmaster", "docs"), { recursive: true });
mkdirSync(join(cwd, ".taskmaster", "tasks"), { recursive: true });

writeFileSync(
  join(cwd, ".taskmaster", "docs", "prd.md"),
  "# Sample PRD\n\nExpand smoke test PRD.\n\n## Features\n1. User authentication\n2. Dashboard\n",
);

const sampleTasks = {
  tasks: [
    {
      id: 1,
      title: "Build user authentication",
      description: "Implement user auth with JWT tokens",
      details: "Create login/logout endpoints with token management and refresh",
      status: "pending",
      dependencies: [],
      priority: "high",
      subtasks: [],
    },
    {
      id: 2,
      title: "Add structured logging",
      description: "Add structured logging throughout the app",
      status: "done",
      dependencies: [],
      priority: "medium",
      subtasks: [],
    },
    {
      id: 3,
      title: "Write API documentation",
      description: "Document all REST endpoints",
      status: "pending",
      dependencies: [2],
      priority: "low",
      subtasks: [],
    },
  ],
  metadata: {
    projectName: "expand-smoke-test",
    totalTasks: 3,
    sourceFile: "prd.md",
    generatedAt: new Date().toISOString(),
  },
};

writeFileSync(
  join(cwd, ".taskmaster", "tasks", "tasks.json"),
  JSON.stringify(sampleTasks, null, 2),
);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type SessionState = "idle" | "active" | "stopping";

let sessionState: SessionState = "idle";
let sessionId: string | null = null;
let sessionTaskId: string | null = null;
let sessionTimer: ReturnType<typeof setInterval> | null = null;
let completedOutcome: Record<string, unknown> | null = null;

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

function readCurrentTasks(): typeof sampleTasks {
  return JSON.parse(
    readFileSync(join(cwd, ".taskmaster", "tasks", "tasks.json"), "utf8"),
  );
}

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
    expandSession:
      sessionState !== "idle" && sessionId
        ? {
            sessionId,
            taskId: sessionTaskId,
            agent: "claude",
            model: undefined,
            variant: undefined,
            state: sessionState,
          }
        : null,
    expandOutcome: completedOutcome,
  };
}

// ---------------------------------------------------------------------------
// Scripted subtasks result (agent output)
// ---------------------------------------------------------------------------

const SCRIPTED_SUBTASKS = [
  {
    id: 1,
    title: "Set up authentication module",
    description: "Create the auth module with JWT token management",
    details: "Implement JWT token generation, validation, and refresh logic",
    dependencies: [] as number[],
    testStrategy: "Unit tests for token generation and validation",
  },
  {
    id: 2,
    title: "Implement login endpoint",
    description: "Create POST /api/auth/login with credential validation",
    details: "Validate email/password, issue JWT, return token",
    dependencies: [1],
    testStrategy: "Integration tests with mock database",
  },
  {
    id: 3,
    title: "Add logout and session cleanup",
    description: "Implement logout endpoint and token revocation",
    details: "Maintain token blacklist for revoked tokens",
    dependencies: [1, 2],
  },
];

/**
 * Write subtasks into tasks.json to simulate the file-writing part
 * of the expand pipeline.
 */
function writeSubtasksToFile(taskId: string): void {
  const data = readCurrentTasks();
  const task = data.tasks.find((t) => String(t.id) === taskId);
  if (task) {
    task.subtasks = SCRIPTED_SUBTASKS.map((s) => ({
      ...s,
      status: "pending" as const,
    })) as any;
  }
  writeFileSync(
    join(cwd, ".taskmaster", "tasks", "tasks.json"),
    JSON.stringify(data, null, 2),
  );
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

  socket.send(JSON.stringify(buildConnectedMessage()));
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

// GET /api/status
fastify.get("/api/status", async () => ({
  state: "idle",
  hasPrd: true,
  hasTasksFile: true,
  hasValidTasks: true,
  hasTasksJson: true,
}));

// GET /api/models
fastify.get("/api/models", async () => ({
  models: [
    { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4" },
    { id: "claude-opus-4-20250514", name: "Claude Opus 4" },
  ],
}));

// GET /api/tasks
fastify.get("/api/tasks", async () => {
  try {
    return readCurrentTasks();
  } catch {
    return { tasks: [] };
  }
});

// GET /api/expand — current expand state
fastify.get("/api/expand", async () => ({
  state: sessionState === "idle" && !completedOutcome ? "idle" : sessionState !== "idle" ? sessionState : "idle",
  session: sessionState !== "idle" && sessionId
    ? { id: sessionId, taskId: sessionTaskId, agent: "claude", state: sessionState }
    : null,
  outcome: completedOutcome,
}));

// POST /api/tasks/:id/expand — start a scripted expand session
fastify.post<{ Params: { id: string } }>(
  "/api/tasks/:id/expand",
  async (request, reply) => {
    const taskId = request.params.id;
    const query = request.query as Record<string, string>;
    const mode = query.mode ?? cliMode;

    if (sessionState !== "idle") {
      return reply.code(409).send({
        error: "Another session is active",
        reason: "active_session",
      });
    }

    // Validate task exists and is pending
    const data = readCurrentTasks();
    const task = data.tasks.find((t) => String(t.id) === taskId);
    if (!task) {
      return reply.code(404).send({
        error: `Task ${taskId} not found`,
        reason: "task_not_found",
      });
    }
    if (task.status !== "pending") {
      return reply.code(409).send({
        error: `Task ${taskId} has status "${task.status}"`,
        reason: "task_not_pending",
      });
    }
    if (task.subtasks && task.subtasks.length > 0) {
      return reply.code(409).send({
        error: `Task ${taskId} already has subtasks`,
        reason: "task_has_subtasks",
      });
    }

    sessionId = randomUUID();
    sessionTaskId = taskId;
    sessionState = "active";
    completedOutcome = null;

    // Broadcast expand:started
    broadcast({
      type: "expand:started",
      channel: "expand",
      sessionId,
      taskId,
      agent: "claude",
    });

    // Broadcast system prompt
    broadcast({
      type: "agent:system_prompt",
      channel: "expand",
      text: "You are a task decomposition agent. Analyze the task and break it into subtasks.",
    });

    // Broadcast task prompt
    broadcast({
      type: "agent:task_prompt",
      channel: "expand",
      text: `Expand task ${taskId}: ${task.title}\n\n${task.description}\n\nDetails: ${task.details}`,
    });

    // Simulate agent work with scripted events
    let step = 0;
    const steps = [
      { type: "agent:text", text: "Analyzing task structure and requirements...\n" },
      { type: "agent:tool", name: "Read", summary: "Reading project structure" },
      { type: "agent:tool_result", summary: "Found 12 source files" },
      { type: "agent:text", text: "Identifying decomposition points...\n" },
      { type: "agent:tool", name: "Grep", summary: "Searching for auth patterns" },
      { type: "agent:tool_result", summary: "Found 3 relevant patterns" },
      { type: "agent:text", text: "Generating subtask breakdown...\n" },
    ];

    sessionTimer = setInterval(() => {
      if (sessionState !== "active") {
        if (sessionTimer) clearInterval(sessionTimer);
        return;
      }

      if (step < steps.length) {
        broadcast({ ...steps[step], channel: "expand" });
      } else {
        // Terminal step
        if (sessionTimer) clearInterval(sessionTimer);
        sessionTimer = null;

        if (mode === "failure") {
          // Failure mode: validation error
          const failureOutcome = {
            status: "failure" as const,
            taskId,
            reason: "validation_failed",
            errors: [
              "subtask IDs must be sequential starting from 1",
              "forward dependency reference: subtask 1 depends on subtask 3",
            ],
            message: "Validation failed: subtask IDs must be sequential starting from 1",
            subtaskCount: 0,
          };

          broadcast({
            type: "expand:error",
            channel: "expand",
            message: failureOutcome.message,
            reason: "validation_failed",
          });

          completedOutcome = failureOutcome;
          sessionState = "idle";

          broadcast({
            type: "expand:finished",
            channel: "expand",
            outcome: failureOutcome,
          });

          sessionId = null;
          sessionTaskId = null;
        } else {
          // Success mode: write subtasks and complete
          writeSubtasksToFile(taskId);

          // Broadcast tasks:updated
          broadcast({ type: "tasks:updated" });

          const successOutcome = {
            status: "success" as const,
            taskId,
            subtaskCount: 3,
          };

          completedOutcome = null; // Success outcomes are cleared
          sessionState = "idle";

          broadcast({
            type: "expand:finished",
            channel: "expand",
            outcome: successOutcome,
          });

          sessionId = null;
          sessionTaskId = null;
        }
      }

      step++;
    }, 400);

    return { started: true, sessionId, taskId };
  },
);

// DELETE /api/tasks/:id/expand — cancel the active expand session
fastify.delete<{ Params: { id: string } }>(
  "/api/tasks/:id/expand",
  async (request, reply) => {
    const taskId = request.params.id;

    if (sessionState === "idle") {
      return reply.code(409).send({
        error: "No active expand session",
        reason: "no_active_session",
      });
    }

    if (sessionTaskId !== taskId) {
      return reply.code(409).send({
        error: `Active expand session is for task ${sessionTaskId}`,
        reason: "task_mismatch",
        activeTaskId: sessionTaskId,
      });
    }

    if (sessionTimer) {
      clearInterval(sessionTimer);
      sessionTimer = null;
    }

    const cancelledOutcome = {
      status: "cancelled" as const,
      taskId,
      subtaskCount: 0,
    };
    completedOutcome = cancelledOutcome;
    sessionState = "idle";

    broadcast({
      type: "expand:finished",
      channel: "expand",
      outcome: cancelledOutcome,
    });

    sessionId = null;
    sessionTaskId = null;

    return { stopped: true };
  },
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

await fastify.listen({ port: 0, host: "127.0.0.1" });
const addr = fastify.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;

console.log(`HARNESS_PORT=${port}`);
console.log(`HARNESS_URL=http://127.0.0.1:${port}`);
console.log(`HARNESS_CWD=${cwd}`);
console.log(`HARNESS_MODE=${cliMode}`);
console.log("Expand smoke harness ready. Send SIGTERM to shut down.");

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
