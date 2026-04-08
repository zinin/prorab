## Задача: покрыть тестами verbose-вывод в консоль для обоих драйверов

### Контекст

Проект prorab. Два agent-драйвера выводят информацию в консоль во время работы:

- `src/core/drivers/opencode.ts` — `OpenCodeDriver`, стримит SSE events
- `src/core/drivers/claude.ts` — `ClaudeDriver`, итерирует SDK messages

Есть готовые JSON fixtures с реальными данными:
- `src/__tests__/fixtures/opencode-minimax-MiniMax-M2.5.json` (и 4 других провайдера)
- `src/__tests__/fixtures/claude-opus-4-6.json`

Есть тесты на корректность данных (`opencode-real-data.test.ts`, `claude-real-data.test.ts`), но **консольный вывод не тестируется вообще**.

### Что нужно сделать

Написать тесты, которые проверяют **что именно выводится в консоль** при обработке реальных данных в verbose/default/quiet режимах.

### Стратегия

1. **Прочитай оба драйвера** (`opencode.ts`, `claude.ts`) полностью — пойми все точки вывода (`console.log`, `process.stdout.write`), когда используется `log()` (dim), `logVerbose()` (cyan), raw write.

2. **Прочитай существующие тесты** (`opencode-real-data.test.ts`, `claude-real-data.test.ts`) и fixtures — пойми формат данных.

3. **Для OpenCodeDriver** — замокай:
   - `createOpencodeClient` → возвращает fake client
   - `client.event.subscribe()` → возвращает async iterable, который yield-ит SSE events из fixture
   - `client.session.create()` → `{ data: { id: "test-session" } }`
   - `client.session.promptAsync()` → `{}`
   - `client.session.messages()` → данные `assistantMessages` из fixture
   - `client.session.delete()` → `{}`

   Обрати внимание: `setup()` вызывает `createOpencodeServer` и `findFreePort` — их тоже нужно замокать (или тестировать только `runSession()` напрямую, предварительно подставив mock client через reflection/spy).

4. **Для ClaudeDriver** — замокай:
   - `query` из `@anthropic-ai/claude-agent-sdk` → возвращает async iterable, который yield-ит SDK messages из fixture (в fixture есть `initMessage`, `sampleTextBlocks`, `sampleToolUseBlocks`, `resultMessage` — нужно будет реконструировать полную последовательность messages)

5. **Шпионь на вывод**:
   ```typescript
   const logs: string[] = [];
   vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
   vi.spyOn(process.stdout, 'write').mockImplementation((data) => { logs.push(String(data)); return true; });
   ```

6. **Проверяй для verbose режима**:
   - **OpenCode**:
     - `[step-finish]` строки выводятся для каждого step-finish event (с reason, in/out, cache)
     - `[tool]` строки содержат полный JSON input
     - `[tool-result]` содержит **полный** output (не обрезанный)
     - Текст агента выводится в cyan (содержит `\x1b[36m`)
     - `[opencode]` мета-строки выводятся в dim (`\x1b[2m`)
   - **Claude**:
     - `[init]` строка содержит model name
     - `[assistant]` текст выводится в cyan
     - `[tool]` строки содержат полный JSON input
     - `[tool-result]` содержит полный summary
     - `[rate-limit]` строка выводится при rate_limit_event
     - `[task-started]` строка выводится для sub-agent tasks

7. **Проверяй для default режима**:
   - `[assistant]` показывает только первую строку, обрезанную до 120 символов
   - `[tool]` показывает summary (не полный JSON)
   - `[tool-result]` показывает первую строку обрезанную (Claude) / не показывается (OpenCode)
   - step-finish **не** выводится
   - Всё в dim

8. **Проверяй для quiet режима**:
   - Никакого вывода в console.log (проверить что logs пуст или содержит только stderr)

### Файлы для создания

- `src/__tests__/opencode-verbose-output.test.ts`
- `src/__tests__/claude-verbose-output.test.ts`

### Ключевые файлы для чтения

- `CLAUDE.md` — архитектура, команды
- `src/core/drivers/opencode.ts` — OpenCode драйвер
- `src/core/drivers/claude.ts` — Claude драйвер
- `src/core/drivers/types.ts` — интерфейс AgentDriver, parseSignal
- `src/__tests__/opencode-real-data.test.ts` — примеры загрузки fixtures
- `src/__tests__/fixtures/opencode-minimax-MiniMax-M2.5.json` — OpenCode fixture
- `src/__tests__/fixtures/claude-opus-4-6.json` — Claude fixture
- `src/types.ts` — IterationResult, Verbosity

### Требования

- Использовать vitest (уже настроен в проекте)
- Не рефакторить драйверы — тестировать as-is через моки
- Проверять наличие ANSI-кодов цвета (`\x1b[36m` для cyan, `\x1b[2m` для dim)
- Использовать существующие fixture данные, не создавать новые
- Запуск: `npm run build && npm test`
