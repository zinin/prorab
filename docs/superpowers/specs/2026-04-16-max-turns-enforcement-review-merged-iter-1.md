# Merged Design Review — Iteration 1

Source design: `docs/superpowers/specs/2026-04-16-max-turns-enforcement-design.md`
Source plan:   `docs/superpowers/plans/2026-04-16-max-turns-enforcement.md`

## codex-executor (gpt-5.4 xhigh)

## [ARCH-1] `maxTurns`-ошибка не попадает в retry-механику

**Где:** design §Goals.5 и §Failure behavior / plan tasks 4–6 / `src/commands/run.ts:136-386`, `564-663`, `773-856`, `1057-1063`.
**Проблема:** design исходит из того, что breach вернётся как `signal:error` и дальше пойдёт в существующий `--max-retries` loop. В коде этого нет: `executeUnit()` на любом `signal:error` сразу выходит без retry, review/aggregator вообще запускаются по одному разу, rework тоже не ретраится.
**Почему важно:** после внедрения лимита `reviewMaxTurns` станет жёстким фейлом с первого срабатывания, а не "soft fail" с повторной попыткой. Это ломает основной recovery-сценарий из design.
**Предложение:** ввести отдельный retryable-код (`error.code = "max_turns_exceeded"`) и обрабатывать его в общей retry-обёртке; либо вынести review/aggregator/rework на тот же attempt-runner, что execute, и отдельно определить, как такие retries расходуют `maxIterations`.

## [CODE-1] Плановый sentinel/boolean в Codex маскирует посторонние ошибки

**Где:** plan task 6 step 3, catch-ветка.
**Проблема:** предложенная проверка `maxTurnsExceeded || signal.reason._prorabMaxTurns === sentinel` переписывает в `Max turns exceeded` любой exception после того, как флаг успели поднять. Если после лимита прилетит другая ошибка SDK/логгера/обработки события, она будет скрыта.
**Почему важно:** диагностика станет ложной, а retry/policy будет приниматься по неправильной причине.
**Предложение:** бросать отдельный `MaxTurnsExceededError` прямо из loop; либо различать только по `signal.aborted && signal.reason`; либо использовать `err.name === "MaxTurnsExceeded"` как единственный marker.

## [GAP-1] Добавление обязательного `reviewMaxTurns` ломает существующие typed fixtures

**Где:** plan task 1 / `src/__tests__/execute-review-rework.test.ts:116-128`, `src/__tests__/run-attempt-counter.test.ts:108-120`.
**Проблема:** план делает `RunOptions.reviewMaxTurns` и `ExecuteOptions.reviewMaxTurns` обязательными, но обновляет только `execution-manager.test.ts`. Уже существующие литералы `RunOptions` в тестах останутся без нового поля и уронят `tsc`.
**Почему важно:** task 1 step 4 ожидает зелёный `npm run build`, но он упадёт до любой функциональной проверки.
**Предложение:** добавить отдельную задачу на sweep всех `RunOptions`/`ExecuteOptions` fixtures; либо держать поле optional внутри типов и дефолтить его только на CLI/API boundary.

## [TEST-1] Предложенный тест routing-а ничего не проверяет и не покрывает aggregator path

**Где:** plan task 4 steps 1–3 / `src/commands/run.ts:590-600`, `776-786`.
**Проблема:** `run-routes-review-max-turns.test.ts` не вызывает `executeReviewCycle()` и фактически проверяет только `expect(options.reviewMaxTurns).toBe(42)`. "Богатый" follow-up assertion описан только для reviewer path; aggregator callsite остаётся без проверки.
**Почему важно:** тест может стабильно проходить при полностью сломанной маршрутизации `reviewMaxTurns`, особенно для aggregation.
**Предложение:** убрать smoke-test; в `execute-review-rework.test.ts` реально прогнать single-review и multi-review с aggregation и заассерить `maxTurns` для execute/reviewer/aggregator/rework по отдельности.

