/**
 * Pure functions for mapping server parse-prd state to the parse-prd store.
 *
 * Extracted from useWebSocket.ts so that unit tests can import the real
 * mapping logic instead of duplicating it in test helpers.
 *
 * Follows the same pattern as project-state-mapping.ts.
 */

import type { ParsePrdOutcome, ParsePrdSessionInfo, ParsePrdStoreState } from "../stores/parse-prd";

/**
 * Minimal writable interface for the parse-prd store — avoids importing the
 * full Pinia store type, which requires Vue reactivity context.
 */
export interface ParsePrdStateStore {
  state: ParsePrdStoreState;
  sessionInfo: ParsePrdSessionInfo | null;
  outcome: ParsePrdOutcome | null;
  setRehydrating(v: boolean): void;
}

/**
 * Apply parse-prd state from a WS `connected` message to the parse-prd store.
 *
 * Three cases:
 *  - `parsePrdSession` present → active session, restore state/sessionInfo, clear outcome, enable rehydrating
 *  - `parsePrdOutcome` present (no session) → terminal outcome, set completed state, enable rehydrating
 *  - Neither present → reset to idle, enable rehydrating (suppresses stale replay events)
 *
 * Note: `clearMessages()` must be called separately before this function
 * (it is called by the connected-message handler in useWebSocket.ts).
 */
export function applyConnectedParsePrdState(
  store: ParsePrdStateStore,
  data: Record<string, unknown>,
): void {
  if (data.parsePrdSession && typeof data.parsePrdSession === "object") {
    const ps = data.parsePrdSession as Record<string, unknown>;
    store.state = ((ps.state as string) ?? "active") as ParsePrdStoreState;
    store.sessionInfo = {
      agent: ps.agent as string,
      model: ps.model as string | undefined,
      variant: ps.variant as string | undefined,
    };
    store.outcome = null;
    store.setRehydrating(true);
  } else if (data.parsePrdOutcome && typeof data.parsePrdOutcome === "object") {
    store.state = "completed";
    store.sessionInfo = null;
    store.outcome = data.parsePrdOutcome as ParsePrdOutcome;
    store.setRehydrating(true);
  } else {
    store.state = "idle";
    store.sessionInfo = null;
    store.outcome = null;
    // Always enable rehydrating — the ring buffer may contain stale
    // parse-prd:finished events from a previous session.  Without this
    // guard they would re-set state to "completed" after we just cleared it.
    // The flag is cleared by replay:complete.
    store.setRehydrating(true);
  }
}
