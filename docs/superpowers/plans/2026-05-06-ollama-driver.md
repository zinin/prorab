# Ollama Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `ollama` agent to prorab that routes Claude Agent SDK traffic through the local Ollama daemon (`127.0.0.1:11434` by default), giving access to Ollama cloud models (`*:cloud`) without depending on a CCS proxy.

**Architecture:** New `OllamaDriver` class composes over `ClaudeDriver` (mirroring the proven `CcsDriver` pattern). It builds a per-session `env` override (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=ollama`, model defaults, `CLAUDE_CODE_*` knobs) and delegates the actual SDK work to the inner driver. Preflight: HTTP probe `/api/version` + verify the requested cloud model appears in `/v1/models`.

**Tech Stack:** TypeScript (strict), Node.js 24+, `@anthropic-ai/claude-agent-sdk`, vitest, Vue 3 SFCs (UI), zod (`AgentTypeSchema`), commander (CLI).

---

## File Structure

**Created:**
- `src/core/drivers/ollama.ts` — the `OllamaDriver` class (composition over `ClaudeDriver`).
- `src/__tests__/ollama-driver.test.ts` — vitest suite mirroring `ccs-driver.test.ts` patterns.

**Modified:**
- `src/types.ts` — add `"ollama"` to `AgentTypeSchema` (line 326).
- `src/core/drivers/factory.ts` — add `case "ollama"` in `createDriver()` switch.
- `src/index.ts` — extend the `--agent` help string (line 38).
- `ui/src/components/AgentWizard.vue` — add `{ label: "Ollama", value: "ollama" }` (line ~219).
- `ui/src/views/TaskDetailView.vue` — same (line ~207).
- `ui/src/views/ExecutionView.vue` — same (line ~180).
- `ui/src/views/TaskListView.vue` — same (line ~134).
- `.claude/rules/drivers.md` — append `OllamaDriver` section.
- `CLAUDE.md` — add `ollama` to the drivers/agents listing.

**Reference files (read-only — used as patterns, not modified):**
- `src/core/drivers/ccs.ts` — same architectural pattern.
- `src/__tests__/ccs-driver.test.ts` — same test patterns.
- `src/core/drivers/types.ts` — `AgentDriver`, `SessionOptions`, `ChatOptions` interfaces.

---

## Test Setup Conventions

The new test file uses these conventions (copied verbatim from `ccs-driver.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentDriver } from "../core/drivers/types.js";

// Mock ClaudeDriver so we don't need the real SDK
vi.mock("../core/drivers/claude.js", () => {
  const MockClaudeDriver = vi.fn(function (this: any) {
    this.setup = vi.fn().mockResolvedValue(undefined);
    this.teardown = vi.fn().mockResolvedValue(undefined);
    this.runSession = vi.fn().mockResolvedValue({ signal: { type: "complete" } });
    this.startChat = vi.fn();
    this.sendMessage = vi.fn();
    this.replyQuestion = vi.fn();
    this.abortChat = vi.fn();
  });
  return { ClaudeDriver: MockClaudeDriver };
});

import { OllamaDriver } from "../core/drivers/ollama.js";
import { ClaudeDriver } from "../core/drivers/claude.js";

describe("OllamaDriver", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    globalThis.fetch = originalFetch;
  });

  // ... tests ...
});
```

`fetch` is mocked per-test by reassigning `globalThis.fetch = vi.fn().mockResolvedValue(...)`. Each test should set up the fetch mock it needs in its body.

---

## Task 1: Skeleton — class file, test scaffold, "requires model" error

**Files:**
- Create: `src/core/drivers/ollama.ts`
- Create: `src/__tests__/ollama-driver.test.ts`

- [ ] **Step 1.1: Write the failing test (file creation)**

Create `src/__tests__/ollama-driver.test.ts` with the test setup above (mocks for ClaudeDriver, beforeEach/afterEach for env+fetch) and add this single test inside the `describe("OllamaDriver", () => { ... })` block:

```typescript
describe("setup()", () => {
  it("throws when model is missing", async () => {
    const driver = new OllamaDriver();
    await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
      "Ollama agent requires a model",
    );
  });
});
```

- [ ] **Step 1.2: Run test — must fail because the file does not exist**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: vitest fails with module-resolution error (`Cannot find module '../core/drivers/ollama.js'`).

- [ ] **Step 1.3: Create the minimal `ollama.ts`**

Create `src/core/drivers/ollama.ts`:

```typescript
import type { IterationResult, ModelEntry } from "../../types.js";
import type {
  AgentDriver,
  ChatEvent,
  ChatOptions,
  QuestionAnswers,
  SessionOptions,
  SetupOptions,
} from "./types.js";
import { ClaudeDriver } from "./claude.js";

