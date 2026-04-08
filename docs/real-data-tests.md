# Real Data Tests — OpenCode & Claude Drivers

## Зачем

Код OpenCode driver (`src/core/drivers/opencode.ts`) обрабатывает SSE-поток от OpenCode сервера и собирает из него `IterationResult` — токены, стоимость, длительность, модель, текст агента. Логика нетривиальная: данные приходят из двух источников (step-finish SSE events + `session.messages()` API), и у разных провайдеров (Anthropic, Google, OpenAI, MiniMax, ZAI) **семантика полей отличается**. Без тестов на реальных данных невозможно быть уверенным, что агрегация работает корректно для каждого провайдера.

Аналогичная проблема существует для Claude driver (`src/core/drivers/claude.ts`) — данные из Claude Agent SDK (`query()` async итератор) имеют совершенно другой формат (system/assistant/user/result сообщения вместо SSE events).

## Что сделали

### 1. Добавили временный дамп-код в драйверы

В `opencode.ts` и `claude.ts` добавлен код с меткой `// --- TEMPORARY DUMP ---`, который:
- Собирает каждый SSE event в массив `rawEvents[]`
- Сохраняет ответ `session.messages()` в `rawMessages`
- В конце `runSession()` пишет всё в JSON-файл в `docs/fixtures/`

**Статус**: дамп-код полностью удалён из обоих файлов.

### 2. Сняли реальный вывод для 5 OpenCode моделей

Запускали `prorab run --agent opencode --model MODEL --verbose --max-iterations 1` последовательно в `/tmp/test-project` (Vue 3 contacts-app с задачами в backlog). Каждая модель брала следующую задачу из очереди.

| Модель | Задача | SSE events | Файл |
|---|---|---|---|
| `zai-coding-plan/glm-4.7` | 6.2 Реализация watch | 1301 | `opencode-zai-coding-plan--glm-4.7-*.json` |
| `minimax/MiniMax-M2.5` | 6.3 HTML-шаблон | 357 | `opencode-minimax-MiniMax-M2.5-*.json` |
| `anthropic/claude-sonnet-4-6` | 6.4 CSS стили | 245 | `opencode-anthropic--claude-sonnet-4-6-*.json` |
| `google-vertex/gemini-3.1-pro-preview` | 6.5 Тесты SearchBar | 138 | `opencode-google-vertex--gemini-3.1-pro-preview-*.json` |
| `openai/gpt-5.3-codex` | 7.1 Структура App.vue | 598 | `opencode-openai--gpt-5.3-codex-*.json` |

### 3. Сняли реальный вывод для Claude Code driver

Запускали `prorab run --verbose --max-iterations 1` из обычного терминала (не из Claude Code сессии — вложенный запуск невозможен из-за `CLAUDECODE` env var).

| Модель | Задача | SDK messages | Файл |
|---|---|---|---|
| `claude-opus-4-6` | 7.2 Computed properties App.vue | 98 | `claude-claude-opus-4-6-*.json` |

Особенности: использовались две модели — opus (основная) + haiku (sub-agent tasks через `Task` tool).

### 4. Создали минимизированные test fixtures

Полные дампы (до 900KB каждый) слишком большие для тестов. Скрипт извлёк из каждого:
- Все `step-finish` events (токены, стоимость)
- 3 sample `text` parts (текст агента)
- 3 sample `tool` parts (вызовы инструментов)
- Session events (idle, status, error)
- Assistant messages из `session.messages()` (без system prompt, с усечёнными parts)
- Финальный `iterationResult`

Расположение:
- **Полные дампы**: `docs/fixtures/opencode-*.json` (2.5MB суммарно)
- **Минимизированные fixtures для тестов**: `src/__tests__/fixtures/opencode-*.json` (179KB суммарно)
- **Claude fixture**: `src/__tests__/fixtures/claude-opus-4-6.json` (9KB)
- **Claude полный дамп**: `docs/fixtures/claude-claude-opus-4-6-*.json` (285KB)
- **Общие утилиты логирования**: `src/core/drivers/logging.ts` (118 строк)
- **Тесты утилит**: `src/__tests__/logging.test.ts` (33 теста)

### 5. Написали тесты на реальных данных + утилиты

Файлы:
- `src/__tests__/opencode-real-data.test.ts` — 61 тест (5 провайдеров)
- `src/__tests__/claude-real-data.test.ts` — 32 теста (opus + haiku)
- `src/__tests__/logging.test.ts` — 33 теста (утилиты логирования)

