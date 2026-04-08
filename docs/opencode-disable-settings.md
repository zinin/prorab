# OpenCode: управление пользовательскими настройками при автономном запуске

## Контекст задачи

В `ClaudeDriver` есть параметр `useUserSettings` (управляется галочкой "No user settings" в UI).
Когда `false` — SDK использует только проектные настройки (`settingSources: ["project"]`),
игнорируя `~/.claude/settings.json`. Это убирает кастомные правила, MCP-серверы, разрешения
пользователя, которые могут мешать автономному выполнению.

**Цель:** сделать аналогичное для `OpenCodeDriver` — отключить skills, commands, agents, plugins
из пользовательского окружения, **сохранив** доступ ко всем настроенным провайдерам (API-ключи, endpoints).

## Архитектура конфигурации OpenCode

### Источники конфигурации (порядок приоритета, от низшего к высшему)

1. **Remote** — `.well-known/opencode` endpoint (организационные дефолты)
2. **Global config** — `~/.config/opencode/opencode.json[c]` (XDG path, `$XDG_CONFIG_HOME/opencode/`)
3. **Custom config** — файл по пути из `OPENCODE_CONFIG` env var
4. **Project config** — `opencode.json[c]` в корне проекта (отключается `OPENCODE_DISABLE_PROJECT_CONFIG`)
5. **`.opencode` директории** — сканируются на agents, commands, plugins, skills, и отдельный `opencode.json[c]`
6. **Inline config** — `OPENCODE_CONFIG_CONTENT` env var (JSON)
7. **Managed/Enterprise** — `/etc/opencode/` (наивысший приоритет)

Все источники **мержатся** в один объект. Нет возможности исключить отдельные ключи из конкретного источника.

### Структура глобального конфига (`opencode.json`)

Провайдеры и агенты/команды/скиллы живут **в одном файле**:

```jsonc
{
  // === Провайдеры (нужно сохранить) ===
  "provider": {
    "anthropic": { "options": { "apiKey": "sk-..." } },
    "openai": { "options": { "apiKey": "sk-...", "baseURL": "..." } }
  },
  "model": "anthropic/claude-sonnet-4-20250514",
  "disabled_providers": ["google"],
  "enabled_providers": ["anthropic", "openai"],

  // === Кастомизации (нужно отключить) ===
  "agent": { "custom-agent": { "model": "...", "prompt": "..." } },
  "command": { "/my-cmd": { "template": "..." } },
  "skills": { "paths": ["/home/user/skills"], "urls": ["https://..."] },
  "mcp": { "my-server": { "command": "...", "args": [] } },
  "plugin": ["my-plugin@1.0"],
  "instructions": ["/home/user/extra-instructions.md"],
  "permission": { /* кастомные разрешения */ }
}
```

### `.opencode` директории — что сканируется

`ConfigPaths.directories()` возвращает упорядоченный список:

1. `~/.config/opencode/` (global XDG)
2. `.opencode` dirs от cwd до корня worktree (проектные)
3. `~/.opencode/` (home directory — **всегда сканируется, нет флага отключения**)
4. `$OPENCODE_CONFIG_DIR` (если задан — добавляется, не заменяет)

Для каждой директории загружаются:

| Паттерн | Что загружает |
|---------|--------------|
| `{agent,agents}/**/*.md` | Определения агентов |
| `{command,commands}/**/*.md` | Определения команд |
| `{mode,modes}/*.md` | Режимы (deprecated → agents) |
| `{plugin,plugins}/*.{ts,js}` | Плагины |
| `opencode.json[c]` | Полный конфиг |

### Skills — отдельная загрузка

Skills загружаются в `Skill.state()`, НЕ в `Config.state()`:

1. **External dirs** — `.claude/skills/`, `.agents/skills/` (global + project). Отключается `OPENCODE_DISABLE_EXTERNAL_SKILLS`.
2. **`.opencode` directories** — паттерн `{skill,skills}/**/SKILL.md`
3. **Custom paths** — из `config.skills.paths`
4. **Remote URLs** — из `config.skills.urls`

## Доступные env-переменные

### Флаги отключения (каскад)

