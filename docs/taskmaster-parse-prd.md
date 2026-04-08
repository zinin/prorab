# TaskMaster parse-prd: полный разбор pipeline

Анализ реализации команды `parse-prd` в TaskMaster как эталон для реализации аналогичной функциональности.

Исходный код: `/opt/github/eyaltoledano/claude-task-master/`

---

## Оглавление

1. [Общая схема](#общая-схема)
2. [Точки входа](#точки-входа)
3. [Формирование промпта](#формирование-промпта)
4. [Шаблон промпта (parse-prd.json)](#шаблон-промпта)
5. [Рендеренный промпт — точный текст](#рендеренный-промпт--точный-текст)
6. [Prompt Manager — шаблонизатор](#prompt-manager--шаблонизатор)
7. [Unified Service Runner — отправка в AI](#unified-service-runner--отправка-в-ai)
8. [Claude Code провайдер](#claude-code-провайдер)
9. [Zod-схема ответа](#zod-схема-ответа)
10. [Постобработка результата](#постобработка-результата)
11. [Ключевые решения и выводы](#ключевые-решения-и-выводы)

---

## Общая схема

```
PRD файл (.md/.txt)
    |
    v
readPrdContent() — читает файл целиком в строку
    |
    v
buildPrompts() — PromptManager рендерит шаблон parse-prd.json
                  подставляет переменные (numTasks, nextId, prdContent, ...)
    |
    v
_unifiedServiceRunner('generateObject', ...)
    |-- дописывает " Always respond in {language}." к system prompt
    |-- формирует messages: [{role:'system', ...}, {role:'user', ...}]
    |-- резолвит провайдер и модель по role (main/research/fallback)
    |-- вызывает provider.generateObject(callParams)
    |
    v
BaseAIProvider.generateObject()
    |-- Vercel AI SDK generateObject({model, messages, schema, mode:'json'})
    |-- schema = prdResponseSchema (Zod)
    |
    v
AI возвращает structured JSON {tasks: [...], metadata: ...}
    |
    v
processTasks() — перенумерация ID, ремап зависимостей, дефолтные значения
    |
    v
saveTasksToFile() — записывает в tasks.json с поддержкой тегов
```

**Весь текст PRD отправляется одним запросом. Никакого чанкинга, RAG или embeddings нет.**

---

## Точки входа

### CLI
Команда `task-master parse-prd <path>` → CLI-обработчик → вызывает core `parsePRD()`.

### MCP (от Claude Code / другого агента)
`mcp-server/src/core/direct-functions/parse-prd.js` → `parsePRDDirect()`:
- Резолвит пути (PRD файл, tasks.json)
- Определяет `numTasks` (из аргумента или конфига, дефолт = **10**)
- Включает silent mode (подавляет console.log)
- Вызывает core `parsePRD()`

**Файл:** `/opt/github/eyaltoledano/claude-task-master/mcp-server/src/core/direct-functions/parse-prd.js`

### Core функция
`scripts/modules/task-manager/parse-prd/parse-prd.js` → `parsePRD()`:

```
parsePRD(prdPath, tasksPath, numTasks, options)
    |
    +-- PrdParseConfig — собирает конфигурацию
    |
    +-- useStreaming? (ОТКЛЮЧЕН, ENABLE_STREAMING = false)
    |     |-- да → parsePRDWithStreaming → streamObjectService
    |     |-- нет → parsePRDWithoutStreaming → generateObjectService
    |
    +-- parsePRDCore(config, serviceHandler, isStreaming)
         |-- loadExistingTasks()
         |-- validateFileOperations()
         |-- readPrdContent()
         |-- buildPrompts()
         |-- serviceHandler() — вызывает AI
         |-- processTasks() — постобработка
         |-- saveTasksToFile()
```

**Файл:** `/opt/github/eyaltoledano/claude-task-master/scripts/modules/task-manager/parse-prd/parse-prd.js`

---

## Формирование промпта

**Файл:** `/opt/github/eyaltoledano/claude-task-master/scripts/modules/task-manager/parse-prd/parse-prd-helpers.js:272-287`

```js
export async function buildPrompts(config, prdContent, nextId) {
    const promptManager = getPromptManager();
    const defaultTaskPriority = getDefaultPriority(config.projectRoot) || 'medium';

    return promptManager.loadPrompt('parse-prd', {
        research: config.research,
        numTasks: config.numTasks,
        nextId,
        prdContent,
        prdPath: config.prdPath,
        defaultTaskPriority,
        hasCodebaseAnalysis: config.hasCodebaseAnalysis(),
        projectRoot: config.projectRoot || ''
    });
}
```

Переменные для шаблона:
| Переменная | Тип | Описание |
|---|---|---|
| `research` | boolean | Включить расширенный режим с исследованием технологий |
| `numTasks` | number | Сколько задач генерировать (дефолт 10) |
| `nextId` | number | С какого ID начинать нумерацию (1 или max+1 при append) |
| `prdContent` | string | **Полный текст PRD файла** |
| `prdPath` | string | Путь к PRD файлу (для информации) |
| `defaultTaskPriority` | string | Приоритет по умолчанию (`medium`) |
| `hasCodebaseAnalysis` | boolean | Есть ли доступ к codebase analysis (true для Claude Code) |
| `projectRoot` | string | Путь к корню проекта |

---

## Шаблон промпта

**Файл:** `/opt/github/eyaltoledano/claude-task-master/src/prompts/parse-prd.json`

Это JSON с Handlebars-подобным синтаксисом (`{{#if}}`, `{{variable}}`, `{{#if (gt numTasks 0)}}`).

Содержит два промпта:
- `prompts.default.system` — системный промпт
- `prompts.default.user` — пользовательский промпт

Шаблонизатор поддерживает: `{{#if}}...{{else}}...{{/if}}`, `{{#each}}`, `(gt ...)`, `(eq ...)`, `(not ...)`, `{{{json var}}}`.

**Файл шаблонизатора:** `/opt/github/eyaltoledano/claude-task-master/scripts/modules/prompt-manager.js`

---

## Рендеренный промпт — точный текст

При стандартных настройках: `numTasks=10`, `nextId=1`, `research=false`, `defaultTaskPriority='medium'`, `hasCodebaseAnalysis=true` (Claude Code), `responseLanguage='English'`.

### System prompt

```
You are an AI assistant specialized in analyzing Product Requirements Documents (PRDs)
and generating a structured, logically ordered, dependency-aware and sequenced list of
development tasks in JSON format.

Analyze the provided PRD content and generate approximately 10 top-level development tasks.
If the complexity or the level of detail of the PRD is high, generate more tasks relative
to the complexity of the PRD
Each task should represent a logical unit of work needed to implement the requirements and
focus on the most direct and effective way to implement the requirements without unnecessary
complexity or overengineering. Include pseudo-code, implementation details, and test strategy
for each task. Find the most up to date information to implement each task.
Assign sequential IDs starting from 1. Infer title, description, details, and test strategy
for each task based *only* on the PRD content.
Set status to 'pending', dependencies to an empty array [], and priority to 'medium'
initially for all tasks.
Generate a response containing a single key "tasks", where the value is an array of task
objects adhering to the provided schema.

Each task should follow this JSON structure:
{
    "id": number,
    "title": string,
    "description": string,
    "status": "pending",
    "dependencies": number[] (IDs of tasks this depends on),
    "priority": "high" | "medium" | "low",
    "details": string (implementation details),
    "testStrategy": string (validation approach)
}

Guidelines:
1. Unless complexity warrants otherwise, create exactly 10 tasks, numbered sequentially starting from 1
2. Each task should be atomic and focused on a single responsibility following the most up to date best practices and standards
3. Order tasks logically - consider dependencies and implementation sequence
4. Early tasks should focus on setup, core functionality first, then advanced features
5. Include clear validation/testing approach for each task
6. Set appropriate dependency IDs (a task can only depend on tasks with lower IDs, potentially including existing tasks with IDs less than 1 if applicable)
7. Assign priority (high/medium/low) based on criticality and dependency order
8. Include detailed implementation guidance in the "details" field
9. If the PRD contains specific requirements for libraries, database schemas, frameworks, tech stacks, or any other implementation details, STRICTLY ADHERE to these requirements in your task breakdown and do not discard them under any circumstance
10. Focus on filling in any gaps left by the PRD or areas that aren't fully specified, while preserving all explicit requirements
11. Always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches

 Always respond in English.
```

> **Примечание:** строка `Always respond in {language}.` добавляется не шаблонизатором, а в `_unifiedServiceRunner` (`ai-services-unified.js:640`).

### System prompt (с research=true) — дополнительный блок

Если `research=true`, после первого абзаца вставляется:

```
Before breaking down the PRD into tasks, you will:
1. Research and analyze the latest technologies, libraries, frameworks, and best practices that would be appropriate for this project
2. Identify any potential technical challenges, security concerns, or scalability issues not explicitly mentioned in the PRD without discarding any explicit requirements or going overboard with complexity -- always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches
3. Consider current industry standards and evolving trends relevant to this project (this step aims to solve LLM hallucinations and out of date information due to training data cutoff dates)
4. Evaluate alternative implementation approaches and recommend the most efficient path
5. Include specific library versions, helpful APIs, and concrete implementation guidance based on your research
6. Always aim to provide the most direct path to implementation, avoiding over-engineering or roundabout approaches

Your task breakdown should incorporate this research, resulting in more detailed implementation guidance, more accurate dependency mapping, and more precise technology recommendations than would be possible from the PRD text alone, while maintaining all explicit requirements and best practices and all details and nuances of the PRD.
```

И добавляется guideline 12:
```
12. For each task, include specific, actionable guidance based on current industry standards and best practices discovered through research
```

А в details guideline (8) добавляется: `, with specific libraries and version recommendations based on your research`.

### User prompt (hasCodebaseAnalysis=true)

```
## IMPORTANT: Codebase Analysis Required

You have access to powerful codebase analysis tools. Before generating tasks:

1. Use the Glob tool to explore the project structure (e.g., "**/*.js", "**/*.json", "**/README.md")
2. Use the Grep tool to search for existing implementations, patterns, and technologies
3. Use the Read tool to examine key files like package.json, README.md, and main entry points
4. Analyze the current state of implementation to understand what already exists

Based on your analysis:
- Identify what components/features are already implemented
- Understand the technology stack, frameworks, and patterns in use
- Generate tasks that build upon the existing codebase rather than duplicating work
- Ensure tasks align with the project's current architecture and conventions

Project Root: /path/to/your/project

Here's the Product Requirements Document (PRD) to break down into approximately 10 tasks, starting IDs from 1:

<ПОЛНЫЙ ТЕКСТ PRD ФАЙЛА ВСТАВЛЯЕТСЯ СЮДА>

IMPORTANT: Your response must be a JSON object with a "tasks" property containing an array of task objects. You may optionally include a "metadata" object. Do not include any other properties.
```

### User prompt (hasCodebaseAnalysis=false)

Без блока codebase analysis. Просто:

```
Here's the Product Requirements Document (PRD) to break down into approximately 10 tasks, starting IDs from 1:

<ПОЛНЫЙ ТЕКСТ PRD ФАЙЛА>

IMPORTANT: Your response must be a JSON object with a "tasks" property containing an array of task objects. You may optionally include a "metadata" object. Do not include any other properties.
```

### User prompt (research=true) — дополнение

Перед текстом PRD добавляется:

```
Remember to thoroughly research current best practices and technologies before task breakdown to provide specific, actionable implementation details.
```

---

## Prompt Manager — шаблонизатор

**Файл:** `/opt/github/eyaltoledano/claude-task-master/scripts/modules/prompt-manager.js`

Собственный Handlebars-подобный шаблонизатор (не настоящий Handlebars). Поддерживает:

| Синтаксис | Пример | Описание |
|---|---|---|
| `{{variable}}` | `{{numTasks}}` | Подстановка переменной |
| `{{#if cond}}...{{/if}}` | `{{#if research}}...{{/if}}` | Условный блок |
| `{{#if cond}}...{{else}}...{{/if}}` | | Условный блок с else |
| `(gt var num)` | `(gt numTasks 0)` | Greater than |
| `(eq var "str")` | `(eq status "pending")` | Equals |
| `(not var)` | `(not research)` | Negation |
| `{{#each array}}...{{/each}}` | | Цикл по массиву |
| `{{{json var}}}` | | JSON.stringify переменной |
| `nested.path` | `{{task.title}}` | Доступ к вложенным свойствам |

Промпты кэшируются по ключу `promptId-variables-variant`.

Все шаблоны лежат в `src/prompts/*.json` и импортируются статически.

---

## Unified Service Runner — отправка в AI

**Файл:** `/opt/github/eyaltoledano/claude-task-master/scripts/modules/ai-services-unified.js`

### Цепочка вызовов

```
generateObjectService(params)
    → _unifiedServiceRunner('generateObject', params)
        → _getRoleConfiguration(role) — получает provider/modelId из конфига
        → _getProvider(providerName) — находит инстанс провайдера
        → формирует messages:
            [{role: 'system', content: systemPrompt + " Always respond in {lang}."},
             {role: 'user', content: userPrompt}]
        → _attemptProviderCallWithRetries(provider, 'generateObject', callParams)
            → provider.generateObject(callParams)   // до 4 попыток (1 + 3 retries)
```

### Fallback-цепочка ролей

Если main провайдер упал, пробуются другие:

| Начальная роль | Порядок попыток |
|---|---|
| `main` | main → fallback → research |
| `research` | research → fallback → main |
| `fallback` | fallback → main → research |

### callParams — что уходит в провайдер

```js
{
    apiKey,
    modelId,                    // e.g. 'claude-opus-4-20250514'
    maxTokens,                  // из конфига роли
    temperature,                // из конфига роли
    messages,                   // [{role:'system',...}, {role:'user',...}]
    schema,                     // prdResponseSchema (Zod)
    objectName,                 // 'tasks_data'
    commandName,                // 'parse-prd'
    outputType,                 // 'cli' или 'mcp'
    projectRoot,
    baseURL,                    // если настроен
    // ...provider-specific params
}
```

---

## Claude Code провайдер

**Файл:** `/opt/github/eyaltoledano/claude-task-master/src/ai-providers/claude-code.js`

### Особенности

- **Не требует API ключ** — использует локальный Claude Code CLI с OAuth
- **`needsExplicitJsonSchema = true`** — Vercel AI SDK использует `mode: 'json'` (не tool call)
- **`supportsTemperature = false`** — temperature не передаётся
- Загружает `CLAUDE.md` из проекта (`settingSources: ['user', 'project', 'local']`)
- Использует пресет `claude_code` как системный промпт SDK

### Создание клиента

```js
createClaudeCode({
    defaultSettings: {
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        ...commandSpecificSettings
    }
})
```

### Финальный вызов Vercel AI SDK

**Файл:** `/opt/github/eyaltoledano/claude-task-master/src/ai-providers/base-provider.js:529-541`

```js
import { generateObject } from 'ai';  // Vercel AI SDK

const result = await generateObject({
    model: claudeCodeClient('claude-opus-4-20250514'),
    messages: [
        { role: 'system', content: '<system prompt>' },
        { role: 'user', content: '<user prompt с PRD>' }
    ],
    schema: prdResponseSchema,          // Zod-схема
    mode: 'json',                       // потому что needsExplicitJsonSchema = true
    schemaName: 'tasks_data',
    schemaDescription: 'Generate a valid JSON object for tasks_data',
    maxTokens: <из конфига>,
    // temperature НЕ передаётся для Claude Code
});
```

При `mode: 'json'` Vercel AI SDK автоматически добавляет JSON-схему в system prompt и инструкцию "respond with valid JSON matching this schema".

---

## Zod-схема ответа

**Файл:** `/opt/github/eyaltoledano/claude-task-master/scripts/modules/task-manager/parse-prd/parse-prd-config.js:16-43`

```js
const prdSingleTaskSchema = z.object({
    id: z.number(),
    title: z.string().min(1),
    description: z.string().min(1),
    details: z.string(),
    testStrategy: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    dependencies: z.array(z.number()),
    status: z.string()
});

const prdResponseSchema = z.object({
    tasks: z.array(prdSingleTaskSchema),
    metadata: z.union([
        z.object({
            projectName: z.string(),
            totalTasks: z.number(),
            sourceFile: z.string(),
            generatedAt: z.string()
        }),
        z.null()
    ]).default(null)
});
```

Vercel AI SDK валидирует ответ по этой схеме. Если AI вернёт невалидный JSON — SDK выбросит ошибку. В `base-provider.js:566-590` есть fallback: `jsonrepair` пытается починить сломанный JSON.

---

## Постобработка результата

**Файл:** `/opt/github/eyaltoledano/claude-task-master/scripts/modules/task-manager/parse-prd/parse-prd-helpers.js`

### processTasks() — строки 130-176

1. **Валидация ID** — проверяет что ID в ответе от AI последовательные, уникальные, начинаются с 1
2. **Перенумерация** — присваивает новые ID начиная с `nextId` (важно при `--append`)
3. **Маппинг зависимостей** — пересчитывает dependency ID по новой нумерации
4. **Дефолтные значения** — `status: 'pending'`, `priority`, пустые строки для details/testStrategy
5. **Фильтрация зависимостей** — убирает невалидные (на несуществующие задачи, циклические)

### saveTasksToFile() — строки 222-263

- Читает существующий `tasks.json`
- Обновляет только целевой тег (`master` по дефолту)
- Сохраняет метаданные (created/updated timestamps)
- Записывает JSON с отступами

### Структура tasks.json

```json
{
    "master": {
        "tasks": [ ... ],
        "metadata": {
            "created": "2025-01-01T00:00:00.000Z",
            "updated": "2025-01-01T00:00:00.000Z",
            "description": "Tasks for master context"
        }
    }
}
```

---

## Ключевые решения и выводы

### Архитектура

1. **Один вызов AI** — весь PRD отправляется целиком, все задачи генерируются за один запрос. Нет итеративной генерации по одной задаче.

2. **Structured output через Zod** — Vercel AI SDK + Zod-схема гарантируют валидный JSON без ручного парсинга. При `mode: 'json'` SDK сам добавляет JSON-схему в промпт.

3. **Шаблонизатор промптов** — собственный Handlebars-подобный движок, промпты хранятся в JSON-файлах. Позволяет условно включать/выключать блоки (research, codebase analysis).

4. **Fallback-цепочка провайдеров** — если main модель упала, автоматически пробуется fallback, потом research.

5. **Streaming отключён** — несмотря на наличие streaming-реализации, сейчас `ENABLE_STREAMING = false`. Используется `generateObject` (один ответ целиком).

### Промпт-инженерия

1. **Строгие ограничения** — промпт требует точное количество задач, точную JSON-структуру, конкретный формат ID.

2. **Приоритет PRD** — guideline 9: "STRICTLY ADHERE to requirements in PRD". Модель не должна менять технологический стек из PRD.

3. **Язык ответа** — добавляется отдельно в `_unifiedServiceRunner`, не в шаблоне. Берётся из `global.responseLanguage` в конфиге.

4. **Codebase analysis** — при Claude Code в user prompt добавляется блок с инструкциями использовать Glob/Grep/Read для анализа существующего кода. Модель с tool use может реально прочитать проект перед генерацией задач.

### Что стоит перенять

- Zod-схема для structured output — надёжнее ручного парсинга JSON
- Шаблонизация промптов — разделение шаблона и данных
- Fallback-цепочка провайдеров
- Валидация и перенумерация ID после генерации
- JSON-repair как fallback при сломанном ответе

### Что можно улучшить

- Чанкинг для больших PRD (сейчас весь текст в одном запросе)
- Итеративная генерация с ревью зависимостей
- Кэширование промежуточных результатов
- Streaming для отображения прогресса (сейчас отключён)
