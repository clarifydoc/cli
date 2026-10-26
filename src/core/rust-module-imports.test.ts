import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Rust `use crate::league::{Table}` names the file declaring `Table` by the
 * crate's module tree, through the module's glob re-exports: a unique-name
 * method there is evidenced. A standard-library member (`.iter()`) never
 * lands on the project's only method of that name (real-repo shape).
 */
const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\n`,
  "src/lib.rs": `pub mod league;\npub mod report;\n`,
  "src/league/mod.rs": `mod table;\npub use table::*;\n`,
  "src/league/table.rs": `pub struct Table {}

impl Table {
    pub fn promoted_clubs(&self) -> Vec<String> {
        Vec::new()
    }

    pub fn iter(&self) -> Vec<String> {
        Vec::new()
    }
}
`,
  "src/report.rs": `use crate::league::{Table};

pub fn summary(standings: &Standings) -> usize {
    let table = standings.current();
    let clubs = table.promoted_clubs();
    clubs.iter().count()
}
`,
};

describe("Rust module imports", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-rust-modules-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName.endsWith(callName));
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.strategy}` : null;
  };

  it("links a unique method of a file a use path names through a glob re-export", () => {
    expect(linkOf("summary", "table.promoted_clubs")).toBe("src/league/table.rs Table.promoted_clubs unique-global");
  });

  it("never lands a standard-library member on a project method of that name", () => {
    expect(linkOf("summary", "clubs.iter")).toBeNull();
  });
});
