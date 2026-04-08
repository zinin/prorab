/**
 * Integration test: parse-prd rehydration guard at the composable level.
 *
 * Verifies the full reconnect sequence:
 *   connected(parsePrdSession) → replay of parse-prd:started (suppressed) → replay:complete
 *
 * This exercises the same routing + connected-handler + rehydration flow that
 * useWebSocket.ts performs, ensuring the _rehydrating flag prevents replayed
 * lifecycle events from overwriting the authoritative server snapshot.
 *
 * Analogous to ws-no-duplicate-chat.test.ts for the chat channel.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "../../ui/src/stores/chat";
import { useExecutionStore } from "../../ui/src/stores/execution";
import { useParsePrdStore } from "../../ui/src/stores/parse-prd";
import { applyConnectedParsePrdState } from "../../ui/src/composables/parse-prd-state-mapping";
import { applyConnectedProjectState } from "../../ui/src/composables/project-state-mapping";

/**
 * Full routing + exec-switch + connected-handler simulation from useWebSocket.onmessage.
 *
 * Unlike the simpler routeWsEvent in ws-channel-routing.test.ts,
 * this exercises the connected-message handler and replay:complete sentinel
 * so the full rehydration flow is tested end-to-end.
 */
function simulateWsMessage(
  data: Record<string, unknown>,
  chatStore: ReturnType<typeof useChatStore>,
  execStore: ReturnType<typeof useExecutionStore>,
  parsePrdStore: ReturnType<typeof useParsePrdStore>,
  tasksStore: { hasPrd: boolean; hasTasksFile: boolean; hasValidTasks: boolean; hasTasksJson: boolean; wsInitialized: boolean; fetchTasks: () => void },
) {
  // ── Early routing: chat channel ──
  if (data.channel === "chat" || (typeof data.type === "string" && (data.type as string).startsWith("chat:"))) {
    chatStore.handleWsEvent(data as Parameters<typeof chatStore.handleWsEvent>[0]);
    return;
  }

  // ── Early routing: parse-prd channel ──
  if (data.channel === "parse-prd" || (typeof data.type === "string" && (data.type as string).startsWith("parse-prd:"))) {
    parsePrdStore.handleWsEvent(data as Parameters<typeof parsePrdStore.handleWsEvent>[0]);
    return;
  }

  // ── Main exec switch ──
  switch (data.type) {
    case "replay:complete":
      chatStore.setRehydrating(false);
      parsePrdStore.setRehydrating(false);
      break;
    case "connected":
      applyConnectedProjectState(tasksStore, data);
      execStore.clearEvents();
      execStore.state = (data.state as string) ?? "idle";
      chatStore.clearMessages();
      parsePrdStore.clearMessages();
      // Chat initialization (simplified — not the focus of this test)
      if (data.chatSession) {
        const cs = data.chatSession as Record<string, unknown>;
        chatStore.state = ((cs.state as string) ?? "idle") as "idle" | "active" | "question_pending" | "stopping";
        chatStore.awaitingUserInput = (cs.awaitingUserInput as boolean) ?? false;
        chatStore.sessionInfo = { agent: cs.agent as string, model: cs.model as string | undefined };
        chatStore.pendingQuestion = null;
        chatStore.setRehydrating(true);
      } else {
        chatStore.state = "idle";
        chatStore.awaitingUserInput = false;
        chatStore.sessionInfo = null;
        chatStore.pendingQuestion = null;
      }
      // Parse-prd initialization — uses the shared helper
      applyConnectedParsePrdState(parsePrdStore, data);
      break;
    case "tasks:updated":
      tasksStore.fetchTasks();
      break;
    case "agent:text":
    case "agent:tool":
    case "agent:tool_result":
    case "agent:system_prompt":
    case "agent:task_prompt": {
      const ev =
        data.type === "agent:tool"
          ? { timestamp: Date.now(), type: "tool" as const, content: data.summary as string, toolName: data.name as string }
          : data.type === "agent:tool_result"
            ? { timestamp: Date.now(), type: "tool_result" as const, content: data.summary as string }
            : { timestamp: Date.now(), type: (data.type as string).replace("agent:", "") as "text" | "system_prompt" | "task_prompt", content: data.text as string };
      execStore.addEvent(ev);
      break;
    }
  }
}

