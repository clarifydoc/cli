import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { readFileSync } from "fs";
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
  // A bare call finds the block's own item before the file's namesake.
  "src/main_block.rs": `mod util;
mod pitch {
    fn helper() {}
    pub fn run() { helper(); }
    pub fn other() { self::helper(); }
    pub mod stand { pub fn helper() {} pub fn seat() { helper(); super::helper(); } }
}
fn helper() {}
fn render() {}
pub fn main() {
    crate::util::render();
    pitch::helper();
    pitch::run();
    pitch::stand::helper();
    helper();
    render();
}
`,
  "src/util.rs": "pub fn render() {}\n",
  // A module path into the project reaches a function whose name is a stdlib noise name (`format`, `write`); the
  // std macro and a std path stay unlinked.
  "src/noise.rs": `mod fmt_util;
mod pitch { pub fn write() {} }
pub fn main() {
    fmt_util::format();
    crate::fmt_util::format();
    pitch::write();
    let s = format!("{}", 1);
    let t = std::fmt::format(format_args!("x"));
}
`,
  "src/fmt_util.rs": "pub fn format() {}\n",
  // A `use` of the standard library or another crate binds a head that is no project module.
  "src/disk.rs": `use std::fs;
use std::io::{self, Write};
pub fn save() {
    fs::write("a", "b");
    io::write(1);
    std::fs::write("a", "b");
}
`,
  // `use` of an item of an inline module of another file, beside a file-level namesake and another module's.
  "src/stadium.rs": `pub mod pitch {
    pub fn mow() {}
    pub fn line() {}
}
pub fn mow() {}
pub mod stand {
    pub fn mow() {}
}
`,
  "src/crew.rs": `use crate::stadium::pitch::mow;
use crate::stadium::stand::mow as sweep;
use crate::stadium::mow as plain;
pub fn work() { mow(); sweep(); plain(); }
`,
  "src/crew_grouped.rs": `use crate::stadium::pitch::{mow as cut, line};
pub fn work() { cut(); line(); }
`,
  "src/crew_glob.rs": `use crate::stadium::pitch::*;
pub fn work() { mow(); }
`,
  // A test module nested in an inline module (real-repo FP): `use super::*` brings the enclosing module's items, and
  // `use self::kit::*` a nested one's; the file's namesake is no item of either.
  "src/pitch_tests.rs": `pub fn rank(points: i32) -> i32 { points * 3 }
pub fn sample() -> i32 { 9 }
pub mod pitch {
    pub fn rank(points: i32) -> i32 { points }
    #[cfg(test)]
    mod tests {
        use super::*;
        use self::kit::*;
        mod kit { pub fn sample() -> i32 { 7 } }
        fn ranks() { rank(4); sample(); }
    }
}
`,
  "src/pair.rs": `mod sys { pub fn ignite() {} }
mod decoy { pub fn ignite() {} pub fn spark() { ignite(); } }
pub fn go() { sys::ignite(); }
`,
};

describe.each([["ANTLR", undefined], ["regex", "no-antlr"]])("Rust inline modules (%s front end)", (_name, features) => {
  let dir: string;
  let links: string[];
  beforeAll(async () => {
    if (features) process.env.CLARIFYDOC_FEATURES = features;
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
    delete process.env.CLARIFYDOC_FEATURES;
    await rm(dir, { recursive: true, force: true });
  });

  it("links `sys::ignite()` to the function of the inline `mod sys`, also through a `use … as` rename", () => {
    expect(links).toContain("src/main.rs:8 ignite -> src/main.rs::sys.ignite");
    expect(links).toContain("src/main.rs:8 rank -> src/main.rs::league.table.rank");
  });

  it("links a call to the right one of two same-named functions in two inline modules, and a bare call to its own module's", () => {
    expect(links).toContain("src/pair.rs:3 sys::ignite -> src/pair.rs::sys.ignite");
    expect(links).toContain("src/pair.rs:2 decoy::ignite -> src/pair.rs::decoy.ignite");
    expect(links.filter((l) => l.startsWith("src/pair.rs:3") && l.includes("decoy"))).toEqual([]);
  });

  it("links path and bare calls to the block's own items, never the parent module's namesake", () => {
    const m = "src/main_block.rs";
    expect(links).toContain(`${m}:4 pitch::helper -> ${m}::pitch.helper`);
    expect(links).toContain(`${m}:5 pitch::helper -> ${m}::pitch.helper`);
    expect(links).toContain(`${m}:12 pitch::helper -> ${m}::pitch.helper`);
    expect(links).toContain(`${m}:13 run -> ${m}::pitch.run`);
    expect(links).toContain(`${m}:14 pitch::stand::helper -> ${m}::pitch.stand.helper`);
    expect(links).toContain(`${m}:6 pitch::stand::helper -> ${m}::pitch.stand.helper`);
    expect(links).toContain(`${m}:6 pitch::helper -> ${m}::pitch.helper`);
    // The file's own `helper` is called only by the bare call in `main`.
    expect(links.filter((l) => l.endsWith(`${m}::helper`))).toEqual([`${m}:15 helper -> ${m}::helper`]);
    expect(links).toContain(`${m}:11 crate::util::render -> src/util.rs::render`);
    expect(links).toContain(`${m}:16 render -> ${m}::render`);
  });

  it("links a path call into a project module whose function has a noise name, never the std macro or path", () => {
    const n = "src/noise.rs";
    expect(links).toContain(`${n}:5 crate::fmt_util::format -> src/fmt_util.rs::format`);
    expect(links).toContain(`${n}:6 write -> ${n}::pitch.write`);
    expect(links.filter((l) => l.startsWith(`${n}:7`) || l.startsWith(`${n}:8`))).toEqual([]);
  });

  it("links a function imported by name from an inline module of another file to that module's, not the file's namesake", () => {
    expect(links).toContain("src/crew.rs:4 mow -> src/stadium.rs::pitch.mow");
    expect(links).toContain("src/crew.rs:4 sweep -> src/stadium.rs::stand.mow");
    expect(links).toContain("src/crew.rs:4 plain -> src/stadium.rs::mow");
    expect(links).toContain("src/crew_grouped.rs:2 cut -> src/stadium.rs::pitch.mow");
    expect(links.filter((l) => l.startsWith("src/crew.rs:4") && /(?:::|\.)mow$/.test(l))).toHaveLength(3);
  });

  it("links a bare call through a glob import of an inline module to that module's function", () => {
    expect(links).toContain("src/crew_glob.rs:2 mow -> src/stadium.rs::pitch.mow");
    expect(links.filter((l) => l.startsWith("src/crew_glob.rs"))).toHaveLength(1);
  });

  it("links a bare call in a nested test module through its `use super::*` and `use self::x::*`, never the file's namesake", () => {
    const f = "src/pitch_tests.rs";
    expect(links).toContain(`${f}:10 pitch::rank -> ${f}::pitch.rank`);
    expect(links).toContain(`${f}:10 pitch::tests::kit::sample -> ${f}::pitch.tests.kit.sample`);
    expect(links.filter((l) => l.startsWith(`${f}:10`) && (l.endsWith(`${f}::rank`) || l.endsWith(`${f}::sample`)))).toEqual([]);
  });

  it("keeps no row for a noise-named call through a head `use` binds from std", () => {
    const calls = JSON.parse(readFileSync(join(dir, "out", "src", "disk.rs.json"), "utf8")).functions.flatMap((f: { calls: Array<{ name: string }> }) => f.calls.map((c) => c.name));
    expect(calls).toEqual([]);
  });
});
