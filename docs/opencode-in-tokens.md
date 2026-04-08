# OpenCode: почему `inputTokens` для Anthropic показывает ~1 за ход

## Проблема

При запуске `prorab run --agent opencode` с Anthropic-моделью (например `anthropic/claude-sonnet-4-6`) метрика `in` в итогах сессии показывает аномально низкое значение — порядка 1 токена на ход:

```
--- Result: complete | 18 turns | 94.3s | $0.0000 | in=19 out=5121 ---
```

Для сравнения, та же метрика с OpenAI-моделью (например `openai/gpt-5.3-codex`) показывает реалистичные значения:

```
--- Result: complete | 13 turns | 71.3s | $0.0000 | in=103599 out=2901 ---
```

## Расследование

### Что показывают step-finish events

Данные из SSE-событий `step-finish` для одной и той же задачи (task 3.4 vs 3.5, comparable size):

**Anthropic (claude-sonnet-4-6), 18 ходов:**

| Step | input | output | cache.read | cache.write | total |
|------|-------|--------|------------|-------------|-------|
| #1 | 2 | 58 | 0 | 19,888 | 19,948 |
| #2 | 1 | 164 | 19,888 | 690 | 20,743 |
| #18 | 1 | 212 | 29,584 | 690 | 30,487 |
| **Sum** | **19** | **5,121** | **403,737** | **60,166** | |

**OpenAI (gpt-5.3-codex), 13 ходов:**

| Step | input | output | cache.read | cache.write | total |
|------|-------|--------|------------|-------------|-------|
| #1 | 15,774 | 430 | 0 | 0 | 16,204 |
| #2 | 3,262 | 180 | 16,000 | 0 | 19,442 |
| #11 | 39,239 | 178 | 0 | 0 | 39,417 |
| #12 | 1,259 | 75 | 39,296 | 0 | 40,630 |
| **Sum** | **103,599** | **2,901** | **343,040** | **0** | |

### Ключевое наблюдение

На первом шаге **OpenAI** показывает `input=15,774` — это полный промпт (system prompt + tool definitions + task), кеша ещё нет. Это реалистично.

На первом шаге **Anthropic** показывает `input=2`, а `cache.write=19,888` — весь промпт (~20K токенов) сразу ушёл в кеш, "uncached" осталось лишь 2 токена.

## Корневая причина

### Как Anthropic API считает input_tokens

Anthropic API возвращает три поля:
- `input_tokens` — токены **после** последнего `cache_control` breakpoint (не из кеша, не записанные в кеш)
- `cache_read_input_tokens` — токены, прочитанные из кеша
- `cache_creation_input_tokens` — токены, записанные в кеш

Формула: `total_input = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`

### Как OpenCode конструирует промпт для Anthropic

OpenCode использует Vercel AI SDK (`@ai-sdk/anthropic`), который поддерживает `cache_control: { type: "ephemeral" }` breakpoints. OpenCode расставляет эти breakpoints так, что **весь промпт** (system prompt, tool definitions, user messages) покрывается кешем.

В результате `input_tokens` из Anthropic API = 1-2 (то, что оказалось после последнего breakpoint — обычно финальный разделитель или закрывающий тег).

### Почему OpenAI ведёт себя иначе

У OpenAI нет Anthropic-style `cache_control` breakpoints. Кеширование серверное, автоматическое. Vercel AI SDK не может управлять им через breakpoints. Поэтому `inputTokens` из API = реальное число входных токенов.

OpenCode's `getUsage()` знает об этом различии:

```typescript
// packages/opencode/src/session/index.ts
const excludesCachedTokens = !!(input.metadata?.["anthropic"] || input.metadata?.["bedrock"])
const adjustedInputTokens = safe(
  excludesCachedTokens ? inputTokens : inputTokens - cacheReadInputTokens - cacheWriteInputTokens,
)
```

Для Anthropic: `excludesCachedTokens = true` → `adjustedInputTokens = inputTokens` (= 1-2, уже uncached).
Для OpenAI: `excludesCachedTokens = false` → `adjustedInputTokens = inputTokens - cacheRead` (SDK возвращает total, нужно вычесть кеш).

Оба пути корректно возвращают "uncached input". Разница в том, что для Anthropic "uncached" = 1-2 токена из-за агрессивных cache breakpoints.

### Что делает prorab

prorab накапливает `tokens.input` из step-finish events:

```typescript
// src/core/drivers/opencode.ts
inputTokens += sfp.tokens.input;
```

Это корректно передаёт то, что OpenCode возвращает. Проблема — upstream в стратегии кеширования OpenCode.

## Данные по четырём провайдерам

Сравнительные запуски на задачах одного размера (Vue-компоненты в тестовом проекте):

| Provider | Кеширование | turns | in | cache_read | cache_write | **total input** |
|----------|------------|-------|-----|------------|-------------|----------------|
| MiniMax-M2.5 (local) | нет | 18 | **232,698** | 0 | 0 | 232,698 |
| GLM-4.7 | серверное | 14 | **66,679** | 466,859 | 0 | 533,538 |
| OpenAI gpt-5.3-codex | серверное | 13 | **103,599** | 343,040 | 0 | 446,639 |
| Anthropic claude-sonnet-4-6 | breakpoints | 18 | **19** | 403,737 | 60,166 | 463,922 |

