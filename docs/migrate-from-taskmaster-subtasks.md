# Миграция с task-master: разбиение задач на подзадачи

> 2026-03-08. Цель: реализовать собственный функционал анализа сложности задач и их разбиения на подзадачи, аналогичный `task-master expand` и `task-master analyze-complexity`.

## Мотивация

- `parse-prd` уже реализован и генерирует только top-level задачи (пустой `subtasks: []`)
- Для эффективной работы задачи нужно разбивать на подзадачи перед выполнением
- Task-master делает это в два шага: оценка сложности → разбиение. Нужно перенести оба

## Как это работает в task-master

### Общая архитектура: два шага

```
analyze-complexity                     expand
┌──────────────┐                 ┌───────────────┐
│ Все задачи   │  LLM-вызов     │ Одна задача   │  LLM-вызов
│ (pending/    │ ──────────►    │ + контекст    │ ──────────►
│  blocked/    │  JSON-ответ     │ + complexity  │  JSON-ответ
│  in-progress)│                 │   report      │
└──────┬───────┘                 └──────┬────────┘
       │                                │
       ▼                                ▼
  complexity-report.json           tasks.json (subtasks добавлены)
```

**Шаг 1 — `analyze-complexity`**: анализирует ВСЕ активные задачи за один LLM-вызов. Возвращает для каждой: `complexityScore` (1–10), `recommendedSubtasks` (число), `expansionPrompt` (подсказка для expand), `reasoning`.

**Шаг 2 — `expand`**: берёт ОДНУ задачу и генерирует для неё подзадачи. Может использовать данные из complexity report для определения количества подзадач и формулировки промпта.

### Шаг 1: analyze-complexity — подробности

#### Входные данные
- Массив задач из `tasks.json`, отфильтрованных по статусу (`pending`, `blocked`, `in-progress`)
- Опциональная фильтрация по конкретным ID или диапазону (`--from`, `--to`)
- Контекст связанных задач (fuzzy search по title+description всех анализируемых задач)

#### System prompt (статический)
```
You are an expert software architect and project manager analyzing task
complexity. Your analysis should consider implementation effort, technical
challenges, dependencies, and testing requirements.

IMPORTANT: For each task, provide an analysis object with ALL of the
following fields:
- taskId: The ID of the task being analyzed (positive integer)
- taskTitle: The title of the task
- complexityScore: A score from 1-10 indicating complexity
- recommendedSubtasks: Number of subtasks recommended (non-negative integer;
  0 if no expansion needed)
- expansionPrompt: A prompt to guide subtask generation
- reasoning: Your reasoning for the complexity score

Your response MUST be a JSON object with a single "complexityAnalysis"
property containing an array of these analysis objects.
```

#### User prompt (шаблон)
```
Analyze the following tasks to determine their complexity (1-10 scale)
and recommend the number of subtasks for expansion. Provide a brief
reasoning and an initial expansion prompt for each.

Tasks:
<JSON-массив всех задач целиком, pretty-printed>

# Project Context
<контекст связанных задач из fuzzy search, если есть>
```

При `--research` добавляется фраза: `Consider current best practices, common implementation patterns, and industry standards in your analysis.`

#### Схема ответа (Zod)
```typescript
z.object({
  complexityAnalysis: z.array(z.object({
    taskId: z.number().int().positive(),
    taskTitle: z.string(),
    complexityScore: z.number().min(1).max(10),
    recommendedSubtasks: z.number().int().nonnegative(),
    expansionPrompt: z.string(),
    reasoning: z.string(),
  }))
})
```

#### Постобработка
- Если LLM пропустил задачу → дефолтные значения: `complexityScore: 5`, `recommendedSubtasks: 3`
- Результат мержится с существующим отчётом (если файл уже есть)
- Сохраняется в `.taskmaster/reports/task-complexity-report.json`

#### Пример ответа LLM
```json
{
  "complexityAnalysis": [
    {
      "taskId": 3,
      "taskTitle": "Implement JWT authentication",
      "complexityScore": 7,
      "recommendedSubtasks": 5,
      "expansionPrompt": "Break down JWT auth: token generation, validation middleware, refresh flow, storage strategy, error handling",
      "reasoning": "Requires crypto, middleware integration, token lifecycle management, and security considerations"
    }
  ]
}
```

---

### Шаг 2: expand — подробности

