# Ollama Agent — Design Spec

**Date:** 2026-05-06
**Topic:** New `ollama` agent for prorab that routes Anthropic-protocol requests through the local Ollama daemon to access cloud-hosted models.

## Context

`prorab` currently supports four agents: `claude`, `opencode`, `ccs`, `codex`. The `ccs` agent works with profiles that route requests through CCS local proxies. For Ollama cloud models specifically (`deepseek-v4-pro:cloud`, `kimi-k2.6:cloud`, `minimax-m2.7:cloud`, etc.), CCS profiles like `ollama-deepseek` and `ollama-kimi` exist, but in `prorab` they fail with `401 unauthorized`: `prorab` reads only `~/.ccs/<profile>.settings.json` (which contains the upstream `https://ollama.com` URL with a bearer token), bypassing the per-profile proxy daemon that CCS auto-launches when invoked manually.

The Ollama daemon itself already exposes an Anthropic-compatible API surface on `127.0.0.1:11434/v1/messages` and signs upstream requests with the user's Ed25519 key (created via `ollama signin`). Adding a dedicated `ollama` agent in `prorab` removes the CCS dependency for this scenario, mirrors what the official `ollama launch claude --model <name>` command does, and gives `prorab` a clean, well-supported path to run cloud-hosted non-Anthropic models through the Claude Code SDK.

## Goals

