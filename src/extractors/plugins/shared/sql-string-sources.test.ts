import { describe, it, expect } from "vitest";
import { extractSqlStringDataSources } from "./sql-string-sources.js";

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

describe("table-valued functions are not tables", () => {
  const q = (sql: string) => extractSqlStringDataSources([`"${sql}"`]);

  it("skips a Firebird selectable stored procedure in the FROM position", () => {
    // The backbone of many Delphi/Firebird apps: a procedure called like a table.
    expect(q("SELECT CPRNR FROM SP_WAITLIST(:CLUB_ID, :MATCH_DATE)")).toEqual([]);
  });

  it("skips a Postgres set-returning function", () => {
    expect(q("SELECT * FROM generate_series(1, 10)")).toEqual([]);
  });

  it("falls through to a real table joined alongside a procedure", () => {
    const out = q("SELECT * FROM SP_DRIVER_HISTORY(:ID) H JOIN TPERSON P ON P.ID = H.PERSON_ID");
    expect(out.map((d) => d.entity)).toEqual(["TPERSON"]);
  });

  it("still reads a plain table with no argument list", () => {
    expect(q("SELECT ID FROM TPERSON").map((d) => d.entity)).toEqual(["TPERSON"]);
  });
});
