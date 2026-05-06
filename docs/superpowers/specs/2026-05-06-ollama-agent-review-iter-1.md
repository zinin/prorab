# Review Iteration 1 — 2026-05-06

## Источник

- Design: `docs/superpowers/specs/2026-05-06-ollama-agent-design.md`
- Plan:   `docs/superpowers/plans/2026-05-06-ollama-driver.md`
- Review agents: codex-executor (gpt-5.5, xhigh), gemini-executor (gemini-3.1-pro-preview), ccs-executor (albb-qwen, ollama-kimi, ollama-minimax). Failed: ccs-executor (glm — upstream 429 × 3 retries), ccs-executor (ollama-deepseek — CCS process died mid-stream without writing report).
- Merged output: `docs/superpowers/specs/2026-05-06-ollama-agent-review-merged-iter-1.md`
- Issue count after dedup: 43 (7 critical, 17 concerns, 13 suggestions, 7 questions)

## Замечания

### [CRIT-1] /api/models route breaks for ollama agent

> `src/server/routes/models.ts` calls `setup()` for all non-ccs/non-codex agents. `OllamaDriver.setup()` throws when model is missing, so `/api/models?agent=ollama` returns 500. The route also lifetime-caches non-ccs results — empty/error lists for ollama would be pinned until server restart.

**Источник:** codex
**Статус:** Автоисправлено
**Ответ:** Подтверждено чтением `src/server/routes/models.ts:40-67`. Route действительно делает `needsSetup = agent !== "ccs" && agent !== "codex"` и кэширует результат для non-ccs.
**Действие:** Добавлен новый Task 16 в плане ("Update /api/models server route") — расширяет `needsSetup` exemption и cache-skip до `ollama`. Design — добавлен раздел "`/api/models` server route" с обоснованием.

---

### [CRIT-2] /v1/models is not a reliable cloud-catalog source

> На локальном Ollama 0.23.1 при signed-in `GET /v1/models` возвращает `{"object":"list","data":null}`, но `GET /v1/models/<id>` отдаёт конкретную cloud-модель. Преходит preflight assumption "model in /v1/models == signed in".

**Источник:** codex + ollama-kimi
**Статус:** Обсуждено с пользователем (выбран hardcoded catalog + per-model probe)
**Ответ:** Подтверждено эмпирически на этой машине: `curl /v1/models` → `data:null`, `curl /v1/models/kimi-k2.6:cloud` → 200. Доступно 5 моделей: deepseek-v4-pro:cloud, kimi-k2.6:cloud, minimax-m2.7:cloud, qwen3-coder:480b-cloud, gpt-oss:120b-cloud.
**Действие:** Design — переписан раздел `listModels()`: добавлен `OLLAMA_CLOUD_CATALOG` (5 моделей), Promise.all-probe через `/v1/models/<encodeURIComponent(id)>`. Plan — Task 2 переписан под catalog + probe (4 теста: catalog, URL-encoding, daemon-down × 2). Brainstorming-decision "no hardcoded list" официально переоткрыт ввиду factual-противоречия.

---

### [CRIT-3] Cloud-only constraint not actually enforced (and variant/effort still leaks to SDK)

> (a) preflightModel() returns early on non-cloud — `--model llama3.2` пропускается; (b) ClaudeDriver forwards `opts.variant → effort` (claude.ts:150, 285), персистентный UI variant пробивается.

**Источник:** codex + albb-qwen + ollama-kimi + ollama-minimax
**Статус:** Обсуждено с пользователем (выбран silent strip + cloud-only guard)
**Ответ:** Решено двумя слоями: явный guard в `setup()` отвергает не-cloud модели, OllamaDriver.runSession()/startChat() strip'ают `opts.variant` перед delegation. UI gate (`variantOptions.length > 0`) трогать не нужно — driver-side defense достаточен.
**Действие:** Design — обновлены sections "Architecture" (skeleton с guard + strip) и "Setup flow" (variant strip rationale). Plan — добавлен Task 4 (cloud-only guard, новый), Task 7 теперь strip variant + merge env, Task 10 startChat также strip + merge.

---

### [CRIT-4] OLLAMA_HOST normalization is incomplete

