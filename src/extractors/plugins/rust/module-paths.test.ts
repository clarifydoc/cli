import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { extractRustImports } from "./imports.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import "./meta.js";

const CLUB = `pub struct Club { pub name: String }
impl Club { pub fn new() -> Club { Club { name: String::new() } } pub fn save(&self) { persist(); } }
fn persist() {}
pub fn load() -> Club { Club::new() }
`;

const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\nedition = "2021"\n`,
  "src/main.rs": `mod club;
mod garage;
mod util;
mod a;
mod b;
mod tools;

fn main() {
    let c = club::Club::new();
    c.save();
    tools::wrench();
    crate::garage::tools::spanner();
    util::fmt::score();
    crate::a::load();
    b::load();
}
`,
  "src/club.rs": CLUB,
  "src/tools.rs": "pub fn wrench() {}\n",
  "src/garage/mod.rs": "pub mod tools;\npub fn open() {}\n",
  "src/garage/tools.rs": "pub fn spanner() {}\npub fn wrench() {}\n",
  "src/util/mod.rs": "pub mod fmt;\n",
  "src/util/fmt/mod.rs": "pub fn score() {}\n",
  "src/a/mod.rs": "pub mod inner;\npub fn load() {}\n",
  "src/a/inner.rs": "pub fn load() { super::super::club::load(); }\npub fn other() { super::load(); }\n",
  "src/b/mod.rs": "pub fn load() {}\n",
  "src/garage/bay.rs": `pub fn open_bay() -> u8 { 1 }

#[cfg(test)]
mod tests {
    #[test]
    fn opens() {
        assert_eq!(super::open_bay(), 1);
    }
}
`,
};

describe("Rust module paths, `mod` declarations and one-line impls", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-paths-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
    links = summary.symbolLinks.filter((l) => l.strategy !== "reference").map((l) => `${l.sourceFile}:${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("follows a call through a module path to the module it names, each path its own call", () => {
    expect(links).toEqual(expect.arrayContaining([
      "src/main.rs:11 tools::wrench -> src/tools.rs::wrench",
      "src/main.rs:12 crate::garage::tools::spanner -> src/garage/tools.rs::spanner",
      "src/main.rs:13 util::fmt::score -> src/util/fmt/mod.rs::score",
      "src/main.rs:14 crate::a::load -> src/a/mod.rs::load",
      "src/main.rs:15 b::load -> src/b/mod.rs::load",
      "src/a/inner.rs:1 super::super::club::load -> src/club.rs::load",
      "src/a/inner.rs:2 super::load -> src/a/mod.rs::load",
      // `super` in an inline `mod tests` is the file's own module.
      "src/garage/bay.rs:7 super::open_bay -> src/garage/bay.rs::open_bay",
    ]));
    expect(links.filter((l) => l.startsWith("src/a/inner.rs") && l.endsWith("src/a/inner.rs::load"))).toEqual([]);
  });

  it("makes each method of a one-line impl a method of its type, with its own return type", () => {
    expect(links).toContain("src/main.rs:10 c.save -> src/club.rs::Club.save");
    const regex = extractWithRegex(CLUB, "src/club.rs", "rust");
    const methods = regex.classes.find((c) => c.name === "Club")?.methods.map((m) => `${m.name}: ${m.returnType}`);
    expect(methods).toEqual(["new: Club", "save: null"]);
    expect(regex.functions.map((f) => f.name)).toEqual(["persist", "load"]);
  });

  it("reads `mod x;` as an import of the child module, an edge in the dependency graph", () => {
    expect(extractRustImports(["mod club;", "pub mod garage;", "mod tests {", "}"]).map((i) => `${i.source} ${i.specifiers.join(",")}`))
      .toEqual(["self club", "self garage"]);
    const main = summary.files.indexOf("src/main.rs");
    const edges = (summary.componentGraph[main] ?? (summary.componentGraph as Record<string, unknown>)["src/main.rs"]) as unknown[];
    const named = (edges ?? []).map((e) => (typeof e === "number" ? summary.files[e] : e));
    expect(named).toEqual(expect.arrayContaining(["src/club.rs", "src/tools.rs", "src/garage/mod.rs", "src/a/mod.rs", "src/b/mod.rs", "src/util/mod.rs"]));
  });
});
