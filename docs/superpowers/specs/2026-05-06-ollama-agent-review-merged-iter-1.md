# Merged Design Review — Iteration 1

**Date:** 2026-05-06
**Topic:** ollama-agent
**Documents reviewed:**
- Design: `docs/superpowers/specs/2026-05-06-ollama-agent-design.md`
- Plan:   `docs/superpowers/plans/2026-05-06-ollama-driver.md`

**Reviewers run (7 dispatched, 5 succeeded):**
- codex-executor (gpt-5.5, xhigh) — ✓
- gemini-executor (gemini-3.1-pro-preview) — ✓
- ccs-executor (albb-qwen) — ✓
- ccs-executor (ollama-kimi, kimi-k2.6:cloud) — ✓
- ccs-executor (ollama-minimax, minimax-m2.7:cloud) — ✓
- ccs-executor (glm, glm-5.1) — ✗ failed (HTTP 429 service overloaded × 3 retries)
- ccs-executor (ollama-deepseek) — ✗ failed (CCS process died without writing report.md)

---

## codex-executor (gpt-5.5)

### Critical Issues

- `src/server/routes/models.ts` ломает UI-listing для `ollama`. Сейчас `/api/models` вызывает `setup()` для всех кроме `ccs`/`codex` (`models.ts:40`), а план требует, чтобы `OllamaDriver.setup()` без модели падал. Значит `/api/models?agent=ollama` вернёт 500 вместо списка. Кроме того, маршрут lifetime-кэширует все non-`ccs` результаты (`models.ts:61`); для Ollama это опасно: daemon/signin/model state меняются, а пустой список будет закэширован до перезапуска сервера.

- Источник моделей `/v1/models` под большим вопросом. На текущем локальном `ollama 0.23.1` daemon жив, `POST /api/me` показывает signed-in профиль, но `GET /v1/models` возвращает `{"object":"list","data":null}`. При этом `GET /v1/models/kimi-k2.6:cloud` успешно проксируется в cloud. По исходникам Ollama `GET /v1/models` идёт через local `ListHandler`, который читает manifests, а не динамический cloud-каталог. Это напрямую бьёт по preflight "модель есть в `/v1/models` = signed in for this model".

- Cloud-only не обеспечен. `listModels()` фильтрует `:cloud`, но CLI всё равно принимает `--model llama3.2`, а плановый `setup()` пропускает non-cloud модели, потому что `preflightModel()` просто `return`, если нет `:cloud`. Если local-модели out of scope, `setup()` должен явно отвергать модель без `:cloud`.

- "No effort/variant for ollama" не гарантируется. `ClaudeDriver` прокидывает `opts.variant` как `queryOptions.effort` в batch и chat путях (`claude.ts:150`, `claude.ts:285`). Плановый `OllamaDriver` делегирует `opts` как есть, значит `--variant high` или stale UI default всё равно попадёт в SDK. UI скрывает dropdown только когда `variantOptions.length === 0` (`AgentWizard.vue:482`), но начальное persisted `variant` не очищается на mount (`AgentWizard.vue:291`). Драйвер должен либо отбрасывать `variant`, либо явно reject-ить его.

### Concerns

- Composition over `ClaudeDriver` здесь нормальна и совпадает с `CcsDriver` (`ccs.ts:100`), но дизайн преувеличивает "mirrors `ollama launch claude` exactly". В актуальном `ollama launch claude` env действительно ставятся через `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN=ollama`, model defaults и attribution, но `CLAUDE_CODE_AUTO_COMPACT_WINDOW` берётся через `lookupCloudModelLimit()`, а не через `[1m]/[200k]` suffix. Если suffix-подход зафиксирован, документ надо честно назвать intentional divergence.

- `OLLAMA_HOST` helper в дизайне не совпадает с `envconfig.Host()` из Ollama. Там нормализуются scheme, default port, IPv6, path и special-case `ollama.com`; плановый `resolveBaseUrl()` в лучшем случае prepend-ит `http://`. Минимум нужны тесты на trailing slash, path component, uppercase `HTTP://`, explicit port и bracketed IPv6. Иначе легко получить `http://host//v1/models` или некорректный base URL.

