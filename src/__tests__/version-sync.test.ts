/**
 * The CLI version is declared twice: `package.json` (what npm publishes and
 * what the release tag is cut from) and a literal passed to commander in
 * `src/index.ts` (what `prorab --version` prints). Nothing links them, so a
 * release that bumps only one leaves the binary reporting a stale version.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

describe("version declarations stay in sync", () => {
  it("package.json and the commander .version() literal agree", () => {
    const pkgVersion = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf-8"),
    ).version as string;

    const cliSource = readFileSync(resolve(root, "src/index.ts"), "utf-8");
    const match = cliSource.match(/\.version\("([^"]+)"\)/);

    expect(match, "no .version(\"...\") call found in src/index.ts").not.toBeNull();
    expect(match![1]).toBe(pkgVersion);
  });
});