```
OPENCODE_DISABLE_CLAUDE_CODE=1
  ├── → OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1   (убирает ~/.claude/CLAUDE.md)
  └── → OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1
        └── → OPENCODE_DISABLE_EXTERNAL_SKILLS=1  (убирает .claude/skills/, .agents/skills/)
```

| Переменная | Что отключает |
|---|---|
| `OPENCODE_DISABLE_CLAUDE_CODE` | Всё из `.claude/` — CLAUDE.md как инструкция + все скиллы из `.claude/skills/` и `.agents/skills/` |
| `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT` | Только `~/.claude/CLAUDE.md` как системная инструкция |
| `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` | `.claude/skills/` и `.agents/skills/` (каскадирует `DISABLE_EXTERNAL_SKILLS`) |
| `OPENCODE_DISABLE_EXTERNAL_SKILLS` | `.claude/skills/` и `.agents/skills/` (global + project). **НЕ** влияет на `.opencode/skill/`, `skills.paths`, `skills.urls` |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | Встроенный npm-плагин `opencode-anthropic-auth@0.0.13`. Внутренние плагины (CodexAuth, CopilotAuth, GitlabAuth) всегда загружаются |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | Проектный `opencode.json[c]` и проектные `.opencode/` директории |

### Другие релевантные переменные

| Переменная | Назначение |
|---|---|
| `OPENCODE_CONFIG` | Путь к дополнительному конфиг-файлу (грузится после global, перед project) |
| `OPENCODE_CONFIG_DIR` | Дополнительная директория для agents/commands/plugins (**добавляется**, не заменяет) |
| `OPENCODE_CONFIG_CONTENT` | Инлайн JSON-конфиг (высший приоритет кроме enterprise). Мержится поверх всего |
| `XDG_CONFIG_HOME` | Определяет путь к глобальному конфигу (по умолчанию `~/.config`) |
| `OPENCODE_TEST_HOME` | Переопределяет `os.homedir()` — влияет на `~/.opencode/`, но **НЕ** на XDG-пути |
| `OPENCODE_PERMISSION` | JSON-переопределение разрешений |
| `OPENCODE_MODEL` | Переопределение модели |

## Чего НЕЛЬЗЯ сделать

1. **Нельзя** выборочно отключить `agent`/`command`/`skills`/`plugin`/`mcp` ключи **из глобального** `~/.config/opencode/opencode.json`, сохранив `provider`
2. **Нельзя** отключить сканирование `~/.opencode/` — нет флага, всегда в списке директорий
3. **Нельзя** указать "загрузи только provider из этого источника" — мерж всегда полный
4. `OPENCODE_CONFIG_DIR` — **добавляет** директорию, не заменяет существующие

## Варианты решения

### Вариант 1: Env-переменные при спавне (минимальный)

```ts
// opencode.ts, в setup()
const env: Record<string, string> = { ...process.env };
if (!this.useUserSettings) {
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
}
const proc = spawn("opencode", args, {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
  env,
});
```

**Плюсы:**
- Минимальные изменения в коде
- Провайдеры из `~/.config/opencode/opencode.json` сохраняются полностью
- Убирает основные источники помех: `.claude/` скиллы, внешние скиллы, npm-плагины

**Минусы:**
- **НЕ** отключает agents/commands/skills/mcp/plugins определённые в самом `~/.config/opencode/opencode.json`
- **НЕ** отключает agents/commands из `~/.opencode/` директории
- Если пользователь определил кастомные agents или MCP-серверы в глобальном конфиге — они всё ещё будут загружаться

**Когда подходит:** Если в глобальном конфиге только провайдеры (типичный случай), а кастомизации хранятся в `.claude/` или проектных `.opencode/` директориях.

### Вариант 2: XDG_CONFIG_HOME + OPENCODE_CONFIG (чистая изоляция)

```ts
const env: Record<string, string> = { ...process.env };
if (!this.useUserSettings) {
  // Подменяем глобальный конфиг на пустую директорию
  env.XDG_CONFIG_HOME = "/tmp/prorab-opencode-empty";
  // Загружаем ТОЛЬКО провайдеров из отдельного файла
  env.OPENCODE_CONFIG = "/path/to/providers-only.json";
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
}
```

Где `providers-only.json` содержит только:
```json
{ "provider": { "anthropic": { "options": { "apiKey": "..." } } } }
```