- Race между preflight и `/v1/messages` не закрываем полностью. Если пользователь signout-ится или модель становится недоступной после preflight, ошибка уйдёт как обычный SDK error. Это приемлемо, но стоит явно документировать: `run.ts` на `signal:error` останавливается без retry и оставляет task in-progress, а не делает "model not available" preflight-style сообщение.

- `listModels()` returning `[]` on all failures ухудшает UX. Сейчас UI покажет пустой dropdown без `fetchError`, потому что backend вернёт 200 с `models: []`. Для daemon down/signout это не actionable, особенно если пустой результат ещё и закэширован.

- Плановая проверка `npx vue-tsc --noEmit --project ui/tsconfig.json` не исполнима как написано: в `ui/package.json` нет `vue-tsc`. `npm run build:ui` запускает Vite build, но не полноценный Vue type-check.

### Suggestions

- Добавить отдельную задачу до UI: изменить `src/server/routes/models.ts` для `ollama`: no `setup()` before `listModels()`, no lifetime cache или хотя бы no cache for empty/error, плюс route tests.

- В `OllamaDriver.runSession()` и `startChat()` перед делегированием удалять `variant` для ollama. Это проще и надёжнее, чем пытаться закрыть все UI/CLI пути.

- В `setup()` явно проверять `model.includes(":cloud")`; иначе текущий план не выполняет locked decision "cloud-only".

- Пересмотреть preflight/model source на основе фактов по Ollama 0.23.1. Для проверки конкретной модели `/v1/models/{model}` или `/api/show` выглядят ближе к реальному cloud-access signal, чем `/v1/models`. Для UI-каталога нужен отдельный ответ: либо принять hardcoded/recommended list из Ollama launch source, либо признать, что daemon `/v1/models` не даёт полный cloud catalog.

- Subclass-вариант (`class OllamaDriver extends ClaudeDriver`) возможен: override `setup()`, `teardown()`, `runSession()`, `startChat()`, вызывать `super.runSession({ ...opts, env, variant: undefined })`. Он уменьшит делегационный boilerplate, но не сильно: всё равно нужны guards и env injection в двух entrypoints. Без protected hook в `ClaudeDriver` composition остаётся более явной и менее хрупкой.

### Questions

- Автор реально проверял signed-in поведение `/v1/models` на Ollama `>=0.20` с cloud-моделями, не только shape? Локальный `0.23.1` signed-in случай не подтверждает этот assumption.
- Что должно происходить с `--variant` для `--agent ollama`: silently ignore или fail fast?
- Нужно ли обновлять `README.md`? План меняет `CLAUDE.md` и `.claude/rules/drivers.md`, но пользовательская документация всё ещё перечисляет только четыре агента.
- Если `/v1/models` не является cloud catalog, какой источник списка моделей всё-таки допустим при уже зафиксированном отказе от hardcoded/hybrid/free-text?

---

## gemini-executor (gemini-3.1-pro-preview)

### Critical Issues
Явных блокирующих проблем нет. Spec и план технически грамотны.

### Concerns
- **Перезапись `opts.env` при слиянии SessionOptions**: в `runSession`/`startChat` `overrides.env = this.sessionEnv`, далее `{ ...opts, ...overrides }` — это перезаписывает любой `opts.env` от вызывающей стороны вместо merge (`{ ...opts.env, ...this.sessionEnv }`). Тот же скрытый баг присутствует в `CcsDriver`.
- **Пустая `ANTHROPIC_API_KEY=""`**: если `query()` из `@anthropic-ai/claude-agent-sdk` валидирует API-ключ до пробрасывания в child process, может быть «missing API key». Нужно эмпирически подтвердить.
- **TDD-порядок (Tasks 3, 4, 8, 12)**: тесты на функции, реализованные авансом в более ранних шагах — формально characterization tests, не строгий TDD.

