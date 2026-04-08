import { describe, it, expect } from "vitest";
import { parseSignal, parseReport, parseReviewReport, parsePrdReadySignal } from "../core/drivers/types.js";

describe("parseSignal", () => {
  it("returns complete for <task-complete>DONE</task-complete>", () => {
    const result = parseSignal("some output\n<task-complete>DONE</task-complete>\nmore text");
    expect(result).toEqual({ type: "complete" });
  });

  it("returns blocked with reason for <task-blocked>", () => {
    const result = parseSignal("<task-blocked>Missing API key</task-blocked>");
    expect(result).toEqual({ type: "blocked", reason: "Missing API key" });
  });

  it("returns none when no XML tags present", () => {
    const result = parseSignal("Just regular output without any signals");
    expect(result).toEqual({ type: "none" });
  });

  it("returns none for empty string", () => {
    const result = parseSignal("");
    expect(result).toEqual({ type: "none" });
  });

  it("blocked takes priority over complete when both present", () => {
    const text = "<task-complete>DONE</task-complete>\n<task-blocked>actually blocked</task-blocked>";
    const result = parseSignal(text);
    expect(result).toEqual({ type: "blocked", reason: "actually blocked" });
  });

  it("works with tags buried in multiline output", () => {
    const text = `
Line 1 of output
Line 2 of output
Some more work happening here
<task-complete>DONE</task-complete>
Final line
`;
    const result = parseSignal(text);
    expect(result).toEqual({ type: "complete" });
  });

  it("trims whitespace from blocked reason", () => {
    const result = parseSignal("<task-blocked>  needs dependency  </task-blocked>");
    expect(result).toEqual({ type: "blocked", reason: "needs dependency" });
  });

  it("handles multiline blocked reason", () => {
    const result = parseSignal("<task-blocked>line1\nline2\nline3</task-blocked>");
    expect(result).toEqual({ type: "blocked", reason: "line1\nline2\nline3" });
  });

  it("is case-insensitive for tag names", () => {
    const result = parseSignal("<TASK-COMPLETE>DONE</TASK-COMPLETE>");
    expect(result).toEqual({ type: "complete" });
  });

  it("ignores unpaired <task-complete> quoted in model reasoning", () => {
    const text = [
      'output the following: <task-complete>DONE</task-complete>',
      "reasoning about signals",
      "more reasoning with <task-complete> mentioned",
      "<task-complete>DONE</task-complete>",
    ].join("\n");
    const result = parseSignal(text);
    expect(result).toEqual({ type: "complete" });
  });

  it("ignores unpaired <task-blocked> quoted in model reasoning", () => {
    // Model quotes just the opening tag mid-sentence, then writes the real pair later
    const text = [
      "If blocked, output <task-blocked> with a reason",
      "<task-blocked>Actually blocked</task-blocked>",
    ].join("\n");
    const result = parseSignal(text);
    expect(result).toEqual({ type: "blocked", reason: "Actually blocked" });
  });
});

describe("parseReport", () => {
  it("extracts report from <task-report> tag", () => {
    const text = "some output\n<task-report>Work done here.</task-report>\n<task-complete>DONE</task-complete>";
    expect(parseReport(text)).toBe("Work done here.");
  });

  it("returns null when no <task-report> tag", () => {
    expect(parseReport("just text <task-complete>DONE</task-complete>")).toBeNull();
  });

  it("extracts multiline report", () => {
    const text = "<task-report>\nLine 1\nLine 2\nLine 3\n</task-report>";
    expect(parseReport(text)).toBe("Line 1\nLine 2\nLine 3");
  });

  it("is case-insensitive", () => {
    expect(parseReport("<TASK-REPORT>Done.</TASK-REPORT>")).toBe("Done.");
  });

  it("returns null for empty string", () => {
    expect(parseReport("")).toBeNull();
  });

  it("returns null for empty tag", () => {
    expect(parseReport("<task-report></task-report>")).toBeNull();
  });

  it("returns null for whitespace-only tag", () => {
    expect(parseReport("<task-report>   \n  </task-report>")).toBeNull();
  });

  it("takes last match when multiple tags present", () => {
    const text = "<task-report>First report</task-report>\nMore text\n<task-report>Final report</task-report>";
    expect(parseReport(text)).toBe("Final report");
  });

  it("caps report at 5000 characters", () => {
    const longText = "A".repeat(6000);
    expect(parseReport(`<task-report>${longText}</task-report>`)!.length).toBe(5000);
  });

  it("ignores unpaired <task-report> quoted in model reasoning", () => {
    // Model quotes system prompt in its reasoning, creating an unpaired opening tag
    // before the real <task-report>...</task-report> pair
    const text = [
      "Some reasoning text",
      'Before writing <task-report> and signaling completion, you MUST terminate processes',
      "More reasoning about what to do",
      "<task-report>",
      "Real report content here.",
      "</task-report>",
      "<task-complete>DONE</task-complete>",
    ].join("\n");
    expect(parseReport(text)).toBe("Real report content here.");
  });

  it("ignores <task-report> inside <think> blocks", () => {
    const text = [
      "<think>",
      'Before writing <task-report> and signaling completion',
      "</think>",
      "<task-report>",
      "Actual report.",
      "</task-report>",
    ].join("\n");
    expect(parseReport(text)).toBe("Actual report.");
  });
});

