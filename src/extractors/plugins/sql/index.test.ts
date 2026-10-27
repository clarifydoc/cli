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
  it("drops CTEs, transition tables, catalogs and a wrapped ON UPDATE CASCADE — the table a CTE reads stays", () => {
    const out = rows(`WITH recent AS (SELECT id FROM game)
SELECT * FROM recent;
SELECT relname FROM pg_class;
SELECT * FROM information_schema.views;
    player_id int REFERENCES person ON
    UPDATE CASCADE ON DELETE CASCADE;
CREATE TRIGGER t AFTER DELETE ON ball REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION f();
SELECT count(*) FROM
  old_rows;`);
    expect(out.filter((r) => r.entity).map((r) => r.entity)).toEqual(["game"]);
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
GRANT coach TO alice;
GRANT USAGE ON SCHEMA league TO coach;
GRANT SELECT ON ALL TABLES IN SCHEMA league TO coach;`);
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

describe("T-SQL routines and batches", () => {
  const procs = `CREATE PROCEDURE [dbo].[usp_SignPlayer]
  @PlayerId INT
AS
BEGIN
  BEGIN TRANSACTION
  SELECT CASE WHEN Fee > 0 THEN 1 ELSE 0 END AS Paid FROM dbo.Contracts WHERE PlayerId = @PlayerId
  INSERT INTO dbo.Audit (PlayerId) VALUES (@PlayerId)
  COMMIT
END
GO
CREATE PROC dbo.usp_NotifyAgent @PlayerId INT AS
  SELECT AgentId FROM dbo.Agents WHERE PlayerId = @PlayerId
GO
CREATE FUNCTION "league"."fn_Wage" (@PlayerId INT) RETURNS MONEY AS
BEGIN
  RETURN (SELECT Wage FROM dbo.Contracts WHERE PlayerId = @PlayerId)
END
GO`;

  it("names a routine whole, quotes removed, and ends it at its END or its batch's GO", () => {
    const lines = procs.split("\n");
    const fns = sqlSpec.postProcessFunctions!(lines, [1, 11, 14].map((line) => ({ name: "x", params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line, endLine: line })));
    expect(fns.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["dbo.usp_SignPlayer", 1, 9],
      ["dbo.usp_NotifyAgent", 11, 12],
      ["league.fn_Wage", 14, 17],
    ]);
    // `INSERT INTO t (cols)` and `VALUES (…)` call nothing.
    expect(fns[0]!.calls.map((c) => c.name)).toEqual([]);
  });

  it("reads CREATE PROC as a routine", () => {
    expect(sqlSpec.functionPatterns!.some((p) => p.pattern.test("CREATE PROC dbo.usp_NotifyAgent @PlayerId INT AS"))).toBe(true);
  });

  it("reads every table a routine's statements touch: joins, subqueries, CTEs and an UPDATE's alias", () => {
    const out = rows(`CREATE PROCEDURE dbo.usp_Squad @ClubId INT AS
BEGIN
  IF EXISTS (SELECT 1 FROM dbo.Suspensions WHERE ClubId = @ClubId)
    RETURN
  SELECT p.Name, c.Name
  FROM dbo.Players p
  JOIN [dbo].[Clubs] c ON c.Id = p.ClubId
  WHERE p.Id IN (SELECT PlayerId FROM dbo.Squads WHERE ClubId = @ClubId)
  UPDATE p SET Fit = 1 FROM dbo.Players p JOIN dbo.Medicals m ON m.PlayerId = p.Id
  WITH recent AS (SELECT Id FROM dbo.Matches) SELECT Id FROM recent
END
GO`);
    expect(out.map((r) => `${r.line} ${r.name} ${r.entity} ${r.access}${r.joined ? " joined" : ""}`)).toEqual([
      "3 SELECT Suspensions read",
      "5 SELECT Players read",
      "7 SELECT Clubs read joined",
      "8 SELECT Squads read joined",
      "9 UPDATE Players write",
      "9 SELECT Medicals read joined",
      "10 SELECT Matches read",
    ]);
  });

  it("names the routine an EXEC runs, bracketed or assigned", () => {
    const out = rows(`EXEC [dbo].[usp_SignPlayer] @PlayerId = 7
EXEC @rc = dbo.usp_NotifyAgent 7`);
    expect(out.map((r) => [r.target, r.routine])).toEqual([["dbo.usp_SignPlayer", true], ["dbo.usp_NotifyAgent", true]]);
  });
});

describe("subqueries a write's values read", () => {
  it("reads the tables of a VALUES subquery that opens lines below its parenthesis (real-repo FP)", () => {
    const out = rows(`-- name: sign-player-for-club!
INSERT INTO players_to_clubs (player_id, club_id)
VALUES ((
            SELECT id
            FROM players
            WHERE name = :player), (SELECT id FROM clubs WHERE name = :club));`);
    expect(out.map((r) => `${r.line} ${r.name} ${r.entity}${r.joined ? " joined" : ""}`)).toEqual([
      "2 INSERT INTO players_to_clubs",
      "5 SELECT players joined",
      "6 SELECT clubs joined",
    ]);
  });
});

describe("named queries: parameters and filter fields", () => {
  const src = `-- name: get-squad-by-club^
SELECT p.id,
       p.name,
       (SELECT name FROM clubs WHERE id = p.club_id) AS club_name
FROM players p
         INNER JOIN clubs c ON p.club_id = c.id AND (c.slug = :club_slug)
WHERE p.id = :player_id;

-- name: update-player-shirt!
UPDATE players
SET shirt = :shirt
WHERE id = :player_id;

-- name: delete-player!
DELETE
FROM players
WHERE id = :player_id
  AND club_id = (SELECT id FROM clubs WHERE slug = :club_slug);`;

  it("gives each named query its placeholders as parameters, in order", () => {
    const fns = sqlSpec.postProcessFunctions!(src.split("\n"), []);
    expect(fns.map((f) => [f.name, f.params.map((p) => p.name)])).toEqual([
      ["get-squad-by-club", ["club_slug", "player_id"]],
      ["update-player-shirt", ["shirt", "player_id"]],
      ["delete-player", ["player_id", "club_slug"]],
    ]);
  });

  it("sets each compared field on the row of its table — by alias, else the query at its depth — never a SET or VALUES", () => {
    expect(rows(src).filter((r) => r.whereFields).map((r) => [r.name, r.entity, r.line, r.whereFields!.map((w) => `${w.field}=${w.origin.kind === "param" ? `${w.origin.name}#${w.origin.index}` : "?"}`)])).toEqual([
      ["SELECT", "clubs", 2, ["slug=club_slug#0"]],
      ["SELECT", "players", 5, ["id=player_id#1"]],
      ["UPDATE", "players", 10, ["id=player_id#1"]],
      ["DELETE", "players", 15, ["id=player_id#0"]],
      ["SELECT", "clubs", 18, ["slug=club_slug#1"]],
    ]);
  });
});