/**
 * OllamaDriver wraps ClaudeDriver via composition (same strategy as CcsDriver).
 *
 * It points the Claude Agent SDK at the local Ollama daemon
 * (`http://127.0.0.1:11434` by default, or `OLLAMA_HOST`) so that
 * Anthropic-protocol requests reach Ollama-cloud models. The daemon takes
 * care of upstream Ed25519 signing.
 */
export class OllamaDriver implements AgentDriver {
  private inner: ClaudeDriver | null = null;
  private sessionEnv?: Record<string, string>;

  constructor(
    private model?: string,
    private useUserSettings: boolean = false,
  ) {}

  async setup(_opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    throw new Error("Not implemented yet");
  }

  async teardown(): Promise<void> {
    this.inner = null;
    this.sessionEnv = undefined;
  }

  runSession(_opts: SessionOptions): Promise<IterationResult> {
    throw new Error("Not implemented yet");
  }

  startChat(_opts: ChatOptions): AsyncIterable<ChatEvent> {
    throw new Error("Not implemented yet");
  }

  sendMessage(_text: string): void {
    throw new Error("Not implemented yet");
  }

  replyQuestion(_questionId: string, _answers: QuestionAnswers): void {
    throw new Error("Not implemented yet");
  }

  abortChat(): void {
    throw new Error("Not implemented yet");
  }

  async listModels(): Promise<ModelEntry[]> {
    return [];
  }
}
```

- [ ] **Step 1.4: Run test — must pass**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: 1 passed.

- [ ] **Step 1.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): add OllamaDriver skeleton with model-required guard"
```

---

## Task 2: `listModels()` — daemon down returns empty list

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 2.1: Write the failing test**

Add a new `describe("listModels()", ...)` block (sibling to the `describe("setup()")` block):

```typescript
describe("listModels()", () => {
  it("returns [] when daemon fetch rejects", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const driver = new OllamaDriver();
    const models = await driver.listModels();
    expect(models).toEqual([]);
  });

  it("returns [] when daemon returns non-OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("nope", { status: 500 }),
    );
    const driver = new OllamaDriver();
    const models = await driver.listModels();
    expect(models).toEqual([]);
  });

  it("returns [] when daemon returns malformed JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("not json{", { status: 200 }),
    );
    const driver = new OllamaDriver();
    const models = await driver.listModels();
    expect(models).toEqual([]);
  });
});
```

- [ ] **Step 2.2: Run tests — first new test fails because real `listModels()` returns `[]` already**

Wait — re-read step 1.3: `listModels()` already returns `[]`. So the first test passes trivially even without a real implementation. The failing intent is "real fetch logic that handles errors gracefully". Skip running for now and proceed to implement the real method, then run.

Actually, the clean path is to assert that the implementation calls `fetch`. Update the first test:

Replace the first test body with:

```typescript
const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
globalThis.fetch = fetchMock;
const driver = new OllamaDriver();
const models = await driver.listModels();
expect(models).toEqual([]);
expect(fetchMock).toHaveBeenCalledWith(
  "http://127.0.0.1:11434/v1/models",
  expect.objectContaining({ signal: expect.any(AbortSignal) }),
);
```

Now this fails — the stub returns `[]` without calling `fetch`.

- [ ] **Step 2.3: Run tests — confirm failure**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: at least one test fails (`fetchMock not called`).

- [ ] **Step 2.4: Implement `listModels()`**

Replace the `listModels()` body in `src/core/drivers/ollama.ts`:

```typescript
  async listModels(): Promise<ModelEntry[]> {
    const baseUrl = this.resolveBaseUrl();
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      return [];
    }
    if (!resp.ok) return [];
    let data: { data?: Array<{ id?: unknown }> };
    try {
      data = await resp.json();
    } catch {
      return [];
    }
    const list = Array.isArray(data?.data) ? data.data : [];
    return list
      .filter((m): m is { id: string } => typeof m.id === "string" && m.id.includes(":cloud"))
      .map((m) => ({ id: m.id, name: m.id }));
  }

  private resolveBaseUrl(): string {
    const host = process.env.OLLAMA_HOST?.trim() || "127.0.0.1:11434";
    return /^https?:\/\//i.test(host) ? host : `http://${host}`;
  }
```

- [ ] **Step 2.5: Run tests — all three should pass**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: 4 passed (1 from Task 1, 3 from this task).

- [ ] **Step 2.6: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): listModels() with graceful daemon-down/non-OK/malformed-JSON handling"
```

---

