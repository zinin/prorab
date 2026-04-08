import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Component-level (SFC) tests for AgentWizard.vue.
 *
 * Uses source-level assertions (same approach as chat-view-wrapper.test.ts
 * and agent-chat-panel-input.test.ts) because @vue/test-utils is not a
 * project dependency.
 *
 * Covers dual-mode (chat / parse-prd) wizard:
 *   - mode prop with 'chat' default
 *   - Conditional textarea rendering (shown in chat, hidden in parse-prd)
 *   - Mode-dependent title and CTA label
 *   - Emit payload: initialMessage present in chat, absent in parse-prd
 *   - data-testid attributes for stable browser smoke tests
 *   - Agent/model/variant selectors shared across both modes
 *   - Watcher wiring, fetch lifecycle, and error feedback
 */

const wizardPath = resolve(__dirname, "../../ui/src/components/AgentWizard.vue");
const wizardSource = readFileSync(wizardPath, "utf-8");

// Extract <script setup> and <template> sections
const scriptMatch = wizardSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
const templateMatch = wizardSource.match(/<template>([\s\S]*)<\/template>/);
const styleMatch = wizardSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);

const scriptSection = scriptMatch?.[1] ?? "";
const templateSection = templateMatch?.[1] ?? "";
const styleSection = styleMatch?.[1] ?? "";

