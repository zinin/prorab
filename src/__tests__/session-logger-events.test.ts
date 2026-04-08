import { describe, it, expect, vi } from "vitest";
import { SessionLogger } from "../core/drivers/logging.js";

describe("SessionLogger onLog callback", () => {
  it("calls onLog with agent:text on logAssistant", () => {
    const onLog = vi.fn();
    const logger = new SessionLogger("info", onLog);
    logger.logAssistant("Hello world");
    expect(onLog).toHaveBeenCalledWith({ type: "agent:text", text: "Hello world" });
  });

  it("calls onLog with agent:tool on logTool", () => {
    const onLog = vi.fn();
    const logger = new SessionLogger("info", onLog);
    logger.logTool("Read", { file_path: "/foo/bar.ts" });
    expect(onLog).toHaveBeenCalledWith({ type: "agent:tool", name: "Read", summary: expect.any(String) });
  });

  it("calls onLog with agent:tool_result on logToolResult", () => {
    const onLog = vi.fn();
    const logger = new SessionLogger("info", onLog);
    logger.logToolResult("file contents...");
    expect(onLog).toHaveBeenCalledWith({ type: "agent:tool_result", summary: "file contents..." });
  });

  it("works without onLog callback (backward compatible)", () => {
    const logger = new SessionLogger("info");
    expect(() => logger.logAssistant("test")).not.toThrow();
  });

  it("fires onLog even in quiet mode", () => {
    const onLog = vi.fn();
    const logger = new SessionLogger("quiet", onLog);
    logger.logAssistant("quiet text");
    logger.logTool("Bash", { command: "ls" });
    logger.logToolResult("output");
    expect(onLog).toHaveBeenCalledTimes(3);
    expect(onLog).toHaveBeenCalledWith({ type: "agent:text", text: "quiet text" });
    expect(onLog).toHaveBeenCalledWith({ type: "agent:tool", name: "Bash", summary: expect.any(String) });
    expect(onLog).toHaveBeenCalledWith({ type: "agent:tool_result", summary: "output" });
  });

  it("fires onLog with untrimmed text", () => {
    const onLog = vi.fn();
    const logger = new SessionLogger("info", onLog);
    logger.logAssistant("  padded text  ");
    expect(onLog).toHaveBeenCalledWith({ type: "agent:text", text: "  padded text  " });
  });
});
