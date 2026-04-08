import type { FastifyInstance } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import type { ExecutionManager } from "./execution-manager.js";
import { watch, existsSync } from "node:fs";
import { join } from "node:path";
import { WsBroadcaster, type WsEvent } from "./session/ws-broadcaster.js";
import { getProjectState } from "../core/project-state.js";
import type { ParsePrdManagerOutcome, ExpandManagerOutcome } from "../types.js";
import type { RefinePrdManagerOutcome } from "../types-refine-prd.js";
import type { RefineTasksManagerOutcome } from "../types-refine-tasks.js";

export type { WsEvent };

// Exported for explicit calls from API routes after mutations
let broadcaster: WsBroadcaster | null = null;

/**
 * Minimal interface for retrieving chat session state in the connected message.
 * Avoids importing the full ChatManager to prevent circular dependencies.
 */
export interface ChatStateProvider {
  getSession(): { id: string; agent: string; model?: string; state: string; awaitingUserInput: boolean } | null;
}

let chatState: ChatStateProvider | null = null;

/**
 * Set the chat state provider so the connected message can include active
 * chat session info. Called from serve.ts after ChatManager is created.
 */
export function setChatStateProvider(provider: ChatStateProvider): void {
  chatState = provider;
}

/**
 * Minimal interface for retrieving parse-prd session state and terminal outcome
 * in the connected message. Avoids importing the full ParsePrdManager to prevent
 * circular dependencies.
 */
export interface ParsePrdStateProvider {
  getSession(): { id: string; agent: string; model?: string; variant?: string; state: string } | null;
  getOutcome(): ParsePrdManagerOutcome | null;
}

let parsePrdState: ParsePrdStateProvider | null = null;

/**
 * Set the parse-prd state provider so the connected message can include active
 * parse-prd session info and terminal outcome. Called from serve.ts after
 * ParsePrdManager is created.
 */
export function setParsePrdStateProvider(provider: ParsePrdStateProvider): void {
  parsePrdState = provider;
}

/**
 * Minimal interface for retrieving expand session state and terminal outcome
 * in the connected message. Avoids importing the full ExpandManager to prevent
 * circular dependencies.
 */
export interface ExpandStateProvider {
  getSession(): { id: string; taskId: string; agent: string; model?: string; variant?: string; state: string } | null;
  getOutcome(): ExpandManagerOutcome | null;
}

let expandState: ExpandStateProvider | null = null;

/**
 * Set the expand state provider so the connected message can include active
 * expand session info and terminal outcome. Called from serve.ts after
 * ExpandManager is created.
 */
export function setExpandStateProvider(provider: ExpandStateProvider): void {
  expandState = provider;
}

/**
 * Minimal interface for retrieving refine-prd session state and terminal outcome
 * in the connected message. Avoids importing the full RefinePrdManager.
 */
export interface RefinePrdStateProvider {
  getSession(): {
    id: string;
    steps: Array<{ agent: string; model?: string; variant?: string }>;
    currentStepIndex: number;
    stepState: string;
    pendingQuestionId: string | null;
    pendingQuestionData: { questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>; source: "claude" | "opencode" } | null;
  } | null;
  getOutcome(): RefinePrdManagerOutcome | null;
}

let refinePrdState: RefinePrdStateProvider | null = null;

export function setRefinePrdStateProvider(provider: RefinePrdStateProvider): void {
  refinePrdState = provider;
}

/**
 * Minimal interface for retrieving refine-tasks session state and terminal outcome
 * in the connected message. Avoids importing the full RefineTasksManager.
 */
export interface RefineTasksStateProvider {
  getSession(): {
    id: string;
    steps: Array<{ agent: string; model?: string; variant?: string }>;
    currentStepIndex: number;
    stepState: string;
    pendingQuestionId: string | null;
    pendingQuestionData: { questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }>; source: "claude" | "opencode" } | null;
  } | null;
  getOutcome(): RefineTasksManagerOutcome | null;
}

