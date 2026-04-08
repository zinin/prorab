import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Source-level tests for TaskListView.vue — verifies the wizard integration,
 * error handling, and conditional rendering.
 *
 * Uses source-level assertions (same approach as agent-wizard-component.test.ts
 * and agent-chat-panel-input.test.ts) because @vue/test-utils is not a
 * project dependency.
 */

const viewPath = resolve(__dirname, "../../ui/src/views/TaskListView.vue");
const viewSource = readFileSync(viewPath, "utf-8");

const routerPath = resolve(__dirname, "../../ui/src/router.ts");
const routerSource = readFileSync(routerPath, "utf-8");

const appPath = resolve(__dirname, "../../ui/src/App.vue");
const appSource = readFileSync(appPath, "utf-8");

const parsePrdProgressLogicPath = resolve(__dirname, "../../ui/src/components/parse-prd-progress-logic.ts");
const parsePrdProgressLogicSource = readFileSync(parsePrdProgressLogicPath, "utf-8");

// Extract sections from TaskListView
const scriptMatch = viewSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
const templateMatch = viewSource.match(/<template>([\s\S]*)<\/template>/);

const scriptSection = scriptMatch?.[1] ?? "";
const templateSection = templateMatch?.[1] ?? "";

// ---------------------------------------------------------------------------
// hasTasksFile === false renders AgentWizard
// ---------------------------------------------------------------------------
describe("TaskListView wizard rendering", () => {
  it("imports AgentWizard component", () => {
    expect(scriptSection).toContain("AgentWizard");
    expect(scriptSection).toContain("../components/AgentWizard.vue");
  });

  it("imports IDEA_TO_PRD_PROMPT", () => {
    expect(scriptSection).toContain("IDEA_TO_PRD_PROMPT");
    expect(scriptSection).toContain("../constants/prompts");
  });

  it("uses tasksStore.hasTasksFile (no local ref)", () => {
    expect(scriptSection).not.toMatch(/const\s+hasTasksFile\s*=\s*ref/);
    expect(scriptSection).toContain("tasksStore.hasTasksFile");
  });

  it("renders AgentWizard when viewMode is wizard-*", () => {
    expect(templateSection).toContain("AgentWizard");
    // hasTasksFile check is in computeViewMode(), viewMode drives the template
    expect(scriptSection).toContain("computeViewMode");
    expect(templateSection).toMatch(/viewMode\s*===\s*'wizard-chat'\s*\|\|\s*viewMode\s*===\s*'wizard-parse-prd'/);
  });

  it("does NOT have a separate hasTaskmaster branch blocking wizard", () => {
    // The wizard should be reachable even when .taskmaster/ dir is absent.
    // No v-if="!hasTaskmaster" should precede the wizard conditional.
    expect(templateSection).not.toMatch(/v-if\s*=\s*"[^"]*!hasTaskmaster[^"]*"/);
  });

  it("shows intro text instead of Tasks heading on wizard screen", () => {
    // wizard-intro section has h2 and descriptive text
    expect(templateSection).toContain("wizard-intro");
    expect(templateSection).toContain("No tasks yet");
    expect(templateSection).toContain("PRD");
  });

  it("passes wizardStarting prop to AgentWizard", () => {
    expect(templateSection).toMatch(/:starting\s*=\s*"wizardStarting"/);
  });

  it("listens for @start emit from AgentWizard", () => {
    expect(templateSection).toMatch(/@start\s*=\s*"onWizardStart"/);
  });
});

