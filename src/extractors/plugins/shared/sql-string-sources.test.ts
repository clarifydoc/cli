import { describe, it, expect } from "vitest";
import { extractSqlStringDataSources, tableFrom } from "./sql-string-sources.js";

const sources = (src: string) => extractSqlStringDataSources(src.split("\n"));

describe("extractSqlStringDataSources", () => {
  it("extracts a multi-line QSqlQuery UPDATE (adjacent string literals)", () => {
    const s = sources(`
void markTrackLocationsAsDeleted(const QSqlDatabase& database) {
    QSqlQuery query(database);
    query.prepare("UPDATE track_locations "
                  "SET fs_deleted=1 "
                  "WHERE directory=:directory");
    query.bindValue(":directory", directory);
}
    `);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({
      kind: "database",
      name: "UPDATE",
      target: "track_locations",
      entity: "track_locations",
      line: 4,
    });
  });

  it("never reads IF as the table when CREATE TABLE names a runtime variable", () => {
    const s = sources(`
    query.prepare(
            "CREATE TABLE IF NOT EXISTS " + tableName +
            " ("
            "    id INTEGER PRIMARY KEY AUTOINCREMENT,"
            "    location TEXT UNIQUE)");
    `);
    expect(s).toEqual([]);
  });

  it("extracts SELECT with FROM on a later fragment", () => {
    const s = sources(`
    query.prepare("SELECT library.id, library.title "
                  "FROM library "
                  "WHERE library.id=:id");
    `);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ name: "SELECT", target: "library" });
  });

  it("keeps a macro table name spliced between fragments (CUE_TABLE)", () => {
    const s = sources(`
    query.prepare(QStringLiteral("SELECT * FROM " CUE_TABLE " WHERE track_id=:id"));
    query.prepare(QStringLiteral("DELETE FROM " CUE_TABLE " WHERE track_id=:track_id"));
    query.prepare(QStringLiteral("INSERT INTO " CUE_TABLE
                                 " (track_id, type, position) VALUES (:a,:b,:c)"));
    `);
    expect(s.map((x) => [x.name, x.target])).toEqual([
      ["SELECT", "CUE_TABLE"],
      ["DELETE FROM", "CUE_TABLE"],
      ["INSERT INTO", "CUE_TABLE"],
    ]);
  });

  it("handles DROP TABLE IF EXISTS and sqlite INSERT OR REPLACE", () => {
    const s = sources(`
    query.prepare("DROP TABLE IF EXISTS playlist_import");
    sqlite3_exec(db, "INSERT OR REPLACE INTO settings (name, value) VALUES (?, ?)", 0, 0, 0);
    `);
    expect(s.map((x) => [x.name, x.target])).toEqual([
      ["DROP TABLE", "playlist_import"],
      ["INSERT INTO", "settings"],
    ]);
  });

  it("ignores UI strings that merely start with a SQL verb", () => {
    const s = sources(`
    setStatus(tr("Update available for download"));
    label->setText("Select all tracks in the library");
    help->setText("Select controls from a list of presets");
    `);
    expect(s).toEqual([]);
  });

  it("ignores commented-out SQL", () => {
    const s = sources(`
    // query.prepare("DELETE FROM cues");
    /* "SELECT * FROM library" */
    `);
    expect(s).toEqual([]);
  });

  it("does not read a SQL keyword as the table when the macro is missing", () => {
    // If the table is an unrecognizable expression, skip rather than emit WHERE.
    const s = sources(`
    query.prepare("SELECT * FROM " + tableName() + " WHERE id=:id");
    `);
    expect(s).toEqual([]);
  });
});

