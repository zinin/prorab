# Ollama Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `ollama` agent to prorab that routes Claude Agent SDK traffic through the local Ollama daemon (`127.0.0.1:11434` by default), giving access to Ollama cloud models without depending on a CCS proxy.

**Architecture:** New `OllamaDriver` class composes over `ClaudeDriver` (mirroring the proven `CcsDriver` pattern; subclass alternative was considered and rejected to keep the interface explicit). It builds a per-session `env` override (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=ollama`, model defaults, `CLAUDE_CODE_*` knobs — with a strip pass for any leaked parent `ANTHROPIC_*`/`CLAUDE_CODE_*`) and delegates SDK work to the inner driver, stripping `opts.variant` before delegation. Preflight: HTTP probe `/api/version` + per-model `GET /v1/models/<id>` to disambiguate signed-in / not-signed-in / transient. The model catalog is hardcoded (`OLLAMA_CLOUD_CATALOG`) because the daemon's bulk `GET /v1/models` is local-manifest-only and returns `data:null` even for signed-in cloud profiles (verified empirically on Ollama 0.23.1).

**Tech Stack:** TypeScript (strict), Node.js 24+, `@anthropic-ai/claude-agent-sdk`, vitest, Vue 3 SFCs (UI), zod (`AgentTypeSchema`), commander (CLI).

---

## File Structure

**Created:**
- `src/core/drivers/ollama.ts` — the `OllamaDriver` class (composition over `ClaudeDriver`).
- `src/__tests__/ollama-driver.test.ts` — vitest suite mirroring `ccs-driver.test.ts` patterns.

**Modified:**
- `src/types.ts` — add `"ollama"` to `AgentTypeSchema` (line 326). `Reviewer` derives from this enum and updates automatically.
- `src/core/drivers/factory.ts` — add `case "ollama"` in `createDriver()` switch.
- `src/index.ts` — extend the `--agent` help string (line 38).
- `src/server/routes/models.ts` — extend the `needsSetup` exemption to include `"ollama"` so `/api/models?agent=ollama` doesn't call the model-required `setup()`; skip caching empty results so the dropdown reflects current daemon state on subsequent calls.
- `ui/src/components/AgentWizard.vue` — add `{ label: "Ollama", value: "ollama" }` to the agents list, and extend the "No user settings" checkbox `v-if` (currently `agent === 'claude' || agent === 'ccs'`) to include `'ollama'`.
- `ui/src/views/TaskDetailView.vue` — add `{ label: "Ollama", value: "ollama" }` (line ~207).
- `ui/src/views/ExecutionView.vue` — same (line ~180).
- `ui/src/views/TaskListView.vue` — same (line ~134).
- `.claude/rules/drivers.md` — append `OllamaDriver` section.
- `.claude/rules/frontend.md` — mention `"ollama"` in the agent list / store description.
- `CLAUDE.md` — add `ollama` to the drivers/agents listing.
- `README.md` — add `Ollama` to the four mentions of supported agents (line ~14, ~73, ~85, ~120).

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

## Task 2: `listModels()` — hardcoded catalog probed via per-model GET

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

**Background:** Per design §`listModels()`, the daemon's bulk `GET /v1/models` is local-manifest-only and returns `{"object":"list","data":null}` even for signed-in cloud profiles (verified empirically on Ollama 0.23.1). We define `OLLAMA_CLOUD_CATALOG` as a hardcoded list, then probe each entry via `GET /v1/models/<id>` and surface the ones that come back with HTTP 200.

- [ ] **Step 2.1: Write the failing tests**

Add a new `describe("listModels()")` block (sibling to `describe("setup()")`):

```typescript
describe("listModels()", () => {
  it("returns [] when daemon /api/version rejects", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const models = await new OllamaDriver().listModels();
    expect(models).toEqual([]);
  });

  it("returns [] when daemon /api/version returns non-OK", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 }));
    const models = await new OllamaDriver().listModels();
    expect(models).toEqual([]);
  });

  it("probes each catalog entry via /v1/models/<id> and keeps only HTTP-200 ones", async () => {
    const accessible = new Set(["deepseek-v4-pro:cloud[1m]", "kimi-k2.6:cloud", "minimax-m2.7:cloud"]);
    globalThis.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
      const m = u.match(/\/v1\/models\/(.+)$/);
      if (m) {
        const decoded = decodeURIComponent(m[1]);
        return new Response(JSON.stringify({ id: decoded }), { status: accessible.has(decoded) ? 200 : 404 });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;

    const models = await new OllamaDriver().listModels();
    const ids = models.map((x) => x.id).sort();
    expect(ids).toEqual(["deepseek-v4-pro:cloud[1m]", "kimi-k2.6:cloud", "minimax-m2.7:cloud"]);
    // ModelEntry must NOT carry a `variants` field — UI hides effort dropdown via that.
    for (const m of models) expect(m).not.toHaveProperty("variants");
  });

  it("URL-encodes catalog ids when probing (square brackets do not break the URL)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
      return new Response("", { status: 404 });          // all 404 — only checking call shape
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;

    await new OllamaDriver().listModels();
    const calls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => String(c[0]));
    // No raw `[` should leak into the URL — encodeURIComponent turns it into %5B.
    for (const c of calls) {
      if (c.includes("/v1/models/")) expect(c).not.toMatch(/\[/);
    }
  });
});
```

- [ ] **Step 2.2: Run tests — must fail**

```
npx vitest run src/__tests__/ollama-driver.test.ts
```

Expected: the catalog-probe and URL-encoding tests fail; the two daemon-down tests may pass trivially because the stub `listModels()` already returns `[]`.

- [ ] **Step 2.3: Implement `listModels()` and the catalog**

In `src/core/drivers/ollama.ts`, add at module level (above the class):

```typescript
const PREFLIGHT_TIMEOUT_MS = Number(process.env.OLLAMA_PREFLIGHT_TIMEOUT_MS) || 5000;