describe("parseReviewReport", () => {
  it("extracts report from <review-report> tag", () => {
    const text = "some output\n<review-report>### Strengths\n- Good code</review-report>\n<task-complete>DONE</task-complete>";
    expect(parseReviewReport(text)).toBe("### Strengths\n- Good code");
  });

  it("returns null when no <review-report> tag", () => {
    expect(parseReviewReport("just text <task-complete>DONE</task-complete>")).toBeNull();
  });

  it("takes last match when multiple tags present", () => {
    const text = "<review-report>First</review-report>\n<review-report>Final review</review-report>";
    expect(parseReviewReport(text)).toBe("Final review");
  });

  it("is case-insensitive", () => {
    expect(parseReviewReport("<REVIEW-REPORT>Done.</REVIEW-REPORT>")).toBe("Done.");
  });

  it("returns null for empty tag", () => {
    expect(parseReviewReport("<review-report></review-report>")).toBeNull();
  });

  it("caps at 5000 characters", () => {
    const longText = "B".repeat(6000);
    expect(parseReviewReport(`<review-report>${longText}</review-report>`)!.length).toBe(5000);
  });

  it("does not match <task-report> tags", () => {
    expect(parseReviewReport("<task-report>Not a review</task-report>")).toBeNull();
  });

  it("ignores unpaired <review-report> quoted in model reasoning", () => {
    const text = [
      'Write a <review-report> before signaling',
      "reasoning",
      "<review-report>",
      "Real review content.",
      "</review-report>",
    ].join("\n");
    expect(parseReviewReport(text)).toBe("Real review content.");
  });
});

