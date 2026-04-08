# Проблема: orphaned child processes при использовании OpenCode драйвера

## Суть проблемы

Когда агент (через prorab) запускает фоновые процессы во время выполнения задачи — например, `npm run dev`, Playwright-браузер, dev-сервер и т.п. — поведение после завершения сессии агента отличается в зависимости от драйвера:

| Драйвер | Поведение после завершения сессии |
|----------|----------------------------------|
| **Claude Code** | Все запущенные процессы корректно завершаются |
| **OpenCode** | Процессы продолжают работать (orphaned) |

Агент может «забыть» остановить фоновые процессы перед завершением. Claude Code это компенсирует на уровне архитектуры, OpenCode — нет.

## Архитектурная разница двух драйверов

### Claude Code SDK (`@anthropic-ai/claude-agent-sdk`)

**Архитектура: единый CLI-процесс с встроенным sandbox**

```
prorab (Node.js)
  └── claude CLI (spawned child process, same process group)
        ├── Bash tool → npm run dev (внутренний sandbox)
        ├── Bash tool → playwright (внутренний sandbox)
        └── ... все инструменты работают внутри CLI
```

Ключевые особенности:
- SDK спавнит `claude` CLI как **дочерний процесс** через `child_process.spawn()`
- **Без `detached: true`** — процесс входит в ту же process group, что и prorab
- Claude CLI управляет всеми инструментами через **внутренний sandbox** — все Bash-сессии, фоновые задачи и т.д. контролируются CLI
- SDK реализует **двухступенчатое завершение**:
  1. Отправляет SIGTERM
  2. Ждёт 5 секунд
  3. Если процесс жив — отправляет SIGKILL
- Когда CLI завершается, его sandbox **убивает все дочерние процессы**

Код завершения в SDK (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, деминифицирован):
```javascript
close() {
  this.processStdin?.end();
  // Remove abort signal listener
  this.abortController.signal.removeEventListener("abort", this.abortHandler);
  // Remove exit listeners
  for (let { handler } of this.exitListeners)
    this.process?.off("exit", handler);

  // Two-stage kill:
  if (this.process && !this.process.killed) {
    this.process.kill("SIGTERM");          // Stage 1: graceful
    setTimeout(() => {
      if (this.process && !this.process.killed)
        this.process.kill("SIGKILL");      // Stage 2: force after 5s
    }, 5000);
  }
}
```

### OpenCode SDK (`@opencode-ai/sdk`)

**Архитектура: HTTP-сервер с отдельными дочерними процессами**

```
prorab (Node.js)
  └── opencode serve (spawned child process)
        ├── HTTP server (обрабатывает API-запросы)
        ├── Session → Bash tool → npm run dev (отдельный child process сервера)
        ├── Session → Bash tool → playwright (отдельный child process сервера)
        └── ... инструменты — отдельные процессы, управляемые сервером
```

Ключевые особенности:
- SDK спавнит `opencode serve` как HTTP-сервер через `child_process.spawn()`
- Инструменты (Bash, PTY) запускаются как **отдельные дочерние процессы сервера**
- `serverHandle.close()` делает **только** `proc.kill()` (SIGTERM) — без ожидания, без SIGKILL
- `session.delete()` — просто HTTP DELETE запрос, **не гарантирует** cleanup дочерних процессов на уровне ОС
- Зависит от того, как OpenCode обрабатывает SIGTERM — форвардит ли сигнал своим дочерним процессам

Код завершения в SDK (`node_modules/@opencode-ai/sdk/dist/server.js`):
```javascript
close() {
  proc.kill();  // SIGTERM, synchronous, no wait, no SIGKILL fallback
}
```

## Корневая причина

Проблема **не в prorab**, а в разнице архитектур SDK:

1. **Claude Code**: CLI — это монолит, который контролирует все инструменты через sandbox. Завершение CLI = завершение всего.

2. **OpenCode**: сервер спавнит инструменты как отдельные процессы. Когда prorab убивает сервер через SIGTERM:
   - Сервер **может не успеть** передать сигнал дочерним процессам
   - Сервер **может не реализовать** корректный cleanup (зависит от реализации opencode)
   - Дочерние процессы становятся **orphaned** — PID 1 (init/systemd) принимает их
   - Процессы вроде `npm run dev` или Playwright-браузера продолжают работать бесконечно

### Цепочка вызовов в prorab (обе архитектуры)

```
executeUnit() / executeReview() / executeRework()
  try {
    await driver.setup?.(...)     // OpenCode: start server
    result = await driver.runSession(...)  // Agent does work, spawns processes
  } finally {
    await driver.teardown?.()     // OpenCode: proc.kill() → SIGTERM → hope for the best
  }
```

Файл: `src/commands/run.ts`, строки 188-231

## Что можно сделать

### Вариант 1: Убивать process group целиком (рекомендуемый)

Вместо убийства только серверного процесса — убить всю его process group. Все дочерние процессы сервера наследуют его process group ID (PGID), поэтому `kill(-pgid, SIGTERM)` убьёт их всех.