### Suggestions
- **Subclassing вместо composition**: `CcsDriver` вынужден компоноваться, потому что узнаёт модель асинхронно в `setup()` после чтения `.settings.json` и не может вызвать `super(model)` в конструкторе. `OllamaDriver` же получает model синхронно — `class OllamaDriver extends ClaudeDriver` уместен и убирает boilerplate проброса `sendMessage`, `replyQuestion`, `abortChat`, `teardown`. Размер файла сократится почти вдвое.
- **UI «No user settings»**: в Task 15 `ollama` добавляется в селекты, но пропущены условия видимости чекбокса «No user settings» — во Vue-компонентах `v-if="agent === 'claude' || agent === 'ccs'"`. Поскольку `OllamaDriver` принимает `useUserSettings`, чекбокс надо включить и для `ollama`.
- **Trailing slash в `OLLAMA_HOST`**: при `OLLAMA_HOST=http://127.0.0.1:11434/` `resolveBaseUrl` вернёт значение как есть → `http://...//v1/models`. Добавить `.replace(/\/+$/, "")`.
- **tsconfig**: расчёт «build игнорирует тесты через `exclude: ["src/__tests__"]`, vitest их запустит» верен; правки не нужны.

### Questions
- Проверено ли, что `ANTHROPIC_API_KEY=""` обходит внутреннюю валидацию `query()` из `@anthropic-ai/claude-agent-sdk`, либо SDK прозрачно прокидывает env в child process, где `claude` сам отдаёт приоритет `ANTHROPIC_AUTH_TOKEN`?

---

## ccs-executor (albb-qwen)

### Critical Issues

**1. Гонка / неверная диагностика в preflight.** `preflightModel()` зовёт `listModels()`, у которого собственный `try/catch` глотает любые сетевые сбои и возвращает `[]`. Если `/v1/models` вернёт 503/таймаут — пользователь увидит "model not available via ollama", хотя реальная причина — транзиентный сбой сервера. Спецификация смешивает сетевые ошибки и auth-ошибки.

**2. `AbortSignal.timeout(2000)` слишком агрессивный.** 2 секунды на `/v1/models` мало, когда облачный auth-handshake холодный. При срабатывании таймаута `listModels()` возвращает `[]`, и снова получаем "модель недоступна" — та же мисдиагностика, что и в #1.

**3. `buildEnv()` через `{ ...process.env }` тянет всё окружение.** В Claude-Code-сессию утекают любые `ANTHROPIC_*` переменные родительского процесса (например, `ANTHROPIC_RETRY`), а также сам `OLLAMA_HOST`. Spec явно перетирает только `ANTHROPIC_BASE_URL` и `ANTHROPIC_API_KEY`, остальные `ANTHROPIC_*` от прошлых сессий выживают.

### Concerns

**5. Variant в UI рендерится для не-claude/не-ccs агентов.** План (Task 15) предлагает "не трогать, пока тест не упадёт" — это хрупкая логика. Поле variant как текстовый input будет показано для ollama, пользователь введёт что-то, SDK передаст это в `effort`. План полагается на то, что Claude Code молча проигнорирует неизвестный effort. Если Claude Code упадёт на невалидном effort — фича сломается.

**7. Test Step 2.2 переусложнён.** Скелет `listModels()` возвращает `[]`, и тест "daemon-down" проходит тривиально — план пивотится на "проверим, что fetch вызвался". Чище было бы изначально бросать "not implemented" в скелете, чтобы тест был properly red.

**8. Хелпер `mockOllamaWith` смешивает два эндпоинта.** Для `/api/version` модель не нужна, но мок ставит её и туда. Безвредно, но запутывает.

**10. `CLAUDE_CODE_ATTRIBUTION_HEADER=0` без обоснования.** Хардкод `"0"` в спеке без объяснения почему. Будущий мейнтейнер может убрать как "лишнее". Нужен комментарий рядом со значением.

### Suggestions

**11. Завести типизированный `OllamaPreflightError`** — чтобы retry-логика prorab могла отличить "daemon down" (можно повторить) от "model not signed in" (повторять бессмысленно). Forward-compatible.

