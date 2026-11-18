import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { discoverFiles } from "./file-discovery.js";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { resolveImportSource } from "./import-index.js";

/**
 * Shell rc files claimed by basename (`.bashrc`, …): discovery admits them
 * path-scoped, `source ./.bashrc` resolves, and a same-shaped decoy does not.
 * Labelled against `test-fixtures/sample-shell-scripts` plus a temp tree.
 */
describe("discoverFiles — shell rc namedFiles", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clarifydoc-shell-rc-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  };

  it("admits .bashrc / .zshrc / .profile / .bash_profile as bash, never a decoy dotfile", async () => {
    write(".bashrc", "log_arsenal() { :; }\n");
    write(".zshrc", "log_villa() { :; }\n");
    write(".profile", "log_porsche() { :; }\n");
    write(".bash_profile", "log_ferrari() { :; }\n");
    write(".hidden_decoy", "log_decoy() { :; }\n");
    write(".secret.sh", "echo no\n");
    write("scripts/load.sh", "#!/bin/bash\nsource ./.bashrc\n");
    const r = await discoverFiles(root);
    const lang = Object.fromEntries(r.files.map((f) => [f.relativePath, f.language]));
    expect(lang[".bashrc"]).toBe("bash");
    expect(lang[".zshrc"]).toBe("bash");
    expect(lang[".profile"]).toBe("bash");
    expect(lang[".bash_profile"]).toBe("bash");
    expect(lang["scripts/load.sh"]).toBe("bash");
    expect(lang[".hidden_decoy"]).toBeUndefined();
    expect(lang[".secret.sh"]).toBeUndefined();
  });
});

describe("resolveImportSource — leading-dot named files", () => {
  it("resolves .bashrc as written before the relative-module rewrite", () => {
    const known = new Set([".bashrc", ".zshrc", ".profile", ".bash_profile", "scripts/load.sh"]);
    expect(resolveImportSource("scripts/load.sh", ".bashrc", known)).toBe(".bashrc");
    expect(resolveImportSource("scripts/load.sh", ".hidden_decoy", known)).toBeNull();
  });
});

describe("sample-shell-scripts — source ./.bashrc", () => {
  const fixture = resolve("test-fixtures/sample-shell-scripts");
  let out: string;
  beforeAll(async () => {
    out = mkdtempSync(join(tmpdir(), "clarifydoc-shell-scripts-"));
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  }, 60_000);
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("analyzes the four rc files, refuses the decoy, and links log_arsenal through source", async () => {
    const summary = await loadReportSummary(out);
    const files = (summary.files ?? []) as string[];
    expect(files).toEqual(expect.arrayContaining([".bashrc", ".zshrc", ".profile", ".bash_profile", "scripts/deploy.sh"]));
    expect(files).not.toContain(".hidden_decoy");
    const hits = (summary.symbolLinks ?? []).filter(
      (l) => l.callName === "log_arsenal" && l.sourceFile === "scripts/deploy.sh" && l.targetFile === ".bashrc",
    );
    expect(hits.map((l) => l.strategy)).toContain("import-file");
  });
});