**Плюсы:**
- Полная изоляция: глобальный конфиг не загружается вообще
- Ни agents, ни commands, ни skills, ни plugins, ни MCP из пользовательских настроек
- Провайдеры доступны через отдельный файл

**Минусы:**
- Требует **дополнительного конфиг-файла** с провайдерами — пользователь должен поддерживать два файла
- `XDG_CONFIG_HOME` влияет на ВСЕ XDG-приложения в дочернем процессе (не только OpenCode) — потенциально ломает другие утилиты, вызываемые OpenCode
- `~/.opencode/` всё ещё сканируется (зависит от `os.homedir()`, а не XDG)
- Сложность: нужно создать пустую директорию, управлять файлом провайдеров

### Вариант 3: XDG_CONFIG_HOME + OPENCODE_CONFIG_CONTENT (без файла)

```ts
const env: Record<string, string> = { ...process.env };
if (!this.useUserSettings) {
  env.XDG_CONFIG_HOME = "/tmp/prorab-opencode-empty";
  // Прочитать провайдеров из реального конфига и передать инлайн
  const realConfig = JSON.parse(fs.readFileSync(
    path.join(os.homedir(), ".config/opencode/opencode.json"), "utf8"
  ));
  const providersOnly = {
    provider: realConfig.provider,
    model: realConfig.model,
    disabled_providers: realConfig.disabled_providers,
    enabled_providers: realConfig.enabled_providers,
  };
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(providersOnly);
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
}
```

**Плюсы:**
- Полная изоляция без дополнительных файлов
- Провайдеры автоматически извлекаются из реального конфига
- Не нужна ручная синхронизация файлов

**Минусы:**
- `XDG_CONFIG_HOME` влияет на все XDG-приложения в дочернем процессе
- Хрупкость: нужно парсить пользовательский конфиг, может не быть файла
- `~/.opencode/` всё ещё сканируется
- Размер env-переменной ограничен (обычно ~128KB, но API-ключи могут быть большими)
- Нужно учитывать `opencode.jsonc` (JSONC, не просто JSON)

### Вариант 4: OPENCODE_CONFIG_CONTENT override (без XDG подмены)

```ts
const env: Record<string, string> = { ...process.env };
if (!this.useUserSettings) {
  // Переопределяем agent/command/skills/mcp/plugin пустыми объектами
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    agent: {},
    command: {},
    skills: { paths: [], urls: [] },
    mcp: {},
    plugin: [],
    instructions: [],
  });
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
}
```

**Плюсы:**
- Не трогает `XDG_CONFIG_HOME` — безопасно для дочерних процессов
- Провайдеры из глобального конфига загружаются нормально
- `OPENCODE_CONFIG_CONTENT` имеет высший приоритет — перезаписывает agents/commands/skills/mcp/plugins

