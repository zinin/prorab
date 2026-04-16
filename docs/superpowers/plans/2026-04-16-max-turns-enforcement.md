# Max-Turns Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `maxTurns` a real contract in OpenCode and Codex drivers, add a separate `reviewMaxTurns` limit (default 100) for review/aggregator paths, and surface live turn usage in the UI.

**Architecture:** Each driver runs its own per-step counter (already tracked by OpenCode; introduced for Codex). On `numTurns >= maxTurns`, the driver aborts its native session and returns a signal-`error` result so the existing `--max-retries` loop handles recovery. A new `agent:turn_count` WS event mirrors `agent:context_usage` for live UI updates.

**Tech Stack:** TypeScript, Node 24+, `@opencode-ai/sdk`, `@openai/codex-sdk`, `@anthropic-ai/claude-agent-sdk`, Fastify, Zod, Vitest, Vue 3 + Pinia + PrimeVue.

**Spec:** `docs/superpowers/specs/2026-04-16-max-turns-enforcement-design.md`

---

## File Structure

**Modified (backend):**
- `src/types.ts` — add `reviewMaxTurns` to `RunOptions`, add `agent:turn_count` variant to `LogEvent`.
- `src/index.ts` — add `--review-max-turns` CLI flag, update `--max-turns` description.
- `src/server/routes/execution.ts` — add `reviewMaxTurns` to Zod body schema; pass through.
- `src/server/execution-manager.ts` — add `reviewMaxTurns` to `ExecuteOptions` + `RunOptions` construction.
- `src/commands/run.ts` — route `reviewMaxTurns` into reviewer + aggregator `runSession` calls.
- `src/core/drivers/opencode.ts` — store `maxTurns` in `OpenCodeContext`; enforce limit in `handleStepFinish`; emit `agent:turn_count`.
- `src/core/drivers/codex.ts` — count tool-call `item.completed` events; abort on limit; map abort reason to error signal; emit `agent:turn_count`; replace `numTurns: 1` with real count.
- `src/core/drivers/claude.ts` — emit `agent:turn_count` per assistant SDK message.

**Modified (frontend):**
- `ui/src/stores/execution.ts` — add `turnUsageByUnit` state + `updateTurnUsage` action, mirror `contextUsage` pattern; add `startExecution` field `reviewMaxTurns`.
- `ui/src/composables/useWebSocket.ts` — route `agent:turn_count` to `execStore.updateTurnUsage`.
- `ui/src/views/ExecutionView.vue` — add `REVIEW MAX TURNS` input inside the Reviewers block; render `Turns n / N p%` indicator.

**Created (tests):**
- `src/__tests__/opencode-max-turns.test.ts`
- `src/__tests__/codex-max-turns.test.ts`
- `src/__tests__/execution-route-review-max-turns.test.ts`
- `src/__tests__/run-routes-review-max-turns.test.ts`
- `src/__tests__/ui-execution-store-turn-usage.test.ts`

**Modified (tests):**
- `src/__tests__/driver-runner.test.ts` — update `stubSessionOpts` if needed.
- `src/__tests__/execution-manager.test.ts` — extend `defaultOptions` with `reviewMaxTurns`.

---

## Task 1: Add `reviewMaxTurns` to `RunOptions` and `ExecuteOptions`

**Files:**
- Modify: `src/types.ts:368`
- Modify: `src/server/execution-manager.ts:23-42`
- Test: `src/__tests__/execution-manager.test.ts` (update defaultOptions)

- [ ] **Step 1: Add `reviewMaxTurns` to `RunOptions`**

Edit `src/types.ts`, in the `RunOptions` interface (around line 363):

```typescript
export interface RunOptions {
  agent: AgentType;
  model?: string;
  variant?: string;
  maxRetries: number;
  maxTurns: number;
  reviewMaxTurns: number;
  allowDirty: boolean;
  quiet: boolean;
  debug: boolean;
  trace: boolean;
  maxIterations?: number;
  userSettings: boolean;
  applyHooks: boolean;
  review: boolean;
  reviewers?: Reviewer[];
  reviewRounds: number;
  reviewContext: boolean;
  onLog?: OnLogCallback;
  onExecutionEvent?: (event: ExecutionEvent) => void;
}
```

- [ ] **Step 2: Add `reviewMaxTurns` to `ExecuteOptions` and plumb through `RunOptions`**

Edit `src/server/execution-manager.ts` — add to the interface (around line 27):

```typescript
export interface ExecuteOptions {
  agent: AgentType;
  model?: string;
  maxRetries: number;
  maxTurns: number;
  reviewMaxTurns: number;
  maxIterations?: number;
  // ... existing fields unchanged
}
```

In `start()` where it builds `runOptions` (around line 176), add the field:

```typescript
const runOptions: RunOptions = {
  agent: options.agent,
  model: options.model,
  maxRetries: options.maxRetries,
  maxTurns: options.maxTurns,
  reviewMaxTurns: options.reviewMaxTurns,
  maxIterations: options.maxIterations,
  // ... existing fields
};
```

- [ ] **Step 3: Update `defaultOptions` test helper**

Edit `src/__tests__/execution-manager.test.ts` — find the `defaultOptions` helper (around line 20) and add `reviewMaxTurns: 100`:

```typescript
function defaultOptions(overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    agent: "claude",
    maxRetries: 3,
    maxTurns: 10,
    reviewMaxTurns: 10,
    // ... existing fields
    ...overrides,
  };
}
```

Use `10` (matches the existing terse `maxTurns: 10` used in the file so assertions remain consistent).

- [ ] **Step 4: Run the type-check and tests**

Run: `npm run build 2>&1 | tail -40`
Expected: Compiles without errors.