describe("No duplicate parse-prd:started handling during replay", () => {
  let chatStore: ReturnType<typeof useChatStore>;
  let execStore: ReturnType<typeof useExecutionStore>;
  let parsePrdStore: ReturnType<typeof useParsePrdStore>;
  let tasksStore: { hasPrd: boolean; hasTasksFile: boolean; hasValidTasks: boolean; hasTasksJson: boolean; wsInitialized: boolean; fetchTasks: () => void };

  beforeEach(() => {
    setActivePinia(createPinia());
    chatStore = useChatStore();
    execStore = useExecutionStore();
    parsePrdStore = useParsePrdStore();
    tasksStore = {
      hasPrd: false,
      hasTasksFile: true,
      hasValidTasks: true,
      hasTasksJson: true,
      wsInitialized: false,
      fetchTasks: vi.fn(),
    };
  });

  it("connected(parsePrdSession) → replay parse-prd:started (suppressed) → replay:complete", () => {
    // Step 1: connected message with active parse-prd session
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        hasPrd: true,
        hasTasksFile: false,
        hasValidTasks: false,
        parsePrdSession: {
          sessionId: "pprd-rehydrate-1",
          agent: "claude",
          model: "sonnet",
          variant: "high",
          state: "active",
        },
      },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // Verify: state set from connected message
    expect(parsePrdStore.state).toBe("active");
    expect(parsePrdStore.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: "high" });
    expect(parsePrdStore.outcome).toBeNull();

    // Step 2: replay sends parse-prd:started — should NOT overwrite state
    // because _rehydrating is true (set by applyConnectedParsePrdState)
    simulateWsMessage(
      {
        type: "parse-prd:started",
        channel: "parse-prd",
        agent: "claude",
        model: "sonnet",
        variant: "high",
        sessionId: "pprd-rehydrate-1",
      },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // State still "active" — not re-set by the replayed started event
    expect(parsePrdStore.state).toBe("active");
    // sessionInfo IS updated (needed for UI display)
    expect(parsePrdStore.sessionInfo).toEqual({ agent: "claude", model: "sonnet", variant: "high" });

    // Step 3: replay of agent:text events — messages ARE added
    simulateWsMessage(
      { type: "agent:text", channel: "parse-prd", text: "Reading PRD document..." },
      chatStore, execStore, parsePrdStore, tasksStore,
    );
    simulateWsMessage(
      { type: "agent:tool", channel: "parse-prd", name: "Read", summary: "Read .taskmaster/docs/prd.md" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    expect(parsePrdStore.messages.length).toBe(2);

    // Step 4: replay:complete — clears _rehydrating flag
    simulateWsMessage(
      { type: "replay:complete" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // State still active
    expect(parsePrdStore.state).toBe("active");
    // Messages preserved
    expect(parsePrdStore.messages.length).toBe(2);
  });

  it("connected(parsePrdOutcome) → replay parse-prd:started (suppressed) → replay:complete preserves terminal outcome", () => {
    // Step 1: connected with terminal outcome (session already completed)
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        hasPrd: true,
        hasTasksFile: true,
        hasValidTasks: true,
        parsePrdOutcome: { status: "success" },
      },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    expect(parsePrdStore.state).toBe("completed");
    expect(parsePrdStore.outcome).toEqual({ status: "success" });

    // Step 2: replay sends parse-prd:started — suppressed by _rehydrating
    simulateWsMessage(
      {
        type: "parse-prd:started",
        channel: "parse-prd",
        agent: "claude",
        sessionId: "pprd-done-replay",
      },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // State NOT overwritten — still completed (not reset to active)
    expect(parsePrdStore.state).toBe("completed");
    expect(parsePrdStore.outcome).toEqual({ status: "success" });

    // Step 3: replay of agent events + parse-prd:finished
    simulateWsMessage(
      { type: "agent:text", channel: "parse-prd", text: "Tasks generated" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );
    simulateWsMessage(
      { type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "success" } },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // Step 4: replay:complete
    simulateWsMessage(
      { type: "replay:complete" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // Terminal outcome persists
    expect(parsePrdStore.state).toBe("completed");
    expect(parsePrdStore.outcome).toEqual({ status: "success" });
  });

  it("after replay:complete, new parse-prd:started events update state normally", () => {
    // Step 1: connected with active session
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        parsePrdSession: {
          sessionId: "pprd-live-1",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // Step 2: replay parse-prd:started (suppressed)
    simulateWsMessage(
      { type: "parse-prd:started", channel: "parse-prd", agent: "claude", model: "sonnet", sessionId: "pprd-live-1" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // Step 3: replay:complete — flag cleared
    simulateWsMessage(
      { type: "replay:complete" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // Step 4: a genuinely NEW parse-prd:started should work normally
    simulateWsMessage(
      { type: "parse-prd:started", channel: "parse-prd", agent: "opencode", model: "gpt-4", sessionId: "pprd-new-2" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // State IS updated now (rehydrating is off)
    expect(parsePrdStore.state).toBe("active");
    expect(parsePrdStore.sessionInfo?.agent).toBe("opencode");
    expect(parsePrdStore.sessionInfo?.model).toBe("gpt-4");
  });

  it("parse-prd replay events do not leak into chat or exec stores", () => {
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
    const execAddSpy = vi.spyOn(execStore, "addEvent");

    // Connected with parse-prd session
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        parsePrdSession: {
          sessionId: "pprd-isolation",
          agent: "claude",
          state: "active",
        },
      },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // Reset spies after connected (which calls clearMessages on chatStore)
    chatSpy.mockClear();
    execAddSpy.mockClear();

    // Replay parse-prd events
    simulateWsMessage(
      { type: "parse-prd:started", channel: "parse-prd", agent: "claude", sessionId: "pprd-isolation" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );
    simulateWsMessage(
      { type: "agent:text", channel: "parse-prd", text: "Parsing PRD..." },
      chatStore, execStore, parsePrdStore, tasksStore,
    );
    simulateWsMessage(
      { type: "agent:tool", channel: "parse-prd", name: "Read", summary: "Reading prd.md" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );
    simulateWsMessage(
      { type: "parse-prd:finished", channel: "parse-prd", outcome: { status: "success" } },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // replay:complete
    simulateWsMessage(
      { type: "replay:complete" },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    // Chat store never touched
    expect(chatSpy).not.toHaveBeenCalled();
    expect(chatStore.messages.length).toBe(0);

    // Exec store never touched
    expect(execAddSpy).not.toHaveBeenCalled();

    // Parse-prd store got the messages (text + tool); lifecycle events are
    // suppressed during rehydration so state stays at what `connected` set.
    expect(parsePrdStore.messages.length).toBe(2);
    expect(parsePrdStore.state).toBe("active");
    expect(parsePrdStore.outcome).toBeNull();
  });

  it("connected with no parsePrd fields resets to idle", () => {
    // Set up previous state
    parsePrdStore.state = "completed";
    parsePrdStore.outcome = { status: "success" };

    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        // No parsePrdSession or parsePrdOutcome
      },
      chatStore, execStore, parsePrdStore, tasksStore,
    );

    expect(parsePrdStore.state).toBe("idle");
    expect(parsePrdStore.sessionInfo).toBeNull();
    expect(parsePrdStore.outcome).toBeNull();
  });
});