Итого: **126 тестов**.

### 6. Провели рефакторинг драйверов

Коммиты: `27b6ca1`, `2ce4a0a`, `077e752`, `27a3604`, `5e29a8e`.

**Извлечение общих утилит** → `src/core/drivers/logging.ts` (118 строк):
- ANSI-константы: `DIM`, `CYAN`, `RESET`
- Функции: `dim()`, `cyan()`, `truncate()`, `toolInputSummary()`
- Класс `SessionLogger` — инкапсулирует verbosity-логику: `log()`, `logVerbose()`, `logTool()`, `logAssistant()`, `logToolResult()`

**Разбиение `runSession()`** в обоих драйверах на private-методы с Context-объектами:

- `ClaudeDriver` (262 строки): `ClaudeContext` + 8 private-методов (`dispatchMessage`, `handleSystem`, `handleAssistant`, `handleToolUseSummary`, `handleToolProgress`, `handleRateLimit`, `handleResult`, `buildIterationResult`)
- `OpenCodeDriver` (708 строк): `OpenCodeContext` + 10 private-методов (`processEvent`, `handleSessionIdle`, `handleSessionError`, `handleSessionStatus`, `handlePartUpdated`, `handleTextPart`, `handleToolPart`, `handleStepFinish`, `fetchFinalMetrics`, `buildIterationResult`)

## Что тестируем

### Step-finish token aggregation (5 моделей × 3 теста = 15)
- Сумма `input/output/reasoning/cache.read/cache.write` из step-finish events совпадает с `iterationResult`
- Количество step-finish >= numTurns
- Каждый step-finish имеет валидную структуру tokens

### Model extraction из session.messages() (5 × 2 = 10)
- Последний assistant message имеет `providerID` и `modelID`
- `iterationResult.model` = `{providerID}/{modelID}`

### Cost из session.messages() (3 теста)
- Anthropic: cost = 0 (Anthropic через OpenCode не репортит cost)
- Gemini: cost > 0, совпадает с суммой из messages
- OpenAI: cost = 0

### Duration из session.messages() (5 тестов)
- `durationMs` = `last.time.completed - first.time.created`

### parseSignal на реальном resultText (5 тестов)
- Все 5 моделей завершились с `<task-complete>`, parseSignal возвращает `{ type: "complete" }`

### Provider-specific token semantics (5 тестов)
- **Anthropic**: `inputTokens` очень маленький (< 100), потому что Anthropic через OpenCode считает input как НЕ кешированные токены. `cache_read + cache_write > 10000`
- **MiniMax**: нет кеша и reasoning (всё 0)
- **OpenAI**: есть reasoning, есть cache_read, нет cache_write
- **Gemini**: есть reasoning, cache_read, per-step cost
- **GLM-4.7**: есть reasoning, cache_read

### SSE event structure (5 × 3 = 15)
- У всех моделей есть `session.idle` event
- Text parts имеют `id`, `sessionID`, `text`
- Tool parts имеют `tool`, `state.status`

### Text formatting edge cases (2 теста)
- Все модели дают непустой resultText
- resultText содержит `<task-complete>`

## Что тестируем — Claude driver (32 теста)

### Token aggregation из result.modelUsage (6 тестов)
- `modelUsage` содержит opus и haiku
- `inputTokens` = сумма `inputTokens` по всем моделям
- `outputTokens` = сумма `outputTokens` по всем моделям
- `cacheReadTokens` = сумма `cacheReadInputTokens` по всем моделям
- `cacheWriteTokens` = сумма `cacheCreationInputTokens` по всем моделям
- `reasoningTokens` = 0 (Claude SDK не репортит reasoning tokens)

### Model extraction из init (3 теста)
- `system.init` имеет model name
- `iterationResult.model` совпадает с init model
- init имеет tools count

### Cost и duration из result message (6 тестов)
- `costUsd` = `result.total_cost_usd`
- `costUsd` = сумма per-model `costUSD`
- cost > 0 (Claude всегда репортит cost)
- `durationMs` = `result.duration_ms`
- numTurns = `result.num_turns`

### parseSignal на реальном resultText (3 теста)
- resultText содержит `<task-complete>DONE</task-complete>`, parseSignal возвращает `{ type: "complete" }`

### Anthropic token semantics (4 теста)
- opus `inputTokens` < 100 (non-cached only)
- opus `cacheReadInputTokens` > 100,000
- opus `cacheCreationInputTokens` > 0
- total cache >> inputTokens

