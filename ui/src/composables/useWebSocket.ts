import { ref, onUnmounted } from "vue";
import { useTasksStore } from "../stores/tasks";
import { useExecutionStore } from "../stores/execution";
import { useChatStore } from "../stores/chat";
import { useParsePrdStore } from "../stores/parse-prd";
import { useExpandStore } from "../stores/expand";
import { useBatchExpandStore } from "../stores/batchExpand";
import { applyConnectedProjectState, applyTasksUpdatedProjectState } from "./project-state-mapping";
import { applyConnectedParsePrdState } from "./parse-prd-state-mapping";
import { useRefinePrdStore } from "../stores/refinePrd";
import { applyConnectedRefinePrdState } from "./refine-prd-state-mapping";
import { useRefineTasksStore } from "../stores/refineTasks";
import { applyConnectedRefineTasksState } from "./refine-tasks-state-mapping";

// Must match AGGREGATOR_REVIEWER_ID in src/types.ts
const AGGREGATOR_REVIEWER_ID = "aggregator";

export function useWebSocket() {
  const connected = ref(false);
  let ws: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    // Close previous socket to prevent duplicate connections on reconnect
    if (ws) {
      ws.onclose = null; // prevent old socket's onclose from triggering reconnect
      ws.close();
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      connected.value = true;
    };

    ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return; // ignore malformed messages
      }
      const tasksStore = useTasksStore();
      const execStore = useExecutionStore();
      const chatStore = useChatStore();
      const parsePrdStore = useParsePrdStore();
      const refinePrdStore = useRefinePrdStore();
      const expandStore = useExpandStore();
      const batchExpandStore = useBatchExpandStore();
      const refineTasksStore = useRefineTasksStore();

      // Early routing: chat-channel events go directly to chatStore
      if (data.channel === "chat" || (typeof data.type === "string" && data.type.startsWith("chat:"))) {
        chatStore.handleWsEvent(data);
        // Update project state when chat finishes — the idea-to-PRD flow
        // creates prd.md during the session, so hasPrd must be refreshed
        // for viewMode to transition from wizard-chat to wizard-parse-prd.
        // The server includes project state directly in chat:finished to
        // avoid a separate fetchStatus() HTTP round-trip.
        if (data.type === "chat:finished") {
          if (data.hasPrd != null) tasksStore.hasPrd = data.hasPrd;
          if (data.hasTasksFile != null) tasksStore.hasTasksFile = data.hasTasksFile;
          if (data.hasValidTasks != null) tasksStore.hasValidTasks = data.hasValidTasks;
          // Fallback: also fetch status in case the inline fields are absent
          // (e.g. older server version without project state in chat:finished)
          tasksStore.fetchStatus();
        }
        return;
      }

      // Early routing: parse-prd-channel events go to parsePrdStore.
      // Prevents agent:* events with channel="parse-prd" from polluting
      // the execution event log.
      if (data.channel === "parse-prd" || (typeof data.type === "string" && data.type.startsWith("parse-prd:"))) {
        parsePrdStore.handleWsEvent(data);
        return;
      }

      // Early routing: refine-prd-channel events go to refinePrdStore.
      if (data.channel === "refine-prd" || (typeof data.type === "string" && data.type.startsWith("refine-prd:"))) {
        refinePrdStore.handleWsEvent(data);
        return;
      }

      // Early routing: refine-tasks-channel events go to refineTasksStore.
      if (data.channel === "refine-tasks" || (typeof data.type === "string" && data.type.startsWith("refine-tasks:"))) {
        refineTasksStore.handleWsEvent(data);
        return;
      }

      // Early routing: expand-channel events go to expandStore.
      // Prevents agent:* events with channel="expand" from polluting
      // the execution event log.
      if (data.channel === "expand" || (typeof data.type === "string" && data.type.startsWith("expand:"))) {
        expandStore.handleWsEvent(data);
        return;
      }

      // Early routing: batch-expand-channel events go to batchExpandStore.
      // Prevents agent:* events with channel="batch-expand" from polluting
      // the execution event log.
      if (data.channel === "batch-expand" || (typeof data.type === "string" && data.type.startsWith("batch_expand:"))) {
        batchExpandStore.handleWsEvent(data);
        return;
      }

      switch (data.type) {
        case "replay:complete":
          // Server sends this after all ring-buffer replay events.
          // Clearing the rehydration flag here (instead of via setTimeout(0))
          // guarantees that all replay events have been processed.
          chatStore.setRehydrating(false);
          parsePrdStore.setRehydrating(false);
          refinePrdStore.setRehydrating(false);
          refineTasksStore.setRehydrating(false);
          expandStore.setRehydrating(false);
          batchExpandStore.clearRehydrating();
          // Reconcile project-state flags after replay: ring-buffer may contain
          // stale `tasks:updated` events that optimistically set hasTasksFile=true
          // even though the file no longer exists on disk.
          tasksStore.fetchStatus();
          break;
        case "connected":
          applyConnectedProjectState(tasksStore, data);
          execStore.clearEvents();
          execStore.state = data.state ?? "idle";
          if (data.currentUnit) {
            execStore.currentUnit = {
              id: data.currentUnit.subtaskId
                ? `${data.currentUnit.taskId}.${data.currentUnit.subtaskId}`
                : data.currentUnit.taskId,
              title: data.currentUnit.title ?? "",
              taskId: data.currentUnit.taskId,
              subtaskId: data.currentUnit.subtaskId,
            };
            if (data.currentUnit.taskId) {
              execStore.fetchTaskContext(data.currentUnit.taskId, data.currentUnit.subtaskId);
            }
          } else {
            execStore.currentUnit = null;
          }
          if (data.iterationCurrent != null && data.state !== "idle") {
            execStore.setIterationInfo(data.iterationCurrent, data.iterationTotal ?? null);
          } else {
            execStore.clearIterationInfo();
          }
          execStore.gracefulStop = data.gracefulStop ?? false;
          // Clear message buffers before replay repopulates them,
          // mirroring how execStore.clearEvents() prevents duplicates.
          chatStore.clearMessages();
          parsePrdStore.clearMessages();
          refinePrdStore.clearMessages();
          refineTasksStore.clearMessages();
          expandStore.clearMessages();
          batchExpandStore.resetLocal();
          // Initialize chat state on (re)connect.
          // Uses direct state assignment instead of synthetic events so
          // the store accurately reflects the server-reported state
          // (e.g. question_pending, awaitingUserInput=false).
          // Pending question is restored via ring-buffer replay of the
          // last chat:question event, not from the connected payload.
          if (data.chatSession) {
            chatStore.state = data.chatSession.state ?? "idle";
            chatStore.awaitingUserInput = data.chatSession.awaitingUserInput ?? false;
            chatStore.sessionInfo = {
              agent: data.chatSession.agent,
              model: data.chatSession.model,
            };
            chatStore.pendingQuestion = null;
            // Prevent ring-buffer replay lifecycle events (chat:started,
            // chat:idle) from overwriting the authoritative server snapshot.
            // Flag is cleared when the server's replay:complete sentinel arrives.
            chatStore.setRehydrating(true);
          } else {
            // No active chat session — reset to idle
            chatStore.state = "idle";
            chatStore.awaitingUserInput = false;
            chatStore.sessionInfo = null;
            chatStore.pendingQuestion = null;
          }
          // Initialize parse-prd state on (re)connect.
          // Uses direct state assignment so the store accurately reflects
          // the server-reported state. Messages are restored via ring-buffer
          // replay; the _rehydrating flag prevents replayed lifecycle events
          // (parse-prd:started) from overwriting the authoritative snapshot.
          applyConnectedParsePrdState(parsePrdStore, data);
          // Initialize refine-prd state on (re)connect.
          applyConnectedRefinePrdState(refinePrdStore, data);
          // Initialize refine-tasks state on (re)connect.
          applyConnectedRefineTasksState(refineTasksStore, data);
          // Initialize expand state on (re)connect.
          // Same pattern as parse-prd: connected snapshot is authoritative,
          // _rehydrating flag suppresses stale lifecycle events during replay.
          expandStore.rehydrateFromConnected(data);
          // Initialize batch-expand state on (re)connect.
          // Same pattern as expand: connected snapshot is authoritative,
          // _rehydrating flag suppresses stale lifecycle events during replay.
          batchExpandStore.rehydrateFromConnected(data);
          break;
        case "tasks:updated":
          applyTasksUpdatedProjectState(tasksStore);
          tasksStore.fetchTasks();
          if (execStore.taskContext && execStore.currentUnit?.taskId) {
            execStore.fetchTaskContext(execStore.currentUnit.taskId, execStore.currentUnit.subtaskId);
          }
          break;
        case "execution:state":
          execStore.state = data.state;
          if (data.state === "idle") {
            execStore.clearIterationInfo();
            execStore.gracefulStop = false;
          }
          break;
        case "execution:graceful_stop":
          execStore.gracefulStop = data.enabled;
          break;
        case "execution:started":
          execStore.clearEvents();
          execStore.currentUnit = {
            id: data.unitId,
            title: data.title ?? "",
            taskId: data.taskId,
            subtaskId: data.subtaskId,
          };
          execStore.contextUsageByUnit = {};
          execStore.turnUsageByUnit = {};
          execStore.clearReviewerTabs();
          if (data.taskId) {
            execStore.fetchTaskContext(data.taskId, data.subtaskId);
          }
          break;
        case "execution:review_started": {
          execStore.clearEvents();
          const ri = execStore.reviewRoundInfo;
          const reviewTitle = ri && ri.total > 1 ? `(review — round ${ri.round}/${ri.total})` : "(review)";
          execStore.currentUnit = {
            id: data.taskId,
            title: reviewTitle,
            taskId: data.taskId,
            subtaskId: "",
          };
          execStore.contextUsageByUnit = {};
          execStore.turnUsageByUnit = {};
          execStore.clearReviewerTabs();
          if (data.taskId) {
            execStore.fetchTaskContext(data.taskId);
          }
          break;
        }
        case "execution:rework_started": {
          execStore.clearEvents();
          const ri2 = execStore.reviewRoundInfo;
          const reworkTitle = ri2 && ri2.total > 1 ? `(rework — round ${ri2.round}/${ri2.total})` : "(rework)";
          execStore.currentUnit = {
            id: data.taskId,
            title: reworkTitle,
            taskId: data.taskId,
            subtaskId: "",
          };
          execStore.contextUsageByUnit = {};
          execStore.turnUsageByUnit = {};
          execStore.clearReviewerTabs();
          if (data.taskId) {
            execStore.fetchTaskContext(data.taskId);
          }
          break;
        }
        case "execution:finished":
          execStore.currentUnit = null;
          break;
        case "execution:all_done":
          execStore.state = "idle";
          execStore.currentUnit = null;
          execStore.clearIterationInfo();
          execStore.gracefulStop = false;
          break;
        case "agent:text":
        case "agent:reasoning":
        case "agent:tool":
        case "agent:tool_result":
        case "agent:system_prompt":
        case "agent:task_prompt": {
          const ev = data.type === "agent:tool"
            ? { timestamp: Date.now(), type: "tool" as const, content: data.summary, toolName: data.name }
            : data.type === "agent:tool_result"
              ? { timestamp: Date.now(), type: "tool_result" as const, content: data.summary }
              : data.type === "agent:reasoning"
                ? { timestamp: Date.now(), type: "text" as const, content: `[reasoning] ${data.text}` }
                : { timestamp: Date.now(), type: data.type.replace("agent:", "") as "text" | "system_prompt" | "task_prompt", content: data.text };
          if (data.reviewerId) {
            if (data.reviewerId === AGGREGATOR_REVIEWER_ID) execStore.addAggregatorTab();
            execStore.addReviewerEvent(data.reviewerId, ev);
          } else {
            execStore.addEvent(ev);
          }
          break;
        }
        case "agent:context_usage":
          execStore.updateContextUsage({
            contextTokens: data.contextTokens,
            contextWindow: data.contextWindow,
            model: data.model,
            unitId: data.unitId,
            reviewerId: data.reviewerId,
          });
          break;
        case "agent:turn_count":
          execStore.updateTurnUsage({
            numTurns: data.numTurns,
            maxTurns: data.maxTurns,
            model: data.model,
            unitId: data.unitId,
            reviewerId: data.reviewerId,
          });
          break;
        case "execution:multi_review_started": {
          execStore.clearEvents();
          const riMulti = execStore.reviewRoundInfo;
          const multiTitle = riMulti && riMulti.total > 1 ? `(review — round ${riMulti.round}/${riMulti.total})` : "(review)";
          execStore.currentUnit = {
            id: data.taskId,
            title: multiTitle,
            taskId: data.taskId,
            subtaskId: "",
          };
          execStore.contextUsageByUnit = {};
          execStore.turnUsageByUnit = {};
          execStore.startMultiReview(
            data.reviewers.map((r: { reviewerId: string }) => r.reviewerId),
          );
          if (data.taskId) {
            execStore.fetchTaskContext(data.taskId);
          }
          break;
        }
        case "execution:reviewer_finished":
          execStore.setReviewerStatus(data.reviewerId, data.signal?.type ?? "error");
          break;
        case "execution:multi_review_finished":
          // Informational only — tabs remain visible
          break;
        case "execution:review_round_changed":
          execStore.setReviewRoundInfo(data.round, data.total);
          break;
        case "execution:iteration_changed":
          execStore.setIterationInfo(data.current, data.total);
          break;
        case "execution:blocked":
          // Don't clear reviewer tabs — user needs them for failure diagnosis.
          // Tabs are cleared on next execution:started or execution:rework_started.
          break;
      }
    };

    ws.onclose = () => {
      connected.value = false;
      reconnectTimer = setTimeout(connect, 2000);
    };
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) {
      ws.onclose = null; // prevent reconnect on intentional disconnect
      ws.close();
      ws = null;
    }
  }

  onUnmounted(disconnect);

  return { connected, connect, disconnect };
}