#### Входные данные
- Одна конкретная задача из `tasks.json` (по ID)
- Данные из complexity report (опционально): `recommendedSubtasks`, `expansionPrompt`, `reasoning`
- Контекст связанных задач (fuzzy search по title+description задачи, top-5)
- Дополнительный контекст от пользователя (`--prompt`)

#### Определение количества подзадач (приоритет)
1. Явный параметр `--num` от пользователя
2. `recommendedSubtasks` из complexity report
3. Дефолт из конфига (обычно 5)
4. Хардкод-fallback: 3

#### Выбор варианта промпта
Task-master использует три варианта, выбираемых по условию:
- **complexity-report** — если есть `expansionPrompt` из отчёта сложности
- **research** — если `--research` и нет `expansionPrompt`
- **default** — иначе

Все три варианта имеют одинаковый system prompt, различается user prompt.

#### System prompt (одинаковый для всех вариантов)
```
You are an AI assistant helping with task breakdown. Generate exactly
{{subtaskCount}} subtasks based on the provided prompt and context.

IMPORTANT: Your response MUST be a JSON object with a "subtasks" property
containing an array of subtask objects. Each subtask must include ALL of
the following fields:
- id: MUST be sequential integers starting EXACTLY from {{nextSubtaskId}}.
  First subtask id={{nextSubtaskId}}, second id={{nextSubtaskId}}+1, etc.
- title: A clear, actionable title (5-200 characters)
- description: A detailed description (minimum 10 characters)
- dependencies: An array of task IDs this subtask depends on (can be empty [])
- details: Implementation details (minimum 20 characters)
- status: Must be "pending" for new subtasks
- testStrategy: Testing approach (can be null)
```

#### User prompt (вариант complexity-report — основной)
```
Break down the following task:

Parent Task:
ID: {{task.id}}
Title: {{task.title}}
Description: {{task.description}}
Current details: {{task.details || "None"}}

{{expansionPrompt}}           ← из complexity report

{{additionalContext}}          ← от пользователя (--prompt)

{{complexityReasoningContext}} ← reasoning из complexity report

# Project Context
{{gatheredContext}}             ← fuzzy search по связанным задачам

Generate exactly {{subtaskCount}} subtasks.
CRITICAL: Use sequential IDs starting from {{nextSubtaskId}}.
```

#### Схема ответа (Zod)
```typescript
z.object({
  subtasks: z.array(z.object({
    id: z.number().int().positive(),
    title: z.string().min(5).max(200),
    description: z.string().min(10),
    dependencies: z.array(z.number().int()),
    details: z.string().min(20),
    status: z.enum(['pending', 'done', 'completed']),
    testStrategy: z.string().nullable(),
  }))
})
```

#### Постобработка
- Каждой подзадаче ставится `status: 'pending'`, `dependencies: []`, `testStrategy: null` если пусто
- Подзадачи **дописываются** к существующим (append), не заменяют
- При `--force` существующие подзадачи очищаются перед генерацией
- Обновлённая задача записывается в `tasks.json`

#### Пример ответа LLM
```json
{
  "subtasks": [
    {
      "id": 1,
      "title": "Set up JWT token generation utility",
      "description": "Create a utility module for generating and signing JWT tokens",
      "dependencies": [],
      "details": "Use jsonwebtoken library. Support access tokens (15min) and refresh tokens (7d). Configure secret from env vars. Include token payload structure with userId, role, permissions.",
      "status": "pending",
      "testStrategy": "Unit tests for token generation with various payloads and expiration times"
    }
  ]
}
```

---

### Сбор контекста (общий для обоих шагов)

Task-master использует два механизма для обогащения промпта:

#### FuzzyTaskSearch
- Поиск по всем задачам с помощью Fuse.js (fuzzy matching)
- Поля для поиска: `title` (вес 1.5), `description` (вес 2), `details` (вес 3)
- Запрос: title + description анализируемой задачи (или всех задач для analyze-complexity)
- Возвращает top-5 (expand) или top-10 (analyze-complexity) связанных задач

#### ContextGatherer
- Получает список ID связанных задач от FuzzyTaskSearch
- Форматирует их как текстовый блок: title, description, status, priority, dependencies, details, testStrategy
- Возвращает строку для подстановки в `{{gatheredContext}}`

---

## Что уже есть в prorab