- New CLI/UI agent option `ollama` selectable via `--agent ollama --model <model>`.
- Routes Claude Agent SDK traffic through `http://127.0.0.1:11434` (or `OLLAMA_HOST` if set).
- Hardcoded cloud-model catalog (filtered by per-model accessibility probe).
- Clear preflight errors when the daemon is not running or the model is not accessible (transient errors distinguished from auth errors).
- No new long-running infrastructure: relies on the user's already-running `ollama serve`.
- `--variant` is silently stripped for ollama (Claude's `effort` knob is not honored by cloud non-Claude models).

## Non-Goals (out of scope)

- Auto-starting `ollama serve`.
- Local (non-cloud) Ollama models as a coding agent (rejected at `setup()`).
- `effort`/variant dropdown in UI for ollama models. The variant input is hidden by `variantOptions.length > 0` (the model dropdown returns no `variants`); additionally, `OllamaDriver.runSession()`/`startChat()` strip `opts.variant` before delegation so any stale persisted CLI/UI value is dropped.
- A hardcoded `model → context-window` table for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. We derive context from the `[1m]`/`[200k]` suffix when present and omit the env var otherwise (Claude Code falls back to its default). This is an **intentional divergence** from `ollama launch claude` which uses `lookupCloudModelLimit()`; suffix parsing is simpler and avoids drift in a hardcoded map.
- A parallel `ollama-codex` integration.
- Migration or removal of existing CCS `ollama-*` profiles. The two paths coexist; user chooses.
- Decimal context-window suffixes (e.g. `[1.5m]`). Regex `\[(\d+)([km])\]` accepts integer-only.
- Unix-socket form of `OLLAMA_HOST` (e.g. `/var/run/ollama.sock`). Detected and rejected with a clear error.

## Architecture

### Strategy: composition over `ClaudeDriver`

Mirror the proven `CcsDriver` pattern. New file `src/core/drivers/ollama.ts` defines `OllamaDriver` that wraps a `ClaudeDriver` and supplies a per-session `env` override.

```typescript
// Hardcoded cloud-model catalog. Keep in sync with cmd/launch/claude.go in
// upstream Ollama; bump when new cloud models are released. Empirical source
// of truth; daemon's GET /v1/models is local-manifest-only and not a cloud
// catalog (see §listModels for rationale).
const OLLAMA_CLOUD_CATALOG: ReadonlyArray<string> = [
  "deepseek-v4-pro:cloud[1m]",
  "kimi-k2.6:cloud",
  "minimax-m2.7:cloud",
  "qwen3-coder:480b-cloud[1m]",
  "gpt-oss:120b-cloud",
];

export class OllamaDriver implements AgentDriver {
  private inner: ClaudeDriver | null = null;
  private sessionEnv?: Record<string, string>;

  constructor(private model?: string, private useUserSettings = false) {}

  async setup(opts: SetupOptions): Promise<void> {
    if (!this.model) throw new Error("Ollama agent requires a model");
    if (!this.model.includes(":cloud")) {                       // cloud-only guard
      throw new Error(
        `Ollama agent supports only cloud models (id must contain ':cloud'); got '${this.model}'.`,
      );
    }
    await this.preflightDaemon();       // §Preflight — /api/version
    await this.preflightModel();        // §Preflight — /v1/models/<id>
    this.inner = new ClaudeDriver(this.model, this.useUserSettings);
    this.sessionEnv = this.buildEnv();  // §Env vars
    await this.inner.setup?.(opts);
  }

  async teardown(): Promise<void> { /* mirror CcsDriver */ }

  // runSession / startChat — delegate to inner ClaudeDriver.
  // - Strip opts.variant before delegation (cloud models do not honor Claude's effort).
  // - Merge env: { ...opts.env, ...this.sessionEnv } so caller-provided env wins
  //   for keys we do NOT manage, while ours takes precedence for ANTHROPIC_/CLAUDE_CODE_.
  //
  // sendMessage / replyQuestion / abortChat — pure delegation to inner.

  async listModels(): Promise<ModelEntry[]> { /* §listModels */ }
}
```

### Why composition (and not the alternatives)

- **Composition over `ClaudeDriver`** — chosen. `ClaudeDriver` already handles signal parsing, chat lifecycle, hooks, AskUserQuestion bridge, abort, retries. We only need to inject env vars. `CcsDriver` proves this pattern works.
- Subprocess wrapping `ollama launch claude` — rejected. Defeats prorab session management; we lose ChatEvent stream, signal parsing, AskUserQuestion bridge, SIGINT, structured logging.
- Standalone driver talking directly to `127.0.0.1:11434/v1/messages` — rejected. Reimplements streaming, tool-use protocol, AskUserQuestion plumbing for no functional gain.

## Setup flow

### Env vars (mirrors `ollama launch claude`, with one intentional divergence)

```typescript
const PREFLIGHT_TIMEOUT_MS = Number(process.env.OLLAMA_PREFLIGHT_TIMEOUT_MS) || 5000;
const baseUrl = resolveBaseUrl();           // §OLLAMA_HOST handling

const env: Record<string, string> = { ...process.env } as Record<string, string>;

// Drop undefined values that TypeScript's spread leaves intact.
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

// Hygiene: strip any ANTHROPIC_*/CLAUDE_CODE_* leaked from the parent process
// so a stale ANTHROPIC_API_KEY (real Anthropic key) cannot reach the inner SDK.
// Our own overrides are re-set right below.
for (const k of Object.keys(env)) {
  if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_")) delete env[k];
}

env.ANTHROPIC_BASE_URL = baseUrl;
env.ANTHROPIC_AUTH_TOKEN = "ollama";        // sentinel — daemon recognizes; takes precedence over ANTHROPIC_API_KEY
env.ANTHROPIC_API_KEY = "";                 // explicit empty: ensure no host key sneaks back via SDK defaults
env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
env.CLAUDE_CODE_SUBAGENT_MODEL = model;     // sub-agent calls stay on the chosen model
env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";   // suppresses "Created by Claude Code" attribution; matches `ollama launch claude` Run() and is a noop for non-Anthropic upstreams

const ctx = parseContextWindow(model);      // [1m]→1_000_000, [200k]→200_000, [128k]→128_000, otherwise null
if (ctx !== null) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(ctx);
```

**Why blacklist instead of whitelist?** PATH/HOME/USER/LANG/TZ/proxy variables and dozens of others are needed by the inner SDK and any tools it spawns. We strip only the namespaces we manage (`ANTHROPIC_*`, `CLAUDE_CODE_*`) so stale parent-process tokens cannot leak in.

**Why merge instead of replace at the call site?** `runSession()`/`startChat()` build the override as `{ ...opts.env, ...this.sessionEnv }` (rather than `opts.env = sessionEnv`) so any caller-supplied env is preserved for keys we do not manage; ours wins for ANTHROPIC_/CLAUDE_CODE_ overrides.

**Why `ANTHROPIC_API_KEY=""` is safe.** The Claude Agent SDK forwards the env block verbatim to its child `claude` process via `spawn(..., { env })`. Inside the child, `claude` prefers `ANTHROPIC_AUTH_TOKEN` when set, so an empty `ANTHROPIC_API_KEY` does not block startup. Verified empirically by `CcsDriver` which uses the same idiom.

### `parseContextWindow(model: string): number | null`

Regex: `/\[(\d+)([km])\]/i`. Matches the size hint inside square brackets in the model id (e.g., `deepseek-v4-pro:cloud[1m]`). `m` → ×1_000_000; `k` → ×1_000. No match → `null` and we skip the env var. Decimals (`[1.5m]`) and other units (`[2g]`) intentionally do not match.

### `OLLAMA_HOST` handling — `resolveBaseUrl()`

Stricter than the spec read by the Ollama daemon itself; we only need URL form for `fetch()`.

```typescript
function resolveBaseUrl(): string {
  const raw = process.env.OLLAMA_HOST?.trim();
  if (!raw) return "http://127.0.0.1:11434";

  // Reject unix-socket form (Ollama supports it, fetch() does not).
  if (raw.startsWith("/")) {
    throw new Error(
      `Unix-socket OLLAMA_HOST ('${raw}') is not supported. Use http://host:port or set TCP listening.`,
    );
  }

  // Whitespace inside the value is always a typo; reject explicitly.
  if (/\s/.test(raw)) {
    throw new Error(`OLLAMA_HOST contains whitespace: '${raw}'`);
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");    // strip trailing slash(es) so paths join cleanly
}
```

Behavior summary:

- `OLLAMA_HOST=192.168.1.10:11434` → `http://192.168.1.10:11434`
- `OLLAMA_HOST=https://my-ollama.example.com` → kept as-is
- `OLLAMA_HOST=http://127.0.0.1:11434/` → trailing slash stripped → `http://127.0.0.1:11434`
- `OLLAMA_HOST=HTTP://example.com` → kept verbatim (`/^https?:\/\//i` matches)
- `OLLAMA_HOST=[::1]:11434` → `http://[::1]:11434` (caller responsibility to bracket IPv6)
- `OLLAMA_HOST=/var/run/ollama.sock` → throws (unix-socket rejected)
- `OLLAMA_HOST=" 192.168.1.10:11434 "` → trimmed; whitespace inside throws
- Unset → `http://127.0.0.1:11434`