## [GAP-2] `turnUsage` не сбрасывается на смене фаз

**Где:** plan tasks 8–10 / `ui/src/composables/useWebSocket.ts:217-325`, `ui/src/stores/execution.ts:83-90`.
**Проблема:** план добавляет `turnUsageByUnit`, но сбрасывает его только в `startExecution()`. Сейчас на `execution:started`, `execution:review_started`, `execution:rework_started`, `execution:multi_review_started` очищается только `contextUsageByUnit`.
**Почему важно:** после execute → review → rework или между review rounds header может показывать старый `TURNS n / N` до первого нового `agent:turn_count`.
**Предложение:** чистить `turnUsageByUnit` везде, где уже чистится `contextUsageByUnit`, плюс на `connected`/`execution:all_done`.

## [TEST-2] Для `agent:turn_count` нет автоматического теста маршрутизации WS/UI

**Где:** plan tasks 7–10 / `ui/src/composables/useWebSocket.ts:295-303`, `src/__tests__/ws-channel-routing.test.ts`.
**Проблема:** новая фича зависит от отдельного `case "agent:turn_count"` в `useWebSocket`, но план предлагает только type-check и manual smoke.
**Почему важно:** пропуск одного switch-case не ловится ни store-тестом, ни `vue-tsc`; индикация может молча не работать.
**Предложение:** добавить кейс в `ws-channel-routing.test.ts` на `agent:turn_count` → `execStore.updateTurnUsage`, и короткий integration-test store/view.

## [RISK-1] Abort по лимиту занулит метрики и скроет реальную цену runaway-сессий

**Где:** plan task 5 step 4 / plan task 6 step 3 / `src/core/drivers/opencode.ts:1515-1525`.
**Проблема:** OpenCode через `errorResult()` отдаёт нулевые `duration/tokens/cost`, а план для Codex в catch делает то же самое. При max-turns abort фактические траты и длительность сессии теряются.
**Почему важно:** оператор увидит "дешёвый" фейл там, где модель успела сжечь большой контекст и десятки tool calls.
**Предложение:** возвращать частично накопленные метрики в error-result; минимум сохранить `numTurns`, `durationMs` и уже известные token/cost counters.

---

## gemini-executor

## [ARCH-1] Механизм `maxTurns` breach противоречит роутингу в `run.ts`

**Где:** Design §Failure behavior / `src/commands/run.ts`
**Проблема:** Спецификация утверждает, что при возврате `{ signal: { type: "error" } }` сработает стандартный цикл восстановления `--max-retries`. На самом деле, в `run.ts` метод `executeUnit` при получении сигнала `"error"` завершает работу немедленно (`return false`) без каких-либо ретраев. Более того, в `executeReview` вообще нет цикла `--max-retries` — при падении единственного ревьюера с `"error"`, таска моментально уходит в `blocked`.
**Почему важно:** Запланированный fail-soft механизм восстановления сессии не сработает. Сессия будет жестко прервана.
**Предложение:** Если ретрай действительно нужен: драйверы должны возвращать сигнал `"none"` вместо `"error"`. Либо: обновить логику `run.ts`, добавив явную обработку `MaxTurnsExceeded` для запуска ретраев даже при `"error"`.

## [CODE-1] CodexDriver: отсутствие `AbortController` ломает прерывание цикла

**Где:** Plan Task 6 / `src/core/drivers/codex.ts`
**Проблема:** При превышении лимита план предлагает прерывать `for await` цикл вызовом `opts.abortController?.abort(err)`. Поскольку `abortController` является опциональным параметром, при его отсутствии метод `abort` не вызовется. Локальный генератор событий продолжит работу, а флаг `maxTurnsExceeded` просто зависнет в памяти.
**Почему важно:** Защита от бесконечного цикла не сработает.
**Предложение:** Добавить явный проброс исключения: `if (opts.abortController) { opts.abortController.abort(err); } throw err;`

## [CODE-2] ClaudeDriver: недоступность `opts.maxTurns` в обработчиках сообщений

