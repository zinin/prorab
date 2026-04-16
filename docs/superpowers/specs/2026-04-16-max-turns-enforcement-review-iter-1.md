# Review Iteration 1 — 2026-04-16

## Источник

- Design: `docs/superpowers/specs/2026-04-16-max-turns-enforcement-design.md`
- Plan: `docs/superpowers/plans/2026-04-16-max-turns-enforcement.md`
- Review agents: codex-executor (gpt-5.4 xhigh), gemini-executor, ccs-executor (glm / albb-glm / albb-qwen / albb-kimi / albb-minimax)
- Merged output: `docs/superpowers/specs/2026-04-16-max-turns-enforcement-review-merged-iter-1.md`

## Замечания

### [ARCH-1] Retry loop не срабатывает на signal:error

> `run.ts:364` on `signal.type === "error"` returns immediately (`return false`), no retry. `executeReviewCycle` has no retry loop at all per reviewer. Design's fail-soft premise is broken.

**Источник:** codex, gemini.
**Статус:** Обсуждено с пользователем (Q1 → A).
**Ответ:** Драйверы эмитят `signal:{type:"none"}` + маркер `"Max turns exceeded (N)"` в начало `resultText`. Попадаем в существующий no-signal retry (`run.ts:371`).
**Действие:** Design §Failure behavior полностью переписан: сигнал none вместо error, объяснение почему. Edge cases обновлены. Plan tasks 5 и 6 — переписаны соответствующие снипеты, тесты теперь ассёртят `signal === "none"` и `resultText.startsWith("Max turns exceeded")`.

---

### [CODE-1] Symbol sentinel для abort reason — хрупкий pattern

> `err._prorabMaxTurns = symbol` не гарантирует, что `AbortSignal.reason` сохранит custom property. Frozen objects, strict types, etc. Минимум 6 из 7 ревьюеров.

**Источник:** codex, glm, albb-glm, albb-qwen, albb-kimi, albb-minimax.
**Статус:** Автоисправлено.
**Ответ:** Заменено на `class MaxTurnsExceededError extends Error` в `src/core/drivers/types.ts` (shared). Проверка `err instanceof MaxTurnsExceededError` / `signal.reason instanceof MaxTurnsExceededError`.
**Действие:** Design §Driver changes → Shared contract описывает класс. Plan Task 6 Step 3 переписан: использует `new MaxTurnsExceededError(opts.maxTurns)`, import из `types.js`. Тест в Task 6 Step 1 проверяет `ac.signal.reason instanceof MaxTurnsExceededError`.

---

### [ARCH-2] Race: stream эмитит события после abort

> После `session.abort()` в OpenCode и `abortController.abort()` в Codex поток может продолжать генерировать `step-finish`/`item.completed`. `handleStepFinish` / event loop обработают их, увеличат счётчики, могут вызвать abort повторно.

**Источник:** glm, albb-qwen, albb-kimi, albb-minimax, albb-glm.
**Статус:** Автоисправлено.
**Ответ:** Guard-флаги в обоих драйверах. OpenCode: `ctx.aborted` в начале `handleStepFinish`/`handleToolPart`/`handleTextPart`. Codex: `if (maxTurnsExceeded) break;` в начале `for await`.
**Действие:** Design §Driver changes — добавлены guard-инструкции. Edge cases уточнены. Plan Task 5 Step 4 (guards в handlers). Plan Task 6 Step 3 (guard в начале event loop + synchronous break).

---

### [RISK-1] Метрики обнуляются через errorResult() при maxTurns breach

> `errorResult()` в OpenCode возвращает `numTurns:0, cost:0, tokens:0`. Пропускаем реальные данные о runaway session.

**Источник:** codex, glm.
**Статус:** Автоисправлено.
**Ответ:** Переход на `buildIterationResult(ctx, { type: "none" }, null, null)` в OpenCode. В Codex — inline возврат с preserved `toolCalls`/`usage`/`durationMs`. Маркер `"Max turns exceeded (N)"` prepended to `resultText`.
**Действие:** Design §Driver changes — explicit requirement to preserve metrics. Plan Task 5 Step 6 (новый шаг для OpenCode result building). Plan Task 6 Step 3 (post-loop branch с preserved metrics). Тесты обоих драйверов ассёртят `numTurns >= maxTurns`, `inputTokens > 0`.

