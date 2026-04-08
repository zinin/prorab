import { describe, it, expect } from "vitest";
import { isAllAnswered, assembleAnswers } from "../../ui/src/components/ask-question-logic";
import type { QuestionData } from "../../ui/src/stores/chat";

// --- Helpers ---

function singleQ(question: string, options: string[]): QuestionData {
  return {
    question,
    header: question.slice(0, 10),
    options: options.map((label) => ({ label, description: "" })),
    multiSelect: false,
  };
}

function multiQ(question: string, options: string[]): QuestionData {
  return {
    question,
    header: question.slice(0, 10),
    options: options.map((label) => ({ label, description: "" })),
    multiSelect: true,
  };
}

// ---------------------------------------------------------------------------
// isAllAnswered
// ---------------------------------------------------------------------------
describe("isAllAnswered", () => {
  it("returns true when there are no questions", () => {
    expect(isAllAnswered([], {}, {}, {})).toBe(true);
  });

  // --- single-select ---

  it("returns false when a single-select question has no selection", () => {
    const questions = [singleQ("Pick one?", ["A", "B"])];
    expect(isAllAnswered(questions, {}, {}, {})).toBe(false);
  });

  it("returns false when a single-select question has empty string selection", () => {
    const questions = [singleQ("Pick one?", ["A", "B"])];
    expect(isAllAnswered(questions, { 0: "" }, {}, {})).toBe(false);
  });

  it("returns true when a single-select question has a non-empty selection", () => {
    const questions = [singleQ("Pick one?", ["A", "B"])];
    expect(isAllAnswered(questions, { 0: "A" }, {}, {})).toBe(true);
  });

  // --- multi-select ---

  it("returns false when a multi-select question has no selection", () => {
    const questions = [multiQ("Pick many?", ["A", "B", "C"])];
    expect(isAllAnswered(questions, {}, {}, {})).toBe(false);
  });

  it("returns false when a multi-select question has empty array", () => {
    const questions = [multiQ("Pick many?", ["A", "B", "C"])];
    expect(isAllAnswered(questions, { 0: [] }, {}, {})).toBe(false);
  });

  it("returns true when a multi-select question has at least one item", () => {
    const questions = [multiQ("Pick many?", ["A", "B", "C"])];
    expect(isAllAnswered(questions, { 0: ["B"] }, {}, {})).toBe(true);
  });

  it("returns true when a multi-select question has multiple items", () => {
    const questions = [multiQ("Pick many?", ["A", "B", "C"])];
    expect(isAllAnswered(questions, { 0: ["A", "C"] }, {}, {})).toBe(true);
  });

  // --- custom text ---

  it("returns true when useCustom is set and custom text is non-empty", () => {
    const questions = [singleQ("Pick one?", ["A", "B"])];
    expect(isAllAnswered(questions, {}, { 0: "my answer" }, { 0: true })).toBe(true);
  });

  it("returns false when useCustom is set but custom text is empty", () => {
    const questions = [singleQ("Pick one?", ["A", "B"])];
    expect(isAllAnswered(questions, { 0: "A" }, { 0: "" }, { 0: true })).toBe(false);
  });

  it("returns false when useCustom is set but custom text is only whitespace", () => {
    const questions = [singleQ("Pick one?", ["A", "B"])];
    expect(isAllAnswered(questions, { 0: "A" }, { 0: "   " }, { 0: true })).toBe(false);
  });

  it("ignores selectedOptions when useCustom is true", () => {
    const questions = [singleQ("Pick one?", ["A", "B"])];
    // Has a selection but useCustom is true with empty text → not answered
    expect(isAllAnswered(questions, { 0: "A" }, { 0: "" }, { 0: true })).toBe(false);
  });

  // --- multiple questions ---

  it("returns true only when ALL questions are answered", () => {
    const questions = [
      singleQ("Q1?", ["A", "B"]),
      multiQ("Q2?", ["X", "Y"]),
    ];
    // Only first answered
    expect(isAllAnswered(questions, { 0: "A" }, {}, {})).toBe(false);
    // Only second answered
    expect(isAllAnswered(questions, { 1: ["X"] }, {}, {})).toBe(false);
    // Both answered
    expect(isAllAnswered(questions, { 0: "B", 1: ["X", "Y"] }, {}, {})).toBe(true);
  });

  it("handles mixed custom and selection across questions", () => {
    const questions = [
      singleQ("Q1?", ["A", "B"]),
      multiQ("Q2?", ["X", "Y"]),
    ];
    // Q1 uses custom text, Q2 uses selection
    expect(
      isAllAnswered(questions, { 1: ["X"] }, { 0: "custom" }, { 0: true }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assembleAnswers
// ---------------------------------------------------------------------------
describe("assembleAnswers", () => {
  it("returns empty object for no questions", () => {
    expect(assembleAnswers([], {}, {}, {})).toEqual({});
  });

  // --- single-select ---

  it("returns string value for single-select question", () => {
    const questions = [singleQ("Which color?", ["Red", "Blue"])];
    const answers = assembleAnswers(questions, { 0: "Red" }, {}, {});
    expect(answers).toEqual({ "Which color?": "Red" });
  });

  it("returns empty string for unanswered single-select", () => {
    const questions = [singleQ("Which color?", ["Red", "Blue"])];
    const answers = assembleAnswers(questions, {}, {}, {});
    expect(answers).toEqual({ "Which color?": "" });
  });

  // --- multi-select ---

  it("returns string array for multi-select question", () => {
    const questions = [multiQ("Which fruits?", ["Apple", "Banana", "Cherry"])];
    const answers = assembleAnswers(questions, { 0: ["Apple", "Cherry"] }, {}, {});
    expect(answers).toEqual({ "Which fruits?": ["Apple", "Cherry"] });
  });

  it("returns empty array for unanswered multi-select", () => {
    const questions = [multiQ("Which fruits?", ["Apple", "Banana"])];
    const answers = assembleAnswers(questions, {}, {}, {});
    expect(answers).toEqual({ "Which fruits?": [] });
  });

  it("preserves array type for multi-select — does NOT join", () => {
    const questions = [multiQ("Pick?", ["A", "B", "C"])];
    const answers = assembleAnswers(questions, { 0: ["A", "B"] }, {}, {});
    expect(Array.isArray(answers["Pick?"])).toBe(true);
    expect(answers["Pick?"]).toEqual(["A", "B"]);
  });

  // --- custom text ---

  it("returns trimmed custom text when useCustom is true", () => {
    const questions = [singleQ("Which color?", ["Red", "Blue"])];
    const answers = assembleAnswers(questions, { 0: "Red" }, { 0: "  Green  " }, { 0: true });
    expect(answers).toEqual({ "Which color?": "Green" });
  });

  it("returns custom text as string even for multi-select questions", () => {
    const questions = [multiQ("Which fruits?", ["Apple", "Banana"])];
    const answers = assembleAnswers(questions, { 0: ["Apple"] }, { 0: "Mango" }, { 0: true });
    // Custom text is always a plain string, never an array
    expect(answers).toEqual({ "Which fruits?": "Mango" });
    expect(typeof answers["Which fruits?"]).toBe("string");
  });

  it("ignores custom text when useCustom is false", () => {
    const questions = [singleQ("Q?", ["A", "B"])];
    const answers = assembleAnswers(questions, { 0: "A" }, { 0: "custom" }, { 0: false });
    expect(answers).toEqual({ "Q?": "A" });
  });

  // --- multiple questions ---

  it("assembles answers for multiple questions", () => {
    const questions = [
      singleQ("Q1?", ["A", "B"]),
      multiQ("Q2?", ["X", "Y", "Z"]),
    ];
    const answers = assembleAnswers(
      questions,
      { 0: "B", 1: ["X", "Z"] },
      {},
      {},
    );
    expect(answers).toEqual({
      "Q1?": "B",
      "Q2?": ["X", "Z"],
    });
  });

  it("mixes custom and selected answers across questions", () => {
    const questions = [
      singleQ("Q1?", ["A", "B"]),
      multiQ("Q2?", ["X", "Y"]),
    ];
    const answers = assembleAnswers(
      questions,
      { 1: ["Y"] },
      { 0: "custom1" },
      { 0: true },
    );
    expect(answers).toEqual({
      "Q1?": "custom1",
      "Q2?": ["Y"],
    });
  });

  it("uses question text as key (not header)", () => {
    const questions: QuestionData[] = [{
      question: "What is your preferred language?",
      header: "Lang",
      options: [
        { label: "TypeScript", description: "Typed JS" },
        { label: "Python", description: "Dynamic" },
      ],
      multiSelect: false,
    }];
    const answers = assembleAnswers(questions, { 0: "TypeScript" }, {}, {});
    expect(Object.keys(answers)).toEqual(["What is your preferred language?"]);
    expect(answers["What is your preferred language?"]).toBe("TypeScript");
  });

  it("preserves option descriptions in question data without affecting answers", () => {
    const questions: QuestionData[] = [{
      question: "Pick?",
      header: "Choice",
      options: [
        { label: "Option A", description: "Description for A" },
        { label: "Option B", description: "Description for B" },
      ],
      multiSelect: false,
    }];
    const answers = assembleAnswers(questions, { 0: "Option A" }, {}, {});
    // Answer value is the label, not the description
    expect(answers["Pick?"]).toBe("Option A");
  });
});