### Multi-model usage / sub-agents (3 теста)
- haiku использовалась для sub-agent tasks
- opus cost >> haiku cost (в 10+ раз)
- haiku имеет собственные cache tokens

### SDK message structure (5 тестов)
- Правильное распределение типов сообщений (assistant, user, system, result)
- text blocks имеют type и text
- tool_use blocks имеют id, name, input
- tool names — известные инструменты
- result message имеет subtype "success"

### Специфичные для Claude (2 теста)
- task_started messages имеют description и task_id
- rate_limit_event имеет rate_limit_info

## Что тестируем — logging utilities (33 теста)

Файл: `src/__tests__/logging.test.ts`

### truncate (3 теста)
- Строки короче лимита не усекаются
- Длинные строки усекаются с "…"
- Пустая строка → пустая строка

### toolInputSummary (11 тестов)
- Read → file_path
- Glob → pattern
- Grep → pattern (не path)
- Bash → command (усечённая до 60 символов)
- Task → description
- Write → file_path
- Edit → file_path
- Неизвестный инструмент → "(no summary)"
- Case-insensitive matching имён инструментов

### SessionLogger (15 тестов)
- `log()` — dim вывод в default/verbose, тишина в quiet
- `logVerbose()` — cyan вывод только в verbose
- `logTool()` — полный JSON в verbose, summary в default
- `logAssistant()` — полный текст в verbose, первая строка (усечённая) в default
- `logToolResult()` — аналогично logAssistant

### ~formatThinkTags / cleanThinkTags~ (удалены)
Think-tag форматтеры были удалены как ненужная косметика. Теги `<think>` от моделей (MiniMax и др.) теперь проходят в вывод без трансформации.

## Обнаруженные факты о данных — Claude driver

### inputTokens у Claude = только non-cached (аналогично OpenCode/Anthropic)

```
claude-opus-4-6:   inputTokens=35, cacheRead=930180, cacheWrite=44116
claude-haiku-4-5:  inputTokens=5023, cacheRead=44499, cacheWrite=13844
ИТОГО:             inputTokens=5058, cacheRead=974679, cacheWrite=57960
```

### Multi-model — opus + haiku

Claude Code автоматически использует haiku для sub-agent tasks (инструмент `Task`). В данном дампе — 3 sub-agent задачи (запуск тестов). Токены и cost агрегируются по всем моделям из `modelUsage`.

### Нет tool_use_summary и tool_progress

В отличие от OpenCode, Claude Agent SDK не эмитит отдельные message types для tool results/progress. Tool use приходит как `assistant` messages с `tool_use` content blocks, tool results — как `user` messages.

### rate_limit_event — специфичный для Claude

SDK эмитит `rate_limit_event` с информацией о rate limits (status, resetsAt, rateLimitType). OpenCode не имеет аналога.

## Обнаруженные факты о данных

### inputTokens у Anthropic через OpenCode = только non-cached

```
step 0: input=2, cache_write=22576  → реальный ввод ~22578
step 1: input=1, cache_read=22576   → почти всё из кеша
step 2: input=1, cache_read=23266
step 3: input=1, cache_read=24297
ИТОГО: inputTokens=5, cacheRead=70139, cacheWrite=25172
```

Это НЕ баг — это семантика Anthropic. Но для пользователя `in=5` выглядит сломанным. Возможно стоит показывать `input + cache_read + cache_write` как "total input" в отчёте.

### messagesResponse возвращает данные, но model = None

В реальных данных `info.model` = `None`, но `info.providerID` и `info.modelID` — на верхнем уровне info. Метод `fetchFinalMetrics()` (строка 645) делает `last.providerID && last.modelID` через каст к `AssistantMessage`, что работает корректно.

### cost перезаписывается из messages

`fetchFinalMetrics()` (строка 631): `ctx.costUsd = sumCost` — перезаписывает сумму step-finish costs суммой из messages. Для Gemini обе суммы одинаковы. Для остальных — обе равны 0.

### message.part.delta events не обрабатываются текущим кодом

Код слушает только `message.part.updated`. Но в потоке есть и `message.part.delta` (у GLM-4.7 — 1112 штук). Текущий код их игнорирует, но delta-данные приходят внутри `message.part.updated` через `props.delta`.

## Как повторить снятие данных

### Шаг 1: Вернуть дамп-код (если уже удалён)

В `src/core/drivers/opencode.ts`:

В `createContext()` добавить поля для дампа:
```ts
const rawEvents: unknown[] = [];
let rawMessages: unknown = null;
```

