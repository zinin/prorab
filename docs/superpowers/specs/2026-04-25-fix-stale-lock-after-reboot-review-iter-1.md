# Review Iteration 1 — 2026-04-25 07:53

## Источник

- Design: `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-design.md`
- Plan: `docs/superpowers/plans/2026-04-25-fix-stale-lock-after-reboot.md`
- Review agents: codex-executor (gpt-5.5, xhigh), gemini-executor, ccs-executor (glm, albb-glm, albb-qwen, albb-kimi, albb-minimax, deepseek)
- Merged output: `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-review-merged-iter-1.md`

## Замечания

### [USER-1] argv1 exact-match хрупок под node/npx/tsx/symlinks

> Уязвимость точного сравнения argv1: process.argv[1] резолвится в абсолютный путь, /proc/<pid>/cmdline хранит execve-токены как переданы. Под `node ./dist/index.js`, `npx prorab`, `tsx`, ts-node, относительными symlinks живой prorab будет признан "не our" → mutex развалится.

**Источник:** codex (Critical), gemini (Critical Blocker), kimi (Critical), albb-qwen (Concern), glm (Concern), albb-glm (Critical)
**Статус:** Обсуждено с пользователем
**Ответ:** Перейти на /proc/<pid>/cwd сравнение
**Действие:**
- Lock-формат вернулся к `{ pid, startedAt }` без `argv1`
- Helper `isProrabProcess` переименован в `isOwningProcess(pid, lockedCwd)`
- Логика: Tgid check → readlinkSync /proc/<pid>/cwd → сравнить с realpathSync(lockedCwd)
- Удалена backwards-compat ветка для legacy lock-файлов с argv1 (формат не меняется в принципе)

### [USER-2] TOCTOU между isProcessAlive и /proc reads

> Если процесс умер в окне между kill(0) и readFileSync('/proc/<pid>/...'), вылетит ENOENT, текущая обработка возвращает null → conservative throw. Пользователь видит 409 для уже мёртвого процесса.

**Источник:** gemini (Concern), glm (Critical), albb-kimi (Suggestion), albb-qwen (Concern), deepseek (Concern)
**Статус:** Обсуждено с пользователем
**Ответ:** ENOENT → process is gone → overwrite
**Действие:** В `isOwningProcess` добавлена явная ENOENT-ветка: `if (err.code === "ENOENT") return false`. Остальные ошибки collapse'ятся в null. Покрыто новым Task 8 в плане.

### [USER-3] boot_id альтернатива для btime

> Linux /proc/sys/kernel/random/boot_id даёт UUID на каждую загрузку, не зависит от часов. Был бы чище btime gate.

**Источник:** glm (Suggestion), deepseek (Question)
**Статус:** Обсуждено с пользователем
**Ответ:** Оставить btime + os.uptime fallback
**Действие:** Минимизация scope; btime cross-platform работает; boot_id явно добавлен в Non-Goals со ссылкой на это решение.

### [AUTO-1] Task 4 plan bug: uptimeMock.mockReturnValue(0) ведёт по неправильной ветке

> При uptime = 0, getBootTime вычисляет `Math.floor(Date.now()/1000 - 0) = now`. Условие `Number.isFinite && uptime > 0` возвращает false (0 не > 0), функция возвращает null. Корректно. НО в новой логике: при `0` мы проходим в условие fallback, а `Number.isFinite(0) && 0 > 0` = false → возвращает null. Так что test passes. Однако если кто-то слегка изменит логику (например, на >= 0), всё сломается. Лучше явно throw.

**Источник:** albb-kimi (Question Q4)
**Статус:** Автоисправлено
**Ответ:** заменить mockReturnValue(0) на mockImplementation(() => { throw new Error(...) })
**Действие:** Task 4 (новая нумерация — был Task 4 в старом плане) использует `uptimeMock.mockImplementation(() => { throw new Error("uptime unavailable"); })`. Объяснение добавлено комментарием в Step 1.

### [AUTO-2] Tgid regex не учитывает trailing whitespace

> /^Tgid:\s*(\d+)$/m может не сработать при trailing whitespace после числа на некоторых ядрах.