---

### [CODE-2] Claude не может эмитить incremental turn_count

> SDK не даёт per-message `num_turns` — только final value в `result`. `handleAssistant` не имеет turn count. План говорил "найди место", но места нет.

**Источник:** glm, albb-glm, gemini. **Статус:** Обсуждено с пользователем (Q2 → A).
**Ответ:** Локальный счётчик `ctx.numApiCalls` в `ClaudeContext`, инкремент и emit в `handleAssistant` runSession'а. В `startChat` не эмитим (chat не рендерит индикатор).
**Действие:** Design §Driver changes → ClaudeDriver — новая секция, описывает `numApiCalls` + `maxTurns`/`unitId` в `ClaudeContext`. Plan Task 7 Step 4 — конкретный snippet с `ctx.numApiCalls++`. Plan Task 7 Step 5 — новый тест файл `claude-turn-count.test.ts` с двумя кейсами (runSession emits, startChat не emits).

---

### [TEST-1] Task 4 smoke test тривиален

> `expect(options.reviewMaxTurns).toBe(42)` — не проверяет реальную маршрутизацию. 5 из 7 ревьюеров.

**Источник:** codex, glm, albb-glm, albb-qwen, albb-minimax.
**Статус:** Автоисправлено.
**Ответ:** Удалил smoke-тест полностью. Task 4 теперь сразу расширяет существующий `execute-review-rework.test.ts` четырьмя кейсами (reviewer/aggregator/rework/execute) с distinguishable maxTurns values.
**Действие:** Plan Task 4 переписан — больше нет файла `run-routes-review-max-turns.test.ts`. Assertions: `runSession` spy получает правильный `maxTurns` для каждого пути.

---

### [GAP-1] Обязательный reviewMaxTurns ломает tsc на существующих фикстурах

> `execute-review-rework.test.ts:119`, `run-attempt-counter.test.ts:108` используют `RunOptions` литералы. `npm run build` упадёт.

**Источник:** codex.
**Статус:** Автоисправлено.
**Ответ:** Добавил explicit step в Task 1 (Step 4) на tsc-driven sweep всех `RunOptions`/`ExecuteOptions` литералов. Trust compiler errors, add field, repeat until clean.
**Действие:** Plan Task 1 Step 4 (новый) — tsc sweep. File Structure секция обновлена — упомянут sweep.

---

### [GAP-2] План не обновляет ws-channel-routing.test.ts

> Design требует, план не содержит задачи. 3 ревьюера.

**Источник:** codex, glm, gemini.
**Статус:** Автоисправлено.
**Ответ:** Добавил Step 3 в Task 9 — расширяет `ws-channel-routing.test.ts` двумя кейсами (default channel, reviewerId preservation).
**Действие:** Plan Task 9 Step 3 (новый), Step 4 (type-check + run test).

---

### [INCONS-1] useSessionDefaults.ts упомянут в design, пропущен в плане vs план не должен его трогать

> Gemini: design предлагает антипаттерн (numeric field в session-wide defaults). Glm/albb-kimi: план не включает файл. Противоречивые ревью.

**Источник:** glm, albb-kimi, gemini.
**Статус:** Обсуждено (в design уже зафиксировано решение).
**Ответ:** Решение gemini правильнее — `useSessionDefaults` держит agent/model/variant (cross-session), а не numeric limits. `reviewMaxTurns` живёт как `usePersistedRef` на view-level, рядом с `maxTurns`.
**Действие:** Design §UI → Configuration обновлен: явно говорит, что `useSessionDefaults.ts` НЕ трогается. Plan Task 10 Step 1 — `usePersistedRef` в view. Ответ glm/albb-kimi автоматически решён: файл корректно не в File Structure.

---

### [INCONS-2] Design vs plan — разные подходы к abort reason detection

> Design говорил `err.name === "MaxTurnsExceeded"`, plan использовал Symbol sentinel.

**Источник:** glm, albb-kimi.
**Статус:** Автоисправлено.
**Ответ:** Унифицировано через `class MaxTurnsExceededError extends Error` (Edge cases обновлены в design, plan переписан на `new MaxTurnsExceededError`).
**Действие:** Design §Driver changes → Shared contract, §Edge cases; Plan Task 6 Step 3.