### Preflight (in `setup()`)

Two-step, both bounded by `PREFLIGHT_TIMEOUT_MS` (default 5s, override via env `OLLAMA_PREFLIGHT_TIMEOUT_MS`):

1. **Daemon reachable.** `fetch(${baseUrl}/api/version, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) })`. On reject or non-2xx → throw:

   > `Ollama daemon is not reachable at <baseUrl>. Start it with: ollama serve`

2. **Cloud model accessible.** `fetch(${baseUrl}/v1/models/<encodeURIComponent(model)>, { method: "GET", signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) })`. Disambiguate by status:

   - **200** → model accessible. Continue.
   - **404** → not signed in for this model. Throw with actionable message:
     > `Model '<m>' is not available via ollama. Check 'ollama signin' status, or pick from: <hardcoded catalog list>`
   - **5xx, network error, timeout** → daemon issue, not auth issue. Throw:
     > `Ollama daemon at <baseUrl> failed to verify model '<m>': <error>. The daemon may be transiently overloaded; retry, or check 'ollama serve' logs.`

We use `/v1/models/<id>` (not `/v1/models`) because the daemon's `/v1/models` is served by `ListHandler` against local manifests and returns `{"object":"list","data":null}` for signed-in cloud profiles (verified empirically on Ollama 0.23.1). Per-model GET is the actual access signal.

We deliberately do not probe `~/.ollama/id_ed25519` separately — that file is created on first daemon start, before any signin, and so its presence guarantees nothing.

## `listModels()`

```typescript
async listModels(): Promise<ModelEntry[]> {
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl();         // throws on unix-socket / whitespace
  } catch {
    return [];                          // misconfigured OLLAMA_HOST → empty
  }

  // Daemon up?
  try {
    const resp = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
    if (!resp.ok) return [];
  } catch {
    return [];
  }

  // Probe each catalog entry concurrently. Keep accessible ones.
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
    .map((id) => ({ id, name: id }));   // no `variants` field → UI hides effort dropdown
}
```

**Catalog-then-probe rationale.** The daemon's bulk `GET /v1/models` is local-manifest-only (verified empirically: returns `{"object":"list","data":null}` even on a signed-in cloud profile). Per-model `GET /v1/models/<id>` is the real access signal. We list cloud models from the hardcoded `OLLAMA_CLOUD_CATALOG` and surface only those the daemon can actually serve. The list is finite (~5 entries), so probing in parallel with a 5s timeout completes well under that.

**Catalog maintenance.** `OLLAMA_CLOUD_CATALOG` mirrors the cloud models advertised by `ollama launch claude` upstream. Bump when new cloud models ship. Drift is bounded: missing entries appear after the user runs `ollama signin <model>`, which is a one-time action; the prorab catalog catches up on next release. False positives (entries listed but not subscribed) are filtered out automatically by the per-model probe.