**12. Тест на не-cloud модель.** Spec говорит "cloud-only", но если пользователь передаст `llama3.2:3b`, `preflightModel` пропускает проверку (`!this.model.includes(":cloud")`), и setup проходит. Нужен либо явный тест "non-cloud passes setup без preflightModel", либо upfront-гард, отвергающий локальные модели.

**13. Characterization-тест для shape `/v1/models`.** Spec прямо называет shape `{ data: [{ id }] }` "open assumption, проверено эмпирически". Зафиксировать тестом, чтобы при изменении API Ollama упало сразу.

**14. План — 17 задач и ~20 коммитов на ~200 строк.** Tasks 3 и 4 — чистые тесты без новых изменений кода. Защитимо как "проверим фильтр", но раздувает CI. Можно сложить Tasks 2-4 в один коммит.

**15. Task 15 должен явно протестировать variant.** Либо добавить `v-if="agent !== 'ollama'"` для variant input в `AgentWizard.vue:483`, либо явный тест "ollama + variant input не ломается". "Не трогать пока не упадёт" противоречит non-goal "no effort/variant dropdown".

### Questions

**16. SDK `env`: replace или merge?** План полагается на `{ ...process.env }`. Если SDK подменяет `env` целиком, без spread потеряются `PATH`/`HOME`. CcsDriver работает так же — эмпирически ок, но в дизайне стоит явно зафиксировать ожидание.

**17. `OLLAMA_HOST` как Unix socket?** Ollama поддерживает `OLLAMA_HOST=/var/run/ollama.sock`. Текущий `resolveBaseUrl()` склеит `http:///var/run/...` — невалидный URL для `fetch()`. Spec покрывает только `host:port` и `http(s)://`. Должна ли быть явная ошибка, или допустим runtime-фейл?

---

## ccs-executor (ollama-kimi, kimi-k2.6:cloud)

### Critical Issues

1. TDD-риторика фальшива в Tasks 3/4/8/12 — тесты проходят сразу, это characterization-тесты, а не red/green.
2. `OLLAMA_HOST` с trailing slash даёт `//api/version` — баг.
3. `process.env` spread + `as Record<string, string>` скрывает runtime-`undefined`.
4. Preflight/runtime race: `setup()` проверяет демон, но между `setup()` и `runSession()` пользователь может сделать `ollama signout`.
5. Пустой list `:cloud` моделей при отсутствии sign-in приводит к странному UX.

### Concerns

- Отсутствие fallback на изменение shape `/v1/models`.
- Неконсистентный label "Variant" в UI для ollama.
- Magic timeout 2000ms.
- Дублирование env-override логики между `runSession`/`startChat`.
- Отсутствие учёта `ReviewerSchema`.
- Путь в `OLLAMA_HOST` не нормализуется.
- Inconsistency между `listModels()` (без setup) и `setup()`.

### Suggestions

- Нормализация trailing slash.
- Явная фильтрация `undefined` в `buildEnv()`.
- Вынос `PREFLIGHT_TIMEOUT_MS` в константу.
- Тест на trailing slash.
- Переименование Tasks 3/4/8/12 (characterization, не TDD).
- Защита `setup()` try/catch вокруг `preflightModel()`.
- Client-side guard для пустой model.

### Questions

- Взаимодействие с `--variant`/`--effort`?
- Поведение при mid-session signout?
- Обоснование 2s timeout?
- Intent относительно `ANTHROPIC_API_KEY=""`?
- `parseContextWindow` и decimal?
- Отсутствие `applyHooks` в factory case?
- IPv6 literal без скобок?

---

## ccs-executor (ollama-minimax, minimax-m2.7:cloud)

### Critical Issues

**1. `OLLAMA_HOST` с пробелами** — `trim()` делает `192.168.1.10:11434 ` валидным, но `fetch` отправляет его как `http://192.168.1.10:11434 ` (с trailing space), что сломает соединение. Реальный edge case при копи-пасте.