В `processEvent()` перед обработкой event:
```ts
rawEvents.push(JSON.parse(JSON.stringify(event)));
```

В `fetchFinalMetrics()` после `session.messages()`:
```ts
rawMessages = JSON.parse(JSON.stringify(messagesResult));
```

В `runSession()` перед return в конце:
```ts
import { writeFileSync, mkdirSync } from "node:fs";
const DUMP_DIR = "docs/fixtures";
mkdirSync(DUMP_DIR, { recursive: true });
const modelSlug = model.replace(/\//g, "--");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`${DUMP_DIR}/opencode-${modelSlug}-${ts}.json`, JSON.stringify({
  capturedAt: new Date().toISOString(),
  driver: "opencode", model, sseEvents: rawEvents,
  messagesResponse: rawMessages, iterationResult: { signal, numTurns, durationMs, costUsd, resultText, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, model },
}, null, 2));
```

### Шаг 2: Собрать и запустить

```bash
npm run build
cd /tmp/test-project
prorab run --agent opencode --model MODEL --verbose --max-iterations 1
```

### Шаг 3: Минимизировать fixtures

Скрипт для минимизации (python3):
```bash
# Из корня prorab:
python3 -c "
import json, os, glob
for f in sorted(glob.glob('docs/fixtures/opencode-*.json')):
    with open(f) as fh: data = json.load(fh)
    model = data['model']; slug = model.replace('/', '-')
    events = data['sseEvents']
    sf, tp, tt, se = [], [], [], []
    for e in events:
        if e.get('type') == 'message.part.updated':
            p = e['properties']['part']
            if p['type'] == 'step-finish': sf.append(e)
            elif p['type'] == 'text' and len(tt) < 3: tt.append(e)
            elif p['type'] == 'tool' and len(tp) < 3: tp.append(e)
        elif e.get('type') in ('session.idle','session.error','session.status'): se.append(e)
    msgs = data.get('messagesResponse',{})
    am = [{'info':{k:v for k,v in m['info'].items() if k!='system'},'parts':m.get('parts',[])[:2]}
          for m in (msgs.get('data') or []) if m['info']['role']=='assistant']
    mini = {'model':model,'totalSseEvents':len(events),'stepFinishEvents':sf,
            'sampleTextParts':tt,'sampleToolParts':tp,'sessionEvents':se,
            'assistantMessages':am,'iterationResult':data['iterationResult']}
    out = f'src/__tests__/fixtures/opencode-{slug}.json'
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out,'w') as o: json.dump(mini, o, indent=2, ensure_ascii=False)
    print(f'{slug}: {os.path.getsize(out)} bytes')
"
```

### Шаг 4: Запустить тесты

```bash
npx vitest run src/__tests__/opencode-real-data.test.ts
```

### Для Claude Code driver

**Важно**: запускать из обычного терминала (НЕ из Claude Code сессии).

#### Шаг 1: Вернуть дамп-код в `src/core/drivers/claude.ts`

Добавить import:
```ts
import { writeFileSync, mkdirSync } from "node:fs"; // --- TEMPORARY DUMP ---
```

В `createContext()` добавить:
```ts
rawMessages: [] as unknown[],
```

В `dispatchMessage()` в начале:
```ts
ctx.rawMessages.push(JSON.parse(JSON.stringify(msg)));
```

В `runSession()` перед финальным `return`:
```ts
const DUMP_DIR = "docs/fixtures";
mkdirSync(DUMP_DIR, { recursive: true });
const modelSlug = model.replace(/\//g, "--");
const ts = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`${DUMP_DIR}/claude-${modelSlug}-${ts}.json`, JSON.stringify({
  capturedAt: new Date().toISOString(),
  driver: "claude", model: ctx.model, sdkMessages: ctx.rawMessages,
  iterationResult: { signal, numTurns: ctx.numTurns, durationMs: ctx.durationMs, costUsd: ctx.costUsd, resultText: ctx.resultText, inputTokens: ctx.inputTokens, outputTokens: ctx.outputTokens, cacheReadTokens: ctx.cacheReadTokens, cacheWriteTokens: ctx.cacheWriteTokens, reasoningTokens: 0, model: ctx.model },
}, null, 2));
```

#### Шаг 2: Собрать и запустить

```bash
npm run build
cd /tmp/test-project
prorab run --verbose --max-iterations 1
```

**NB**: файл записывается в `docs/fixtures/` относительно cwd проекта-задачи, а не prorab. Скопировать в `prorab/docs/fixtures/` вручную.