### Схемы данных (tasks-json-types.ts)
Поля для complexity уже определены в `FullTaskSchema`:
```typescript
complexity?: number | string
recommendedSubtasks?: number
expansionPrompt?: string
complexityReasoning?: string
```

### Функции работы с задачами (tasks-json.ts)
- `readTasksFile()`, `writeTasksFile()` — чтение/запись tasks.json
- `mutateTasksFile()` — atomic read-modify-write
- `updateTask()` — обновление полей задачи
- `updateSubtask()` — обновление подзадачи
- `createTask()` — создание задачи с auto-increment ID
- `setStatusDirect()` — статус с каскадом
- `findNextAction()` — выбор следующей задачи (уже поддерживает подзадачи)

### Паттерн AI-вызовов (drivers/)
Prorab использует **агентный подход** — не прямые API-вызовы, а SDK-драйверы:
- `ClaudeDriver` (через `@anthropic-ai/claude-agent-sdk`) — вызывает `query()` с system prompt, cwd, permissionMode
- `OpenCodeDriver` (через `@opencode-ai/sdk/v2`) — вызывает через SSE streaming
- Общий интерфейс: `AgentDriver.runSession({ systemPrompt, taskPrompt, cwd })`
- Сигналы завершения: XML-теги `<task-complete>`, `<task-blocked>`, `<task-report>`

### Паттерн из parse-prd (референс)
```
parse-prd-manager.ts     → менеджер сессии (запуск/отмена/статус)
prompts/parse-prd.ts     → system prompt + task prompt
validate-parse-prd.ts    → постобработка и валидация результата
server/routes/parse-prd.ts → REST API endpoints
```

---

## Ключевое архитектурное решение: агент vs. structured output

**Task-master** вызывает LLM через `generateObject()` — structured output с Zod-схемой. LLM возвращает чистый JSON, без инструментов.

**Prorab** использует агентный подход — LLM получает инструменты (Read, Write, Glob, Grep) и **сам пишет файлы**. Это мощнее (агент может исследовать кодовую базу), но сложнее в валидации.

### Варианты реализации

#### Вариант A: Агентный (как parse-prd)
Агент получает system prompt с правилами, исследует кодовую базу инструментами, **сам записывает подзадачи в tasks.json**.

**Плюсы:**
- Консистентность с parse-prd (один паттерн)
- Агент может исследовать код перед разбиением (умнее подзадачи)
- Не нужно реализовывать structured output / JSON parsing

**Минусы:**
- Нет гарантии формата — нужна постобработка + валидация
- Агент может испортить tasks.json (перезаписать другие задачи)
- Дороже по токенам (инструменты, контекст)
- Сложнее тестировать

#### Вариант B: Structured output (как task-master)
Прямой API-вызов с Zod-схемой, LLM возвращает JSON, prorab сам записывает в tasks.json.

**Плюсы:**
- Гарантированный формат ответа (Zod-валидация)
- Дешевле по токенам
- Проще тестировать (mock LLM → проверить запись)
- Безопаснее (prorab контролирует запись)

**Минусы:**
- Новый паттерн (не агентный), нужно добавить прямой API-вызов
- LLM не может исследовать код (контекст только из промпта)

#### Вариант C: Гибрид
Агент исследует кодовую базу, собирает контекст, но **не пишет в tasks.json**. Вместо этого выдаёт структурированный ответ в XML/JSON-блоке, а prorab парсит и записывает.

**Плюсы:**
- Агент исследует код (как вариант A)
- Prorab контролирует запись (как вариант B)
- Не нужен structured output API

**Минусы:**
- Нужен XML/JSON-парсинг ответа агента
- Менее надёжно, чем Zod structured output

### Рекомендация

**Вариант A (агентный)** — консистентно с parse-prd, проще в реализации, agentDriver инфраструктура уже есть. Контроль формата — через постобработку (`validate-expand.ts`), аналогично `validate-parse-prd.ts`.

---

## Что нужно реализовать

### Фаза 1: Разбиение задачи на подзадачи (expand)

Analyze-complexity — отдельный шаг, не блокирует expand. Можно начать с expand без него.

#### 1.1. Промпт — `src/prompts/expand-task.ts`

Экспорт двух функций: `buildExpandSystemPrompt()` и `buildExpandTaskPrompt(task, options)`.

