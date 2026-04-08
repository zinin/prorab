/**
 * Structural tests for ExpandProgress.vue — verifies component structure,
 * data-testid attributes, conditional rendering, and wiring to logic helpers.
 *
 * Uses source-level assertions (same approach as parse-prd-progress-component.test.ts)
 * because @vue/test-utils is not a project dependency.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const componentPath = resolve(__dirname, "../../ui/src/components/ExpandProgress.vue");
const componentSource = readFileSync(componentPath, "utf-8");

// Extract sections — use greedy match for template (may contain inner <template> tags)
const scriptMatch = componentSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
const templateMatch = componentSource.match(/<template>([\s\S]*)<\/template>/s);
const styleMatch = componentSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);

const scriptSection = scriptMatch?.[1] ?? "";
const templateSection = templateMatch?.[1] ?? "";
const styleSection = styleMatch?.[1] ?? "";

describe("ExpandProgress component structure", () => {
  describe("imports", () => {
    it("imports ExpandMessage, ExpandStoreState, ExpandOutcome, ExpandSessionInfo types", () => {
      expect(scriptSection).toContain("ExpandMessage");
      expect(scriptSection).toContain("ExpandStoreState");
      expect(scriptSection).toContain("ExpandOutcome");
      expect(scriptSection).toContain("ExpandSessionInfo");
    });

    it("imports pure logic helpers from expand-progress-logic", () => {
      expect(scriptSection).toContain("expand-progress-logic");
      expect(scriptSection).toContain("statusText");
      expect(scriptSection).toContain("dotVariant");
      expect(scriptSection).toContain("outcomeLabel");
      expect(scriptSection).toContain("outcomeSeverity");
      expect(scriptSection).toContain("showStopButton");
      expect(scriptSection).toContain("isStopDisabled");
      expect(scriptSection).toContain("showOutcomeBanner");
      expect(scriptSection).toContain("outcomeErrors");
      expect(scriptSection).toContain("showDismissButton");
      expect(scriptSection).toContain("isCommitFailedAfterWrite");
      expect(scriptSection).toContain("outcomeDetailMessage");
      expect(scriptSection).toContain("reasonDisplayText");
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
      expect(scriptSection).not.toContain("useExpandStore");
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
    it("declares messages prop", () => {
      expect(scriptSection).toContain("messages:");
    });

    it("declares state prop", () => {
      expect(scriptSection).toContain("state:");
    });

    it("declares outcome prop", () => {
      expect(scriptSection).toContain("outcome:");
    });

    it("declares sessionInfo prop", () => {
      expect(scriptSection).toContain("sessionInfo:");
    });
  });

  describe("emits", () => {
    it("declares stop emit", () => {
      expect(scriptSection).toMatch(/stop:\s*\[/);
    });

    it("declares dismiss emit", () => {
      expect(scriptSection).toMatch(/dismiss:\s*\[/);
    });
  });

  describe("computed properties", () => {
    it("computes headerText from statusText helper", () => {
      expect(scriptSection).toMatch(/const\s+headerText\s*=\s*computed/);
      expect(scriptSection).toContain("statusText(props.state");
    });

    it("computes headerDotClass from dotVariant helper", () => {
      expect(scriptSection).toMatch(/const\s+headerDotClass\s*=\s*computed/);
      expect(scriptSection).toContain("dotVariant(props.state");
    });

    it("computes canShowStop from showStopButton helper", () => {
      expect(scriptSection).toMatch(/const\s+canShowStop\s*=\s*computed/);
      expect(scriptSection).toContain("showStopButton(props.state");
    });

    it("computes stopDisabled from isStopDisabled helper", () => {
      expect(scriptSection).toMatch(/const\s+stopDisabled\s*=\s*computed/);
      expect(scriptSection).toContain("isStopDisabled(props.state");
    });

    it("computes canShowBanner from showOutcomeBanner helper", () => {
      expect(scriptSection).toMatch(/const\s+canShowBanner\s*=\s*computed/);
      expect(scriptSection).toContain("showOutcomeBanner(props.state");
    });

    it("computes bannerSeverity from outcomeSeverity helper", () => {
      expect(scriptSection).toMatch(/const\s+bannerSeverity\s*=\s*computed/);
      expect(scriptSection).toContain("outcomeSeverity(props.outcome");
    });

    it("computes bannerLabel from outcomeLabel helper", () => {
      expect(scriptSection).toMatch(/const\s+bannerLabel\s*=\s*computed/);
      expect(scriptSection).toContain("outcomeLabel(props.outcome");
    });

    it("computes bannerErrors from outcomeErrors helper", () => {
      expect(scriptSection).toMatch(/const\s+bannerErrors\s*=\s*computed/);
      expect(scriptSection).toContain("outcomeErrors(props.outcome");
    });

    it("computes canShowDismiss from showDismissButton helper", () => {
      expect(scriptSection).toMatch(/const\s+canShowDismiss\s*=\s*computed/);
      expect(scriptSection).toContain("showDismissButton(props.state");
    });

    it("computes commitFailedWarning from isCommitFailedAfterWrite helper", () => {
      expect(scriptSection).toMatch(/const\s+commitFailedWarning\s*=\s*computed/);
      expect(scriptSection).toContain("isCommitFailedAfterWrite(props.outcome");
    });

    it("computes detailMessage from outcomeDetailMessage helper", () => {
      expect(scriptSection).toMatch(/const\s+detailMessage\s*=\s*computed/);
      expect(scriptSection).toContain("outcomeDetailMessage(props.outcome");
    });

    it("computes reasonText from reasonDisplayText helper", () => {
      expect(scriptSection).toMatch(/const\s+reasonText\s*=\s*computed/);
      expect(scriptSection).toContain("reasonDisplayText(props.outcome");
    });
  });

  describe("auto-scroll", () => {
    it("defines scrollToBottom function", () => {
      expect(scriptSection).toMatch(/function\s+scrollToBottom/);
    });

    it("computes scrollSignature from messages length and last content length", () => {
      expect(scriptSection).toMatch(/const\s+scrollSignature\s*=\s*computed/);
      expect(scriptSection).toContain("last.content.length");
    });

    it("watches scrollSignature for auto-scroll (not just messages.length)", () => {
      expect(scriptSection).toMatch(/watch\(\s*scrollSignature\s*,\s*scrollToBottom\s*\)/);
    });

    it("calls scrollToBottom on mount when buffer is already populated", () => {
      expect(scriptSection).toContain("onMounted");
      expect(scriptSection).toMatch(/props\.messages\.length\s*>\s*0/);
    });

    it("uses nextTick for scroll timing", () => {
      expect(scriptSection).toContain("nextTick");
    });

    it("declares outputEl ref for scroll container", () => {
      expect(scriptSection).toMatch(/const\s+outputEl\s*=\s*ref/);
    });
  });

  describe("handleStop function", () => {
    it("is defined", () => {
      expect(scriptSection).toMatch(/function\s+handleStop/);
    });

    it("emits stop", () => {
      expect(scriptSection).toMatch(/emit\(\s*["']stop["']\s*\)/);
    });
  });

  describe("handleDismiss function", () => {
    it("is defined", () => {
      expect(scriptSection).toMatch(/function\s+handleDismiss/);
    });

    it("emits dismiss", () => {
      expect(scriptSection).toMatch(/emit\(\s*["']dismiss["']\s*\)/);
    });
  });

  describe("template: data-testid attributes", () => {
    it("has expand-panel on root element", () => {
      expect(templateSection).toContain('data-testid="expand-panel"');
    });

    it("has expand-status-text on status label", () => {
      expect(templateSection).toContain('data-testid="expand-status-text"');
    });

    it("has expand-stop-button on stop button", () => {
      expect(templateSection).toContain('data-testid="expand-stop-button"');
    });

    it("has expand-outcome-banner on outcome banner", () => {
      expect(templateSection).toContain('data-testid="expand-outcome-banner"');
    });

    it("has expand-outcome-label on outcome label", () => {
      expect(templateSection).toContain('data-testid="expand-outcome-label"');
    });

    it("has expand-outcome-errors on error list", () => {
      expect(templateSection).toContain('data-testid="expand-outcome-errors"');
    });

    it("has expand-dismiss-button on dismiss button", () => {
      expect(templateSection).toContain('data-testid="expand-dismiss-button"');
    });

    it("has expand-outcome-reason on reason badge", () => {
      expect(templateSection).toContain('data-testid="expand-outcome-reason"');
    });
  });

  describe("template: header section", () => {
    it("renders headerText in status area", () => {
      expect(templateSection).toContain("{{ headerText }}");
    });

    it("binds dot class to headerDotClass", () => {
      expect(templateSection).toContain("headerDotClass");
    });

    it("conditionally shows stop button via canShowStop", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"canShowStop"/);
    });

    it("binds stop button disabled to stopDisabled", () => {
      expect(templateSection).toMatch(/:disabled\s*=\s*"stopDisabled"/);
    });

    it("binds stop button click to handleStop", () => {
      expect(templateSection).toMatch(/@click\s*=\s*"handleStop"/);
    });

    it("renders stop button with severity danger", () => {
      expect(templateSection).toContain('severity="danger"');
    });
  });

  describe("template: outcome banner section", () => {
    it("conditionally shows banner via canShowBanner", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"canShowBanner"/);
    });

    it("binds banner class to bannerSeverity", () => {
      expect(templateSection).toContain("bannerSeverity");
    });

    it("renders bannerLabel", () => {
      expect(templateSection).toContain("{{ bannerLabel }}");
    });

    it("conditionally renders error list when bannerErrors has items", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"bannerErrors\.length\s*>\s*0"/);
    });

    it("iterates over bannerErrors", () => {
      expect(templateSection).toMatch(/v-for\s*=\s*"\(err,\s*i\)\s+in\s+bannerErrors"/);
    });

    it("conditionally shows dismiss button via canShowDismiss", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"canShowDismiss"/);
    });

    it("binds dismiss button click to handleDismiss", () => {
      expect(templateSection).toMatch(/@click\s*=\s*"handleDismiss"/);
    });

    it("renders dismiss button with 'Try Again' label", () => {
      expect(templateSection).toContain('label="Try Again"');
    });

    it("renders dismiss button with secondary severity", () => {
      expect(templateSection).toContain('severity="secondary"');
    });

    it("shows commit_failed_after_write warning conditionally", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"commitFailedWarning"/);
      expect(templateSection).toContain("commit failed");
    });

    it("shows detail message conditionally", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"detailMessage"/);
      expect(templateSection).toContain("{{ detailMessage }}");
    });

    it("shows reason text conditionally in failure banner", () => {
      expect(templateSection).toMatch(/v-if\s*=\s*"reasonText"/);
      expect(templateSection).toContain("{{ reasonText }}");
    });
  });

  describe("template: message output section", () => {
    it("renders empty placeholder when no messages and not completed", () => {
      expect(templateSection).toContain("Waiting for agent output");
      expect(templateSection).toMatch(/messages\.length\s*===\s*0/);
    });

    it("iterates over messages", () => {
      expect(templateSection).toMatch(/v-for\s*=\s*"msg\s+in\s+messages"/);
    });

    it("renders text messages", () => {
      expect(templateSection).toMatch(/msg\.type\s*===\s*'text'/);
      expect(templateSection).toContain("msg.content");
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
      expect(templateSection).toContain("exp-line--error");
    });

    it("binds ref to output container for auto-scroll", () => {
      expect(templateSection).toMatch(/ref\s*=\s*"outputEl"/);
    });
  });

  describe("styles", () => {
    it("includes scoped styles", () => {
      expect(componentSource).toContain("<style scoped>");
    });

    it("defines root .exp-progress class", () => {
      expect(styleSection).toContain(".exp-progress");
    });

    it("defines header class", () => {
      expect(styleSection).toContain(".exp-progress__header");
    });

    it("defines status class", () => {
      expect(styleSection).toContain(".exp-progress__status");
    });

    it("defines output area class", () => {
      expect(styleSection).toContain(".exp-progress__output");
    });

    it("defines dot variant classes for all states", () => {
      expect(styleSection).toContain(".exp-dot--active");
      expect(styleSection).toContain(".exp-dot--stopping");
      expect(styleSection).toContain(".exp-dot--completed-success");
      expect(styleSection).toContain(".exp-dot--completed-failure");
      expect(styleSection).toContain(".exp-dot--completed-cancelled");
    });

    it("defines banner severity classes", () => {
      expect(styleSection).toContain(".exp-banner--success");
      expect(styleSection).toContain(".exp-banner--error");
      expect(styleSection).toContain(".exp-banner--warning");
    });

    it("defines pulse animation", () => {
      expect(styleSection).toContain("exp-pulse");
    });

    it("defines dismiss button styling", () => {
      expect(styleSection).toContain(".exp-banner__dismiss");
    });

    it("defines commit warning styling", () => {
      expect(styleSection).toContain(".exp-banner__commit-warning");
    });

    it("defines reason badge styling", () => {
      expect(styleSection).toContain(".exp-banner__reason");
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