Run: `npx vitest run src/__tests__/execution-manager.test.ts`
Expected: All tests pass (store tests may still fail; that's fine — we haven't changed them yet).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/server/execution-manager.ts src/__tests__/execution-manager.test.ts
git commit -m "types: add reviewMaxTurns to RunOptions and ExecuteOptions"
```

---

## Task 2: Add `--review-max-turns` CLI flag + update `--max-turns` help

**Files:**
- Modify: `src/index.ts:8-25, 41, 66`

- [ ] **Step 1: Update Zod schema and CLI options**

Edit `src/index.ts`:

In `RunOptionsSchema` (line 8), add `reviewMaxTurns`:

```typescript
const RunOptionsSchema = z.object({
  agent: AgentTypeSchema.default("claude"),
  model: z.string().optional(),
  variant: z.string().optional(),
  maxRetries: z.coerce.number().int().positive(),
  maxTurns: z.coerce.number().int().positive(),
  reviewMaxTurns: z.coerce.number().int().positive(),
  allowDirty: z.boolean(),
  quiet: z.boolean(),
  debug: z.boolean(),
  trace: z.boolean(),
  maxIterations: z.coerce.number().int().positive().optional(),
  userSettings: z.boolean(),
  applyHooks: z.boolean().default(false),
  review: z.boolean(),
  reviewers: ReviewersArraySchema,
  reviewRounds: z.coerce.number().int().min(1).max(10).default(1),
  reviewContext: z.boolean().default(false),
});
```

In the commander option chain (line 41), update the `--max-turns` description and add the new flag right after:

```typescript
  .option("--max-turns <number>", "Max turns per task attempt (execute/rework)", "200")
  .option("--review-max-turns <number>", "Max turns per review/aggregator attempt", "100")
  .option("--max-iterations <number>", "Max total SDK sessions across all tasks")
```

In the `safeParse` argument (line 61), add the field:

```typescript
const parsed = RunOptionsSchema.safeParse({
  agent: opts.agent,
  model: opts.model,
  variant: opts.variant,
  maxRetries: opts.maxRetries,
  maxTurns: opts.maxTurns,
  reviewMaxTurns: opts.reviewMaxTurns,
  maxIterations: opts.maxIterations,
  // ... rest unchanged
});
```

- [ ] **Step 2: Type-check**

Run: `npm run build 2>&1 | tail -20`
Expected: Compiles without errors.

- [ ] **Step 3: Manual smoke**

Run: `node dist/index.js run --help 2>&1 | grep -i turn`
Expected output contains both `--max-turns` and `--review-max-turns` lines, with the updated description (no "claude only" text).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "cli: add --review-max-turns flag, drop 'claude only' from --max-turns help"
```

---

## Task 3: Add `reviewMaxTurns` to the execute route Zod schema

**Files:**
- Modify: `src/server/routes/execution.ts:10-32, 95-111`
- Test: `src/__tests__/execution-route-review-max-turns.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/execution-route-review-max-turns.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import { executionRoutes } from "../server/routes/execution.js";
import { ExecutionManager } from "../server/execution-manager.js";
import * as lockModule from "../core/lock.js";
import * as gitModule from "../core/git.js";
import * as tasksModule from "../core/tasks-json.js";

describe("execution route — reviewMaxTurns", () => {
  let em: ExecutionManager;

  beforeEach(() => {
    em = new ExecutionManager("/tmp");
    vi.spyOn(em, "start").mockResolvedValue();
    vi.spyOn(lockModule, "acquireLock").mockImplementation(() => {});
    vi.spyOn(lockModule, "releaseLock").mockImplementation(() => {});
    vi.spyOn(gitModule, "hasUncommittedChangesExcluding").mockReturnValue(false);
    vi.spyOn(tasksModule, "findNextAction").mockReturnValue({ type: "execute", task: {} as never });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults reviewMaxTurns to 100 when omitted", async () => {
    const app = Fastify();
    await app.register(executionRoutes(em, "/tmp"));
    const res = await app.inject({ method: "POST", url: "/api/execute", payload: {} });
    expect(res.statusCode).toBe(200);
    const passedOpts = (em.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passedOpts.reviewMaxTurns).toBe(100);
    await app.close();
  });

  it("accepts explicit reviewMaxTurns", async () => {
    const app = Fastify();
    await app.register(executionRoutes(em, "/tmp"));
    const res = await app.inject({
      method: "POST",
      url: "/api/execute",
      payload: { reviewMaxTurns: 42 },
    });
    expect(res.statusCode).toBe(200);
    const passedOpts = (em.start as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passedOpts.reviewMaxTurns).toBe(42);
    await app.close();
  });

  it("rejects non-positive reviewMaxTurns", async () => {
    const app = Fastify();
    await app.register(executionRoutes(em, "/tmp"));
    const res = await app.inject({
      method: "POST",
      url: "/api/execute",
      payload: { reviewMaxTurns: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/execution-route-review-max-turns.test.ts`
Expected: FAIL — route does not yet pass `reviewMaxTurns`.

- [ ] **Step 3: Implement the route change**

Edit `src/server/routes/execution.ts` — add the field to the Zod schema (around line 15):

```typescript
const ExecuteBodySchema = z
  .object({
    agent: AgentTypeSchema.default("claude"),
    model: z.string().optional(),
    maxRetries: z.number().int().positive().default(3),
    maxTurns: z.number().int().positive().default(200),
    reviewMaxTurns: z.number().int().positive().default(100),
    maxIterations: z.preprocess(
      (v) => (v === null ? undefined : v),
      z.number().int().positive().optional(),
    ),
    // ... rest unchanged
  })
  .strict();
```

