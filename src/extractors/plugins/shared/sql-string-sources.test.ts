import { describe, it, expect } from "vitest";
import { extractSqlStringDataSources, tableFrom, joinedTableRows, statementAccesses } from "./sql-string-sources.js";

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

  it("ends a pending statement at the first line without a string", () => {
    const s = sources(`
    q.prepare("SELECT id FROM clubs "
              "WHERE league = 1"
    );
    q.prepare("UPDATE players SET club = 2");
    `);
    expect(s.map((x) => [x.name, x.target, x.line])).toEqual([
      ["SELECT", "clubs", 2],
      ["UPDATE", "players", 5],
    ]);
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

  it("names no table when only its schema is written before a hole (real-repo FP)", () => {
    const s = sources(`sql_query(format!("SELECT * FROM league.{table_name}('{}')", period))`);
    expect(s).toEqual([]);
  });

  it("never reads SQL's own functions as a routine the statement calls", () => {
    const s = sources(`db.Exec("SELECT club_id FROM COALESCE(NULL, 0)")`);
    expect(s.filter((d) => d.routine)).toEqual([]);
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
    expect(q("SELECT relname FROM pg_class JOIN pg_roles ON true")).toEqual([]);
  });

  it("drops a migration tool's bookkeeping tables (real-repo FP)", () => {
    expect(q("SELECT version_num FROM alembic_version")).toEqual([]);
    expect(q("SELECT version FROM public.flyway_schema_history")).toEqual([]);
    expect(q("SELECT MigrationId FROM [__EFMigrationsHistory]")).toEqual([]);
    expect(q("SELECT * FROM schema_migrations JOIN clubs ON 1 = 1")).toEqual([["SELECT", "clubs", false]]);
  });

  it("skips a quoted CTE's name, as a query builder dumps it", () => {
    // Escaped as it sits in a double-quoted code string.
    expect(q('with \\"today\\" as (SELECT * FROM fixtures) SELECT * FROM \\"today\\" JOIN clubs ON 1 = 1')).toEqual([
      ["SELECT", "fixtures", false],
      ["SELECT", "clubs", true],
    ]);
  });

  it("skips a CTE's own name", () => {
    expect(q("WITH top_scorers AS (SELECT * FROM goals) SELECT * FROM top_scorers JOIN players ON 1 = 1")).toEqual([
      ["SELECT", "goals", false],
      ["SELECT", "players", true],
    ]);
  });
});

describe("engine catalogues and SQL clause words are no tables (real-repo FP)", () => {
  const tables = (src: string) => sources(src).map((d) => `${d.name} ${d.target}`);

  it("keeps a name spliced from quoted parts qualified, and drops catalogue schemas", () => {
    expect(tables(`Uptime := GetVar("SELECT login_time FROM " + Quote("master") + "." + Quote("dbo") + "." + Quote("sysprocesses"));
Users := GetCol("SELECT name FROM " + Quote("mysql") + "." + Quote("user") + " WHERE x=1");
Mods := GetVar("SELECT d FROM " + Quote("SYS") + "." + Quote("OBJECTS"));
Clubs := GetCol("SELECT name FROM " + Quote("league") + "." + Quote("clubs"));
Q("UPDATE " + Quote("league") + "." + Quote(Table) + " SET name=1");`)).toEqual(["SELECT league.clubs"]);
  });

  it("reads past MySQL's statement modifiers: IGNORE is no table", () => {
    expect(tables(`db.Exec("UPDATE IGNORE squad_players SET club_id = ? WHERE club_id = ?");
db.Exec("INSERT IGNORE INTO transfers (player_id) VALUES (?)");
db.Exec("DELETE LOW_PRIORITY QUICK FROM injuries WHERE healed = 1");`)).toEqual(["UPDATE squad_players", "INSERT INTO transfers", "DELETE FROM injuries"]);
  });

  it("takes a format verb for a hole, never a table", () => {
    expect(tables(`db.Exec(fmt.Sprintf("DELETE FROM %s WHERE season < ?", table));
db.Exec(fmt.Sprintf("INSERT INTO \`new_%s_new\` SELECT * FROM \`%s\`", t, t));`)).toEqual([]);
  });

  it("drops a quoted name in a catalogue schema and SQLite's table-valued pragmas", () => {
    expect(tables(`q("SELECT * FROM INFORMATION_SCHEMA.\`EVENTS\` WHERE EVENT_SCHEMA=%s");
q("SELECT name FROM pragma_database_list");
q("SELECT * FROM \`league\`.\`matches\`");`)).toEqual(["SELECT matches"]);
  });

  it("reads a statement whose CTEs open it on an earlier line", () => {
    expect(tables(`Keys := GetResults("WITH ndx_list AS (" +
  "    SELECT player_id FROM squads" +
  "), ndx_cols AS (SELECT * FROM ndx_list) " +
  "SELECT * FROM ndx_cols JOIN kits ON true");`)).toEqual(["SELECT squads", "SELECT kits"]);
  });

  it("never reads LATERAL or AUTO_INCREMENT after a hole as a table", () => {
    expect(tables(`Output("ALTER TABLE " + Target + " AUTO_INCREMENT = 1");
q("SELECT c.id FROM clubs c CROSS JOIN LATERAL " + Fn + " AS x WHERE 1=1");`)).toEqual(["SELECT clubs"]);
  });
});