**Error contract:** any failure (daemon down, network error, malformed `OLLAMA_HOST`) → `[]`. UI presents an empty dropdown; the explicit reason surfaces in `setup()` errors when the user actually tries to run.

**Setup-free.** `listModels()` works without `setup()` having been called — the UI populates the agent dropdown before any session exists. Other methods (`runSession`, `startChat`, `sendMessage`, `replyQuestion`, `abortChat`) require `setup()` first and throw `Ollama driver not initialized. Call setup() first.` otherwise.

## Mid-session failures

Preflight only checks the state at `setup()` time. Between `setup()` and the first `/v1/messages` call (or during a long-running session), the user can `ollama signout`, the daemon can crash, or the cloud-side can revoke access. In those cases:

- The Claude Agent SDK surfaces an HTTP error (typically 401/5xx) as a `signal:error` in the `ChatEvent` stream.
- `run.ts` consumes that signal, stops the current iteration without retry, and leaves the task in `in-progress` for resumption — same behavior as for any other agent.
- We deliberately do not re-run preflight mid-session (the next attempt will re-`setup()` and surface the cleaner preflight message).

This is acceptable behavior; a more sophisticated retry policy is out of scope.

## `/api/models` server route

`src/server/routes/models.ts` currently calls `driver.setup()` for every agent except `ccs` and `codex` and lifetime-caches the result. For `ollama` this would (a) fail (`setup()` requires a model, the route does not have one) and (b) cache the empty list across daemon-state changes. The route is updated to:

- Treat `ollama` like `ccs`/`codex`: skip `setup()`, call `listModels()` directly.
- Skip caching for `ollama` (or at minimum do not cache empty results) so the dropdown reflects current daemon-state on subsequent loads after the user runs `ollama serve` / `ollama signin`.

## CLI / UI / wiring

- **`src/types.ts`** — extend `AgentTypeSchema` zod enum with `"ollama"`. `Reviewer` (built from `AgentTypeSchema`) updates automatically.
- **`src/core/drivers/factory.ts`** — add `case "ollama": return new OllamaDriver(model, useUserSettings);`. `applyHooks` is CCS-only and does not apply to ollama (hooks plumb through inner ClaudeDriver).
- **`src/index.ts` (commander)** — `--agent` already accepts a string; add `"ollama"` to validation/help.
- **`src/server/routes/models.ts`** — extend the `needsSetup` exemption list and (optionally) the cache-skip list to include `"ollama"`.
- **UI** — add `"ollama"` to agent dropdowns in `AgentWizard.vue`, `TaskListView.vue`, `TaskDetailView.vue`, `ExecutionView.vue`. Extend the "No user settings" checkbox `v-if` from `agent === 'claude' || agent === 'ccs'` to include `'ollama'`.
- **Docs** — append `OllamaDriver` section in `.claude/rules/drivers.md`; update `CLAUDE.md` (drivers list, `--agent` enumeration), `.claude/rules/frontend.md`, and `README.md` (agents enumeration in 4 places).

## Error handling summary

| Condition | Surface | Message |
|---|---|---|
| `--agent ollama` without `--model` | `setup()` throws | `Ollama agent requires a model` |
| Non-cloud model (no `:cloud` substring) | `setup()` throws | `Ollama agent supports only cloud models (id must contain ':cloud'); got '<m>'.` |
| `OLLAMA_HOST=/var/run/ollama.sock` | `resolveBaseUrl()` throws | `Unix-socket OLLAMA_HOST ('<v>') is not supported. Use http://host:port or set TCP listening.` |
| `OLLAMA_HOST` contains whitespace | `resolveBaseUrl()` throws | `OLLAMA_HOST contains whitespace: '<v>'` |
| Daemon not reachable | `setup()` throws | `Ollama daemon is not reachable at <url>. Start it with: ollama serve` |
| Daemon up, model 404 on `/v1/models/<id>` | `setup()` throws | `Model '<m>' is not available via ollama. Check 'ollama signin' status, or pick from: <catalog>` |
| Daemon up, transient 5xx/timeout on per-model probe | `setup()` throws | `Ollama daemon at <url> failed to verify model '<m>': <error>. The daemon may be transiently overloaded; retry, or check 'ollama serve' logs.` |
| `--variant` passed to `--agent ollama` | silently stripped | (no error; rationale in §Goals) |
| `listModels()` daemon down / network error / bad OLLAMA_HOST | returns `[]` | UI shows empty dropdown; explicit error surfaces on session start |
| Mid-session signout / daemon crash | bubbles up from SDK as `signal:error` | run.ts stops iteration; task remains `in-progress` for resumption |

