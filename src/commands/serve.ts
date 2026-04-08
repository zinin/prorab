import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { statusRoutes } from "../server/routes/status.js";
import { tasksRoutes } from "../server/routes/tasks.js";
import { reportsRoutes } from "../server/routes/reports.js";
import { executionRoutes } from "../server/routes/execution.js";
import { chatRoutes } from "../server/routes/chat.js";
import { parsePrdRoutes } from "../server/routes/parse-prd.js";
import { refinePrdRoutes } from "../server/routes/refine-prd.js";
import { modelsRoutes } from "../server/routes/models.js";
import { expandRoutes } from "../server/routes/expand.js";
import { batchExpandRoutes } from "../server/routes/batch-expand.js";
import { ExecutionManager } from "../server/execution-manager.js";
import { ChatManager } from "../server/chat-manager.js";
import { ParsePrdManager } from "../server/parse-prd-manager.js";
import { RefinePrdManager } from "../server/refine-prd-manager.js";
import { ExpandManager } from "../server/expand-manager.js";
import { BatchExpandManager } from "../server/batch-expand-manager.js";
import { SessionCore } from "../server/session/session-core.js";
import { RefineTasksManager } from "../server/refine-tasks-manager.js";
import { refineTasksRoutes } from "../server/routes/refine-tasks.js";
import { setupWebSocket, setChatStateProvider, setParsePrdStateProvider, setRefinePrdStateProvider, setRefineTasksStateProvider, setExpandStateProvider, setBatchExpandStateProvider } from "../server/ws.js";

export const ServeOptionsSchema = z.object({
  port: z.coerce.number().int().positive().max(65535).default(3000),
  open: z.boolean().default(false),
});

export type ServeOptions = z.infer<typeof ServeOptionsSchema>;

/** Guard to ensure the unhandledRejection handler is registered at most once. */
let rejectionHandlerInstalled = false;