**Минусы:**
- Зависит от поведения мержа: если merge делает deep merge (а не replace), то `agent: {}` может не затереть agents из глобального конфига — **нужно проверить**
- Не отключает `.opencode/` сканирование директорий (agents/*.md, commands/*.md)
- Не отключает `~/.opencode/` сканирование

### Вариант 5: Гибрид — env flags + пустые override'ы (рекомендуемый)

Комбинация вариантов 1 и 4:

```ts
const env: Record<string, string> = { ...process.env };
if (!this.useUserSettings) {
  // Отключаем внешние источники скиллов и плагинов
  env.OPENCODE_DISABLE_CLAUDE_CODE = "1";
  env.OPENCODE_DISABLE_EXTERNAL_SKILLS = "1";
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1";
  // Переопределяем кастомизации из opencode.json пустыми значениями
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    agent: {},
    command: {},
    skills: { paths: [], urls: [] },
    mcp: {},
    plugin: [],
    instructions: [],
  });
}
```

**Плюсы:**
- Максимальное покрытие без побочных эффектов
- Провайдеры сохраняются
- Не трогает XDG
- Env-флаги убирают `.claude/`, `.agents/`, npm-плагины
- `CONFIG_CONTENT` override убирает кастомизации из `opencode.json`

**Минусы:**
- `.opencode/` директории (global `~/.opencode/` + project) всё ещё сканируются на `agent/*.md`, `command/*.md`, `plugin/*.ts` — нет способа отключить
- Нужно проверить, что merge-стратегия для `CONFIG_CONTENT` заменяет (а не мержит) объекты `agent`, `command` и т.д.

### Вариант 6: Runtime config patch через SDK API — НЕ РАБОТАЕТ

~~Монорепо SDK предоставляет `client.config.update()` — PATCH конфига после старта сервера.~~

**Исследование исходников показало, что этот подход НЕ решает задачу.**

#### Как реализован `Config.update(patch)`

```
packages/opencode/src/config/config.ts (~line 1290):

async function update(config: Info) {
  const filepath = path.join(Instance.directory, "config.json")
  const existing = await loadFile(filepath)
  await Filesystem.writeJson(filepath, mergeDeep(existing, config))   // remeda.mergeDeep
  await Instance.dispose()                                             // сброс всего кэша
}
```

#### Почему не работает: merge-семантика

`remeda.mergeDeep` — рекурсивный merge, который **не умеет удалять ключи**:

| Что передаём | Поведение `mergeDeep` | Результат |
|---|---|---|
| `agent: {}` | deep merge `{}` в `{ "my-agent": {...} }` → no-op | **Agents остаются** |
| `command: {}` | deep merge `{}` в `{ "/cmd": {...} }` → no-op | **Commands остаются** |
| `mcp: {}` | deep merge `{}` в `{ "server": {...} }` → no-op | **MCP остаётся** |
| `plugin: []` | Массив не является plain object → shallow replace | **Работает** |
| `instructions: []` | То же | **Работает** |
| `skills: { paths: [], urls: [] }` | Объект deep-merge, но массивы внутри заменяются | **Работает** для paths/urls |

Передача `agent: {}` — это **no-op** для record-полей. Нет способа «стереть» agents/commands/mcp через этот API.

#### Почему не работает: множественные источники

Даже если бы merge стирал ключи — `Config.update()` пишет только в `Instance.directory/config.json`
(рабочая директория инстанса, НЕ глобальный конфиг). После `Instance.dispose()` весь кэш сбрасывается,
и `Config.state()` **пересобирает** конфиг из всех 7 источников (global, project, .opencode dirs, env vars...).
Agents из `~/.config/opencode/opencode.json` и `~/.opencode/agents/*.md` **вернутся**.

#### Единственный механизм удаления агентов

```ts
// В Agent.state() есть проверка:
for (const [key, value] of Object.entries(cfg.agent ?? {})) {
  if (value.disable) { delete result[key]; continue; }  // <-- disable: true удаляет агента
}
```

Можно передать `agent: { "agent-name": { disable: true } }` — но нужно знать имя каждого агента заранее.
Для commands, mcp, skills — аналогичного механизма нет (для MCP есть `enabled: false`, но не проверено).

#### Вывод

`config.update()` непригоден для массового отключения пользовательских кастомизаций.
Для нашей задачи остаются только env-переменные при спавне (варианты 1, 4, 5).

## SDK API — полная справка (монорепо v1.2.x)

Prorab использует `@opencode-ai/sdk` ^1.2.10 с импортом из `@opencode-ai/sdk/v2`.

**Важно:** Существует два разных SDK под одним npm-именем:

| | Stainless SDK (legacy) | Monorepo SDK (текущий) |
|---|---|---|
| Версия | v0.1.0-alpha.21 | v1.2.22 |
| Repo | `anomalyco/opencode-sdk-js` | `anomalyco/opencode/packages/sdk/js/` |
| Server spawn | Нет | `createOpencodeServer()` |
| Config update | Только `get()` | `get()` + `update()` |
| Session prompt | `chat()` (legacy) | `prompt()` / `promptAsync()` |

### Экспорты SDK

- `@opencode-ai/sdk` — main entry (`createOpencode`, `createOpencodeClient`, `createOpencodeServer`)
- `@opencode-ai/sdk/client` — только клиент
- `@opencode-ai/sdk/server` — спавн сервера
- `@opencode-ai/sdk/v2` — v2 версии (используется в prorab)

### `createOpencodeServer(options?)`

```ts
type ServerOptions = {
  hostname?: string;    // default "127.0.0.1"
  port?: number;        // default 4096
  signal?: AbortSignal;
  timeout?: number;     // default 5000ms для ожидания старта
  config?: Config;      // ПОЛНЫЙ конфиг — передаётся через OPENCODE_CONFIG_CONTENT
}
// Возвращает: { url: string, close(): void }
```

### `createOpencodeClient(config?)`

```ts
config?: {
  baseUrl: string;
  directory?: string;   // устанавливает x-opencode-directory header
  fetch?: Function;
  headers?: Record<string, string>;
}
```

### `createOpencode(options?)`

Convenience: спавнит сервер + создаёт клиент. Возвращает `{ client, server }`.

### Session API

```ts
client.session.create({ body?: { parentID?, title? } })
client.session.prompt(id, { body: SessionPromptBody })      // синхронный, ждёт завершения
client.session.promptAsync(id, { body: SessionPromptBody })  // fire-and-forget (204)
client.session.command(id, { body: { command, arguments, messageID?, agent?, model? } })
client.session.shell(id, { body: { agent, command, model? } })
client.session.abort(id)
client.session.fork(id, { body?: { messageID? } })
client.session.diff(id, { query?: { messageID? } })
client.session.messages(id, { query?: { limit? } })
client.session.message(id, messageID)
client.session.status()       // idle/busy/retry map для всех сессий
client.session.list() / .get(id) / .update(id, ...) / .delete(id)
client.session.todo(id)       // todo-list сессии
client.session.children(id)   // дочерние сессии
client.session.share(id) / .unshare(id)
client.session.summarize(id, { body: { providerID, modelID } })
client.session.init(id, { body: { modelID, providerID, messageID } })  // создаёт AGENTS.md
client.session.revert(id, ...) / .unrevert(id)
```

### `SessionPromptBody` — параметры отправки сообщения

```ts
{
  parts: Array<TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput>;  // required
  messageID?: string;
  model?: { providerID: string; modelID: string };
  agent?: string;       // имя агента ("general", "plan", "build", кастомный)
  noReply?: boolean;    // отправить без ожидания ответа
  system?: string;      // override системного промпта
  tools?: { [key: string]: boolean };  // вкл/выкл конкретных инструментов
}
```

### Config API

```ts
client.config.get()                    // чтение текущего конфига
client.config.update(body: Config)     // PATCH конфига в рантайме
client.config.providers()              // список провайдеров с дефолтами
```

### Другие API

```ts
client.app.agents()                    // список всех агентов с конфигами
client.app.log({ body: { service, level, message, extra? } })

client.provider.list()                 // провайдеры с моделями и статусом connected
client.provider.auth()                 // методы авторизации
client.provider.oauth.authorize(id, ...) / .callback(id, ...)

client.tool.ids()                      // список ID всех инструментов
client.tool.list({ query: { provider, model } })  // инструменты с JSON-schema параметрами

client.mcp.status()                    // статус MCP-серверов
client.mcp.add({ body: { name, config } })  // добавить MCP динамически
client.mcp.connect(name) / .disconnect(name)
client.mcp.auth.start(name) / .callback(name, ...) / .authenticate(name) / .remove(name)

client.event.subscribe()               // SSE поток событий
client.global.event()                  // глобальный SSE (cross-directory)

client.command.list()                  // список кастомных команд
client.find.text({pattern}) / .files({query, dirs?}) / .symbols({query})
client.file.list({path}) / .read({path}) / .status()

client.auth.set(id, body)             // установить credentials напрямую
client.project.list() / .current()
client.vcs.get()                       // { branch }
client.lsp.status() / client.formatter.status()
client.path.get()                      // { state, config, worktree, directory }
client.instance.dispose()

// Ответ на permission-запросы
client.postSessionIdPermissionsPermissionId(sessionId, permId, { body: "once" | "always" | "reject" })
```

### Config type (полная схема)

```ts
{
  logLevel?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  model?: string;                // "provider/model"
  small_model?: string;          // для генерации заголовков
  default_agent?: string;
  username?: string;
  provider?: { [key: string]: ProviderConfig };
  agent?: {
    general?: AgentConfig;
    plan?: AgentConfig;
    build?: AgentConfig;
    explore?: AgentConfig;
    [custom: string]: AgentConfig;
  };
  command?: { [name: string]: { template, description?, agent?, model?, subtask? } };
  skills?: { paths?: string[]; urls?: string[] };
  mcp?: { [name: string]: McpLocalConfig | McpRemoteConfig };
  plugin?: string[];
  permission?: {
    edit?: "ask" | "allow" | "deny";
    bash?: "ask" | "allow" | "deny" | { [pattern: string]: "ask" | "allow" | "deny" };
    webfetch?: "ask" | "allow" | "deny";
    doom_loop?: "ask" | "allow" | "deny";
    external_directory?: "ask" | "allow" | "deny";
  };
  instructions?: string[];
  disabled_providers?: string[];
  enabled_providers?: string[];   // whitelist
  tools?: { [key: string]: boolean };
  formatter?: false | { ... };
  lsp?: false | { ... };
  snapshot?: boolean;
  share?: "manual" | "auto" | "disabled";
  server?: { port, hostname, mdns, cors };
  watcher?: { ignore?: string[] };
  compaction?: { auto, prune, reserved };
  experimental?: {
    hook?: { file_edited?, session_completed? };
    chatMaxRetries?: number;
    batch_tool?: boolean;
    primary_tools?: string[];
    // ...
  };
}
```

### AgentConfig (per-agent)

```ts
{
  model?: string;
  temperature?: number;
  top_p?: number;
  prompt?: string;
  tools?: { [key: string]: boolean };
  disable?: boolean;
  description?: string;
  mode?: "subagent" | "primary" | "all";
  color?: string;
  maxSteps?: number;
  permission?: { edit?, bash?, webfetch?, doom_loop?, external_directory? };
}
```

## Нерешённые вопросы

1. **Merge-стратегия `OPENCODE_CONFIG_CONTENT`**: используется `mergeDeep` (remeda) — **deep merge**. Передача `agent: {}` — **no-op**, не стирает agents из глобального конфига. Массивы (`plugin: []`, `instructions: []`) **заменяются**. Это подтверждено исследованием `Config.update()` в `config.ts`, который использует тот же `mergeDeep`. **Вывод:** варианты 4 и 5 с `CONFIG_CONTENT` override **не работают** для record-полей (`agent`, `command`, `mcp`).

2. **`~/.opencode/` директория**: всегда сканируется, нет флага отключения. Если пользователь хранит там `agent/*.md` или `command/*.md` — они загрузятся. Единственный workaround: `OPENCODE_TEST_HOME` (но это test-only переменная).

3. **MCP-серверы**: `mcp` из глобального конфига может запускать процессы. Override через `CONFIG_CONTENT` с `mcp: {}` должен помочь, но нужно подтвердить merge-стратегию.

4. **Permission overrides**: пользовательские `permission` правила из глобального конфига могут блокировать нужные инструменты. Возможно стоит также переопределять через `OPENCODE_PERMISSION` env var.

## Ссылки

- OpenCode source: https://github.com/anomalyco/opencode (branch `dev`)
- OpenCode TypeScript SDK (legacy, Stainless-generated): https://github.com/anomalyco/opencode-sdk-js
- OpenCode TypeScript SDK (текущий, монорепо): https://github.com/anomalyco/opencode/tree/dev/packages/sdk/js (`@opencode-ai/sdk` v1.2.x, используется prorab)
- Ключевые файлы:
  - `packages/opencode/src/flag/flag.ts` — все env-переменные
  - `packages/opencode/src/config/config.ts` — загрузка и мерж конфигов, `Config.state()`, `Config.global()`
  - `packages/opencode/src/config/paths.ts` — `directories()`, сканирование `.opencode/`
  - `packages/opencode/src/skill/skill.ts` — загрузка скиллов, `Skill.state()`
  - `packages/opencode/src/plugin/index.ts` — загрузка плагинов, `BUILTIN` список
  - `packages/opencode/src/session/instruction.ts` — загрузка `CLAUDE.md`, `AGENTS.md`
  - `packages/opencode/src/global/index.ts` — `Global.Path.config`, XDG-пути
- Текущий код prorab: `src/core/drivers/opencode.ts:195-198` — spawn `opencode serve`
- Аналог в Claude: `src/core/drivers/claude.ts:63-66` — `settingSources`
