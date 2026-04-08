/**
 * Integration test: expand rehydration guard at the composable level.
 *
 * Verifies the full reconnect sequence:
 *   connected(expandSession) → replay of expand:started (suppressed) → replay:complete
 *
 * This exercises the same routing + connected-handler + rehydration flow that
 * useWebSocket.ts performs, ensuring the _rehydrating flag prevents replayed
 * lifecycle events from overwriting the authoritative server snapshot.
 *
 * Analogous to ws-no-duplicate-parse-prd.test.ts for the parse-prd channel
 * and ws-no-duplicate-chat.test.ts for the chat channel.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "../../ui/src/stores/chat";
import { useExecutionStore } from "../../ui/src/stores/execution";
import { useParsePrdStore } from "../../ui/src/stores/parse-prd";
import { useExpandStore } from "../../ui/src/stores/expand";
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
  expandStore: ReturnType<typeof useExpandStore>,
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

  // ── Early routing: expand channel ──
  if (data.channel === "expand" || (typeof data.type === "string" && (data.type as string).startsWith("expand:"))) {
    expandStore.handleWsEvent(data as Parameters<typeof expandStore.handleWsEvent>[0]);
    return;
  }

  // ── Main exec switch ──
  switch (data.type) {
    case "replay:complete":
      chatStore.setRehydrating(false);
      parsePrdStore.setRehydrating(false);
      expandStore.setRehydrating(false);
      break;
    case "connected":
      applyConnectedProjectState(tasksStore, data);
      execStore.clearEvents();
      execStore.state = (data.state as string) ?? "idle";
      chatStore.clearMessages();
      parsePrdStore.clearMessages();
      expandStore.clearMessages();
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
      // Expand initialization — uses the store's rehydrateFromConnected action
      expandStore.rehydrateFromConnected(data);
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

describe("No duplicate expand:started handling during replay (frontend)", () => {
  let chatStore: ReturnType<typeof useChatStore>;
  let execStore: ReturnType<typeof useExecutionStore>;
  let parsePrdStore: ReturnType<typeof useParsePrdStore>;
  let expandStore: ReturnType<typeof useExpandStore>;
  let tasksStore: { hasPrd: boolean; hasTasksFile: boolean; hasValidTasks: boolean; hasTasksJson: boolean; wsInitialized: boolean; fetchTasks: () => void };

  beforeEach(() => {
    setActivePinia(createPinia());
    chatStore = useChatStore();
    execStore = useExecutionStore();
    parsePrdStore = useParsePrdStore();
    expandStore = useExpandStore();
    tasksStore = {
      hasPrd: false,
      hasTasksFile: true,
      hasValidTasks: true,
      hasTasksJson: true,
      wsInitialized: false,
      fetchTasks: vi.fn(),
    };
  });

  it("connected(expandSession) → replay expand:started (suppressed) → replay:complete", () => {
    // Step 1: connected message with active expand session
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        hasPrd: true,
        hasTasksFile: true,
        hasValidTasks: true,
        expandSession: {
          sessionId: "exp-rehydrate-1",
          taskId: "7",
          agent: "claude",
          model: "sonnet",
          variant: "high",
          state: "active",
        },
      },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Verify: state set from connected message
    expect(expandStore.state).toBe("active");
    expect(expandStore.sessionInfo).toEqual({
      sessionId: "exp-rehydrate-1",
      taskId: "7",
      agent: "claude",
      model: "sonnet",
      variant: "high",
    });
    expect(expandStore.outcome).toBeNull();

    // Step 2: replay sends expand:started — should NOT overwrite state
    // because _rehydrating is true (set by applyConnectedExpandState)
    simulateWsMessage(
      {
        type: "expand:started",
        channel: "expand",
        agent: "claude",
        model: "sonnet",
        variant: "high",
        sessionId: "exp-rehydrate-1",
        taskId: "7",
      },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // State still "active" — not re-set by the replayed started event
    expect(expandStore.state).toBe("active");
    // sessionInfo preserved from connected snapshot — NOT overwritten by replay
    expect(expandStore.sessionInfo?.agent).toBe("claude");

    // Step 3: replay of agent:text events — messages ARE added
    simulateWsMessage(
      { type: "agent:text", channel: "expand", text: "Reading task details..." },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );
    simulateWsMessage(
      { type: "agent:tool", channel: "expand", name: "Read", summary: "Read .taskmaster/tasks/tasks.json" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    expect(expandStore.messages.length).toBe(2);

    // Step 4: replay:complete — clears _rehydrating flag
    simulateWsMessage(
      { type: "replay:complete" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // State still active
    expect(expandStore.state).toBe("active");
    // Messages preserved
    expect(expandStore.messages.length).toBe(2);
  });

  it("connected(expandOutcome) → replay expand:started (suppressed) → replay:complete preserves terminal outcome", () => {
    // Step 1: connected with terminal outcome (session already completed)
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        hasPrd: true,
        hasTasksFile: true,
        hasValidTasks: true,
        expandOutcome: { status: "success", taskId: "7", subtaskCount: 4 },
      },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    expect(expandStore.state).toBe("completed");
    expect(expandStore.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });

    // Step 2: replay sends expand:started — suppressed by _rehydrating
    simulateWsMessage(
      {
        type: "expand:started",
        channel: "expand",
        agent: "claude",
        sessionId: "exp-done-replay",
        taskId: "7",
      },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // State NOT overwritten — still completed (not reset to active)
    expect(expandStore.state).toBe("completed");
    expect(expandStore.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });

    // Step 3: replay of agent events + expand:finished
    simulateWsMessage(
      { type: "agent:text", channel: "expand", text: "Subtasks generated" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );
    simulateWsMessage(
      { type: "expand:finished", channel: "expand", outcome: { status: "success", taskId: "7", subtaskCount: 4 } },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Step 4: replay:complete
    simulateWsMessage(
      { type: "replay:complete" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Terminal outcome persists
    expect(expandStore.state).toBe("completed");
    expect(expandStore.outcome).toEqual({ status: "success", taskId: "7", subtaskCount: 4 });
  });

  it("after replay:complete, new expand:started events update state normally", () => {
    // Step 1: connected with active session
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        expandSession: {
          sessionId: "exp-live-1",
          taskId: "7",
          agent: "claude",
          model: "sonnet",
          state: "active",
        },
      },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Step 2: replay expand:started (suppressed)
    simulateWsMessage(
      { type: "expand:started", channel: "expand", agent: "claude", model: "sonnet", sessionId: "exp-live-1", taskId: "7" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Step 3: replay:complete — flag cleared
    simulateWsMessage(
      { type: "replay:complete" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Step 4: a genuinely NEW expand:started should work normally
    simulateWsMessage(
      { type: "expand:started", channel: "expand", agent: "opencode", model: "gpt-4", sessionId: "exp-new-2", taskId: "8" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // State IS updated now (rehydrating is off)
    expect(expandStore.state).toBe("active");
    expect(expandStore.sessionInfo?.agent).toBe("opencode");
    expect(expandStore.sessionInfo?.model).toBe("gpt-4");
    expect(expandStore.sessionInfo?.taskId).toBe("8");
  });

  it("expand replay events do not leak into chat, parse-prd, or exec stores", () => {
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
    const parsePrdSpy = vi.spyOn(parsePrdStore, "handleWsEvent");
    const execAddSpy = vi.spyOn(execStore, "addEvent");

    // Connected with expand session
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        expandSession: {
          sessionId: "exp-isolation",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
      },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Reset spies after connected (which calls clearMessages on other stores)
    chatSpy.mockClear();
    parsePrdSpy.mockClear();
    execAddSpy.mockClear();

    // Replay expand events
    simulateWsMessage(
      { type: "expand:started", channel: "expand", agent: "claude", sessionId: "exp-isolation", taskId: "7" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );
    simulateWsMessage(
      { type: "agent:text", channel: "expand", text: "Decomposing task..." },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );
    simulateWsMessage(
      { type: "agent:tool", channel: "expand", name: "Read", summary: "Reading tasks.json" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );
    simulateWsMessage(
      { type: "expand:finished", channel: "expand", outcome: { status: "success", taskId: "7", subtaskCount: 3 } },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // replay:complete
    simulateWsMessage(
      { type: "replay:complete" },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Chat store never touched
    expect(chatSpy).not.toHaveBeenCalled();
    expect(chatStore.messages.length).toBe(0);

    // Parse-prd store never touched
    expect(parsePrdSpy).not.toHaveBeenCalled();
    expect(parsePrdStore.messages.length).toBe(0);

    // Exec store never touched
    expect(execAddSpy).not.toHaveBeenCalled();

    // Expand store got the messages (text + tool); lifecycle events are
    // suppressed during rehydration so state stays at what `connected` set.
    expect(expandStore.messages.length).toBe(2);
    expect(expandStore.state).toBe("active");
    expect(expandStore.outcome).toBeNull();
  });

  it("connected with no expand fields resets to idle", () => {
    // Set up previous state
    expandStore.state = "completed";
    expandStore.outcome = { status: "success", taskId: "7", subtaskCount: 4 };

    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        // No expandSession or expandOutcome
      },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    expect(expandStore.state).toBe("idle");
    expect(expandStore.sessionInfo).toBeNull();
    expect(expandStore.outcome).toBeNull();
  });

  it("expand and parse-prd sessions can coexist without interference", () => {
    // Connected with both parse-prd outcome and expand session
    simulateWsMessage(
      {
        type: "connected",
        state: "idle",
        parsePrdOutcome: { status: "success" },
        expandSession: {
          sessionId: "exp-coexist",
          taskId: "7",
          agent: "claude",
          state: "active",
        },
      },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    // Parse-prd has terminal outcome
    expect(parsePrdStore.state).toBe("completed");
    expect(parsePrdStore.outcome).toEqual({ status: "success" });

    // Expand has active session
    expect(expandStore.state).toBe("active");
    expect(expandStore.sessionInfo?.taskId).toBe("7");
    expect(expandStore.outcome).toBeNull();

    // Replay expand events — should not affect parse-prd
    simulateWsMessage(
      { type: "agent:text", channel: "expand", text: "Working..." },
      chatStore, execStore, parsePrdStore, expandStore, tasksStore,
    );

    expect(expandStore.messages.length).toBe(1);
    expect(parsePrdStore.messages.length).toBe(0);
  });
});
