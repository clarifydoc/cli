import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractRustImports } from "./imports.js";

describe("#[path] modules", () => {
  it("reads the attribute above or on the line of `mod x;` as an import of that file", () => {
    const imports = (lines: string[]) => extractRustImports(lines).map((i) => `${i.source} ${i.specifiers.join(",")}`);
    expect(imports(['#[path = "export.rs"]', "mod export_;"])).toEqual(["./export.rs export_"]);
    expect(imports(['#[path = "gen/parts.rs"] pub mod parts;'])).toEqual(["./gen/parts.rs parts"]);
    expect(imports(['#[cfg(test)]', '#[path = "../shared/helpers.rs"]', "mod helpers;"])).toEqual(["../shared/helpers.rs helpers"]);
    expect(imports(["mod plain;"])).toEqual(["self plain"]);
  });

  const FILES: Record<string, string> = {
    "Cargo.toml": '[package]\nname = "garage"\nversion = "0.1.0"\n',
    "src/main.rs": '#[path = "export.rs"]\nmod export_;\n\nfn run() {\n    export_::tune();\n}\n',
    "src/export.rs": "pub fn tune() { polish(); }\nfn polish() {}\n",
    "src/other.rs": "pub fn tune() {}\n",
  };
  let dir = "";
  let links: string[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-pathattr-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    links = summary.symbolLinks.filter((l) => l.strategy !== "reference").map((l) => `${l.sourceFile} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
  }, 120_000);
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it("links a call through the module to the file the attribute names, never a namesake", () => {
    expect(links).toContain("src/main.rs export_::tune -> src/export.rs::tune");
    expect(links.filter((l) => l.includes("src/other.rs"))).toEqual([]);
  });
});
