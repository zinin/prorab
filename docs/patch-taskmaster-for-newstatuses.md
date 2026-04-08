# Патч Task Master: добавление новых статусов (например testing)

> Исследование проведено 2026-02-27. Версия task-master: исходники из `/opt/github/eyaltoledano/claude-task-master`.

## Контекст

Хотим добавить статус `testing` (после `review`) в жизненный цикл задач. Task Master использует фиксированные списки допустимых статусов, поэтому произвольный статус отклоняется с ошибкой.

## Текущие статусы

Task Master определяет допустимые статусы в **трёх разных местах**, и они **не совпадают** между собой:

### 1. Рантайм-валидация — `src/constants/task-status.js`

Единственный источник правды для CLI-команды `set-status`. Функция `isValidTaskStatus()` проверяет через `TASK_STATUS_OPTIONS.includes(status)`.

```js
// src/constants/task-status.js:16-23
export const TASK_STATUS_OPTIONS = [
  'pending',
  'done',
  'in-progress',
  'review',
  'deferred',
  'cancelled'
];
```

**Нет `blocked`!** Хотя prorab и наша документация его используют.

### 2. Zod-схема для задач — `src/schemas/base-schemas.js:19-26`

Используется для валидации структуры при AI-генерации задач (не при set-status).

```js
export const TaskStatusSchema = z.enum([
  'pending',
  'in-progress',
  'blocked',
  'done',
  'cancelled',
  'deferred'
]);
```

**Нет `review`!** Хотя рантайм-валидация его поддерживает.

### 3. Zod-схема для подзадач — `src/schemas/base-schemas.js:48`

Самый ограниченный набор, используется при AI-генерации подзадач:

```js
status: z.enum(['pending', 'done', 'completed'])
```

**Только 3 статуса!** Нет `in-progress`, `review`, `blocked` и т.д.

### Сводная таблица

| Статус | constants (CLI) | Zod Task | Zod Subtask |
|--------|:---:|:---:|:---:|
| `pending` | + | + | + |
| `in-progress` | + | + | - |
| `done` | + | + | + |
| `completed` | - | - | + |
| `review` | + | - | - |
| `blocked` | - | + | - |
| `deferred` | + | + | - |
| `cancelled` | + | + | - |

Несогласованность — баг самого task-master. При патче имеет смысл заодно выровнять.

## Логика, завязанная на конкретные статусы

### `find-next-task.js` — выбор следующей задачи

Файл: `scripts/modules/task-manager/find-next-task.js`

- **Завершённые** (для проверки зависимостей): `status === 'done' || status === 'completed'` (строки 40, 45)
- **Кандидаты-подзадачи**: статус `pending` или `in-progress` у подзадачи, а родительская задача — `in-progress` (строки 56, 60)
- **Кандидаты-задачи**: статус `pending` или `in-progress` (строка 111)

**Вывод:** задача/подзадача в статусе `testing` будет пропущена — не завершена и не в работе. Это **корректное поведение**: задача на тестировании не должна предлагаться как "следующая".

### `update-single-task-status.js` — каскадное обновление статусов

Файл: `scripts/modules/task-manager/update-single-task-status.js`

- При установке подзадачи в `done`/`completed` проверяет, все ли подзадачи завершены (строки 62-67)
- При установке задачи в `done`/`completed` каскадно завершает все незавершённые подзадачи (строки 109-128)

**Вывод:** подзадача в `testing` не будет считаться завершённой — родительская задача не получит подсказку "все подзадачи done". Это **корректно**.

### `set-task-status.js` — точка входа CLI

Файл: `scripts/modules/task-manager/set-task-status.js`

Вызывает `isValidTaskStatus(newStatus)` на строке 35. Если статус невалидный — `process.exit(1)`.

## Что нужно изменить в task-master

### Минимальный патч для добавления `testing`

**Файл 1: `src/constants/task-status.js`**

```diff
 export const TASK_STATUS_OPTIONS = [
   'pending',
   'done',
   'in-progress',
   'review',
+  'testing',
   'deferred',
   'cancelled'
 ];
```

Также обновить JSDoc typedef на строке 2.

**Файл 2: `src/schemas/base-schemas.js` — TaskStatusSchema**

```diff
 export const TaskStatusSchema = z.enum([
   'pending',
   'in-progress',
   'blocked',
   'done',
+  'review',
+  'testing',
   'cancelled',
   'deferred'
 ]);
```

(Заодно добавляем `review`, которого там не хватало.)

**Файл 3: `src/schemas/base-schemas.js` — SubtaskSchema**

```diff
-status: z.enum(['pending', 'done', 'completed']),
+status: z.enum(['pending', 'in-progress', 'done', 'completed', 'review', 'testing', 'blocked', 'deferred', 'cancelled']),
```

Или, лучше, переиспользовать `TaskStatusSchema` с добавлением `completed`:

```js
status: TaskStatusSchema.or(z.literal('completed')),
```

### Изменения в prorab

**Файл: `src/types.ts`**

```diff
 export const TaskStatusSchema = z.enum([
   "pending",
   "in-progress",
   "done",
   "review",
+  "testing",
   "blocked",
   "deferred",
   "cancelled",
 ]);
```

### Нет необходимости менять

- `find-next-task.js` — новый статус корректно игнорируется
- `update-single-task-status.js` — каскадная логика не затронута
- `set-task-status.js` — использует `isValidTaskStatus()`, который обновится автоматически
- UI prorab — статусы отображаются как строки, нового кода не нужно (разве что цвет/иконку)

## Предполагаемый жизненный цикл

```
pending → in-progress → review → testing → done
                ↑           |        |
                +-----------+--------+  (возврат при проблемах)

blocked (в любой момент)
deferred (в любой момент)
cancelled (в любой момент)
```

## Риски

1. **Обновления task-master** — патч придётся поддерживать при каждом обновлении. Рассмотреть PR в upstream, если статус полезен сообществу.
2. **Несогласованность Zod-схем** — уже существующая проблема task-master. Патч может её усугубить или, наоборот, частично исправить.
3. **AI-генерация** — если AI создаёт задачи через Zod-схемы, он не будет использовать `testing` автоматически, пока не получит соответствующий промпт.

## Альтернатива: использовать metadata вместо нового статуса

Вместо патча можно хранить расширенный статус в `metadata`:

```json
{
  "status": "review",
  "metadata": { "stage": "testing" }
}
```

Плюсы: не нужно патчить task-master.
Минусы: `task-master list` не покажет stage, фильтрация по stage невозможна через CLI.
