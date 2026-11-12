/**
 * Rust function values followed through locals, parameters, struct fields, returns, vectors and tuples to the call
 * that runs them (`value-flow` links), through the real per-file pipeline and the linker.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "rust-vf-"));
  const out = await mkdtemp(join(tmpdir(), "rust-vf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "rust" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

function valueFlowLinks(analyses: FileAnalysis[]): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol}: ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

const league = `pub struct Club {
    on_save: Option<Box<dyn Fn(&str)>>,
    handlers: Vec<Box<dyn Fn(&str)>>,
}

fn save(n: &str) {}
fn release(n: &str) {}

fn wrap(f: fn(&str)) {
    f("x");
}

fn local() {
    let h = save;
    let g = h;
    wrap(g);
}

impl Club {
    pub fn new() -> Self {
        Self { on_save: Some(Box::new(save)), handlers: Vec::new() }
    }
    pub fn fire(&self) {
        if let Some(cb) = &self.on_save {
            cb("a");
        }
    }
    pub fn add(&mut self) {
        self.handlers.push(Box::new(release));
    }
    pub fn fire_all(&self) {
        for h in &self.handlers {
            h("c");
        }
    }
    pub fn kick(n: &str) {}
    pub fn bind() {
        let k = Self::kick;
        k("q");
    }
}

fn build_handler() -> impl Fn(&str) {
    save
}
fn via_factory() {
    let h = build_handler();
    h("z");
}

fn table() {
    let hs: Vec<fn(&str)> = vec![save, release];
    for f in hs.iter() {
        f("y");
    }
    let (a, b) = (save, release);
    a("1");
    b("2");
}
`;

const decoy = `fn f(s: &str) {}
fn g(s: &str) {}
fn cb(s: &str) {}
fn h(s: &str) {}
fn k(s: &str) {}
fn a(s: &str) {}
fn b(s: &str) {}
fn on_save(s: &str) {}
`;

describe("Rust function values", () => {
  it("follows a function through locals, wrappers, fields, constructors, factories, vectors and tuples", async () => {
    const analyses = await analyzeAll({ "src/league.rs": league, "src/garage.rs": decoy });
    expect(valueFlowLinks(analyses)).toEqual([
      "Club.bind: k -> src/league.rs::Club.kick",
      "Club.fire: cb -> src/league.rs::save",
      "Club.fire_all: h -> src/league.rs::release",
      "table: a -> src/league.rs::save",
      "table: b -> src/league.rs::release",
      "table: f -> src/league.rs::release",
      "table: f -> src/league.rs::save",
      "via_factory: h -> src/league.rs::save",
      "wrap: f -> src/league.rs::save",
    ]);
  });

  it("a local named like a function, bound from a call of it, still calls the function", async () => {
    const analyses = await analyzeAll({
      "src/repo.rs": "fn pool() -> i32 { 1 }\n\nfn list() -> i32 {\n    let pool = pool();\n    pool\n}\n",
    });
    expect(valueFlowLinks(analyses)).toEqual([]);
    const plain = buildSymbolLinks(analyses).filter((l) => l.sourceSymbol === "list");
    expect(plain.map((l) => `${l.callName} -> ${l.targetSymbol} [${l.strategy}]`)).toEqual(["pool -> pool [direct]"]);
  });

  it("a static holding a function, set in one module and run in another (through the crate's own imports)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rust-vf-static-"));
    const files: Record<string, string> = {
      "Cargo.toml": '[package]\nname = "league"\nversion = "0.1.0"\n',
      "src/lib.rs": "pub mod hooks;\npub mod boot;\n",
      "src/hooks.rs": 'use std::sync::OnceLock;\n\npub static ON_KICK: OnceLock<fn(&str)> = OnceLock::new();\n\npub fn fire_kick() {\n    if let Some(f) = ON_KICK.get() {\n        f("k");\n    }\n}\n',
      "src/boot.rs": "use crate::hooks::ON_KICK;\n\nfn kick(n: &str) {}\nfn other(n: &str) {}\n\npub fn boot() {\n    ON_KICK.set(kick).unwrap();\n}\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    const summary = await loadReportSummary(join(dir, "out"));
    const links = summary.symbolLinks.filter((l) => l.strategy === "value-flow").map((l) => `${l.sourceSymbol}: ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`);
    expect(links).toEqual(["fire_kick: f -> src/boot.rs::kick"]);
    await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it("only a function taking no self builds the receiver's callbacks; a blanket impl's type is no type", async () => {
    const analyses = await analyzeAll({
      "src/club.rs": `pub struct Club {
    cb: fn(&str),
}

fn save(n: &str) {}
fn release(n: &str) {}

impl Club {
    pub fn new() -> Self {
        Self { cb: save }
    }
    pub fn rebuilt(&self) -> Self {
        Self { cb: release }
    }
    pub fn fire(&self) {
        (self.cb)("x");
    }
}

pub trait Fire {
    fn go(&self);
}
impl<T: Clone> Fire for T {
    fn go(&self) {
        let _t = T { cb: release };
    }
}
`,
    });
    expect(valueFlowLinks(analyses)).toEqual(["Club.fire: self.cb -> src/club.rs::save"]);
  });

  it("never links a held value to a same-named function elsewhere", async () => {
    const analyses = await analyzeAll({ "src/league.rs": league, "src/garage.rs": decoy });
    const links = buildSymbolLinks(analyses).filter((l) => l.targetFile === "src/garage.rs" && l.sourceFile === "src/league.rs");
    expect(links).toEqual([]);
  });
});
