import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** A crate's `tests/<x>.rs` is a crate root of its own: (real-repo FP) `use crate::support::auth` in a helper under `tests/support/`. */
const FILES: Record<string, string> = {
  "Cargo.toml": `[workspace]\nmembers = ["crates/league", "crates/garage"]\n`,
  "crates/league/Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\n`,
  "crates/league/src/lib.rs": `pub fn kickoff() {}\n`,
  "crates/league/tests/kit.rs": `mod support;\n\n#[test]\nfn squad_signs_in() {\n    support::kit::sign_in_squad();\n}\n`,
  "crates/league/tests/support/mod.rs": `pub mod auth;\npub mod kit;\n`,
  "crates/league/tests/support/kit.rs": `use crate::support::auth::{squad_login};\n\npub fn sign_in_squad() {\n    squad_login();\n}\n`,
  "crates/league/tests/support/auth.rs": `pub fn squad_login() {}\n`,
  // Decoy: another crate's `support/auth.rs` of the same name and function.
  "crates/garage/Cargo.toml": `[package]\nname = "garage"\nversion = "0.1.0"\n`,
  "crates/garage/src/lib.rs": `pub mod support;\n`,
  "crates/garage/src/support/mod.rs": `pub mod auth;\n`,
  "crates/garage/src/support/auth.rs": `pub fn squad_login() {}\n`,
  // A module folder named `tests` inside a crate keeps its own meaning.
  "crates/garage/src/tests/mod.rs": `mod helpers;\n`,
  "crates/garage/src/tests/helpers.rs": `use crate::support::auth::{squad_login};\n\npub fn run() {\n    squad_login();\n}\n`,
};

describe("Rust test-crate modules", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-test-crate-"));
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

  it("resolves `use crate::support::auth` under tests/ to the file beside it, never another crate's", () => {
    const links = summary.symbolLinks
      .filter((l) => l.sourceSymbol === "sign_in_squad")
      .map((l) => `${l.callName} → ${l.targetFile}#${l.targetSymbol}`);
    expect(links).toEqual(["squad_login → crates/league/tests/support/auth.rs#squad_login"]);
  });

  it("still resolves a `src/tests/` module folder against the crate's src", () => {
    const links = summary.symbolLinks
      .filter((l) => l.sourceSymbol === "run")
      .map((l) => `${l.callName} → ${l.targetFile}#${l.targetSymbol}`);
    expect(links).toEqual(["squad_login → crates/garage/src/support/auth.rs#squad_login"]);
  });
});