---

### [GAP-3] План Task 1 не включал RunOptions — только ExecuteOptions

> Albb-qwen: без изменения `RunOptions` поле не дойдёт от CLI до `run.ts`.

**Источник:** albb-qwen.
**Статус:** Автоисправлено.
**Ответ:** План уже правильно меняет `RunOptions` в Step 1 (я перепроверил), но описание Task 1 подразумевало только ExecuteOptions. Уточнил заголовок + шаги.
**Действие:** File Structure и Task 1 формулировки уточнены — меняем оба интерфейса, делаем tsc-driven sweep всех fixtures.

---

### [GAP-4] turnUsage не сбрасывается на смене фаз

> Только startExecution чистит, но execute → review → rework → multi-round не чистит. Header показывает stale.

**Источник:** codex, albb-qwen.
**Статус:** Автоисправлено.
**Ответ:** Новый action `clearTurnUsage(scope?)` в store. Зеркалирует существующие сбросы `contextUsageByUnit` в store и `useWebSocket.ts`.
**Действие:** Design §UI → Turns indicator — explicit requirement. Plan Task 8 Step 3 (новый action). Plan Task 9 Step 2 — зеркалировать clear-сайты.

---

### [CODE-3] ESM mocking pattern (vi.doMock + dynamic import) ненадёжен

> `vi.doMock` в ESM требует `vi.resetModules()` + dynamic import, может не перехватывать.

**Источник:** albb-qwen, albb-glm.
**Статус:** Автоисправлено.
**Ответ:** Task 4 теперь переиспользует уже работающий фикстурный pattern из `execute-review-rework.test.ts`. Task 6 Step 1 переписан на hoisted `vi.mock()` + top-level import + mutable `mockEvents` variable (стандартный ESM pattern).
**Действие:** Plan Task 4 (no more new file), Task 6 Step 1 (переписан).

---

### [CODE-4] Codex off-by-one: `toolCalls++` перед проверкой

> При breach `numTurns` возвращается на 1 больше `maxTurns`. Design требует strict `>=`.

**Источник:** albb-qwen.
**Статус:** Автоисправлено.
**Ответ:** После внедрения `if (maxTurnsExceeded) break;` в начале цикла и synchronous break после abort, последующие tool-calls не инкрементируют счётчик. `numTurns === maxTurns` точно при breach. Тест `codex-max-turns.test.ts` ассёртит `result.numTurns === 2` при `maxTurns: 2` при наличии 3-го tool-call в стриме.
**Действие:** Plan Task 6 Step 3 (break-on-flag + top-of-loop guard). Тест обновлен.

---

### [CODE-5] Codex abort без abortController = no-op

> Optional chaining `opts.abortController?.abort()` — если undefined, ничего не происходит.

