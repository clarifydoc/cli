import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Real-repo FP: one schema kept as Diesel migrations for three databases — 143 ER nodes for 28 tables. */
const CREATE = (pk: string) => `CREATE TABLE clubs (\n  uuid ${pk} NOT NULL PRIMARY KEY,\n  name TEXT NOT NULL\n);\n\nCREATE TABLE players (\n  uuid ${pk} NOT NULL PRIMARY KEY,\n  club_uuid ${pk} NOT NULL REFERENCES clubs (uuid)\n);\n`;
const REBUILD = `CREATE TABLE players_new (\n  uuid TEXT NOT NULL PRIMARY KEY,\n  club_uuid TEXT NOT NULL REFERENCES clubs (uuid),\n  shirt INTEGER\n);\nINSERT INTO players_new SELECT uuid, club_uuid, NULL FROM players;\nDROP TABLE players;\nALTER TABLE players_new RENAME TO players;\n`;
const FILES: Record<string, string> = {
  "migrations/postgresql/2019-09-12-100000_create_tables/up.sql": CREATE("VARCHAR(40)"),
  "migrations/postgresql/2022-03-02-210038_add_shirt/up.sql": "ALTER TABLE players ADD COLUMN shirt INTEGER;\n",
  "migrations/sqlite/2018-01-14-171611_create_tables/up.sql": CREATE("TEXT"),
  "migrations/sqlite/2018-01-14-171611_create_tables/down.sql": "DROP TABLE players;\nDROP TABLE clubs;\n",
  // A down script recreating what its migration replaced is no table of the schema.
  "migrations/postgresql/2022-03-02-210038_add_shirt/down.sql": "CREATE TABLE players_old (uuid VARCHAR(40) NOT NULL PRIMARY KEY);\n",
  "db/migrate/000003_bench.down.sql": "CREATE TABLE bench (id INTEGER PRIMARY KEY);\n",
  // An undo script's enum and the old tables its view reads are no part of the schema either.
  "migrations/postgresql/2023-01-01-000000_kit_colour/down.sql": "CREATE TYPE kit_colour_enum AS ENUM ('home', 'away');\nCREATE VIEW fixture_view AS SELECT * FROM old_fixtures;\n",
  "migrations/sqlite/2022-03-02-210038_add_shirt/up.sql": REBUILD,
  "migrations/mysql/2018-01-14-171611_create_tables/up.sql": CREATE("CHAR(36)"),
};

describe("migration chains for several databases", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-dialect-chains-"));
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

  it("are one schema, as the first dialect's chain ends", () => {
    const nodes = summary.entityGraph!.nodes.map((n) => `${n.id} ${n.columns.map((c) => c.name).join(",")}`).sort();
    expect(nodes).toEqual([
      "migrations/postgresql/2019-09-12-100000_create_tables/up.sql::clubs uuid,name",
      "migrations/postgresql/2019-09-12-100000_create_tables/up.sql::players uuid,club_uuid,shirt",
    ]);
    expect(summary.entityGraph!.edges).toHaveLength(1);
  });
});