## Task 3: `listModels()` — happy path filters to `:cloud`

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`

- [ ] **Step 3.1: Write the failing test**

Add inside the `describe("listModels()")` block:

```typescript
it("filters to *:cloud* models from /v1/models", async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: [
          { id: "llama3.2:3b", object: "model" },
          { id: "deepseek-v4-pro:cloud[1m]", object: "model" },
          { id: "kimi-k2.6:cloud", object: "model" },
          { id: "qwen3-coder:480b", object: "model" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const driver = new OllamaDriver();
  const models = await driver.listModels();
  expect(models).toEqual([
    { id: "deepseek-v4-pro:cloud[1m]", name: "deepseek-v4-pro:cloud[1m]" },
    { id: "kimi-k2.6:cloud", name: "kimi-k2.6:cloud" },
  ]);
});
```

- [ ] **Step 3.2: Run test — must pass (filter logic is already in Task 2's impl)**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: 5 passed.

If the test fails, the implementation in Task 2 was insufficient — adjust the filter logic in `ollama.ts` until this test passes alongside the others.

- [ ] **Step 3.3: Commit**

```bash
git add src/__tests__/ollama-driver.test.ts
git commit -m "test(ollama): listModels() filters to :cloud models"
```

---

## Task 4: `listModels()` honors `OLLAMA_HOST`

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`

- [ ] **Step 4.1: Write the failing test**

Add inside `describe("listModels()")`:

```typescript
it("uses OLLAMA_HOST env var (host:port form)", async () => {
  process.env.OLLAMA_HOST = "192.168.1.10:11434";
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), { status: 200 }),
  );
  globalThis.fetch = fetchMock;
  await new OllamaDriver().listModels();
  expect(fetchMock).toHaveBeenCalledWith(
    "http://192.168.1.10:11434/v1/models",
    expect.anything(),
  );
});

it("uses OLLAMA_HOST env var (https URL form, kept as-is)", async () => {
  process.env.OLLAMA_HOST = "https://my-ollama.example.com";
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ data: [] }), { status: 200 }),
  );
  globalThis.fetch = fetchMock;
  await new OllamaDriver().listModels();
  expect(fetchMock).toHaveBeenCalledWith(
    "https://my-ollama.example.com/v1/models",
    expect.anything(),
  );
});
```

- [ ] **Step 4.2: Run tests — should pass (resolveBaseUrl already handles both forms)**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: 7 passed.

- [ ] **Step 4.3: Commit**

```bash
git add src/__tests__/ollama-driver.test.ts
git commit -m "test(ollama): listModels() respects OLLAMA_HOST in both host:port and URL forms"
```

---

## Task 5: `setup()` preflight — daemon-not-reachable

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 5.1: Write the failing test**

Add inside `describe("setup()")`:

```typescript
it("throws when daemon /api/version fetch rejects", async () => {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
    /daemon is not reachable.*ollama serve/,
  );
});

it("throws when daemon /api/version returns non-OK", async () => {
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response("err", { status: 500 }),
  );
  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
    /daemon is not reachable/,
  );
});
```

- [ ] **Step 5.2: Run tests — must fail**

Expected: both new tests fail because `setup()` currently throws "Not implemented yet".

- [ ] **Step 5.3: Implement preflight (daemon reachability) in `setup()`**

In `src/core/drivers/ollama.ts`, replace the `setup()` body:

```typescript
  async setup(opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    await this.preflightDaemon();
    throw new Error("Not implemented yet");
  }

  private async preflightDaemon(): Promise<void> {
    const baseUrl = this.resolveBaseUrl();
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/api/version`, {
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      throw new Error(
        `Ollama daemon is not reachable at ${baseUrl}. Start it with: ollama serve`,
      );
    }
    if (!resp.ok) {
      throw new Error(
        `Ollama daemon is not reachable at ${baseUrl}. Start it with: ollama serve`,
      );
    }
  }
```

- [ ] **Step 5.4: Run tests — all should pass except the still-stubbed downstream of `setup()`**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: 9 passed.

- [ ] **Step 5.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): preflight rejects when daemon not reachable"
```

---

## Task 6: `setup()` preflight — cloud model not in `/v1/models`

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 6.1: Write the failing test**

Add inside `describe("setup()")`:

```typescript
it("throws when requested cloud model is missing from /v1/models", async () => {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    }
    if (u.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "kimi-k2.6:cloud" }] }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
    /Model 'deepseek-v4-pro:cloud\[1m\]' is not available.*ollama signin/,
  );
});
```

- [ ] **Step 6.2: Run test — must fail**

The test will fail because `setup()` still throws "Not implemented yet" after `preflightDaemon`.

- [ ] **Step 6.3: Implement cloud-model preflight**

In `src/core/drivers/ollama.ts`, update `setup()` body:

```typescript
  async setup(opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    await this.preflightDaemon();
    await this.preflightModel();
    throw new Error("Not implemented yet");
  }

  private async preflightModel(): Promise<void> {
    if (!this.model || !this.model.includes(":cloud")) return;
    const models = await this.listModels();
    if (!models.some((m) => m.id === this.model)) {
      const list = models.map((m) => m.id).join(", ") || "(none)";
      throw new Error(
        `Model '${this.model}' is not available via ollama. ` +
          `Check 'ollama signin' status, or pick from: ${list}`,
      );
    }
  }
```

- [ ] **Step 6.4: Run tests — must pass**