**Где:** Plan Task 7, Step 4 / `src/core/drivers/claude.ts`
**Проблема:** План предписывает отправлять событие `agent:turn_count` внутри метода, обрабатывающего `assistant` сообщения. Для этого требуется `opts.maxTurns` и `opts.unitId`. Однако объект `opts` недоступен в контексте `handleAssistant` (он принимает только `msg` и `ctx: ClaudeContext`).
**Почему важно:** Предложенный код не скомпилируется — `ReferenceError: opts is not defined`.
**Предложение:** Добавить `maxTurns: number | undefined` в интерфейс `ClaudeContext`; сохранять значение из `opts.maxTurns` в методе `createContext`; использовать `ctx.maxTurns` и `ctx.unitId`.

## [INCONS-1] Место сохранения настроек `reviewMaxTurns` на клиенте

**Где:** Design §UI Configuration / Plan Task 8, Task 10.
**Проблема:** Дизайн требует сохранять `reviewMaxTurns` внутри стора `ui/src/stores/execution.ts` через `usePersistedRef` и также добавлять его в глобальный `ui/src/composables/useSessionDefaults.ts`. План (справедливо) это игнорирует и кладет `usePersistedRef` напрямую в компонент `ui/src/views/ExecutionView.vue`.
**Почему важно:** Спецификация предлагает антипаттерн (персистентные рефы внутри очищаемого стора execution) и расходится с планом.
**Предложение:** Обновить спек, закрепив, что `reviewMaxTurns` сохраняется через `usePersistedRef` только в слое представления.

## [GAP-1] Отсутствие обновлений для тестов `ws-channel-routing` и `ClaudeDriver`

**Где:** Design §Testing / Plan.
**Проблема:** В секции тестирования дизайн-документа прямо указано требование: «Extend `src/__tests__/ws-channel-routing.test.ts`...». План упускает этот файл. Также план добавляет новую логику `agent:turn_count` в `ClaudeDriver`, но не включает обновление тестов `claude-*.test.ts`.
**Почему важно:** Снижение покрытия.
**Предложение:** Добавить шаги для обновления фикстур и тестов `ws-channel-routing.test.ts` и `claude-*.test.ts`.

## [RISK-1] Бесконечный цикл без вызовов инструментов в CodexDriver

**Где:** Design §CodexDriver (Why not count all items).
**Проблема:** `CodexDriver` увеличивает `toolCalls` только на событиях `item.completed` с типами тулзов. Если модель галлюцинирует и входит в бесконечный цикл генерации исключительно текстовых `agent_message` (или `reasoning`), счетчик тулзов останется на нуле.
**Почему важно:** В таком сценарии лимит `maxTurns` не будет достигнут, и сессия все равно станет бесконечной.
**Предложение:** Добавить предохранитель: считать любые итерации ответа модели, но с увеличенным fallback-лимитом (например, hard throw если количество ходов без тулзов превысило `maxTurns * 2`).

---

## ccs-executor (glm-5)

## [CODE-1] OpenCode: `errorResult()` обнуляет все метрики при превышении maxTurns

**Где:** plan Task 5 Step 4 / `src/core/drivers/opencode.ts:1515` (функция `errorResult`).
**Проблема:** При превышении `maxTurns` вызывается `ctx.errorResult = errorResult(...)`. Функция `errorResult()` возвращает `numTurns: 0, durationMs: 0, costUsd: 0`, а также нулевые `inputTokens`/etc. Цикл `runSession` делает `return ctx.errorResult`, теряя все накопленные в `ctx` метрики. Для сравнения, в Codex catch-блок корректно возвращает `numTurns: Math.max(1, toolCalls)`.
**Почему важно:** После 100 шагов `IterationResult` покажет 0 токенов, 0 стоимости, 0 ходов. Retry не видит реальной стоимости предыдущей попытки.
**Предложение:** Вместо `errorResult(...)` собирать результат из текущего `ctx` через `this.buildIterationResult(ctx, { type: "error", message: ... })`. Это сохранит накопленные метрики, как делает Codex.

