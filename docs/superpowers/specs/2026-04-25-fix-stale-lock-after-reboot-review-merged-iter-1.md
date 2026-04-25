# Merged Design Review — Iteration 1

**Date:** 2026-04-25

**Documents reviewed:**
- Design: `docs/superpowers/specs/2026-04-25-fix-stale-lock-after-reboot-design.md`
- Plan: `docs/superpowers/plans/2026-04-25-fix-stale-lock-after-reboot.md`

**Agents:** codex-executor (gpt-5.5, xhigh), gemini-executor, ccs-executor (glm, albb-glm, albb-qwen, albb-kimi, albb-minimax, deepseek)

---

## codex-executor (gpt-5.5)

### Critical Issues

- **`argv1` + точное-токенное сравнение небезопасно.** В дизайне `argv1 = process.argv[1]`, а проверка ищет этот текст как exact token в `/proc/<pid>/cmdline`. На Node 24 `process.argv[1]` обычно абсолютный путь, а `/proc/.../cmdline` хранит исходный (часто относительный) токен. Пример: `node showargv.js` → `process.argv[1] = /tmp/.../showargv.js`, но `cmdline = node\0showargv.js\0`. Живой `prorab` будет ошибочно признан "non-prorab" и lock перезапишется.
- **Поломка mutex-инварианта при типичных способах запуска.** `node dist/index.js`, `./dist/index.js`, shebang через относительный symlink, `tsx`, `ts-node`, многие dev-запуски — могут позволить второму процессу стартовать поверх живого первого.
- **Стратегия моков противоречит сама себе.** Дизайн требует `vi.spyOn` без whole-module mock, а план использует hoisted `vi.mock("node:fs")`/`vi.mock("node:os")`. С учётом named imports в `lock.ts` поздний `spyOn` ненадёжен.
- **Missing `Tgid` трактуется как "false/overwrite".** Это неверно — это "cannot tell". Корректнее вернуть `null` и консервативно бросить.
- **План тестов не соответствует спецификации.** Спека перечисляет 10 новых кейсов, план создаёт 8.

### Concerns

- TOCTOU между `process.kill(pid, 0)` и чтением `/proc/<pid>/...` ведёт к `null` и throw. `ENOENT` после успешного alive-check можно безопаснее трактовать как "process is gone" и перезаписывать.
- Проверка "это prorab" не проверяет, что процесс держит lock именно этого `cwd`. PID, переиспользованный другим `prorab` из другого проекта с тем же `argv1`, даст `true` → ложный 409.
- Тест `genuine running prorab` опирается на реальный `/proc/self/cmdline` и утверждает, что там есть `process.argv[1]`. Это предположение не всегда верно для Node-запусков — тест будет зелёным в CI и при этом не ловить реальный баг.
- Слабая валидация `pid`/`startedAt`. Валидный JSON с `pid: 0`, отрицательным значением, строкой или NaN-подобным значением попадёт в `process.kill` и даст странные ветки.
- Базовая блокировка по-прежнему не атомарна: `existsSync` → read → `writeFileSync`. Существующая проблема, но feature позиционируется как cross-process mutex.

### Suggestions

- **Рассмотреть замену `argv1`-ownership на Linux `pid + /proc/<pid>/stat` starttime (поле 22).** Решает PID reuse без хрупкости путей.
- **Если оставлять `argv1`** — канонизировать сравнение: читать `/proc/<pid>/cwd`, резолвить относительные cmdline-токены относительно cwd процесса, применять `realpathSync`/`resolve`.
- **Добавить в lock-файл `cwd`/`lockPath`** и на Linux сравнивать `/proc/<pid>/cwd` с проектным cwd.
- **Синхронизировать документы:** либо везде `vi.mock` pass-through, либо динамический import после setup spy.
- **Упростить warn-assertions:** не проверять всю строку, только стабильный reason token, или вынести reason-фразы в константы.