/**
 * Hardcoded list of cloud model ids prorab knows how to surface. Mirrors the
 * cloud catalog advertised by `ollama launch claude` upstream. Bump when new
 * cloud models ship; per-model probing in listModels() filters to whatever
 * the local daemon can actually serve, so false positives are auto-pruned.
 */
const OLLAMA_CLOUD_CATALOG: ReadonlyArray<string> = [
  "deepseek-v4-pro:cloud[1m]",
  "kimi-k2.6:cloud",
  "minimax-m2.7:cloud",
  "qwen3-coder:480b-cloud[1m]",
  "gpt-oss:120b-cloud",
];

function resolveBaseUrl(): string {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return "http://127.0.0.1:11434";
  if (raw.startsWith("/")) {
    throw new Error(
      `Unix-socket OLLAMA_HOST ('${raw}') is not supported. Use http://host:port or set TCP listening.`,
    );
  }
  if (/\s/.test(raw)) {
    throw new Error(`OLLAMA_HOST contains whitespace: '${raw}'`);
  }
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}
```

Replace the `listModels()` body in `OllamaDriver`:

```typescript
  async listModels(): Promise<ModelEntry[]> {
    let baseUrl: string;
    try {
      baseUrl = resolveBaseUrl();
    } catch {
      return [];
    }

    try {
      const v = await fetch(`${baseUrl}/api/version`, {
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      });
      if (!v.ok) return [];
    } catch {
      return [];
    }

    const checks = await Promise.all(
      OLLAMA_CLOUD_CATALOG.map(async (id) => {
        try {
          const r = await fetch(`${baseUrl}/v1/models/${encodeURIComponent(id)}`, {
            signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
          });
          return r.ok ? id : null;
        } catch {
          return null;
        }
      }),
    );
    return checks
      .filter((id): id is string => id !== null)
      .map((id) => ({ id, name: id }));
  }
```

- [ ] **Step 2.4: Run tests — all four should pass**

Expected: 5 passed total (1 from Task 1, 4 from this task).

- [ ] **Step 2.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): listModels via hardcoded catalog probed by /v1/models/<id>"
```

---

## Task 3: `listModels()` honors `OLLAMA_HOST` (characterization)

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`

These tests pin the `resolveBaseUrl()` behavior the implementation in Task 2 already has. Pure characterization — they should pass without further code changes.

- [ ] **Step 3.1: Add tests**

Add inside `describe("listModels()")`:

```typescript
it("uses OLLAMA_HOST (host:port form)", async () => {
  process.env.OLLAMA_HOST = "192.168.1.10:11434";
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;

  await new OllamaDriver().listModels();
  const versionCalls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.endsWith("/api/version"));
  expect(versionCalls[0]).toBe("http://192.168.1.10:11434/api/version");
});

it("uses OLLAMA_HOST (https URL form, kept verbatim)", async () => {
  process.env.OLLAMA_HOST = "https://my-ollama.example.com";
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;

  await new OllamaDriver().listModels();
  const versionCalls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.endsWith("/api/version"));
  expect(versionCalls[0]).toBe("https://my-ollama.example.com/api/version");
});

