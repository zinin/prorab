/**
 * Integration test: chat:* events are handled exactly once via early routing.
 *
 * Verifies that the main exec switch in useWebSocket does NOT duplicate
 * chat:* event handling — chatStore.handleWsEvent() is the single point
 * of truth for all chat-channel events.
 *
 * Task 17.3: Убрать дублирующую обработку chat:* из основного switch.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useChatStore } from "../../ui/src/stores/chat";
import { useExecutionStore } from "../../ui/src/stores/execution";

/**
 * Full routing + exec-switch simulation from useWebSocket.onmessage.
 *
 * Unlike the simpler routeWsEvent in ws-channel-routing.test.ts,
 * this exercises the exec switch as well — ensuring that no chat:*
 * case blocks live inside it.
 */
function simulateWsMessage(
  data: Record<string, unknown>,
  chatStore: ReturnType<typeof useChatStore>,
  execStore: ReturnType<typeof useExecutionStore>,
  tasksStore: { fetchTasks: () => void },
) {
  // ── Early routing (mirrors lines 38-42 of useWebSocket.ts) ──
  if (data.channel === "chat" || (typeof data.type === "string" && (data.type as string).startsWith("chat:"))) {
    chatStore.handleWsEvent(data as Parameters<typeof chatStore.handleWsEvent>[0]);
    return;
  }

  // ── Main exec switch (mirrors lines 44-208) ──
  // Must match exactly the cases in the real composable.
  // IMPORTANT: no chat:* cases are listed here — that is the invariant under test.

  const AGGREGATOR_REVIEWER_ID = "aggregator";

  switch (data.type) {
    case "connected":
      execStore.clearEvents();
      execStore.state = (data.state as "idle" | "running" | "stopping") ?? "idle";
      if (data.currentUnit) {
        const cu = data.currentUnit as Record<string, unknown>;
        execStore.currentUnit = {
          id: cu.subtaskId ? `${cu.taskId}.${cu.subtaskId}` : String(cu.taskId),
          title: (cu.title as string) ?? "",
          taskId: cu.taskId as string,
          subtaskId: cu.subtaskId as string,
        };
      } else {
        execStore.currentUnit = null;
      }
      // Clear chat messages before replay (mirrors real implementation)
      chatStore.clearMessages();
      // chatSession initialization — direct state assignment (mirrors lines 78-97 of useWebSocket.ts)
      if (data.chatSession && typeof data.chatSession === "object") {
        const cs = data.chatSession as Record<string, unknown>;
        chatStore.state = ((cs.state as string) ?? "idle") as "idle" | "active" | "question_pending" | "stopping";
        chatStore.awaitingUserInput = (cs.awaitingUserInput as boolean) ?? false;
        chatStore.sessionInfo = {
          agent: cs.agent as string,
          model: cs.model as string | undefined,
        };
        chatStore.pendingQuestion = null;
      } else {
        chatStore.state = "idle";
        chatStore.awaitingUserInput = false;
        chatStore.sessionInfo = null;
        chatStore.pendingQuestion = null;
      }
      break;
    case "tasks:updated":
      tasksStore.fetchTasks();
      break;
    case "execution:state":
      execStore.state = data.state as "idle" | "running" | "stopping";
      break;
    case "execution:started":
      execStore.currentUnit = {
        id: data.unitId as string,
        title: (data.title as string) ?? "",
        taskId: data.taskId as string,
        subtaskId: data.subtaskId as string,
      };
      break;
    case "execution:finished":
      execStore.currentUnit = null;
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
      if (data.reviewerId) {
        if (data.reviewerId === AGGREGATOR_REVIEWER_ID) execStore.addAggregatorTab();
        execStore.addReviewerEvent(data.reviewerId as string, ev);
      } else {
        execStore.addEvent(ev);
      }
      break;
    }
    case "agent:context_usage":
      execStore.updateContextUsage({
        contextTokens: data.contextTokens as number,
        contextWindow: data.contextWindow as number,
        model: data.model as string,
        unitId: data.unitId as string,
        reviewerId: data.reviewerId as string | undefined,
      });
      break;
    // Intentionally: NO chat:* cases here.
    // All chat events are handled by the early return above.
  }
}