**Источник:** albb-qwen (Concern), albb-glm (Concern)
**Статус:** Автоисправлено
**Действие:** Regex изменён на `/^Tgid:\s*(\d+)\s*$/m` в spec и plan.

### [AUTO-3] Missing Tgid field трактовался как false (overwrite)

> Если /proc/<pid>/status доступен но в нём нет строки Tgid, текущая логика возвращает false → перезапись lock. Это противоречит принципу "conservative when uncertain". Должно быть null → throw.

**Источник:** codex (Critical), deepseek (Suggestion)
**Статус:** Автоисправлено
**Действие:** В `isOwningProcess`: `if (!tgidMatch) return null` (вместо подразумеваемого false). Добавлен новый тест 10 в Task 9: missing Tgid → throws.

### [AUTO-4] Spec mock strategy не соответствовал plan

> Spec говорил "vi.spyOn strategy (no whole-module vi.mock)", plan использует vi.mock с partial pass-through. Несогласованность.

**Источник:** codex (Critical), albb-minimax (Critical)
**Статус:** Автоисправлено
**Действие:** В spec секции "Tests" описана реальная стратегия: partial vi.mock для node:fs/node:os с pass-through, vi.spyOn для process.kill/console.warn, Object.defineProperty для process.platform. Plan и spec теперь согласованы.

### [AUTO-5] План имел 8 тестов вместо 10 в spec

> Spec упоминал 10 cases, plan создавал 8. Mapping не задокументирован.

**Источник:** codex (Critical), albb-qwen (Critical)
**Статус:** Автоисправлено
**Действие:** Новый plan имеет 10 тестов в lock-stale-detection.test.ts. "Fresh start" покрыт существующим lock.test.ts (без изменений в формате lock — assertion на argv1 убран). "Corrupt JSON" покрыт существующим lock.test.ts (regression-тест). Spec явно перечисляет 10 кейсов с комментарием про lock.test.ts coverage.

### [AUTO-6] mockReset() избыточен в beforeEach

> mockReset сбрасывает реализацию в undefined, потом mockImplementation восстанавливает pass-through. Двойная работа. mockClear достаточно.

**Источник:** deepseek (Critical)
**Статус:** Автоисправлено
**Действие:** В новом plan'е beforeEach использует `mockClear()` затем re-installs pass-through через `mockImplementation`. Изменение применено к readMock, readlinkMock, uptimeMock.

### [AUTO-7] Test 7 (genuine running prorab) хрупкий

> Тест полагался на реальный process.argv[1] vitest и реальный /proc/self/cmdline. Под симлинками/wrappers/non-Linux мог не работать или работать по неверной причине.

**Источник:** codex (Concern), gemini (Critical Blocker), albb-kimi (Concern), deepseek (Critical), albb-qwen (Concern), glm (Concern), albb-glm (Concern)
**Статус:** Автоисправлено
**Действие:** Test 7 переписан с использованием моков (как Tasks 5/6). Тест использует `fakePid = 99999994`, мокает `/proc/<fakePid>/status` (Tgid match) и `/proc/<fakePid>/cwd` (= realpathSync(tempDir)). Полностью детерминистичен, не зависит от способа запуска vitest. `it.skipIf(...)` не нужен.

### [AUTO-8] Tgid порядок (was: cmdline first для perf)

> Suggestion: на одном syscall меньше при cmdline mismatch — проверка cmdline → если match, проверка Tgid.

**Источник:** glm (Suggestion), albb-kimi (Critical, perf)
**Статус:** Автоисправлено (но в новой логике)
**Действие:** В новой архитектуре (cwd-based): Tgid идёт первым (1 syscall дешёвый readFileSync /proc/<pid>/status), затем cwd (1 syscall readlinkSync). Tgid-first защищает от ложно-положительных при cwd-наследовании от родительского процесса в потоках. Cwd-second семантически правильнее.

### [AUTO-9] Post-boot dead PID не покрыт регрессионным тестом