it("strips trailing slash from OLLAMA_HOST", async () => {
  process.env.OLLAMA_HOST = "http://127.0.0.1:11434/";
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;

  await new OllamaDriver().listModels();
  const versionCalls = (fetchMock as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.endsWith("/api/version"));
  // No double slash anywhere in the path.
  expect(versionCalls[0]).toBe("http://127.0.0.1:11434/api/version");
  for (const c of versionCalls) expect(c).not.toMatch(/[^:]\/\//);
});

it("returns [] (does not throw) when OLLAMA_HOST is unix-socket form", async () => {
  process.env.OLLAMA_HOST = "/var/run/ollama.sock";
  const models = await new OllamaDriver().listModels();
  expect(models).toEqual([]);
});

it("returns [] when OLLAMA_HOST contains internal whitespace", async () => {
  process.env.OLLAMA_HOST = "192.168.1.10 :11434";
  const models = await new OllamaDriver().listModels();
  expect(models).toEqual([]);
});
```

- [ ] **Step 3.2: Run tests — should pass**

Expected: 10 passed total.

- [ ] **Step 3.3: Commit**

```bash
git add src/__tests__/ollama-driver.test.ts
git commit -m "test(ollama): characterize OLLAMA_HOST normalization (host:port, URL, trailing slash, unix-socket, whitespace)"
```

---

## Task 4: `setup()` cloud-only guard

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 4.1: Write the failing test**

Add inside `describe("setup()")`:

```typescript
it("rejects non-cloud models", async () => {
  // No fetch mock needed — cloud guard runs before any HTTP call.
  globalThis.fetch = vi.fn();
  const driver = new OllamaDriver("llama3.2:3b");
  await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
    /supports only cloud models.*llama3\.2:3b/,
  );
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
```

- [ ] **Step 4.2: Run test — must fail**

The test fails because `setup()` currently throws "Not implemented yet" generically.

- [ ] **Step 4.3: Implement the guard**

In `src/core/drivers/ollama.ts`, update `setup()`:

```typescript
  async setup(_opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    if (!this.model.includes(":cloud")) {
      throw new Error(
        `Ollama agent supports only cloud models (id must contain ':cloud'); got '${this.model}'.`,
      );
    }
    throw new Error("Not implemented yet");
  }
```

- [ ] **Step 4.4: Run tests — must pass**

Expected: 11 passed.

- [ ] **Step 4.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): reject non-cloud models at setup()"
```

---

## Task 5: `setup()` preflight — daemon-not-reachable

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 5.1: Write the failing tests**

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

Expected: both new tests fail because `setup()` currently throws "Not implemented yet" after the cloud-guard.

- [ ] **Step 5.3: Implement daemon preflight**

In `src/core/drivers/ollama.ts`, replace the `setup()` body:

```typescript
  async setup(_opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    if (!this.model.includes(":cloud")) {
      throw new Error(
        `Ollama agent supports only cloud models (id must contain ':cloud'); got '${this.model}'.`,
      );
    }
    await this.preflightDaemon();
    throw new Error("Not implemented yet");
  }

  private async preflightDaemon(): Promise<void> {
    const baseUrl = resolveBaseUrl();
    let resp: Response;
    try {
      resp = await fetch(`${baseUrl}/api/version`, {
        signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
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

- [ ] **Step 5.4: Run tests — must pass**

Expected: 13 passed.

- [ ] **Step 5.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): preflight rejects when daemon not reachable"
```

---

## Task 6: `setup()` preflight — per-model GET disambiguates 404 vs transient

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

**Background:** Per design §Preflight, model-access is checked via `GET /v1/models/<id>` because the daemon's bulk `GET /v1/models` is local-manifest-only. Status disambiguation:
- `200` → accessible.
- `404` → not signed in for this model. Surface "Check 'ollama signin' status".
- `5xx` / network error / timeout → transient. Surface daemon-issue message; do NOT misdiagnose as auth.

- [ ] **Step 6.1: Write the failing tests**

Add inside `describe("setup()")`:

```typescript
it("throws 'not available / signin' when /v1/models/<id> returns 404", async () => {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    if (u.includes("/v1/models/")) return new Response(JSON.stringify({}), { status: 404 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
    /Model 'deepseek-v4-pro:cloud\[1m\]' is not available.*ollama signin/,
  );
});

it("throws 'transient daemon issue' when /v1/models/<id> returns 5xx", async () => {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    if (u.includes("/v1/models/")) return new Response("upstream gone", { status: 503 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
    /failed to verify model.*transiently overloaded|daemon at .* failed to verify/,
  );
});

it("throws 'transient daemon issue' when /v1/models/<id> fetch rejects", async () => {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    if (u.includes("/v1/models/")) throw new Error("ECONNRESET");
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;

  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(
    /failed to verify model/,
  );
});
```

- [ ] **Step 6.2: Run tests — must fail**

Expected: 3 new tests fail because `setup()` still throws "Not implemented yet" after `preflightDaemon`.

- [ ] **Step 6.3: Implement `preflightModel()`**

In `src/core/drivers/ollama.ts`, update `setup()`:

```typescript
  async setup(_opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    if (!this.model.includes(":cloud")) {
      throw new Error(
        `Ollama agent supports only cloud models (id must contain ':cloud'); got '${this.model}'.`,
      );
    }
    await this.preflightDaemon();
    await this.preflightModel();
    throw new Error("Not implemented yet");
  }

  private async preflightModel(): Promise<void> {
    const baseUrl = resolveBaseUrl();
    const url = `${baseUrl}/v1/models/${encodeURIComponent(this.model as string)}`;
    let resp: Response;
    try {
      resp = await fetch(url, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
    } catch (err) {
      throw new Error(
        `Ollama daemon at ${baseUrl} failed to verify model '${this.model}': ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `The daemon may be transiently overloaded; retry, or check 'ollama serve' logs.`,
      );
    }
    if (resp.status === 404) {
      const catalog = OLLAMA_CLOUD_CATALOG.join(", ");
      throw new Error(
        `Model '${this.model}' is not available via ollama. ` +
          `Check 'ollama signin' status, or pick from: ${catalog}`,
      );
    }
    if (!resp.ok) {
      throw new Error(
        `Ollama daemon at ${baseUrl} failed to verify model '${this.model}': ` +
          `HTTP ${resp.status}. The daemon may be transiently overloaded; retry, or check 'ollama serve' logs.`,
      );
    }
  }
```

- [ ] **Step 6.4: Run tests — must pass**

Expected: 16 passed.

- [ ] **Step 6.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): per-model preflight via /v1/models/<id> with 404/5xx disambiguation"
```

---

## Task 7: `setup()` builds env vars + variant strip + env merge

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

This task wires the inner `ClaudeDriver`, builds `sessionEnv` (with ANTHROPIC_*/CLAUDE_CODE_* hygiene), and updates `runSession` to (a) strip `opts.variant`, (b) merge our env on top of caller-provided `opts.env` rather than replacing it.

- [ ] **Step 7.1: Add a shared test helper**

Inside `describe("OllamaDriver", ...)` (after `afterEach`), add:

```typescript
function mockOllamaWith(modelId: string): void {
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    if (u.includes("/v1/models/")) {
      const id = decodeURIComponent(u.replace(/.*\/v1\/models\//, ""));
      return new Response(JSON.stringify({ id }), { status: id === modelId ? 200 : 404 });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}
```

