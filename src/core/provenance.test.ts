import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { TOOL_VERSION } from "./version.js";
import { EXTRACTOR_VERSION } from "./manifest.js";
import { SCHEMA_VERSION } from "./element-registry.js";

/**
 * A summary described nothing about the run that produced it: not the
 * extractor version (that lived only in `manifest.json`, and only on
 * incremental runs), not whether a config was found, not whether git history
 * was available. Config validation warnings were computed and then printed to
 * a verbose console, which is exactly where nobody analyzing from an editor or
 * through MCP would see them.
 */
const REPO_ROOT = resolve(__dirname, "..", "..");

describe("TOOL_VERSION", () => {
  it("matches package.json, from src and from the bundle alike", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));
    expect(TOOL_VERSION).toBe(pkg.version);
  });
});

describe("every fixture records its provenance", () => {
  const summaries = globSync("test-output/**/project-summary.json", { cwd: REPO_ROOT });

  it("found fixtures", () => {
    expect(summaries.length).toBeGreaterThan(20);
  });

  it("stamps the versions that produced it", () => {
    for (const rel of summaries) {
      const p = JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf-8")).provenance;
      expect(p, rel).toBeDefined();
      expect(p.extractorVersion, rel).toBe(EXTRACTOR_VERSION);
      expect(p.schemaVersion, rel).toBe(SCHEMA_VERSION);
      expect(p.toolVersion, rel).toBe(TOOL_VERSION);
    }
  });

  it("reports the signals the fixture run deliberately lacks", () => {
    for (const rel of summaries) {
      const p = JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf-8")).provenance;
      // Fixtures run with --no-lsp --no-git-history: "disabled", not "skipped",
      // and certainly not silently absent.
      expect(p.signals.gitHistory, rel).toBe("disabled");
      expect(p.signals.lsp, rel).toBe("absent");
    }
  });

  it("reports no parse fallbacks, which is the expected state", () => {
    for (const rel of summaries) {
      const p = JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf-8")).provenance;
      expect(p.parseFallbacks, rel).toBeUndefined();
    }
  });

  it("carries a config only where the fixture ships one, and no warnings", () => {
    // sample-config-patterns ships .clarifydoc/config.json (its `extract` section is what it tests).
    for (const rel of summaries) {
      const p = JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf-8")).provenance;
      expect(p.config.present, rel).toBe(rel.includes("sample-config-patterns"));
      expect(p.config.warnings, rel).toEqual([]);
    }
  });
});