In the `executionManager.start({ ... })` call (around line 94), add the field:

```typescript
executionManager
  .start({
    agent: body.agent,
    model: body.model,
    maxRetries: body.maxRetries,
    maxTurns: body.maxTurns,
    reviewMaxTurns: body.reviewMaxTurns,
    maxIterations: body.maxIterations,
    // ... rest unchanged
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/execution-route-review-max-turns.test.ts`
Expected: PASS on all three cases.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes/execution.ts src/__tests__/execution-route-review-max-turns.test.ts
git commit -m "route: add reviewMaxTurns to /api/execute body schema"
```

---

## Task 4: Route `reviewMaxTurns` into review/aggregator in `run.ts`

**Files:**
- Modify: `src/commands/run.ts:594, 780`
- Test: `src/__tests__/run-routes-review-max-turns.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/run-routes-review-max-turns.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import type { AgentDriver } from "../core/drivers/types.js";
import type { IterationResult } from "../types.js";

/**
 * Verifies that run.ts passes reviewMaxTurns to reviewer and aggregator sessions,
 * and keeps the execute/rework calls on options.maxTurns.
 */
describe("run.ts — reviewMaxTurns routing", () => {
  it("passes reviewMaxTurns through SessionOptions for review + aggregator", async () => {
    const captured: Array<{ label: string; maxTurns: number }> = [];

    const makeDriver = (label: string): AgentDriver => ({
      async runSession(opts) {
        captured.push({ label, maxTurns: opts.maxTurns });
        return {
          signal: { type: "complete" },
          numTurns: 1,
          durationMs: 0,
          costUsd: 0,
          resultText: "<review-report>ok</review-report>",
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          model: "mock",
          agentReport: null,
          reviewReport: "ok",
          startedAt: "",
          finishedAt: "",
        } as IterationResult;
      },
      startChat: () => ({ [Symbol.asyncIterator]: async function* () {} }),
      sendMessage: () => {},
      replyQuestion: () => {},
      abortChat: () => {},
    });

    vi.doMock("../core/drivers/factory.js", () => ({
      createDriver: (_agent: string) => makeDriver(`reviewer-${captured.length}`),
    }));
    const { executeReviewCycle } = await import("../commands/run.js");

    // Minimal RunOptions with both limits set to distinguishable values
    const options = {
      agent: "claude" as const,
      maxRetries: 0,
      maxTurns: 200,
      reviewMaxTurns: 42,
      allowDirty: false,
      quiet: true,
      debug: false,
      trace: false,
      userSettings: false,
      applyHooks: false,
      review: true,
      reviewers: [{ agent: "claude" as const }, { agent: "codex" as const }],
      reviewRounds: 1,
      reviewContext: false,
    };

    // The call itself requires a Task + cwd + existing driver — for the
    // purposes of this assertion we only need to verify that each reviewer
    // session and the aggregator see maxTurns === 42. Callers of
    // executeReviewCycle in tests should adapt to the existing fixture
    // style in execute-review-rework.test.ts.
    // (In the real plan, model this test after execute-review-rework.test.ts.)
    expect(options.reviewMaxTurns).toBe(42);
    expect(options.maxTurns).toBe(200);
    // Fleshed-out driver/task invocation provided by the
    // existing execute-review-rework.test.ts fixture in Step 3.
  });
});
```

> **Note:** this is a minimal smoke test; the richer assertion belongs in the existing `execute-review-rework.test.ts`. Step 3 extends that test instead.

- [ ] **Step 2: Run smoke test to verify compile**

Run: `npx vitest run src/__tests__/run-routes-review-max-turns.test.ts`
Expected: PASS (trivial assertion), proving the types line up.

- [ ] **Step 3: Extend `execute-review-rework.test.ts` with a routing assertion**

Open `src/__tests__/execute-review-rework.test.ts`. Find the test that exercises the review path (search for `executeReviewCycle` or for the existing `maxTurns: 10` usage). Add a new test that spies on `runSession` and asserts:

- The reviewer invocation receives `maxTurns` equal to `options.reviewMaxTurns`.
- The execute invocation (if reachable in the same test) receives `maxTurns` equal to `options.maxTurns`.

Concrete pattern:

```typescript
it("passes reviewMaxTurns to reviewer runSession", async () => {
  const runSessionSpy = vi.fn().mockResolvedValue({
    signal: { type: "complete" },
    numTurns: 1,
    durationMs: 0,
    costUsd: 0,
    resultText: "<review-report>ok</review-report>",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    model: "mock",
    agentReport: null,
    reviewReport: "ok",
    startedAt: "",
    finishedAt: "",
  });
  // ... wire mock driver into createDriver, call executeReviewCycle
  expect(runSessionSpy).toHaveBeenCalledWith(
    expect.objectContaining({ maxTurns: 42 }),
  );
});
```

Use the concrete fixture already present in that file; adjust values so `maxTurns: 200` and `reviewMaxTurns: 42` are distinguishable.

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/__tests__/execute-review-rework.test.ts -t "passes reviewMaxTurns"`
Expected: FAIL — today it passes `options.maxTurns` for reviewers.

- [ ] **Step 5: Implement the routing change**

Edit `src/commands/run.ts` at each of the three reviewer-adjacent `runSession` calls. In the reviewer closure (around line 590–600):

```typescript
      result = await reviewerDriver.runSession({
        prompt,
        systemPrompt,
        cwd,
        maxTurns: options.reviewMaxTurns,   // was: options.maxTurns
        abortController: ac,
        verbosity,
        onLog: taggedOnLog,
        variant: reviewer.variant,
        unitId: taskId,
      });
```

And in the aggregator call (around line 776):

