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
- `src/core/drivers/types.ts` — add `MaxTurnsExceededError` class (shared).
- `src/core/drivers/opencode.ts` — store `maxTurns`/`aborted`/`maxTurnsExceeded` in `OpenCodeContext`; enforce limit in `handleStepFinish`; guard handlers post-abort; preserve metrics; emit `agent:turn_count`; return `signal: none` with reason in `resultText`.
- `src/core/drivers/codex.ts` — count tool-call `item.completed` events; abort on limit with `MaxTurnsExceededError`; guard loop post-abort; preserve metrics; emit `agent:turn_count`; replace `numTurns: 1` with `Math.max(1, toolCalls)`; return `signal: none` with reason in `resultText`.
- `src/core/drivers/claude.ts` — add `maxTurns`, `unitId`, `numApiCalls` to `ClaudeContext`; emit `agent:turn_count` from `handleAssistant` only in `runSession` (not `startChat`).

**Modified (frontend):**
- `ui/src/stores/execution.ts` — add `turnUsageByUnit` state + `updateTurnUsage` / `clearTurnUsage` actions, mirror `contextUsage` pattern; reset on lifecycle events.
- `ui/src/composables/useWebSocket.ts` — route `agent:turn_count` to `execStore.updateTurnUsage`; reset `turnUsageByUnit` on `execution:multi_review_started` / `execution:reviewer_finished` / `execution:all_done`.
- `ui/src/views/ExecutionView.vue` — add `REVIEW MAX TURNS` input inside the Reviewers block (with `usePersistedRef("prorab:reviewMaxTurns", 100)`); render `Turns n / N p%` indicator; include `reviewMaxTurns` in payload.

**Created (tests):**
- `src/__tests__/opencode-max-turns.test.ts`
- `src/__tests__/codex-max-turns.test.ts`
- `src/__tests__/claude-turn-count.test.ts`
- `src/__tests__/execution-route-review-max-turns.test.ts`
- `src/__tests__/ui-execution-store-turn-usage.test.ts`
- `src/__tests__/ui-execution-turns-indicator.test.ts`

**Modified (tests):**
- `src/__tests__/execute-review-rework.test.ts` — add reviewer / aggregator / rework / execute maxTurns routing + retry assertions.
- `src/__tests__/ws-channel-routing.test.ts` — add `agent:turn_count` routing case.
- `src/__tests__/execution-manager.test.ts` — extend `defaultOptions` with `reviewMaxTurns`.
- `src/__tests__/driver-runner.test.ts` — `stubSessionOpts` unchanged (no `reviewMaxTurns` there — it's a run-level option, not SessionOptions).
- All other `__tests__/*.test.ts` files that construct `RunOptions` / `ExecuteOptions` literals — tsc-driven sweep in Task 1.

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

- [ ] **Step 4: tsc-driven sweep of all existing `RunOptions` / `ExecuteOptions` literals in tests**

After the type change, `tsc` will flag every test fixture that builds a full `RunOptions` or `ExecuteOptions` without `reviewMaxTurns`. Run `npm run build 2>&1 | tail -60` and fix each reported line by adding `reviewMaxTurns: 10` (test-appropriate small value) to the literal. At minimum the following files are known to need updates:

- `src/__tests__/execute-review-rework.test.ts` (~line 119)
- `src/__tests__/run-attempt-counter.test.ts` (~line 108)

There may be others — trust the compiler's error list, add the field, re-run build until clean.

- [ ] **Step 5: Run the type-check and tests**

Run: `npm run build 2>&1 | tail -40`
Expected: Compiles without errors.

Run: `npx vitest run src/__tests__/execution-manager.test.ts src/__tests__/execute-review-rework.test.ts src/__tests__/run-attempt-counter.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/server/execution-manager.ts src/__tests__/
git commit -m "types: add reviewMaxTurns to RunOptions/ExecuteOptions + fixture sweep"
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
  reviewMaxTurns: z.coerce.number().int().positive().default(100),
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
- Test: `src/__tests__/execute-review-rework.test.ts` (extend — no new test file)

- [ ] **Step 1: Add failing routing assertions in `execute-review-rework.test.ts`**

Open `src/__tests__/execute-review-rework.test.ts`. The file already has fixtures that spin up `executeReviewCycle` / `executeUnit` with mock drivers (`createDriver` is mocked). Reuse that plumbing.

Add four tests with distinguishable values (`maxTurns: 200`, `reviewMaxTurns: 42`). Each captures `runSession` arguments via a `vi.fn()` spy and asserts:

```typescript
import { describe, it, expect, vi } from "vitest";
// ... existing imports

describe("run.ts — reviewMaxTurns routing", () => {
  it("reviewer runSession gets reviewMaxTurns", async () => {
    const spy = vi.fn().mockResolvedValue(/* completed IterationResult */);
    // wire spy through existing mock-driver helper in this file
    await runReviewCycleWithOptions({ maxTurns: 200, reviewMaxTurns: 42 });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 42 }));
  });

  it("aggregator runSession gets reviewMaxTurns", async () => {
    // Two reviewers so aggregator runs
    // assert aggregator-call-arg.maxTurns === 42
  });

  it("rework runSession gets maxTurns (not reviewMaxTurns)", async () => {
    // Put task into rework state, run executeRework
    // assert rework-call-arg.maxTurns === 200
  });

  it("execute runSession gets maxTurns (not reviewMaxTurns)", async () => {
    // assert execute-call-arg.maxTurns === 200
  });
});
```

The prior "smoke test" in `run-routes-review-max-turns.test.ts` is dropped — it tested nothing beyond a local constant. Reuse the real fixture in `execute-review-rework.test.ts` which already drives the `run.ts` code paths through a mock-driver factory.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/__tests__/execute-review-rework.test.ts -t "reviewMaxTurns routing"`
Expected: FAIL for all four — `run.ts` currently passes `options.maxTurns` everywhere.