- [ ] **Step 7.2: Write the failing tests**

Add inside `describe("setup()")`:

```typescript
it("builds session env with required Anthropic + Claude Code vars", async () => {
  mockOllamaWith("deepseek-v4-pro:cloud[1m]");
  const driver = new OllamaDriver("deepseek-v4-pro:cloud[1m]");
  await driver.setup({ verbosity: "info" });

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

it("strips parent ANTHROPIC_*/CLAUDE_CODE_* leakage", async () => {
  // Parent process has a real key set; it must NOT survive into the inner SDK env.
  process.env.ANTHROPIC_API_KEY = "sk-ant-real-parent-key";
  process.env.ANTHROPIC_RETRY = "9";
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "999";

  mockOllamaWith("kimi-k2.6:cloud");
  const driver = new OllamaDriver("kimi-k2.6:cloud");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  const env = innerInstance.runSession.mock.calls[0][0].env;

  expect(env.ANTHROPIC_API_KEY).toBe("");                  // stripped + re-set to ""
  expect(env.ANTHROPIC_RETRY).toBeUndefined();             // stripped, no override
  expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined(); // model has no [Nm]/[Nk] suffix → stripped, no re-set

  await driver.teardown();
});

it("strips opts.variant before delegating to inner ClaudeDriver", async () => {
  mockOllamaWith("kimi-k2.6:cloud");
  const driver = new OllamaDriver("kimi-k2.6:cloud");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
    variant: "high",                                        // must NOT reach inner
  } as any);
  const calledOpts = innerInstance.runSession.mock.calls[0][0];
  expect(calledOpts.variant).toBeUndefined();

  await driver.teardown();
});

it("merges caller opts.env with sessionEnv (caller wins for unmanaged keys)", async () => {
  mockOllamaWith("kimi-k2.6:cloud");
  const driver = new OllamaDriver("kimi-k2.6:cloud");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
    env: { CUSTOM_USER_VAR: "value-from-caller", ANTHROPIC_AUTH_TOKEN: "should-be-overridden" } as Record<string, string>,
  } as any);
  const env = innerInstance.runSession.mock.calls[0][0].env;
  expect(env.CUSTOM_USER_VAR).toBe("value-from-caller");          // caller key preserved
  expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");                 // our override wins

  await driver.teardown();
});
```

- [ ] **Step 7.3: Run tests — must fail**

`setup()` still throws "Not implemented yet" after preflight. The four new tests fail.

- [ ] **Step 7.4: Implement `buildEnv()`, complete `setup()`, wire `runSession`**

In `src/core/drivers/ollama.ts`:

Replace `setup()`:

```typescript
  async setup(opts: SetupOptions): Promise<void> {
    if (!this.model) {
      throw new Error("Ollama agent requires a model");
    }
    if (!this.model.includes(":cloud")) {
      throw new Error(
        `Ollama agent supports only cloud models (id must contain ':cloud'); got '${this.model}'.`,
      );
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
    const baseUrl = resolveBaseUrl();
    const model = this.model as string;
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    // Drop undefineds left behind by the spread on optional keys.
    for (const k of Object.keys(env)) {
      if (env[k] === undefined) delete env[k];
    }
    // Strip any ANTHROPIC_*/CLAUDE_CODE_* leaked from the parent process so a
    // stale ANTHROPIC_API_KEY (real Anthropic key) cannot reach the inner SDK.
    for (const k of Object.keys(env)) {
      if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_")) delete env[k];
    }

    env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = "ollama";        // sentinel; takes precedence over ANTHROPIC_API_KEY
    env.ANTHROPIC_API_KEY = "";                 // belt-and-suspenders: ensure no host key sneaks back via SDK defaults
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
    env.CLAUDE_CODE_SUBAGENT_MODEL = model;
    env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";   // matches `ollama launch claude` Run(); suppresses "Created by Claude Code" attribution
    return env;
  }
```

Replace `runSession()`:

```typescript
  runSession(opts: SessionOptions): Promise<IterationResult> {
    const driver = this.requireDriver();
    const { variant: _variant, env: callerEnv, ...rest } = opts as SessionOptions & { variant?: unknown };
    const mergedEnv = this.sessionEnv
      ? { ...(callerEnv ?? {}), ...this.sessionEnv }
      : callerEnv;
    return driver.runSession({ ...rest, env: mergedEnv } as SessionOptions);
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

Expected: 20 passed.

- [ ] **Step 7.6: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): build session env (with ANTHROPIC_*/CLAUDE_CODE_* hygiene), strip variant, merge caller env"
```

---

## Task 8: `setup()` env honors `OLLAMA_HOST` (characterization)

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`

These pin the host-resolution behavior the env builder already inherits from `resolveBaseUrl()`. Pure characterization.

- [ ] **Step 8.1: Add tests**

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
  expect(innerInstance.runSession.mock.calls[0][0].env.ANTHROPIC_BASE_URL).toBe("http://192.168.1.10:11434");

  await driver.teardown();
});

it("env ANTHROPIC_BASE_URL preserves OLLAMA_HOST URL form (no double slash)", async () => {
  process.env.OLLAMA_HOST = "https://my-ollama.example.com/";       // trailing slash
  mockOllamaWith("kimi-k2.6:cloud");
  const driver = new OllamaDriver("kimi-k2.6:cloud");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  expect(innerInstance.runSession.mock.calls[0][0].env.ANTHROPIC_BASE_URL).toBe("https://my-ollama.example.com");

  await driver.teardown();
});

it("setup() throws when OLLAMA_HOST is unix-socket form", async () => {
  process.env.OLLAMA_HOST = "/var/run/ollama.sock";
  globalThis.fetch = vi.fn();                                        // never reached
  const driver = new OllamaDriver("kimi-k2.6:cloud");
  await expect(driver.setup({ verbosity: "info" })).rejects.toThrow(/Unix-socket/);
});
```