### Questions

- Нужно ли официально поддерживать dev-запуски `node dist/index.js`, `tsx src/index.ts`, `ts-node`?
- Почему отсутствие `Tgid` считается доказательством "не наш процесс", а не "не можем определить"?
- Чиним только reboot-stale, или также same-boot PID reuse после `kill -9`?
- Должен ли lock действительно быть строгим cross-process mutex? Если да — отдельной задачей заменить `existsSync`/`writeFileSync` на атомарное создание lock-файла (`O_EXCL`).

---

## gemini-executor

### Critical Issues

1. **Уязвимость точного сравнения `argv1` (Blocker)**. `tokens.includes(expectedArgv1)` не работает в реальных условиях. Node.js резолвит `process.argv[1]` в абсолютный путь (с раскрытием симлинков). `/proc/<pid>/cmdline` содержит токены ровно в том виде, в котором они были переданы в `execve`. Примеры: `node ./dist/index.js`, `npx`, symlinks. Валидный prorab будет воспринят как чужой → lock перезапишется → разрушение mutex.
2. **Флакающий тест в Task 7**. Полагается на `process.argv[1]` vitest и реальный `/proc/self`. Если они не совпадут — тест упадёт по неверной причине.

### Concerns

1. **TOCTOU ведёт к ложным 409**. Если процесс умер между `isProcessAlive` и чтением `/proc`, вылетит `ENOENT`, вернётся `null`, бросится 409 для уже мёртвого процесса.
2. **Зависимость тестов от `process.platform`**. На macOS Test 7 пройдёт по неверной причине (non-Linux вместо cmdline-match).

### Suggestions

1. **Альтернативный способ проверки**: вместо хрупкой проверки cmdline, проверять **рабочую директорию процесса (cwd)** через `fs.readlinkSync('/proc/<pid>/cwd')`. Совпадение с `cwd` проекта = 100% гарантия.
2. **Если оставлять `argv1`** — смягчить проверку: `tokens.some(t => t.endsWith(expectedArgv1) || expectedArgv1.endsWith(t) || t.includes('prorab'))`.
3. **Обработка `ENOENT` в TOCTOU**: при `err.code === 'ENOENT'` возвращать `false` (процесс умер, lock 100% свободен), а не `null`.
4. **Фикс тестов Task 7**: не использовать настоящий `process.pid`, замокать `/proc/<pid>/cmdline` и `/proc/<pid>/status` как в Task 5/6.

### Questions

1. Планируется ли в будущем собирать `prorab` в единый бинарник (через `pkg` или `bun build`)? Это сломает `argv[1]`.
2. Насколько реален кейс "повторное использование PID **без** перезагрузки" на ваших серверах? Возможно, отказаться от `isProrabProcess` и оставить только `btime`?

---

## ccs-executor (glm)

### Critical Issues

1. **`getBootTime()` вызывает `readFileSync`, который замокан глобально — неявное сцепление**. Каждый тест должен явно учитывать все возможные пути.
2. **`isProrabProcess` проверяет `/proc/<pid>/status` ДО `/proc/<pid>/cmdline` — лишний системный вызов**. cmdline-проверка дешевле и отсекает 99% ложных PID. Tgid нужен только при совпадении cmdline.
3. **TOCTOU между `isProcessAlive` и чтением `/proc/<pid>/{status,cmdline}`** ведёт к conservative throw, пользователь должен повторить запрос. План не упоминает это как known limitation, не добавляет retry.

### Concerns

