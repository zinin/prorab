/**
 * Pure functions for mapping server refine-prd state to the refine-prd store.
 *
 * Extracted from useWebSocket.ts so that unit tests can import the real
 * mapping logic instead of duplicating it in test helpers.
 *
 * Follows the same pattern as parse-prd-state-mapping.ts.
 */

import type { RefinePrdStoreState, RefinePrdSessionInfo, RefinePrdOutcome, RefinePrdPendingQuestion } from "../stores/refinePrd";

/**
 * Minimal writable interface for the refine-prd store — avoids importing the
 * full Pinia store type, which requires Vue reactivity context.
 */
export interface RefinePrdStateStore {
  state: RefinePrdStoreState;
  sessionInfo: RefinePrdSessionInfo | null;
  outcome: RefinePrdOutcome | null;
  pendingQuestion: RefinePrdPendingQuestion | null;
  setRehydrating(v: boolean): void;
}

/**
 * Apply refine-prd state from a WS `connected` message to the refine-prd store.
 *
 * Three cases:
 *  - `refinePrdSession` present → active session, restore sessionInfo + pendingQuestion, clear outcome, enable rehydrating
 *  - `refinePrdOutcome` present (no session) → terminal outcome, set completed state, enable rehydrating
 *  - Neither present → reset to idle, enable rehydrating (suppresses stale replay events)
 *
 * Note: `clearMessages()` must be called separately before this function
 * (it is called by the connected-message handler in useWebSocket.ts).
 */
export function applyConnectedRefinePrdState(
  store: RefinePrdStateStore,
  data: Record<string, unknown>,
): void {
  const session = data.refinePrdSession as any;
  const oc = data.refinePrdOutcome as any;

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
    // refine-prd:finished events from a previous session.  Without this
    // guard they would re-set state to "completed" after we just cleared it.
    // The flag is cleared by replay:complete.
    store.setRehydrating(true);
  }
}
