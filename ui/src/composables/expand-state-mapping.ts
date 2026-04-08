/**
 * Pure functions for mapping server expand state to the expand store.
 *
 * Extracted from useWebSocket.ts so that unit tests can import the real
 * mapping logic instead of duplicating it in test helpers.
 *
 * Follows the same pattern as parse-prd-state-mapping.ts.
 */

import type { ExpandOutcome, ExpandSessionInfo, ExpandStoreState } from "../stores/expand";

/** Known valid states — used as a whitelist when casting server values. */
const VALID_STATES: readonly ExpandStoreState[] = ["idle", "active", "stopping", "completed"];

/**
 * Minimal writable interface for the expand store — avoids importing the
 * full Pinia store type, which requires Vue reactivity context.
 */
export interface ExpandStateStore {
  state: ExpandStoreState;
  sessionInfo: ExpandSessionInfo | null;
  outcome: ExpandOutcome | null;
  setRehydrating(v: boolean): void;
}

/**
 * Apply expand state from a WS `connected` message to the expand store.
 *
 * Three cases:
 *  - `expandSession` present → active session, restore state/sessionInfo, clear outcome, enable rehydrating
 *  - `expandOutcome` present (no session) → terminal outcome, set completed state, enable rehydrating
 *  - Neither present → reset to idle, enable rehydrating (suppresses stale replay events)
 *
 * Note: `clearMessages()` must be called separately before this function
 * (it is called by the connected-message handler in useWebSocket.ts).
 */
export function applyConnectedExpandState(
  store: ExpandStateStore,
  data: Record<string, unknown>,
): void {
  if (data.expandSession && typeof data.expandSession === "object") {
    const es = data.expandSession as Record<string, unknown>;
    const rawState = (es.state as string) ?? "active";
    store.state = VALID_STATES.includes(rawState as ExpandStoreState)
      ? (rawState as ExpandStoreState)
      : "active";
    store.sessionInfo = {
      sessionId: es.sessionId as string,
      taskId: es.taskId as string,
      agent: es.agent as string,
      model: es.model as string | undefined,
      variant: es.variant as string | undefined,
    };
    store.outcome = null;
    store.setRehydrating(true);
  } else if (data.expandOutcome && typeof data.expandOutcome === "object") {
    store.state = "completed";
    store.sessionInfo = null;
    store.outcome = data.expandOutcome as ExpandOutcome;
    store.setRehydrating(true);
  } else {
    store.state = "idle";
    store.sessionInfo = null;
    store.outcome = null;
    // Always enable rehydrating — the ring buffer may contain stale
    // expand:finished events from a previous session.  Without this
    // guard they would re-set state to "completed" after we just cleared it.
    // The flag is cleared by replay:complete.
    store.setRehydrating(true);
  }
}