// ---------------------------------------------------------------------------
// onWizardStart: dual-mode — calls chatStore.startFlow or parsePrdStore.start
// ---------------------------------------------------------------------------
describe("TaskListView onWizardStart", () => {
  it("defines onWizardStart as an async function", () => {
    expect(scriptSection).toMatch(/async\s+function\s+onWizardStart/);
  });

  it("accepts initialMessage as optional parameter", () => {
    // The config type should have initialMessage?: string (optional)
    expect(scriptSection).toMatch(/initialMessage\?\s*:\s*string/);
  });

  it("branches on wizardMode to decide chat vs parse-prd", () => {
    expect(scriptSection).toMatch(/wizardMode\.value\s*===\s*["']parse-prd["']/);
  });

  it("calls parsePrdStore.start in parse-prd mode", () => {
    expect(scriptSection).toContain("parsePrdStore.start(");
  });

  it("calls chatStore.startFlow in chat mode", () => {
    expect(scriptSection).toContain("chatStore.startFlow");
  });

  it("passes IDEA_TO_PRD_PROMPT as systemPrompt in chat mode", () => {
    expect(scriptSection).toContain("systemPrompt: IDEA_TO_PRD_PROMPT");
  });

  it("does not navigate away on success (chat is shown inline)", () => {
    // Chat panel is rendered inline via showInlineChat computed,
    // no router.push("/chat") needed
    expect(scriptSection).not.toContain('router.push("/chat")');
  });

  it("sets wizardStarting to true before starting", () => {
    expect(scriptSection).toContain("wizardStarting.value = true");
  });

  it("resets wizardStarting in finally block", () => {
    expect(scriptSection).toContain("wizardStarting.value = false");
  });
});

// ---------------------------------------------------------------------------
// Error handling: toast on failure
// ---------------------------------------------------------------------------
describe("TaskListView error handling", () => {
  it("imports useToast from primevue", () => {
    expect(scriptSection).toContain("useToast");
    expect(scriptSection).toContain("primevue/usetoast");
  });

  it("initializes toast", () => {
    expect(scriptSection).toMatch(/const\s+toast\s*=\s*useToast\(\)/);
  });

  it("calls toast.add on error", () => {
    expect(scriptSection).toContain("toast.add(");
  });

  it("shows error severity in toast", () => {
    expect(scriptSection).toContain('severity: "error"');
  });

  it("checks chatStore.state on partial success (session already active)", () => {
    // When chatStore.state is not idle in the catch block, the inline chat view takes over
    expect(scriptSection).toContain('chatStore.state !== "idle"');
  });

  it("checks parsePrdStore.state on partial success (parse-prd session active)", () => {
    // When parsePrdStore.state is active in the catch block, parse-prd running indicator takes over
    expect(scriptSection).toContain('parsePrdStore.state === "active"');
  });
});

// ---------------------------------------------------------------------------
// Parse-prd wizard mode integration
// ---------------------------------------------------------------------------
describe("TaskListView parse-prd wizard mode", () => {
  it("imports useParsePrdStore", () => {
    expect(scriptSection).toContain("useParsePrdStore");
    expect(scriptSection).toContain("../stores/parse-prd");
  });

  it("initializes parsePrdStore", () => {
    expect(scriptSection).toMatch(/const\s+parsePrdStore\s*=\s*useParsePrdStore\(\)/);
  });

  it("defines wizardMode computed derived from viewMode", () => {
    expect(scriptSection).toMatch(/const\s+wizardMode\s*=\s*computed/);
    // wizardMode is derived from viewMode, not directly from tasksStore.hasPrd
    expect(scriptSection).toContain("wizard-parse-prd");
  });

  it("wizardMode returns 'parse-prd' when viewMode is wizard-parse-prd", () => {
    expect(scriptSection).toMatch(/viewMode\.value\s*===\s*["']wizard-parse-prd["']\s*\?\s*["']parse-prd["']/);
  });

  it("wizardMode returns 'chat' as fallback", () => {
    expect(scriptSection).toMatch(/:\s*["']chat["']/);
  });

  it("uses single viewMode computed instead of scattered booleans", () => {
    // No showParsePrdPanel, showInlineChat, or showWizard computed properties
    expect(scriptSection).not.toMatch(/const\s+showParsePrdPanel\s*=\s*computed/);
    expect(scriptSection).not.toMatch(/const\s+showInlineChat\s*=\s*computed/);
    expect(scriptSection).not.toMatch(/const\s+showWizard\s*=\s*computed/);
    // Single viewMode computed that delegates to computeViewMode()
    expect(scriptSection).toMatch(/const\s+viewMode\s*=\s*computed/);
    expect(scriptSection).toContain("computeViewMode(");
  });

  it("passes parsePrdState to computeViewMode", () => {
    // parsePrdStore.state is passed as parsePrdState flag to the pure function
    expect(scriptSection).toContain("parsePrdState: parsePrdStore.state");
  });

  it("passes :mode to AgentWizard in template", () => {
    expect(templateSection).toMatch(/:mode\s*=\s*"wizardMode"/);
  });

  it("shows parse-prd intro text when wizardMode is parse-prd", () => {
    expect(templateSection).toMatch(/v-if\s*=\s*"wizardMode\s*===\s*'parse-prd'"/);
    expect(templateSection).toContain("PRD found");
  });

  it("shows chat intro text when wizardMode is not parse-prd", () => {
    expect(templateSection).toContain("Describe your idea below");
  });

  it("wizard uses viewMode guard (v-else-if)", () => {
    // The wizard template section should be guarded by viewMode === 'wizard-*'
    expect(templateSection).toMatch(/v-else-if\s*=\s*"viewMode\s*===\s*'wizard-chat'/);
  });
});

// ---------------------------------------------------------------------------
// Parse-PRD progress panel (shown when showParsePrdPanel is true)
// ---------------------------------------------------------------------------
describe("TaskListView parse-prd progress panel", () => {
  it("shows parse-prd panel via viewMode === 'parse-prd-progress'", () => {
    expect(templateSection).toMatch(/v-else-if\s*=\s*"viewMode\s*===\s*'parse-prd-progress'"/);
    expect(templateSection).toContain("<ParsePrdProgress");
  });

  it("passes handleParsePrdStop event handler to ParsePrdProgress", () => {
    expect(templateSection).toContain("handleParsePrdStop");
    expect(templateSection).toContain("@stop=\"handleParsePrdStop\"");
  });

  it("defines handleParsePrdStop function", () => {
    expect(scriptSection).toMatch(/async\s+function\s+handleParsePrdStop/);
    expect(scriptSection).toContain("parsePrdStore.stop()");
  });

  it("renders parsePrdStore.messages in the output area", () => {
    expect(templateSection).toContain("parsePrdStore.messages");
  });

  it("shows status text with stopping/generating distinction in parse-prd-progress-logic", () => {
    // These strings are in the parse-prd-progress-logic helper, not TaskListView
    expect(parsePrdProgressLogicSource).toContain("Stopping");
    expect(parsePrdProgressLogicSource).toContain("Generating tasks from PRD");
  });

  it("fullscreen class uses isFullscreen computed", () => {
    expect(templateSection).toMatch(/:class\s*=\s*"isFullscreen/);
    // isFullscreen covers both inline-chat and parse-prd-progress modes
    expect(scriptSection).toContain("isFullscreen");
    expect(scriptSection).toContain("inline-chat");
    expect(scriptSection).toContain("parse-prd-progress");
  });

  it("delegates auto-scroll to ParsePrdProgress component", () => {
    // Auto-scroll logic is encapsulated in the ParsePrdProgress component,
    // not implemented in TaskListView. TaskListView just passes props.
    expect(templateSection).toContain("<ParsePrdProgress");
    expect(templateSection).toContain(":messages=");
    expect(templateSection).toContain(":state=");
    expect(templateSection).toContain(":outcome=");
  });

  it("binds @dismiss to handleParsePrdDismiss", () => {
    expect(templateSection).toContain('@dismiss="handleParsePrdDismiss"');
  });
});

// ---------------------------------------------------------------------------
// Parse-PRD dismiss: recovery from failure/cancelled back to wizard
// ---------------------------------------------------------------------------
describe("TaskListView parse-prd dismiss (recovery to wizard)", () => {
  it("defines handleParsePrdDismiss function", () => {
    expect(scriptSection).toMatch(/function\s+handleParsePrdDismiss/);
  });

  it("calls parsePrdStore.clearParsePrd in handleParsePrdDismiss", () => {
    expect(scriptSection).toContain("parsePrdStore.clearParsePrd()");
  });
});

// ---------------------------------------------------------------------------
// Parse-PRD success transition: watcher confirms valid tasks.json
// ---------------------------------------------------------------------------
describe("TaskListView parse-prd success transition", () => {
  it("imports watch from vue", () => {
    expect(scriptSection).toContain("watch");
    expect(scriptSection).toMatch(/import\s*\{[^}]*watch[^}]*\}\s*from\s*["']vue["']/);
  });

  it("watches parsePrdStore.outcome for success", () => {
    expect(scriptSection).toContain("parsePrdStore.outcome");
    expect(scriptSection).toMatch(/outcome\?\.status\s*===\s*["']success["']/);
  });

  it("calls tasksStore.fetchStatus on success outcome", () => {
    expect(scriptSection).toContain("tasksStore.fetchStatus()");
  });

  it("calls tasksStore.fetchTasks after confirming hasValidTasks", () => {
    expect(scriptSection).toContain("tasksStore.fetchTasks()");
    expect(scriptSection).toContain("tasksStore.hasValidTasks");
  });

  it("calls parsePrdStore.clearParsePrd after confirmed valid tasks.json", () => {
    // The watcher calls clearParsePrd after fetchStatus + fetchTasks confirm validity
    expect(scriptSection).toContain("parsePrdStore.clearParsePrd()");
  });
});

// ---------------------------------------------------------------------------
// Router: beforeEnter guard with async server check
// ---------------------------------------------------------------------------
describe("router /chat beforeEnter guard", () => {
  it("defines /chat route", () => {
    expect(routerSource).toContain('path: "/chat"');
  });

  it("has an async beforeEnter guard", () => {
    expect(routerSource).toContain("beforeEnter: async");
  });

  it("checks local chatStore.state first", () => {
    expect(routerSource).toContain('chatStore.state !== "idle"');
  });

  it("falls back to server-side check via GET /api/chat", () => {
    expect(routerSource).toContain('fetch("/api/chat")');
  });

  it("allows navigation when server reports active session", () => {
    expect(routerSource).toContain('data.state !== "idle"');
  });

  it("redirects to / when no active session", () => {
    expect(routerSource).toContain('return "/"');
  });
});

// ---------------------------------------------------------------------------
// App.vue navbar
// ---------------------------------------------------------------------------
describe("App.vue navbar", () => {
  it("has a Tasks link", () => {
    expect(appSource).toContain('to="/"');
  });

  it("has an Execution link", () => {
    expect(appSource).toContain('to="/execution"');
  });

  it("does not have a Chat nav link (chat is inline on main page)", () => {
    expect(appSource).not.toContain('to="/chat"');
    expect(appSource).not.toContain("chat-indicator");
  });

  it("hides navbar when hasTasksFile is false or wsInitialized is false", () => {
    expect(appSource).toMatch(/v-if\s*=\s*"showNavbar"/);
    expect(appSource).toContain("tasksStore.hasTasksFile");
    expect(appSource).toContain("tasksStore.wsInitialized");
  });

  it("defines --app-content-height CSS variable", () => {
    expect(appSource).toContain("--app-content-height");
    expect(appSource).toContain("no-navbar");
  });
});

// ---------------------------------------------------------------------------
// replay:complete sentinel replaces setTimeout(0) for rehydration
// ---------------------------------------------------------------------------
describe("replay:complete handling in useWebSocket", () => {
  it("handles replay:complete event to clear rehydrating flag", () => {
    const wsPath = resolve(__dirname, "../../ui/src/composables/useWebSocket.ts");
    const wsSource = readFileSync(wsPath, "utf-8");
    expect(wsSource).toContain("replay:complete");
    expect(wsSource).toContain("setRehydrating(false)");
  });

  it("does NOT use setTimeout(0) for rehydration", () => {
    const wsPath = resolve(__dirname, "../../ui/src/composables/useWebSocket.ts");
    const wsSource = readFileSync(wsPath, "utf-8");
    // chatRehydrationId was the counter for the old setTimeout approach
    expect(wsSource).not.toContain("chatRehydrationId");
    // setTimeout(0) was used for rehydration — should no longer appear in that context
    // (setTimeout for reconnect timer is fine, but not for setRehydrating)
    expect(wsSource).not.toMatch(/setTimeout\s*\([^)]*setRehydrating/);
  });
});

// ---------------------------------------------------------------------------
// wsInitialized gate: prevent flash of wrong content before WS connected
// ---------------------------------------------------------------------------
describe("wsInitialized gate", () => {
  it("tasks store exports wsInitialized ref", () => {
    const storePath = resolve(__dirname, "../../ui/src/stores/tasks.ts");
    const storeSource = readFileSync(storePath, "utf-8");
    expect(storeSource).toContain("wsInitialized");
    // Should default to false
    expect(storeSource).toMatch(/wsInitialized.*ref\s*\(\s*false\s*\)/);
  });

  it("TaskListView gates content on viewMode === 'loading'", () => {
    // The first template condition checks viewMode (which encodes wsInitialized)
    expect(templateSection).toMatch(/v-if\s*=\s*"viewMode\s*===\s*'loading'"/);
    // wsInitialized is still passed to computeViewMode
    expect(scriptSection).toContain("tasksStore.wsInitialized");
  });

  it("useWebSocket sets wsInitialized on connected", () => {
    const wsPath = resolve(__dirname, "../../ui/src/composables/useWebSocket.ts");
    const wsSource = readFileSync(wsPath, "utf-8");
    // useWebSocket calls applyConnectedProjectState in the "connected" case,
    // which sets store.wsInitialized = true (line 42 of project-state-mapping.ts)
    expect(wsSource).toContain("applyConnectedProjectState");
    // Verify both imports and usage are present
    expect(wsSource).toMatch(/import.*applyConnectedProjectState/);
    expect(wsSource).toMatch(/applyConnectedProjectState\(tasksStore/);
  });
});

// ---------------------------------------------------------------------------
// Router: /execution beforeEnter guard
// ---------------------------------------------------------------------------
describe("router /execution beforeEnter guard", () => {
  it("redirects to / when no tasks file", () => {
    expect(routerSource).toContain('path: "/execution"');
    expect(routerSource).toContain("tasksStore.hasTasksFile");
  });
});

// ---------------------------------------------------------------------------
// Error state: invalid tasks.json — stable test IDs, no parse-prd CTA
// ---------------------------------------------------------------------------
describe("TaskListView error state (invalid tasks.json)", () => {
  it("renders error state via viewMode === 'error'", () => {
    expect(templateSection).toMatch(/v-else-if\s*=\s*"viewMode\s*===\s*'error'"/);
  });

  it("has data-testid='invalid-tasks-error' on the container", () => {
    expect(templateSection).toContain('data-testid="invalid-tasks-error"');
  });

  it("has data-testid='invalid-tasks-heading' on the heading", () => {
    expect(templateSection).toContain('data-testid="invalid-tasks-heading"');
  });

  it("heading text says 'Invalid tasks file'", () => {
    // The heading should clearly communicate the problem
    expect(templateSection).toContain("Invalid tasks file");
  });

  it("has data-testid='invalid-tasks-body' on the message body", () => {
    expect(templateSection).toContain('data-testid="invalid-tasks-body"');
  });

  it("mentions the file path in the error message", () => {
    expect(templateSection).toContain(".taskmaster/tasks/tasks.json");
  });

  it("tells user to fix or delete the file", () => {
    expect(templateSection).toMatch(/[Ff]ix.*delete/s);
  });

  it("does NOT contain any button or CTA in the error section", () => {
    // Extract only the error state section of the template
    const errorSectionMatch = templateSection.match(
      /data-testid="invalid-tasks-error"[\s\S]*?(?=<!--\s*\w|<template\s+v-else|<\/div>\s*<\/div>\s*<\/template>)/,
    );
    const errorSection = errorSectionMatch?.[0] ?? "";

    // Must have found the section
    expect(errorSection).toBeTruthy();
    expect(errorSection.length).toBeGreaterThan(20);

    // No Button component in the error section
    expect(errorSection).not.toContain("<Button");
    // No <button> HTML element either
    expect(errorSection).not.toContain("<button");
    // No AgentWizard in the error section
    expect(errorSection).not.toContain("<AgentWizard");
    // No @click handlers that could start parse-prd
    expect(errorSection).not.toContain("parsePrdStore.start");
    expect(errorSection).not.toContain("onWizardStart");
  });

  it("does NOT offer to generate or regenerate tasks in the error section", () => {
    // Extract only the error state section
    const errorSectionMatch = templateSection.match(
      /data-testid="invalid-tasks-error"[\s\S]*?(?=<!--\s*\w|<template\s+v-else|<\/div>\s*<\/div>\s*<\/template>)/,
    );
    const errorSection = errorSectionMatch?.[0] ?? "";

    // No "generate" / "regenerate" / "try again" / "retry" language
    const lower = errorSection.toLowerCase();
    expect(lower).not.toContain("generate");
    expect(lower).not.toContain("regenerate");
    expect(lower).not.toContain("try again");
    expect(lower).not.toContain("retry");
  });

  it("error state section has a comment explaining no CTA by design", () => {
    // A comment should document why there's no parse-prd button
    expect(templateSection).toMatch(/No parse-prd CTA/i);
  });
});

// ---------------------------------------------------------------------------
// Chat finish → fetchStatus to refresh hasPrd (wizard-chat → wizard-parse-prd)
// ---------------------------------------------------------------------------
describe("TaskListView chat finish refreshes project state", () => {
  it("watches chatStore.state for idle transition", () => {
    expect(scriptSection).toContain("chatStore.state");
    // Specifically watches for idle transition (not just any state)
    expect(scriptSection).toMatch(/chatStore\.state[\s\S]*?["']idle["']/);
  });

  it("calls fetchStatus when chat transitions to idle", () => {
    // The watch handler should call fetchStatus to refresh hasPrd
    // after the idea-to-PRD chat finishes
    expect(scriptSection).toContain("tasksStore.fetchStatus()");
  });

  it("has a watch that guards oldState !== idle to avoid false triggers", () => {
    // The watch should only fire on actual transitions to idle,
    // not on initial idle state
    expect(scriptSection).toMatch(/oldState\s*&&\s*oldState\s*!==\s*["']idle["']/);
  });
});
