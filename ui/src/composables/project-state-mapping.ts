/**
 * Pure functions for mapping server project-state data to the tasks store.
 *
 * Extracted from useWebSocket.ts so that unit tests can import the real
 * mapping logic instead of duplicating it in test helpers.
 */

/**
 * Minimal writable interface for the tasks store — avoids importing the
 * full Pinia store type, which requires Vue reactivity context.
 */
export interface ProjectStateStore {
  hasPrd: boolean;
  hasTasksFile: boolean;
  hasValidTasks: boolean;
  hasTasksJson: boolean;
  wsInitialized: boolean;
}

/**
 * Apply project-state fields from a WS `connected` message to the tasks store.
 *
 * Fallback chain (backward compatibility with older servers):
 *  - `hasPrd`:        present field or `false`
 *  - `hasTasksFile`:  present field, else `hasTasksJson`, else `true`
 *  - `hasValidTasks`: present field, else `hasTasksFile` fallback, else `hasTasksJson`, else `true`
 *  - `hasTasksJson`:  present field or `true`  (legacy alias)
 *
 * The `true` terminal default matches the optimistic store defaults —
 * a very old server that sends neither field is treated as "tasks present"
 * to avoid hiding the navbar.
 */
export function applyConnectedProjectState(
  store: ProjectStateStore,
  data: Record<string, unknown>,
): void {
  store.hasPrd = (data.hasPrd as boolean) ?? false;
  store.hasTasksFile = (data.hasTasksFile as boolean) ?? ((data.hasTasksJson as boolean) ?? true);
  store.hasValidTasks =
    (data.hasValidTasks as boolean) ?? ((data.hasTasksFile as boolean) ?? ((data.hasTasksJson as boolean) ?? true));
  store.hasTasksJson = (data.hasTasksJson as boolean) ?? true;
  store.wsInitialized = true;
}

/**
 * Optimistically update project-state flags when a `tasks:updated` event
 * arrives. Only tasks-related flags are touched; `hasPrd` is left unchanged.
 *
 * `hasTasksFile` and `hasTasksJson` are set to `true` — the file watcher
 * only fires when the file exists on disk.
 *
 * `hasValidTasks` is NOT set here because the file watcher fires on any
 * change, including partial writes or corrupted content. Only the server
 * (via the `connected` message or `/api/status`) can authoritatively
 * validate file contents.
 */
export function applyTasksUpdatedProjectState(
  store: Pick<ProjectStateStore, "hasTasksJson" | "hasTasksFile">,
): void {
  store.hasTasksJson = true;
  store.hasTasksFile = true;
}