describe("stored procedures are routines, not tables", () => {
  const q = (sql: string) => extractSqlStringDataSources([`"${sql}"`]);
  const rows = (sql: string) => q(sql).map((d) => [d.name, d.target, d.entity ?? null, d.routine ?? false, d.joined ?? false]);

  it("records a Firebird selectable stored procedure as a routine call, never an entity", () => {
    // The backbone of many Delphi/Firebird apps: a procedure called like a table.
    expect(rows("SELECT HOME_TEAM FROM SP_FIXTURES(:CLUB_ID, :MATCH_DATE)")).toEqual([
      ["EXEC", "SP_FIXTURES", null, true, false],
    ]);
  });

  it("records EXECUTE PROCEDURE, CALL and T-SQL EXEC", () => {
    expect(rows("EXECUTE PROCEDURE UPDATE_MATCH_REPORT_SENT(:REPORT_ID_LIST)")).toEqual([
      ["EXEC", "UPDATE_MATCH_REPORT_SENT", null, true, false],
    ]);
    expect(rows("{call get_driver(?)}")).toEqual([["EXEC", "get_driver", null, true, false]]);
    expect(rows("EXEC dbo.usp_TeamStandings @season = 2024")).toEqual([["EXEC", "dbo.usp_TeamStandings", null, true, false]]);
  });

  it("does not read prose that opens with Execute as a procedure", () => {
    expect(q("Execute command")).toEqual([]);
    expect(q("EXECUTE STATEMENT :sql")).toEqual([]);
  });

  it("skips built-in set-returning functions", () => {
    expect(q("SELECT * FROM generate_series(1, 10)")).toEqual([]);
  });

  it("keeps the procedure and the table joined beside it", () => {
    expect(rows("SELECT * FROM SP_PLAYER_HISTORY(:ID) H JOIN PLAYER P ON P.ID = H.PERSON_ID")).toEqual([
      ["EXEC", "SP_PLAYER_HISTORY", null, true, false],
      ["SELECT", "PLAYER", "PLAYER", false, true],
    ]);
  });

  it("tableFrom still answers with the joined table", () => {
    expect(tableFrom("SELECT * FROM SP_PLAYER_HISTORY(:ID) H JOIN PLAYER P ON P.ID = H.PERSON_ID")).toEqual({ verb: "SELECT", table: "PLAYER" });
    expect(tableFrom("EXECUTE PROCEDURE X(:A)")).toBeNull();
  });

  it("still reads a plain table with no argument list", () => {
    expect(q("SELECT ID FROM PLAYER").map((d) => d.entity)).toEqual(["PLAYER"]);
  });
});

describe("every table a statement reads", () => {
  const q = (sql: string) => extractSqlStringDataSources([`"${sql}"`]).map((d) => [d.name, d.target, d.joined ?? false]);

  it("keeps JOINed tables, the statement's own FROM first even after a correlated subquery", () => {
    expect(q(
      "SELECT T.ID, (SELECT COUNT(*) FROM PLAYER_GOALS G WHERE G.TEAM_ID = T.ID) AS GOALS " +
      "FROM TEAM T INNER JOIN LEAGUE L ON L.ID = T.LEAGUE_ID LEFT OUTER JOIN STADIUM S ON S.ID = T.STADIUM_ID",
    )).toEqual([
      ["SELECT", "TEAM", false],
      ["SELECT", "PLAYER_GOALS", true],
      ["SELECT", "LEAGUE", true],
      ["SELECT", "STADIUM", true],
    ]);
  });

  it("reads comma joins when a WHERE follows, never in prose", () => {
    expect(q("SELECT * FROM CAR C, DRIVER D WHERE C.DRIVER_ID = D.ID")).toEqual([
      ["SELECT", "CAR", false],
      ["SELECT", "DRIVER", true],
    ]);
    expect(q("Select friends from Facebook, Twitter")).toEqual([["SELECT", "Facebook", false]]);
  });

  it("reads a write's subquery tables as reads beside it", () => {
    expect(q("DELETE FROM cars WHERE id IN (SELECT car_id FROM recalls)")).toEqual([
      ["DELETE FROM", "cars", false],
      ["SELECT", "recalls", true],
    ]);
  });

  it("never reads a function argument's FROM as a table", () => {
    expect(q("SELECT EXTRACT(YEAR FROM kickoff) FROM matches")).toEqual([["SELECT", "matches", false]]);
  });

  it("reads $ names whole and drops the engine's catalogue", () => {
    expect(q("SELECT gen_id(TEAM_ID_GEN, 1) AS id FROM rdb$database")).toEqual([]);
    expect(q("SELECT SYSDATE FROM dual")).toEqual([]);
    expect(q("SELECT * FROM team$history")).toEqual([["SELECT", "team$history", false]]);
    expect(q("SELECT 1 FROM sqlite_master WHERE type = 'table'")).toEqual([]);
    expect(q("SELECT column_name FROM information_schema.columns WHERE table_name = 'clubs'")).toEqual([]);
  });

  it("skips a CTE's own name", () => {
    expect(q("WITH top_scorers AS (SELECT * FROM goals) SELECT * FROM top_scorers JOIN players ON 1 = 1")).toEqual([
      ["SELECT", "goals", false],
      ["SELECT", "players", true],
    ]);
  });
});