## [INCONS-1] Design и план используют разные механизмы различения maxTurns-abort в Codex

**Где:** design §Driver changes → CodexDriver; plan Task 6 Step 3.
**Проблема:** Design описывает `err.name = "MaxTurnsExceeded"` + `signal.reason.name === "MaxTurnsExceeded"`. План реализует `Symbol("MaxTurnsExceeded")` + `_prorabMaxTurns` на объекте Error.
**Почему важно:** Если реализатор следует design — получится менее надёжный код. Если плану — документация расходится с реализацией.
**Предложение:** Обновить design: заменить `err.name` на Symbol-based sentinel, либо явно документировать выбор.

## [GAP-1] ClaudeDriver: `agent:turn_count` emission не конкретизирована

**Где:** plan Task 7 Step 4; `src/core/drivers/claude.ts`.
**Проблема:** План говорит: *"find where each assistant message is processed..."* Но в `ClaudeDriver.runSession` **нет собственного счётчика ходов** — `ctx.numTurns` устанавливается один раз в `handleResult` из `msg.num_turns`. `handleAssistant` может вызываться несколько раз за один SDK-ход. `handleStreamEvent` с `message_start` — один раз за API-вызов и уже эмитит `context_usage`.
**Почему важно:** Без точного указания места реализатор может эмитить на каждом content block (завышая счётчик) или пропустить эмиссию.
**Предложение:** Конкретизировать: эмитить в `handleStreamEvent` при `event.type === "message_start"`, рядом с существующей эмиссией `context_usage`. Добавить локальный счётчик `numApiCalls++`.

## [GAP-2] `useSessionDefaults.ts` не включён в план

**Где:** plan §File Structure и Task 8.
**Проблема:** Design указывает добавить `reviewMaxTurns: 100` в `useSessionDefaults.ts`, но план не содержит задачи для этого файла.
**Почему важно:** Если `useSessionDefaults` предоставляет дефолты для UI, отсутствие `reviewMaxTurns` может привести к `undefined` в UI до первого ручного ввода.
**Предложение:** Добавить шаг в Task 8 или Task 10: обновить `useSessionDefaults.ts`.

## [GAP-3] Тест WS-маршрутизации `agent:turn_count` отсутствует в плане

**Где:** design §Testing → WS.
**Проблема:** Design требует расширить `ws-channel-routing.test.ts`, но план не содержит задачи для этого.
**Предложение:** Добавить шаг в Task 7 или Task 9: расширить `ws-channel-routing.test.ts` кейсом для `agent:turn_count`.

## [ARCH-1] Кросс-драйверная семантика «хода» различается, но `maxTurns` единый

**Где:** design §Driver changes (OpenCodeDriver vs CodexDriver).
**Проблема:** OpenCode считает `step-finish`; Codex — tool-call; Claude — assistant turns. При `maxTurns=100`: OpenCode может выполнить 100 LLM-вызовов (каждый с несколькими tool-use → потенциально тысячи tool-вызовов), Codex — 100 tool-вызовов, Claude — 100 SDK-ходов.
**Почему важно:** Для multi-reviewer один и тот же `reviewMaxTurns=100` даёт radically different headroom.
**Предложение:** Либо явно документировать семантику каждого драйвера в CLI help, либо нормализовать. Как минимум — добавить в Risks.

## [TEST-1] Task 4: smoke-тест не тестирует реальную маршрутизацию

**Где:** plan Task 4 Step 1.
**Проблема:** Тест содержит `expect(options.reviewMaxTurns).toBe(42)` — тривиальная проверка локальной константы.
**Почему важно:** CI покажет зелёный, хотя маршрутизация может быть сломана.
**Предложение:** Удалить Step 1/2 и объединить с Step 3, либо заменить на реальный тест с `vi.doMock` и вызовом `executeReviewCycle`.

