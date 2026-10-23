import { describe, it, expect } from "vitest";
import { sqlSpec } from "./index.js";

const rows = (sql: string) => sqlSpec.extractDataSources!(sql.split("\n"), []);

describe("SQL DML rows name their table", () => {
  it("sets entity to the bare table of INSERT / UPDATE / DELETE / SELECT", () => {
    const out = rows(`INSERT INTO public.person (name) VALUES ('a');
UPDATE "game" SET title = 'x';
DELETE FROM [dbo].[Cars] WHERE id = 1;
SELECT id FROM community WHERE id = 2;`);
    expect(out.map((r) => [r.name, r.entity, r.access])).toEqual([
      ["INSERT INTO", "person", "write"],
      ["UPDATE", "game", "write"],
      ["DELETE", "Cars", "write"],
      ["SELECT", "community", "read"],
    ]);
  });

  it("reads a SELECT whose FROM is on a later line, and skips table functions", () => {
    const out = rows(`SELECT p.id,
       p.name
  FROM person p
 WHERE p.id = 1;
SELECT * FROM generate_series(1, 3);`);
    expect(out.map((r) => r.entity)).toEqual(["person"]);
  });
});

describe("SQL DML rows skip relations that are not tables", () => {
  it("drops CTEs, transition tables, catalogs and a wrapped ON UPDATE CASCADE", () => {
    const out = rows(`WITH recent AS (SELECT id FROM game)
SELECT * FROM recent;
SELECT relname FROM pg_class;
SELECT * FROM information_schema.views;
    player_id int REFERENCES person ON
    UPDATE CASCADE ON DELETE CASCADE;
CREATE TRIGGER t AFTER DELETE ON ball REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION f();
SELECT count(*) FROM
  old_rows;`);
    expect(out.filter((r) => r.entity).map((r) => r.entity)).toEqual([]);
  });
});

describe("SQL routines and grants", () => {
  it("reads Firebird and SQL Server CREATE OR ALTER / RECREATE PROCEDURE as routines", () => {
    const fns = (sql: string) =>
      sqlSpec.functionPatterns!.flatMap((p) => sql.split("\n").map((l) => l.match(p.pattern)?.[1]).filter(Boolean));
    expect(fns("CREATE OR ALTER PROCEDURE TEAM_STANDINGS (\nRECREATE PROCEDURE LAP_TIMES\nCREATE OR REPLACE FUNCTION f()")).toEqual([
      "TEAM_STANDINGS",
      "LAP_TIMES",
      "f",
    ]);
  });

  it("targets the object a GRANT names, never the privilege", () => {
    const out = rows(`GRANT SELECT ON players TO read_only_role;
GRANT EXECUTE ON PROCEDURE TEAM_STANDINGS TO USER COACH;
GRANT coach TO alice;`);
    expect(out.map((r) => [r.name, r.target])).toEqual([
      ["GRANT", "players"],
      ["GRANT", "TEAM_STANDINGS"],
    ]);
  });

  it("marks an EXEC as a routine call and skips dynamic SQL", () => {
    const out = rows(`EXECUTE PROCEDURE TEAM_STANDINGS(:SEASON);
EXECUTE STATEMENT :sql;`);
    expect(out.map((r) => [r.name, r.target, r.routine])).toEqual([["EXEC", "TEAM_STANDINGS", true]]);
  });
});

describe("SQL CREATE TABLE", () => {
  it("reads a table whose name stands on the line after CREATE TABLE (real-repo FP)", () => {
    const classes = sqlSpec.extractClasses!("CREATE TABLE\nkit_colour (\n    id serial PRIMARY KEY,\n    name text\n);\n".split("\n"), []);
    expect(classes.map((c) => `${c.name} ${c.properties.map((p) => p.name).join(",")}`)).toEqual(["kit_colour id,name"]);
    const split = sqlSpec.extractClasses!("CREATE\n  TABLE\n  IF NOT EXISTS fixtures(\n    id BIGINT PRIMARY KEY\n);\n".split("\n"), []);
    expect(split.map((c) => c.name)).toEqual(["fixtures"]);
  });
});

describe("SQL tables named with a schema and a quoted part", () => {
  it("keeps the whole name, quotes removed, in the table and its references", () => {
    const classes = sqlSpec.extractClasses!(`CREATE TABLE league."match" (
  match_id VARCHAR(36) PRIMARY KEY
);
CREATE TABLE league.goal (
  goal_id VARCHAR(36) PRIMARY KEY,
  match_id VARCHAR(36) REFERENCES league."match"(match_id)
);`.split("\n"), []);
    expect(classes.map((c) => [c.name, c.implements])).toEqual([["league.match", []], ["league.goal", ["league.match"]]]);
  });
});