function installRejectionHandler(): void {
  if (rejectionHandlerInstalled) return;
  rejectionHandlerInstalled = true;

  // Defense-in-depth: prevent unhandled promise rejections from crashing the
  // server. The Claude Agent SDK may emit rejections during abort flows that
  // cannot be caught at the driver level (e.g. internal write after abort).
  process.on("unhandledRejection", (reason) => {
    // Check for AbortError by error name first (most reliable), then fall back
    // to message matching with word-boundary-aware patterns to avoid false
    // positives on unrelated strings that happen to contain "abort".
    if (reason instanceof Error && reason.name === "AbortError") return;
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (/\babort(ed)?\b/i.test(msg)) return;

    console.error("[prorab] unhandled rejection:", msg);
  });
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  installRejectionHandler();

  // Allow spawning Claude Code SDK sessions even when prorab itself is launched
  // from within a Claude Code session. The SDK checks this env var and refuses
  // to start if it detects nesting.
  delete process.env.CLAUDECODE;

  const cwd = process.cwd();
  const fastify = Fastify({ logger: false });
  const executionManager = new ExecutionManager(cwd);

  // Serve Vue SPA from ui/dist if it exists
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const uiDistPath = join(__dirname, "..", "..", "ui", "dist");
  if (existsSync(uiDistPath)) {
    await fastify.register(fastifyStatic, {
      root: uiDistPath,
      prefix: "/",
      wildcard: false,
    });
    // SPA fallback: serve index.html for all non-API routes
    fastify.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/ws")) {
        reply.code(404).send({ error: "Not found" });
      } else {
        reply.sendFile("index.html");
      }
    });
  }

  // WebSocket (must be set up before chat routes so broadcaster is available)
  const broadcaster = await setupWebSocket(fastify, executionManager, cwd);

  // Chat manager — uses its own SessionCore to avoid conflicting with execution
  const chatSessionCore = new SessionCore(cwd);
  const chatManager = new ChatManager(cwd, chatSessionCore, broadcaster);

  // Wire chat state into WS connected message (ChatManager broadcasts chat:*
  // events through the shared WsBroadcaster directly — no EventEmitter needed)
  setChatStateProvider(chatManager);

  // Parse-PRD manager — uses its own SessionCore (separate from chat and execution)
  const parsePrdSessionCore = new SessionCore(cwd);
  const parsePrdManager = new ParsePrdManager(cwd, parsePrdSessionCore, broadcaster);

  // Wire parse-prd state into WS connected message (ParsePrdManager broadcasts
  // parse-prd:* events through the shared WsBroadcaster directly)
  setParsePrdStateProvider(parsePrdManager);

  // Refine-PRD manager — shares SessionCore with parse-prd to ensure
  // mutual exclusivity (only one can hold the lock at a time).
  // This enables the release-then-acquire handoff pattern.
  const refinePrdManager = new RefinePrdManager(cwd, parsePrdSessionCore, broadcaster);
  refinePrdManager.setParsePrdManager(parsePrdManager);

  // Wire refine-prd state into WS connected message
  setRefinePrdStateProvider(refinePrdManager);

  // Refine-Tasks manager — shares SessionCore with parse-prd and refine-prd
  const refineTasksManager = new RefineTasksManager(cwd, parsePrdSessionCore, broadcaster);
  parsePrdManager.setRefineTasksManager(refineTasksManager);
  setRefineTasksStateProvider(refineTasksManager);

  // Expand manager — uses its own SessionCore (separate from chat, parse-prd, and execution)
  const expandSessionCore = new SessionCore(cwd);
  const expandManager = new ExpandManager(cwd, expandSessionCore, broadcaster);

  // Wire expand state into WS connected message (ExpandManager broadcasts
  // expand:* events through the shared WsBroadcaster directly)
  setExpandStateProvider(expandManager);

  // Batch-expand manager — no SessionCore (manages its own parallel agents)
  const batchExpandManager = new BatchExpandManager(cwd, broadcaster);

  // Wire batch-expand state into WS connected message
  setBatchExpandStateProvider(batchExpandManager);

  // Helper: check if any single-session manager is active (for conflict detection)
  const isAnySessionActive = () =>
    executionManager.state !== "idle" ||
    chatManager.getState() !== "idle" ||
    parsePrdManager.getState() !== "idle" ||
    refinePrdManager.getState() !== "idle" ||
    refineTasksManager.getState() !== "idle" ||
    expandManager.getState() !== "idle" ||
    (batchExpandManager.getState().state !== "idle" && batchExpandManager.getState().state !== "finished");

  // Closure: check if batch-expand is running (for cross-session conflict checks)
  const isBatchExpandActive = () => {
    const s = batchExpandManager.getState().state;
    return s === "active" || s === "stopping";
  };

  // API routes
  await fastify.register(statusRoutes(executionManager, cwd));
  await fastify.register(tasksRoutes(cwd));
  await fastify.register(reportsRoutes(cwd));
  await fastify.register(executionRoutes(executionManager, cwd, isBatchExpandActive));
  await fastify.register(chatRoutes(chatManager, cwd, isBatchExpandActive));
  await fastify.register(parsePrdRoutes(parsePrdManager, cwd, isBatchExpandActive));
  await fastify.register(refinePrdRoutes(refinePrdManager, cwd, isAnySessionActive, isBatchExpandActive));
  await fastify.register(refineTasksRoutes(refineTasksManager, cwd, isAnySessionActive, isBatchExpandActive));
  await fastify.register(expandRoutes(expandManager, cwd, isBatchExpandActive));
  await fastify.register(batchExpandRoutes(batchExpandManager, cwd, isAnySessionActive));
  await fastify.register(modelsRoutes());

  await fastify.listen({ port: options.port, host: "127.0.0.1" });
  console.log(`prorab serve — running at http://127.0.0.1:${options.port}`);

  if (options.open) {
    const { execFile } = await import("node:child_process");
    const url = `http://127.0.0.1:${options.port}`;
    if (process.platform === "darwin") {
      execFile("open", [url]);
    } else if (process.platform === "win32") {
      execFile("cmd", ["/c", "start", url]);
    } else {
      execFile("xdg-open", [url]);
    }
  }

  // Graceful shutdown — wait for execution to finish before exiting (C5)
  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    batchExpandManager.stop();
    await batchExpandManager.waitForFinished();
    const activeExpandTaskId = expandManager.getSession()?.taskId;
    if (activeExpandTaskId) await expandManager.stop(activeExpandTaskId);
    await refineTasksManager.stop();
    await refinePrdManager.stop();
    await parsePrdManager.stop();
    await chatManager.stop();
    executionManager.stop();
    if (executionManager.state !== "idle") {
      const timeout = setTimeout(() => {
        console.error("Shutdown timed out, forcing exit.");
        process.exit(1);
      }, 30_000);
      await executionManager.waitForIdle();
      clearTimeout(timeout);
    }
    await fastify.close();
    process.exit(0);
  });
}
