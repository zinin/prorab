import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  truncate,
  toolInputSummary,
  SessionLogger,
} from "../core/drivers/logging.js";

describe("truncate", () => {
  it("returns string unchanged when within limit", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns string unchanged when exactly at limit", () => {
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends … when over limit", () => {
    expect(truncate("hello world", 5)).toBe("hello…");
  });
});

describe("toolInputSummary", () => {
  it("extracts file_path for Read (PascalCase)", () => {
    expect(toolInputSummary("Read", { file_path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
  });

  it("extracts file_path for read (lowercase)", () => {
    expect(toolInputSummary("read", { file_path: "/foo/bar.ts" })).toBe("/foo/bar.ts");
  });

  it("extracts pattern for Glob", () => {
    expect(toolInputSummary("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
  });

  it("extracts pattern for Grep (prefers pattern over path)", () => {
    expect(toolInputSummary("Grep", { pattern: "TODO", path: "/src" })).toBe("TODO");
  });

  it("extracts command for Bash and truncates", () => {
    const longCmd = "a".repeat(100);
    const result = toolInputSummary("bash", { command: longCmd });
    expect(result.length).toBeLessThanOrEqual(81); // 80 + "…"
  });

  it("extracts description for Task", () => {
    expect(toolInputSummary("Task", { description: "do stuff" })).toBe("do stuff");
  });

  it("falls back to first string value for unknown tools", () => {
    expect(toolInputSummary("CustomTool", { query: "search term" })).toBe("search term");
  });

  it("returns empty string when no string values", () => {
    expect(toolInputSummary("CustomTool", { count: 42 })).toBe("");
  });

  it("returns empty string for empty input object", () => {
    expect(toolInputSummary("Read", {})).toBe("");
  });

  it("extracts file_path for Write", () => {
    expect(toolInputSummary("Write", { file_path: "/out.ts", content: "x" })).toBe("/out.ts");
  });

  it("extracts file_path for Edit", () => {
    expect(toolInputSummary("edit", { file_path: "/out.ts", old_string: "a" })).toBe("/out.ts");
  });

  it("truncates Task prompt when description missing", () => {
    const longPrompt = "b".repeat(100);
    const result = toolInputSummary("Task", { prompt: longPrompt });
    expect(result.length).toBeLessThanOrEqual(61); // 60 + "…"
  });

  it("returns Grep pattern even without path", () => {
    expect(toolInputSummary("grep", { pattern: "fixme" })).toBe("fixme");
  });

  it("returns empty string for Grep without pattern", () => {
    expect(toolInputSummary("grep", { path: "/src" })).toBe("");
  });
});

describe("SessionLogger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("log() outputs in info mode", () => {
    const logger = new SessionLogger("info");
    logger.log("test");
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("log() is silent in quiet mode", () => {
    const logger = new SessionLogger("quiet");
    logger.log("test");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logVerbose() outputs in debug mode", () => {
    const logger = new SessionLogger("debug");
    logger.logVerbose("test");
    expect(consoleSpy).toHaveBeenCalledOnce();
  });

  it("logVerbose() is silent in info mode", () => {
    const logger = new SessionLogger("info");
    logger.logVerbose("test");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logAssistant() shows first line in info mode", () => {
    const logger = new SessionLogger("info");
    logger.logAssistant("line one\nline two\nline three");
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("line one");
    expect(output).not.toContain("line two");
  });

  it("logAssistant() shows truncated text in debug mode", () => {
    const logger = new SessionLogger("debug");
    logger.logAssistant("line one\nline two");
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("line one\nline two");
  });

  it("logAssistant() shows full text in trace mode", () => {
    const logger = new SessionLogger("trace");
    const longText = "a".repeat(3000);
    logger.logAssistant(longText);
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain(longText);
  });

  it("logAssistant() skips empty text", () => {
    const logger = new SessionLogger("info");
    logger.logAssistant("   ");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logTool() shows summary in info mode", () => {
    const logger = new SessionLogger("info");
    logger.logTool("Read", { file_path: "/foo.ts" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("Read");
    expect(output).toContain("/foo.ts");
  });

  it("logTool() shows full JSON in debug mode", () => {
    const logger = new SessionLogger("debug");
    logger.logTool("Read", { file_path: "/foo.ts" });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('"file_path"');
  });

  it("logToolResult() shows first line in info mode", () => {
    const logger = new SessionLogger("info");
    logger.logToolResult("output line one\noutput line two");
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("output line one");
    expect(output).not.toContain("output line two");
  });

  it("logToolResult() shows truncated text in debug mode", () => {
    const logger = new SessionLogger("debug");
    logger.logToolResult("output line one\noutput line two");
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    // debug truncates at 200ch — short text still fully shown
    expect(output).toContain("output line one\noutput line two");
  });

  it("logToolResult() shows full text in trace mode", () => {
    const logger = new SessionLogger("trace");
    const longResult = "x".repeat(500);
    logger.logToolResult(longResult);
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain(longResult);
  });

  it("logToolResult() skips empty text", () => {
    const logger = new SessionLogger("info");
    logger.logToolResult("   ");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logTool() is silent in quiet mode", () => {
    const logger = new SessionLogger("quiet");
    logger.logTool("Read", { file_path: "/foo.ts" });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logAssistant() is silent in quiet mode", () => {
    const logger = new SessionLogger("quiet");
    logger.logAssistant("hello world");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logToolResult() is silent in quiet mode", () => {
    const logger = new SessionLogger("quiet");
    logger.logToolResult("some output");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("logTool() shows tool name without summary when input is empty", () => {
    const logger = new SessionLogger("info");
    logger.logTool("CustomTool", { count: 42 });
    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("CustomTool");
    expect(output).not.toContain(":");
  });
});