1. **`argv1` при запуске через `npx`** — путь во временном кэше. Между запусками хэш меняется, но в рамках одной инкарнации совпадает. Стоит явно указать в комментариях.
2. **`cmdline` сравнение через `tokens.includes(expectedArgv1)` — exact match**. На Linux работает (cmdline содержит ровно execve-аргументы), но при symlink-переключении версий между запусками — может ввести в заблуждение.
3. **`releaseLock` не проверяет `argv1`**. Существующая проблема (PID reuse в рамках одной сессии).
4. **Формат mock-implementation — хрупкий type-cast**. `((path: ..., ...args: unknown[]) => ...) as typeof readFileSync` — вынужденный хак. Альтернатива: `vi.fn<Parameters<typeof readFileSync>, ReturnType<typeof readFileSync>>()`.
5. **Тест Task 7 не работает на macOS**. План упоминает `it.skipIf(process.platform !== "linux")`, но не добавляет его сейчас.
6. **Тест Task 4: `uptimeMock.mockReturnValue(0)`**. `os.uptime()` никогда не возвращает 0 в реальной системе. Стоит использовать `NaN` или mock с исключением.

### Suggestions

1. **Рассмотреть `boot_id` вместо вычисления btime**. Linux предоставляет `/proc/sys/kernel/random/boot_id` — UUID, уникальный для каждой загрузки. Устраняет `getBootTime()`, fallback, проблемы с drift.
2. **Инвертировать порядок проверок в `isProrabProcess`**: cmdline сначала, Tgid потом.
3. **Добавить явный retry при TOCTOU `null`**.
4. **Кешировать `getBootTime()` на время жизни процесса**.
5. **Документировать сценарий `npx` в комментарии к `argv1`**.

### Questions

1. Почему `Tgid`-проверка выполняется ДО `cmdline`?
2. Есть ли данные о частоте false positive lock в продакшене?
3. Рассматривался ли `flock(2)` / `fcntl(F_SETLK)` как альтернатива?
4. Что происходит при `prorab serve` с несколькими параллельными запросами?

---

## ccs-executor (albb-glm)

### Critical Issues

1. **TOCTOU coverage неполный в формулировке, но корректный в коде**.
2. **Mock-инфраструктура: `vi.mock` pass-through ломается с named imports** — vitest обрабатывает это автоматически для ESM, но не всегда для CJS/interop. План не проверяет конфигурацию `vitest.config.ts` (`deps.interopDefault: true`).
3. **Cmdline match exact**: edge case absolute vs relative argv1 не покрыт тестами.
4. **`process.argv[1]` undefined → `argv1: ""` → legacy behavior**. Не позволяет отличить "really legacy" от "new with empty argv1".
5. **Warn-message assertions unstable**. `toHaveBeenCalledWith` checks at least one call. Нужно `toHaveBeenCalledTimes(1)` для single-warn branches.

### Concerns

1. `Tgid` regex с tabs vs spaces — covered.
2. `/proc/stat` regex — OK.
3. `Date.parse` reliability — OK.
4. `os.uptime()` fallback race condition — sub-second drift acceptable.
5. **Platform override: vitest runs tests parallel by default**. Нужен `--threads=false` или `poolOptions.forks.singleFork`. План не указывает это.
6. **Task 7: добавить `it.skipIf(process.platform !== "linux")` сейчас**, не «когда-нибудь».

### Suggestions

1. Добавить `toHaveBeenCalledTimes(1)` в warn assertions.
2. Проверить Vitest конфигурацию для `vi.mock` pass-through.
3. Документировать порядок чтения `status` → `cmdline` в Design.
4. Добавить edge-case test для argv1 mismatch (absolute vs relative path).
5. Указать в плане необходимость `--no-threads` или `pool: 'forks'` для `process.platform` override safety.

### Questions

1. Legacy lock без `argv1` с `pid: process.pid` и `startedAt` predates boot — должен ли тест покрывать этот case?
2. EACCES на `/proc/<pid>/status` — `null` → throw. Conservative, но стоит ли warn?
3. Zombie process: `/proc/<pid>/cmdline` empty — стоит ли explicit test?
4. Multi-lock scenario: два разных cwd, два lock files — нужен ли тест?

---

## ccs-executor (albb-qwen)

### Critical Issues

