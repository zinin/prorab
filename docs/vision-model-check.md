# Vision Capability Check — контекст и следующие шаги

## Промпт для новой сессии

> В prorab есть проблема: когда задачи требуют анализа изображений/скриншотов (E2E тесты с визуальной верификацией), а модель не поддерживает vision — модель всё равно выполняет задачу, используя text-only workaround (accessibility tree из browser_snapshot), и рапортует `<task-complete>`. Нужно реализовать capability check. Прочитай docs/vision-model-check.md — там описано что мы уже попробовали и почему не сработало, а также варианты решения.

---

## Проблема

Prorab запускает агентские сессии на разных моделях (Claude, OpenCode с произвольной моделью). Некоторые задачи требуют анализа изображений — например, E2E тесты, где нужно сделать скриншот и визуально проверить, что UI отображается корректно.

Если модель не поддерживает vision (например minimax-m2.5, glm-4.7), она:
- Не осознаёт ограничение в контексте задачи
- Использует `browser_snapshot` (accessibility tree — текстовое представление DOM) вместо реального визуального анализа
- Рапортует `<task-complete>DONE</task-complete>` как будто всё в порядке
- Задача помечается как выполненная, хотя визуальная верификация не проводилась

## Что мы попробовали

### Подход C: инструкция в системном промпте

Добавили секцию "Capability Self-Check" в системный промпт (`src/prompts/execute.ts` и `src/prompts/review.ts`). Модель должна была:
1. Прочитать описание задачи
2. Определить, нужен ли vision
3. Проверить, есть ли у неё vision
4. Если нужен, но нет — сигнализировать `<task-blocked>`

Попробовали два варианта:
- **v1**: секция в середине промпта, после "Process Cleanup"
- **v2**: секция в самом начале промпта, с заголовком "MANDATORY FIRST STEP", с расширенными триггерами и фразой "Do NOT use text-only workarounds for visual checks"

### Результаты (оба варианта провалились)

**minimax-m2.5** — полностью проигнорировала инструкцию. В `<think>` блоке нет никакого упоминания capability check. Модель сразу начала выполнять задачу.

**glm-4.7** — прочитала инструкцию, но нашла логическое обоснование пройти мимо:
```
browser_snapshot returns an accessibility snapshot (text representation), NOT images
The verification is checking text (e.g., "Изменённое Имя" appears in the list)
This is TEXT verification, not visual/pixel verification
Therefore, vision is NOT required
```

Два класса моделей — два способа обойти промпт:
- **Слабые модели** игнорируют инструкцию
- **Умные модели** находят loophole (browser_snapshot — это текст, а не изображение)

### Вывод

Prompt-only подход не работает для capability checking. Коммиты с промптовыми изменениями откачены (коммит `62b54b4`). Дизайн-документ остался в `docs/plans/2026-02-28-vision-capability-check-design.md`.

## Что работает: прямой вопрос модели

Эксперимент показал, что если напрямую спросить модель "умеешь ли ты vision?", она отвечает честно:

```
$ opencode run "ты умеешь vision? ответь одним словом Yes/No в теге <result>Yes</result> или <result>No</result>"
> MiniMax-M2.5
<result>No</result>
```

Модель знает свои ограничения, когда спрашивают напрямую. Но в контексте задачи она не применяет эти знания — ей "хочется" выполнить задачу.

## Варианты для следующей итерации

### Вариант 1: Keyword matching в коде prorab + probe-запрос (рекомендуемый)

**Идея**: prorab сам определяет, нужен ли vision, и делает отдельный probe-запрос к модели.

**Реализация**:
1. Функция `requiresVision(unit: ExecutionUnit): boolean` в prorab — анализирует `title`, `description`, `details`, `testStrategy` по ключевым словам (screenshot, скриншот, browser_snapshot для проверки, визуальная проверка, visual check, image analysis и т.д.)
2. Если `requiresVision()` вернул `true` — запустить мини-сессию через `AgentDriver.runSession()` с промптом: "Do you support analyzing images (vision)? Answer ONLY with `<result>Yes</result>` or `<result>No</result>`"
3. Распарсить ответ. Если `No` — поставить задаче статус `blocked` с причиной, prorab останавливается
4. Probe делать перед каждой задачей с vision (не кэшировать — пользователь может менять модель mid-run)

**Плюсы**: надёжно — keyword matching в нашем коде + честный ответ модели на прямой вопрос.
**Минусы**: overhead от запуска мини-сессии (особенно OpenCode — поднимает сервер). Keyword matching может давать false positives/negatives.

**Файлы для изменения**:
- `src/core/capabilities.ts` (новый) — функция `requiresVision()` + probe logic
- `src/core/drivers/types.ts` — опциональный метод `probe?()` в `AgentDriver` или использовать `runSession()` с maxTurns=1
- `src/commands/run.ts` — вызов probe перед execute, если задача требует vision
- `src/prompts/probe.ts` (новый) — промпт для probe-запроса

### Вариант 2: Метод `probe()` в AgentDriver

**Идея**: добавить лёгкий метод `probe(question: string): Promise<string>` в интерфейс AgentDriver, который делает один API-вызов без полноценной сессии.

Для ClaudeDriver — прямой вызов Anthropic Messages API (без Agent SDK session).
Для OpenCodeDriver — через OpenCode SDK.

**Плюсы**: быстрее и дешевле чем полная сессия.
**Минусы**: нужен прямой доступ к API. ClaudeDriver сейчас работает только через Agent SDK, прямого Messages API нет. Потребуется добавить зависимость `@anthropic-ai/sdk` или использовать fetch.

### Вариант 3: requiredCapabilities в tasks.json

**Идея**: добавить поле `requiredCapabilities: string[]` в схему задач. Prorab проверяет capabilities модели при старте.

**Плюсы**: явная разметка, нет гадания по ключевым словам.
**Минусы**: требует ручной разметки задач (или авто-разметки при генерации). Меняет формат tasks.json.

## Принятые решения

- Реестр моделей (хардкод capabilities для каждой модели) — **отвергнут**. Моделей слишком много, список невозможно поддерживать.
- CLI флаг `--capabilities vision` — **не обсуждался детально**, но может быть полезен как override.
- При несоответствии capability — **остановить весь процесс** (не пропускать задачу и продолжать).

## Ветка

Работа ведётся в `feature/vision-capability-check`. Текущее состояние: промпты откачены, дизайн-документ в git history.
