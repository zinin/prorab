import type { OnLogCallback, Verbosity } from "../../types.js";

// ANSI escape codes (exported for direct stdout streaming in OpenCode driver)
export const DIM = "\x1b[2m";
export const CYAN = "\x1b[36m";
export const RESET = "\x1b[0m";

/** Wrap text in ANSI dim. */
export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

/** Wrap text in ANSI cyan. */
export function cyan(text: string): string {
  return `${CYAN}${text}${RESET}`;
}

/** Truncate string to maxLen, appending "…" if truncated. */
export function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

/**
 * Extract a short description from tool input for display.
 * Tool names are compared case-insensitively — Claude uses PascalCase,
 * OpenCode uses lowercase.
 */
export function toolInputSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  const name = toolName.toLowerCase();
  if (name === "grep") {
    return truncate(String(input.pattern || ""), 60);
  }
  if (name === "read" || name === "glob") {
    const path = input.file_path || input.path || input.pattern || "";
    return String(path);
  }
  if (name === "write" || name === "edit") {
    return String(input.file_path || "");
  }
  if (name === "bash") {
    return truncate(String(input.command || ""), 80);
  }
  if (name === "task") {
    return truncate(String(input.description || input.prompt || ""), 60);
  }
  for (const [, v] of Object.entries(input)) {
    if (typeof v === "string" && v.length > 0) {
      return truncate(v, 60);
    }
  }
  return "";
}

/**
 * Verbosity-aware logger for driver sessions.
 * Encapsulates dim/cyan formatting and quiet/info/debug/trace routing
 * so drivers don't repeat if/else verbosity chains.
 *
 * Level behavior (console = UI at each level):
 * | Method          | quiet  | info           | debug          | trace     |
 * |-----------------|--------|----------------|----------------|-----------|
 * | logAssistant()  | silent | firstLine 120  | truncate 2000  | full text |
 * | logTool()       | silent | summary 60-80  | full JSON      | full JSON |
 * | logToolResult() | silent | firstLine 120  | truncate 200   | full text |
 * | logVerbose()    | silent | silent         | shown          | shown     |
 * | log()           | silent | shown          | shown          | shown     |
 */
export class SessionLogger {
  readonly isQuiet: boolean;
  /** debug or trace (replaces old isVerbose for console output compat). */
  readonly isVerbose: boolean;
  readonly isDebug: boolean;
  readonly isTrace: boolean;
  private onLog?: OnLogCallback;

  constructor(verbosity: Verbosity, onLog?: OnLogCallback) {
    this.isQuiet = verbosity === "quiet";
    this.isDebug = verbosity === "debug";
    this.isTrace = verbosity === "trace";
    this.isVerbose = this.isDebug || this.isTrace;
    this.onLog = onLog;
  }

  /** Log a dim message. Skipped in quiet mode. */
  log(msg: string): void {
    if (!this.isQuiet) console.log(dim(msg));
  }

  /** Log a cyan message. Only shown in debug/trace mode. */
  logVerbose(msg: string): void {
    if (this.isVerbose) console.log(cyan(msg));
  }

  /** Log a tool invocation — full JSON input in debug/trace, summary line in info. */
  logTool(name: string, input: Record<string, unknown>): void {
    const summary = this.isVerbose
      ? JSON.stringify(input)
      : toolInputSummary(name, input);
    if (!this.isQuiet) {
      if (this.isVerbose) {
        const inputStr = JSON.stringify(input, null, 2);
        this.logVerbose(`  [tool] ${name}:\n${inputStr}`);
      } else {
        this.log(`  [tool] ${name}${summary ? ": " + summary : ""}`);
      }
    }
    this.onLog?.({ type: "agent:tool", name, summary });
  }

  /**
   * Log assistant text.
   * Console: info → first line (120ch), debug → truncate(2000), trace → full.
   * onLog: identical to console at each level.
   */
  logAssistant(text: string): void {
    if (!this.isQuiet) {
      const trimmed = text.trim();
      if (trimmed) {
        if (this.isTrace) {
          this.logVerbose(`  [assistant] ${trimmed}`);
        } else if (this.isDebug) {
          this.logVerbose(`  [assistant] ${truncate(trimmed, 2000)}`);
        } else {
          const firstLine = trimmed.split("\n")[0];
          this.log(`  [assistant] ${truncate(firstLine, 120)}`);
        }
      }
    }
    // onLog: trace → full, debug → truncate(2000), info/quiet → truncate(2000)
    if (this.isTrace) {
      this.onLog?.({ type: "agent:text", text });
    } else {
      this.onLog?.({ type: "agent:text", text: truncate(text, 2000) });
    }
  }

  /** Send event directly to onLog callback only (no console output). */
  sendToLog(event: Parameters<NonNullable<OnLogCallback>>[0]): void {
    this.onLog?.(event);
  }

  /**
   * Log tool result.
   * Console: info → first line (120ch), debug → truncate(200), trace → full.
   * onLog: identical to console at each level.
   */
  logToolResult(summary: string): void {
    if (!this.isQuiet) {
      const trimmed = summary.trim();
      if (trimmed) {
        if (this.isTrace) {
          this.logVerbose(`  [tool-result] ${trimmed}`);
        } else if (this.isDebug) {
          this.logVerbose(`  [tool-result] ${truncate(trimmed, 200)}`);
        } else {
          this.log(`  [tool-result] ${truncate(trimmed.split("\n")[0], 120)}`);
        }
      }
    }
    // onLog: trace → full, debug → truncate(200), info/quiet → truncate(200)
    if (this.isTrace) {
      this.onLog?.({ type: "agent:tool_result", summary });
    } else {
      this.onLog?.({ type: "agent:tool_result", summary: truncate(summary, 200) });
    }
  }
}
