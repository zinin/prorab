---
paths: "src/__tests__/**/*.ts"
---

# Testing

## Browser Smoke Harnesses (`src/__tests__/harness/`)

Standalone Fastify servers for deterministic browser smoke testing without a live LLM. Each harness serves the SPA from `ui/dist`, implements minimum API surface, listens on `port: 0` (random free port), prints `HARNESS_PORT=<port>` and `HARNESS_URL=<url>` on stdout. SIGTERM to shut down (cleans up temp directory).

### parse-prd-smoke-server.ts

Fixture: PRD present, no tasks.json. Implements `GET /api/status`, `GET /api/models`, `POST /api/parse-prd` (scripted agent events), `DELETE /api/parse-prd` (cancels with `cancelled` outcome). `?mode=failure` terminates with failure after scripted steps. WS sends `connected` + `replay:complete`.

### invalid-tasks-smoke-server.ts

Fixture: invalid tasks.json (malformed JSON), no PRD. Status: `hasTasksFile: true, hasValidTasks: false`. No parse-prd endpoints — verifies error state renders without CTA buttons.

### chat-wizard-smoke-server.ts

Fixture: no PRD, no tasks.json. Status: `hasPrd: false, hasTasksFile: false, hasValidTasks: false`. Triggers `wizard-chat` view mode. No session endpoints.

### task-list-smoke-server.ts

Fixture: valid tasks.json (4 sample tasks) + PRD. Status: `hasPrd: true, hasTasksFile: true, hasValidTasks: true`. Triggers `task-list` view mode. Static data, no session endpoints.

### expand-smoke-server.ts

Standalone scripted Fastify server for browser smoke tests. Scripted agent events with timing, simulated file writes, success/failure modes via `?mode=failure`. Implements `/api/status`, `/api/tasks`, `/api/expand`, POST/DELETE `/api/tasks/:id/expand`, `/ws`.

## Expand Test Suites

### Unit Tests
- `expand-no-write-guarantee.test.ts` — agent failure, parse failure, validation failure, hash conflict, multi-tag hash conflict, user cancellation; verifies no writes on any failure path (REQ-007)
- `expand-noop-success.test.ts` — `{ "subtasks": [] }` is valid success; backend, re-expand eligibility, UI helpers (REQ-005)
- `expand-commit-failed-after-write.test.ts` — post-write git failure: outcome correctness, no-rollback guarantee, broadcast events, UI store integration, UI helpers
- `expand-eligibility-contract.test.ts` — completeness of expand API contract: reason codes ↔ UI mappings, HTTP statuses, stop reasons, launch gating, reload predicates (REQ-012)

### Integration Tests
- `expand-no-write-integration.test.ts` — real file I/O, byte-by-byte comparison, real SHA-256 hashing, concurrent mutation detection
- `expand-noop-integration.test.ts` — real file I/O, full validation→write pipeline, byte-identical preservation
- `expand-multi-tag.test.ts` — multi-tag tasks.json: write preservation, hash conflict detection, no-op, Zod key reordering, serialization, first-tag selection
- `expand-e2e-pipeline.test.ts` — real Fastify server, mocked agent, happy-path: write → commit → WS events → REST state → store transitions
- `expand-git-preflight.test.ts` — real Fastify server, all git preconditions, rejection/priority/allowance tests (REQ-008)
- `expand-smoke.test.ts` — real HTTP + WS, full expand flow, error cases, SPA shell
- `expand-reconnect-stop.test.ts` — WS reconnect, stop behavior, connected snapshot, store rehydration, event channel integrity

## Batch Expand Test Suites

### Unit Tests
- `batch-expand-progress-logic.test.ts` — progress logic helpers
- `batch-expand-progress-component.test.ts` — BatchExpandProgress component rendering
- `batch-expand-launch-helpers.test.ts` — launch gating helpers
- `batch-expand-store-focus.test.ts` — store state machine and WS event handling

### Complexity Tests
- `complexity-validation.test.ts` — parse + validate complexity agent results
- `write-complexity-fields.test.ts` — `writeComplexityFields()` integration with tasks.json

## Test Configuration

Tests run via `vitest` only (not compiled by `tsc`). Test files may import from `../../ui/src/` which is outside `rootDir`.

## Port Allocation in Tests

Never hardcode port 3000. Use `findFreePort()` from `core/net-utils.ts` or `listen({ port: 0, host: "127.0.0.1" })` and read actual port from `server.address()`.