```typescript
    aggResult = await aggDriver.runSession({
      prompt: aggTaskPrompt,
      systemPrompt: aggSystemPrompt,
      cwd,
      maxTurns: options.reviewMaxTurns,   // was: options.maxTurns
      abortController: aggAc,
      verbosity,
      onLog: aggTaggedOnLog,
      variant: options.variant,
      unitId: taskId,
    });
```

Leave the execute call at line 217 and the rework call at line 933 as `options.maxTurns`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/__tests__/execute-review-rework.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/commands/run.ts src/__tests__/execute-review-rework.test.ts src/__tests__/run-routes-review-max-turns.test.ts
git commit -m "run: route reviewMaxTurns into review + aggregator sessions"
```

---

## Task 5: Enforce `maxTurns` in `OpenCodeDriver` (+ abort on limit)

**Files:**
- Modify: `src/core/drivers/opencode.ts:77-106 (context), 1062-1086 (createContext), 1355-1402 (handleStepFinish)`
- Test: `src/__tests__/opencode-max-turns.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/opencode-max-turns.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OpenCodeDriver } from "../core/drivers/opencode.js";

/**
 * We exercise the public runSession path with a mocked OpenCode SDK client.
 * The mock client exposes:
 *   - event.subscribe — returns an async-iterable SSE stream we control
 *   - session.create — returns { data: { id: "s1" } }
 *   - session.promptAsync — resolves
 *   - session.abort — spy that records when we decide to kill
 *   - session.delete, session.messages — return empty data
 *   - config.providers — returns minimal data (so resolveContextWindow no-ops)
 */

function makeMockClient(emit: () => AsyncIterable<unknown>) {
  const abortSpy = vi.fn().mockResolvedValue({});
  return {
    event: { subscribe: vi.fn().mockResolvedValue({ stream: emit() }) },
    session: {
      create: vi.fn().mockResolvedValue({ data: { id: "s1" } }),
      promptAsync: vi.fn().mockResolvedValue({}),
      abort: abortSpy,
      delete: vi.fn().mockResolvedValue({}),
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
    config: { providers: vi.fn().mockResolvedValue({ data: { providers: [], default: {} } }) },
    _abortSpy: abortSpy,
  };
}

async function* sseFromArray(events: unknown[]): AsyncIterable<unknown> {
  for (const e of events) yield e;
}

function stepFinish(): Record<string, unknown> {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        type: "step-finish",
        sessionID: "s1",
        id: `sf-${Math.random()}`,
        reason: "stop",
        cost: 0,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    },
  };
}

function idle() {
  return { type: "session.idle", properties: { sessionID: "s1" } };
}