let refineTasksState: RefineTasksStateProvider | null = null;

export function setRefineTasksStateProvider(provider: RefineTasksStateProvider): void {
  refineTasksState = provider;
}

/**
 * Minimal interface for retrieving batch-expand state in the connected message.
 * Avoids importing the full BatchExpandManager to prevent circular dependencies.
 */
export interface BatchExpandStateProvider {
  getState(): {
    state: string;
    slots: Array<{ slotIndex: number; taskId: number | null; phase: string }>;
    summary: Array<{
      taskId: number;
      taskTitle: string;
      complexityScore: number | null;
      recommendedSubtasks: number | null;
      subtaskCount: number | null;
      skipped: boolean;
      error: string | null;
      status: string;
    }>;
    progress: { completed: number; total: number; errors: number; skipped: number };
    outcome: unknown | null;
  };
}

let batchExpandState: BatchExpandStateProvider | null = null;

/**
 * Set the batch-expand state provider so the connected message can include
 * batch-expand state. Called from serve.ts after BatchExpandManager is created.
 */
export function setBatchExpandStateProvider(provider: BatchExpandStateProvider): void {
  batchExpandState = provider;
}

export function broadcastTasksUpdated(): void {
  broadcaster?.broadcast({ type: "tasks:updated" });
}

/**
 * Apply default channel to agent:* events that don't already have one.
 * Returns a new event with `channel: 'execute'` set, or the original
 * event unchanged if it already has a channel or isn't an agent:* event.
 *
 * Ensures backward compatibility — consumers always receive a channel
 * field on agent events regardless of the call site.
 */
export function applyDefaultChannel(event: WsEvent): WsEvent {
  if (
    event.type.startsWith("agent:") &&
    !event.channel
  ) {
    return { ...event, channel: "execute" };
  }
  return event;
}

