import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** A Diesel schema's table and the model struct mapping it (real-repo FP: 54 of 56 typed model calls did not link). */
const FILES: Record<string, string> = {
  "Cargo.toml": `[package]\nname = "league"\nversion = "0.1.0"\n\n[dependencies]\ndiesel = "2"\n`,
  "src/db/schema.rs": `table! {
    clubs (uuid) {
        uuid -> Text,
        name -> Text,
    }
}
`,
  "src/db/models/club.rs": `use crate::db::schema::clubs;

#[derive(Identifiable, Queryable, Insertable)]
#[diesel(table_name = clubs)]
pub struct Club {
    pub uuid: String,
    pub name: String,
}

impl Club {
    pub async fn save(&self, conn: &DbConn) -> EmptyResult {
        diesel::insert_into(clubs::table).values(self).execute(conn)
    }
}
`,
  "src/api/clubs.rs": `use crate::db::models::Club;

#[post("/clubs")]
async fn post_clubs(conn: DbConn) -> EmptyResult {
    let club = Club::new();
    club.save(&conn).await
}
`,
};

describe("Diesel tables and their model structs", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-diesel-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("are one entity, the struct, so a call on a value of it links", () => {
    const clubs = (summary.entityGraph?.nodes ?? []).filter((n) => n.name === "Club").map((n) => `${n.filePath} ${n.table ?? ""}`);
    expect(clubs).toEqual(["src/db/models/club.rs clubs"]);
    expect(summary.symbolLinks.filter((l) => l.sourceSymbol === "post_clubs").map((l) => l.targetSymbol)).toContain("Club.save");
  });
});
