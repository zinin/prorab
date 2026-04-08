import { usePersistedRef } from "./usePersistedRef";

export interface SessionDefaults {
  agent: string;
  model: string;
  variant: string;
  verbosity: string;
  userSettings: boolean;
  applyHooks?: boolean;
}

const SESSION_DEFAULTS_KEY = "prorab:sessionDefaults";

const DEFAULT_SESSION_DEFAULTS: SessionDefaults = {
  agent: "claude",
  model: "",
  variant: "",
  verbosity: "trace",
  userSettings: false,
};

export function useSessionDefaults() {
  return usePersistedRef<SessionDefaults>(
    SESSION_DEFAULTS_KEY,
    DEFAULT_SESSION_DEFAULTS,
    { deep: true },
  );
}