- [ ] **Step 8.2: Run tests — should pass**

Expected: 23 passed.

- [ ] **Step 8.3: Commit**

```bash
git add src/__tests__/ollama-driver.test.ts
git commit -m "test(ollama): characterize OLLAMA_HOST handling in setup() env (host:port, URL with trailing slash, unix-socket reject)"
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

it("ignores decimal suffix [1.5m] (regex matches integers only)", async () => {
  // Custom mock: probe must match the exact id including the suffix.
  globalThis.fetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.23.1" }), { status: 200 });
    if (u.includes("/v1/models/")) {
      const id = decodeURIComponent(u.replace(/.*\/v1\/models\//, ""));
      return new Response(JSON.stringify({ id }), { status: id === "weird-model:cloud[1.5m]" ? 200 : 404 });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  const driver = new OllamaDriver("weird-model:cloud[1.5m]");
  await driver.setup({ verbosity: "info" });

  const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
  await driver.runSession({
    prompt: "hi", systemPrompt: "sys", cwd: "/tmp",
    maxTurns: 1, verbosity: "info", unitId: "u1",
  });
  expect(innerInstance.runSession.mock.calls[0][0].env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();

  await driver.teardown();
});
```

- [ ] **Step 9.2: Run tests — first two must fail (variable not set)**

Expected: 2 failures (the `[1m]` and `[200k]` cases). The "omits" + decimal cases pass because the env builder doesn't set the var yet.

- [ ] **Step 9.3: Implement `parseContextWindow()` and add to `buildEnv()`**

In `src/core/drivers/ollama.ts`, add a module-level helper above the class declaration:

