import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { classOfType, exprType, stepType, yieldOf } from "./element-types.js";

describe("Rust container types", () => {
  const env = { fields: new Map([["League.clubs", "Vec<Club>"], ["League.shared", "Arc<Mutex<Club>>"]]), returns: new Map([["make", "Vec<Club>"]]) };
  it("reads the item of an iteration and the type of a std step", () => {
    expect(yieldOf("Vec<Club>")).toEqual({ kind: "one", item: "Club" });
    expect(yieldOf("HashMap<String, Club>")).toEqual({ kind: "pair", item: "Club" });
    expect(yieldOf("&[Club]")).toEqual({ kind: "one", item: "Club" });
    expect(stepType("Vec<Club>", "first")).toBe("Option<Club>");
    expect(stepType("Option<Club>", "unwrap")).toBe("Club");
    expect(stepType("Arc<Mutex<Club>>", "lock")).toBe("Result<Club>");
    expect(classOfType("Arc<Club>")).toBe("Club");
    expect(classOfType("Vec<Club>")).toBeNull();
    expect(classOfType("String")).toBeNull();
  });
  it("types an expression from fields, calls and steps", () => {
    const none = () => null;
    expect(exprType("self.clubs[0]", env, "League", none)).toBe("Club");
    expect(exprType("self.shared.lock().unwrap()", env, "League", none)).toBe("Club");
    expect(exprType("make().first().unwrap()", env, null, none)).toBe("Club");
    expect(exprType("self.clubs.iter().filter(|c| c.up)", env, "League", none)).toBe("Iter<Club>");
    expect(exprType("unknown.clubs", env, null, none)).toBeNull();
  });
});

const FILES: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "league"\nversion = "0.1.0"\n',
  "src/main.rs": `use std::collections::HashMap;
use std::sync::{Arc, Mutex};

struct Club { name: String }
impl Club { fn promote(&self) {} }
struct Player { name: String }
impl Player { fn promote(&self) {} }

struct League { clubs: Vec<Club>, by_name: HashMap<String, Club>, shared: Arc<Mutex<Club>> }

impl League {
    fn from_field(&self) {
        for c in &self.clubs { c.promote(); }
        for c in self.clubs.iter() { c.promote(); }
    }
    fn from_shared(&self) {
        self.shared.lock().unwrap().promote();
        let g = self.shared.lock().unwrap();
        g.promote();
    }
}
fn make() -> Vec<Club> { vec![] }
fn find() -> Option<Club> { None }
fn try_find() -> Result<Club, String> { Err(String::new()) }
fn loops(clubs: Vec<Club>) {
    for c in &clubs { c.promote(); }
    for c in clubs.iter() { c.promote(); }
    for c in clubs.iter_mut() { c.promote(); }
    for (i, c) in clubs.iter().enumerate() { c.promote(); }
}
fn loop_local() {
    let clubs: Vec<Club> = Vec::new();
    for c in &clubs { c.promote(); }
    let more = make();
    for c in more.iter() { c.promote(); }
}
fn closures(clubs: Vec<Club>) {
    clubs.iter().map(|c| c.promote());
    clubs.iter().for_each(|c| c.promote());
    clubs.iter().filter(|c| c.name.is_empty()).for_each(|c| c.promote());
    clubs.into_iter().for_each(|c| { c.promote(); });
}
fn narrowing(maybe_club: Option<Club>, x: Option<Club>) {
    if let Some(c) = maybe_club { c.promote(); }
    match x { Some(c) => c.promote(), None => {} }
}
fn whiles(mut it: Option<Club>) {
    while let Some(w) = it { w.promote(); it = None; }
}
fn access(clubs: Vec<Club>, map: HashMap<String, Club>) {
    clubs[0].promote();
    map.get("a").unwrap().promote();
    let c = find().unwrap();
    c.promote();
    let d = try_find().unwrap();
    d.promote();
    let e = try_find()?;
    e.promote();
}
trait Source { fn first(&self) -> Club { Club { name: String::new() } } }
fn use_src(s: &dyn Source) { s.first().promote(); }

fn mixed(a: Vec<Club>, b: Vec<Player>) {
    for z in &a { z.promote(); }
    for z in &b { z.promote(); }
}
fn decoy(players: Vec<Player>, by_id: HashMap<u32, Player>) {
    for p in &players { p.promote(); }
    for (k, v) in &by_id { v.promote(); }
    players.iter().for_each(|q| q.promote());
}
fn plain(names: Vec<String>) {
    for n in &names { n.promote(); }
}
`,
};

describe.each([["ANTLR", undefined], ["regex", "no-antlr"]])("Rust loop variables, closures and patterns (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-rs-elements-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const target = (from: string, callName: string) =>
    summary.symbolLinks
      .filter((l) => (l.sourceSymbol === from || l.sourceSymbol.endsWith(`.${from}`)) && l.callName === callName)
      .map((l) => l.targetSymbol);

  it("types a for loop over a parameter, a field, a typed local and a call's result", () => {
    for (const fn of ["loops", "loop_local", "from_field"]) expect(target(fn, "c.promote"), fn).toEqual(["Club.promote"]);
  });

  it("types the parameter of an iterator closure", () => {
    expect(target("closures", "c.promote")).toEqual(["Club.promote"]);
  });

  it("types the payload of if let, while let and match", () => {
    expect(target("narrowing", "c.promote")).toEqual(["Club.promote"]);
    expect(target("whiles", "w.promote")).toEqual(["Club.promote"]);
  });

  it("links an index, a map lookup and a lock guard", () => {
    expect(target("access", "clubs[].promote")).toEqual(["Club.promote"]);
    // The line scan names a chain one call deep; only the parser reads these two.
    if (!features) {
      expect(target("access", "map.get().unwrap().promote")).toEqual(["Club.promote"]);
      expect(target("from_shared", "shared.lock().unwrap().promote")).toEqual(["Club.promote"]);
    }
    expect(target("from_shared", "g.promote")).toEqual(["Club.promote"]);
  });

  it("keeps the namesake apart and leaves ambiguous bindings untyped", () => {
    expect(target("decoy", "p.promote")).toEqual(["Player.promote"]);
    expect(target("decoy", "v.promote")).toEqual(["Player.promote"]);
    expect(target("decoy", "q.promote")).toEqual(["Player.promote"]);
    expect(target("mixed", "z.promote")).toEqual([]);
    expect(target("plain", "n.promote")).toEqual([]);
  });
});