**System prompt** (адаптация под агентный подход):
- Роль: разбить задачу на подзадачи
- Правила формата: JSON-массив subtasks внутри `tasks.json`
- Правила ID: `nextSubtaskId` — следующий свободный ID (передать в промпт)
- Обязательные поля: `id`, `title`, `description`, `dependencies`, `details`, `status: "pending"`, `testStrategy`
- **Исследование кодовой базы**: инструкция использовать Glob/Grep/Read для анализа кода перед генерацией подзадач
- **Запись результата**: инструкция обновить tasks.json — записать подзадачи в `subtasks` массив нужной задачи
- **Запреты**: не менять другие задачи, не менять поля родительской задачи (кроме subtasks)
- Сигнал завершения: `<task-complete>DONE</task-complete>`
- Сигнал ошибки: `<task-blocked>reason</task-blocked>`

**Task prompt** (динамический):
```
Разбей задачу #{{task.id}} на {{subtaskCount}} подзадач.

Задача:
ID: {{task.id}}
Title: {{task.title}}
Description: {{task.description}}
Details: {{task.details || "Нет"}}
Dependencies: {{task.dependencies}}

{{#if expansionPrompt}}
Рекомендация по разбиению:
{{expansionPrompt}}
{{/if}}

{{#if additionalContext}}
Дополнительный контекст:
{{additionalContext}}
{{/if}}

Путь к tasks.json: {{tasksJsonPath}}
Подзадачи начинаются с ID: {{nextSubtaskId}}
```

#### 1.2. Валидация — `src/core/validate-expand.ts`

По аналогии с `validate-parse-prd.ts`:

```typescript
function getExpandOutcome(cwd: string, taskId: number): ExpandValidationResult
```

Проверки:
- tasks.json читается и проходит валидацию
- Задача `taskId` существует
- У задачи появились подзадачи (было 0 → стало > 0, или стало больше чем было)
- Все подзадачи имеют `status: "pending"`
- ID подзадач последовательны, начинаются с `nextSubtaskId`
- Обязательные поля заполнены (title, description, details)
- Зависимости подзадач ссылаются только на другие подзадачи той же задачи или на пустой массив
- Другие задачи не были изменены (сравнить snapshot до/после)

#### 1.3. Менеджер сессии — `src/server/expand-manager.ts`

По аналогии с `parse-prd-manager.ts`:

```typescript
class ExpandManager {
  async expand(taskId: number, options?: ExpandOptions): Promise<ExpandResult>
  getStatus(): ExpandStatus
  abort(): void
}
```

Поток:
1. Прочитать `tasks.json`, найти задачу, определить `nextSubtaskId`
2. Если у задачи уже есть подзадачи и нет `force` → ошибка
3. Снять snapshot tasks.json (для валидации "другие задачи не изменены")
4. Собрать промпт через `buildExpandSystemPrompt()` + `buildExpandTaskPrompt()`
5. Запустить драйвер: `driver.runSession({ systemPrompt, taskPrompt, cwd })`
6. Дождаться завершения (сигнал `<task-complete>`)
7. Запустить `getExpandOutcome()` — валидация
8. Если валидация не прошла → откатить tasks.json из snapshot
9. Вернуть результат

#### 1.4. REST API — дополнить `src/server/routes/tasks.ts`

```
POST /api/tasks/:id/expand
  Body: { force?: boolean, subtaskCount?: number, additionalContext?: string }
  Response: { status: "success" | "error", task: FullTask }
```

#### 1.5. Оценка объёма

| Компонент | Строк кода | Файл |
|-----------|------------|------|
| Промпт | ~60–80 | `src/prompts/expand-task.ts` |
| Валидация | ~100–130 | `src/core/validate-expand.ts` |
| Менеджер | ~120–160 | `src/server/expand-manager.ts` |
| REST route | ~30–40 | `src/server/routes/tasks.ts` (дополнение) |
| Тесты валидации | ~100–150 | `src/core/validate-expand.spec.ts` |
| **Итого** | ~410–560 | |

---

### Фаза 2: Анализ сложности (analyze-complexity)

Опциональный шаг. Может работать и без него — expand умеет работать с дефолтным количеством подзадач.

#### 2.1. Промпт — `src/prompts/analyze-complexity.ts`

**System prompt:**
- Роль: архитектор, оценивающий сложность задач
- Правило: исследовать кодовую базу перед оценкой
- Формат ответа: JSON-массив анализов в виде файла `.taskmaster/reports/task-complexity-report.json`

