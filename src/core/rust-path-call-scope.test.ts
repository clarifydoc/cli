import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Rust path call (`Garage::park()`) names its type only through what is in scope: a `use` (named, aliased,
 * glob, a module re-exporting it), the module path written before it, `Self`, or the type's own file. A
 * `Garage` declared in a sibling file that nothing in the caller reaches is a namesake, never the callee —
 * and the link made is the class-name one, not an injected receiver's.
 */
const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\n`,
  "src/main.rs": `mod garage;\nmod pre;\nmod bare;\nmod used;\nmod full;\nmod glob;\nmod alias;\nmod module;\nmod barrel;\nmod local;\nmod nest;\nmod league;\nmod bench;\nfn main() {}\n`,
  "src/garage.rs": `pub struct Garage;\n\nimpl Garage {\n    pub fn park() {}\n    pub fn new() -> Garage {\n        Garage\n    }\n}\n`,
  "src/pre.rs": `pub use crate::garage::Garage;\n`,
  "src/bare.rs": `pub fn nothing_in_scope() {\n    Garage::park();\n    let g = Garage::new();\n}\n`,
  "src/used.rs": `use crate::garage::Garage;\n\npub fn named() {\n    Garage::park();\n    let g = Garage::new();\n}\n`,
  "src/full.rs": `pub fn written_in_full() {\n    crate::garage::Garage::park();\n}\n`,
  "src/glob.rs": `use crate::garage::*;\n\npub fn through_glob() {\n    Garage::park();\n}\n`,
  "src/alias.rs": `use crate::garage::Garage as Bay;\n\npub fn through_alias() {\n    Bay::park();\n}\n`,
  "src/module.rs": `use crate::garage;\n\npub fn through_module() {\n    garage::Garage::park();\n}\n`,
  "src/barrel.rs": `use crate::pre::*;\n\npub fn through_barrel() {\n    Garage::park();\n}\n`,
  "src/nest/mod.rs": `use super::garage::Garage;\n\npub fn through_super() {\n    Garage::park();\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn inline_glob() {\n        Garage::new();\n    }\n}\n`,
  "src/league.rs": `#[path = "league/squad.rs"]\npub mod squad;\n#[path = "league/staff.rs"]\npub mod staff;\npub type Roster = squad::Squad;\npub type Squad = squad::Squad;\npub type Team = crate::league::squad::Squad;\npub struct Coach;\n`,
  "src/league/staff.rs": `pub struct Physio;\n`,
  "src/league/squad.rs": `pub struct Squad;\n\nimpl Squad {\n    pub fn sign() {}\n}\n`,
  "src/bench.rs": `use crate::{\n    league,\n    league::Coach,\n};\n\npub fn by_alias_name() {\n    league::Squad::sign();\n}\n\npub fn by_other_name() {\n    league::Roster::sign();\n}\n\npub fn by_full_path_alias() {\n    league::Team::sign();\n}\n\npub fn unknown_name() {\n    league::Reserve::sign();\n}\n`,
  "src/local.rs": `pub struct Garage;\n\nimpl Garage {\n    pub fn park() {}\n\n    pub fn twice() {\n        Self::park();\n        Garage::park();\n    }\n}\n`,
};

describe.each([
  ["ANTLR", undefined],
  ["regex", "no-antlr"],
] as const)("Rust path calls bind through scope (%s front end)", (_name, feature) => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-path-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    const previous = process.env.CLARIFYDOC_FEATURES;
    if (feature) process.env.CLARIFYDOC_FEATURES = feature;
    try {
      await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    } finally {
      if (previous === undefined) delete process.env.CLARIFYDOC_FEATURES;
      else process.env.CLARIFYDOC_FEATURES = previous;
    }
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName === callName);
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.strategy}` : null;
  };

  it("leaves a call unlinked when nothing in scope names the type", () => {
    expect(linkOf("nothing_in_scope", "Garage.park")).toBeNull();
    expect(linkOf("nothing_in_scope", "Garage.new")).toBeNull();
    expect(summary.symbolLinks.filter((l) => l.sourceFile === "src/bare.rs")).toEqual([]);
  });

  it("links through a use, a glob, an alias, a module and a re-exporting module, labelled class-name", () => {
    expect(linkOf("named", "Garage.park")).toBe("src/garage.rs Garage.park class-name");
    expect(linkOf("named", "Garage.new")).toBe("src/garage.rs Garage.new class-name");
    expect(linkOf("through_glob", "Garage.park")).toBe("src/garage.rs Garage.park class-name");
    expect(linkOf("through_alias", "Bay.park")).toBe("src/garage.rs Garage.park class-name");
    expect(linkOf("through_module", "Garage.park")).toBe("src/garage.rs Garage.park class-name");
    expect(linkOf("through_barrel", "Garage.park")).toBe("src/garage.rs Garage.park class-name");
  });

  it("links through `use super::` and an inline module's `use super::*`", () => {
    expect(linkOf("through_super", "Garage.park")).toBe("src/garage.rs Garage.park class-name");
    expect(linkOf("inline_glob", "Garage.new")).toMatch(/^src\/garage\.rs Garage\.new /);
  });

  it("links a type written with its module path, and the type of the same file", () => {
    expect(linkOf("written_in_full", "Garage.park")).toBe("src/garage.rs Garage.park class-name");
    expect(linkOf("Garage.twice", "Garage.park")).toMatch(/^src\/local\.rs Garage\.park /);
    expect(linkOf("Garage.twice", "Self.park")).toMatch(/^src\/local\.rs Garage\.park /);
  });

  it("takes a type alias of a module as passing the type on, whatever its name", () => {
    expect(linkOf("by_alias_name", "Squad.sign")).toBe("src/league/squad.rs Squad.sign class-name");
    expect(linkOf("by_other_name", "Roster.sign")).toBe("src/league/squad.rs Squad.sign class-name");
    expect(linkOf("by_full_path_alias", "Team.sign")).toBe("src/league/squad.rs Squad.sign class-name");
    expect(linkOf("unknown_name", "Reserve.sign")).toBeNull();
  });
});
