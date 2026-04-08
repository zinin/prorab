# Task Master: Структура файла tasks.json

Файл `.taskmaster/tasks/tasks.json` — основная база данных задач проекта. Управляется автоматически через CLI-команды и MCP-инструменты Task Master. Ручное редактирование не рекомендуется.

## Формат файла

### Стандартный формат

```json
{
  "tasks": [
    { /* Task */ },
    { /* Task */ }
  ],
  "metadata": {
    "version": "1.0.0",
    "lastModified": "2026-02-23T10:00:00.000Z",
    "taskCount": 12,
    "completedCount": 4
  }
}
```

### Формат с тегами (multi-tag)

Теги позволяют вести несколько независимых списков задач в одном файле — например, для разных веток или направлений работы.

```json
{
  "master": {
    "tasks": [ /* задачи основной ветки */ ],
    "metadata": { /* ... */ }
  },
  "feature-auth": {
    "tasks": [ /* задачи ветки feature-auth */ ],
    "metadata": { /* ... */ }
  }
}
```

Переключение между тегами: `task-master use-tag <name>`.

---

## Task — объект задачи

Каждая задача описывает единицу работы с полным контекстом для реализации.

### Обязательные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | `string \| number` | Уникальный идентификатор. Числовой (`1`, `2`) для файлового хранилища или с префиксом (`HAM-1`) для API-хранилища |
| `title` | `string` | Краткий заголовок задачи |
| `description` | `string` | Развёрнутое описание: что нужно сделать и зачем |
| `status` | `TaskStatus` | Текущий статус (см. ниже) |
| `priority` | `TaskPriority` | Приоритет (см. ниже) |
| `dependencies` | `string[]` | Массив ID задач, которые должны быть завершены перед этой. Пустой массив `[]`, если зависимостей нет |
| `details` | `string` | Детали реализации: конкретные шаги, используемые технологии, ссылки на документацию |
| `testStrategy` | `string` | Стратегия тестирования: какие тесты писать, что проверять |
| `subtasks` | `Subtask[]` | Массив подзадач. Пустой массив `[]`, если подзадач нет |

### Необязательные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `createdAt` | `string` | Дата создания в формате ISO 8601 (`2026-02-23T10:00:00.000Z`) |
| `updatedAt` | `string` | Дата последнего обновления в формате ISO 8601 |
| `effort` | `number` | Оценка трудоёмкости (story points) |
| `actualEffort` | `number` | Фактически затраченные усилия |
| `tags` | `string[]` | Пользовательские теги для классификации (`["backend", "auth"]`) |
| `assignee` | `string` | Ответственный исполнитель |
| `databaseId` | `string` | UUID записи в Supabase (для API-хранилища) |
| `metadata` | `Record<string, unknown>` | Произвольные пользовательские метаданные. Сохраняются при всех операциях |

### Поля анализа сложности

Заполняются автоматически командой `task-master analyze-complexity`.

| Поле | Тип | Описание |
|------|-----|----------|
| `complexity` | `TaskComplexity \| number` | Сложность: строка (`"simple"`, `"moderate"`, `"complex"`, `"very-complex"`) или число от 1 до 10 |
| `recommendedSubtasks` | `number` | Рекомендуемое количество подзадач по результатам анализа |
| `expansionPrompt` | `string` | Подсказка для AI при расширении задачи в подзадачи |
| `complexityReasoning` | `string` | Обоснование присвоенной сложности |

### Поля контекста реализации (AI-generated)

Генерируются AI при создании/обновлении задач. Помогают разработчику быстро погрузиться в контекст.

| Поле | Тип | Описание |
|------|-----|----------|
| `relevantFiles` | `RelevantFile[]` | Файлы, относящиеся к задаче |
| `codebasePatterns` | `string[]` | Паттерны кода, которым следует следовать |
| `existingInfrastructure` | `ExistingInfrastructure[]` | Существующие сервисы/модули для переиспользования |
| `scopeBoundaries` | `ScopeBoundaries` | Границы задачи: что входит и что не входит |
| `implementationApproach` | `string` | Пошаговый план реализации |
| `technicalConstraints` | `string[]` | Технические ограничения |
| `acceptanceCriteria` | `string[]` | Критерии приёмки |
| `skills` | `string[]` | Необходимые навыки |
| `category` | `TaskCategory` | Категория работы |

---

## Subtask — объект подзадачи

Подзадача — это часть задачи, представляющая конкретный шаг реализации. **Вложенность подзадач не поддерживается** — у подзадачи не может быть своих подзадач.

### Отличия от Task

| Поле | Тип | Описание |
|------|-----|----------|
| `id` | `number` (файл) / `string` (API) | Числовой ID внутри родительской задачи (1, 2, 3...) |
| `parentId` | `string` | ID родительской задачи (`"1"`, `"HAM-1"`) |
| `subtasks` | — | Отсутствует. Подзадачи не могут иметь вложенных подзадач |

