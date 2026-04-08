# Миграция с task-master CLI на собственную реализацию

> 2026-02-27. Цель: убрать зависимость от глобально установленного `task-master` CLI, сохранив формат `tasks.json`.

## Мотивация

- task-master требует глобальной установки (`npm i -g task-master-ai`)
- Несогласованность статусов внутри самого task-master (см. `docs/patch-taskmaster-for-newstatuses.md`)
- Невозможно добавить свои статусы без патча чужого пакета
- Prorab уже реализовал бо́льшую часть функционала в `tasks-json.ts`

## Что уже есть (не нужно менять)

Файлы `src/core/tasks-json.ts` + `src/core/tasks-json-types.ts` уже реализуют:

| Функция | Файл | Описание |
|---------|------|----------|
| `readTasksFile()` | tasks-json.ts:67 | Чтение tasks.json (стандартный + multi-tag формат) |
| `writeTasksFile()` | tasks-json.ts:87 | Запись с atomic write (tmp + rename) |
| `mutateTasksFile()` | tasks-json.ts:137 | Read-modify-write с сохранением multi-tag |
| `updateTask()` | tasks-json.ts:149 | Обновление полей задачи (включая status) |
| `updateSubtask()` | tasks-json.ts:203 | Обновление полей подзадачи (включая status) |
| `createTask()` | tasks-json.ts:164 | Создание новой задачи |
| `deleteTask()` | tasks-json.ts:193 | Удаление задачи |
| `deleteSubtask()` | tasks-json.ts:220 | Удаление подзадачи |
| `withTasksMutex()` | tasks-json.ts:15 | Мьютекс для конкурентных операций |
| `incrementAttemptCount()` | tasks-json.ts:250 | Счётчик попыток выполнения |
| `getAttemptCount()` | tasks-json.ts:229 | Чтение счётчика попыток |

Полные Zod-схемы для tasks.json: `src/core/tasks-json-types.ts` (FullTask, FullSubtask, TasksFile и т.д.)

Серверные роуты (`src/server/routes/tasks.ts`) уже работают через `tasks-json.ts`, а не через CLI.

## Что использует task-master CLI сейчас

Все вызовы CLI проходят через `src/core/task-master.ts`. Функции и их потребители:

### 1. `getNextTask(cwd)` — получить следующую задачу

**CLI:** `task-master next -f json`

**Потребители:**
- `src/commands/run.ts:475` — основной цикл `prorab run`
- `src/server/execution-manager.ts:202` — `prorab serve`, автоматический выбор задачи

**Что делает:** находит задачу/подзадачу со статусом `pending` или `in-progress`, у которой все зависимости выполнены. Сортирует по приоритету. Для подзадач — ищет только внутри `in-progress` родителей.

**Как заменить:** реализовать `findNextTask()` в `tasks-json.ts`. Алгоритм из task-master (`scripts/modules/task-manager/find-next-task.js`) — ~100 строк. Подробная логика:

1. Собрать set завершённых ID (`done` / `completed`) — и задач, и подзадач (формат `parentId.subId`)
2. Ищем подзадачи: перебираем задачи со статусом `in-progress`, у которых есть `subtasks`. Среди их подзадач выбираем `pending`/`in-progress`, у которых все зависимости в completedIds
3. Если нашли — сортируем: приоритет (desc) → количество зависимостей (asc) → parentId (asc) → subId (asc). Берём первую
4. Если подзадач нет — ищем top-level задачи со статусом `pending`/`in-progress`, у которых все зависимости выполнены
5. Сортируем по тем же правилам. Берём первую
6. Если ничего нет — возвращаем `null`

### 2. `showTask(id, cwd)` — получить задачу по ID

**CLI:** `task-master show <id> -f json`

**Потребители:**
- `src/commands/run.ts:524` — проверка подзадач после выполнения итерации
- `src/server/execution-manager.ts:119,225` — получение задачи для выполнения

**Как заменить:** тривиально — `readTasksFile(cwd)` + `find()` по ID. Функция `findTask()` уже есть в `tasks-json.ts` (приватная, нужно экспортировать или добавить обёртку).

### 3. `setStatus(id, status, cwd)` — установить статус

**CLI:** `task-master set-status --id <id> --status <status>`

**Потребители:**
- `src/commands/run.ts:158,312,322,343,353,503,529,549` — управление жизненным циклом при выполнении
- `src/server/execution-manager.ts:213,230,238` — то же для serve-режима

**Как заменить:** `updateTask(cwd, taskId, { status })` или `updateSubtask(cwd, taskId, subId, { status })` — уже есть.

Но нужно добавить **каскадную логику** из task-master:
- При установке задачи в `done` — все незавершённые подзадачи тоже ставятся в `done`
- При установке подзадачи в `done` — проверить, все ли подзадачи завершены (логирование/предложение)

Каскад реализован в `update-single-task-status.js:60-89,109-129`, это ~30 строк.

### 4. `isTaskMasterAvailable()` — проверка наличия CLI

**CLI:** `task-master --version`

**Потребители:**
- `src/commands/run.ts:375` — ранний выход если CLI не установлен

**Как заменить:** заменить на проверку наличия файла `.taskmaster/tasks/tasks.json`.

### 5. `expandTaskAsync(id, cwd)` — расширить задачу в подзадачи через AI

**CLI:** `task-master expand --id <id>`

**Потребители:**
- `src/server/routes/tasks.ts:250` — эндпоинт `POST /api/tasks/:id/expand`

**Решение: убрать полностью.** Эндпоинт expand удалить или временно возвращать 501 Not Implemented.

### 6. `setTaskMasterVerbosity(v)` — настройка логирования