describe("statementAccesses — every source a statement reads", () => {
  const acc = (sql: string) => statementAccesses(sql).map((a) => `${a.verb} ${a.table}${a.joined ? " +" : ""}`);

  it("reads a write's FROM, USING and INSERT … SELECT sources beside its target", () => {
    expect(acc("UPDATE clubs SET tier = 1 FROM standings s WHERE s.club_id = clubs.id")).toEqual(["UPDATE clubs", "SELECT standings +"]);
    expect(acc("DELETE FROM players USING clubs c, loans l WHERE players.club_id = c.id")).toEqual(["DELETE FROM players", "SELECT clubs +", "SELECT loans +"]);
    expect(acc("MERGE INTO standings s USING results r ON s.club_id = r.club_id WHEN MATCHED THEN UPDATE SET points = r.points"))
      .toEqual(["MERGE INTO standings", "SELECT results +"]);
    expect(acc("INSERT INTO club_archive (id) SELECT id FROM clubs WHERE id IN (SELECT club_id FROM relegations)"))
      .toEqual(["INSERT INTO club_archive", "SELECT clubs +", "SELECT relegations +"]);
  });

  it("writes the table an UPDATE's alias names", () => {
    expect(acc("UPDATE c SET tier = 1 FROM clubs c JOIN standings s ON s.club_id = c.id")).toEqual(["UPDATE clubs", "SELECT standings +"]);
    expect(acc("UPDATE c SET c.tier = 1 FROM dbo.Clubs AS c")).toEqual(["UPDATE dbo.Clubs"]);
  });

  it("reads the write CTEs lead into, and what their bodies read", () => {
    expect(acc("WITH top AS (SELECT club_id FROM standings) UPDATE clubs SET tier = 1 WHERE id IN (SELECT club_id FROM top)"))
      .toEqual(["UPDATE clubs", "SELECT standings +"]);
  });

  it("never reads a column USING list, a JPQL join path, IS DISTINCT FROM or a quoted word as a table", () => {
    expect(acc("SELECT * FROM clubs JOIN standings USING (club_id)")).toEqual(["SELECT clubs", "SELECT standings +"]);
    expect(acc("ALTER TABLE cars ALTER COLUMN year TYPE int USING year::int")).toEqual(["ALTER TABLE cars"]);
    expect(acc("SELECT c FROM Club c JOIN c.players p LEFT JOIN FETCH c.league WHERE p.age > 30")).toEqual(["SELECT Club"]);
    expect(acc("SELECT c FROM Club c JOIN Garage g ON g.club = c")).toEqual(["SELECT Club", "SELECT Garage +"]);
    expect(acc("SELECT * FROM cars WHERE colour IS DISTINCT FROM paint")).toEqual(["SELECT cars"]);
    expect(acc("SELECT * FROM transfers WHERE note = 'moved from Lyon' AND fee > 0")).toEqual(["SELECT transfers"]);
  });
});

describe("joinedTableRows", () => {
  it("names each further table once as a joined read, beside the caller's own", () => {
    const rows = joinedTableRows("SELECT * FROM league.clubs c JOIN league.standings s ON 1 = 1 JOIN standings x ON 1 = 1", "clubs", "cur.execute", 4, { lastPart: true });
    expect(rows).toEqual([{ kind: "database", name: "cur.execute", target: "standings", access: "read", entity: "standings", joined: true, calls: [], line: 4 }]);
  });

  it("leaves routines to the caller and drops what the caller vetoes", () => {
    const rows = joinedTableRows("SELECT * FROM sp_squad(1) s JOIN hole0__ h ON 1 = 1 JOIN kits k ON 1 = 1", null, "q", 1, { keep: (t) => !t.includes("hole") });
    expect(rows.map((r) => r.target)).toEqual(["kits"]);
  });
});