## [CODE-2] Мёртвый код в тесте Codex

**Где:** plan Task 6 Step 1 — переменная `threadStarted` определена, но не используется (везде вызывается `thread_started_like()`).
**Предложение:** Удалить неиспользуемую константу.

## [RISK-1] Codex: abort срабатывает внутри `item.completed`, но stream может обработать ещё события

**Где:** plan Task 6 Step 3.
**Проблема:** `abortController.abort(err)` может не разорвать `runStreamed`-итератор мгновенно. Цикл может обработать ещё несколько событий (reasoning, agent_message) перед попаданием в catch. `resultText` может накопить текст от последующих `agent_message` событий.
**Предложение:** Добавить guard: `if (maxTurnsExceeded) break;` в начало итерации `for await`.

## [INCONS-2] Plan Task 1: `reviewMaxTurns` в `ExecuteOptions` не проходит через ExecutionManager в RunOptions

**Где:** plan Task 1 Step 2; `src/server/execution-manager.ts:176`.
**Проблема:** В `ExecutionManager.start()` `runOptions` конструируется в методе, указание «around line 176» может быть неточным.
**Предложение:** Уточнить: найти место где формируется `RunOptions` (передача в `executeUnit`/`executeReviewCycle`).

---

## ccs-executor (albb-glm / glm-5)

## [CODE-1] Claude driver не может emit turn_count incrementally

**Где:** plan Task 7 Step 4 / `src/core/drivers/claude.ts`.
**Проблема:** Claude Agent SDK **не предоставляет incremental numTurns** — только final `num_turns` в `result` message. `handleAssistant` не имеет turn count; `handleStreamEvent` получает `message_start` с token usage, не turn number.
**Почему важно:** План непрактичен — UI indicator будет показывать 0 до конца session, затем final value.
**Предложение:** Реализовать локальный counter в `handleAssistant` (increment per assistant message), emit там. Обновить design/plan.

## [CODE-2] Codex abort без abortController не остановит session

**Где:** plan Task 6 Step 3.
**Проблема:** `opts.abortController?.abort(err)` — optional chaining. Если undefined, abort не вызывается, session продолжает.
**Предложение:** Require `abortController` в `SessionOptions` (throw если absent when `maxTurns > 0`), или добавить fallback — throw error внутри event loop чтобы break stream.

## [CODE-3] Sentinel `_prorabMaxTurns` — hacky pattern

**Где:** plan Task 6 Step 3.
**Проблема:** Implicit coupling через property mutation. Если error object frozen, assignment может fail silently. AbortSignal.reason может не preserve custom properties.
**Предложение:** Создать `class MaxTurnsExceededError extends Error`. Catch block проверяет `err instanceof MaxTurnsExceededError`.

## [TEST-1] Mock pattern в run-routes test может не работать

**Где:** plan Task 4 Step 1.
**Проблема:** Vitest ES modules mocking требует `vi.mock` **перед** top-level import, или `vi.resetModules()` + dynamic import.
**Предложение:** Использовать стандартный Vitest pattern: `vi.mock(...)` + статический импорт.

## [INCONS-1] UI payload не включает reviewMaxTurns в plan snippet

**Где:** plan Task 10 Step 2.
**Проблема:** Текущий `startExecution` options type не включает `reviewMaxTurns` — нужно добавить в interface.
**Предложение:** Plan Step 1 должен явно указать extension `startExecution` interface type.

## [GAP-1] Нет явного шага для driver-runner.test.ts update

**Где:** plan File Structure / "Modified (tests)".
**Проблема:** План говорит "update stubSessionOpts if needed", но не дает конкретного шага.
**Предложение:** Добавить explicit step: "Run full test suite, fix any stubSessionOpts missing reviewMaxTurns".

## [RISK-1] Race condition между abort и stream continuation в Codex

