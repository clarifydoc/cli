import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { ownerIndex, symbolAnswersTo } from "../../../core/owner-paths.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import "./meta.js";

const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\nedition = "2021"\n`,
  "src/util.rs": `pub fn helper() {}
pub mod pitch {
    pub fn helper() {}
    pub fn run() { helper(); }
    pub fn lower() {}
    pub mod inner { pub fn kick() {} }
    pub struct Car;
    impl Car { pub fn name(&self) {} }
}
pub fn plain() {}
#[cfg(test)]
mod tests {
    use super::*;
    fn helper() {}
    fn setup() { plain(); }
}
`,
  "src/main.rs": `mod util;
use crate::util::pitch::helper;
use crate::util::pitch::lower;
fn main() { helper(); util::pitch::run(); lower(); util::pitch::inner::kick(); util::plain(); }
`,
};

describe.each([["ANTLR", undefined], ["regex", "no-antlr"]])("Rust inline-module function ids (%s front end)", (_name, features) => {
  let dir: string;
  let links: string[];
  let complexity: string[];
  beforeAll(async () => {
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    dir = await mkdtemp(join(tmpdir(), "cd-rust-modids-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    links = summary.symbolLinks.map((l) => `${l.sourceFile}:${l.sourceLine} ${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol}`);
    complexity = (summary.complexity ?? []).flatMap((c) => c.functions.map((f) => `${c.filePath}::${f.functionName}`));
  }, 120_000);
  afterAll(async () => {
    delete process.env.CLARIFYDOC_FEATURES;
    await rm(dir, { recursive: true, force: true });
  });

  it("spells a function of an inline module by its module path, nested modules and `mod tests` included", () => {
    for (const id of ["util.rs::helper", "util.rs::pitch.helper", "util.rs::pitch.run", "util.rs::pitch.lower", "util.rs::pitch.inner.kick", "util.rs::plain", "util.rs::tests.helper", "util.rs::tests.setup"]) {
      expect(complexity, id).toContain(`src/${id}`);
    }
    // One spelling: a function the plugin named `pitch::helper` is never `pitch.pitch::helper`.
    expect(complexity.filter((c) => c.includes("::pitch::") || c.includes("pitch.pitch"))).toEqual([]);
    // An impl method keeps its type's id.
    expect(complexity).toContain("src/util.rs::Car.name");
  });

  it("changes no link, only the ids the links end at", () => {
    expect(links).toContain("src/main.rs:4 main -> src/util.rs::pitch.helper");
    expect(links).toContain("src/main.rs:4 main -> src/util.rs::pitch.run");
    expect(links).toContain("src/main.rs:4 main -> src/util.rs::pitch.lower");
    expect(links).toContain("src/main.rs:4 main -> src/util.rs::pitch.inner.kick");
    expect(links).toContain("src/main.rs:4 main -> src/util.rs::plain");
    expect(links).toContain("src/util.rs:4 pitch.run -> src/util.rs::pitch.helper");
    expect(links.filter((l) => l.startsWith("src/main.rs") && l.includes("::helper"))).toEqual([]);
  });
});

describe("owner index of inline modules", () => {
  const file = (over: Partial<FileAnalysis>): FileAnalysis => ({ filePath: "src/a.rs", language: "rust", classes: [], functions: [], complexities: [], ...over }) as FileAnalysis;
  it("answers by line for two namesakes and keeps a method with its type", () => {
    const a = file({
      inlineModules: [{ name: "pitch", path: "pitch", line: 2, endLine: 9 }, { name: "inner", path: "pitch::inner", line: 5, endLine: 7 }],
      functions: [
        { name: "run", line: 1, endLine: 1 }, { name: "pitch::run", line: 3, endLine: 3 }, { name: "pitch::inner::run", line: 6, endLine: 6 },
      ] as FileAnalysis["functions"],
    });
    const ix = ownerIndex(a);
    expect(ix.functionSymbol("run", 1)).toBe("run");
    expect(ix.functionSymbol("pitch::run", 3)).toBe("pitch.run");
    expect(ix.functionSymbol("pitch::inner::run", 6)).toBe("pitch.inner.run");
  });
  it("is found by its id, its bare name and the `::` label", () => {
    for (const want of ["pitch.run", "run", "pitch::run", "inner.kick", "pitch.inner.kick"]) expect(symbolAnswersTo(want.includes("kick") ? "pitch.inner.kick" : "pitch.run", want), want).toBe(true);
    expect(symbolAnswersTo("pitch.run", "stand.run")).toBe(false);
  });
});