## Testing — `src/__tests__/ollama-driver.test.ts`

Mirrors `ccs-driver.test.ts` patterns. Mock `ClaudeDriver` via `vi.mock("../core/drivers/claude.js", ...)` returning a constructor that hangs `setup`/`teardown`/`runSession`/`startChat`/`sendMessage`/`replyQuestion`/`abortChat` mocks on `this`. `fetch` is mocked per-test by reassigning `globalThis.fetch = vi.fn()...`. Restore `process.env` and `globalThis.fetch` in `afterEach`.

Test cases:

1. `OllamaDriver()` without model → `listModels()` works (returns `[]` if daemon down or empty catalog), `setup()` throws `"Ollama agent requires a model"`.
2. `setup()` rejects non-cloud models with `"Ollama agent supports only cloud models"`.
3. `setup()` throws "daemon not reachable" when `fetch /api/version` rejects or returns non-OK.
4. `setup()` throws "model not available ... ollama signin" on **404** from `/v1/models/<id>`.
5. `setup()` throws transient-error message on **5xx** or fetch-throw from `/v1/models/<id>` (distinct from auth failure).
6. `setup()` builds env: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY=""`, four model defaults, `CLAUDE_CODE_ATTRIBUTION_HEADER=0`.
7. `setup()` strips parent `ANTHROPIC_*`/`CLAUDE_CODE_*` from the inherited env (e.g. `ANTHROPIC_API_KEY=real-key` set in `process.env` does not survive into `sessionEnv`).
8. `setup()` honors `OLLAMA_HOST=192.168.1.10:11434` → `ANTHROPIC_BASE_URL=http://192.168.1.10:11434`. Explicit `https://my-ollama.example.com` kept as-is. `http://127.0.0.1:11434/` (trailing slash) stripped to `http://127.0.0.1:11434`. Unix-socket form throws. Whitespace inside the value throws.
9. `setup()` sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` for `[1m]`, `200000` for `[200k]`; omits the var when no suffix; ignores decimal suffix `[1.5m]` as no-match.
10. `runSession`/`startChat` inject `sessionEnv` and **strip `opts.variant`** before delegating; if caller passes `opts.env`, it is preserved (merged) for keys we do not manage.
11. `sendMessage` / `replyQuestion` / `abortChat` delegate verbatim and throw `"Ollama driver not initialized"` (matches regex `/not initialized/`) when called pre-setup.
12. `teardown()` clears `inner` and `sessionEnv`; subsequent calls throw "not initialized".
13. `listModels()` characterization:
    - probes each catalog entry concurrently and returns only those with HTTP 200;
    - returns `[]` when `/api/version` rejects, returns non-OK, or `OLLAMA_HOST` is malformed (unix-socket / whitespace);
    - emits no `variants` field on returned `ModelEntry`s.

## Implementation footprint estimate

- New file `src/core/drivers/ollama.ts` — ~250 lines (catalog, normalization, preflight per-model, env hygiene, variant strip).
- New file `src/__tests__/ollama-driver.test.ts` — ~350 lines (13 test groups, ~25-30 individual cases).
- Edits in `factory.ts`, `types.ts`, `index.ts`, `server/routes/models.ts`, UI SFCs (4 files), docs (drivers.md, frontend.md, CLAUDE.md, README.md) — ~60 lines total.

Total: ~1 implementation file + 1 test file + ~10 wiring/docs touches.

## Verification

End-to-end sanity (manual, on the user's machine):

1. `ollama serve` running, `ollama signin` done.
2. `prorab serve` → web UI lists `ollama` agent → dropdown contains `*:cloud` models from `/v1/models`.
3. Select `deepseek-v4-pro:cloud[1m]`, run a small task → request hits `127.0.0.1:11434/v1/messages` (verifiable via `tcpdump -i lo` or daemon logs), response streams back as normal Claude SDK output.
4. Stop `ollama serve` → re-run → setup throws the daemon-not-reachable error.
5. With daemon up but `ollama signout` first → setup throws the model-not-available error.

Automated:

- `npm test -- ollama-driver` runs the new test file (~25-30 cases).
- `npm run build` passes (TypeScript) — verifies `factory.ts`, `types.ts`, `server/routes/models.ts` integration.
- `npm run build:ui` passes (Vite) — UI SFCs compile. Note: `vue-tsc` is not in `ui/package.json`; the CLAUDE.md mention of `npx vue-tsc --noEmit --project ui/tsconfig.json` is aspirational and will fail with "missing packages" on a clean machine. Type checking of Vue SFCs is out of scope for this task.