> trailing slash → `//v1/models`; whitespace inside значения; uppercase HTTP://; explicit path; IPv6 без скобок; unix-socket form `/var/run/ollama.sock` → невалидный URL.

**Источник:** codex + gemini + albb-qwen + ollama-kimi + ollama-minimax (все 5)
**Статус:** Автоисправлено
**Ответ:** Полная нормализация в `resolveBaseUrl()`: trim, явный reject unix-socket form, явный reject internal whitespace, scheme prepend для host:port, strip trailing slash regex `/\/+$/`. IPv6 — caller responsibility (bracket).
**Действие:** Design — section "OLLAMA_HOST handling" переписан с code-listing нормализатора и behavior summary (8 case'ов). Plan — Task 3 теперь характеризационная (5 OLLAMA_HOST tests), Task 8 покрывает trailing slash в setup() env.

---

### [CRIT-5] buildEnv() {...process.env} spread leaks parent ANTHROPIC_*/CLAUDE_CODE_*

> Spread тянет `ANTHROPIC_API_KEY`, `ANTHROPIC_RETRY`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` и т.д. от родителя. Если на хосте есть real key — он утечёт.

**Источник:** albb-qwen + gemini + ollama-kimi + ollama-minimax
**Статус:** Обсуждено с пользователем (выбран strip ANTHROPIC_*/CLAUDE_CODE_*)
**Ответ:** Blacklist подход: после spread удаляем все ключи начинающиеся на `ANTHROPIC_`/`CLAUDE_CODE_`, затем выставляем нужные. PATH/HOME/LANG/proxy сохраняются.
**Действие:** Design §"Env vars" — добавлен два цикла очистки (drop undefined, strip namespaces) с rationale "blacklist over whitelist". Plan Task 7 — buildEnv реализация, плюс новый тест "strips parent ANTHROPIC_*/CLAUDE_CODE_* leakage" с реальным `ANTHROPIC_API_KEY=sk-ant-real-parent-key` в process.env.

---

### [CRIT-6] Network failure misdiagnosed as 'model not signed in'

> preflightModel() звал listModels() с silent catch → 503/timeout/network становились "model not available, ollama signin", путая user'а.

**Источник:** albb-qwen
**Статус:** Автоисправлено
**Ответ:** preflightModel теперь делает собственный `fetch(/v1/models/<id>)` с явной обработкой статусов: 200 ok, 404 → "ollama signin", 5xx/throw/timeout → "transient daemon issue, retry or check serve logs".
**Действие:** Design §"Preflight" — расписана дисамбигуация. Plan Task 6 переписан: 3 теста (404, 5xx, fetch-throw), реализация с явным statusCode-switch.

---

### [CRIT-7] AbortSignal.timeout(2000) is too aggressive

> 2 секунды на cold cloud-handshake мало; срабатывает таймаут → "model not available" misdiagnosis.

**Источник:** albb-qwen + ollama-kimi + ollama-minimax
**Статус:** Автоисправлено
**Ответ:** Поднят до 5 секунд по умолчанию, вынесен в module-level `PREFLIGHT_TIMEOUT_MS = Number(process.env.OLLAMA_PREFLIGHT_TIMEOUT_MS) || 5000`. Конфигурируется через env.
**Действие:** Design + plan везде (preflightDaemon, preflightModel, listModels) используют `PREFLIGHT_TIMEOUT_MS`. Plan Task 2 — добавлено объявление константы.

---

### [CONC-1] Spec overstates 'mirrors ollama launch claude exactly'

> Real `ollama launch claude` берёт `CLAUDE_CODE_AUTO_COMPACT_WINDOW` из `lookupCloudModelLimit()`, не из суффикса.

**Источник:** codex
**Статус:** Автоисправлено
**Ответ:** Honest documenting: переименован header section в "mirrors `ollama launch claude`, with one intentional divergence", в Non-Goals явно сказано "Intentional divergence from `ollama launch claude`'s `lookupCloudModelLimit()`".
**Действие:** Design § "Non-Goals" + § "Env vars" обновлены. drivers.md (Task 17) тоже отмечает divergence.

---

### [CONC-2] Preflight/runtime race: signout between setup() and first request

> Между preflight и первым /v1/messages пользователь может signout/daemon crash.

**Источник:** codex + ollama-kimi + ollama-minimax
**Статус:** Автоисправлено (документация)
**Ответ:** Acceptable behavior — SDK error пробросится как signal:error в ChatEvent, run.ts остановит итерацию, task останется in-progress. Документировано явно.
**Действие:** Design — добавлен новый раздел "Mid-session failures" с rationale "не re-running preflight; следующий запуск re-setup". drivers.md mention.

---

### [CONC-3] listModels() returning [] on every failure produces poor UX

> Backend возвращает 200 с models:[] для daemon-down/signout/network/malformed. UI без fetchError.

**Источник:** codex
**Статус:** Автоисправлено (частично — связано с CRIT-1)
**Ответ:** Решено комплексно: (a) Task 16 убирает кэширование для ollama → каждый refresh re-probe'ает daemon; (b) явная ошибка теперь surface'ится на session-start через preflight'ы (404 vs 5xx разделены, CRIT-6); (c) Plan Task 18 (manual verify) включает checking dropdown-empty case.
**Действие:** Plan Task 16 (cache skip), design § "listModels error contract" уточняет error contract, design § "/api/models server route" добавлен.

---

### [CONC-4] 'npx vue-tsc --noEmit' is not executable

> ui/package.json не содержит vue-tsc; npm run build:ui — Vite build без type-check.

**Источник:** codex
**Статус:** Автоисправлено
**Ответ:** Подтверждено: `which vue-tsc` пусто, `ui/node_modules/.bin/vue-tsc` отсутствует, `npx vue-tsc` падает с "missing packages: vue-tsc@3.2.8". CLAUDE.md упоминает команду aspirational. Plan убрал её, оставлен только `npm run build:ui` с пометкой.
**Действие:** Plan Task 15 — удалён шаг с vue-tsc, оставлен `npm run build:ui` с пометкой про отсутствие type-check'а Vue SFC. Design § "Verification" — отмечено явно.

---

### [CONC-5] env merge overwrites caller-provided opts.env instead of merging

> `{ ...opts, env: this.sessionEnv }` затирает любой `opts.env`. Ту же латентную ошибку повторяет CcsDriver.

**Источник:** gemini + ollama-kimi
**Статус:** Автоисправлено
**Ответ:** runSession/startChat теперь делают `{ ...callerEnv, ...this.sessionEnv }` — caller wins для unmanaged keys, наши overrides побеждают для ANTHROPIC_/CLAUDE_CODE_.
**Действие:** Design § "Env vars" — раздел "Why merge instead of replace at the call site". Plan Task 7 — реализация runSession destructure-merge + новый тест "merges caller opts.env (caller wins for unmanaged keys)". Plan Task 10 — то же для startChat.

---

### [CONC-6] ANTHROPIC_API_KEY="" may not bypass SDK validation

> Если SDK валидирует API-key до forwarding в child — empty string может быть rejected.

**Источник:** gemini + ollama-kimi
**Статус:** Автоисправлено (документация)
**Ответ:** Эмпирически verified: SDK forwards env через `spawn(..., { env })`, child `claude` prefer'ит `ANTHROPIC_AUTH_TOKEN`. CcsDriver использует тот же паттерн (тот же `ANTHROPIC_API_KEY = ""`) и работает в продакшене с момента выхода CcsDriver.
**Действие:** Design § "Env vars" — добавлен раздел "Why `ANTHROPIC_API_KEY=""` is safe" со ссылкой на CcsDriver-empirical confirmation.

---

### [CONC-7] TDD-style framing in Tasks 3/4/8/12 is characterization

> Тесты проходят immediately после реализации в предыдущих шагах — это characterization, не red→green TDD.

**Источник:** gemini + albb-qwen + ollama-kimi
**Статус:** Автоисправлено
**Ответ:** Tasks 3 и 8 теперь явно помечены "(characterization)" в title, в body — "Pure characterization — they should pass without further code changes".
**Действие:** Plan — Tasks 3 и 8 переименованы. Task 12 ("teardown clears state") уже корректно помечен "must pass (teardown already implemented in Task 7)".

---

### [CONC-8] AgentWizard 'No user settings' checkbox not extended to ollama

> v-if="agent === 'claude' || agent === 'ccs'" — но `OllamaDriver(model, useUserSettings)` принимает флаг.

**Источник:** gemini
**Статус:** Автоисправлено
**Ответ:** Добавлено в plan Task 15 step 1(b): расширить v-if до `agent === 'claude' || agent === 'ccs' || agent === 'ollama'`.
**Действие:** Plan Task 15.1 — пункт (b) с точным фрагментом v-if. Design § "CLI / UI / wiring" mentions.

---

### [CONC-9] CLAUDE_CODE_ATTRIBUTION_HEADER="0" is undocumented magic value

> Хардкод "0" без объяснения. Future maintainer может удалить.

**Источник:** albb-qwen + ollama-minimax
**Статус:** Автоисправлено
**Ответ:** Inline-комментарий: "matches `ollama launch claude` Run() and is a noop for non-Anthropic upstreams; suppresses 'Created by Claude Code' attribution".
**Действие:** Design § "Env vars" — комментарий в code-block. drivers.md (Task 17) тоже document'ирует.

---

### [CONC-10] Missing test for non-cloud model rejection

> Нужен явный тест "non-cloud rejected at setup".

**Источник:** albb-qwen
**Статус:** Автоисправлено
**Ответ:** Добавлен полноценный Task 4 с test "rejects non-cloud models" (проверяет message + что fetch не вызывался).
**Действие:** Plan Task 4 — новый, между preflight-tasks.

---

### [CONC-11] Add typed OllamaPreflightError to distinguish daemon-down vs not-signed-in

> Forward-compatible для retry-логики.

**Источник:** albb-qwen
**Статус:** Отклонено
**Ответ:** YAGNI. Текущая retry-логика prorab останавливается на signal:error без анализа типа; типизация не используется. Сообщения в setup() уже actionable. Если в будущем понадобится — добавим.
**Действие:** Не применено.

---

### [CONC-12] Lock the /v1/models response shape with a characterization test

> Spec называет shape "open assumption verified empirically". Зафиксировать тестом.

**Источник:** albb-qwen + ollama-kimi
**Статус:** Автоисправлено (трансформировано)
**Ответ:** Изначально CRIT-2 fix полностью убрал зависимость от bulk `/v1/models` — теперь зависим только от per-model `/v1/models/<id>` shape `{ id }`. Плюс tests Task 2 (catalog probe) уже фиксируют новый assumption (status code semantics). Старая забота про bulk shape отпала.
**Действие:** Plan Task 2 включает 4 теста про per-model probe. Design § "listModels()" rationale обновлён.

---

### [CONC-13] Plan is over-decomposed: 17 tasks for ~200 lines

> Tasks 3 и 4 — чистые тесты без production кода.

**Источник:** albb-qwen
**Статус:** Отклонено (частично решено иначе)
**Ответ:** Granularity нужна для bisect и review-checkpoint. Однако Tasks 3 (OLLAMA_HOST list) и Task 4 (OLLAMA_HOST host:port URL form) объединены в один Task 3 (5 характеризационных тестов). Total tasks теперь 18 (вырос за счёт CRIT-1 → Task 16, CRIT-3 → Task 4).
**Действие:** Plan — Tasks 3+4 объединены, добавлены Task 4 (cloud-only) и Task 16 (models.ts route).

---

### [CONC-14] ReviewerSchema not updated for ollama

> План не упоминает расширение ReviewerSchema.

**Источник:** ollama-kimi
**Статус:** Отклонено (false positive)
**Ответ:** ReviewerSchema (`src/types.ts:336`) уже использует `agent: AgentTypeSchema` — расширение enum AgentTypeSchema автоматически расширяет Reviewer. Никаких отдельных правок не нужно.
**Действие:** Plan Task 13.3 — explicit пометка "Reviewer (built from AgentTypeSchema) now accepts 'ollama' automatically — no separate edit needed".

---

### [CONC-15] listModels() works without setup() while runSession requires it

> Асимметрию задокументировать.

**Источник:** ollama-kimi
**Статус:** Автоисправлено
**Ответ:** Design § "listModels()" — добавлен раздел "Setup-free" документирующий контракт.
**Действие:** Design обновлён.

---

### [CONC-16] Plan Task 15.1 mischaracterizes the variant gate

> Plan говорил gate — agent-check, реальный gate — `variantOptions.length > 0`.

**Источник:** ollama-minimax
**Статус:** Автоисправлено
**Ответ:** Plan Task 15.1 пункт (c) переписан с правильной характеристикой: agent-check — это **label** "Effort" vs "Variant", visibility — `variantOptions.length > 0`. Driver-side strip — primary defense.
**Действие:** Plan Task 15.1 переписан.

---

### [CONC-17] Plan Task 2.2 contains a draft 'Wait — re-read' note

> Step 2.2: "Wait — re-read step 1.3" — черновик.

**Источник:** ollama-minimax
**Статус:** Автоисправлено
**Ответ:** Полная переработка Task 2 (см. CRIT-2 fix) удалила оригинальный Step 2.2 целиком вместе с черновой пометкой.
**Действие:** Plan Task 2 переписан clean.

---

### [SUGG-1] Add a dedicated task before UI work to fix /api/models for ollama

**Источник:** codex
**Статус:** Автоисправлено (см. CRIT-1)
**Ответ:** Реализовано как Task 16, размещён ПОСЛЕ UI tasks (Task 15) — это OK, так как `/api/models` route нужен для UI dropdown'а который тестируется в Task 18 (manual verify), не в Task 15 (build:ui only).
**Действие:** Plan Task 16 добавлен.

---

### [SUGG-2] Strip 'variant' from opts in OllamaDriver runSession/startChat

**Источник:** codex
**Статус:** Автоисправлено (см. CRIT-3)
**Действие:** Plan Tasks 7 + 10.

---

### [SUGG-3] Reconsider preflight model source

**Источник:** codex
**Статус:** Автоисправлено (см. CRIT-2)

---

### [SUGG-4] Reconsider subclassing ClaudeDriver

> OllamaDriver получает model sync — subclass возможен и halfes boilerplate.

**Источник:** codex + gemini
**Статус:** Обсуждено с пользователем — оставлено composition
**Ответ:** Locked decision из brainstorming держится. Composition — explicit, легче review'ить, mirror'ит CcsDriver. Subclass-вариант оставлен в design в section "Why composition (and not the alternatives)" как rejected option.
**Действие:** Design без изменений в этом пункте; Plan rephrase'ит overview "subclass alternative was considered and rejected to keep the interface explicit".

---

### [SUGG-5] Test the trailing-slash OLLAMA_HOST normalization explicitly

**Источник:** ollama-kimi
**Статус:** Автоисправлено (см. CRIT-4)
**Действие:** Plan Task 3 — характеризационный test "strips trailing slash from OLLAMA_HOST". Plan Task 8 — то же в setup() env.

---

### [SUGG-6] Wrap preflightModel() in try/catch for transient errors

**Источник:** ollama-kimi
**Статус:** Автоисправлено (см. CRIT-6)
**Действие:** Plan Task 6.

---

### [SUGG-7] Client-side guard for empty model string

**Источник:** ollama-kimi
**Статус:** Отклонено
**Ответ:** YAGNI. Backend setup() throw "Ollama agent requires a model" уже surface'ит ошибку понятно. Остальная UI работает по принципу submit→serverside-error. Дублировать validation на UI добавляет maintenance без user-value.
**Действие:** Не применено.

---

### [SUGG-8] Mock fetch consistently — vi.stubGlobal vs globalThis.fetch

**Источник:** ollama-minimax
**Статус:** Отклонено (стилистика)
**Ответ:** Оба паттерна валидны в vitest. План использует `globalThis.fetch = vi.fn()` consistent — выбран потому что save/restore через `originalFetch` в beforeEach/afterEach самодокументируется. Унификация со spec не критична — spec был написан до plan'а как design intent.
**Действие:** Не применено.

---

### [SUGG-9] Test refine-steps stepVariantLabel with ollama

**Источник:** ollama-minimax
**Статус:** Отклонено
**Ответ:** Overengineered. Лейбл "Effort" vs "Variant" — purely cosmetic для refine-steps UI; ollama попадает в "Variant" branch, что harmless т.к. фактически input скрыт через `variantOptions.length > 0`. Driver-side strip primary защита. Тест на лейбл не добавит реальной ценности.
**Действие:** Не применено. Plan Task 15.1 (c) явно объясняет это решение для будущего maintainer'а.

---

### [SUGG-10] Plan Task 16 should also touch .claude/rules/frontend.md

**Источник:** ollama-minimax
**Статус:** Автоисправлено
**Действие:** Plan Task 17 (была Task 16) — добавлен Step 17.2 "Update `.claude/rules/frontend.md`".

---

### [SUGG-11] Pre-PR cleanup may miss other docs/superpowers/* artifacts

**Источник:** ollama-minimax
**Статус:** Автоисправлено
**Ответ:** Расширен `git rm` блок: design + plan + review-merged-iter-* + review-iter-* + execution-prompt + любые execution/ docs если будут.
**Действие:** Plan § "Pre-PR Cleanup" обновлён — список путей расширен, добавлен `2>/dev/null || true` чтобы не падать на отсутствующих файлах.

---

### [SUGG-12] Add explicit test or comment for [1K] (uppercase)

**Источник:** ollama-minimax
**Статус:** Отклонено
**Ответ:** Regex `/i` flag покрывает upper-case. Отдельный тест overengineered (нет реального cloud-модели с uppercase suffix). Минор.
**Действие:** Не применено.

---

### [SUGG-13] Document effort/variant dropdown is hidden (not disabled) for ollama

**Источник:** ollama-minimax
**Статус:** Автоисправлено
**Ответ:** Design § "Non-Goals" — расширено объяснение "The variant input is hidden by `variantOptions.length > 0` (the model dropdown returns no `variants`)". Plan Task 15.1 (c) тоже документирует.
**Действие:** Design + Plan обновлены.

---

### [QUEST-1] Was /v1/models behavior verified against signed-in Ollama >=0.20?

**Источник:** codex
**Статус:** Обсуждено + автоисправлено
**Ответ:** Da, после получения вопроса я эмпирически проверил на актуальной машине пользователя (ollama 0.23.1). Результат: `data:null`. Полный shift на per-model probe (CRIT-2 решение).
**Действие:** Design § "listModels()" — "verified empirically on Ollama 0.23.1".

---

### [QUEST-2] What should --variant do for --agent ollama?

**Источник:** codex + ollama-kimi
**Статус:** Обсуждено с пользователем
**Ответ:** Silent strip в runSession/startChat. Никакого warning'а или throw'а — driver-side стрип это invariance, пользователю не нужно об этом думать.
**Действие:** см. CRIT-3.

---

### [QUEST-3] Should README.md be updated?

**Источник:** codex
**Статус:** Автоисправлено
**Ответ:** Да. Проверено `grep "claude\|opencode\|ccs\|codex" README.md` — упоминаний 4 (lines ~14, ~73, ~85, ~120).
**Действие:** Plan Task 17.4 — обновить README.md в 4 местах.

---

### [QUEST-4] If /v1/models is not the cloud catalog, what source is acceptable?

**Источник:** codex
**Статус:** Обсуждено с пользователем (выбран hardcoded catalog)
**Действие:** см. CRIT-2.

---

### [QUEST-5] Does claude-agent-sdk replace or merge env when given options.env?

**Источник:** albb-qwen
**Статус:** Автоисправлено (документация)
**Ответ:** SDK forwards env через `spawn(..., { env })`. Child получает env block как есть. Поэтому `{ ...process.env }` обязателен в `buildEnv()` — иначе child потеряет PATH/HOME/LANG.
**Действие:** Design § "Env vars" — раздел "Why `ANTHROPIC_API_KEY=""` is safe" + "Why blacklist instead of whitelist" документируют env-semantics.

---

### [QUEST-6] Does parseContextWindow need to accept decimals like [1.5m]?

**Источник:** ollama-kimi
**Статус:** Автоисправлено
**Ответ:** Нет. Regex `/\[(\d+)([km])\]/i` — integer only by design (нет известных cloud моделей с decimal context). `[1.5m]` → null → env var omitted. Fixed by explicit non-goal.
**Действие:** Design § "Non-Goals" — добавлен пункт "Decimal context-window suffixes (e.g. `[1.5m]`)". Plan Task 9 — добавлен test "ignores decimal suffix [1.5m]".

---

### [QUEST-7] Is applyHooks needed in factory case for ollama?

**Источник:** ollama-kimi
**Статус:** Отклонено (false positive)
**Ответ:** `applyHooks` — параметр CcsDriver-only (передаётся в его конструктор как 3-й аргумент: `new CcsDriver(model, useUserSettings, applyHooks)`). Для ollama hooks plumb через inner ClaudeDriver.setup() который мы и так вызываем — никаких отдельных hooks-связок не нужно.
**Действие:** Design § "CLI / UI / wiring" — явная пометка "applyHooks is CCS-only and does not apply to ollama".

---

## Изменения в документах

| Файл | Изменение |
|------|-----------|
| `docs/superpowers/specs/2026-05-06-ollama-agent-design.md` | Goals/Non-Goals (intentional divergence + variant strip + decimal/unix-socket reject); Architecture skeleton (catalog + cloud-guard + variant strip + env merge); Setup flow / Env vars (PREFLIGHT_TIMEOUT_MS, env hygiene blacklist, why merge, why API_KEY="" safe, ATTRIBUTION_HEADER comment); resolveBaseUrl() with normalization (trim, unix-socket reject, whitespace reject, trailing slash strip, IPv6 note); Preflight (per-model GET with 404/5xx disambiguation); listModels() (catalog-then-probe rationale, setup-free contract); new section "Mid-session failures"; new section "/api/models server route"; CLI/UI/wiring (factory applyHooks note, /api/models extension, useUserSettings checkbox); Error handling table extended (non-cloud, unix-socket, whitespace, transient probe, variant strip, mid-session); Testing (13 test groups, ~25-30 cases including parent-leak strip, variant strip, env merge, decimal reject); footprint update; Verification update (no vue-tsc). |
| `docs/superpowers/plans/2026-05-06-ollama-driver.md` | Architecture overview (composition rationale + per-model probe explanation); File Structure (added server/routes/models.ts, frontend.md, README.md, Reviewer auto-derive note, useUserSettings checkbox extension); Task 2 (rewritten to catalog + per-model probe + URL encoding); Task 3 (now characterization for OLLAMA_HOST normalization with 5 tests); Task 4 (NEW — cloud-only guard); Task 5 (preflight daemon — PREFLIGHT_TIMEOUT_MS); Task 6 (rewritten — per-model GET with 404/5xx tests); Task 7 (env hygiene + variant strip + caller-env merge + 4 new tests); Task 8 (characterization for setup() env OLLAMA_HOST + unix-socket throw); Task 9 (decimal suffix test added); Task 10 (rewritten — startChat strip + merge + 3 tests); Task 13 (Reviewer auto-derive note); Task 15 (rewritten — useUserSettings checkbox extension, accurate variant gate description, vue-tsc removed); Task 16 (NEW — /api/models route fix); Task 17 (was 16 — extended docs to frontend.md + README.md, drivers.md updated); Task 18 (was 17 — extended fail modes including non-cloud and OLLAMA_HOST checks); Pre-PR Cleanup (extended path list with `2>/dev/null \|\| true`); Self-Review Checklist (updated to 13 test groups, all 7 CRIT issues mapped). |

## Статистика

- Всего замечаний: 43
- Автоисправлено: 33
- Обсуждено с пользователем: 4 (CRIT-2, CRIT-3, CRIT-5, SUGG-4)
- Отклонено: 6 (CONC-11, CONC-13, CONC-14, SUGG-7, SUGG-8, SUGG-9, SUGG-12, QUEST-7 → 8 отклонений; CONC-13 частично применено)
- Повторов (автоответ): 0 (первая итерация)
- Пользователь сказал "стоп": Нет
- Агенты успешные: codex-executor, gemini-executor, ccs-executor (albb-qwen, ollama-kimi, ollama-minimax)
- Агенты failed: ccs-executor (glm — upstream 429), ccs-executor (ollama-deepseek — process died mid-stream)
