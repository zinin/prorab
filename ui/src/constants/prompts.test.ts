import { describe, expect, it } from "vitest";
import { IDEA_TO_PRD_PROMPT } from "./prompts";

describe("IDEA_TO_PRD_PROMPT", () => {
  it("is exported and is a non-empty string", () => {
    expect(typeof IDEA_TO_PRD_PROMPT).toBe("string");
    expect(IDEA_TO_PRD_PROMPT.length).toBeGreaterThan(0);
  });

  it("has length > 4000 characters (full skill content)", () => {
    expect(IDEA_TO_PRD_PROMPT.length).toBeGreaterThan(4000);
  });

  it("contains PRD-related key phrases", () => {
    expect(IDEA_TO_PRD_PROMPT).toContain("PRD");
    expect(IDEA_TO_PRD_PROMPT).toContain("discovery");
    expect(IDEA_TO_PRD_PROMPT).toContain("Requirements");
  });

  it("covers all six phases", () => {
    expect(IDEA_TO_PRD_PROMPT).toContain("Phase 1: Explore Context");
    expect(IDEA_TO_PRD_PROMPT).toContain("Phase 2: Discovery Questions");
    expect(IDEA_TO_PRD_PROMPT).toContain("Phase 3: Explore Approaches");
    expect(IDEA_TO_PRD_PROMPT).toContain("Phase 4: Design Validation");
    expect(IDEA_TO_PRD_PROMPT).toContain("Phase 5: Write PRD");
    expect(IDEA_TO_PRD_PROMPT).toContain("Phase 6: Stop");
  });

  it("has no leading or trailing whitespace (trimmed)", () => {
    expect(IDEA_TO_PRD_PROMPT).toBe(IDEA_TO_PRD_PROMPT.trim());
  });

  it("contains the <prd-ready>true</prd-ready> terminal tag", () => {
    expect(IDEA_TO_PRD_PROMPT).toContain("<prd-ready>true</prd-ready>");
  });

  it("requires successful write of .taskmaster/docs/prd.md before outputting the tag", () => {
    expect(IDEA_TO_PRD_PROMPT).toMatch(
      /Rules \(non-negotiable\):.*only after.*successfully writing.*\.taskmaster\/docs\/prd\.md.*the file must exist/is,
    );
  });

  it("specifies the tag must be the last meaningful line", () => {
    expect(IDEA_TO_PRD_PROMPT).toContain("last meaningful line");
  });

  describe("Phase 6 final-message contract", () => {
    it("Phase 6 describes the terminal signal as part of the final message structure", () => {
      // Phase 6 must mention the terminal signal inline — extract the Phase 6 section
      // and verify it contains the tag reference (not just any match across the whole prompt)
      const phase6Start = IDEA_TO_PRD_PROMPT.indexOf("### Phase 6: Stop");
      const phase6Section = IDEA_TO_PRD_PROMPT.slice(phase6Start, phase6Start + 800);
      expect(phase6Section).toMatch(/Terminal signal/);
      expect(phase6Section).toContain("<prd-ready>true</prd-ready>");
    });

    it("Phase 6 states the conversation ends after the tag", () => {
      expect(IDEA_TO_PRD_PROMPT).toMatch(
        /Phase 6.*conversation ends/is,
      );
    });

    it("prohibits next steps, implementation plans, or follow-up after the tag", () => {
      expect(IDEA_TO_PRD_PROMPT).toMatch(
        /Do NOT suggest next steps/i,
      );
      expect(IDEA_TO_PRD_PROMPT).toMatch(
        /Do NOT continue the conversation after/i,
      );
    });

    it("prohibits invoking skills or tools after the terminal signal", () => {
      expect(IDEA_TO_PRD_PROMPT).toMatch(
        /Do NOT invoke any skill or tool after the terminal signal/i,
      );
    });

    it("prohibits outputting the tag mid-message (before summary)", () => {
      expect(IDEA_TO_PRD_PROMPT).toMatch(
        /Do NOT output the tag in the middle of a message/i,
      );
    });
  });

  describe("negative constraints on premature / quoted / non-terminal tag usage", () => {
    it("prohibits using the tag in examples, quotes, or explanations in generated output", () => {
      expect(IDEA_TO_PRD_PROMPT).toMatch(
        /Do NOT use.*<prd-ready>.*in examples.*quotes.*explanations.*in your generated output/is,
      );
    });

    it("prohibits any value other than true", () => {
      expect(IDEA_TO_PRD_PROMPT).toMatch(
        /Do NOT output.*<prd-ready>.*with any value other than.*true/is,
      );
    });

    it("describes the tag as a machine-readable signal, not a discussion topic", () => {
      expect(IDEA_TO_PRD_PROMPT).toContain("machine-readable signal");
      expect(IDEA_TO_PRD_PROMPT).toContain("not a discussion topic");
    });
  });
});
