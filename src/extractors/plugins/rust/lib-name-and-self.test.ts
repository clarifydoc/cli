import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * A crate imported by its `[lib] name` (package `league-core`, library `league_lib`) and a module bound by
 * `use path::module::{self, …}`; decoys: a namesake crate and module, a `{self}` of a module without the function,
 * and an external `serde::de::{self}` next to a local `de.rs`.
 */
const FILES: Record<string, string> = {
  "Cargo.toml": `[workspace]\nmembers = ["crates/league", "crates/garage", "crates/app"]\n`,
  "crates/league/Cargo.toml": `[package]\nname = "league-core"\nversion = "0.1.0"\n[lib]\nname = "league_lib"\n`,
  "crates/league/src/lib.rs": `pub mod squad;\npub mod scoring;\npub mod cup;\npub mod table;\npub fn kickoff() {}\n`,
  "crates/league/src/squad.rs": `pub fn pick() {}\npub struct Coach;\n`,
  "crates/league/src/scoring.rs": `pub fn tally() {}\npub struct Goal;\n`,
  "crates/league/src/table.rs": `pub fn rank() {}\n`,
  "crates/league/src/cup/mod.rs": `pub mod final_match;\n`,
  "crates/league/src/cup/final_match.rs": `use crate::squad::{self};\nuse crate::scoring::{self, Goal};\nfn play() {\n    squad::pick();\n    scoring::tally();\n}\n`,
  "crates/league/src/bin/trainer.rs": `use league_lib::squad::{self, Coach};\nfn train() {\n    squad::pick();\n}\n`,
  "crates/garage/Cargo.toml": `[package]\nname = "garage"\nversion = "0.1.0"\n`,
  "crates/garage/src/lib.rs": `pub fn kickoff() {}\npub mod table;\npub mod squad;\n`,
  "crates/garage/src/table.rs": `pub fn rank() {}\n`,
  "crates/garage/src/squad.rs": `pub fn pick() {}\n`,
  "crates/app/Cargo.toml": `[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nleague-core = { path = "../league" }\ngarage = { path = "../garage" }\n`,
  "crates/app/src/main.rs": `use league_lib::kickoff;\nuse garage::squad::{self};\nfn main() {\n    kickoff();\n    league_lib::table::rank();\n    squad::pick();\n}\n`,
  "crates/app/src/de.rs": `pub fn decode() {}\n`,
  "crates/app/src/other.rs": `use serde::de::{self};\nuse garage::table::{self};\nfn f() {\n    de::decode();\n    table::nothing();\n}\n`,
};

describe("Rust crate by [lib] name and a {self} module import", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-libname-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links exactly the calls through the library name and the {self} modules, each to its own crate", () => {
    const links = summary.symbolLinks
      .filter((l) => l.callName !== "Goal")
      .map((l) => `${l.sourceFile} ${l.callName} → ${l.targetFile}#${l.targetSymbol} ${l.confidence}`)
      .sort();
    expect(links).toEqual([
      "crates/app/src/main.rs kickoff → crates/league/src/lib.rs#kickoff EXTRACTED",
      "crates/app/src/main.rs league_lib::table::rank → crates/league/src/table.rs#rank EXTRACTED",
      "crates/app/src/main.rs squad::pick → crates/garage/src/squad.rs#pick EXTRACTED",
      "crates/league/src/bin/trainer.rs squad::pick → crates/league/src/squad.rs#pick EXTRACTED",
      "crates/league/src/cup/final_match.rs scoring::tally → crates/league/src/scoring.rs#tally EXTRACTED",
      "crates/league/src/cup/final_match.rs squad::pick → crates/league/src/squad.rs#pick EXTRACTED",
    ]);
  });
});
