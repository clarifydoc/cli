import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: 531 calls to functions imported by name, 5 linked. */
const FILES: Record<string, string> = {
  "Cargo.toml": `[workspace]\nmembers = ["league-api", "league-db", "crates/api_utils"]\n`,
  "crates/api_utils/Cargo.toml": `[package]\nname = "league_api_utils"\nversion = "0.1.0"\n`,
  "crates/api_utils/src/lib.rs": `pub fn check_squad_size(n: usize) -> bool {\n    n <= 25\n}\n`,
  "league-db/Cargo.toml": `[package]\nname = "league-db"\nversion = "0.1.0"\n`,
  "league-db/src/lib.rs": `pub mod persistence;\n`,
  "league-db/src/persistence/mod.rs": `mod club_sql;\npub use club_sql::*;\n`,
  "league-db/src/persistence/club_sql.rs": `pub fn select_club(conn: &mut Conn, id: &str) -> Club {\n    clubs::table.find(id).first(conn)\n}\n`,
  "league-api/Cargo.toml": `[package]\nname = "league-api"\nversion = "0.1.0"\n`,
  "league-api/src/main.rs": `mod util;\nmod handlers;\nfn main() {}\n`,
  "league-api/src/util.rs": `pub fn is_derby(a: &str, b: &str) -> bool {\n    a == b\n}\n`,
  "league-api/src/handlers/mod.rs": `pub mod fixtures;\n`,
  "league-api/src/handlers/fixtures.rs": `use crate::util::{is_derby};
use league_db::persistence::{select_club};
use super::super::util::is_derby as derby;
use league_api_utils::{check_squad_size};

pub fn fixture(conn: &mut Conn, home: &str, away: &str) -> bool {
    let club = select_club(conn, home);
    check_squad_size(22);
    is_derby(home, away)
}
`,
};

describe("Rust functions imported by name", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-imports-"));
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

  it("link to the file that defines them — through crate::, another workspace crate and a glob re-export", () => {
    const links = summary.symbolLinks
      .filter((l) => l.sourceSymbol === "fixture")
      .map((l) => `${l.callName} → ${l.targetFile}#${l.targetSymbol}`)
      .sort();
    expect(links).toEqual([
      "check_squad_size → crates/api_utils/src/lib.rs#check_squad_size",
      "is_derby → league-api/src/util.rs#is_derby",
      "select_club → league-db/src/persistence/club_sql.rs#select_club",
    ]);
  });
});