// ---------------------------------------------------------------------------
// Mode prop and defaults
// ---------------------------------------------------------------------------
describe("AgentWizard mode prop", () => {
  it("defines mode prop with 'chat' | 'parse-prd' type", () => {
    expect(scriptSection).toMatch(/mode\?\s*:\s*["']chat["']\s*\|\s*["']parse-prd["']/);
  });

  it("defaults mode to 'chat'", () => {
    expect(scriptSection).toMatch(/mode:\s*["']chat["']/);
  });

  it("uses withDefaults for prop defaults", () => {
    expect(scriptSection).toContain("withDefaults");
  });
});

// ---------------------------------------------------------------------------
// Conditional textarea rendering
// ---------------------------------------------------------------------------
describe("AgentWizard conditional textarea (chat vs parse-prd)", () => {
  it("wraps message field in a v-if that hides it in parse-prd mode", () => {
    // The message field wrapper should only show in chat mode
    expect(templateSection).toMatch(/v-if\s*=\s*"mode\s*===\s*'chat'"/);
  });

  it("renders Textarea component inside the conditional block", () => {
    expect(templateSection).toContain("Textarea");
    expect(templateSection).toMatch(/v-model\s*=\s*"message"/);
  });

  it("still has the Message label inside the conditional block", () => {
    expect(templateSection).toContain("Message");
  });
});

// ---------------------------------------------------------------------------
// Mode-dependent title
// ---------------------------------------------------------------------------
describe("AgentWizard mode-dependent title", () => {
  it("has a wizardTitle computed property", () => {
    expect(scriptSection).toMatch(/const\s+wizardTitle\s*=\s*computed/);
  });

  it("returns 'Generate Tasks' for parse-prd mode", () => {
    expect(scriptSection).toContain("Generate Tasks");
  });

  it("returns 'New Chat' for chat mode", () => {
    expect(scriptSection).toContain("New Chat");
  });

  it("binds title text dynamically in template", () => {
    expect(templateSection).toContain("{{ wizardTitle }}");
  });
});

// ---------------------------------------------------------------------------
// Mode-dependent CTA button label
// ---------------------------------------------------------------------------
describe("AgentWizard mode-dependent CTA button", () => {
  it("has a submitLabel computed property", () => {
    expect(scriptSection).toMatch(/const\s+submitLabel\s*=\s*computed/);
  });

  it("returns 'Generate' for parse-prd mode (not starting)", () => {
    expect(scriptSection).toContain('"Generate"');
  });

  it("returns 'Generating...' for parse-prd mode (starting)", () => {
    expect(scriptSection).toContain('"Generating..."');
  });

  it("returns 'Start' for chat mode (not starting)", () => {
    expect(scriptSection).toContain('"Start"');
  });

  it("returns 'Starting...' for chat mode (starting)", () => {
    expect(scriptSection).toContain('"Starting..."');
  });

  it("binds submitLabel to the Button", () => {
    expect(templateSection).toMatch(/:label\s*=\s*"submitLabel"/);
  });
});

// ---------------------------------------------------------------------------
// data-testid attributes
// ---------------------------------------------------------------------------
describe("AgentWizard data-testid attributes", () => {
  it("has data-testid on root element", () => {
    expect(templateSection).toContain('data-testid="agent-wizard"');
  });

  it("has data-testid on wizard title", () => {
    expect(templateSection).toContain('data-testid="wizard-title"');
  });

  it("has data-testid on agent select", () => {
    expect(templateSection).toContain('data-testid="wizard-agent-select"');
  });

  it("has data-testid on model select", () => {
    expect(templateSection).toContain('data-testid="wizard-model-select"');
  });

  it("has data-testid on variant select", () => {
    expect(templateSection).toContain('data-testid="wizard-variant-select"');
  });

  it("has data-testid on message field wrapper", () => {
    expect(templateSection).toContain('data-testid="wizard-message-field"');
  });

  it("has data-testid on message textarea", () => {
    expect(templateSection).toContain('data-testid="wizard-message-textarea"');
  });

  it("has data-testid on submit button", () => {
    expect(templateSection).toContain('data-testid="wizard-submit-button"');
  });
});

// ---------------------------------------------------------------------------
// Emit payload: initialMessage is optional and mode-dependent
// ---------------------------------------------------------------------------
describe("AgentWizard emit payload (mode-dependent)", () => {
  it("declares initialMessage as optional in emit type", () => {
    expect(scriptSection).toContain("initialMessage?: string");
  });

  it("emit type includes agent field", () => {
    expect(scriptSection).toContain("agent: string");
  });

  it("emit type includes optional model field", () => {
    expect(scriptSection).toContain("model?: string");
  });

  it("emit type includes optional variant field", () => {
    expect(scriptSection).toContain("variant?: string");
  });

  describe("onSubmit function", () => {
    it("is defined", () => {
      expect(scriptSection).toMatch(/function\s+onSubmit/);
    });

    it("guards on canSubmit", () => {
      expect(scriptSection).toMatch(/if\s*\(\s*!canSubmit\.value\s*\)/);
    });

    it("emits 'start' event", () => {
      expect(scriptSection).toMatch(/emit\(\s*["']start["']/);
    });

    it("builds payload with agent value", () => {
      expect(scriptSection).toContain("agent: agent.value");
    });

    it("sends model as undefined when empty", () => {
      expect(scriptSection).toContain("model: model.value || undefined");
    });

    it("sends variant as undefined when empty", () => {
      expect(scriptSection).toContain("variant: variant.value || undefined");
    });

    it("only includes initialMessage when mode is NOT parse-prd", () => {
      // Check that initialMessage assignment is guarded by mode check
      // parse-prd branch handles responseLanguage; else branch handles initialMessage
      expect(scriptSection).toMatch(/if\s*\(\s*props\.mode\s*===\s*["']parse-prd["']\s*\)/);
      expect(scriptSection).toContain("payload.initialMessage = message.value.trim()");
    });
  });

  it("does NOT include systemPrompt in emit type", () => {
    expect(scriptSection).not.toContain("systemPrompt");
  });
});

// ---------------------------------------------------------------------------
// canSubmit: mode-aware validation
// ---------------------------------------------------------------------------
describe("AgentWizard canSubmit (mode-aware)", () => {
  it("is defined as a computed property", () => {
    expect(scriptSection).toMatch(/const\s+canSubmit\s*=\s*computed/);
  });

  it("checks modelsLoading is false", () => {
    expect(scriptSection).toContain("modelsLoading.value");
  });

  it("checks starting prop", () => {
    expect(scriptSection).toContain("props.starting");
  });

  it("returns true without message check in parse-prd mode", () => {
    // In parse-prd mode, canSubmit should not require a message
    expect(scriptSection).toMatch(/props\.mode\s*===\s*["']parse-prd["']/);
  });

  it("requires non-empty message in chat mode", () => {
    expect(scriptSection).toMatch(/message\.value\.trim\(\)\.length\s*>\s*0/);
  });
});

// ---------------------------------------------------------------------------
// Shared agent Select (same across modes)
// ---------------------------------------------------------------------------
describe("AgentWizard agent Select (shared)", () => {
  it("renders a Select bound to agent", () => {
    expect(templateSection).toMatch(/v-model\s*=\s*"agent"/);
  });

  it("has agentOptions with exactly 4 entries", () => {
    const agentOptsMatch = scriptSection.match(
      /const\s+agentOptions\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(agentOptsMatch).not.toBeNull();
    const entries = agentOptsMatch![1].match(/\{\s*label:/g);
    expect(entries).toHaveLength(4);
  });

  it("includes claude option", () => {
    expect(scriptSection).toMatch(/value:\s*["']claude["']/);
  });

  it("includes opencode option", () => {
    expect(scriptSection).toMatch(/value:\s*["']opencode["']/);
  });
});

// ---------------------------------------------------------------------------
// Model Select (shared)
// ---------------------------------------------------------------------------
describe("AgentWizard model Select (shared)", () => {
  it("renders a Select bound to model", () => {
    expect(templateSection).toMatch(/v-model\s*=\s*"model"/);
  });

  it("uses models array as options", () => {
    expect(templateSection).toMatch(/:options\s*=\s*"models"/);
  });

  it("shows loading state via modelsLoading", () => {
    expect(templateSection).toMatch(/:loading\s*=\s*"modelsLoading"/);
  });

  it("has filter enabled for model search", () => {
    expect(templateSection).toContain("filter");
    expect(templateSection).toContain("filterPlaceholder");
  });

  it("supports virtual scrolling for large lists", () => {
    expect(templateSection).toContain("virtualScrollerOptions");
  });
});

// ---------------------------------------------------------------------------
// Variant Select (shared)
// ---------------------------------------------------------------------------
describe("AgentWizard variant Select (shared)", () => {
  it("conditionally renders variant Select when options exist", () => {
    expect(templateSection).toMatch(/v-if\s*=\s*"variantOptions\.length\s*>\s*0"/);
  });

  it("binds to variant", () => {
    expect(templateSection).toMatch(/v-model\s*=\s*"variant"/);
  });

  it("shows 'Effort' label for claude agent", () => {
    expect(templateSection).toContain("Effort");
  });

  it("shows 'Variant' label for non-claude agent", () => {
    expect(templateSection).toContain("Variant");
  });
});

// ---------------------------------------------------------------------------
// Chat-mode message Textarea (backward compat)
// ---------------------------------------------------------------------------
describe("AgentWizard message Textarea (chat mode)", () => {
  it("renders a Textarea bound to message", () => {
    expect(templateSection).toMatch(/v-model\s*=\s*"message"/);
  });

  it("has a placeholder", () => {
    expect(templateSection).toContain("Describe your idea");
  });
});

// ---------------------------------------------------------------------------
// Keyboard shortcut (chat mode only — textarea present)
// ---------------------------------------------------------------------------
describe("AgentWizard keyboard shortcut", () => {
  it("supports Ctrl+Enter to submit", () => {
    expect(templateSection).toContain("@keydown.ctrl.enter");
  });

  it("supports Cmd+Enter to submit", () => {
    expect(templateSection).toContain("@keydown.meta.enter");
  });
});

// ---------------------------------------------------------------------------
// Watchers — shared wiring
// ---------------------------------------------------------------------------
describe("AgentWizard watchers", () => {
  describe("watch(agent) → fetchModels", () => {
    it("defines a watcher on agent", () => {
      expect(scriptSection).toMatch(/watch\(\s*agent\s*,/);
    });

    it("resets model on agent change", () => {
      expect(scriptSection).toContain('model.value = ""');
    });

    it("resets variant on agent change", () => {
      expect(scriptSection).toContain('variant.value = ""');
    });

    it("calls fetchModels with new agent value", () => {
      expect(scriptSection).toMatch(/fetchModels\(\s*newAgent\s*\)/);
    });
  });

  describe("watch(model) → reset variant", () => {
    it("defines a watcher on model", () => {
      expect(scriptSection).toMatch(/watch\(\s*model\s*,/);
    });

    it("resets variant when model changes", () => {
      const modelWatchMatch = scriptSection.match(
        /watch\(\s*model\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\}\s*\)/,
      );
      expect(modelWatchMatch).not.toBeNull();
      expect(modelWatchMatch![1]).toContain('variant.value = ""');
    });
  });

  describe("fetchModels function", () => {
    it("is defined", () => {
      expect(scriptSection).toMatch(/async\s+function\s+fetchModels/);
    });

    it("sets modelsLoading to true at start", () => {
      expect(scriptSection).toContain("modelsLoading.value = true");
    });

    it("resets models at start", () => {
      expect(scriptSection).toContain("models.value = []");
    });

    it("calls createModelsFetcher result", () => {
      expect(scriptSection).toContain("fetchModelsImpl(agentValue)");
    });

    it("checks superseded before updating state", () => {
      expect(scriptSection).toContain("!result.superseded");
    });

    it("sets modelsLoading to false for non-superseded results", () => {
      expect(scriptSection).toContain("modelsLoading.value = false");
    });
  });

  describe("onMounted — initial fetch", () => {
    it("imports onMounted from vue", () => {
      expect(scriptSection).toContain("onMounted");
    });

    it("calls fetchModels on mount", () => {
      expect(scriptSection).toMatch(/onMounted\(\s*\(\)\s*=>\s*\{[\s\S]*?fetchModels\(\s*agent\.value\s*\)/);
    });
  });

  describe("auto-select variant", () => {
    it("watches variantOptions", () => {
      expect(scriptSection).toMatch(/watch\(\s*variantOptions\s*,/);
    });

    it("auto-selects last variant when options become available", () => {
      expect(scriptSection).toContain("opts[opts.length - 1]");
    });
  });
});

// ---------------------------------------------------------------------------
// Cleanup: onUnmounted abort
// ---------------------------------------------------------------------------
describe("AgentWizard cleanup", () => {
  it("imports onUnmounted from vue", () => {
    expect(scriptSection).toContain("onUnmounted");
  });

  it("calls abort on unmount to cancel in-flight fetch", () => {
    expect(scriptSection).toMatch(/onUnmounted\(\s*\(\)\s*=>\s*\{[\s\S]*?\.abort\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Error feedback: fetchError state
// ---------------------------------------------------------------------------
describe("AgentWizard fetch error feedback", () => {
  it("declares fetchError ref", () => {
    expect(scriptSection).toMatch(/const\s+fetchError\s*=\s*ref/);
  });

  it("resets fetchError at the start of fetchModels", () => {
    expect(scriptSection).toContain("fetchError.value = false");
  });

  it("sets fetchError from result.error for non-superseded results", () => {
    expect(scriptSection).toContain("fetchError.value = !!result.error");
  });

  it("shows error message in template when fetchError is true", () => {
    expect(templateSection).toMatch(/v-if\s*=\s*"fetchError"/);
    expect(templateSection).toContain("Failed to load models");
  });

  it("provides a retry link for fetch errors", () => {
    expect(templateSection).toContain("Retry");
    expect(templateSection).toMatch(/@click\.prevent\s*=\s*"retryModels"/);
  });

  it("defines retryModels function", () => {
    expect(scriptSection).toMatch(/function\s+retryModels/);
  });

  it("has error CSS class", () => {
    expect(styleSection).toContain(".wizard-error");
  });

  it("has retry CSS class", () => {
    expect(styleSection).toContain(".wizard-retry");
  });
});

// ---------------------------------------------------------------------------
// Store independence (same as before)
// ---------------------------------------------------------------------------
describe("AgentWizard store independence", () => {
  it("does not import any pinia store", () => {
    expect(scriptSection).not.toContain("useStore");
    expect(scriptSection).not.toContain("useChatStore");
    expect(scriptSection).not.toContain("useExecutionStore");
    expect(scriptSection).not.toContain("defineStore");
    expect(scriptSection).not.toContain("pinia");
  });

  it("does not hardcode system prompt", () => {
    expect(scriptSection).not.toContain("systemPrompt");
  });
});

// ---------------------------------------------------------------------------
// CSS layout (preserved)
// ---------------------------------------------------------------------------
describe("AgentWizard CSS layout", () => {
  it("has centered card layout", () => {
    expect(styleSection).toContain("display: flex");
    expect(styleSection).toContain("align-items: center");
    expect(styleSection).toContain("justify-content: center");
  });

  it("has min-height based on viewport", () => {
    expect(styleSection).toContain("min-height: var(--app-content-height, 100vh)");
  });

  it("has max-width for card", () => {
    expect(styleSection).toContain("max-width: 760px");
  });

  it("has box-shadow on card", () => {
    expect(styleSection).toContain("box-shadow");
  });
});

// ---------------------------------------------------------------------------
// Starting prop (shared)
// ---------------------------------------------------------------------------
describe("AgentWizard starting prop", () => {
  it("defines starting prop via defineProps", () => {
    expect(scriptSection).toContain("starting");
    expect(scriptSection).toContain("defineProps");
  });

  it("shows loading state on button when starting", () => {
    expect(templateSection).toContain(":loading=");
  });
});