**Где:** plan Task 6 Step 3.
**Проблема:** После `abortController.abort()`, `thread.runStreamed` stream может still yield несколько events (turn.completed, thread.finished) перед termination.
**Предложение:** Guard flag `maxTurnsExceeded` — skip processing events если flag set. Verify в catch block тоже.

## [ARCH-1] CcsDriver неявно covered через delegation — но не documented

**Где:** plan File Structure.
**Проблема:** File Structure не list CcsDriver — reader может думать что он missed.
**Предложение:** Add explicit note: "CcsDriver — no changes (inherits via ClaudeDriver delegation)".

## [TEST-2] Integration test не проверяет retry loop propagation

**Где:** plan Task 4 Step 3.
**Проблема:** Driver tests проверяют abort, но integration не проверяет full path: error signal → retry → second attempt.
**Предложение:** Добавить test case: mock reviewer driver returns `signal: { type: "error", message: "Max turns exceeded" }`, verify retry fires, verify second attempt succeeds.

## [CODE-4] numTurns: Math.max(1, toolCalls) — но toolCalls может быть 0 при immediate abort

**Где:** plan Task 6 Step 3.
**Проблема:** Если abort fires before any tool-call completed, `toolCalls === 0`, но `numTurns: 1` будет reported.
**Предложение:** Или keep `numTurns: 0` для aborted sessions, или emit `agent:turn_count` с `numTurns: 0` в catch block.

---

## ccs-executor (albb-qwen / qwen3.5-plus)

## [INCONS-1] Plan указывает изменение ExecuteOptions, но не RunOptions в types.ts

**Где:** plan task 1 vs design §"Types".
**Проблема:** Plan task 1 предписывает добавить `reviewMaxTurns` только в `ExecuteOptions`, но design явно требует изменения в `RunOptions`.
**Почему важно:** Без изменения `RunOptions` поле не сможет быть передано от CLI через `run.ts` в review/aggregator сессии.
**Предложение:** В task 1 явно включить шаг по изменению `src/types.ts:RunOptions`.

## [INCONS-2] Plan противоречит design в структуре ExecuteOptions

**Где:** plan task 1 vs design §"reviewMaxTurns wiring".
**Проблема:** Plan пересоздаёт интерфейс и опускает обязательные поля `variant`, `quiet`, etc.
**Предложение:** В plan указать "добавить `reviewMaxTurns` в существующий интерфейс" вместо пересоздания.

## [ARCH-1] CodexDriver: подсчёт toolCalls до проверки abort создаёт гонку

**Где:** plan task 6, step 3.
**Проблема:** Сначала `toolCalls++`, затем проверка лимита. При `maxTurns=2` счётчик станет 3 на момент abort, `numTurns` вернётся 3. UI покажет `TURNS 3 / 2`.
**Почему важно:** Design §"Edge cases" требует "off-by-one: comparison is `>=`, N turns complete successfully and (N+1)-th is not started" — план нарушает контракт.
**Предложение:** Проверка `if (opts.maxTurns && toolCalls + 1 >= opts.maxTurns)`, затем инкремент только если не abort. Либо возвращать `numTurns: toolCalls - 1` при abort.

## [CODE-1] Plan task 6: некорректная работа с AbortSignal.reason

**Где:** plan task 6, step 3.
**Проблема:** После `abort(err)` `signal.reason === err`, а не `{ _prorabMaxTurns: ... }`. Проверка не сработает.
**Предложение:** Создать `MaxTurnsExceededError extends Error`, проверять `signal.reason instanceof MaxTurnsExceededError`.

## [GAP-1] Отсутствие emit agent:turn_count в CCS driver

**Где:** design §"CcsDriver".
**Проблема:** Design говорит "CCS delegates", но plan task 7 предписывает emit только из opencode/codex/claude. Если CCS делегирует ClaudeDriver — emit произойдёт; если нет — UI не получит данные.
**Предложение:** Явно указать: "CCS driver делегирует → emit покрывает CCS".

## [RISK-1] UI store: отсутствие сброса turnUsageByUnit при batch-expand