**Потребители:**
- `src/commands/run.ts:449`
- `src/server/execution-manager.ts:106`

**Как заменить:** после удаления `task-master.ts` вербозность уходит вместе с ним. Если нужно логирование для новых функций — добавить по месту.

## План миграции

Порядок шагов выбран так, чтобы на каждом этапе всё собиралось и тесты проходили.

### Шаг 1. Добавить `findNextTask()` в `tasks-json.ts`

Новая функция, не трогает существующий код. Можно покрыть тестами изолированно.

**Входные данные:** `TasksFile` (уже прочитанный) или `cwd` (прочитает сам).
**Возвращает:** `FullTask | null` — задачу с заполненными subtasks, или null.

При возврате подзадачи нужно вернуть объект, совместимый с текущим `Task` из `types.ts`, потому что `run.ts` и `execution-manager.ts` ожидают именно его. Проверить, что `ExecutionUnit` формируется корректно.

**Тесты:** написать для всех сценариев из `find-next-task.js`:
- Нет pending задач → null
- Простая задача без подзадач
- Задача с подзадачами (подзадача pending, родитель in-progress)
- Зависимости между подзадачами
- Сортировка по приоритету
- Multi-tag формат

### Шаг 2. Добавить `showTaskById()` в `tasks-json.ts`

Обёртка над `readTasksFile()` + поиск по ID. Поддержка формата `N.M` (подзадачи) не нужна — `showTask()` вызывается только с ID задачи.

**Тесты:** задача найдена / не найдена.

### Шаг 3. Добавить `setStatusDirect()` в `tasks-json.ts`

Обёртка над `updateTask()`/`updateSubtask()` с каскадной логикой:
- Парсит ID формата `N` или `N.M`
- Если статус `done` для задачи → каскадно ставит `done` подзадачам
- Использует `withTasksMutex()` для безопасности

**Тесты:**
- Установка статуса задачи
- Установка статуса подзадачи
- Каскад done → подзадачи
- Невалидный ID → ошибка

### Шаг 4. Убрать expand

- Удалить эндпоинт `POST /api/tasks/:id/expand` из `routes/tasks.ts`
- Убрать импорт `expandTaskAsync` отовсюду
- Убрать кнопку/вызов expand в UI (если есть)

### Шаг 5. Переключить потребителей

Заменить импорты в файлах:

**`src/commands/run.ts`:**
```
- import { getNextTask, setStatus, showTask, isTaskMasterAvailable, setTaskMasterVerbosity } from "../core/task-master.js";
+ import { findNextTask, setStatusDirect, showTaskById } from "../core/tasks-json.js";
```
- `isTaskMasterAvailable()` → проверка `existsSync(".taskmaster/tasks/tasks.json")`
- `setTaskMasterVerbosity()` → удалить
- `getNextTask(cwd)` → `findNextTask(cwd)`
- `showTask(id, cwd)` → `showTaskById(id, cwd)`
- `setStatus(id, status, cwd)` → `setStatusDirect(id, status, cwd)`

**`src/server/execution-manager.ts`:** — аналогичная замена.

**`src/__tests__/run-attempt-counter.test.ts`:** — обновить моки.

### Шаг 6. Удалить `src/core/task-master.ts`

После переключения всех потребителей — удалить файл целиком.

### Шаг 7. Согласовать типы

Сейчас есть два набора типов:
- `src/types.ts` — `TaskSchema`, `SubtaskSchema`, `TaskStatus` (используется в `run.ts`, `execution-manager.ts`, промптах)
- `src/core/tasks-json-types.ts` — `FullTaskSchema`, `FullSubtaskSchema` (используется в `tasks-json.ts`, `routes/tasks.ts`)

Нужно убедиться, что новые функции возвращают типы, совместимые с `Task`/`Subtask` из `types.ts`. Варианты:
- **A.** Новые функции возвращают `FullTask`, а потребители адаптируются (FullTask — супермножество Task)
- **B.** Новые функции конвертируют `FullTask → Task` через `TaskSchema.parse()` (безопаснее, ничего не сломает)

Рекомендация: **вариант B** на этапе миграции, потом можно унифицировать типы.

## Что НЕ меняется

- Формат `.taskmaster/tasks/tasks.json` — тот же, что и раньше
- Ручной запуск `task-master` CLI в терминале по-прежнему будет работать с тем же файлом
- Логика `prorab run` (outer/inner loop) — без изменений
- Логика `prorab serve` — без изменений (кроме удаления expand)
- Коммит-стратегия — без изменений
- Промпты — без изменений

## Чек-лист безопасности (что проверить перед каждым шагом)

- [ ] `npm run build` — компиляция без ошибок
- [ ] `npm test` — все тесты проходят
- [ ] `prorab run` с реальным tasks.json — задачи выбираются и выполняются
- [ ] `prorab serve` — UI показывает задачи, статусы обновляются
- [ ] Multi-tag формат tasks.json работает
- [ ] Подзадачи с зависимостями разрешаются в правильном порядке

## Оценка объёма

| Шаг | Новый код | Изменённые файлы |
|-----|-----------|-----------------|
| 1. findNextTask | ~80-100 строк + тесты | tasks-json.ts |
| 2. showTaskById | ~10 строк + тесты | tasks-json.ts |
| 3. setStatusDirect | ~40 строк + тесты | tasks-json.ts |
| 4. Убрать expand | удаление | routes/tasks.ts, UI |
| 5. Переключить потребителей | правки импортов | run.ts, execution-manager.ts, тесты |
| 6. Удалить task-master.ts | удаление | — |
| 7. Согласовать типы | ~10-20 строк | types.ts или потребители |
