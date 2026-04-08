import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { IterationResult, ModelEntry } from "../../types.js";
import type {
  AgentDriver,
  ChatEvent,
  ChatOptions,
  QuestionAnswers,
  SessionOptions,
  SetupOptions,
} from "./types.js";
import { ClaudeDriver } from "./claude.js";

/** Settings file shape for a CCS profile (~/.ccs/{profile}.settings.json). */
interface CcsSettings {
  env: Record<string, string>;
  hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>;
}

function commandHookToCallback(
  command: string,
  timeoutMs: number = 85000,
): (...args: unknown[]) => Promise<unknown> {
  return (...args: unknown[]) => {
    const input = args[0];
    const { signal } = (args[2] ?? {}) as { signal: AbortSignal };
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", command], { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";

      child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on("data", () => {}); // ignore stderr

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Hook command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const abortHandler = () => {
        child.kill("SIGKILL");
        clearTimeout(timer);
        reject(new Error("Hook aborted"));
      };
      if (signal) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      child.on("close", (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abortHandler);
        try {
          const result = stdout.trim() ? JSON.parse(stdout.trim()) : {};
          if (code === 2) {
            resolve({ ...result, decision: result.decision ?? "block" });
          } else {
            resolve({ continue: true, ...result });
          }
        } catch {
          resolve({ continue: true });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", abortHandler);
        reject(err);
      });

      child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
  };
}

/**
 * CcsDriver wraps ClaudeDriver via composition.
 *
 * It reads CCS profile settings from `~/.ccs/{profile}.settings.json`,
 * overrides `process.env` with the profile's env vars during `setup()`,
 * and restores them in `teardown()`.
 */
export class CcsDriver implements AgentDriver {
  private profile?: string;
  private useUserSettings: boolean;
  private applyHooks: boolean;
  private inner: ClaudeDriver | null = null;
  private profileSettings?: CcsSettings;
  private sdkHooks?: Record<string, Array<{ matcher?: string; hooks: Array<(...args: unknown[]) => Promise<unknown>> }>>;
  /** Per-session env vars passed to SDK query() — no global process.env mutation. */
  private sessionEnv?: Record<string, string>;

  constructor(profile?: string, useUserSettings: boolean = false, applyHooks: boolean = false) {
    this.profile = profile;
    this.useUserSettings = useUserSettings;
    this.applyHooks = applyHooks;
  }

  async setup(opts: SetupOptions): Promise<void> {
    if (!this.profile) {
      throw new Error("CCS agent requires a profile name");
    }

    // Read profile settings
    const settingsPath = join(homedir(), ".ccs", `${this.profile}.settings.json`);
    const raw = await readFile(settingsPath, "utf-8");
    const settings: CcsSettings = JSON.parse(raw);
    this.profileSettings = settings;

    // Create inner ClaudeDriver with the model from settings
    const model = settings.env.ANTHROPIC_MODEL;
    this.inner = new ClaudeDriver(model, this.useUserSettings);

    // Build per-session env from profile (no process.env mutation).
    // Map ANTHROPIC_AUTH_TOKEN → ANTHROPIC_API_KEY (SDK convention).
    // Start from a copy of current process.env so the SDK inherits PATH etc.
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const [key, value] of Object.entries(settings.env)) {
      const targetKey = key === "ANTHROPIC_AUTH_TOKEN" ? "ANTHROPIC_API_KEY" : key;
      env[targetKey] = value;
    }
    this.sessionEnv = env;

    // Build SDK hooks from profile command-based hooks
    if (this.applyHooks && this.profileSettings?.hooks) {
      this.sdkHooks = this.buildSdkHooks(this.profileSettings.hooks);
    }

    // Call inner driver's setup if it exists
    const innerAsDriver = this.inner as AgentDriver;
    if (innerAsDriver.setup) {
      await innerAsDriver.setup(opts);
    }
  }

  async teardown(): Promise<void> {
    // Call inner driver's teardown if it exists
    const innerAsDriver = this.inner as AgentDriver | null;
    if (innerAsDriver?.teardown) {
      await innerAsDriver.teardown();
    }

    // Clear state
    this.inner = null;
    this.sdkHooks = undefined;
    this.profileSettings = undefined;
    this.sessionEnv = undefined;
  }

  // ---------------------------------------------------------------------------
  // Delegation methods
  // ---------------------------------------------------------------------------

  runSession(opts: SessionOptions): Promise<IterationResult> {
    const driver = this.requireDriver();
    const overrides: Partial<SessionOptions> = {};
    if (this.sessionEnv) overrides.env = this.sessionEnv;
    if (this.sdkHooks) overrides.hooks = this.sdkHooks as SessionOptions["hooks"];
    return Object.keys(overrides).length > 0
      ? driver.runSession({ ...opts, ...overrides })
      : driver.runSession(opts);
  }

  startChat(opts: ChatOptions): AsyncIterable<ChatEvent> {
    const driver = this.requireDriver();
    const overrides: Partial<ChatOptions> = {};
    if (this.sessionEnv) overrides.env = this.sessionEnv;
    if (this.sdkHooks) overrides.hooks = this.sdkHooks as ChatOptions["hooks"];
    return Object.keys(overrides).length > 0
      ? driver.startChat({ ...opts, ...overrides })
      : driver.startChat(opts);
  }

  sendMessage(text: string): void {
    this.requireDriver().sendMessage(text);
  }

  replyQuestion(questionId: string, answers: QuestionAnswers): void {
    this.requireDriver().replyQuestion(questionId, answers);
  }

  abortChat(): void {
    this.requireDriver().abortChat();
  }

  // ---------------------------------------------------------------------------
  // listModels — works without a profile
  // ---------------------------------------------------------------------------

  async listModels(): Promise<ModelEntry[]> {
    const ccsDir = join(homedir(), ".ccs");
    let files: string[];

    try {
      files = (await readdir(ccsDir)) as string[];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }

    const settingsFiles = files.filter((f) => f.endsWith(".settings.json"));
    const models: ModelEntry[] = [];

    for (const file of settingsFiles) {
      try {
        const raw = await readFile(join(ccsDir, file), "utf-8");
        const settings: CcsSettings = JSON.parse(raw);
        const modelName = settings.env?.ANTHROPIC_MODEL;
        const baseUrl = settings.env?.ANTHROPIC_BASE_URL;

        // Filter out profiles without ANTHROPIC_BASE_URL (CLIProxy profiles)
        if (!baseUrl) continue;

        const profileName = file.replace(".settings.json", "");
        models.push({
          id: profileName,
          name: `${profileName} (${modelName ?? "unknown"})`,
          variants: ["low", "medium", "high", "max"],
        });
      } catch {
        // Skip malformed settings files
        continue;
      }
    }

    return models;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private buildSdkHooks(
    profileHooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> }>>,
  ): Record<string, Array<{ matcher?: string; hooks: Array<(...args: unknown[]) => Promise<unknown>> }>> {
    const sdkHooks: Record<string, Array<{ matcher?: string; hooks: Array<(...args: unknown[]) => Promise<unknown>> }>> = {};
    for (const [event, matchers] of Object.entries(profileHooks)) {
      sdkHooks[event] = matchers.map((m) => ({
        matcher: m.matcher,
        hooks: m.hooks
          .filter((h) => h.type === "command")
          .map((h) => commandHookToCallback(h.command, (h.timeout ?? 85) * 1000)),
      }));
    }
    return sdkHooks;
  }

  private requireDriver(): ClaudeDriver {
    if (!this.inner) {
      throw new Error("CCS driver not initialized. Call setup() first.");
    }
    return this.inner;
  }
}
