# Ollama Agent — Design Spec

**Date:** 2026-05-06
**Topic:** New `ollama` agent for prorab that routes Anthropic-protocol requests through the local Ollama daemon to access cloud-hosted models.

## Context

`prorab` currently supports four agents: `claude`, `opencode`, `ccs`, `codex`. The `ccs` agent works with profiles that route requests through CCS local proxies. For Ollama cloud models specifically (`deepseek-v4-pro:cloud`, `kimi-k2.6:cloud`, `minimax-m2.7:cloud`, etc.), CCS profiles like `ollama-deepseek` and `ollama-kimi` exist, but in `prorab` they fail with `401 unauthorized`: `prorab` reads only `~/.ccs/<profile>.settings.json` (which contains the upstream `https://ollama.com` URL with a bearer token), bypassing the per-profile proxy daemon that CCS auto-launches when invoked manually.

The Ollama daemon itself already exposes an Anthropic-compatible API surface on `127.0.0.1:11434/v1/messages` and signs upstream requests with the user's Ed25519 key (created via `ollama signin`). Adding a dedicated `ollama` agent in `prorab` removes the CCS dependency for this scenario, mirrors what the official `ollama launch claude --model <name>` command does, and gives `prorab` a clean, well-supported path to run cloud-hosted non-Anthropic models through the Claude Code SDK.

## Goals

- New CLI/UI agent option `ollama` selectable via `--agent ollama --model <model>`.
- Routes Claude Agent SDK traffic through `http://127.0.0.1:11434` (or `OLLAMA_HOST` if set).
- Cloud-only models in `listModels()` (filtered by `:cloud` suffix).
- Clear preflight errors when the daemon is not running or the model is not accessible.
- No new long-running infrastructure: relies on the user's already-running `ollama serve`.

## Non-Goals (out of scope)

