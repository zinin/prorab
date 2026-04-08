import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { acquireLock, releaseLock, LOCK_FILENAME, ensureLockInGitignore } from "../core/lock.js";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "prorab-lock-test-"));
  mkdirSync(join(dir, ".taskmaster"), { recursive: true });
  return dir;
}

describe("acquireLock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempRepo();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates lock file with current PID", () => {
    acquireLock(tempDir);
    const lockPath = join(tempDir, ".taskmaster", LOCK_FILENAME);
    expect(existsSync(lockPath)).toBe(true);
    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(data.pid).toBe(process.pid);
    expect(data.startedAt).toBeDefined();
  });

  it("throws when lock held by live process (self)", () => {
    acquireLock(tempDir);
    expect(() => acquireLock(tempDir)).toThrow(/already running/);
  });

  it("removes stale lock from dead process and acquires", () => {
    const lockPath = join(tempDir, ".taskmaster", LOCK_FILENAME);
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, startedAt: "2020-01-01T00:00:00.000Z" }));
    acquireLock(tempDir);
    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(data.pid).toBe(process.pid);
  });

  it("replaces corrupt lock file", () => {
    const lockPath = join(tempDir, ".taskmaster", LOCK_FILENAME);
    writeFileSync(lockPath, "not valid json{{{");
    acquireLock(tempDir);
    const data = JSON.parse(readFileSync(lockPath, "utf-8"));
    expect(data.pid).toBe(process.pid);
  });
});

describe("ensureLockInGitignore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempRepo();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates .gitignore with lock pattern when file does not exist", () => {
    ensureLockInGitignore(tempDir);
    const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(content).toContain(`.taskmaster/${LOCK_FILENAME}`);
  });

  it("appends lock pattern to existing .gitignore", () => {
    writeFileSync(join(tempDir, ".gitignore"), "node_modules/\n");
    ensureLockInGitignore(tempDir);
    const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(content).toContain("node_modules/");
    expect(content).toContain(`.taskmaster/${LOCK_FILENAME}`);
  });

  it("does not duplicate pattern if already present", () => {
    const pattern = `.taskmaster/${LOCK_FILENAME}`;
    writeFileSync(join(tempDir, ".gitignore"), `${pattern}\n`);
    ensureLockInGitignore(tempDir);
    const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    const occurrences = content.split(pattern).length - 1;
    expect(occurrences).toBe(1);
  });

  it("handles .gitignore without trailing newline", () => {
    writeFileSync(join(tempDir, ".gitignore"), "node_modules/");
    ensureLockInGitignore(tempDir);
    const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(content).toBe(`node_modules/\n.taskmaster/${LOCK_FILENAME}\n`);
  });

  it("is called automatically by acquireLock", () => {
    acquireLock(tempDir);
    const content = readFileSync(join(tempDir, ".gitignore"), "utf-8");
    expect(content).toContain(`.taskmaster/${LOCK_FILENAME}`);
  });
});

describe("releaseLock", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempRepo();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes lock file", () => {
    acquireLock(tempDir);
    const lockPath = join(tempDir, ".taskmaster", LOCK_FILENAME);
    expect(existsSync(lockPath)).toBe(true);
    releaseLock(tempDir);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("no-ops when lock file missing", () => {
    expect(() => releaseLock(tempDir)).not.toThrow();
  });

  it("does not remove lock owned by different PID", () => {
    const lockFile = join(tempDir, ".taskmaster", LOCK_FILENAME);
    writeFileSync(lockFile, JSON.stringify({ pid: 99999999, startedAt: "2020-01-01T00:00:00.000Z" }));
    releaseLock(tempDir);
    expect(existsSync(lockFile)).toBe(true);
  });

  it("removes corrupt lock file", () => {
    const lockFile = join(tempDir, ".taskmaster", LOCK_FILENAME);
    writeFileSync(lockFile, "garbage content");
    releaseLock(tempDir);
    expect(existsSync(lockFile)).toBe(false);
  });
});
