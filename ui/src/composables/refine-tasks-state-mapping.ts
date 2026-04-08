/**
 * Pure functions for mapping server refine-tasks state to the refine-tasks store.
 *
 * Extracted from useWebSocket.ts so that unit tests can import the real
 * mapping logic instead of duplicating it in test helpers.
 *
 * Follows the same pattern as refine-prd-state-mapping.ts.
 */

import type { RefineTasksStoreState, RefineTasksSessionInfo, RefineTasksOutcome, RefineTasksPendingQuestion } from "../stores/refineTasks";

/**
 * Minimal writable interface for the refine-tasks store — avoids importing the
 * full Pinia store type, which requires Vue reactivity context.
 */
export interface RefineTasksStateStore {
  state: RefineTasksStoreState;
  sessionInfo: RefineTasksSessionInfo | null;
  outcome: RefineTasksOutcome | null;
  pendingQuestion: RefineTasksPendingQuestion | null;
  setRehydrating(v: boolean): void;
}

/**
 * Apply refine-tasks state from a WS `connected` message to the refine-tasks store.
 *
 * Three cases:
 *  - `refineTasksSession` present → active session, restore sessionInfo + pendingQuestion, clear outcome, enable rehydrating
 *  - `refineTasksOutcome` present (no session) → terminal outcome, set completed state, enable rehydrating
 *  - Neither present → reset to idle, enable rehydrating (suppresses stale replay events)
 *
 * Note: `clearMessages()` must be called separately before this function
 * (it is called by the connected-message handler in useWebSocket.ts).
 */
export function applyConnectedRefineTasksState(
  store: RefineTasksStateStore,
  data: Record<string, unknown>,
): void {
  const session = data.refineTasksSession as any;
  const oc = data.refineTasksOutcome as any;

  if (session) {
    store.state = "active";
    store.sessionInfo = {
      steps: session.steps ?? [],
      currentStepIndex: session.currentStepIndex ?? 0,
      stepState: session.stepState ?? "running",
    };
    store.outcome = null;
    // Restore pending question if present
    store.pendingQuestion = session.pendingQuestion
      ? {
          questionId: session.pendingQuestion.questionId,
          questions: session.pendingQuestion.questions,
          source: session.pendingQuestion.source,
        }
      : null;
    store.setRehydrating(true);
  } else if (oc) {
    store.state = "completed";
    store.outcome = oc;
    store.sessionInfo = null;
    store.pendingQuestion = null;
    store.setRehydrating(true);
  } else {
    store.state = "idle";
    store.sessionInfo = null;
    store.outcome = null;
    store.pendingQuestion = null;
    // Always enable rehydrating — the ring buffer may contain stale
    // refine-tasks:finished events from a previous session.  Without this
    // guard they would re-set state to "completed" after we just cleared it.
    // The flag is cleared by replay:complete.
    store.setRehydrating(true);
  }
}