describe("parsePrdReadySignal", () => {
  it("returns true when tag is the final content", () => {
    const text = "Here is your PRD.\n<prd-ready>true</prd-ready>";
    expect(parsePrdReadySignal(text)).toBe(true);
  });

  it("returns true when tag is followed by trailing whitespace", () => {
    const text = "Done.\n<prd-ready>true</prd-ready>\n  \n";
    expect(parsePrdReadySignal(text)).toBe(true);
  });

  it("returns false when tag is in the middle of text", () => {
    const text = "Some text\n<prd-ready>true</prd-ready>\nMore text after";
    expect(parsePrdReadySignal(text)).toBe(false);
  });

  it("returns false when no tag present", () => {
    expect(parsePrdReadySignal("Just regular output")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(parsePrdReadySignal("")).toBe(false);
  });

  it("returns false when tag content is not 'true'", () => {
    expect(parsePrdReadySignal("<prd-ready>false</prd-ready>")).toBe(false);
    expect(parsePrdReadySignal("<prd-ready>done</prd-ready>")).toBe(false);
    expect(parsePrdReadySignal("<prd-ready></prd-ready>")).toBe(false);
  });

  it("is case-insensitive for tag name", () => {
    expect(parsePrdReadySignal("<PRD-READY>true</PRD-READY>")).toBe(true);
    expect(parsePrdReadySignal("<Prd-Ready>true</Prd-Ready>")).toBe(true);
  });

  it("is case-insensitive for content", () => {
    expect(parsePrdReadySignal("<prd-ready>TRUE</prd-ready>")).toBe(true);
    expect(parsePrdReadySignal("<prd-ready>True</prd-ready>")).toBe(true);
  });

  it("allows whitespace inside tag content", () => {
    expect(parsePrdReadySignal("<prd-ready> true </prd-ready>")).toBe(true);
    expect(parsePrdReadySignal("<prd-ready>\n true \n</prd-ready>")).toBe(true);
  });

  it("ignores quoted tag in instructions when real tag follows", () => {
    const text = [
      'When done, output <prd-ready>true</prd-ready>',
      "Here is the PRD content...",
      "<prd-ready>true</prd-ready>",
    ].join("\n");
    expect(parsePrdReadySignal(text)).toBe(true);
  });

  it("ignores quoted tag in instructions when no terminal tag", () => {
    const text = [
      'When done, output <prd-ready>true</prd-ready>',
      "Here is the PRD content...",
      "Still working on it.",
    ].join("\n");
    expect(parsePrdReadySignal(text)).toBe(false);
  });

  it("ignores inline instruction tag even when it is the terminal content", () => {
    // Regression: an instructional example at the end of the buffer must NOT
    // trigger auto-finish — only a tag on its own line counts.
    const text = "When done, output <prd-ready>true</prd-ready>";
    expect(parsePrdReadySignal(text)).toBe(false);
  });

  it("ignores inline instruction tag at end with trailing whitespace", () => {
    const text = "When done, output <prd-ready>true</prd-ready>\n  ";
    expect(parsePrdReadySignal(text)).toBe(false);
  });

  it("returns true when tag is the only content", () => {
    expect(parsePrdReadySignal("<prd-ready>true</prd-ready>")).toBe(true);
  });

  it("returns false for partial/incomplete tag at end", () => {
    expect(parsePrdReadySignal("text\n<prd-ready>true")).toBe(false);
    expect(parsePrdReadySignal("text\n<prd-ready>")).toBe(false);
  });

  // Fragmented accumulation tests — verify that the helper works on
  // concatenated text regardless of how transport chunks split the tag.
  describe("fragmented accumulation", () => {
    const accumulate = (chunks: string[]) => chunks.join("");

    it("detects tag split across two chunks", () => {
      const buffer = accumulate([
        "Here is your PRD.\n<prd-re",
        "ady>true</prd-ready>",
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(true);
    });

    it("detects tag split across many small chunks", () => {
      const tag = "<prd-ready>true</prd-ready>";
      // Split every 3 characters to simulate tiny transport frames
      const chunks: string[] = ["PRD content.\n"];
      for (let i = 0; i < tag.length; i += 3) {
        chunks.push(tag.slice(i, i + 3));
      }
      const buffer = accumulate(chunks);
      expect(parsePrdReadySignal(buffer)).toBe(true);
    });

    it("detects tag when closing tag arrives in a separate chunk", () => {
      const buffer = accumulate([
        "Some PRD text\n<prd-ready>true",
        "</prd-ready>",
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(true);
    });

    it("detects tag when content 'true' is a separate chunk", () => {
      const buffer = accumulate([
        "PRD.\n<prd-ready>",
        "true",
        "</prd-ready>",
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(true);
    });

    it("detects tag with trailing whitespace arriving as final chunk", () => {
      const buffer = accumulate([
        "PRD.\n<prd-ready>true</prd-ready>",
        "\n  \n",
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(true);
    });

    it("returns false when non-whitespace text follows tag in later chunk", () => {
      const buffer = accumulate([
        "PRD.\n<prd-ready>true</prd-ready>",
        "\nMore content after",
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(false);
    });

    it("returns false when tag is complete but followed by another sentence in next chunk", () => {
      const buffer = accumulate([
        "Here is the PRD.\n<prd-ready>true</prd-ready>\n",
        "Actually, one more thing...",
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(false);
    });

    it("returns false for incomplete tag even after multiple chunks", () => {
      const buffer = accumulate([
        "PRD.\n<prd-",
        "ready>",
        "true",
        // Missing closing tag — stream not finished
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(false);
    });

    it("handles quoted tag in early chunk, real tag in final chunk", () => {
      const buffer = accumulate([
        'Output <prd-ready>true</prd-ready> when done.\n',
        "Here is the PRD...\n",
        "<prd-ready>true</prd-ready>",
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(true);
    });

    it("returns false for quoted tag in early chunk with no terminal tag", () => {
      const buffer = accumulate([
        'Output <prd-ready>true</prd-ready> when done.\n',
        "Here is the PRD content.\n",
        "Still working...",
      ]);
      expect(parsePrdReadySignal(buffer)).toBe(false);
    });

    it("single-character-at-a-time accumulation", () => {
      const full = "Done.\n<prd-ready>true</prd-ready>\n";
      const chunks = full.split(""); // one char per chunk
      const buffer = accumulate(chunks);
      expect(parsePrdReadySignal(buffer)).toBe(true);
    });
  });
});