```typescript
/**
 * Extract the context-window hint from a model id like
 * `deepseek-v4-pro:cloud[1m]` → 1_000_000, `foo:cloud[200k]` → 200_000.
 * Returns null if the model has no `[Nk]`/`[Nm]` suffix; the caller then
 * omits CLAUDE_CODE_AUTO_COMPACT_WINDOW and Claude Code uses its default.
 * Decimals (`[1.5m]`) and other units intentionally do not match.
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

Expected: 27 passed.

- [ ] **Step 9.5: Commit**

```bash
git add src/core/drivers/ollama.ts src/__tests__/ollama-driver.test.ts
git commit -m "feat(ollama): parse [Nk]/[Nm] suffix into CLAUDE_CODE_AUTO_COMPACT_WINDOW"
```

---

## Task 10: `startChat()` injects env, merges caller env, strips variant

**Files:**
- Modify: `src/__tests__/ollama-driver.test.ts`
- Modify: `src/core/drivers/ollama.ts`

- [ ] **Step 10.1: Write the failing tests**

Add inside `describe("OllamaDriver", ...)`:

```typescript
describe("startChat()", () => {
  it("forwards sessionEnv to the inner ClaudeDriver", async () => {
    mockOllamaWith("kimi-k2.6:cloud");
    const driver = new OllamaDriver("kimi-k2.6:cloud");
    await driver.setup({ verbosity: "info" });

    const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
    driver.startChat({ cwd: "/tmp", verbosity: "info" });

    expect(innerInstance.startChat).toHaveBeenCalledTimes(1);
    const calledOpts = innerInstance.startChat.mock.calls[0][0];
    expect(calledOpts.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(calledOpts.env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");

    await driver.teardown();
  });

  it("strips opts.variant before delegating", async () => {
    mockOllamaWith("kimi-k2.6:cloud");
    const driver = new OllamaDriver("kimi-k2.6:cloud");
    await driver.setup({ verbosity: "info" });

    const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
    driver.startChat({ cwd: "/tmp", verbosity: "info", variant: "high" } as any);

    expect(innerInstance.startChat.mock.calls[0][0].variant).toBeUndefined();

    await driver.teardown();
  });

  it("merges caller opts.env (caller wins for unmanaged keys)", async () => {
    mockOllamaWith("kimi-k2.6:cloud");
    const driver = new OllamaDriver("kimi-k2.6:cloud");
    await driver.setup({ verbosity: "info" });

    const innerInstance = vi.mocked(ClaudeDriver).mock.results[0].value;
    driver.startChat({
      cwd: "/tmp",
      verbosity: "info",
      env: { CUSTOM_USER_VAR: "x", ANTHROPIC_AUTH_TOKEN: "should-be-overridden" } as Record<string, string>,
    } as any);

    const env = innerInstance.startChat.mock.calls[0][0].env;
    expect(env.CUSTOM_USER_VAR).toBe("x");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("ollama");

    await driver.teardown();
  });
});
```

- [ ] **Step 10.2: Run tests — must fail**

`startChat()` still throws "Not implemented yet".

- [ ] **Step 10.3: Implement `startChat()` (delegation with env merge + variant strip)**

In `src/core/drivers/ollama.ts`, replace `startChat()`:

```typescript
  startChat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    const driver = this.requireDriver();
    const { variant: _variant, env: callerEnv, ...rest } = opts as ChatOptions & { variant?: unknown };
    const mergedEnv = this.sessionEnv
      ? { ...(callerEnv ?? {}), ...this.sessionEnv }
      : callerEnv;
    return driver.startChat({ ...rest, env: mergedEnv } as ChatOptions);
  }
```

- [ ] **Step 10.4: Run tests — must pass**

Expected: 30 passed.

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

Expected: 32 passed.

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

Expected: 33 passed.

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

Expected: full suite passes (existing tests + ~33 new OllamaDriver tests). `Reviewer` (built from `AgentTypeSchema`) now accepts `"ollama"` automatically — no separate edit needed.

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

## Task 15: UI dropdown — add `Ollama` to all four agent lists + extend "No user settings" gate

**Files:**
- Modify: `ui/src/components/AgentWizard.vue`
- Modify: `ui/src/views/TaskListView.vue`
- Modify: `ui/src/views/TaskDetailView.vue`
- Modify: `ui/src/views/ExecutionView.vue`

Each file contains a literal array of agent options. Insert the new entry after the existing `Codex` line (last in the list) so ordering stays consistent.

- [ ] **Step 15.1: Modify `ui/src/components/AgentWizard.vue`**

(a) Around line 219, extend the agent options:

```typescript
  { label: "Claude", value: "claude" },
  { label: "OpenCode", value: "opencode" },
  { label: "CCS", value: "ccs" },
  { label: "Codex", value: "codex" },
  { label: "Ollama", value: "ollama" },
```

(b) Find the "No user settings" checkbox `v-if`. In the wizard it is gated by `agent === 'claude' || agent === 'ccs'`. Extend to include ollama (because `OllamaDriver(model, useUserSettings)` accepts the flag):

```html
<Checkbox v-if="agent === 'claude' || agent === 'ccs' || agent === 'ollama'" v-model="useUserSettings" ... />
```

(c) Verify, **but do not modify**, the variant/effort plumbing. Two places use agent-keyed labels:

- Around line 129: `return step.agent === "claude" || step.agent === "ccs" ? "Effort" : "Variant";` — picks the visible label only. For ollama it falls into the `"Variant"` branch; harmless because step (b) below ensures the input is hidden.
- Around line 483: `<label>{{ agent === 'claude' || agent === 'ccs' ? 'Effort' : 'Variant' }}</label>` — same logic.

The actual visibility is gated by `v-if="variantOptions.length > 0"` on the dropdown itself. `OllamaDriver.listModels()` returns `ModelEntry`s with no `variants` field, so `computeVariantOptions` returns `[]` and the dropdown is hidden. This is the intended behavior per spec §Goals: the dropdown is **hidden, not disabled**. Driver-side, `runSession()`/`startChat()` already strip `opts.variant` (Task 7 / Task 10) so any stale persisted value can't reach the SDK. Do not add an ollama-specific `v-if` here unless a test fails.

- [ ] **Step 15.2: Modify `ui/src/views/TaskListView.vue` (line ~134)**

Find the same array (`{ label: "Claude", value: "claude" }, ...`) and append `{ label: "Ollama", value: "ollama" },` as the last entry.

- [ ] **Step 15.3: Modify `ui/src/views/TaskDetailView.vue` (line ~207)**

Same change as above.

- [ ] **Step 15.4: Modify `ui/src/views/ExecutionView.vue` (line ~180)**

Same change as above.

- [ ] **Step 15.5: Run UI build to ensure the SFC compiles**

```
npm run build:ui
```

Expected: Vite build succeeds.

(Note: `vue-tsc` is **not** in `ui/package.json`. The CLAUDE.md mention of `npx vue-tsc --noEmit --project ui/tsconfig.json` is aspirational — running it on a clean machine fails with "missing packages: vue-tsc". Type-checking Vue SFCs is out of scope for this task; rely on Vite for syntax validation.)

- [ ] **Step 15.6: Commit**

```bash
git add ui/src/components/AgentWizard.vue ui/src/views/TaskListView.vue ui/src/views/TaskDetailView.vue ui/src/views/ExecutionView.vue
git commit -m "feat(ollama): add Ollama option to UI agent dropdowns and extend useUserSettings gate"
```

---

## Task 16: Update `/api/models` server route

**Files:**
- Modify: `src/server/routes/models.ts`

The route currently calls `setup()` for every agent except `ccs`/`codex` and lifetime-caches non-`ccs` results. For `ollama` this would (a) fail because `setup()` requires a model the route does not pass, and (b) cache the empty list across daemon-state changes (signin / signout / daemon restart). Both must be fixed before the UI dropdown can work.

- [ ] **Step 16.1: Extend the `needsSetup` exemption to `"ollama"`**

In `src/server/routes/models.ts` (around line 41-43):

```typescript
      // CCS listModels() is a pure file scan — no setup/teardown needed
      // Codex listModels() reads ~/.codex/models_cache.json — no setup/teardown needed
      // Ollama listModels() probes the local daemon directly — no setup/teardown needed (and setup() requires a model)
      const needsSetup = agent !== "ccs" && agent !== "codex" && agent !== "ollama";
```

- [ ] **Step 16.2: Skip caching for `ollama` (mirror `ccs` semantics)**

In the same file, change the cache-check guard so `ollama` always re-probes the daemon:

```typescript
      // CCS: pure file scan — re-scan on every request.
      // Ollama: per-request probe of /v1/models/<id> — re-probe so signin/signout becomes visible.
      if (agent !== "ccs" && agent !== "ollama") {
        const cached = cache.get(agent);
        if (cached) {
          const models = await cached;
          return { models };
        }
      }
```

And the cache-write block:

```typescript
      if (agent !== "ccs" && agent !== "ollama") {
        cache.set(agent, promise);
      }
```

```typescript
        if (agent !== "ccs" && agent !== "ollama") {
          // Codex: do not cache empty results — CLI may not be running yet (no ~/.codex/models_cache.json)
          if (agent === "codex" && models.length === 0) {
            cache.delete(agent);
          } else {
            cache.set(agent, models);
          }
        }
```

- [ ] **Step 16.3: Run the full suite to confirm nothing else broke**

```
npm test
```

Expected: full suite passes (existing tests still green; no new tests added for the route — covered by manual verification in Task 18).

- [ ] **Step 16.4: Commit**

```bash
git add src/server/routes/models.ts
git commit -m "feat(ollama): /api/models route skips setup() and cache for ollama"
```

---

## Task 17: Documentation

**Files:**
- Modify: `.claude/rules/drivers.md`
- Modify: `.claude/rules/frontend.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 17.1: Append `OllamaDriver` section to `.claude/rules/drivers.md`**

Add after the `CodexDriver` section:

```markdown
## OllamaDriver

Standalone driver wrapping `ClaudeDriver` via composition (same pattern as `CcsDriver`). Routes the Claude Agent SDK at the local Ollama daemon (`http://127.0.0.1:11434` by default; `OLLAMA_HOST` overrides — host:port gets `http://` prepended, full URL kept verbatim with trailing slash stripped, unix-socket / whitespace forms rejected). Lets prorab use Ollama-cloud models like `deepseek-v4-pro:cloud[1m]` and `kimi-k2.6:cloud` without depending on a CCS proxy.

**Setup**:
- Reject non-cloud models (id must contain `:cloud`).
- Probe `/api/version` (daemon up?) within `OLLAMA_PREFLIGHT_TIMEOUT_MS` (default 5s).
- Probe `GET /v1/models/<id>` for the requested model: 200 → accessible, 404 → "check ollama signin", 5xx/timeout/network → distinct "transient daemon" error (not auth misdiagnosis).
- The bulk `GET /v1/models` is intentionally NOT used — on Ollama 0.23.1 it returns `{"data":null}` even for signed-in cloud profiles.

**Catalog**: `listModels()` returns the intersection of a hardcoded `OLLAMA_CLOUD_CATALOG` (mirroring `cmd/launch/claude.go` upstream) and the per-model 200-OK probes. No `variants` field — UI hides the effort dropdown.

**Per-session env** (closely mirrors `ollama launch claude --model <name>`, with one intentional divergence — see below):

- `ANTHROPIC_BASE_URL=<resolved daemon URL>`
- `ANTHROPIC_AUTH_TOKEN=ollama` (sentinel — daemon recognizes it; takes precedence over ANTHROPIC_API_KEY in upstream `claude`)
- `ANTHROPIC_API_KEY=""` (belt-and-suspenders: prevents host-env keys from sneaking in via SDK defaults)
- `ANTHROPIC_DEFAULT_OPUS_MODEL`/`SONNET_MODEL`/`HAIKU_MODEL` = chosen model
- `CLAUDE_CODE_SUBAGENT_MODEL` = chosen model
- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`
- `CLAUDE_CODE_AUTO_COMPACT_WINDOW` = parsed from `[Nm]/[Nk]` suffix in the model id; omitted when no suffix. **Intentional divergence** from upstream's `lookupCloudModelLimit()`: simpler and avoids drift in a hardcoded model→context map.

**Env hygiene**: before applying overrides, all `ANTHROPIC_*`/`CLAUDE_CODE_*` keys leaking from the parent process are stripped. Other env (PATH, HOME, language, proxies, etc.) is preserved.

**Variant**: `runSession()`/`startChat()` strip `opts.variant` before delegating. Cloud non-Claude models do not honor Claude's `effort` knob; persisted CLI/UI variants would otherwise leak through.

**Auth**: relies entirely on the user's `ollama signin` (Ed25519 key in `~/.ollama/id_ed25519`). prorab never reads upstream tokens or signs requests itself; the daemon does.

**Mid-session failures**: signout / daemon crash / cloud-revoke during a session surface as a `signal:error` from the SDK. `run.ts` stops the iteration; the task remains `in-progress` for resumption. We deliberately do not re-run preflight mid-session.
```

- [ ] **Step 17.2: Update `.claude/rules/frontend.md`**

In the agent dropdown / store description, add `ollama` alongside the other agent values. Keep the order Claude → OpenCode → CCS → Codex → Ollama.

- [ ] **Step 17.3: Update `CLAUDE.md`**

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

- [ ] **Step 17.4: Update `README.md`**

The README mentions the supported agents in four places (around lines 14, 73, 85, 120). Add `Ollama` to each:

- L14: `Multi-agent — Claude, OpenCode, CCS, Codex, Ollama — different models for different stages`
- L73: `Multi-agent support: Claude, OpenCode, CCS, Codex, Ollama`
- L85 area: add a bullet under the agent backends list — `Ollama` (relies on the local `ollama serve` daemon and `ollama signin` for cloud models)
- L120 area (CLI flags table): update the `--agent <type>` row to `Agent backend: claude, opencode, ccs, codex, ollama`

- [ ] **Step 17.5: Commit**

```bash
git add .claude/rules/drivers.md .claude/rules/frontend.md CLAUDE.md README.md
git commit -m "docs(ollama): document OllamaDriver in drivers.md, frontend.md, CLAUDE.md, README.md"
```

---

## Task 18: End-to-end manual verification

**Files:** none (manual session, no edits — this task confirms the implementation works against a real daemon).

- [ ] **Step 18.1: Confirm prerequisites**

```
ollama --version
curl -s http://127.0.0.1:11434/api/version
ls ~/.ollama/id_ed25519
```

Expected: ollama installed, daemon running (otherwise `ollama serve` in another terminal), Ed25519 key file present (created on first daemon start; signin already done if cloud models work in `ollama launch claude`).

- [ ] **Step 18.2: Run prorab serve and check the UI**

```
npm run build && node dist/index.js serve
```

Open the printed `http://127.0.0.1:<port>` URL. In the agent dropdown choose **Ollama**. The model dropdown should populate with the cloud models from `OLLAMA_CLOUD_CATALOG` that the daemon serves (probed via `/v1/models/<id>`). Pick `deepseek-v4-pro:cloud[1m]`. Run a small task. Verify you see normal Claude Code SDK output (not 401).

- [ ] **Step 18.3: Confirm fail modes**

(a) **Daemon down.** Stop the daemon (`pkill ollama`). Re-run a task → `setup()` should fail with:
> `Ollama daemon is not reachable at http://127.0.0.1:11434. Start it with: ollama serve`

(b) **Signed-out / model unavailable.** Restart the daemon. Run `ollama signout`. Re-run a task → `setup()` should fail with:
> `Model '<m>' is not available via ollama. Check 'ollama signin' status, or pick from: <catalog>`

(c) **Non-cloud model rejected.** Try `--model llama3.2:3b` → `setup()` rejects with:
> `Ollama agent supports only cloud models (id must contain ':cloud'); got 'llama3.2:3b'.`

(d) **Bad OLLAMA_HOST.** `OLLAMA_HOST=/var/run/ollama.sock node dist/index.js run --agent ollama --model kimi-k2.6:cloud` → throws `Unix-socket OLLAMA_HOST ...`.

`ollama signin` again to restore.

- [ ] **Step 18.4: Document the verification outcome**

Record "verified on 2026-05-06 against ollama 0.23.1 with deepseek-v4-pro:cloud[1m]" in the PR description. If running headless / in CI where this task cannot execute, note "manual verification skipped — no daemon" in the PR description and call this out for human follow-up.

- [ ] **Step 18.5: No commit** (this task is a manual smoke test).

---

## Pre-PR Cleanup

Per `/home/zinin/.claude/CLAUDE.md`, design and plan documents under `docs/superpowers/` must NOT appear in the PR diff. Before opening the PR, remove **all** ollama-driver artifacts under `docs/superpowers/`:

```bash
git rm \
  docs/superpowers/specs/2026-05-06-ollama-agent-design.md \
  docs/superpowers/specs/2026-05-06-ollama-agent-review-merged-iter-*.md \
  docs/superpowers/specs/2026-05-06-ollama-agent-review-iter-*.md \
  docs/superpowers/plans/2026-05-06-ollama-driver.md \
  docs/superpowers/plans/2026-05-06-ollama-driver-execution-prompt.md \
  2>/dev/null || true
git commit -m "chore: drop ollama-driver design + plan + review docs before PR"
```

The documents stay accessible via the branch's git history if needed later.

---

## Self-Review Checklist (run at end of implementation)

- [ ] All 13 design test groups have a corresponding plan task: skeleton (Task 1), catalog probe + URL encoding (Task 2), `OLLAMA_HOST` characterization (Tasks 3 + 8), cloud-only guard (Task 4), daemon preflight (Task 5), per-model 404/5xx disambiguation (Task 6), env contents + hygiene + variant strip + env merge (Task 7), `AUTO_COMPACT_WINDOW` incl. decimal reject (Task 9), startChat env+merge+strip (Task 10), chat delegation + `not initialized` guard (Task 11), teardown (Task 12). ✓
- [ ] CRIT findings from review iter-1 are addressed:
  - CRIT-1 (`/api/models` route) → Task 16. ✓
  - CRIT-2 (`/v1/models` data:null) → hardcoded catalog + per-model probe in Tasks 2 + 6. ✓
  - CRIT-3 (cloud-only + variant leak) → Tasks 4 + 7 + 10. ✓
  - CRIT-4 (OLLAMA_HOST normalization) → Tasks 2 + 3 + 8. ✓
  - CRIT-5 (env hygiene) → Task 7. ✓
  - CRIT-6 (network mis-diagnosed as auth) → Task 6 disambiguation. ✓
  - CRIT-7 (5s timeout configurable) → `PREFLIGHT_TIMEOUT_MS` constant in Task 2 + `OLLAMA_PREFLIGHT_TIMEOUT_MS` env in design. ✓
- [ ] Type names match across tasks: `OllamaDriver`, `AgentDriver`, `SessionOptions`, `ChatOptions`, `ModelEntry`, `IterationResult`, `AgentTypeSchema`, `ClaudeDriver`. ✓
- [ ] No "TBD"/"TODO"/"similar to Task N" placeholders in any code block. ✓
- [ ] Every step that changes code shows the actual code or exact diff. ✓
- [ ] Commit messages are scoped (`feat(ollama)`, `test(ollama)`, `docs(ollama)`, `chore`). ✓
- [ ] Pre-PR cleanup removes design + plan + review iter + execution-prompt docs from `docs/superpowers/`. ✓
- [ ] No `vue-tsc` invocation (not installed in `ui/package.json`); UI verification runs through `npm run build:ui` only. ✓