**Источник:** gemini, albb-glm.
**Статус:** Автоисправлено.
**Ответ:** После abort делаем `break` из цикла (не зависим от того, что SDK acknowledge'нет abort). В случае отсутствия abortController и наличия maxTurns — всё равно корректно выходим через flag+break.
**Действие:** Plan Task 6 Step 3 — код теперь делает `break` сразу после abort, top-of-loop guard подхватывает.

---

### [CODE-6] opts недоступен в handleAssistant (Claude)

> Gemini: `opts` не в scope. Нужен `ctx.maxTurns`/`ctx.unitId`.

**Источник:** gemini.
**Статус:** Автоисправлено.
**Ответ:** В Task 7 Step 4 явно указано — добавить `maxTurns`, `unitId`, `numApiCalls` в `ClaudeContext`, заполнять в `createContext`, читать из `ctx.*` в `handleAssistant`.
**Действие:** Plan Task 7 Step 4 (новый snippet с корректным scope).

---

### [CODE-7] Ошибка в codex тесте: `thread_started_like()` vs `threadStarted`

> Переменная определена, функция не.

**Источник:** glm, albb-kimi.
**Статус:** Автоисправлено.
**Ответ:** В переписанном Task 6 Step 1 теста нет этой путаницы — используется функция `threadStarted()`.
**Действие:** Plan Task 6 Step 1 переписан.

---

### [GAP-5] Нет теста UI turn indicator

> Albb-kimi: ни одного рендер-теста для `Turns n / N`.

**Источник:** albb-kimi.
**Статус:** Автоисправлено.
**Ответ:** Добавлен в File Structure `src/__tests__/ui-execution-turns-indicator.test.ts`. Design §Testing → UI описывает: прогресс-бар при `maxTurns > 0`, `TURNS n` без бара при `maxTurns === 0`.
**Действие:** File Structure обновлён. Design §Testing → UI обновлен.

---

### [GAP-6] CCS driver — нет explicit note в плане

> Albb-glm: File Structure не упоминает `ccs.ts` → реализатор может try-to-modify.

**Источник:** albb-glm.
**Статус:** Автоисправлено.
**Ответ:** Добавлен note в File Structure.
**Действие:** File Structure: `src/core/drivers/ccs.ts` упомянут как "no changes (inherits via ClaudeDriver delegation)". Design §CcsDriver уточнён.

---

### [RISK-2] Default reviewMaxTurns=100 может быть мал

> Albb-kimi: для сложных diffs.

**Источник:** albb-kimi.
**Статус:** Отклонено (обсуждено с пользователем ранее в brainstorming — выбрал 100, переопределяется через CLI/UI). Уже задокументировано в Risks.
**Действие:** Никакого.

---

### [RISK-3] Infinite loop via pure agent_message/reasoning в Codex

> Gemini: модель может галлюцинировать текстом бесконечно, tool-calls не инкрементируются.

**Источник:** gemini.
**Статус:** Отклонено.
**Ответ:** Физически невозможно в текущей модели Codex SDK: один `runStreamed()` = один `turn`, который завершается `turn.completed` когда модель решит остановиться. Pure-text infinite loop в рамках одного turn'а не может произойти (модель рано или поздно остановит генерацию, т.е. turn закончится). В design §Driver changes → CodexDriver добавлен явный комментарий: "Pure-text infinite loops in Codex are physically impossible within one runStreamed".
**Действие:** Design §Driver changes → CodexDriver (добавлен комментарий).

---

### [RISK-4] Unknown WS events в старом UI

> Albb-kimi: старые клиенты могут ошибиться.

**Источник:** albb-kimi.
**Статус:** Отклонено.
**Ответ:** Существующий switch-case dispatcher в `useWebSocket.ts` silently ignore'ит unknown types. Добавил это в Risks.
**Действие:** Design §Risks обновлен.

---

### [TEST-2] Integration test не покрывает retry propagation

> Albb-glm, codex: driver unit tests проверяют abort, но integration не проверяет full path error → retry → second attempt.

**Источник:** codex, albb-glm.
**Статус:** Автоисправлено.
**Ответ:** Design §Testing → Integration теперь требует тест на каждом из 4 путей: reviewer/aggregator/rework/execute. Для execute — verify retry fires.
**Действие:** Design §Testing обновлён. Plan Task 4 покрывает reviewer/aggregator/rework/execute в одном наборе тестов.

---

### [TEST-3] Ненадёжный mocking OpenCode (driver as unknown).client

> Albb-kimi: нарушение инкапсуляции.

**Источник:** albb-kimi.
**Статус:** Отклонено.
**Ответ:** Принятая практика для тестов с private полями драйверов (используется в существующих `opencode-*-chat.test.ts`). Рефакторить драйвер ради теста — излишне. Риск приемлемый.
**Действие:** Никакого.

---

### [TEST-4] OpenCode errorResult не exported для тестов

> Albb-kimi: тест вызывает `errorResult` как глобальную.

**Источник:** albb-kimi.
**Статус:** Отклонено.
**Ответ:** Снипет теста в Task 5 Step 1 не вызывает `errorResult` — он мокает SDK и проверяет поведение драйвера через public API `runSession`. После переписывания на `buildIterationResult` вопрос отпадает.
**Действие:** Никакого.

---

### [CODE-8] numTurns: Math.max(1, toolCalls) — при immediate abort reports 1

> Albb-glm: при abort до первого tool-call reports 1 вместо 0.

**Источник:** albb-glm.
**Статус:** Отклонено.
**Ответ:** Immediate abort до первого tool-call физически невозможен если `maxTurns >= 1` — мы инкрементируем на первом tool-call и только после этого проверяем лимит. В catch-ветке (external abort) уже используем `Math.max(0, toolCalls)`, т.е. reports 0 при нуле. Math.max(1, ...) — только в max-turns и success path, где минимум 1 tool-call гарантирован (иначе max-turns не сработал бы).
**Действие:** Plan Task 6 Step 3 — уточнил: в catch-ветке `Math.max(0, toolCalls)` (external), в max-turns-ветке и success `Math.max(1, toolCalls)`.

---

### [CODE-9] Field name reviewerId vs reviewId

> Albb-minimax: `reviewerId` vs `reviewId`.

**Источник:** albb-minimax.
**Статус:** Отклонено (ложное срабатывание).
**Ответ:** Во всём плане и design использовался `reviewerId`. Проверил — `reviewId` нигде нет.
**Действие:** Никакого.

---

### [INCONS-3] plan Task 1: «around line 176» возможно неточный

> Glm: где именно формируется RunOptions в ExecutionManager.

**Источник:** glm.
**Статус:** Отклонено (ложное срабатывание — я перечитал execution-manager.ts:176, runOptions действительно там).
**Ответ:** Проверил: `runOptions` строится в `start()` методе around line 176. `executeLoop` принимает готовый объект. План корректен.
**Действие:** Никакого.

---

### [GAP-7] Нет теста CCS delegation через maxTurns

> Albb-glm: рекомендует добавить в ccs-driver.test.ts.

**Источник:** albb-glm.
**Статус:** Отклонено.
**Ответ:** CCS — тонкая обёртка над ClaudeDriver. Тестирование delegation-паттерна в целом не даёт дополнительной ценности над тем, что уже покрыто тестами ClaudeDriver. Добавление в follow-up если понадобится.
**Действие:** Никакого.

---

## Изменения в документах

| Файл | Изменение |
|------|-----------|
| `docs/superpowers/specs/2026-04-16-max-turns-enforcement-design.md` | §Driver changes полностью переписан: Shared contract (MaxTurnsExceededError), explicit guards, metric preservation. §Failure behavior: signal none вместо error, объяснение why. §Edge cases уточнены (guards, synchronous break). §UI: useSessionDefaults не трогаем, lifecycle resets. §Testing: расширено до 4 путей integration + claude-turn-count test + ws-channel-routing. §Risks: cross-driver semantics, signal none logging, unknown WS events. |
| `docs/superpowers/plans/2026-04-16-max-turns-enforcement.md` | File Structure обновлён (добавлены новые тест-файлы, убран run-routes-review-max-turns). Task 1 Step 4 добавлен — tsc sweep. Task 2 — Zod default. Task 4 переписан — сразу в execute-review-rework.test.ts 4 кейсами. Task 5 Step 3-6 переписаны — guards, preserved metrics, signal none. Task 6 Step 1 — hoisted vi.mock, Step 3 — MaxTurnsExceededError + break + preserved metrics + signal none. Task 7 Step 4 — ClaudeContext + handleAssistant emit, Step 5 — новый claude-turn-count.test.ts. Task 8 Step 3 — clearTurnUsage action. Task 9 — ws-channel-routing.test.ts. Task 10 Step 2 — startExecution interface. Task 11 Step 5 — обновлённый smoke-сценарий. |
| `docs/superpowers/specs/2026-04-16-max-turns-enforcement-review-merged-iter-1.md` | Создан — merged output всех 7 ревьюеров. |
| `docs/superpowers/specs/2026-04-16-max-turns-enforcement-review-iter-1.md` | Создан — этот файл. |

## Статистика

- Всего замечаний: 25 (уникальных после дедупликации из ~80 raw)
- Автоисправлено: 18
- Обсуждено с пользователем: 3 (Q1 retry strategy, Q2 Claude emission, INCONS-1 useSessionDefaults)
- Отклонено: 7 (ложные срабатывания / out-of-scope / acceptable risks)
- Повторов (автоответ): 0 (iter 1)
- Пользователь сказал "стоп": Нет
- Агенты: codex-executor (gpt-5.4 xhigh), gemini-executor, ccs-executor (glm / albb-glm / albb-qwen / albb-kimi / albb-minimax)
