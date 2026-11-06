import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import "./meta.js";

const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\nedition = "2021"\n`,
  "src/main.rs": `mod sys { pub fn ignite() {} }
mod league {
    pub mod table {
        pub fn rank() -> u32 { 1 }
    }
}
use crate::league::table as t;
fn go() { sys::ignite(); t::rank(); }
fn main() { go(); }
`,
  // Two functions of one name in one file: each is named by its module, so the call names the one it means.
  "src/pair.rs": `mod sys { pub fn ignite() {} }
mod decoy { pub fn ignite() {} pub fn spark() { ignite(); } }
pub fn go() { sys::ignite(); }
`,
};

describe("Rust inline modules", () => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-inline-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    links = summary.symbolLinks.map((l) => `${l.sourceFile}:${l.sourceLine} ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links `sys::ignite()` to the function of the inline `mod sys`, also through a `use … as` rename", () => {
    expect(links).toContain("src/main.rs:8 ignite -> src/main.rs::ignite");
    expect(links).toContain("src/main.rs:8 rank -> src/main.rs::rank");
  });

  it("links a call to the right one of two same-named functions in two inline modules, and a bare call to its own module's", () => {
    expect(links).toContain("src/pair.rs:3 sys::ignite -> src/pair.rs::sys::ignite");
    expect(links).toContain("src/pair.rs:2 decoy::ignite -> src/pair.rs::decoy::ignite");
    expect(links.filter((l) => l.startsWith("src/pair.rs:3") && l.includes("decoy"))).toEqual([]);
  });
});
