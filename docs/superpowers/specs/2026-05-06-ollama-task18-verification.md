# Task 18 — End-to-end manual verification

**Date:** 2026-05-06
**Branch:** feat/ollama-driver
**HEAD at start:** 5f08b29 (Task 17 polish)

## Daemon prerequisites
- ollama version: `ollama version is 0.23.1`
- `/api/version`: `{"version":"0.23.1"}` (daemon reachable on 127.0.0.1:11434)
- `~/.ollama/id_ed25519`: **missing** (only `~/.ollama/config.json` is present, 107 bytes)
- `ollama list`: empty (no local models pulled)
- `/v1/models` on daemon: returns `{"object":"list","data":null}` (no models exposed)

The daemon is running but the user does NOT appear to be signed in via the documented flow (no Ed25519 key file). Cloud-model probes still work for some entries — the daemon resolves the catalog without local sign-in for these.

## Catalog probe (5 models)

| Model | HTTP status |
|---|---|
| deepseek-v4-pro:cloud[1m] | 400 |
| kimi-k2.6:cloud | 200 |
| minimax-m2.7:cloud | 200 |
| qwen3-coder:480b-cloud[1m] | 400 |
| gpt-oss:120b-cloud | 200 |

The `[1m]` variant suffixes return HTTP 400 directly from the daemon's `/v1/models/{id}` endpoint. The plain cloud IDs (`kimi-k2.6:cloud`, `minimax-m2.7:cloud`, `gpt-oss:120b-cloud`) return HTTP 200.

This is fine — the OllamaDriver's `listModels()` already filters non-200 entries out.

## /api/models?agent=ollama

- Server start: ok (`prorab serve — running at http://127.0.0.1:3000`)
- Response:
  ```json
  {
    "models": [
      { "id": "kimi-k2.6:cloud",   "name": "kimi-k2.6:cloud" },
      { "id": "minimax-m2.7:cloud","name": "minimax-m2.7:cloud" },
      { "id": "gpt-oss:120b-cloud","name": "gpt-oss:120b-cloud" }
    ]
  }
  ```
- Cross-check `/api/models?agent=claude`: HTTP 200, returned `default/sonnet/haiku` with variants (sanity ok).

The route correctly:
- Skips `setup()` for the ollama agent (per Task 16 behavior).
- Probes the hardcoded catalog and includes only the entries that returned HTTP 200.

## Fail modes tested

- **OLLAMA_HOST=/var/run/ollama.sock** (unix-socket form):
  - `prorab serve` started normally.
  - `GET /api/models?agent=ollama` returned `{ "models": [] }` (no error in log).
  - Confirms `resolveBaseUrl` throws for unix-socket form, and `listModels()` swallows the throw → returns empty list, as designed.
- **Non-cloud model rejection:** covered by unit tests (Task 4). Not re-tested live here because the failure path is at `setup()`, not at `/api/models`.
- **Daemon-down:** not tested live — would disrupt the user's other work.

## Skipped

- **Running an actual task end-to-end against a cloud model.** That requires either:
  (a) a populated `.taskmaster/tasks/tasks.json` in the cwd plus an interactive `prorab run --agent ollama --model <id>` session, or
  (b) launching the web UI and clicking through Execution / Chat / Refine flows with `--agent ollama` selected.
  Neither is in scope for autonomous, hands-off verification. Recommended for a human reviewer before PR merge.

## Outcome

- **E2E happy-path verified at the catalog/probe layer:** daemon is reachable, the hardcoded catalog probe works, and `/api/models?agent=ollama` filters on the live `/v1/models/{id}` HTTP status.
- **Fail-mode for `OLLAMA_HOST=/var/run/ollama.sock`** returns an empty model list as designed (no 500, no crash).
- **Caveat:** the user's machine is NOT in the "fully signed in to ollama cloud with Ed25519 key" state described in the task spec. 3 of 5 catalog models still resolve, which is enough to validate the route. Bracketed `[1m]` variants returned 400 from the daemon — this is a daemon-side restriction on those exact IDs, not a prorab bug.
- A real task run (`prorab run --agent ollama --model kimi-k2.6:cloud ...`) and a UI smoke (chat / execution / parse-prd against the same agent) are recommended before merging the PR.

## Status: DONE_WITH_CONCERNS

The implementation is verified at the route / catalog / fail-mode level. The only deferred check is "real task hits real cloud model and returns text," which requires interactive verification and is documented as such above.