> Существующий lock.test.ts "removes stale lock from dead process" использует startedAt: "2020-01-01" и dead PID. С btime gate он теперь выходит на шаге 1 (predates boot), а не шаге 2 (process is gone). Шаг 2 не покрыт.

**Источник:** albb-qwen (Critical)
**Статус:** Автоисправлено
**Действие:** Добавлен Task 3 в plan: "Post-boot dead-PID regression test". Тест с startedAt = `Date.now() - 60_000` (1 минута назад → после boot) и dead PID. Ожидание: warn `process is gone`.

### [AUTO-10] expect.stringMatching хрупко для warn-сообщений

> stringMatching с regex чувствителен к forming. Лучше stringContaining (substring match).

**Источник:** albb-kimi (Concern), albb-qwen (Concern), deepseek (Concern), glm (Suggestion)
**Статус:** Автоисправлено
**Действие:** Все warn-assertions в plan'е используют `expect.stringContaining(...)`. Reason fragments стабильны: "predates boot", "process is gone", "reused by non-prorab".

### [DIS-1] Кеширование getBootTime между вызовами

> Boot time не меняется в течение жизни процесса; можно вычислить раз при первом acquireLock.

**Источник:** glm (Suggestion)
**Статус:** Отклонено
**Ответ:** acquireLock вызывается ровно раз на старт сессии prorab serve (или ещё реже для CLI run). Perf-выгода ничтожна, не оправдывает усложнение state.

### [DIS-2] Warn-сообщения как именованные константы

> Стилистическое улучшение для maintainability.

**Источник:** albb-qwen (Suggestion), deepseek (Suggestion), glm (Suggestion)
**Статус:** Отклонено
**Ответ:** Сообщений всего 4, reason-фрагменты ("predates boot", "process is gone", "reused by non-prorab", "corrupt") стабильны. Тесты используют stringContaining, поэтому косметические правки сообщений тестов не сломают. Не вижу необходимости в constant-extraction сейчас.

### [DIS-3] Atomic O_EXCL lock creation

> existsSync → read → writeFileSync неатомарно. Два процесса могут одновременно увидеть отсутствие lock и оба написать.

**Источник:** codex (Concern)
**Статус:** Отклонено
**Ответ:** Out of scope — это существующая проблема в `lock.ts`, не введённая текущей фичей. Может быть отдельным bug-fix'ом.

### [DIS-4] Тест на zombie-процесс

> /proc/<pid>/cmdline для zombie может быть пустым.

**Источник:** albb-minimax (Concern), albb-glm (Question)
**Статус:** Отклонено
**Ответ:** В новой логике (cwd-based) zombie обработается естественно: readlinkSync /proc/<zombiePid>/cwd на zombie бросит ENOENT (или EACCES) → ENOENT-ветка вернёт false → overwrite. Edge case покрыт без специального теста.

### [DIS-5] PID namespace в Docker/Podman

> Внутри контейнера PID namespace может отличаться от host. Lock написан на host, прочитан в container — поведение непредсказуемо.

**Источник:** albb-kimi (Suggestion S5)
**Статус:** Отклонено
**Ответ:** Out of scope. Cross-namespace lock sharing не поддерживается ни до фикса, ни после. Документировано в edge cases таблице spec.

### [DIS-6] Тест на clock skew (future startedAt)

> startedAt в будущем (часы перевели вперёд) — обработка?

**Источник:** albb-kimi (Concern), deepseek (Suggestion)
**Статус:** Отклонено
**Ответ:** При `startedSec > bootSec` btime gate просто не срабатывает (`startedSec < bootSec` = false), flow идёт на PID checks. Это и есть корректное поведение. Документировано в edge cases таблице spec ("startedAt invalid date — Date.parse → NaN → btime gate skipped").

### [DIS-7] Type-cast hack в mock implementation

> `((path: ..., ...args: unknown[]) => ...) as typeof readFileSync` — вынужденный typescript-хак.

**Источник:** glm (Concern)
**Статус:** Отклонено
**Ответ:** Стилистика; вытекает из ограничений vitest type-inference для mocked builtins. Альтернативы (полная typed factory) более многословны и не дают выигрыша.

### [DIS-8] process.platform parallel test isolation

