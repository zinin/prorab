/**
 * Structural tests for BatchExpandProgress.vue — verifies component structure,
 * data-testid attributes, conditional rendering, and wiring to logic helpers.
 *
 * Uses source-level assertions (same approach as expand-progress-component.test.ts)
 * because @vue/test-utils is not a project dependency.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const componentPath = resolve(__dirname, "../../ui/src/components/BatchExpandProgress.vue");
const componentSource = readFileSync(componentPath, "utf-8");

// Extract sections — use greedy match for template (may contain inner <template> tags)
const scriptMatch = componentSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
const templateMatch = componentSource.match(/<template>([\s\S]*)<\/template>/s);
const styleMatch = componentSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);

const scriptSection = scriptMatch?.[1] ?? "";
const templateSection = templateMatch?.[1] ?? "";
const styleSection = styleMatch?.[1] ?? "";

describe("BatchExpandProgress component structure", () => {
  describe("imports", () => {
    it("imports SlotState, TaskSummaryItem, BatchExpandProgressData types from store", () => {
      expect(scriptSection).toContain("SlotState");
      expect(scriptSection).toContain("TaskSummaryItem");
      expect(scriptSection).toContain("BatchExpandProgressData");
    });

    it("imports BatchExpandOutcome type from types", () => {
      expect(scriptSection).toContain("BatchExpandOutcome");
    });

    it("imports launch helpers from batch-expand-launch-helpers", () => {
      expect(scriptSection).toContain("batch-expand-launch-helpers");
      expect(scriptSection).toContain("batchStatusText");
      expect(scriptSection).toContain("progressPercent");
      expect(scriptSection).toContain("taskCardClass");
      expect(scriptSection).toContain("taskCardLabel");
      expect(scriptSection).toContain("outcomeSummaryText");
    });

    it("imports pure logic helpers from batch-expand-progress-logic", () => {
      expect(scriptSection).toContain("batch-expand-progress-logic");
      expect(scriptSection).toContain("dotVariant");
      expect(scriptSection).toContain("outcomeLabel");
      expect(scriptSection).toContain("outcomeBannerClass");
      expect(scriptSection).toContain("hasTaskErrors");
      expect(scriptSection).toContain("showStopButton");
      expect(scriptSection).toContain("isStopDisabled");
      expect(scriptSection).toContain("showDoneButton");
      expect(scriptSection).toContain("contextLabel");
      expect(scriptSection).toContain("contextColor");
      expect(scriptSection).toContain("slotInfoLabel");
    });

    it("imports PrimeVue Button", () => {
      expect(scriptSection).toContain('import Button from "primevue/button"');
    });

    it("imports Vue composition API", () => {
      expect(scriptSection).toContain("ref");
      expect(scriptSection).toContain("watch");
      expect(scriptSection).toContain("nextTick");
      expect(scriptSection).toContain("computed");
      expect(scriptSection).toContain("onMounted");
    });
  });

  describe("store independence", () => {
    it("does not import any store directly", () => {
      expect(scriptSection).not.toContain("useBatchExpandStore");
      expect(scriptSection).not.toContain("useParsePrdStore");
      expect(scriptSection).not.toContain("useChatStore");
      expect(scriptSection).not.toContain("useExecutionStore");
      expect(scriptSection).not.toContain("defineStore");
    });

    it("does not import pinia", () => {
      expect(scriptSection).not.toContain("pinia");
    });

    it("does not call fetch directly", () => {
      expect(scriptSection).not.toContain("fetch(");
    });
  });

  describe("props", () => {
    it("declares state prop", () => {
      expect(scriptSection).toContain("state:");
    });

    it("declares slots prop", () => {
      expect(scriptSection).toContain("slots:");
    });

    it("declares summary prop", () => {
      expect(scriptSection).toContain("summary:");
    });

    it("declares progress prop", () => {
      expect(scriptSection).toContain("progress:");
    });

    it("declares outcome prop", () => {
      expect(scriptSection).toContain("outcome:");
    });

    it("declares activeSlotIndex prop", () => {
      expect(scriptSection).toContain("activeSlotIndex:");
    });

    it("declares error prop", () => {
      expect(scriptSection).toContain("error:");
    });

    it("declares contextUsage prop", () => {
      expect(scriptSection).toContain("contextUsage:");
    });

    it("declares pinned prop", () => {
      expect(scriptSection).toContain("pinned:");
    });
  });

  describe("emits", () => {
    it("declares stop emit", () => {
      expect(scriptSection).toMatch(/stop:\s*\[/);
    });

    it("declares dismiss emit", () => {
      expect(scriptSection).toMatch(/dismiss:\s*\[/);
    });

    it("declares selectTask emit", () => {
      expect(scriptSection).toMatch(/selectTask:\s*\[/);
    });
  });

  describe("computed properties using logic helpers", () => {
    it("computes statusLabel from batchStatusText", () => {
      expect(scriptSection).toMatch(/const\s+statusLabel\s*=\s*computed/);
      expect(scriptSection).toContain("batchStatusText(props.state");
    });

    it("computes dotClass from dotVariant helper", () => {
      expect(scriptSection).toMatch(/const\s+dotClass\s*=\s*computed/);
      expect(scriptSection).toContain("dotVariant(props.state");
    });

    it("computes showStop from showStopButton helper", () => {
      expect(scriptSection).toMatch(/const\s+showStop\s*=\s*computed/);
      expect(scriptSection).toContain("showStopButton(props.state");
    });

    it("computes stopDisabled from isStopDisabledFn helper", () => {
      expect(scriptSection).toMatch(/const\s+stopDisabled\s*=\s*computed/);
      expect(scriptSection).toContain("isStopDisabledFn(props.state");
    });

    it("computes showDone from showDoneButton helper", () => {
      expect(scriptSection).toMatch(/const\s+showDone\s*=\s*computed/);
      expect(scriptSection).toContain("showDoneButton(props.state");
    });

    it("computes outcomeBannerClass from outcomeBannerClassFn helper", () => {
      expect(scriptSection).toMatch(/const\s+outcomeBannerClass\s*=\s*computed/);
      expect(scriptSection).toContain("outcomeBannerClassFn(props.outcome");
    });

    it("computes outcomeText from outcomeLabel helper", () => {
      expect(scriptSection).toMatch(/const\s+outcomeText\s*=\s*computed/);
      expect(scriptSection).toContain("outcomeLabel(props.outcome");
    });

    it("computes contextLabel from contextLabelFn helper", () => {
      expect(scriptSection).toMatch(/const\s+contextLabel\s*=\s*computed/);
      expect(scriptSection).toContain("contextLabelFn(props.contextUsage");
    });

    it("computes contextColor from contextColorFn helper", () => {
      expect(scriptSection).toMatch(/const\s+contextColor\s*=\s*computed/);
      expect(scriptSection).toContain("contextColorFn(props.contextUsage");
    });

    it("computes slotInfoLabel from slotInfoLabelFn helper", () => {
      expect(scriptSection).toMatch(/const\s+slotInfoLabel\s*=\s*computed/);
      expect(scriptSection).toContain("slotInfoLabelFn(");
    });

    it("computes progressPct from progressPercent helper", () => {
      expect(scriptSection).toMatch(/const\s+progressPct\s*=\s*computed/);
      expect(scriptSection).toContain("progressPercent(props.progress");
    });
  });

  describe("auto-scroll", () => {
    it("defines scrollToBottom function", () => {
      expect(scriptSection).toMatch(/function\s+scrollToBottom/);
    });

    it("computes scrollSignature including activeSlotIndex for slot-switch trigger", () => {
      expect(scriptSection).toMatch(/const\s+scrollSignature\s*=\s*computed/);
      expect(scriptSection).toContain("props.activeSlotIndex");
      expect(scriptSection).toContain("last.content");
    });

    it("watches scrollSignature for auto-scroll", () => {
      expect(scriptSection).toMatch(/watch\(\s*scrollSignature\s*,\s*scrollToBottom\s*\)/);
    });

    it("calls scrollToBottom on mount when buffer is already populated", () => {
      expect(scriptSection).toContain("onMounted");
    });

    it("uses nextTick for scroll timing", () => {
      expect(scriptSection).toContain("nextTick");
    });

    it("declares outputEl ref for scroll container", () => {
      expect(scriptSection).toMatch(/const\s+outputEl\s*=\s*ref/);
    });
  });

  describe("template: data-testid attributes", () => {
    it("has batch-expand-progress on root element", () => {
      expect(templateSection).toContain('data-testid="batch-expand-progress"');
    });

    it("has batch-expand-status-text on status label", () => {
      expect(templateSection).toContain('data-testid="batch-expand-status-text"');
    });

    it("has batch-expand-stop-button on stop button", () => {
      expect(templateSection).toContain('data-testid="batch-expand-stop-button"');
    });

    it("has batch-expand-done-button on done/dismiss button", () => {
      expect(templateSection).toContain('data-testid="batch-expand-done-button"');
    });

    it("has batch-expand-context-usage on context usage label", () => {
      expect(templateSection).toContain('data-testid="batch-expand-context-usage"');
    });

    it("has batch-expand-cards on task cards container", () => {
      expect(templateSection).toContain('data-testid="batch-expand-cards"');
    });

    it("has batch-expand-card on individual task cards", () => {
      expect(templateSection).toContain('data-testid="batch-expand-card"');
    });

    it("has batch-expand-outcome-banner on outcome banner", () => {
      expect(templateSection).toContain('data-testid="batch-expand-outcome-banner"');
    });

    it("has batch-expand-error-banner on error banner", () => {
      expect(templateSection).toContain('data-testid="batch-expand-error-banner"');
    });
  });

  describe("template: header section", () => {
    it("renders statusLabel in status area", () => {
      expect(templateSection).toContain("{{ statusLabel }}");
    });

    it("binds dot class to dotClass", () => {
      expect(templateSection).toContain("dotClass");
    });

    it("conditionally shows stop button via showStop", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"showStop"/);
    });

    it("binds stop button disabled to stopDisabled", () => {
      expect(templateSection).toMatch(/:disabled\s*=\s*"stopDisabled"/);
    });

    it("binds stop button click to emit stop", () => {
      expect(templateSection).toContain("emit('stop')");
    });

    it("renders stop button with severity danger", () => {
      expect(templateSection).toContain('severity="danger"');
    });

    it("conditionally shows done button via showDone", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"showDone"/);
    });
  });

  describe("template: error banner", () => {
    it("conditionally shows error banner when error is present", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"error"/);
    });

    it("renders error message content", () => {
      expect(templateSection).toContain("{{ error }}");
    });
  });

  describe("template: task cards section", () => {
    it("iterates over summary items", () => {
      expect(templateSection).toMatch(/v-for\s*=\s*"item\s+in\s+summary"/);
    });

    it("binds card class via taskCardClass helper", () => {
      expect(templateSection).toContain("taskCardClass(");
    });

    it("emits selectTask on card click", () => {
      expect(templateSection).toContain("emit('selectTask'");
    });

    it("renders taskCardLabel for card label", () => {
      expect(templateSection).toContain("taskCardLabel(");
    });

    it("renders task id", () => {
      expect(templateSection).toContain("item.taskId");
    });
  });

  describe("template: outcome banner section", () => {
    it("conditionally shows banner in completed state with outcome", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"state\s*===\s*'completed'\s*&&\s*outcome"/);
    });

    it("binds banner class to outcomeBannerClass", () => {
      expect(templateSection).toContain("outcomeBannerClass");
    });

    it("renders outcomeText", () => {
      expect(templateSection).toContain("{{ outcomeText }}");
    });

    it("conditionally renders outcomeSummary", () => {
      expect(templateSection).toContain("outcomeSummary");
    });
  });

  describe("template: message output section", () => {
    it("renders empty placeholder when no messages", () => {
      expect(templateSection).toContain("Waiting for agent output");
    });

    it("renders completed empty state message", () => {
      expect(templateSection).toContain("Click a task card to view its output");
    });

    it("renders slotInfoLabel", () => {
      expect(templateSection).toContain("{{ slotInfoLabel }}");
    });

    it("renders separator messages", () => {
      expect(templateSection).toMatch(/msg\.type\s*===\s*'separator'/);
    });

    it("renders text messages", () => {
      expect(templateSection).toMatch(/msg\.type\s*===\s*'text'/);
    });

    it("renders tool messages with collapsible details", () => {
      expect(templateSection).toMatch(/msg\.type\s*===\s*'tool'/);
      expect(templateSection).toContain("msg.toolName");
    });

    it("renders tool_result messages with collapsible details", () => {
      expect(templateSection).toMatch(/msg\.type\s*===\s*'tool_result'/);
    });

    it("renders error messages with error styling", () => {
      expect(templateSection).toMatch(/msg\.type\s*===\s*'error'/);
      expect(templateSection).toContain("bexp-line--error");
    });

    it("renders system_prompt messages with collapsible details", () => {
      expect(templateSection).toMatch(/msg\.type\s*===\s*'system_prompt'/);
    });

    it("renders task_prompt messages with collapsible details", () => {
      expect(templateSection).toMatch(/msg\.type\s*===\s*'task_prompt'/);
    });

    it("binds ref to output container for auto-scroll", () => {
      expect(templateSection).toMatch(/ref\s*=\s*"outputEl"/);
    });
  });

  describe("styles", () => {
    it("includes scoped styles", () => {
      expect(componentSource).toContain("<style scoped>");
    });

    it("defines root .bexp-progress class", () => {
      expect(styleSection).toContain(".bexp-progress");
    });

    it("defines header class", () => {
      expect(styleSection).toContain(".bexp-progress__header");
    });

    it("defines status class", () => {
      expect(styleSection).toContain(".bexp-progress__status");
    });

    it("defines output area class", () => {
      expect(styleSection).toContain(".bexp-progress__output");
    });

    it("defines dot variant classes for all states", () => {
      expect(styleSection).toContain(".bexp-dot--active");
      expect(styleSection).toContain(".bexp-dot--stopping");
      expect(styleSection).toContain(".bexp-dot--completed-success");
      expect(styleSection).toContain(".bexp-dot--completed-failure");
      expect(styleSection).toContain(".bexp-dot--completed-cancelled");
    });

    it("defines card status classes", () => {
      expect(styleSection).toContain(".bexp-card--done");
      expect(styleSection).toContain(".bexp-card--active");
      expect(styleSection).toContain(".bexp-card--focused");
      expect(styleSection).toContain(".bexp-card--skipped");
      expect(styleSection).toContain(".bexp-card--error");
      expect(styleSection).toContain(".bexp-card--queued");
    });

    it("defines banner severity classes", () => {
      expect(styleSection).toContain(".bexp-banner--success");
      expect(styleSection).toContain(".bexp-banner--error");
      expect(styleSection).toContain(".bexp-banner--warning");
    });

    it("defines pulse animation", () => {
      expect(styleSection).toContain("bexp-pulse");
    });

    it("defines progress bar classes", () => {
      expect(styleSection).toContain(".bexp-progress-bar");
      expect(styleSection).toContain(".bexp-progress-bar__fill");
    });

    it("uses terminal theme CSS variables", () => {
      expect(styleSection).toContain("--chat-bg-terminal");
      expect(styleSection).toContain("--chat-bg-surface");
      expect(styleSection).toContain("--chat-text-primary");
    });

    it("uses semantic colour CSS variables for messages", () => {
      expect(styleSection).toContain("--chat-tool-color");
      expect(styleSection).toContain("--chat-result-color");
      expect(styleSection).toContain("--chat-error-color");
    });
  });
});