export async function setupWebSocket(
  fastify: FastifyInstance,
  executionManager: ExecutionManager,
  cwd: string,
): Promise<WsBroadcaster> {
  await fastify.register(fastifyWebsocket);

  const clients = new Set<import("@fastify/websocket").WebSocket>();
  const bc = new WsBroadcaster(clients as unknown as Set<{ readyState: number; send(data: string): void }>);
  broadcaster = bc;

  // Inject broadcaster into ExecutionManager so it can broadcast events directly
  executionManager.setBroadcaster(bc);

  // [C6] Watch DIRECTORY, not file — fs.watch on a file loses
  // subscription when inode changes (atomic write = temp + rename).
  const tasksDir = join(cwd, ".taskmaster", "tasks");
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  if (existsSync(tasksDir)) {
    try {
      const watcher = watch(tasksDir, (_eventType, filename) => {
        if (filename !== "tasks.json") return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          bc.broadcast({ type: "tasks:updated" });
        }, 200);
      });
      // Clean up watcher on server close
      fastify.addHook("onClose", () => {
        watcher.close();
      });
    } catch {
      // Directory may not be watchable
    }
  }

  // WebSocket endpoint
  fastify.get("/ws", { websocket: true }, (socket) => {
    clients.add(socket);

    // Send current state on connect (filter currentUnit to avoid leaking full Task object)
    const unit = executionManager.currentUnit;
    const chatSession = chatState?.getSession() ?? null;
    const parsePrdSession = parsePrdState?.getSession() ?? null;
    const parsePrdOutcome = parsePrdState?.getOutcome() ?? null;
    const expandSession = expandState?.getSession() ?? null;
    const expandOutcome = expandState?.getOutcome() ?? null;
    const refinePrdSession = refinePrdState?.getSession() ?? null;
    const refinePrdOutcome = refinePrdState?.getOutcome() ?? null;
    const refineTasksSession = refineTasksState?.getSession() ?? null;
    const refineTasksOutcome = refineTasksState?.getOutcome() ?? null;
    const projectState = getProjectState(cwd);
    socket.send(
      JSON.stringify({
        type: "connected",
        state: executionManager.state,
        currentUnit: unit
          ? { type: unit.type, taskId: unit.taskId, subtaskId: unit.subtaskId ?? "", title: unit.title }
          : null,
        iterationCurrent: executionManager.iterationCurrent,
        iterationTotal: executionManager.iterationTotal,
        gracefulStop: executionManager.gracefulStop,
        // Full project-state — the primary contract for UI
        hasPrd: projectState.hasPrd,
        hasTasksFile: projectState.hasTasksFile,
        hasValidTasks: projectState.hasValidTasks,
        // Backward-compatible alias — legacy frontend reads hasTasksJson
        hasTasksJson: projectState.hasTasksFile,
        chatSession: chatSession
          ? { sessionId: chatSession.id, agent: chatSession.agent, model: chatSession.model, state: chatSession.state, awaitingUserInput: chatSession.awaitingUserInput }
          : null,
        parsePrdSession: parsePrdSession
          ? { sessionId: parsePrdSession.id, agent: parsePrdSession.agent, model: parsePrdSession.model, variant: parsePrdSession.variant, state: parsePrdSession.state }
          : null,
        parsePrdOutcome,
        expandSession: expandSession
          ? { sessionId: expandSession.id, taskId: expandSession.taskId, agent: expandSession.agent, model: expandSession.model, variant: expandSession.variant, state: expandSession.state }
          : null,
        expandOutcome,
        refinePrdSession: refinePrdSession
          ? {
              sessionId: refinePrdSession.id,
              steps: refinePrdSession.steps,
              currentStepIndex: refinePrdSession.currentStepIndex,
              stepState: refinePrdSession.stepState,
              // Extract current step's agent/model for UI display
              agent: refinePrdSession.steps[refinePrdSession.currentStepIndex]?.agent,
              model: refinePrdSession.steps[refinePrdSession.currentStepIndex]?.model,
              // Include pending question data for rehydration
              ...(refinePrdSession.stepState === "question_pending" && refinePrdSession.pendingQuestionData
                ? {
                    pendingQuestion: {
                      questionId: refinePrdSession.pendingQuestionId,
                      questions: refinePrdSession.pendingQuestionData.questions,
                      source: refinePrdSession.pendingQuestionData.source,
                    },
                  }
                : {}),
            }
          : null,
        refinePrdOutcome,
        refineTasksSession: refineTasksSession
          ? {
              sessionId: refineTasksSession.id,
              steps: refineTasksSession.steps,
              currentStepIndex: refineTasksSession.currentStepIndex,
              stepState: refineTasksSession.stepState,
              // Extract current step's agent/model for UI display
              agent: refineTasksSession.steps[refineTasksSession.currentStepIndex]?.agent,
              model: refineTasksSession.steps[refineTasksSession.currentStepIndex]?.model,
              // Include pending question data for rehydration
              ...(refineTasksSession.stepState === "question_pending" && refineTasksSession.pendingQuestionData
                ? {
                    pendingQuestion: {
                      questionId: refineTasksSession.pendingQuestionId,
                      questions: refineTasksSession.pendingQuestionData.questions,
                      source: refineTasksSession.pendingQuestionData.source,
                    },
                  }
                : {}),
            }
          : null,
        refineTasksOutcome,
        batchExpandState: batchExpandState?.getState() ?? null,
      }),
    );

    // Replay buffered events so the client recovers full history
    bc.replay(socket as unknown as { readyState: number; send(data: string): void });

    // Signal that replay is complete — client uses this to clear the
    // rehydration guard instead of an unreliable setTimeout(0).
    socket.send(JSON.stringify({ type: "replay:complete" }));

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "execution:stop") {
          executionManager.stop();
        }
      } catch {
        // Ignore malformed messages
      }
    });

    socket.on("error", () => {
      clients.delete(socket);
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  return bc;
}