**Task prompt:**
```
Оцени сложность следующих задач (шкала 1–10) и рекомендуй количество
подзадач для каждой.

Задачи:
{{JSON.stringify(tasks)}}

Для каждой задачи запиши в отчёт:
- taskId, taskTitle
- complexityScore (1–10)
- recommendedSubtasks (0 если разбиение не нужно)
- expansionPrompt (подсказка для разбиения)
- reasoning (обоснование оценки)

Сохрани отчёт в: {{reportPath}}
```

#### 2.2. Валидация — `src/core/validate-analyze-complexity.ts`

Проверки:
- Файл отчёта создан и содержит валидный JSON
- Массив `complexityAnalysis` содержит записи для всех запрошенных задач
- `complexityScore` в диапазоне 1–10
- `recommendedSubtasks` ≥ 0

#### 2.3. Интеграция с expand

После analyze-complexity данные из отчёта передаются в expand:
- `recommendedSubtasks` → количество подзадач (если пользователь не указал явно)
- `expansionPrompt` → добавляется в task prompt для expand
- `reasoning` → добавляется как контекст

Для этого `expand-manager.ts` при запуске проверяет наличие файла отчёта и читает данные для конкретной задачи.

#### 2.4. Оценка объёма

| Компонент | Строк кода | Файл |
|-----------|------------|------|
| Промпт | ~40–60 | `src/prompts/analyze-complexity.ts` |
| Валидация | ~80–100 | `src/core/validate-analyze-complexity.ts` |
| Менеджер | ~100–130 | `src/server/analyze-complexity-manager.ts` |
| REST route | ~30–40 | `src/server/routes/tasks.ts` (дополнение) |
| Тесты валидации | ~80–100 | `src/core/validate-analyze-complexity.spec.ts` |
| **Итого** | ~330–430 | |

---

## Отличия от task-master

| Аспект | Task-master | Prorab |
|--------|-------------|--------|
| Паттерн вызова LLM | `generateObject()` — structured output | Агент с инструментами (Read/Write/Glob/Grep) |
| Кто пишет в tasks.json | Код task-master после получения JSON | Агент сам пишет |
| Исследование кода | Только если research mode + codebase analysis | Всегда (агент имеет инструменты) |
| Контекст | FuzzyTaskSearch + ContextGatherer | Агент сам собирает через Glob/Grep/Read |
| Валидация | Zod-схема на ответе LLM | Постобработка файла (validate-expand.ts) |
| Шаблоны промптов | JSON-файлы с Handlebars-синтаксисом | TypeScript-функции (как parse-prd.ts) |
| Сигналы завершения | Нет (синхронный API-вызов) | XML-теги: `<task-complete>`, `<task-blocked>` |
| Fuzzy search контекста | Fuse.js (встроенный) | Не нужен — агент сам находит релевантный код |

## Что НЕ нужно переносить из task-master

- **PromptManager** (Handlebars-рендеринг JSON-шаблонов) — prorab использует TypeScript-функции для промптов
- **FuzzyTaskSearch / ContextGatherer** — агент исследует кодовую базу сам
- **generateObjectService** (прямой API-вызов) — prorab использует AgentDriver
- **Тройной fallback ролей** (main → fallback → research) — prorab управляет моделью через драйвер
- **Теги (multi-tag)** — если не используется, пропустить

## Чек-лист

### Фаза 1 (expand)
- [ ] `src/prompts/expand-task.ts` — system + task prompt
- [ ] `src/core/validate-expand.ts` — валидация результата
- [ ] `src/server/expand-manager.ts` — менеджер сессии
- [ ] `src/server/routes/tasks.ts` — POST endpoint
- [ ] Тесты для валидации
- [ ] Проверка: expand задачи без подзадач → подзадачи появились
- [ ] Проверка: expand с `force` → старые подзадачи заменены
- [ ] Проверка: другие задачи не затронуты

### Фаза 2 (analyze-complexity)
- [ ] `src/prompts/analyze-complexity.ts` — system + task prompt
- [ ] `src/core/validate-analyze-complexity.ts` — валидация отчёта
- [ ] `src/server/analyze-complexity-manager.ts` — менеджер сессии
- [ ] `src/server/routes/tasks.ts` — POST endpoint
- [ ] Интеграция: expand читает complexity report
- [ ] Тесты для валидации
- [ ] Проверка: отчёт содержит все запрошенные задачи
- [ ] Проверка: expand использует данные из отчёта