- [ ] **Step 3: Implement the routing change**

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

  it("aborts and returns none signal when maxTurns is reached", async () => {
    const driver = new OpenCodeDriver();
    const client = makeMockClient(() =>
      sseFromArray([stepFinish(), stepFinish(), stepFinish(), idle()]),
    );
    (driver as unknown as { client: unknown }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 2 });

    expect(client._abortSpy).toHaveBeenCalledTimes(1);
    expect(client._abortSpy).toHaveBeenCalledWith({ sessionID: "s1" });
    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(2\)/);
    // Metrics must be preserved (non-zero)
    expect(result.numTurns).toBeGreaterThanOrEqual(2);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it("ignores post-abort events (no double abort, no counter drift)", async () => {
    const driver = new OpenCodeDriver();
    // 5 step-finish events, maxTurns=2 — after abort, events 3/4/5 must be ignored
    const client = makeMockClient(() =>
      sseFromArray([stepFinish(), stepFinish(), stepFinish(), stepFinish(), stepFinish(), idle()]),
    );
    (driver as unknown as { client: unknown }).client = client;

    const result = await driver.runSession({ ...baseOpts, maxTurns: 2 });

    expect(client._abortSpy).toHaveBeenCalledTimes(1);
    expect(result.numTurns).toBe(2);
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

- [ ] **Step 3: Add `maxTurns`, `aborted`, `maxTurnsExceeded` to `OpenCodeContext` and `createContext`**

Edit `src/core/drivers/opencode.ts`. In the `OpenCodeContext` interface (around line 77), add three fields:

```typescript
interface OpenCodeContext {
  logger: SessionLogger;
  cwd: string;
  maxTurns: number;
  /** Set once we have sent session.abort — subsequent SSE events must be ignored. */
  aborted: boolean;
  /** True when abort reason was maxTurns breach — result is built with signal: none + marker. */
  maxTurnsExceeded: boolean;
  // ... existing fields unchanged
}
```

In `createContext()` (around line 1062), populate the new fields:

```typescript
private createContext(opts: SessionOptions): OpenCodeContext {
  return {
    logger: new SessionLogger(opts.verbosity, opts.onLog),
    cwd: opts.cwd,
    maxTurns: opts.maxTurns,
    aborted: false,
    maxTurnsExceeded: false,
    // ... existing fields unchanged
  };
}
```

- [ ] **Step 4: Guard handlers against post-abort events**

Add at the very top of `handleStepFinish`, `handleToolPart`, and `handleTextPart`:

```typescript
if (ctx.aborted) return;
```

This prevents the SSE stream from continuing to accumulate counters or re-trigger abort while our `session.abort()` HTTP call is in flight.

- [ ] **Step 5: Enforce the limit in `handleStepFinish`**

In `handleStepFinish` (around line 1355), after metric accumulation and before verbose logging, insert the limit check:

```typescript
  ctx.numTurns++;
  ctx.inputTokens += sfp.tokens.input;
  ctx.outputTokens += sfp.tokens.output;
  ctx.reasoningTokens += sfp.tokens.reasoning;
  ctx.cacheReadTokens += sfp.tokens.cache.read;
  ctx.cacheWriteTokens += sfp.tokens.cache.write;
  ctx.costUsd += sfp.cost;

  // Enforce maxTurns: abort session, mark context, suppress the N/N turn-count emission below.
  if (ctx.maxTurns && ctx.numTurns >= ctx.maxTurns && !ctx.aborted) {
    ctx.aborted = true;
    ctx.maxTurnsExceeded = true;
    this.client?.session
      .abort({ sessionID: ctx.sessionId! })
      .catch(() => {});
    // Do NOT emit agent:turn_count here — a terminal N/N blip is misleading; the next
    // runSession-level retry will reset the counter cleanly.
    return;
  }

  if (ctx.logger.isVerbose) {
    // ... existing verbose logging
  }

  // emit agent:turn_count (only reached when not aborting)
  ctx.logger.sendToLog({
    type: "agent:turn_count",
    numTurns: ctx.numTurns,
    maxTurns: ctx.maxTurns,
    model: ctx.model,
    unitId: ctx.unitId,
  });
```

- [ ] **Step 6: Build the result with preserved metrics and `signal: none` on breach**

In `runSession` (around line 440, after the `for await` loop), replace the final result-building logic. When `ctx.maxTurnsExceeded` is set:

```typescript
if (ctx.maxTurnsExceeded) {
  const marker = `Max turns exceeded (${ctx.maxTurns})`;
  console.error(`  !!! ${marker} — retrying !!!`);
  const sseText = Array.from(ctx.textPartAccumulator.values()).join("\n");
  const finalText = sseText || ctx.resultText;
  return this.buildIterationResult(
    { ...ctx, resultText: `${marker}\n${finalText}` },
    { type: "none" },
    null,
    null,
  );
}
```

Do **not** call `errorResult(...)` in this path — it zeros all metrics. The existing `buildIterationResult(ctx, signal, report, reviewReport)` already reads accumulated metrics from `ctx`.

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

Use the hoisted `vi.mock()` pattern (ESM-compatible):

```typescript
import { describe, it, expect, vi } from "vitest";

/**
 * Vitest ESM-compatible pattern: vi.mock is hoisted and must declare its factory
 * before any imports of the mocked module. We expose a setter so each test can
 * swap the event stream.
 */

let mockEvents: AsyncIterable<unknown> = (async function* () {})();

vi.mock("@openai/codex-sdk", () => {
  return {
    Codex: vi.fn().mockImplementation(() => ({
      startThread: vi.fn().mockReturnValue({
        runStreamed: vi.fn().mockImplementation(async () => ({ events: mockEvents })),
      }),
    })),
  };
});

import { CodexDriver } from "../core/drivers/codex.js";
import { MaxTurnsExceededError } from "../core/drivers/types.js";

async function* seqAsync<T>(items: T[]): AsyncIterable<T> {
  for (const i of items) yield i;
}

function threadStarted() {
  return { type: "thread.started", thread_id: "t1" };
}
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
  const baseOpts = {
    prompt: "t",
    systemPrompt: "s",
    cwd: "/tmp",
    verbosity: "quiet" as const,
    unitId: "u1",
  };

  it("counts only tool-call items, not reasoning or agent messages", async () => {
    mockEvents = seqAsync([
      threadStarted(),
      reasoning(),
      agentMessage("text"),
      toolStartedCmd(),
      toolCompletedCmd(),
      toolStartedCmd(),
      toolCompletedCmd(),
      turnCompleted(),
    ]);
    const driver = new CodexDriver("gpt-5.4");
    const result = await driver.runSession({ ...baseOpts, maxTurns: 10 });
    expect(result.signal.type).not.toBe("error");
    expect(result.numTurns).toBe(2);
  });

  it("aborts and returns signal:none with marker when limit reached", async () => {
    const ac = new AbortController();
    mockEvents = seqAsync([
      threadStarted(),
      toolStartedCmd(),
      toolCompletedCmd(),
      toolStartedCmd(),
      toolCompletedCmd(),
      // would-be 3rd tool call — should never be counted because loop breaks
      toolStartedCmd(),
      toolCompletedCmd(),
      turnCompleted(),
    ]);
    const driver = new CodexDriver("gpt-5.4");
    const result = await driver.runSession({
      ...baseOpts,
      maxTurns: 2,
      abortController: ac,
    });
    expect(result.signal.type).toBe("none");
    expect(result.resultText).toMatch(/^Max turns exceeded \(2\)/);
    expect(result.numTurns).toBe(2); // NOT 3 — loop broke before 3rd increment
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBeInstanceOf(MaxTurnsExceededError);
  });

  it("external AbortController abort with non-maxTurns reason keeps error path", async () => {
    const ac = new AbortController();
    ac.abort(new Error("user cancelled"));
    mockEvents = seqAsync([threadStarted(), turnCompleted()]);
    const driver = new CodexDriver("gpt-5.4");
    const result = await driver.runSession({
      ...baseOpts,
      maxTurns: 10,
      abortController: ac,
    });
    // External abort → standard error path (not maxTurns)
    expect(result.signal.type).toBe("error");
    expect(
      result.signal.type === "error" && result.signal.message,
    ).not.toMatch(/Max turns exceeded/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/codex-max-turns.test.ts`
Expected: FAIL — driver neither counts tool calls nor aborts on limit.

- [ ] **Step 3: Implement the counter + abort logic**

Edit `src/core/drivers/codex.ts` inside `runSession()` (around line 147). Add a local counter and a named error class before the `try` block:

First, add the shared error class in `src/core/drivers/types.ts`:

```typescript
export class MaxTurnsExceededError extends Error {
  constructor(public readonly maxTurns: number) {
    super(`Max turns exceeded (${maxTurns})`);
    this.name = "MaxTurnsExceeded";
  }
}
```

Import it at the top of `src/core/drivers/codex.ts`:

```typescript
import { parseSignal, parseReport, parseReviewReport, MaxTurnsExceededError } from "./types.js";
```

Then edit `runSession`. Add a local counter and a guard flag before the `try` block:

```typescript
async runSession(opts: SessionOptions): Promise<IterationResult> {
  const startTime = Date.now();
  const modelName = this.model ?? DEFAULT_CODEX_MODEL;

  const codex = new Codex();
  const thread = codex.startThread({
    // ... existing options unchanged
  });

  const fullPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  const logger = new SessionLogger(opts.verbosity, opts.onLog);

  let resultText = "";
  let usage: { input_tokens: number; output_tokens: number; cached_input_tokens: number } | null = null;
  let threadId: string | null = null;
  let toolCalls = 0;
  let maxTurnsExceeded = false;
```

Inside the event loop, **add a guard at the top** (prevents post-abort events from being processed):

```typescript
for await (const event of streamedTurn.events) {
  if (maxTurnsExceeded) break; // stop immediately after limit decision
  switch (event.type) {
    // ... existing cases
```

In the `"item.completed"` case, increment counter on tool-call items, emit turn_count, enforce limit, and break out synchronously:

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
    logger.sendToLog({
      type: "agent:turn_count",
      numTurns: toolCalls,
      maxTurns: opts.maxTurns ?? 0,
      model: modelName,
      unitId: opts.unitId,
    });
    if (opts.maxTurns && toolCalls >= opts.maxTurns && !maxTurnsExceeded) {
      maxTurnsExceeded = true;
      const err = new MaxTurnsExceededError(opts.maxTurns);
      if (opts.abortController) {
        opts.abortController.abort(err);
      }
      // Break out of the for-await synchronously; don't wait for SDK ack.
      // Using a labeled break requires a label, so we rely on the top-of-loop
      // guard instead — the next iteration's `if (maxTurnsExceeded) break;`
      // catches it. Falling through is safe because further processing
      // within this case is idempotent (logger calls accept our counter).
    }
  }
  // ... existing logging / context-usage updates (unchanged) ...
  break;
}
```

**After the `for await` loop and before the `catch` block**, handle the max-turns outcome with preserved metrics:

```typescript
  } // end for-await

  if (maxTurnsExceeded) {
    const marker = `Max turns exceeded (${opts.maxTurns})`;
    console.error(`  !!! ${marker} — retrying !!!`);
    return {
      signal: { type: "none" },
      durationMs: Date.now() - startTime,
      costUsd: 0,
      numTurns: Math.max(1, toolCalls),
      resultText: `${marker}\n${resultText}`,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cached_input_tokens ?? 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      model: modelName,
      agentReport: null,
      reviewReport: null,
      startedAt: "",
      finishedAt: "",
    };
  }
} catch (err: unknown) {
  // External abort or SDK error — do NOT treat as maxTurns (that path returned above)
  const message = err instanceof Error ? err.message : String(err);
  return {
    signal: { type: "error", message },
    durationMs: Date.now() - startTime,
    costUsd: 0,
    numTurns: Math.max(0, toolCalls), // 0 if nothing happened
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

At the bottom of the method (success path), replace the hardcoded `numTurns: 1`:

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

- [ ] **Step 4: Emit from `ClaudeDriver` — add local counter, emit per assistant message, only in `runSession`**

The Claude Agent SDK does not expose incremental `num_turns` during streaming — only the final value in the `result` message. For a live UI indicator we maintain our own counter in `ClaudeContext`.

In `src/core/drivers/claude.ts`:

1. Locate `ClaudeContext` interface (grep for `interface ClaudeContext`). Add three fields:

```typescript
interface ClaudeContext {
  // ... existing fields
  maxTurns: number;
  unitId: string;
  numApiCalls: number;
}
```

2. In `createContext()` (the helper that builds `ClaudeContext` for `runSession`), populate:

```typescript
return {
  // ... existing fields
  maxTurns: opts.maxTurns,
  unitId: opts.unitId,
  numApiCalls: 0,
};
```

3. In `handleAssistant` (the method called once per SDK `assistant` message in `runSession`), increment and emit at the top of the method:

```typescript
private handleAssistant(msg: SDKAssistantMessage, ctx: ClaudeContext): void {
  ctx.numApiCalls++;
  ctx.logger.sendToLog({
    type: "agent:turn_count",
    numTurns: ctx.numApiCalls,
    maxTurns: ctx.maxTurns,
    model: ctx.model,
    unitId: ctx.unitId,
  });
  // ... existing body unchanged
}
```

4. **Do NOT add this emission to `startChat`.** Chat sessions do not render the turns indicator and do not pass a `maxTurns`. The chat context is a separate data structure; only the `runSession` context gets the new fields.

- [ ] **Step 5: Create `src/__tests__/claude-turn-count.test.ts`**

```typescript
import { describe, it, expect, vi } from "vitest";
// Mock the Claude SDK to yield a controlled assistant-message sequence.
// Pattern: hoisted vi.mock, then import ClaudeDriver.
// ...

it("emits agent:turn_count for each assistant message with maxTurns and unitId", async () => {
  const events: unknown[] = [];
  const driver = new ClaudeDriver();
  // wire mocked SDK to yield 3 assistant messages then result
  const result = await driver.runSession({
    prompt: "p", systemPrompt: "s", cwd: "/tmp",
    maxTurns: 50, verbosity: "quiet", unitId: "u1",
    onLog: (e) => events.push(e),
  });
  const turnCountEvents = events.filter(
    (e): e is { type: string; numTurns: number; maxTurns: number; unitId: string } =>
      (e as { type?: string }).type === "agent:turn_count",
  );
  expect(turnCountEvents.map((e) => e.numTurns)).toEqual([1, 2, 3]);
  expect(turnCountEvents.every((e) => e.maxTurns === 50)).toBe(true);
  expect(turnCountEvents.every((e) => e.unitId === "u1")).toBe(true);
});

it("does NOT emit agent:turn_count during startChat", async () => {
  const events: unknown[] = [];
  const driver = new ClaudeDriver();
  const stream = driver.startChat({
    cwd: "/tmp", verbosity: "quiet",
    onLog: (e) => events.push(e),
  });
  driver.sendMessage("hi");
  for await (const ev of stream) {
    if (ev.type === "idle") break;
  }
  expect(events.some((e) => (e as { type?: string }).type === "agent:turn_count")).toBe(false);
});
```

- [ ] **Step 6: Run all driver tests**

Run: `npx vitest run src/__tests__/opencode-*.test.ts src/__tests__/codex-*.test.ts src/__tests__/claude-*.test.ts`
Expected: All pass. If `opencode-verbose-output.test.ts` or similar snapshot tests capture the event stream, the new `agent:turn_count` event will show up — update the fixture/snapshot.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/core/drivers/types.ts src/core/drivers/opencode.ts src/core/drivers/codex.ts src/core/drivers/claude.ts src/__tests__/
git commit -m "drivers: emit agent:turn_count for live UI indicator (runSession only)"
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

Next to `updateContextUsage` (around line 192), add two actions:

```typescript
function updateTurnUsage(data: { numTurns: number; maxTurns: number; model: string; unitId: string; reviewerId?: string }) {
  const key = data.reviewerId ? `${data.unitId}:${data.reviewerId}` : data.unitId;
  turnUsageByUnit.value[key] = {
    numTurns: data.numTurns,
    maxTurns: data.maxTurns,
    model: data.model,
  };
}

function clearTurnUsage(scope?: { unitId?: string; reviewerId?: string }) {
  if (!scope) {
    turnUsageByUnit.value = {};
    return;
  }
  if (scope.unitId && scope.reviewerId) {
    delete turnUsageByUnit.value[`${scope.unitId}:${scope.reviewerId}`];
  } else if (scope.unitId) {
    delete turnUsageByUnit.value[scope.unitId];
    // also clear per-reviewer entries for this unit
    for (const key of Object.keys(turnUsageByUnit.value)) {
      if (key.startsWith(`${scope.unitId}:`)) delete turnUsageByUnit.value[key];
    }
  }
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
  updateContextUsage, updateTurnUsage, clearTurnUsage,
  // ... rest unchanged
};
```

**Phase-transition resets.** `turnUsageByUnit` must also be cleared wherever `contextUsageByUnit` is cleared today (search `contextUsageByUnit.value = {}` across the store and composables). The `startExecution` reset above covers run start; other lifecycle events (`execution:multi_review_started`, `execution:reviewer_finished`, `execution:all_done`) are handled either directly in the store (if a helper already exists) or in `useWebSocket.ts` (Task 9).

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

- [ ] **Step 2: Add the turn-count handler + phase-transition resets**

Add a case mirroring the context-usage one. Also find places where `contextUsageByUnit` is cleared on lifecycle events and mirror them for `turnUsageByUnit`.

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

For phase transitions: any place that currently clears `contextUsageByUnit` (e.g. on `execution:multi_review_started`, `execution:all_done`) must also call `execStore.clearTurnUsage(...)` with the same scope. Search `contextUsageByUnit` in `useWebSocket.ts` and the store; mirror each clear site.

- [ ] **Step 3: Extend `ws-channel-routing.test.ts`**

Add a case verifying that an `agent:turn_count` event without explicit `channel` is routed to the `"execute"` channel by `applyDefaultChannel()`, like other `agent:*` events. Follow the pattern already used for `agent:context_usage` in that file:

```typescript
it("applies default 'execute' channel to agent:turn_count", () => {
  const event = { type: "agent:turn_count", numTurns: 5, maxTurns: 100, model: "m", unitId: "u1" };
  expect(applyDefaultChannel(event).channel).toBe("execute");
});

it("preserves reviewerId on agent:turn_count", () => {
  const event = {
    type: "agent:turn_count", numTurns: 3, maxTurns: 100, model: "m", unitId: "u1",
    reviewerId: "r1",
  };
  expect(applyDefaultChannel(event).reviewerId).toBe("r1");
});
```

- [ ] **Step 4: Type-check and run tests**

Run: `npx vue-tsc --noEmit --project ui/tsconfig.json`
Expected: No errors.

Run: `npx vitest run src/__tests__/ws-channel-routing.test.ts`
Expected: All tests pass, including the two new cases.

- [ ] **Step 5: Commit**

```bash
git add ui/src/composables/useWebSocket.ts src/__tests__/ws-channel-routing.test.ts
git commit -m "ui/ws: route agent:turn_count, reset turnUsage on phase transitions"
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

First, update the `startExecution` options interface in `ui/src/stores/execution.ts` (around line 62) to include the field:

```typescript
async function startExecution(options: {
  // ... existing fields
  maxTurns?: number;
  reviewMaxTurns?: number;
  // ... existing fields
}) {
```

Then in `ExecutionView.vue` around line 355, where `maxTurns: maxTurns.value` is set, add the new field:

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
- Once 3 tool-calls/steps happen, the reviewer session aborts, log shows `"Max turns exceeded (3) — retrying"`, and the next attempt starts (up to `--max-retries`).
- After retries exhausted, the task commit log records the failure via the standard max-retries path.

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
