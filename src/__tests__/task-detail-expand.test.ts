import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Source-level tests for TaskDetailView.vue — verifies the expand dialog
 * integration, gating logic, persisted defaults, and ExpandProgress wiring.
 *
 * Uses source-level assertions (same approach as agent-wizard-component.test.ts
 * and task-list-view-wizard.test.ts) because @vue/test-utils is not a
 * project dependency.
 */

const viewPath = resolve(__dirname, "../../ui/src/views/TaskDetailView.vue");
const viewSource = readFileSync(viewPath, "utf-8");

const helpersPath = resolve(__dirname, "../../ui/src/composables/expand-launch-helpers.ts");
const helpersSource = readFileSync(helpersPath, "utf-8");

// Extract <script setup> and <template> sections
const scriptMatch = viewSource.match(/<script[^>]*>([\s\S]*?)<\/script>/);
const templateMatch = viewSource.match(/<template>([\s\S]*)<\/template>/);
const styleMatch = viewSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);

const scriptSection = scriptMatch?.[1] ?? "";
const templateSection = templateMatch?.[1] ?? "";
const styleSection = styleMatch?.[1] ?? "";

// ---------------------------------------------------------------------------
// Store imports
// ---------------------------------------------------------------------------
describe("TaskDetailView expand store imports", () => {
  it("imports useExpandStore", () => {
    expect(scriptSection).toContain("useExpandStore");
    expect(scriptSection).toContain("../stores/expand");
  });

  it("imports useExecutionStore for session conflict detection", () => {
    expect(scriptSection).toContain("useExecutionStore");
    expect(scriptSection).toContain("../stores/execution");
  });

  it("imports useChatStore for session conflict detection", () => {
    expect(scriptSection).toContain("useChatStore");
    expect(scriptSection).toContain("../stores/chat");
  });

  it("imports useParsePrdStore for session conflict detection", () => {
    expect(scriptSection).toContain("useParsePrdStore");
    expect(scriptSection).toContain("../stores/parse-prd");
  });

  it("initializes all stores", () => {
    expect(scriptSection).toMatch(/const\s+expandStore\s*=\s*useExpandStore\(\)/);
    expect(scriptSection).toMatch(/const\s+executionStore\s*=\s*useExecutionStore\(\)/);
    expect(scriptSection).toMatch(/const\s+chatStore\s*=\s*useChatStore\(\)/);
    expect(scriptSection).toMatch(/const\s+parsePrdStore\s*=\s*useParsePrdStore\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Expand button visibility and gating
// ---------------------------------------------------------------------------
describe("TaskDetailView expand button", () => {
  it("renders Expand button with v-if=showExpandButton", () => {
    expect(templateSection).toContain('v-if="showExpandButton"');
    expect(templateSection).toContain('label="Expand"');
  });

  it("has data-testid on expand button", () => {
    expect(templateSection).toContain('data-testid="expand-launch-button"');
  });

  it("binds disabled state to expandDisabled computed", () => {
    expect(templateSection).toMatch(/:disabled\s*=\s*"expandDisabled"/);
  });

  it("binds title/tooltip to expandTooltip", () => {
    expect(templateSection).toMatch(/:title\s*=\s*"expandTooltip/);
  });

  it("calls openExpandDialog on click", () => {
    expect(templateSection).toMatch(/@click\s*=\s*"openExpandDialog"/);
  });

  it("uses an icon for the button", () => {
    expect(templateSection).toContain('icon="pi pi-sitemap"');
  });
});

// ---------------------------------------------------------------------------
// showExpandButton computed
// ---------------------------------------------------------------------------
describe("TaskDetailView showExpandButton computed", () => {
  it("is defined as a computed property", () => {
    expect(scriptSection).toMatch(/const\s+showExpandButton\s*=\s*computed/);
  });

  it("delegates to canShowExpandButton helper", () => {
    expect(scriptSection).toContain("canShowExpandButton(");
  });

  it("passes task.value.status to helper", () => {
    expect(scriptSection).toContain("task.value.status");
  });

  it("passes subtask count to helper", () => {
    expect(scriptSection).toContain("task.value.subtasks?.length ?? 0");
  });

  it("returns false when task is null", () => {
    expect(scriptSection).toContain("if (!task.value) return false");
  });
});

// ---------------------------------------------------------------------------
// Expand disabled state (session conflicts + dirty + saving)
// ---------------------------------------------------------------------------
describe("TaskDetailView expand disabled state", () => {
  it("defines expandDisabled computed", () => {
    expect(scriptSection).toMatch(/const\s+expandDisabled\s*=\s*computed/);
  });

  it("delegates to isExpandDisabled helper", () => {
    expect(scriptSection).toContain("isExpandDisabled(");
  });

  it("defines sessionConflict computed", () => {
    expect(scriptSection).toMatch(/const\s+sessionConflict\s*=\s*computed/);
  });

  it("delegates to hasConflictingSession helper", () => {
    expect(scriptSection).toContain("hasConflictingSession(");
  });

  it("checks executionStore.state for session conflicts", () => {
    expect(scriptSection).toContain("executionStore.state");
  });

  it("checks chatStore.hasSession for session conflicts", () => {
    expect(scriptSection).toContain("chatStore.hasSession");
  });

  it("checks parsePrdStore.hasSession for session conflicts", () => {
    expect(scriptSection).toContain("parsePrdStore.hasSession");
  });

  it("checks expandStore.isRunning for session conflicts (not hasSession — completed sessions are not conflicts)", () => {
    expect(scriptSection).toContain("expandIsRunning: expandStore.isRunning");
  });

  it("uses expandStore.belongsToTask for same-task detection", () => {
    expect(scriptSection).toContain("expandStore.belongsToTask(");
  });

  it("passes isDirty to isExpandDisabled", () => {
    expect(scriptSection).toContain("isDirty: isDirty.value");
  });

  it("passes saving state to isExpandDisabled", () => {
    expect(scriptSection).toContain("isSaving: saving.value");
  });
});

// ---------------------------------------------------------------------------
// Expand tooltip
// ---------------------------------------------------------------------------
describe("TaskDetailView expand tooltip", () => {
  it("defines expandTooltip computed", () => {
    expect(scriptSection).toMatch(/const\s+expandTooltip\s*=\s*computed/);
  });

  it("delegates to expandDisabledTooltip helper", () => {
    expect(scriptSection).toContain("expandDisabledTooltip(");
  });
});

// ---------------------------------------------------------------------------
// Expand dialog
// ---------------------------------------------------------------------------
describe("TaskDetailView expand dialog", () => {
  it("imports Dialog from primevue", () => {
    expect(scriptSection).toContain("import Dialog from");
    expect(scriptSection).toContain("primevue/dialog");
  });

  it("renders Dialog component", () => {
    expect(templateSection).toContain("<Dialog");
  });

  it("binds dialog visibility to expandDialogVisible", () => {
    expect(templateSection).toMatch(/v-model:visible\s*=\s*"expandDialogVisible"/);
  });

  it("has modal=true", () => {
    expect(templateSection).toMatch(/:modal\s*=\s*"true"/);
  });

  it("has data-testid on dialog", () => {
    expect(templateSection).toContain('data-testid="expand-dialog"');
  });

  it("has data-testid on dialog form", () => {
    expect(templateSection).toContain('data-testid="expand-dialog-form"');
  });

  it("has header 'Expand Task'", () => {
    expect(templateSection).toContain('header="Expand Task"');
  });

  it("defines expandDialogVisible ref", () => {
    expect(scriptSection).toMatch(/const\s+expandDialogVisible\s*=\s*ref/);
  });
});

// ---------------------------------------------------------------------------
// Dialog form fields
// ---------------------------------------------------------------------------
describe("TaskDetailView expand dialog form fields", () => {
  it("has agent select", () => {
    expect(templateSection).toContain('data-testid="expand-agent-select"');
    expect(templateSection).toMatch(/v-model\s*=\s*"expandAgent"/);
  });

  it("has model select", () => {
    expect(templateSection).toContain('data-testid="expand-model-select"');
    expect(templateSection).toMatch(/v-model\s*=\s*"expandModel"/);
  });

  it("has variant select (conditional)", () => {
    expect(templateSection).toContain('data-testid="expand-variant-select"');
    expect(templateSection).toMatch(/v-model\s*=\s*"expandVariant"/);
  });

  it("has submit button", () => {
    expect(templateSection).toContain('data-testid="expand-submit-button"');
  });

  it("submit button calls onExpandSubmit", () => {
    expect(templateSection).toMatch(/@click\s*=\s*"onExpandSubmit"/);
  });

  it("submit button disabled state bound to expandCanSubmit", () => {
    expect(templateSection).toMatch(/:disabled\s*=\s*"!expandCanSubmit"/);
  });

  it("submit button shows loading state", () => {
    expect(templateSection).toMatch(/:loading\s*=\s*"expandStarting"/);
  });

  it("defines expandCanSubmit computed", () => {
    expect(scriptSection).toMatch(/const\s+expandCanSubmit\s*=\s*computed/);
  });

  it("expandCanSubmit checks modelsLoading and starting", () => {
    expect(scriptSection).toContain("expandModelsLoading.value");
    expect(scriptSection).toContain("expandStarting.value");
  });
});

// ---------------------------------------------------------------------------
// Dialog form — model fetching
// ---------------------------------------------------------------------------
describe("TaskDetailView expand dialog model fetching", () => {
  it("imports createModelsFetcher from agent-wizard-logic", () => {
    expect(scriptSection).toContain("createModelsFetcher");
    expect(scriptSection).toContain("../components/agent-wizard-logic");
  });

  it("imports computeVariantOptions from agent-wizard-logic", () => {
    expect(scriptSection).toContain("computeVariantOptions");
  });

  it("creates a models fetcher instance", () => {
    expect(scriptSection).toContain("createModelsFetcher(fetch.bind(globalThis))");
  });

  it("defines fetchExpandModels function", () => {
    expect(scriptSection).toMatch(/async\s+function\s+fetchExpandModels/);
  });

  it("watches expandAgent for changes", () => {
    expect(scriptSection).toMatch(/watch\(\s*expandAgent\s*,/);
  });

  it("resets model and variant on agent change", () => {
    // Ensure the watcher resets both fields
    expect(scriptSection).toContain('expandModel.value = ""');
    expect(scriptSection).toContain('expandVariant.value = ""');
  });

  it("watches expandModel to reset variant", () => {
    expect(scriptSection).toMatch(/watch\(\s*expandModel\s*,/);
  });

  it("auto-selects default variant when options appear", () => {
    expect(scriptSection).toMatch(/watch\(\s*expandVariantOptions\s*,/);
  });

  it("cleans up fetcher on unmount", () => {
    expect(scriptSection).toContain("fetchExpandModelsImpl.abort()");
    expect(scriptSection).toContain("onUnmounted");
  });

  it("has retry functionality for failed model fetch", () => {
    expect(scriptSection).toMatch(/function\s+retryExpandModels/);
    expect(templateSection).toContain("retryExpandModels");
  });

  it("shows error message for failed model fetch", () => {
    expect(templateSection).toMatch(/v-if\s*=\s*"expandFetchError"/);
    expect(templateSection).toContain("Failed to load models");
  });
});

// ---------------------------------------------------------------------------
// Persisted defaults
// ---------------------------------------------------------------------------
describe("TaskDetailView expand persisted defaults", () => {
  it("imports useSessionDefaults", () => {
    expect(scriptSection).toContain("useSessionDefaults");
    expect(scriptSection).toContain("../composables/useSessionDefaults");
  });

  it("creates sessionDefaults instance", () => {
    expect(scriptSection).toMatch(/const\s+sessionDefaults\s*=\s*useSessionDefaults\(\)/);
  });

  it("initializes from persisted defaults in openExpandDialog", () => {
    expect(scriptSection).toMatch(/function\s+openExpandDialog/);
    expect(scriptSection).toContain("sessionDefaults.value.agent");
    expect(scriptSection).toContain("sessionDefaults.value.model");
    expect(scriptSection).toContain("sessionDefaults.value.variant");
  });

  it("saves defaults after successful expand start", () => {
    // In onExpandSubmit, after successful start, update sessionDefaults
    expect(scriptSection).toContain("sessionDefaults.value = {");
  });
});

// ---------------------------------------------------------------------------
// onExpandSubmit function
// ---------------------------------------------------------------------------
describe("TaskDetailView onExpandSubmit", () => {
  it("is defined as async function", () => {
    expect(scriptSection).toMatch(/async\s+function\s+onExpandSubmit/);
  });

  it("guards on expandCanSubmit", () => {
    expect(scriptSection).toContain("!expandCanSubmit.value");
  });

  it("calls expandStore.start with task id and options", () => {
    expect(scriptSection).toContain("expandStore.start(");
  });

  it("passes agent, model, variant to start", () => {
    expect(scriptSection).toContain("agent: expandAgent.value");
    expect(scriptSection).toContain("model: expandModel.value || undefined");
    expect(scriptSection).toContain("variant: expandVariant.value || undefined");
  });

  it("closes dialog on successful start", () => {
    expect(scriptSection).toContain("expandDialogVisible.value = false");
  });

  it("shows toast on error", () => {
    expect(scriptSection).toContain("toast.add(");
    expect(scriptSection).toContain('"Expand failed"');
  });

  it("uses startReasonDisplayText for error messages", () => {
    expect(scriptSection).toContain("startReasonDisplayText(");
  });

  it("reads reason from expandStore.reason", () => {
    expect(scriptSection).toContain("expandStore.reason");
  });

  it("sets expandStarting in finally block", () => {
    expect(scriptSection).toContain("expandStarting.value = false");
  });
});

// ---------------------------------------------------------------------------
// ExpandProgress integration
// ---------------------------------------------------------------------------
describe("TaskDetailView ExpandProgress integration", () => {
  it("imports ExpandProgress component", () => {
    expect(scriptSection).toContain("ExpandProgress");
    expect(scriptSection).toContain("../components/ExpandProgress.vue");
  });

  it("renders ExpandProgress in template", () => {
    expect(templateSection).toContain("<ExpandProgress");
  });

  it("conditionally shows ExpandProgress via showExpandProgress", () => {
    expect(templateSection).toMatch(/v-if\s*=\s*"showExpandProgress"/);
  });

  it("has data-testid on expand progress section", () => {
    expect(templateSection).toContain('data-testid="expand-progress-section"');
  });

  it("defines showExpandProgress computed", () => {
    expect(scriptSection).toMatch(/const\s+showExpandProgress\s*=\s*computed/);
  });

  it("showExpandProgress checks expandStore.hasSession and belongsToTask", () => {
    expect(scriptSection).toContain("expandStore.hasSession");
    expect(scriptSection).toContain("expandStore.belongsToTask(");
  });

  it("passes messages prop to ExpandProgress", () => {
    expect(templateSection).toMatch(/:messages\s*=\s*"expandStore\.messages"/);
  });

  it("passes state prop to ExpandProgress", () => {
    expect(templateSection).toMatch(/:state\s*=\s*"expandStore\.state"/);
  });

  it("passes outcome prop to ExpandProgress", () => {
    expect(templateSection).toMatch(/:outcome\s*=\s*"expandStore\.outcome"/);
  });

  it("passes sessionInfo prop to ExpandProgress", () => {
    expect(templateSection).toMatch(/:sessionInfo\s*=\s*"expandStore\.sessionInfo"/);
  });

  it("handles @stop event from ExpandProgress", () => {
    expect(templateSection).toMatch(/@stop\s*=\s*"handleExpandStop"/);
  });

  it("handles @dismiss event from ExpandProgress", () => {
    expect(templateSection).toMatch(/@dismiss\s*=\s*"handleExpandDismiss"/);
  });
});

// ---------------------------------------------------------------------------
// handleExpandStop and handleExpandDismiss
// ---------------------------------------------------------------------------
describe("TaskDetailView expand stop and dismiss handlers", () => {
  it("defines handleExpandStop function", () => {
    expect(scriptSection).toMatch(/function\s+handleExpandStop/);
  });

  it("handleExpandStop calls expandStore.stop", () => {
    expect(scriptSection).toContain("expandStore.stop(");
  });

  it("handleExpandStop shows toast on error", () => {
    expect(scriptSection).toContain('"Stop failed"');
  });

  it("defines handleExpandDismiss function", () => {
    expect(scriptSection).toMatch(/function\s+handleExpandDismiss/);
  });

  it("handleExpandDismiss calls expandStore.clearExpand", () => {
    expect(scriptSection).toContain("expandStore.clearExpand()");
  });
});

// ---------------------------------------------------------------------------
// Auto-reload on file-writing expand outcomes
// ---------------------------------------------------------------------------
describe("TaskDetailView expand auto-reload", () => {
  it("watches expandStore.outcome", () => {
    expect(scriptSection).toContain("expandStore.outcome");
  });

  it("uses shouldReloadAfterExpand for reload decision", () => {
    expect(scriptSection).toContain("shouldReloadAfterExpand");
    expect(scriptSection).toContain("loadTask()");
  });

  it("imports shouldReloadAfterExpand", () => {
    expect(scriptSection).toContain("shouldReloadAfterExpand");
    expect(scriptSection).toContain("expand-launch-helpers");
  });

  it("has dedup guard via lastReloadedOutcomeRef", () => {
    expect(scriptSection).toContain("lastReloadedOutcomeRef");
  });

  it("shows toast for commit_failed_after_write", () => {
    expect(scriptSection).toContain("commit_failed_after_write");
    expect(scriptSection).toContain("Git commit failed");
  });
});

// ---------------------------------------------------------------------------
// Expand launch helpers module structure
// ---------------------------------------------------------------------------
describe("expand-launch-helpers module", () => {
  it("exports canShowExpandButton", () => {
    expect(helpersSource).toContain("export function canShowExpandButton");
  });

  it("exports isExpandDisabled", () => {
    expect(helpersSource).toContain("export function isExpandDisabled");
  });

  it("exports hasConflictingSession", () => {
    expect(helpersSource).toContain("export function hasConflictingSession");
  });

  it("exports expandDisabledTooltip", () => {
    expect(helpersSource).toContain("export function expandDisabledTooltip");
  });

  it("exports startReasonDisplayText", () => {
    expect(helpersSource).toContain("export function startReasonDisplayText");
  });

  it("exports shouldReloadAfterExpand", () => {
    expect(helpersSource).toContain("export function shouldReloadAfterExpand");
  });

  it("maps all known start reason codes", () => {
    expect(helpersSource).toContain("tasks_file_missing");
    expect(helpersSource).toContain("tasks_file_invalid");
    expect(helpersSource).toContain("task_not_found");
    expect(helpersSource).toContain("task_not_pending");
    expect(helpersSource).toContain("task_has_subtasks");
    expect(helpersSource).toContain("git_not_repo");
    expect(helpersSource).toContain("tasks_file_untracked");
    expect(helpersSource).toContain("git_identity_missing");
    expect(helpersSource).toContain("tasks_file_dirty");
    expect(helpersSource).toContain("active_session");
    expect(helpersSource).toContain("task_mismatch");
  });

  it("does not import pinia stores (pure logic module)", () => {
    expect(helpersSource).not.toContain("defineStore");
    expect(helpersSource).not.toContain("pinia");
    expect(helpersSource).not.toContain("useExpandStore");
    expect(helpersSource).not.toContain("useExecutionStore");
    expect(helpersSource).not.toContain("useChatStore");
    expect(helpersSource).not.toContain("useParsePrdStore");
  });
});

// ---------------------------------------------------------------------------
// CSS classes for expand dialog
// ---------------------------------------------------------------------------
describe("TaskDetailView expand CSS", () => {
  it("has expand progress section styles", () => {
    expect(styleSection).toContain(".expand-progress-section");
  });

  it("has expand dialog form styles", () => {
    expect(styleSection).toContain(".expand-dialog__form");
  });

  it("has expand dialog field styles", () => {
    expect(styleSection).toContain(".expand-dialog__field");
  });

  it("has expand dialog select styles", () => {
    expect(styleSection).toContain(".expand-dialog__select");
  });

  it("has expand dialog submit styles", () => {
    expect(styleSection).toContain(".expand-dialog__submit");
  });

  it("has expand dialog error styles", () => {
    expect(styleSection).toContain(".expand-dialog__error");
  });

  it("has expand dialog retry styles", () => {
    expect(styleSection).toContain(".expand-dialog__retry");
  });
});

// ---------------------------------------------------------------------------
// Existing functionality preserved
// ---------------------------------------------------------------------------
describe("TaskDetailView preserves existing functionality", () => {
  it("still has Save button", () => {
    expect(templateSection).toContain('label="Save"');
  });

  it("still has Back button", () => {
    expect(templateSection).toContain("Back");
  });

  it("still has Refresh button", () => {
    expect(templateSection).toContain('label="Refresh"');
  });

  it("still has ReportSection", () => {
    expect(templateSection).toContain("<ReportSection");
  });

  it("still has subtasks DataTable", () => {
    expect(templateSection).toContain("<DataTable");
  });

  it("still has description field", () => {
    expect(templateSection).toContain("Description");
  });

  it("still has implementation details field", () => {
    expect(templateSection).toContain("Implementation Details");
  });

  it("still has test strategy field", () => {
    expect(templateSection).toContain("Test Strategy");
  });

  it("still has isDirty computed", () => {
    expect(scriptSection).toMatch(/const\s+isDirty\s*=\s*computed/);
  });

  it("still has save function", () => {
    expect(scriptSection).toMatch(/async\s+function\s+save\(\)/);
  });

  it("still has syncDraft function", () => {
    expect(scriptSection).toMatch(/function\s+syncDraft\(\)/);
  });

  it("still has remote update detection", () => {
    expect(scriptSection).toContain("hasRemoteUpdate");
    expect(scriptSection).toContain("lastKnownJson");
  });
});