Все остальные поля (title, description, status, priority, dependencies, details, testStrategy и т.д.) идентичны полям Task.

### Адресация подзадач

Подзадачи адресуются через точку: `<parentId>.<subtaskId>`.

- `1.1` — первая подзадача задачи 1
- `1.2` — вторая подзадача задачи 1
- `HAM-1.3` — третья подзадача задачи HAM-1 (API-хранилище)

Более глубокая вложенность (`1.2.3`) **не поддерживается**.

---

## Перечисления

### TaskStatus — статус задачи

| Значение | Описание |
|----------|----------|
| `pending` | Готова к работе. Начальный статус |
| `in-progress` | В процессе выполнения |
| `done` | Завершена и проверена |
| `review` | На ревью |
| `blocked` | Заблокирована внешними факторами |
| `deferred` | Отложена на потом |
| `cancelled` | Отменена, больше не нужна |

**Бизнес-правила:**
- Задача может быть отмечена как `done` только если все её подзадачи в статусе `done` или `cancelled`
- Завершённую задачу нельзя вернуть в `pending`

### TaskPriority — приоритет

| Значение | Описание |
|----------|----------|
| `low` | Низкий приоритет |
| `medium` | Средний приоритет |
| `high` | Высокий приоритет |
| `critical` | Критический приоритет |

### TaskComplexity — сложность

| Значение | Описание |
|----------|----------|
| `simple` | Простая задача |
| `moderate` | Умеренная сложность |
| `complex` | Сложная задача |
| `very-complex` | Очень сложная задача |

Также может быть числом от 1 до 10.

### TaskCategory — категория

| Значение | Описание |
|----------|----------|
| `research` | Исследование |
| `design` | Проектирование |
| `development` | Разработка |
| `testing` | Тестирование |
| `documentation` | Документация |
| `review` | Ревью |

---

## Вложенные типы

### RelevantFile

Файл проекта, связанный с задачей.