1. **Существующий тест #3 меняет путь выполнения**. `lock.test.ts` тест `"removes stale lock from dead process"` пишет `startedAt: "2020-01-01"`. После btime-гейта lock будет перехвачен на шаге 1 (`predates boot`), а не на шаге 2 (`process is gone`). Сценарий "dead process after boot" больше не покрыт. План не добавляет регрессионный тест.
2. **`vi.mock("node:fs")` с pass-through — риск конфликтов с другими моками `node:fs`**. В проекте есть `project-state.test.ts` и `run-attempt-counter.test.ts` с `vi.mock("node:fs")`. Vitest изолирует module cache per-test-file, но не гарантировано при определённых конфигурациях `threads`.
3. **План: 8 тестов вместо 10 в spec**. Missing: "fresh start (no lock) → writes lock with argv1" (частично покрыт extension lock.test.ts), "corrupt JSON" (покрыт существующим тестом). Plan должен явно задокументировать mapping.

### Concerns

4. **Tgid regex может не сработать с trailing whitespace**. Безопаснее: `/^Tgid:\s*(\d+)\s*$/m`.
5. **Test 7 — fragility на разных способах запуска vitest**. Может не работать при shebang, wrapper-скриптах, `node --import`. Plan не добавляет `it.skipIf`.
6. **Warn-message assertions через `expect.stringMatching`** — хрупки к рефакторингу сообщений. Стоит зафиксировать в константах.
7. **TOCTOU**: пользователь видит confusing 409 для уже мёртвого процесса. Acceptance criteria должны явно задокументировать.
8. **`process.argv[1] ?? ""` — пустая строка как falsy**. Два реальных prorab процесса одного инсталла не обнаружат друг друга через cmdline → consecutive throw.

### Suggestions

9. **Добавить тест для ветки "Tgid matches but cmdline mismatch"**.
10. **Изменить regex Tgid** на `/^Tgid:\s*(\d+)\s*$/m`.
11. **Добавить regression test "dead process after boot"**.
12. **Упомянуть `os` import в Task 2 commit message** (чисто документация).

### Questions

1. Нужно ли добавлять explicit тест для `startedAt >= bootSec && PID dead`?
2. Стоит ли вынести warn-сообщения в константы?
3. Как обрабатывать "оба prorab запущены, но с разными argv1"?
4. Планируется ли CI-запуск на macOS?

---

## ccs-executor (albb-kimi)

### Critical Issues

1. **`Tgid` проверка имеет ошибку порядка**. Проверка должна быть первой; текущий порядок status→cmdline даёт два syscalls вместо одного. Если `Tgid !== pid`, зачем читать `cmdline`?
2. **`argv1` может не совпадать между разными способами запуска**. `npx`, `node dist/index.js`, `tsx src/index.ts` — все дают разные `argv1`. Если первый запуск через `npx`, а второй через `node` — `argv1` не совпадут, и живой процесс будет признан "не our".

### Concerns

3. **Стабильность тестов с `expect.stringMatching`**. Лучше `expect.stringContaining`.
4. **`vi.mock` с partial pass-through сложен в поддержке**. `vi.importActual` внутри `vi.mock` может работать непредсказуемо. `mockImplementation(...)` каждого теста должен помнить о fallback. Хрупко.
5. **Отсутствие защиты от "будущих" lock-файлов** (clock skew). `startedSec < bootSec` будет `false` → flow к `isProcessAlive`.
6. **Проверка `Number.isFinite(startedSec)` избыточна** (NaN < x = false, и так корректно). Не вредит.

### Suggestions

S1. **Добавить `execPath` в lock-файл** (process.execPath).
S2. **Сделать `isProrabProcess` устойчивым к коротким cmdline**.
S3. **Добавить retry-логику для TOCTOU** (50ms задержка).
S4. **Уточнить тест Task 7**: добавить комментарий "self-test, не полная имитация".
S5. **Рассмотреть PID namespace issue** в Docker/Podman.