Expected: 10 passed.

- [ ] **Step 6.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): preflight rejects cloud models missing from /v1/models"
```

---

## Task 7: `setup()` builds env vars (BASE_URL, AUTH_TOKEN, API_KEY, model defaults, ATTRIBUTION)

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 7.1: Add a shared test helper**

Inside the top-level `describe("OllamaDriver", ...)` (after `afterEach`), add a small helper that the next several tests will reuse to set up a fetch mock returning a single given cloud model:

```typescript
function mockOllamaWith(modelId: string): void {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/version")) {
      return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    }
    if (u.endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: modelId }] }),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}
```

- [ ] **Step 7.2: Write the failing test**

Add inside `describe("setup()")`:

```typescript
it("builds session env with required Anthropic + Claude Code vars", async () => {
  mockOllamaWith("deepseek-v4-pro:cloud[1m]");
  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await driver.setup({ verbosity: "info" });

  // Trigger a runSession so we can inspect what the inner driver received.
  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  const calledOpts = innerInstance.runSession.mock.calls[0][0];

  expect(calledOpts.env).toBeDefined();
  expect(calledOpts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:11434");
  expect(calledOpts.env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");
  expect(calledOpts.env.ANTHROPIC_API_KEY).toBe("");
  expect(calledOpts.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-pro:cloud[1m]");
  expect(calledOpts.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-v4-pro:cloud[1m]");
  expect(calledOpts.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-pro:cloud[1m]");
  expect(calledOpts.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-pro:cloud[1m]");
  expect(calledOpts.env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe("0");

  await driver.teardown();
});
```

- [ ] **Step 7.3: Run test — must fail**

`setup()` still throws "Not implemented yet" after preflight; `runSession` also throws. The test fails.

- [ ] **Step 7.4: Implement `buildEnv()`, finish `setup()`, and wire `runSession`**

In `src/core/drivers/ollama.ts`:

Replace `setup()`:

```typescript
  async setup(opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    await this.preflightDaemon();
    await this.preflightModel();
    this.inner = new ClaudeDriver(this.model, this.useUserSettings);
    this.sessionEnv = this.buildEnv();
    const innerAsDriver = this.inner as AgentDriver;
    if (innerAsDriver.setup) {
      await innerAsDriver.setup(opts);
    }
  }
```

Add `buildEnv()`:

```typescript
  private buildEnv(): Record<string, string> {
    const baseUrl = this.resolveBaseUrl();
    const model = this.model as string;
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = "ollama";
    env.ANTHROPIC_API_KEY = "";
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";
    return env;
  }
```

Replace `runSession()`:

```typescript
  runSession(opts: SessionOptions): Promise<IterationResult> {
    const driver = this.requireDriver();
    const overrides: Partial<SessionOptions> = {};
    if (this.sessionEnv) overrides.env = this.sessionEnv;
    return Object.keys(overrides).length > 0
      ? driver.runSession({ ...opts, ...overrides })
      : driver.runSession(opts);
  }

  private requireDriver(): ClaudeDriver {
    if (!this.inner) {
      throw new Error("Ollama driver not initialized. Call setup() first.");
    }
    return this.inner;
  }
```

Replace `teardown()`:

```typescript
  async teardown(): Promise<void> {
    const innerAsDriver = this.inner as AgentDriver | null;
    if (innerAsDriver?.teardown) {
      await innerAsDriver.teardown();
    }
    this.inner = null;
    this.sessionEnv = undefined;
  }
```

- [ ] **Step 7.5: Run tests — must pass**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: 11 passed.

- [ ] **Step 7.6: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): build session env, instantiate inner ClaudeDriver, delegate runSession"
```

---

## Task 8: `setup()` env honors `OLLAMA_HOST`

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`

- [ ] **Step 8.1: Write the failing test**

Add inside `describe("setup()")`:

```typescript
it("env ANTHROPIC_BASE_URL honors OLLAMA_HOST (host:port → http://...)", async () => {
  process.env.OLLAMA_HOST = "192.168.1.10:11434";
  mockOllamaWith("deepseek-v4-pro:cloud[1m]");
  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  const calledOpts = innerInstance.runSession.mock.calls[0][0];
  expect(calledOpts.env.ANTHROPIC_BASE_URL).toBe("http://192.168.1.10:11434");

  await driver.teardown();
});

it("env ANTHROPIC_BASE_URL preserves OLLAMA_HOST URL form", async () => {
  process.env.OLLAMA_HOST = "https://my-ollama.example.com";
  mockOllamaWith("kimi-k2.6:cloud");
  const driver = new OllamaDriver("kimi-k2.6:cloud");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  const calledOpts = innerInstance.runSession.mock.calls[0][0];
  expect(calledOpts.env.ANTHROPIC_BASE_URL).toBe("https://my-ollama.example.com");

  await driver.teardown();
});
```

- [ ] **Step 8.2: Run tests — should pass (resolveBaseUrl already handles both forms)**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: 13 passed.

- [ ] **Step 8.3: Commit**

```bash
git add src/__tests__/ollama-driver.test.ts
git commit -m "test(ollama): setup() env honors OLLAMA_HOST in both forms"
```

---

## Task 9: `setup()` parses `CLAUDE_CODE_AUTO_COMPACT_WINDOW` from model suffix

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 9.1: Write the failing tests**

Add inside `describe("setup()")`:

```typescript
it("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from [1m] suffix", async () => {
  mockOllamaWith("deepseek-v4-pro:cloud[1m]");
  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  const calledOpts = innerInstance.runSession.mock.calls[0][0];
  expect(calledOpts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");

  await driver.teardown();
});

it("sets CLAUDE_CODE_AUTO_COMPACT_WINDOW from [200k] suffix", async () => {
  mockOllamaWith("foo-model:cloud[200k]");
  const driver = new OllamaDriver("foo-model:cloud[200k]");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  const calledOpts = innerInstance.runSession.mock.calls[0][0];
  expect(calledOpts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");

  await driver.teardown();
});

it("omits CLAUDE_CODE_AUTO_COMPACT_WINDOW when no [Nk]/[Nm] suffix", async () => {
  mockOllamaWith("kimi-k2.6:cloud");
  const driver = new OllamaDriver("kimi-k2.6:cloud");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  const calledOpts = innerInstance.runSession.mock.calls[0][0];
  expect(calledOpts.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();

  await driver.teardown();
});
```

- [ ] **Step 9.2: Run tests — first two must fail (variable not set)**

Expected: 2 failures (the `[1m]` and `[200k]` cases). The "omits" case passes because the env builder doesn't set it yet.

- [ ] **Step 9.3: Implement `parseContextWindow()` and add to `buildEnv()`**

In `src/core/drivers/ollama.ts`, add a module-level helper above the class declaration:

```typescript
/**
 * Extract the context-window hint from a model id like
 * `deepseek-v4-pro:cloud[1m]` → 1_000_000, `foo:cloud[200k]` → 200_000.
 * Returns null if the model has no `[Nk]`/`[Nm]` suffix; the caller then
 * omits CLAUDE_CODE_AUTO_COMPACT_WINDOW and Claude Code uses its default.
 */
function parseContextWindow(model: string): number | null {
  const match = /\[(\d+)([km])\]/i.exec(model);
  if (!match) return null;
  const [, num, unit] = match;
  const multiplier = unit.toLowerCase() === "m" ? 1_000_000 : 1_000;
  return Number(num) * multiplier;
}
```

In `buildEnv()`, after the `CLAUDE_CODE_ATTRIBUTION_HEADER` line, add:

```typescript
    const ctx = parseContextWindow(model);
    if (ctx !== null) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(ctx);
    }
```

- [ ] **Step 9.4: Run tests — all should pass**

Expected: 16 passed.

- [ ] **Step 9.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): parse [Nk]/[Nm] suffix into CLAUDE_CODE_AUTO_COMPACT_WINDOW"
```

---

## Task 10: `startChat()` injects env into inner driver

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 10.1: Write the failing test**

Add inside `describe("setup()")` (or a new sibling `describe("startChat()")`):

```typescript
it("startChat() forwards sessionEnv to the inner ClaudeDriver", async () => {
  mockOllamaWith("kimi-k2.6:cloud");
  const driver = new OllamaDriver("kimi-k2.6:cloud");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  driver.startChat({ cwd: "/tmp", verbosity: "info" });

  expect(innerInstance.startChat).toHaveBeenCalledTimes(1);
  const calledOpts = innerInstance.startChat.mock.calls[0][0];
  expect(calledOpts.env).toBeDefined();
  expect(calledOpts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:11434");
  expect(calledOpts.env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");

  await driver.teardown();
});
```

- [ ] **Step 10.2: Run test — must fail**

`startChat()` still throws "Not implemented yet".

- [ ] **Step 10.3: Implement `startChat()` (delegation with env override)**

In `src/core/drivers/ollama.ts`, replace `startChat()`:

```typescript
  startChat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    const driver = this.requireDriver();
    const overrides: Partial<ChatOptions> = {};
    if (this.sessionEnv) overrides.env = this.sessionEnv;
    return Object.keys(overrides).length > 0
      ? driver.startChat({ ...opts, ...overrides })
      : driver.startChat(opts);
  }
```

- [ ] **Step 10.4: Run tests — must pass**

Expected: 17 passed.

- [ ] **Step 10.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): startChat() injects sessionEnv into inner driver"
```

---

## Task 11: `sendMessage` / `replyQuestion` / `abortChat` delegation

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 11.1: Write the failing tests**

Add inside `describe("OllamaDriver", ...)`:

```typescript
describe("chat delegation", () => {
  it("sendMessage / replyQuestion / abortChat delegate to inner driver", async () => {
    mockOllamaWith("kimi-k2.6:cloud");
    const driver = new OllamaDriver("kimi-k2.6:cloud");
    await driver.setup({ verbosity: "info" });

    const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;

    driver.sendMessage("hello");
    expect(innerInstance.sendMessage).toHaveBeenCalledWith("hello");

    driver.replyQuestion("q-1", { answer: "yes" });
    expect(innerInstance.replyQuestion).toHaveBeenCalledWith("q-1", { answer: "yes" });

    driver.abortChat();
    expect(innerInstance.abortChat).toHaveBeenCalledTimes(1);

    await driver.teardown();
  });

  it("delegation methods throw when setup() has not been called", () => {
    const driver = new OllamaDriver("kimi-k2.6:cloud");
    expect(() => driver.sendMessage("hi")).toThrow(/not initialized/);
    expect(() => driver.replyQuestion("q", {})).toThrow(/not initialized/);
    expect(() => driver.abortChat()).toThrow(/not initialized/);
  });
});
```

- [ ] **Step 11.2: Run tests — must fail**

The chat methods still throw "Not implemented yet".

- [ ] **Step 11.3: Implement the delegation methods**

In `src/core/drivers/ollama.ts`, replace each:

```typescript
  sendMessage(text: string): void {
    this.requireDriver().sendMessage(text);
  }

  replyQuestion(questionId: string, answers: QuestionAnswers): void {
    this.requireDriver().replyQuestion(questionId, answers);
  }

  abortChat(): void {
    this.requireDriver().abortChat();
  }
```

- [ ] **Step 11.4: Run tests — must pass**

Expected: 19 passed.

- [ ] **Step 11.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): delegate sendMessage/replyQuestion/abortChat to inner driver"
```

---

## Task 12: `teardown()` clears state and calls inner teardown

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`

- [ ] **Step 12.1: Write the failing test**

Add inside `describe("OllamaDriver", ...)`:

```typescript
describe("teardown()", () => {
  it("clears inner driver and sessionEnv; subsequent calls throw", async () => {
    mockOllamaWith("kimi-k2.6:cloud");
    const driver = new OllamaDriver("kimi-k2.6:cloud");
    await driver.setup({ verbosity: "info" });
    const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
    await driver.teardown();

    expect(innerInstance.teardown).toHaveBeenCalledTimes(1);
    expect(() => driver.runSession({} as any)).toThrow(/not initialized/);
    expect(() => driver.sendMessage("x")).toThrow(/not initialized/);
  });
});
```

- [ ] **Step 12.2: Run test — must pass (teardown already implemented in Task 7)**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: 20 passed.

- [ ] **Step 12.3: Commit**

```bash
git add src/__tests__/ollama-driver.test.ts
git commit -m "test(ollama): teardown clears state and inner teardown is invoked"
```

---

## Task 13: Wire `AgentTypeSchema` and `factory.ts`

**Files:**
- Modify: `src/types.ts:326`
- Modify: `src/core/drivers/factory.ts`

- [ ] **Step 13.1: Extend `AgentTypeSchema`**

In `src/types.ts:326`, change:

```typescript
export const AgentTypeSchema = z.enum(["claude", "opencode", "ccs", "codex"]);
```

to:

```typescript
export const AgentTypeSchema = z.enum(["claude", "opencode", "ccs", "codex", "ollama"]);
```

- [ ] **Step 13.2: Add `ollama` to factory switch**

In `src/core/drivers/factory.ts`, add an import and a switch case:

```typescript
import { OllamaDriver } from "./ollama.js";
```

In the `switch (agent)` block, before `default`, add:

```typescript
    case "ollama":
      return new OllamaDriver(model, useUserSettings);
```

- [ ] **Step 13.3: Run the full test suite to confirm nothing else broke**

```
npm test
```

Expected: full suite passes (existing tests + 20 new OllamaDriver tests).

- [ ] **Step 13.4: Commit**

```bash
git add src/types.ts src/core/drivers/factory.ts
git commit -m "feat(ollama): wire OllamaDriver into AgentType + factory"
```

---

## Task 14: CLI help text

**Files:**
- Modify: `src/index.ts:38`

- [ ] **Step 14.1: Update `--agent` help string**

In `src/index.ts:38`, change:

```typescript
  .option("--agent <type>", 'Agent backend: "claude", "opencode", "ccs", or "codex"', "claude")
```

to:

```typescript
  .option("--agent <type>", 'Agent backend: "claude", "opencode", "ccs", "codex", or "ollama"', "claude")
```

- [ ] **Step 14.2: Verify build still succeeds**

```
npm run build
```

Expected: TypeScript build passes (no errors).

- [ ] **Step 14.3: Commit**

```bash
git add src/index.ts
git commit -m "feat(ollama): add ollama to --agent CLI help text"
```

---

## Task 15: UI dropdown — add `Ollama` to all four agent lists

**Files:**
- Modify: `ui/src/components/AgentWizard.vue`
- Modify: `ui/src/views/TaskListView.vue`
- Modify: `ui/src/views/TaskDetailView.vue`
- Modify: `ui/src/views/ExecutionView.vue`

Each file contains a literal array of agent options. Insert the new entry after the existing `Codex` line (last in the list) so ordering stays consistent.

- [ ] **Step 15.1: Modify `ui/src/components/AgentWizard.vue` (line ~219)**

Replace:

```typescript
  { label: "Claude", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "CCS", value: "ccs" },
  { label: "Codex", value: "codex" },
```

with:

```typescript
  { label: "Claude", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "CCS", value: "ccs" },
  { label: "Codex", value: "codex" },
  { label: "Ollama", value: "ollama" },
```

Then verify the existing conditionals in this file gate the effort/variant dropdown by agent. Around line 129 the file has:

```typescript
return step.agent === "claude" || step.agent === "ccs" ? "Effort" : "Variant";
```

and around line 483:

```html
<label>{{ agent === 'claude' || agent === 'ccs' ? 'Effort' : 'Variant' }}</label>
```

`ollama` is intentionally absent from these — by design (per spec §4) the Ollama agent has no effort/variant dropdown. Confirm by reading around lines 480-575 that the variant input is rendered for all agents though, as a generic field; if so, leave it alone (the model dropdown alone is what we control via `listModels()` returning no `variants`). **Do not** add Ollama-specific gates for variant unless a test fails.

- [ ] **Step 15.2: Modify `ui/src/views/TaskListView.vue` (line ~134)**

Find the same array (`{ label: "Claude", value: "claude" }, ...`) and append `{ label: "Ollama", value: "ollama" },` as the last entry.

- [ ] **Step 15.3: Modify `ui/src/views/TaskDetailView.vue` (line ~207)**

Same change as above.

- [ ] **Step 15.4: Modify `ui/src/views/ExecutionView.vue` (line ~180)**

Same change as above.

- [ ] **Step 15.5: Verify Vue type-check still passes**

```
npx vue-tsc --noEmit --project ui/tsconfig.json
```

Expected: no errors. (Vite skips type-check during build, so this is the only place we catch UI type drift.)

- [ ] **Step 15.6: Run UI build to ensure the SFC compiles**

```
npm run build:ui
```

Expected: build succeeds.

- [ ] **Step 15.7: Commit**

```bash
git add ui/src/components/AgentWizard.vue ui/src/views/TaskListView.vue ui/src/views/TaskDetailView.vue ui/src/views/ExecutionView.vue
git commit -m "feat(ollama): add Ollama option to UI agent dropdowns"
```

---

## Task 16: Documentation

**Files:**
- Modify: `.claude/rules/drivers.md`
- Modify: `CLAUDE.md`

- [ ] **Step 16.1: Append `OllamaDriver` section to `.claude/rules/drivers.md`**

Add after the `CodexDriver` section:

```markdown
## OllamaDriver

Standalone driver wrapping `ClaudeDriver` via composition (same pattern as `CcsDriver`). Routes the Claude Agent SDK at the local Ollama daemon (`http://127.0.0.1:11434` by default; `OLLAMA_HOST` overrides). Lets prorab use Ollama-cloud models like `deepseek-v4-pro:cloud[1m]` and `kimi-k2.6:cloud` without depending on a CCS proxy.

**Setup**: preflight = HTTP `GET /api/version` (daemon up?) + `GET /v1/models` filter (`:cloud`) to verify the requested cloud model is accessible (proxy for "signed in"). Throws actionable errors otherwise.

**Per-session env** (mirrors `ollama launch claude --model <name>`):

- `ANTHROPIC_BASE_URL=<resolved daemon URL>`
- `ANTHROPIC_AUTH_TOKEN=ollama` (sentinel — daemon recognizes it)
- `ANTHROPIC_API_KEY=""` (explicit empty so a stray host env var does not leak)
- `ANTHROPIC_DEFAULT_OPUS_MODEL`/`SONNET_MODEL`/`HAIKU_MODEL` = chosen model
- `CLAUDE_CODE_SUBAGENT_MODEL` = chosen model
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` = parsed from `[1m]`/`[200k]` suffix; omitted when no suffix.

**Models**: `listModels()` queries the daemon's OpenAI-compat `/v1/models` and filters to entries whose `id` contains `:cloud`. No `variants` field — UI hides the effort dropdown.

**Auth**: relies entirely on the user's `ollama signin` (Ed25519 key in `~/.ollama/id_ed25519`). prorab never reads upstream tokens or signs requests itself; the daemon does.
```

- [ ] **Step 16.2: Update `CLAUDE.md`**

In the "Tech Stack" / drivers list and the `--agent` enumeration, add `ollama`. Specifically:

In the `## Architecture` section (around the `core/drivers/` description), change:

```
├── core/
│   ├── drivers/          # AgentDriver strategy: claude.ts, opencode.ts, ccs.ts, codex.ts, factory.ts, types.ts, logging.ts, context-window.ts, async-queue.ts
```

to:

```
├── core/
│   ├── drivers/          # AgentDriver strategy: claude.ts, opencode.ts, ccs.ts, codex.ts, ollama.ts, factory.ts, types.ts, logging.ts, context-window.ts, async-queue.ts
```

Also in the `## Key Patterns` section — under `**Agent drivers**`, change:

```
**Agent drivers**: Strategy pattern — `AgentDriver` with `ClaudeDriver`, `OpenCodeDriver`, `CcsDriver`, and `CodexDriver`. ... Selected via `--agent claude|opencode|ccs|codex`.
```

to:

```
**Agent drivers**: Strategy pattern — `AgentDriver` with `ClaudeDriver`, `OpenCodeDriver`, `CcsDriver`, `CodexDriver`, and `OllamaDriver`. ... Selected via `--agent claude|opencode|ccs|codex|ollama`.
```

In the `## Modular Docs` section, the `drivers.md` bullet remains valid (we just appended a section).

- [ ] **Step 16.3: Commit**

```bash
git add .claude/rules/drivers.md CLAUDE.md
git commit -m "docs(ollama): document OllamaDriver in drivers.md and CLAUDE.md"
```

---

## Task 17: End-to-end manual verification

**Files:** none (manual session, no edits — this task confirms the implementation works against a real daemon).

- [ ] **Step 17.1: Confirm prerequisites**

```
ollama --version
ollama list
ls ~/.ollama/id_ed25519
```

Expected: ollama installed, daemon should be running already (otherwise start with `ollama serve` in another terminal), and the Ed25519 key file exists (created on first daemon start; signin already done if cloud models work in `ollama launch claude`).

- [ ] **Step 17.2: Run prorab serve and check the UI**

```
npm run build && node dist/index.js serve
```

Open the printed `http://127.0.0.1:<port>` URL. In the agent dropdown choose **Ollama**. The model dropdown should populate with whatever `*:cloud` models the daemon reports. Pick `deepseek-v4-pro:cloud[1m]`. Run a small task. Verify you see normal Claude Code SDK output (not 401).

- [ ] **Step 17.3: Confirm fail modes**

Stop the daemon (`pkill ollama` in another terminal) and re-run a task — `setup()` should fail with `Ollama daemon is not reachable at http://127.0.0.1:11434. Start it with: ollama serve`.

Restart the daemon. Run `ollama signout` (this leaves the daemon up but removes cloud-account access — `/v1/models` will not list `:cloud` models). Re-run a task — `setup()` should fail with `Model '<m>' is not available via ollama. Check 'ollama signin' status, ...`.

`ollama signin` again to restore.

- [ ] **Step 17.4: Document the verification outcome**

If anything fails or behaves unexpectedly: open an issue and stop. Otherwise, record "verified on 2026-05-06 against ollama 0.23.1 with deepseek-v4-pro:cloud[1m]" in the PR description.

- [ ] **Step 17.5: No commit** (this task is a manual smoke test).

---

## Pre-PR Cleanup

Per `/home/zinin/.claude/CLAUDE.md`, design and plan documents under `docs/superpowers/` must NOT appear in the PR diff. Before opening the PR:

```bash
git rm docs/superpowers/specs/2026-05-06-ollama-agent-design.md docs/superpowers/plans/2026-05-06-ollama-driver.md
git commit -m "chore: drop ollama-driver design + plan docs before PR"
```

The documents stay accessible via the branch's git history if needed later.

---

## Self-Review Checklist (run at end of implementation)

- [ ] All 9 spec tests have a corresponding task: skeleton (Task 1), `:cloud` filter (Task 3), daemon-down preflight (Task 5), missing-cloud-model preflight (Task 6), env contents (Task 7), `OLLAMA_HOST` (Task 8), `AUTO_COMPACT_WINDOW` (Task 9), env injection on runSession + startChat (Tasks 7 + 10), listModels error contract (Task 2). ✓
- [ ] Type names match across tasks: `OllamaDriver`, `AgentDriver`, `SessionOptions`, `ChatOptions`, `ModelEntry`, `IterationResult`, `AgentTypeSchema`, `ClaudeDriver`. ✓
- [ ] No "TBD"/"TODO"/"similar to Task N" placeholders in any code block. ✓
- [ ] Every step that changes code shows the actual code or exact diff. ✓
- [ ] Commit messages are scoped (`feat(ollama)`, `test(ollama)`, `docs(ollama)`, `chore`). ✓
- [ ] Pre-PR cleanup removes `docs/superpowers/specs/...` and `docs/superpowers/plans/...`. ✓