describe("No duplicate chat:* handling (task 17.3)", () => {
  let chatStore: ReturnType<typeof useChatStore>;
  let execStore: ReturnType<typeof useExecutionStore>;
  let tasksStore: { fetchTasks: () => void };

  beforeEach(() => {
    setActivePinia(createPinia());
    chatStore = useChatStore();
    execStore = useExecutionStore();
    tasksStore = { fetchTasks: vi.fn() as unknown as () => void };
  });

  // ── Core invariant: handleWsEvent called exactly once ──

  it("chat:question → handleWsEvent called exactly once, pendingQuestion set", () => {
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    const questions = [
      {
        question: "Which approach?",
        header: "Approach",
        options: [
          { label: "A", description: "Option A" },
          { label: "B", description: "Option B" },
        ],
        multiSelect: false,
      },
    ];

    simulateWsMessage(
      {
        type: "chat:question",
        channel: "chat",
        questionId: "q-test-1",
        questions,
        source: "claude",
      },
      chatStore,
      execStore,
      tasksStore,
    );

    // handleWsEvent called exactly once — not twice
    expect(spy).toHaveBeenCalledOnce();

    // pendingQuestion contains the expected data
    expect(chatStore.pendingQuestion).not.toBeNull();
    expect(chatStore.pendingQuestion!.questionId).toBe("q-test-1");
    expect(chatStore.pendingQuestion!.questions).toEqual(questions);
    expect(chatStore.pendingQuestion!.source).toBe("claude");

    // state is question_pending
    expect(chatStore.state).toBe("question_pending");
  });

  it("chat:started → handleWsEvent called exactly once", () => {
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    simulateWsMessage(
      {
        type: "chat:started",
        channel: "chat",
        agent: "claude",
        model: "sonnet",
        sessionId: "s-test-1",
      },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.state).toBe("active");
    expect(chatStore.awaitingUserInput).toBe(true);
    expect(chatStore.sessionInfo).toEqual({ agent: "claude", model: "sonnet" });
  });

  it("chat:idle → handleWsEvent called exactly once", () => {
    // Set up active + question_pending state first
    chatStore.handleWsEvent({
      type: "chat:started",
      channel: "chat",
      agent: "claude",
    });
    chatStore.handleWsEvent({
      type: "chat:question",
      channel: "chat",
      questionId: "q1",
      questions: [],
      source: "claude",
    });

    const spy = vi.spyOn(chatStore, "handleWsEvent");

    simulateWsMessage(
      { type: "chat:idle", channel: "chat" },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.state).toBe("active");
    expect(chatStore.awaitingUserInput).toBe(true);
    expect(chatStore.pendingQuestion).toBeNull();
  });

  it("chat:error → handleWsEvent called exactly once", () => {
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    simulateWsMessage(
      { type: "chat:error", channel: "chat", message: "Oops" },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.error).toBe("Oops");
  });

  it("chat:finished → handleWsEvent called exactly once", () => {
    chatStore.handleWsEvent({
      type: "chat:started",
      channel: "chat",
      agent: "claude",
    });
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    simulateWsMessage(
      { type: "chat:finished", channel: "chat" },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.state).toBe("idle");
    expect(chatStore.sessionInfo).toBeNull();
  });

  // ── exec store is not polluted by chat events ──

  it("chat:question does not add events to exec store", () => {
    const addEventSpy = vi.spyOn(execStore, "addEvent");

    simulateWsMessage(
      {
        type: "chat:question",
        channel: "chat",
        questionId: "q2",
        questions: [{ question: "Pick?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }],
        source: "opencode",
      },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(addEventSpy).not.toHaveBeenCalled();
  });

  it("agent:text with channel=chat does not add events to exec store", () => {
    const addEventSpy = vi.spyOn(execStore, "addEvent");

    simulateWsMessage(
      { type: "agent:text", channel: "chat", text: "Chat agent output" },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(addEventSpy).not.toHaveBeenCalled();
    expect(chatStore.messages.length).toBe(1);
    expect(chatStore.messages[0].content).toBe("Chat agent output");
  });

  it("agent:tool with channel=chat does not add events to exec store", () => {
    const addEventSpy = vi.spyOn(execStore, "addEvent");

    simulateWsMessage(
      { type: "agent:tool", channel: "chat", name: "Read", summary: "Reading file" },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(addEventSpy).not.toHaveBeenCalled();
    expect(chatStore.messages.length).toBe(1);
    expect(chatStore.messages[0].type).toBe("tool");
  });

  // ── exec events still work correctly (regression guard) ──

  it("agent:text without channel goes to exec store, not chat store", () => {
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    simulateWsMessage(
      { type: "agent:text", text: "Execution output" },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(chatSpy).not.toHaveBeenCalled();
    expect(chatStore.messages.length).toBe(0);
  });

  it("agent:text with channel=execute goes to exec store, not chat store", () => {
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    simulateWsMessage(
      { type: "agent:text", channel: "execute", text: "Exec-channel output" },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(chatSpy).not.toHaveBeenCalled();
    expect(chatStore.messages.length).toBe(0);
  });

  it("execution:started goes to exec store without touching chat store", () => {
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");

    simulateWsMessage(
      { type: "execution:started", unitId: "1", taskId: "1", title: "Task 1" },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(chatSpy).not.toHaveBeenCalled();
    expect(execStore.currentUnit).not.toBeNull();
    expect(execStore.currentUnit!.id).toBe("1");
  });

  // ── chat:question without channel field (legacy/fallback) ──

  it("chat:question without channel field still handled exactly once via type prefix", () => {
    const spy = vi.spyOn(chatStore, "handleWsEvent");

    simulateWsMessage(
      {
        type: "chat:question",
        questionId: "q-legacy",
        questions: [{ question: "Legacy?", header: "L", options: [{ label: "Y", description: "yes" }], multiSelect: false }],
        source: "claude",
      },
      chatStore,
      execStore,
      tasksStore,
    );

    expect(spy).toHaveBeenCalledOnce();
    expect(chatStore.pendingQuestion!.questionId).toBe("q-legacy");
  });

  // ── Sequence test: chat + exec events interleaved ──

  it("interleaved chat and exec events are routed correctly without leakage", () => {
    const chatSpy = vi.spyOn(chatStore, "handleWsEvent");
    const execAddSpy = vi.spyOn(execStore, "addEvent");

    // 1. Chat started
    simulateWsMessage(
      { type: "chat:started", channel: "chat", agent: "claude", sessionId: "s1" },
      chatStore, execStore, tasksStore,
    );

    // 2. Exec agent output (no channel)
    simulateWsMessage(
      { type: "agent:text", text: "Running task..." },
      chatStore, execStore, tasksStore,
    );

    // 3. Chat agent output
    simulateWsMessage(
      { type: "agent:text", channel: "chat", text: "Chat response" },
      chatStore, execStore, tasksStore,
    );

    // 4. Chat question
    simulateWsMessage(
      {
        type: "chat:question",
        channel: "chat",
        questionId: "q-interleave",
        questions: [{ question: "Pick?", header: "H", options: [{ label: "A", description: "a" }], multiSelect: false }],
        source: "claude",
      },
      chatStore, execStore, tasksStore,
    );

    // 5. More exec output
    simulateWsMessage(
      { type: "agent:tool", name: "Bash", summary: "Running tests" },
      chatStore, execStore, tasksStore,
    );

    // Chat store: 3 events (started, text, question)
    expect(chatSpy).toHaveBeenCalledTimes(3);
    expect(chatStore.messages.length).toBe(2); // text + question (started doesn't add a message)
    expect(chatStore.state).toBe("question_pending");

    // Exec store: 2 events (agent:text + agent:tool)
    expect(execAddSpy).toHaveBeenCalledTimes(2);
  });
});