> vitest по умолчанию parallel; Object.defineProperty(process, "platform") может race'ить с другими тестами.

**Источник:** albb-glm (Concern)
**Статус:** Отклонено
**Ответ:** vitest изолирует test files в worker'ах (process.platform override живёт только в одном worker). afterEach restore'ит оригинальное значение. Внутри файла тесты sequential. Защита достаточна.

### [DIS-9] Explicit pid validation (NaN/negative/0)

> data.pid может быть нечислом или некорректным значением.

**Источник:** codex (Concern)
**Статус:** Отклонено
**Ответ:** `process.kill(invalid, 0)` throws → `isProcessAlive` возвращает false → step 2 → overwrite. Корректное и безопасное fall-through; явная валидация не добавляет ценности. Документировано в edge cases.

### [DIS-10] releaseLock не обновлён

> При смене формата lock-файла стоит обновить releaseLock.

**Источник:** albb-minimax (Critical), deepseek (Question)
**Статус:** Отклонено / неактуально
**Ответ:** Формат lock-файла НЕ меняется (по решению USER-1). releaseLock работает без изменений.

### [DIS-11] Рассмотреть proper-lockfile

> Готовая библиотека с stale-detection.

**Источник:** albb-kimi (Question Q1), albb-minimax (Question Q1)
**Статус:** Отклонено
**Ответ:** Добавлено в Non-Goals spec'а: "adds dependency, fragile under SIGKILL on some filesystems". Текущий подход с `{pid, startedAt}` уже почти работает; нужно его починить, не заменять стек.

### [DIS-12] /proc/<pid>/cwd на macOS

> Что если когда-нибудь добавим macOS support?

**Источник:** gemini (Suggestion)
**Статус:** Отклонено
**Ответ:** Решено USER-3 + non-Linux conservative throw. Когда придёт время macOS поддержки, добавим `ps`-based ownership check. Сейчас не нужен.

### [DIS-13] Single-binary builds (pkg/bun)

> Если в будущем prorab будет собран в единый бинарник, argv[1] будет undefined/странный.

**Источник:** gemini (Question)
**Статус:** Отклонено / неактуально
**Ответ:** В новой архитектуре argv1 не используется. /proc/<pid>/cwd работает одинаково для любого способа запуска. Hypothetical future-proof через cwd-check уже встроен.

## Изменения в документах

| Файл | Изменение |
|------|-----------|
| `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-design.md` | Полная переработка: убран `argv1` из формата, новая функция `isOwningProcess(pid, lockedCwd)` через /proc/<pid>/cwd, явная ENOENT-ветка, обновлены edge cases (Tgid missing → null, ENOENT → false), 10 тест-кейсов вместо 8/10 mismatch, Non-Goals явно перечисляет boot_id/proper-lockfile/atomic-O_EXCL/macOS-ps. |
| `docs/superpowers/plans/2026-04-25-fix-stale-lock-after-reboot.md` | Полная переработка: 10 тасков (новая нумерация), убран таск про argv1 (формат не меняется), новые таски — cwd-check (Task 5), Tgid (Task 6), live-owning детерминистичный с моками (Task 7), ENOENT (Task 8), conservative throws (Task 9). Mock-стратегия документирована (mockClear + pass-through). Все warn-assertions через stringContaining. Tgid regex `/^Tgid:\s*(\d+)\s*$/m`. |
| `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-review-merged-iter-1.md` | Создан — содержит выводы 8 ревью-агентов. |
| `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-review-iter-1.md` | Этот файл. |

## Статистика

- Всего замечаний: 26 (после дедупликации)
- Обсуждено с пользователем: 3 (USER-1, USER-2, USER-3)
- Автоисправлено: 10 (AUTO-1 .. AUTO-10)
- Отклонено: 13 (DIS-1 .. DIS-13)
- Повторов (автоответ): 0 (это первая итерация)
- Пользователь сказал "стоп": Нет
- Агенты: codex-executor (gpt-5.5, xhigh), gemini-executor, ccs-executor (glm, albb-glm, albb-qwen, albb-kimi, albb-minimax, deepseek)
