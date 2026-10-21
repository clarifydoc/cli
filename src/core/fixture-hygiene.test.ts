import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { STABLE_TIMESTAMP } from "./analyzer.js";

/**
 * Committed fixtures must not depend on the machine that produced them.
 *
 * Before `--stable-output`, every regeneration rewrote `analyzedAt` and an
 * absolute `projectRoot` in every summary and payload. A fixture diff could
 * therefore never be read as an extraction diff, two developers' regenerations
 * never agreed, and a "regenerate, the diff must be empty" CI gate was
 * impossible. The tree also carried developer paths: 84 files naming a home
 * directory and 16 still naming a Windows drive.
 */
const REPO_ROOT = resolve(__dirname, "..", "..");

// lsp-*.json come from Docker runs that the fixture script does not perform,
// so they are not regenerated and are excluded from the gate.
const SUMMARIES = globSync("test-output/**/project-summary.json", { cwd: REPO_ROOT });
const ALL_JSON = globSync(["test-output/**/*.json"], {
  cwd: REPO_ROOT,
  ignore: ["**/lsp-*.json"],
});

describe("committed fixtures are machine-independent", () => {
  it("found fixtures to check", () => {
    expect(SUMMARIES.length).toBeGreaterThan(20);
  });

  it("records the sentinel timestamp, not the moment of regeneration", () => {
    const offenders = SUMMARIES.filter((rel) => {
      const summary = JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf-8"));
      return summary.analyzedAt !== STABLE_TIMESTAMP;
    });
    expect(offenders).toEqual([]);
  });

  it("records a relative project root", () => {
    const offenders = SUMMARIES.filter((rel) => {
      const root = JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf-8")).projectRoot ?? "";
      return root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root);
    });
    expect(offenders).toEqual([]);
  });

  it("leaks no absolute path from the machine that generated it", () => {
    // Deliberately NOT a bare "/Users/" search: a fixture may legitimately
    // declare an ASP.NET route such as `/Users/{id}`, which is part of the analyzed
    // application, not a developer's home directory. The leaks that matter are
    // this checkout's own root and a Windows drive root.
    const offenders: string[] = [];
    for (const rel of ALL_JSON) {
      const text = readFileSync(resolve(REPO_ROOT, rel), "utf-8");
      if (text.includes(REPO_ROOT) || /"[A-Za-z]:\\\\/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