**Где:** plan task 8, step 3.
**Проблема:** Сброс только в `startExecution()`, но batch-expand использует отдельный WS канал и не вызывает `startExecution()`.
**Предложение:** Добавить сброс в `BatchExpandManager.start()` или в WS handler.

## [TEST-1] Integration test для reviewMaxTurns retry не покрывает aggregator

**Где:** design §"Testing — Integration".
**Проблема:** Aggregator session использует тот же лимит, но не покрыт тестом.
**Предложение:** Второй тест: aggregator hitting `reviewMaxTurns` → retry → success.

## [CODE-2] Plan task 4: тест использует vi.doMock() для ESM

**Где:** plan task 4, step 1.
**Проблема:** Проект использует ESM. `vi.doMock()` + dynamic import работает для CJS, но для ESM требуется `vi.mock()` с hoisted factory.
**Предложение:** Использовать стандартный ESM-паттерн.

## [GAP-2] Отсутствие emit turn_count в ClaudeDriver для chat sessions

**Где:** design §"Non-goals" vs §"UI".
**Проблема:** Design исключает chat из scope, но plan task 7 предписывает emit из ClaudeDriver без различия runSession vs startChat. Если emit в chat, UI покажет `TURNS n / ∞`.
**Предложение:** Emit только для `runSession` (проверить `opts.maxTurns !== undefined`).

## [ARCH-2] OpenCodeDriver: abort session не гарантирует немедленную остановку SSE

**Где:** plan task 5, step 4.
**Проблема:** SSE stream может продолжить emit events до завершения abort. `handleStepFinish` будет вызван ещё N раз.
**Предложение:** Guard `if (ctx.errorResult) return;` в начало `handleStepFinish`.

---

## ccs-executor (albb-kimi / Kimi-K2.5)

## [ARCH-1] Несоответствие семантики "turn" между драйверами

Codex считает tool calls, OpenCode — step-finish, Claude — assistant messages. Один Claude turn = несколько Codex tool-calls.
**Предложение:** В Codex считать `turn.completed`, либо документировать различие.

## [ARCH-2] Гонка в CodexDriver abort-on-limit

Между `abort()` и попаданием в catch может прийти ещё один `item.completed`.
**Предложение:** Проверять `maxTurnsExceeded` в начале обработки каждого события.

## [INCONS-1] Противоречие: required vs optional поле reviewMaxTurns

Design требует `required`, но plan показывает без `?`, а текущий `RunOptions` не имеет поля.
**Предложение:** `reviewMaxTurns?: number` с дефолтом 100 внутри использующих функций.

## [INCONS-2] Несоответствие abort reason detection между design и plan

Design: `signal.reason.name === "MaxTurnsExceeded"`; plan: symbol-based.
**Предложение:** Использовать symbol-based, обновить design.

## [GAP-1] Отсутствие reviewMaxTurns в ExecuteBodySchema

Task 3 упоминает, но нужно проверить реализацию.
**Предложение:** Добавить `reviewMaxTurns: z.number().int().positive().default(100)`.

## [GAP-2] Отсутствие reviewMaxTurns в useSessionDefaults

Plan Task 8 требует, но файл не упомянут в списке модифицированных.
**Предложение:** Добавить `useSessionDefaults.ts` в план.

## [GAP-3] Не обновлён startExecution payload в ExecutionView.vue

Вызов идёт с `maxTurns`, но без `reviewMaxTurns`.
**Предложение:** Добавить `reviewMaxTurns: reviewMaxTurns.value` в payload.

## [TEST-1] Ненадёжный mocking OpenCode в тестах

`(driver as unknown as { client: unknown }).client = client;` нарушает инкапсуляцию.
**Предложение:** Тестовый конструктор `OpenCodeDriver.createForTesting(mockClient)`.

## [TEST-2] Нет теста на UI turn indicator

Нет ни одного теста, проверяющего рендеринг `Turns n / N`.
**Предложение:** Добавить component test.