```json
{
  "path": "src/auth/jwt.service.ts",
  "description": "Сервис генерации и валидации JWT-токенов",
  "action": "modify"
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `path` | `string` | Путь относительно корня проекта |
| `description` | `string` | Что содержит файл и зачем он нужен |
| `action` | `"create" \| "modify" \| "reference"` | `create` — создать новый, `modify` — изменить существующий, `reference` — использовать как справку |

### ExistingInfrastructure

Существующий модуль или сервис для переиспользования.

```json
{
  "name": "AuthService",
  "location": "src/services/auth.service.ts",
  "usage": "Использовать метод validateToken() для проверки JWT"
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `name` | `string` | Название сервиса/модуля |
| `location` | `string` | Путь в проекте |
| `usage` | `string` | Как использовать или интегрировать |

### ScopeBoundaries

Границы задачи — что входит и что не входит в объём работы.

```json
{
  "included": "JWT-аутентификация, хеширование паролей, middleware защиты маршрутов",
  "excluded": "OAuth провайдеры, двухфакторная аутентификация, управление ролями"
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `included` | `string` | Что входит в объём задачи |
| `excluded` | `string` | Что явно не входит в объём |

---

## Metadata — метаданные проекта

Хранятся рядом с массивом задач. Обновляются автоматически.

```json
{
  "version": "1.0.0",
  "lastModified": "2026-02-23T10:00:00.000Z",
  "taskCount": 12,
  "completedCount": 4,
  "projectName": "my-project",
  "description": "Backend API for mobile app"
}
```

| Поле | Тип | Обязательное | Описание |
|------|-----|:---:|----------|
| `version` | `string` | да | Версия формата файла |
| `lastModified` | `string` | да | Дата последнего изменения (ISO 8601) |
| `taskCount` | `number` | да | Общее количество задач |
| `completedCount` | `number` | да | Количество завершённых задач |
| `projectName` | `string` | нет | Название проекта |
| `description` | `string` | нет | Описание проекта |
| `tags` | `string[]` | нет | Список тегов |
| `created` | `string` | нет | Дата создания файла |
| `updated` | `string` | нет | Дата обновления файла |

---

## Формат ID задач

### Файловое хранилище (локальные файлы)

- Задачи: числовые строки — `"1"`, `"2"`, `"123"`
- Подзадачи: через точку — `"1.1"`, `"2.3"`
- Подзадачи подзадач **не поддерживаются** (`"1.2.3"` — невалидный ID)

### API-хранилище (Supabase)

- Задачи: с префиксом — `"HAM-1"`, `"HAM-123"`
- Подзадачи в API-хранилище не поддерживаются
- Нормализация: `"ham1"` → `"HAM-1"`, `"HAM1"` → `"HAM-1"`

---

## Зависимости

Поле `dependencies` содержит массив ID задач, которые должны быть завершены перед текущей.

```json
{
  "id": "3",
  "title": "Реализовать API эндпоинты",
  "dependencies": ["1", "2"],
  "..."
}
```

Задача `3` не может быть начата, пока задачи `1` и `2` не завершены.

**Правила:**
- Циклические зависимости запрещены
- Ссылки на несуществующие задачи считаются ошибкой
- Валидация: `task-master validate-dependencies`
- Автоисправление: `task-master fix-dependencies`

---

## Полный пример

```json
{
  "tasks": [
    {
      "id": 1,
      "title": "Настроить проект и базовую структуру",
      "description": "Инициализировать проект: package.json, TypeScript, ESLint, структура директорий",
      "status": "done",
      "priority": "high",
      "dependencies": [],
      "details": "1. npm init\n2. Установить TypeScript, ESLint, Prettier\n3. Создать tsconfig.json\n4. Настроить структуру src/",
      "testStrategy": "Проверить, что проект компилируется без ошибок, линтер проходит",
      "subtasks": [],
      "createdAt": "2026-02-20T08:00:00.000Z",
      "updatedAt": "2026-02-20T12:30:00.000Z"
    },
    {
      "id": 2,
      "title": "Реализовать систему аутентификации",
      "description": "JWT-аутентификация с регистрацией и входом пользователей",
      "status": "in-progress",
      "priority": "high",
      "dependencies": ["1"],
      "details": "Использовать bcrypt для хеширования паролей, jsonwebtoken для токенов. Access token — 15 минут, refresh token — 7 дней.",
      "testStrategy": "Unit-тесты для функций хеширования и валидации токенов. Integration-тесты для /register и /login эндпоинтов.",
      "subtasks": [
        {
          "id": 1,
          "parentId": "2",
          "title": "Создать модель User",
          "description": "Определить схему пользователя: email, passwordHash, createdAt",
          "status": "done",
          "priority": "high",
          "dependencies": [],
          "details": "Использовать Prisma ORM. Поля: id (UUID), email (unique), passwordHash, createdAt, updatedAt.",
          "testStrategy": "Проверить создание и чтение пользователя через Prisma client"
        },
        {
          "id": 2,
          "parentId": "2",
          "title": "Реализовать эндпоинт /register",
          "description": "POST /api/auth/register — регистрация нового пользователя",
          "status": "in-progress",
          "priority": "high",
          "dependencies": [1],
          "details": "Валидация email, проверка уникальности, хеширование пароля, создание записи, возврат JWT.",
          "testStrategy": "Тесты: успешная регистрация, дублирование email, невалидный email, слабый пароль"
        },
        {
          "id": 3,
          "parentId": "2",
          "title": "Реализовать эндпоинт /login",
          "description": "POST /api/auth/login — вход существующего пользователя",
          "status": "pending",
          "priority": "high",
          "dependencies": [1],
          "details": "Найти пользователя по email, сравнить пароль через bcrypt, вернуть пару access/refresh токенов.",
          "testStrategy": "Тесты: успешный вход, неверный пароль, несуществующий email"
        }
      ],
      "complexity": "complex",
      "recommendedSubtasks": 5,
      "relevantFiles": [
        {
          "path": "src/auth/auth.controller.ts",
          "description": "Контроллер с эндпоинтами аутентификации",
          "action": "create"
        },
        {
          "path": "src/auth/auth.service.ts",
          "description": "Бизнес-логика аутентификации",
          "action": "create"
        },
        {
          "path": "prisma/schema.prisma",
          "description": "Схема базы данных",
          "action": "modify"
        }
      ],
      "acceptanceCriteria": [
        "Пользователь может зарегистрироваться с email и паролем",
        "Пользователь может войти и получить JWT-токен",
        "Повторная регистрация с тем же email возвращает ошибку 409"
      ],
      "scopeBoundaries": {
        "included": "Регистрация, вход, JWT-токены, хеширование паролей",
        "excluded": "OAuth, 2FA, сброс пароля, управление ролями"
      }
    },
    {
      "id": 3,
      "title": "Реализовать CRUD для ресурсов",
      "description": "REST API эндпоинты для основных сущностей проекта",
      "status": "pending",
      "priority": "medium",
      "dependencies": ["1", "2"],
      "details": "Стандартные CRUD-операции с валидацией, пагинацией и фильтрацией.",
      "testStrategy": "Integration-тесты для каждого эндпоинта: создание, чтение, обновление, удаление.",
      "subtasks": []
    }
  ],
  "metadata": {
    "version": "1.0.0",
    "lastModified": "2026-02-23T10:00:00.000Z",
    "taskCount": 3,
    "completedCount": 1,
    "projectName": "my-api",
    "description": "Backend API service"
  }
}
```

---

## Управление полями задач: CLI vs MCP

Task Master предоставляет два интерфейса для управления задачами: CLI (командная строка) и MCP (Model Context Protocol, для AI-агентов). Их возможности по изменению полей задач различаются.

### Детерминированное изменение отдельных полей

Только три поля можно менять точечно и предсказуемо (без участия AI):

| Поле | CLI | MCP | Команда |
|------|:---:|:---:|---------|
| `status` | + | + | CLI: `task-master set-status --id=1 --status=done`; MCP: `set_task_status` |
| `dependencies` | + | + | CLI: `task-master add-dependency --id=3 --depends-on=1`; MCP: `add_dependency` / `remove_dependency` |
| `metadata` | **нет** | + | Только MCP: `update_task({id: "1", metadata: '{"sprint": "Q1"}'})`; требует `TASK_MASTER_ALLOW_METADATA_UPDATES=true` в env |

### Изменение содержимого через AI-промпт

Поля `title`, `description`, `details`, `testStrategy`, `relevantFiles`, `acceptanceCriteria` и другие содержательные поля **нельзя изменить напрямую** ни через CLI, ни через MCP. Вместо этого используется AI-операция: вы передаёте текстовый промпт, и AI перегенерирует содержимое задачи на его основе.

| Операция | CLI | MCP | Описание |
|----------|:---:|:---:|----------|
| Обновить задачу через AI | + | + | CLI: `task-master update-task 1 "добавить валидацию email"`; MCP: `update_task({id: "1", prompt: "..."})` |
| Дописать к details (append) | + | + | CLI: `task-master update-task 1 --append "заметка о реализации"`; MCP: `update_task({id: "1", prompt: "...", append: true})` |
| Обновить подзадачу | + | + | CLI: `task-master update-subtask --id=1.2 --prompt="..."`; MCP: `update_subtask({id: "1.2", prompt: "..."})` |
| AI с исследованием | + | + | Добавить флаг `--research` (CLI) или `research: true` (MCP) для подключения Perplexity |

### Поля, задаваемые только при создании

| Поле | CLI | MCP | Описание |
|------|:---:|:---:|---------|
| `priority` | + | + | CLI: `task-master add-task --priority=high --prompt="..."`; MCP: `add_task({priority: "high", prompt: "..."})`. После создания — только через AI-update |
| `title` (вручную) | + | + | CLI: `task-master add-task --title="Заголовок"`; MCP: `add_task({title: "..."})` |
| `description` (вручную) | + | + | CLI: `task-master add-task --description="Описание"`; MCP: `add_task({description: "..."})` |
| `details` (вручную) | + | + | CLI: `task-master add-task --details="Детали"`; MCP: `add_task({details: "..."})` |

### Структурные операции

| Операция | CLI | MCP |
|----------|:---:|:---:|
| Создать задачу | + `add-task` | + `add_task` |
| Создать подзадачу | + `add-subtask` | + `add_subtask` |
| Удалить задачу/подзадачу | + `remove-task` | + `remove_task` |
| Расширить задачу в подзадачи (AI) | + `expand` | + `expand_task` |
| Переместить задачу | + `move` | + `move_task` |
| Массовое обновление задач (AI) | + `update --from=5` | + `update` |

### Только чтение

| Операция | CLI | MCP |
|----------|:---:|:---:|
| Список задач | + `list` | + `get_tasks` |
| Детали задачи | + `show <id>` | + `get_task` |
| Следующая задача | + `next` | + `next_task` |
| Анализ сложности (AI) | + `analyze-complexity` | + `analyze_project_complexity` |
| Отчёт о сложности | + `complexity-report` | + `complexity_report` |
| Валидация зависимостей | + `validate-dependencies` | + `validate_dependencies` |

### Итого

Если использовать Task Master как движок для управления задачами с расширенными атрибутами:

- **`status`** и **`dependencies`** — полный контроль через CLI и MCP
- **`metadata`** (произвольные пользовательские данные) — только через MCP или ручное редактирование tasks.json
- **Остальные поля** (title, description, details и т.д.) — через AI-промпт или ручное задание при создании задачи; прямого `--title="новый заголовок"` для существующей задачи нет

---

## Ключевые файлы исходного кода Task Master (https://github.com/eyaltoledano/claude-task-master)

| Файл | Содержимое |
|------|------------|
| `packages/tm-core/src/common/types/index.ts` | TypeScript-определения всех типов |
| `packages/tm-core/src/common/schemas/task-id.schema.ts` | Zod-схемы валидации ID задач |
| `packages/tm-core/src/modules/tasks/entities/task.entity.ts` | Entity с бизнес-правилами валидации |
| `packages/tm-core/src/modules/storage/adapters/file-storage/format-handler.ts` | Логика чтения/записи файла и нормализации данных |
| `packages/tm-core/src/testing/task-fixtures.ts` | Тестовые фикстуры — примеры валидных объектов |