### Три стратегии кеширования

**Нет кеширования (MiniMax-M2.5, локальная модель)**:
`in=232,698` — полный промпт пересылается каждый ход. Контекст растёт от ~15K на первом ходу до ~30K+ к последнему. Сумма — полная стоимость без оптимизации. `cache_read` и `cache_write` = 0.

**Серверное автоматическое кеширование (OpenAI, GLM)**:
`in=66-103K` — сервер провайдера автоматически кеширует часть промпта (обычно prefix). Нет `cache_write` потому что кеширование implicit, не управляется breakpoints. `in` = реально пересчитанные (не из кеша) токены.

**Explicit cache_control breakpoints (Anthropic через Vercel AI SDK)**:
`in=19` — OpenCode ставит `cache_control: { type: "ephemeral" }` на весь промпт. Anthropic API считает `input_tokens` как токены **после** последнего breakpoint — отсюда 1-2 на ход. Почти весь ввод проходит через `cache_write` (первый ход) или `cache_read` (последующие).

### Сопоставимые метрики

`in` не сопоставим между провайдерами напрямую. Для сравнения нужно использовать **total input** = `in + cache_read + cache_write`:

- GLM, OpenAI, Anthropic: 446-534K — сопоставимый диапазон, разница объясняется числом ходов
- MiniMax: 233K — ниже потому что total input без кеша = сумма растущего контекста, а не повторные чтения из кеша

## Как работает prompt caching

### Зачем нужен кеш

Каждый ход (turn) в разговоре с моделью — это отдельный HTTP-запрос к API провайдера, содержащий **весь контекст** с начала разговора:

```
Turn 1:  [system prompt] [tools] [user message]                                          ~20K tokens
Turn 2:  [system prompt] [tools] [user message] [assistant reply] [tool result] [msg]     ~22K tokens
Turn 3:  [system prompt] [tools] [user message] [reply] [result] [msg] [reply] [result]   ~25K tokens
...
Turn 18: [всё вышеперечисленное]                                                          ~30K tokens
```

Без кеширования провайдер пересчитывает все токены с нуля каждый ход. Кеш позволяет переиспользовать prefix промпта, который не меняется между ходами (system prompt, tools, начало разговора).

### Механика кеширования Anthropic

На первом ходу prefix ещё не в кеше — записывается (`cache_write`). На втором ходу тот же prefix читается из кеша (`cache_read`), а новый контент (ответ модели + результат инструмента) записывается. И так далее:

```
Turn 1:  cache_write=19,888  cache_read=0       (всё новое → записать в кеш)
Turn 2:  cache_write=690     cache_read=19,888   (prefix из кеша, новый кусок записать)
Turn 18: cache_write=690     cache_read=29,584   (большой prefix из кеша, маленький довесок)
```

Кеш живёт 5 минут (`ephemeral`) на серверах Anthropic. При частых запросах кеш может переиспользоваться даже между сессиями.

### Экономический эффект

Расценки Anthropic (Claude Sonnet):

| Тип токенов | Цена за 1M |
|-------------|-----------|
| input (uncached) | $3.00 |
| cache_write | $3.75 (на 25% дороже input) |
| cache_read | $0.30 (в 10 раз дешевле input) |

Пример: сессия из 18 ходов с Anthropic через OpenCode:

| | Без кеша | С кешем |
|---|---------|---------|
| uncached input | 464K × $3.00 = $1.39 | 19 × $3.00 ≈ $0.00 |
| cache_write | — | 60K × $3.75 = $0.23 |
| cache_read | — | 404K × $0.30 = $0.12 |
| **Итого input** | **$1.39** | **$0.35** |

Экономия **~75%** на входных токенах. На длинных сессиях ещё больше — `cache_write` только на первых ходах, дальше `cache_read` по $0.30 вместо $3.00.

У OpenAI кешированные токены ~50% дешевле. У локальных моделей кеширование не влияет на стоимость, но может ускорять inference.

### Можно ли отключить

Отключать не нужно — кеш экономит деньги без побочных эффектов на качество.

- **Anthropic через OpenCode**: breakpoints зашиты в конструирование промпта OpenCode, отключить без патча исходников нельзя.
- **OpenAI**: серверное кеширование автоматическое, отключить невозможно.
- **Локальные модели**: кеширования нет, отключать нечего.

## Статус

Принято как есть. Это не баг в prorab — мы корректно передаём значения из OpenCode. Низкий `inputTokens` для Anthropic через OpenCode — следствие агрессивной стратегии prompt caching в OpenCode + Vercel AI SDK. Единственное следствие — метрика `in` для Anthropic показывает ~1 за ход вместо полного размера промпта.

## Ссылки

- OpenCode source `getUsage()`: `packages/opencode/src/session/index.ts` ([sst/opencode](https://github.com/sst/opencode) на GitHub)
- Vercel AI SDK issue: [vercel/ai#8349](https://github.com/vercel/ai/issues/8349) — inaccurate usage counts with Anthropic
- PostHog issue: [PostHog/posthog-js#2829](https://github.com/PostHog/posthog-js/issues/2829) — Vercel AI SDK v6 changed inputTokens semantics for Anthropic
- Anthropic prompt caching docs: [docs.anthropic.com/en/docs/build-with-claude/prompt-caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