**2. `run.ts` не передаёт `env` при вызове `runSession`** — но OllamaDriver правильно инжектит `sessionEnv` через `overrides.env`, так что в execute flow проблем нет (он работает).

**3. Variant dropdown в UI**: `agent === 'claude' || agent === 'ccs'` gate не добавляет Ollama, но dropdown всё равно рендерится если `variantOptions.length > 0` (`AgentWizard.vue:482`). `listModels()` для ollama возвращает `id`/`name` без `variants`, значит `computeVariantOptions` вернёт `[]`. Условие `v-if="variantOptions.length > 0"` скроет dropdown. **Это корректно**, но есть subtlety: если future-расширение добавит variants — dropdown не появится. По дизайну correct, но стоило явно задокументировать, что effort/variant dropdown для ollama полностью hidden, не disabled.

**4. `[Nk]/[Nm]` regex в `parseContextWindow`** покрыт `/i`, но `[2G]` — невалидный суффикс — silently пропускается. Это документировано (spec: "omitted when no suffix"), но `[1K]` (uppercase) explicit-теста нет.

### Concerns

- `AbortSignal.timeout` — Node.js 18+; на Node 24+ безопасно.
- Race condition между preflight и runtime (минорно).
- `process.env` mutation: `{ ...process.env }` — shallow copy, безопасно, но `CLAUDE_CODE_AUTO_COMPACT_WINDOW` уже установленный в `process.env` останется в копии и пройдёт в SDK. Может быть deliberate.
- `requireDriver()` message OK, соответствует pattern.
- Plan Task 2.2: "Wait — re-read step 1.3" — выглядит как черновик.
- `OLLAMA_HOST` env var — нет discovery-механизма, но preflight `/api/version` это закрывает.

### Suggestions

**11. Plan Task 15.1 неточен**: основной dropdown gate — это `variantOptions.length > 0`, а не agent-check (это про refine-steps label). Уточнить план.

**12. Mock-система в тестах**: spec использует `vi.stubGlobal("fetch", ...)`, plan использует `globalThis.fetch = vi.fn()`. Оба работают, но стоило унифицировать.

**13. Тест на refine-steps `stepVariantLabel`** — возвращает "Variant" для ollama, что correct, но не покрыто тестом.

**14. Документация**: план Task 16 обновляет `.claude/rules/drivers.md` и `CLAUDE.md`, но не упоминает `.claude/rules/frontend.md`.

**15. Pre-PR cleanup** — план не упоминает `docs/superpowers/execution/` docs если таковые есть.

### Questions

- Q1: Почему `CLAUDE_CODE_ATTRIBUTION_HEADER = "0"`? Нужен комментарий.
- Q2: 2s timeout достаточно для preflight? Cделать configurable или 5s.
- Q3: `/v1/models` vs `/api/models` — locked decision, acceptable as documented risk.
- Q4: Sequential preflight vs parallel — текущая схема conditional уже OK.

---

## ccs-executor (glm) — FAILED

Three retries, all returned `API Error: Request rejected (429) · The service may be temporarily overloaded, please try again later`. The error originates at the upstream GLM API (model `glm-5.1`); not a prorab/CCS problem. The prompt is preserved at `/home/zinin/.claude/ccs-interaction/2026-05-06-10-27-13-design-review-ollama-agent-iter-1-retry2/prompt.md` and can be re-run later when the upstream cools down.

---

## ccs-executor (ollama-deepseek) — FAILED

The CCS process produced ~377KB of streaming events in `log.jsonl` and ~390KB in `raw.jsonl` between 10:19 and 10:28, then died without writing the final `output.txt`/`report.md`. The wrapping `until [ -f report.md ]; do sleep 10` poll loop became a zombie and was killed manually by the orchestrator. Likely upstream hit max-turns or stream error before the wrapper could finalize. Logs preserved at `/home/zinin/.claude/ccs-interaction/2026-05-06-10-19-23-design-review-ollama-agent-iter-1-ollama-deepseek/`.