### Questions

Q1. Почему отклонён `proper-lockfile`? (Spec не объясняет.)
Q2. Как будет работать с `ts-node`/`tsx`? `argv1` будет `src/index.ts`.
Q3. Почему `Tgid` проверка важнее `cmdline`?
Q4. **Что произойдёт при `os.uptime() === 0`?** При `uptime = 0`, `bootSec = now`. `startedSec` для `2020-01-01` < `now` → `predates boot`. Но Task 4 теста ожидает `process is gone`. **Это ошибка в плане.**
Q5. Как `releaseLock` обрабатывает новый формат?

---

## ccs-executor (albb-minimax)

### Critical Issues

1. **Mocking strategy — избыточная сложность с глобальным `vi.mock`**. spec говорит "vi.spyOn strategy (no whole-module vi.mock)", но план использует `vi.mock`. Несоответствие.
2. **`releaseLock` не обновлён для `argv1`**. Не критично, но возникнут вопросы в code review.

### Concerns

3. **TOCTOU между `isProcessAlive` и `isProrabProcess`** — архитектура устойчива (catch → null → throw).
4. **Zombie processes — проверка неполная**. Тест для зомби не добавлен.
5. **`process.argv[1]` в тестах может быть undefined**. Рекомендация: `it.skipIf(!process.argv[1])`.

### Suggestions

6. **Добавить тест для неполного `/proc/stat` (без btime)**.
7. **Явно задокументировать Linux-only** в тестах. Использовать `itIfLinux`.
8. **Валидация argv1 при записи** — risk признан, но добавить комментарий.

### Questions

Q1. Почему не использовать `proper-lockfile`?
Q2. Почему `process.kill(pid, 0)` оставлен как есть? (perf-вопрос)
Q3. Нужно ли обновлять `releaseLock` для нового формата?

---

## ccs-executor (deepseek)

### Critical Issues

1. **`vi.mock` pass-through и `beforeEach` сброс — двойная инициализация без необходимости**. `mockReset()` сбрасывает реализацию в `undefined`, а затем `mockImplementation` восстанавливает pass-through — избыточно. Достаточно `mockClear()`.
2. **TOCTOU между чтением lock-файла и записью нового — гонка не закрыта**. План добавляет ТРИ новых файловых чтения, расширяя окно гонки на десятки-сотни микросекунд.
3. **Test 7 зависит от недокументированного инварианта vitest**. При симлинках `process.argv[1]` и `/proc/self/cmdline` могут расходиться. `it.skipIf(non-linux)` не решает проблему.

### Concerns

4. **Неполное покрытие тестами: отсутствует случай `argv1: ""`** (пустая строка).
5. **`isProrabProcess` не проверяет `Tgid` для "custom kernel без Tgid"**. Сейчас отсутствие Tgid → false → перезапись. Должно быть → null → conservative throw.
6. **`os.uptime()` fallback не работает при отрицательном/субсекундном результате**. На только что загрузившейся системе btime gate не сработает в первые ~секунду.
7. **Стабильность warn-сообщений под `stringMatching`**. Warn-сообщения должны быть экспортированы как константы.

### Suggestions

8. Добавить тест на «Tgid отсутствует → conservative throw» (изменить семантику на `null`).
9. Использовать `it.skipIf(process.platform !== "linux")` для Test 7 немедленно.
10. Добавить тест на невалидную дату `startedAt`.
11. `getBootTime()` fallback: использовать `Math.round` вместо `Math.floor`.
12. **План не требует запуска полного `npm test` после каждого таска**. Рекомендуется добавить `npx vitest run src/__tests__/lock.test.ts` после каждого изменения.

### Questions

13. Почему `releaseLock` не обновлён для работы с `argv1`?
14. Рассматривался ли вариант хранения `bootId` (из `/proc/sys/kernel/random/boot_id`) вместо `btime`?