- Auto-starting `ollama serve`.
- Local (non-cloud) Ollama models as a coding agent.
- `effort`/variant dropdown in UI for ollama models (these models do not honor Claude's effort param).
- A hardcoded `model → context-window` table for `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. We derive context from the `[1m]`/`[200k]` suffix when present and omit the env var otherwise (Claude Code falls back to its default).
- A parallel `ollama-codex` integration.
- Migration or removal of existing CCS `ollama-*` profiles. The two paths coexist; user chooses.

## Architecture

### Strategy: composition over `ClaudeDriver`

Mirror the proven `CcsDriver` pattern. New file `src/core/drivers/ollama.ts` defines `OllamaDriver` that wraps a `ClaudeDriver` and supplies a per-session `env` override.

```typescript
export class OllamaDriver implements AgentDriver {
  private inner: ClaudeDriver | null = null;
  private sessionEnv?: Record<string, string>;

  constructor(private model?: string, private useUserSettings = false) {}

  async setup(opts: SetupOptions): Promise<void> {
    if (!this.model) throw new Error("Ollama agent requires a model");
    await this.preflight();             // §Preflight
    this.inner = new ClaudeDriver(this.model, this.useUserSettings);
    this.sessionEnv = this.buildEnv();  // §Env vars
    await this.inner.setup?.(opts);
  }

  async teardown(): Promise<void> { /* mirror CcsDriver */ }

  // runSession / startChat / sendMessage / replyQuestion / abortChat
  // → delegate to inner ClaudeDriver, injecting sessionEnv into options
  //   exactly as CcsDriver does.

  async listModels(): Promise<ModelEntry[]> { /* §listModels */ }
}
```

### Why composition (and not the alternatives)

- **Composition over `ClaudeDriver`** — chosen. `ClaudeDriver` already handles signal parsing, chat lifecycle, hooks, AskUserQuestion bridge, abort, retries. We only need to inject env vars. `CcsDriver` proves this pattern works.
- Subprocess wrapping `ollama launch claude` — rejected. Defeats prorab session management; we lose ChatEvent stream, signal parsing, AskUserQuestion bridge, SIGINT, structured logging.
- Standalone driver talking directly to `127.0.0.1:11434/v1/messages` — rejected. Reimplements streaming, tool-use protocol, AskUserQuestion plumbing for no functional gain.

## Setup flow

### Env vars (mirrors `ollama launch claude` exactly)

```typescript
const host = process.env.OLLAMA_HOST?.trim() || "127.0.0.1:11434";
const baseUrl = host.startsWith("http") ? host : `http://${host}`;

const env: Record<string, string> = { ...process.env };
env.ANTHROPIC_BASE_URL = baseUrl;
env.ANTHROPIC_AUTH_TOKEN = "ollama";        // sentinel — daemon recognizes
env.ANTHROPIC_API_KEY = "";                 // explicit empty: don't leak host env
env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
env.CLAUDE_CODE_SUBAGENT_MODEL = model;     // sub-agent calls also stay on the chosen model
env.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";

const ctx = parseContextWindow(model);      // [1m]→1_000_000, [200k]→200_000, [128k]→128_000, otherwise null
if (ctx) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(ctx);
```

### `parseContextWindow(model: string): number | null`

Regex: `/\[(\d+)([km])\]/i`. Matches the size hint inside square brackets in the model id (e.g., `deepseek-v4-pro:cloud[1m]`). `m` → ×1_000_000; `k` → ×1_000. No match → `null` and we skip the env var.

### `OLLAMA_HOST` handling

Honored exactly like Ollama's own Go `envconfig.Host()`:

- `OLLAMA_HOST=192.168.1.10:11434` → `http://192.168.1.10:11434`
- `OLLAMA_HOST=https://my-ollama.example.com` → kept as-is
- Unset → `http://127.0.0.1:11434`

### Preflight (in `setup()`)

Two-step:

1. **Daemon reachable.** `fetch(${baseUrl}/api/version, { signal: AbortSignal.timeout(2000) })`. On reject or non-2xx → throw:

   > `Ollama daemon is not reachable at <baseUrl>. Start it with: ollama serve`

2. **Cloud model accessible.** If `model.includes(":cloud")` → call `this.listModels()`; if the requested id is not in the result → throw:

   > `Model '<m>' is not available via ollama. Check 'ollama signin' status, or pick from: <list>`

We deliberately do not probe `~/.ollama/id_ed25519` separately — that file is created on first daemon start, before any signin, and so its presence guarantees nothing. The "is the cloud model visible to my daemon" check above is the actual signal of "signed in for this model".

## `listModels()`

```typescript
async listModels(): Promise<ModelEntry[]> {
  const baseUrl = this.resolveBaseUrl();
  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2000) });
  } catch {
    return [];                          // daemon down / network error → empty list
  }
  if (!resp.ok) return [];
  let data: { data?: Array<{ id: string }> };
  try {
    data = await resp.json();
  } catch {
    return [];
  }
  return (data.data ?? [])
    .filter((m) => typeof m.id === "string" && m.id.includes(":cloud"))
    .map((m) => ({ id: m.id, name: m.id }));
                                        // no `variants` field → UI hides effort dropdown
}
```

**Error contract:** any failure (network error, non-200, malformed JSON, missing `data` array) → `[]`. UI presents an empty dropdown; user understands they need to start the daemon or sign in.

**Open assumption:** the response shape is the standard OpenAI-compat `{ data: [{ id, ... }] }`. Verified empirically during implementation; if Ollama's `/v1/models` shape differs, adjust parsing only — design unchanged.

## CLI / UI / wiring

- **`src/types.ts`** — extend `AgentType` (and any matching zod validator) with `"ollama"`.
- **`src/core/drivers/factory.ts`** — add `case "ollama": return new OllamaDriver(model, useUserSettings);`.
- **`src/index.ts` (commander)** — `--agent` already accepts a string; add `"ollama"` to validation/help.
- **UI** — add `"ollama"` to the agents list in the relevant Pinia store / const (1–2 small edits).
- **Docs** — append `OllamaDriver` section in `.claude/rules/drivers.md`; mention in CLAUDE.md `Tech Stack` / drivers list.

## Error handling summary

| Condition | Surface | Message |
|---|---|---|
| `--agent ollama` without `--model` | `setup()` throws | `Ollama agent requires a model` |
| Daemon not reachable | `setup()` throws | `Ollama daemon is not reachable at <url>. Start it with: ollama serve` |
| Daemon up, requested cloud model missing from `/v1/models` | `setup()` throws | `Model '<m>' is not available via ollama. Check 'ollama signin' status, or pick from: <list>` |
| `listModels()` daemon down / network error | returns `[]` | UI shows empty dropdown |
| Auth failure at request time (signed in but model rejected) | bubbles up from SDK | SDK's own 401 — ideally already filtered by preflight; if not, surfaces unchanged |

## Testing — `src/__tests__/ollama-driver.test.ts`

Mirrors `ccs-driver.test.ts` patterns. Mock `fetch` via `vi.stubGlobal("fetch", ...)`; mock `ClaudeDriver` (constructor returns object with `setup`/`teardown`/`runSession`/etc. mocks).

1. `OllamaDriver()` without model → `listModels()` works, `setup()` throws.
2. `setup()` throws "daemon not reachable" when `fetch` rejects or returns non-OK.
3. `setup()` throws "model not available" when the requested cloud model is missing from the `/v1/models` response.
4. `setup()` builds env: `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY=""`, four model defaults, `CLAUDE_CODE_ATTRIBUTION_HEADER=0`.
5. `setup()` honors `OLLAMA_HOST=192.168.1.10:11434` → `ANTHROPIC_BASE_URL=http://192.168.1.10:11434`; with explicit `https://my-ollama.example.com` the URL is kept as-is.
6. `setup()` sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW=1000000` for `[1m]`, `200000` for `[200k]`; omits the var when no suffix.
7. `runSession`/`startChat` inject `sessionEnv` into the inner `ClaudeDriver` call.
8. `teardown()` clears `inner` and `sessionEnv`; subsequent calls throw "not initialized".
9. `listModels()` filters to `*:cloud*` only and returns `[]` on daemon down / non-OK / malformed JSON.

## Implementation footprint estimate

- New file `src/core/drivers/ollama.ts` — ~200 lines.
- New file `src/__tests__/ollama-driver.test.ts` — ~250 lines.
- Edits in `factory.ts`, `types.ts`, `index.ts`, UI const, docs — ~30 lines total.

Total: ~1 implementation file + 1 test file + small wiring/docs touches.

## Verification

End-to-end sanity (manual, on the user's machine):

1. `ollama serve` running, `ollama signin` done.
2. `prorab serve` → web UI lists `ollama` agent → dropdown contains `*:cloud` models from `/v1/models`.
3. Select `deepseek-v4-pro:cloud[1m]`, run a small task → request hits `127.0.0.1:11434/v1/messages` (verifiable via `tcpdump -i lo` or daemon logs), response streams back as normal Claude SDK output.
4. Stop `ollama serve` → re-run → setup throws the daemon-not-reachable error.
5. With daemon up but `ollama signout` first → setup throws the model-not-available error.

Automated:

- `npm test -- ollama-driver` runs the new test file (9 cases above).
- `npm run build` passes (TypeScript) — verifies `factory.ts` and `types.ts` integration.