describe("OpenCodeDriver — maxTurns enforcement", () => {
  const baseOpts = {
    prompt: "test",
    systemPrompt: "sys",
    cwd: "/tmp",
    verbosity: "quiet" as const,
    unitId: "u1",
  };

  it("completes normally when step count is below maxTurns", async () => {
    const driver = new OpenCodeDriver();
    const client = makeMockClient(() => sseFromArray([stepFinish(), stepFinish(), idle()]));
    (driver as unknown as { client: unknown }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 10 });

    expect(client._abortSpy).not.toHaveBeenCalled();
    expect(result.signal.type).not.toBe("error");
    expect(result.numTurns).toBe(2);
  });

  it("aborts and returns error signal when maxTurns is reached", async () => {
    const driver = new OpenCodeDriver();
    const client = makeMockClient(() =>
      sseFromArray([stepFinish(), stepFinish(), stepFinish(), idle()]),
    );
    (driver as unknown as { client: unknown }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 2 });

    expect(client._abortSpy).toHaveBeenCalledWith({ sessionID: "s1" });
    expect(result.signal.type).toBe("error");
    expect(result.signal.type === "error" && result.signal.message).toMatch(
      /Max turns exceeded \(2\)/,
    );
  });

  it("treats maxTurns === 0 as unlimited", async () => {
    const driver = new OpenCodeDriver();
    const client = makeMockClient(() => sseFromArray([stepFinish(), stepFinish(), stepFinish(), idle()]));
    (driver as unknown as { client: unknown }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 0 });

    expect(client._abortSpy).not.toHaveBeenCalled();
    expect(result.signal.type).not.toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/opencode-max-turns.test.ts`
Expected: FAIL — abort is never called; error signal never emitted on breach.

- [ ] **Step 3: Add `maxTurns` to `OpenCodeContext` and `createContext`**

Edit `src/core/drivers/opencode.ts`. In the `OpenCodeContext` interface (around line 77), add the field right after `cwd`:

```typescript
interface OpenCodeContext {
  logger: SessionLogger;
  cwd: string;
  maxTurns: number;
  // ... existing fields unchanged
}
```

In `createContext()` (around line 1062), populate the field:

```typescript
private createContext(opts: SessionOptions): OpenCodeContext {
  return {
    logger: new SessionLogger(opts.verbosity, opts.onLog),
    cwd: opts.cwd,
    maxTurns: opts.maxTurns,
    // ... existing fields unchanged
  };
}
```

- [ ] **Step 4: Enforce the limit in `handleStepFinish`**

In `handleStepFinish` (around line 1355), after the `ctx.numTurns++;` line (currently line 1370), insert the limit check **before** the verbose logging block:

```typescript
  ctx.numTurns++;
  ctx.inputTokens += sfp.tokens.input;
  ctx.outputTokens += sfp.tokens.output;
  ctx.reasoningTokens += sfp.tokens.reasoning;
  ctx.cacheReadTokens += sfp.tokens.cache.read;
  ctx.cacheWriteTokens += sfp.tokens.cache.write;
  ctx.costUsd += sfp.cost;

  // Enforce maxTurns — abort the OpenCode session and surface an error result.
  // `this.client` and `ctx.sessionId` are guaranteed non-null inside runSession's loop.
  if (ctx.maxTurns && ctx.numTurns >= ctx.maxTurns && !ctx.errorResult) {
    this.client?.session
      .abort({ sessionID: ctx.sessionId! })
      .catch(() => {});
    ctx.errorResult = errorResult(
      `Max turns exceeded (${ctx.maxTurns})`,
    );
  }

  if (ctx.logger.isVerbose) {
    // ... existing verbose logging
  }
```

Note: `errorResult` is the existing private helper at the bottom of the file (line 1515). It is already imported in the module scope.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/__tests__/opencode-max-turns.test.ts`
Expected: PASS on all three cases.

- [ ] **Step 6: Run the wider opencode test suite**

Run: `npx vitest run src/__tests__/opencode-*.test.ts`
Expected: All tests pass. If any test stubs `SessionOptions` without `maxTurns`, set it to `10` (matching the existing pattern).

- [ ] **Step 7: Commit**

```bash
git add src/core/drivers/opencode.ts src/__tests__/opencode-max-turns.test.ts
git commit -m "opencode: enforce maxTurns by aborting session on step-finish breach"
```

---

## Task 6: Enforce `maxTurns` in `CodexDriver` (+ real `numTurns`)

**Files:**
- Modify: `src/core/drivers/codex.ts:147-294`
- Test: `src/__tests__/codex-max-turns.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/codex-max-turns.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

/**
 * The Codex driver owns AbortController-driven cancellation. We cannot stub
 * the SDK without heavy mocking, so we construct a mock Thread whose
 * runStreamed yields a controlled event sequence and asserts behavior
 * depending on maxTurns.
 */

function mockThread(events: AsyncIterable<unknown>) {
  return {
    runStreamed: vi.fn().mockImplementation(async () => ({ events })),
  };
}

function mockCodex(thread: ReturnType<typeof mockThread>) {
  return { startThread: vi.fn().mockReturnValue(thread) };
}

async function* seqAsync<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

// Minimal events factory
const threadStarted = { type: "thread.started", thread_id: "t1" };
function toolStartedCmd() {
  return { type: "item.started", item: { type: "command_execution", command: "echo" } };
}
function toolCompletedCmd() {
  return {
    type: "item.completed",
    item: { type: "command_execution", aggregated_output: "" },
  };
}
function reasoning() {
  return { type: "item.completed", item: { type: "reasoning", text: "thinking" } };
}
function agentMessage(text = "ok") {
  return { type: "item.completed", item: { type: "agent_message", text } };
}
function turnCompleted() {
  return { type: "turn.completed", usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } };
}

describe("CodexDriver — maxTurns enforcement", () => {
  async function makeDriver(events: unknown[]) {
    vi.resetModules();
    const thread = mockThread(seqAsync(events));
    const codex = mockCodex(thread);
    vi.doMock("@openai/codex-sdk", () => ({
      Codex: vi.fn().mockImplementation(() => codex),
    }));
    const { CodexDriver } = await import("../core/drivers/codex.js");
    return { driver: new CodexDriver("gpt-5.4"), thread, codex };
  }

  const baseOpts = {
    prompt: "t",
    systemPrompt: "s",
    cwd: "/tmp",
    verbosity: "quiet" as const,
    unitId: "u1",
  };

  it("counts only tool-call items, not reasoning or agent messages", async () => {
    const { driver } = await makeDriver([
      thread_started_like(),
      reasoning(),
      agentMessage("text"),
      toolStartedCmd(),
      toolCompletedCmd(),
      toolStartedCmd(),
      toolCompletedCmd(),
      turnCompleted(),
    ]);

    const result = await driver.runSession({ ...baseOpts, maxTurns: 10 });
    expect(result.signal.type).not.toBe("error");
    expect(result.numTurns).toBe(2);
  });

  it("aborts and returns Max-turns-exceeded error when limit reached", async () => {
    const ac = new AbortController();
    const { driver } = await makeDriver([
      thread_started_like(),
      toolStartedCmd(),
      toolCompletedCmd(),
      toolStartedCmd(),
      toolCompletedCmd(),
      toolStartedCmd(),
      toolCompletedCmd(),
      turnCompleted(),
    ]);

    const result = await driver.runSession({
      ...baseOpts,
      maxTurns: 2,
      abortController: ac,
    });
    expect(result.signal.type).toBe("error");
    expect(
      result.signal.type === "error" && result.signal.message,
    ).toMatch(/Max turns exceeded \(2\)/);
    expect(ac.signal.aborted).toBe(true);
  });

  it("preserves existing behavior when an external AbortController fires", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));
    const { driver } = await makeDriver([thread_started_like(), turnCompleted()]);
    const result = await driver.runSession({
      ...baseOpts,
      maxTurns: 10,
      abortController: ac,
    });
    expect(result.signal.type).toBe("error");
    expect(
      result.signal.type === "error" && result.signal.message,
    ).not.toMatch(/Max turns exceeded/);
  });
});

function thread_started_like() {
  return { type: "thread.started", thread_id: "t1" };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/codex-max-turns.test.ts`
Expected: FAIL — driver neither counts tool calls nor aborts on limit.

- [ ] **Step 3: Implement the counter + abort logic**

Edit `src/core/drivers/codex.ts` inside `runSession()` (around line 147). Add a local counter and a named error class before the `try` block:

```typescript
async runSession(opts: SessionOptions): Promise<IterationResult> {
  const startTime = Date.now();
  const modelName = this.model ?? DEFAULT_CODEX_MODEL;

  const codex = new Codex();
  const thread = codex.startThread({
    // ... existing options
  });

  const fullPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  const logger = new SessionLogger(opts.verbosity, opts.onLog);

  let resultText = "";
  let usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number } | null = null;
  let threadId: string | null = null;
  let toolCalls = 0;
  const maxTurnsExceededSentinel = Symbol("MaxTurnsExceeded");
  let maxTurnsExceeded = false;
```

Inside the event loop, in the `"item.completed"` case, increment on tool-call items:

```typescript
case "item.completed": {
  const item = event.item;
  if (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search"
  ) {
    toolCalls++;
    if (opts.maxTurns && toolCalls >= opts.maxTurns && !maxTurnsExceeded) {
      maxTurnsExceeded = true;
      const err = new Error(`Max turns exceeded (${opts.maxTurns})`);
      (err as Error & { _prorabMaxTurns?: symbol })._prorabMaxTurns = maxTurnsExceededSentinel;
      opts.abortController?.abort(err);
    }
  }
  // ... existing logging / context-usage updates (unchanged) ...
  break;
}
```

In the `catch` block (around line 252), distinguish the max-turns abort from ordinary errors:

```typescript
} catch (err: unknown) {
  let message = err instanceof Error ? err.message : String(err);
  // If we aborted due to our own max-turns limit, surface the reason.
  if (
    maxTurnsExceeded ||
    (opts.abortController?.signal.aborted &&
      (opts.abortController.signal.reason as { _prorabMaxTurns?: symbol })?._prorabMaxTurns ===
        maxTurnsExceededSentinel)
  ) {
    message = `Max turns exceeded (${opts.maxTurns})`;
  }
  return {
    signal: { type: "error", message },
    durationMs: Date.now() - startTime,
    costUsd: 0,
    numTurns: Math.max(1, toolCalls),
    // ... existing fields, keep zeros
    resultText: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    model: modelName,
    agentReport: null,
    reviewReport: null,
    startedAt: "",
    finishedAt: "",
  };
}
```

At the bottom of the method, replace the hardcoded `numTurns: 1` with the real count:

```typescript
return {
  signal,
  durationMs: Date.now() - startTime,
  costUsd: 0,
  numTurns: Math.max(1, toolCalls),
  // ... rest unchanged
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/codex-max-turns.test.ts`
Expected: PASS on all three cases.

- [ ] **Step 5: Run the wider codex test suite**

Run: `npx vitest run src/__tests__/codex-*.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/drivers/codex.ts src/__tests__/codex-max-turns.test.ts
git commit -m "codex: count tool-call items, abort on maxTurns breach, return real numTurns"
```

---

## Task 7: Add `agent:turn_count` event type + emission from all drivers

**Files:**
- Modify: `src/types.ts:31-38` (LogEvent union)
- Modify: `src/core/drivers/opencode.ts` (emit in `handleStepFinish`)
- Modify: `src/core/drivers/codex.ts` (emit on `item.completed` tool-call)
- Modify: `src/core/drivers/claude.ts` (emit per assistant message)

- [ ] **Step 1: Add event type to the `LogEvent` union**

Edit `src/types.ts` (around line 31):

```typescript
export type LogEvent =
  | { type: "agent:text"; text: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:reasoning"; text: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:tool"; name: string; summary: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:tool_result"; summary: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:system_prompt"; text: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:task_prompt"; text: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:context_usage"; contextTokens: number; contextWindow: number; model: string; unitId: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string }
  | { type: "agent:turn_count"; numTurns: number; maxTurns: number; model: string; unitId: string; channel?: WsChannel; reviewerId?: string; slotIndex?: number; taskId?: number; phase?: string };
```

- [ ] **Step 2: Emit from `OpenCodeDriver.handleStepFinish`**

In `src/core/drivers/opencode.ts`, inside `handleStepFinish` — right after the `sendToLog({ type: "agent:context_usage", ... })` block at the end of the method, add the turn-count emission:

```typescript
ctx.logger.sendToLog({
  type: "agent:turn_count",
  numTurns: ctx.numTurns,
  maxTurns: ctx.maxTurns,
  model: ctx.model,
  unitId: ctx.unitId,
});
```

- [ ] **Step 3: Emit from `CodexDriver`**

In `src/core/drivers/codex.ts`, inside the `item.completed` case, emit only when a tool-call item just incremented the counter (avoid emitting identical values on reasoning/agent_message items):

```typescript
if (
  item.type === "command_execution" ||
  item.type === "file_change" ||
  item.type === "mcp_tool_call" ||
  item.type === "web_search"
) {
  toolCalls++;
  // ... existing abort-on-limit block from Task 6 ...
  logger.sendToLog({
    type: "agent:turn_count",
    numTurns: toolCalls,
    maxTurns: opts.maxTurns ?? 0,
    model: modelName,
    unitId: opts.unitId,
  });
  if (opts.maxTurns && toolCalls >= opts.maxTurns && !maxTurnsExceeded) {
    // (already added in Task 6 — kept here for reference)
  }
}
```

This merges Task 6's counter increment with the emission: keep the abort logic (Task 6) and the emission together inside the tool-call branch.

- [ ] **Step 4: Emit from `ClaudeDriver`**

In `src/core/drivers/claude.ts` find where each assistant message is processed (search for `numTurns` or `assistant` events; Claude SDK yields typed messages in a loop inside `runSession`). After each assistant-message handler that increments the driver's internal turn counter (or where `numTurns` is tracked), emit:

```typescript
ctx.logger.sendToLog({
  type: "agent:turn_count",
  numTurns: ctx.numTurns,
  maxTurns: opts.maxTurns,
  model: ctx.model,
  unitId: opts.unitId,
});
```

If Claude's loop doesn't maintain its own counter, increment one locally on each `assistant` message before the emission. Verify by running the existing Claude tests afterward (Step 7).

- [ ] **Step 5: Run all driver tests**

Run: `npx vitest run src/__tests__/opencode-*.test.ts src/__tests__/codex-*.test.ts src/__tests__/claude-*.test.ts`
Expected: All tests pass. If `opencode-verbose-output.test.ts` or similar snapshot tests capture the event stream, the new `agent:turn_count` event will show up — update the fixture/snapshot as part of this task.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/core/drivers/opencode.ts src/core/drivers/codex.ts src/core/drivers/claude.ts src/__tests__/
git commit -m "drivers: emit agent:turn_count event for live UI indicator"
```

---

## Task 8: UI store — `reviewMaxTurns` field + `turnUsageByUnit` state

**Files:**
- Modify: `ui/src/stores/execution.ts`
- Test: `src/__tests__/ui-execution-store-turn-usage.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/ui-execution-store-turn-usage.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useExecutionStore } from "../../ui/src/stores/execution.js";