## [RISK-1] Значение по умолчанию reviewMaxTurns=100 может быть агрессивным

Для сложных PR review может не уложиться.
**Предложение:** Поднять до 150/200 либо `maxTurns * 0.5`.

## [RISK-2] Отсутствие graceful degradation для старых WS клиентов

Новый `agent:turn_count` может вызвать ошибки у старых UI.
**Предложение:** Убедиться, что неизвестные типы событий silently ignored.

## [CODE-1] Ошибка в codex-max-turns.test.ts snippet

Используется `thread_started_like()`, но определена только константа `threadStarted`.
**Предложение:** Использовать `threadStarted` или определить функцию.

## [CODE-2] Обращение к ctx.maxTurns до инициализации

Убедиться что `maxTurns` добавлен в `OpenCodeContext` и в `createContext`.

## [CODE-3] Не импортирован errorResult в OpenCodeDriver для теста

`errorResult` private. Либо export для тестов, либо inline в тесте.

---

## ccs-executor (albb-minimax / MiniMax-M2.5)

## [ARCH-1] Ограничение whitelist для типов инструментов Codex

Если SDK добавит новый тип (например, `browser_action`), он не будет учитываться.
**Предложение:** Комментарий о необходимости обновления; fallback на "любой item с tool_call_id".

## [ARCH-2] Сложность обработки ошибки через Symbol sentinel

Паттерн `Symbol + _prorabMaxTurns` требует двух проверок в catch.
**Предложение:** Отдельный подкласс `class MaxTurnsExceededError extends Error`.

## [INCONS-1] Позиция emit для turn_count может показать некорректное значение

В `handleStepFinish` сначала `numTurns++`, затем проверка лимита, затем emit. При breach отправляется N/N, но сессия уже аборчена.
**Предложение:** Emit после проверки лимита; если `ctx.errorResult` установлен — не отправлять.

## [GAP-1] Тест маршрутизации reviewMaxTurns — smoke-тест

Тест только проверяет константу, не вызывает `executeReviewCycle`.
**Предложение:** Step 3 (расширение `execute-review-rework.test.ts`) должен выполняться ДО коммита Task 4.

## [GAP-2] Нет верификации CCS-делегирования с maxTurns

Нет unit-теста в `ccs-driver.test.ts`, проверяющего `maxTurns` через CCS-обёртку.
**Предложение:** Добавить unit-тест.

## [TEST-1] Неполный unit-тест для OpenCode maxTurns

Нет проверки что после abort сессия корректно завершает SSE-поток.
**Предложение:** Assertion на правильный sessionID и корректное завершение.

## [CODE-1] Опечатка в Zod-валидации плана

`reviewMaxTurns: z.coerce.number().int().positive()` без `.default(100)`.
**Предложение:** Добавить default или обработать undefined.

## [CODE-2] План Task 5 Step 4: неполная проверка условия

Race: abort отправлен, но `session.idle` не пришёл. Возможны множественные abort.
**Предложение:** Флаг `ctx.sessionAborted: boolean`.

## [CODE-3] В store `reviewerId` vs `reviewId`

Design использует `reviewerId`, `updateTurnUsage` в plan — `reviewId`.
**Предложение:** Унифицировать `reviewerId`.

## [RISK-1] Race condition при множественных step-finish

Между `abort()` и `session.idle` могут прийти ещё `step-finish` события.
**Предложение:** Проверка `ctx.sessionAborted` перед обработкой.

## [RISK-2] Отсутствует fallback для agent:turn_count на клиенте

При `maxTurns === 0` индикатор покажет "0 / ∞". Старый backend не шлёт события — UI ничего не показывает.
**Предложение:** Если `maxTurns === 0` — не рендерить прогресс-бар, показать "TURNS ∞" или скрыть.

## [RISK-3] Codex: race между abort и штатным завершением

После abort может прийти `turn.completed` позже.
**Предложение:** После abort установить флаг ДО итератора событий и игнорировать последующие events.
