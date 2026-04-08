import type { AgentType } from "../../types.js";
import type { AgentDriver } from "./types.js";
import { CcsDriver } from "./ccs.js";
import { ClaudeDriver } from "./claude.js";
import { CodexDriver } from "./codex.js";
import { OpenCodeDriver } from "./opencode.js";

export function createDriver(
  agent: AgentType,
  model?: string,
  useUserSettings: boolean = false,
  applyHooks: boolean = false,
): AgentDriver {
  switch (agent) {
    case "claude":
      return new ClaudeDriver(model, useUserSettings);
    case "opencode":
      return new OpenCodeDriver(model);
    case "ccs":
      return new CcsDriver(model, useUserSettings, applyHooks);
    case "codex":
      return new CodexDriver(model);
    default:
      throw new Error(`Unknown agent type: ${agent}`);
  }
}