**Проблема**: SDK не экспортирует PID серверного процесса через `serverHandle`. Нужно либо:
- Форкнуть SDK / запатчить
- Получить PID другим способом (например, через lsof по порту)
- Использовать `spawn()` напрямую вместо `createOpencodeServer()`

**Реализация (если есть PID)**:
```typescript
async teardown(): Promise<void> {
  if (this.serverPid) {
    try {
      // Kill entire process group (negative PID = process group)
      process.kill(-this.serverPid, 'SIGTERM');
      // Wait for cleanup
      await new Promise(resolve => setTimeout(resolve, 2000));
      // Force kill if still alive
      try { process.kill(-this.serverPid, 'SIGKILL'); } catch {}
    } catch {}
  }
  if (this.serverHandle) {
    this.serverHandle.close();
    this.serverHandle = null;
  }
}
```

### Вариант 2: Самостоятельный spawn вместо SDK

Вместо `createOpencodeServer()` спавнить `opencode serve` самостоятельно, чтобы иметь доступ к `ChildProcess` объекту и его PID:

```typescript
import { spawn } from 'node:child_process';

async setup(opts: SetupOptions): Promise<void> {
  const port = await findFreePort();
  this.serverProcess = spawn('opencode', ['serve', `--port=${port}`], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // detached: false — по умолчанию, процессы в одной group
  });
  this.serverPid = this.serverProcess.pid;
  // Ждать "opencode server listening" в stdout...
}

async teardown(): Promise<void> {
  if (this.serverPid) {
    try {
      process.kill(-this.serverPid, 'SIGTERM'); // kill process group
    } catch {}
    await waitForExit(this.serverProcess, 3000);
    try {
      process.kill(-this.serverPid, 'SIGKILL'); // force kill
    } catch {}
  }
}
```

### Вариант 3: Двухступенчатое завершение (как Claude SDK)

Добавить SIGKILL fallback в текущий teardown:

```typescript
async teardown(): Promise<void> {
  if (this.serverHandle) {
    this.serverHandle.close(); // SIGTERM
    this.serverHandle = null;
  }
  // Wait + force kill server abort signal
  await new Promise(resolve => setTimeout(resolve, 3000));
  if (this.serverAbort && !this.serverAbort.signal.aborted) {
    this.serverAbort.abort(); // Force abort
  }
  this.serverAbort = null;
  this.client = null;
}
```

**Ограничение**: это убьёт сервер, но не его дочерние процессы-сироты.

### Вариант 4: Убийство дочерних процессов по дереву (pkill/pstree)

Найти все процессы-потомки серверного процесса и убить их:

```typescript
import { execFileSync } from 'node:child_process';

function killProcessTree(pid: number): void {
  try {
    // Получить все дочерние PID через pgrep
    const children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .trim().split('\n').filter(Boolean).map(Number);

    // Рекурсивно убить дочерние
    for (const child of children) {
      killProcessTree(child);
    }

    // Убить сам процесс
    process.kill(pid, 'SIGTERM');
  } catch {}
}
```

**Ограничение**: зависимость от системной утилиты `pgrep`, не кроссплатформенно для Windows.

### Вариант 5: Инструкции в промпте (быстрый хотфикс)

Добавить в системный промпт агента инструкцию:

```
IMPORTANT: Before signaling task completion, you MUST stop all background
processes you started during this session (dev servers, browsers, watchers,
etc.). Use `kill` or `Ctrl+C` equivalent to terminate them. Verify with
`ps aux | grep` that nothing is left running.
```

Файл: `src/prompts/execute.ts` → `buildSystemPrompt()`

**Ограничение**: агент может проигнорировать инструкцию. Не надёжно, но лучше чем ничего.

## Рекомендуемый план действий

1. **Немедленно (хотфикс)**: Вариант 5 — добавить инструкцию в промпт
2. **Краткосрочно**: Вариант 2 — перейти на самостоятельный spawn сервера, чтобы иметь PID
3. **В spawn использовать**: Вариант 1 — убивать process group через `kill(-pid, SIGTERM/SIGKILL)`
4. **Опционально**: подать issue/PR в opencode-ai/sdk с просьбой экспортировать PID или реализовать корректный cleanup

## Релевантные файлы

| Файл | Что в нём |
|------|-----------|
| `src/core/drivers/opencode.ts` | OpenCodeDriver — setup/teardown/runSession |
| `src/core/drivers/claude.ts` | ClaudeDriver для сравнения |
| `src/core/drivers/types.ts` | AgentDriver интерфейс |
| `src/commands/run.ts` | Основной цикл выполнения, вызов setup/teardown |
| `src/prompts/execute.ts` | Системный промпт для агента |
| `node_modules/@opencode-ai/sdk/dist/server.js` | createOpencodeServer — spawn + close() |
| `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs` | Claude SDK — spawn + двухступенчатый kill |