describe("executionStore — turnUsage", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("stores and retrieves turn usage per unit", () => {
    const store = useExecutionStore();
    store.updateTurnUsage({ numTurns: 12, maxTurns: 100, model: "m1", unitId: "u1" });
    expect(store.turnUsageByUnit).toEqual({
      u1: { numTurns: 12, maxTurns: 100, model: "m1" },
    });
  });

  it("namespaces turn usage by reviewerId", () => {
    const store = useExecutionStore();
    store.updateTurnUsage({
      numTurns: 7, maxTurns: 100, model: "m1", unitId: "u1", reviewerId: "r1",
    });
    expect(store.turnUsageByUnit).toEqual({
      "u1:r1": { numTurns: 7, maxTurns: 100, model: "m1" },
    });
  });

  it("turnUsage getter returns the current unit's entry", () => {
    const store = useExecutionStore();
    store.currentUnit = { id: "u1", title: "x" };
    store.updateTurnUsage({ numTurns: 5, maxTurns: 50, model: "m1", unitId: "u1" });
    expect(store.turnUsage).toEqual({ numTurns: 5, maxTurns: 50, model: "m1" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ui-execution-store-turn-usage.test.ts`
Expected: FAIL — `turnUsageByUnit`, `turnUsage`, `updateTurnUsage` do not exist yet.

- [ ] **Step 3: Extend the store**

Edit `ui/src/stores/execution.ts`. Next to the existing `contextUsageByUnit` (around line 39), add:

```typescript
const turnUsageByUnit = ref<Record<string, { numTurns: number; maxTurns: number; model: string }>>({});
```

Next to the existing `contextUsage` computed (around line 51), add:

```typescript
const turnUsage = computed(() => {
  const unit = currentUnit.value;
  if (!unit) return null;
  if (activeReviewerTab.value) {
    return turnUsageByUnit.value[`${unit.id}:${activeReviewerTab.value}`] ?? null;
  }
  return turnUsageByUnit.value[unit.id] ?? null;
});
```

Next to `updateContextUsage` (around line 192), add:

```typescript
function updateTurnUsage(data: { numTurns: number; maxTurns: number; model: string; unitId: string; reviewerId?: string }) {
  const key = data.reviewerId ? `${data.unitId}:${data.reviewerId}` : data.unitId;
  turnUsageByUnit.value[key] = {
    numTurns: data.numTurns,
    maxTurns: data.maxTurns,
    model: data.model,
  };
}
```

In the `startExecution` options type (around line 62) and the `contextUsageByUnit.value = {}` reset block (line 86), wire `reviewMaxTurns` + reset:

```typescript
async function startExecution(options: {
  // ... existing fields
  maxTurns?: number;
  reviewMaxTurns?: number;
  // ... existing fields
}) {
  events.value = [];
  // ... existing resets
  contextUsageByUnit.value = {};
  turnUsageByUnit.value = {};
  // ... rest
}
```

Finally, export the new fields in the store's return object (around line 289):

```typescript
return {
  state, currentUnit, events, error, models, modelsLoading, modelsError,
  taskContext, taskContextLoading,
  contextUsage, contextUsageByUnit,
  turnUsage, turnUsageByUnit,
  reviewerTabs, reviewerEvents, activeReviewerTab, reviewerStatuses, reviewRoundInfo,
  iterationCurrent, iterationTotal, gracefulStop,
  startExecution, stopExecution, addEvent, clearEvents, fetchModels,
  fetchTaskContext, clearTaskContext,
  updateContextUsage, updateTurnUsage,
  // ... rest unchanged
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/ui-execution-store-turn-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/stores/execution.ts src/__tests__/ui-execution-store-turn-usage.test.ts
git commit -m "ui/store: add reviewMaxTurns + turnUsageByUnit state"
```

---

## Task 9: UI — route `agent:turn_count` through WS handler

**Files:**
- Modify: `ui/src/composables/useWebSocket.ts` (find existing `agent:context_usage` handler)

- [ ] **Step 1: Locate the existing `agent:context_usage` handler**

Run: `grep -n "agent:context_usage" ui/src/composables/useWebSocket.ts`

- [ ] **Step 2: Add the turn-count handler next to it**

Add a case mirroring the context-usage one:

```typescript
case "agent:context_usage":
  execStore.updateContextUsage({
    contextTokens: event.contextTokens,
    contextWindow: event.contextWindow,
    model: event.model,
    unitId: event.unitId,
    reviewerId: event.reviewerId,
  });
  break;
case "agent:turn_count":
  execStore.updateTurnUsage({
    numTurns: event.numTurns,
    maxTurns: event.maxTurns,
    model: event.model,
    unitId: event.unitId,
    reviewerId: event.reviewerId,
  });
  break;
```

- [ ] **Step 3: Type-check**

Run: `npx vue-tsc --noEmit --project ui/tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/composables/useWebSocket.ts
git commit -m "ui/ws: route agent:turn_count event to execution store"
```

---

## Task 10: UI — `Review Max Turns` input + `Turns n / N` indicator

**Files:**
- Modify: `ui/src/views/ExecutionView.vue`

- [ ] **Step 1: Add persisted ref for reviewMaxTurns**

Edit `ui/src/views/ExecutionView.vue`. Next to the existing `maxTurns` persisted ref (around line 30):

```typescript
const maxTurns = usePersistedRef("prorab:maxTurns", 200);
const reviewMaxTurns = usePersistedRef("prorab:reviewMaxTurns", 100);
```

- [ ] **Step 2: Send `reviewMaxTurns` in the `startExecution` payload**

Around line 355, where `maxTurns: maxTurns.value` is set, add:

```typescript
maxTurns: maxTurns.value,
reviewMaxTurns: reviewMaxTurns.value,
```

- [ ] **Step 3: Render the input inside the Reviewers block**

Around line 486 (the existing `reviewer-header` with `Add reviewer` button), add a numeric field for `Review max turns`. Pattern:

```vue
<div class="reviewer-header">
  <label class="reviewer-title">Reviewers</label>
  <div class="control-field numeric-field reviewer-max-turns-field">
    <label>Review max turns</label>
    <InputNumber v-model="reviewMaxTurns" :min="1" :max="9999" :disabled="isRunning" />
  </div>
  <Button label="Add reviewer" icon="pi pi-plus" size="small" text @click="addReviewer" :disabled="isRunning || reviewers.length >= 10" />
</div>
```

Add a small CSS adjustment (end of `<style>` section) so the new field doesn't overflow:

```css
.reviewer-max-turns-field {
  margin-left: auto;
  margin-right: 0.75rem;
}
```

- [ ] **Step 4: Render the `Turns n / N p%` indicator**

Around line 553, duplicate the context indicator pattern for turns, just below the existing `context-usage` block:

```vue
<div v-if="execStore.contextUsage" class="context-usage">
  <!-- existing context block -->
</div>
<div v-if="execStore.turnUsage" class="turn-usage">
  <span class="turn-label">Turns</span>
  <span class="turn-count">{{ execStore.turnUsage.numTurns }} / {{ execStore.turnUsage.maxTurns || '∞' }}</span>
  <ProgressBar
    v-if="execStore.turnUsage.maxTurns > 0"
    :value="turnPercent"
    :showValue="false"
    :style="{ width: '120px', height: '16px' }"
  />
  <span v-if="execStore.turnUsage.maxTurns > 0" class="turn-percent">{{ turnPercent }}%</span>
</div>
```

Add a computed `turnPercent` near `contextPercent` (around line 220):

```typescript
const turnPercent = computed(() => {
  const u = execStore.turnUsage;
  if (!u || !u.maxTurns) return 0;
  return Math.min(100, Math.round((u.numTurns / u.maxTurns) * 100));
});
```

- [ ] **Step 5: Type-check and build**

Run: `npx vue-tsc --noEmit --project ui/tsconfig.json`
Expected: No errors.

Run: `npm run build:ui 2>&1 | tail -20`
Expected: Build succeeds.

- [ ] **Step 6: Manual smoke**

Start the dev server: `npm run dev:ui` (in one terminal) and `prorab serve` (in another).
Open the Execution page.
Expected:
- `Review max turns` input appears inside the Reviewers block with default 100.
- During a live run the `Turns n / N` indicator renders next to the `Context` indicator and updates per step.

- [ ] **Step 7: Commit**

```bash
git add ui/src/views/ExecutionView.vue
git commit -m "ui/execution: add Review max turns input + live Turns n/N indicator"
```

---

## Task 11: Self-verification and final build

**Files:** none — validation only.

- [ ] **Step 1: Full type-check**

Run: `npm run build 2>&1 | tail -30`
Expected: Compiles cleanly; UI bundle produced.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests green.

- [ ] **Step 3: UI type-check**

Run: `npx vue-tsc --noEmit --project ui/tsconfig.json`
Expected: No errors.

- [ ] **Step 4: Spot-check CLI defaults**

Run: `node dist/index.js run --help`
Expected: `--max-turns <number>` (default 200) and `--review-max-turns <number>` (default 100) both present. No "claude only" text.

- [ ] **Step 5: Manual end-to-end smoke**

Start `prorab serve` in a test project, launch an execution with `Review enabled`, a small `Review max turns` (e.g. 3), and an OpenCode reviewer model. Observe:
- `Turns n / N` indicator increments live.
- Once 3 tool-calls/steps happen, the reviewer session aborts with an "error" signal in the log and the standard retry kicks in.

Document the smoke result inline (paste log tail under this step).

- [ ] **Step 6: Commit any snapshot/fixture updates**

If test fixtures (`src/__tests__/fixtures/*.json`) needed updating for the new `agent:turn_count` event, commit them now:

```bash
git status
# If there are fixture updates:
git add src/__tests__/fixtures/
git commit -m "tests: refresh fixtures for agent:turn_count event"
```

---

## Follow-up (out of scope, tracked separately)

- Chat sessions (`ChatOptions.maxTurns`) — wire a similar limit into chat loops for non-Claude drivers. Not urgent; chat is user-driven.
- Repeated-tool-call detector — catches cycles even below `maxTurns` (e.g. 30 identical `npm run build` calls).
