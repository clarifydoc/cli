import { describe, it, expect } from "vitest";
import "../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../parsers/parser-manager.js";
import { CSharpDataSourceExtractor } from "./csharp/data-sources.js";
import { PythonDataSourceExtractor } from "./python/data-sources.js";
import { JavaKotlinDataSourceExtractor } from "./java-kotlin/data-sources.js";
import { PhpDataSourceExtractor } from "./php/data-sources.js";
import { sqlVerbAccess, dbVerbTable } from "./shared/db-access.js";
import type { DataSourceInfo, Language } from "../../types/analysis.js";

/**
 * `DataSourceInfo.access` answers "which endpoints MODIFY this table". It was
 * set by the JavaScript and Ruby plugins alone, so on every other language a
 * write was indistinguishable from a read: C# `Add` + `SaveChangesAsync`, a Go
 * `INSERT`, a Python `session.add` all reported `writesState: false`.
 *
 * One table per plugin, asserting the access of a real call shape.
 */

const db = (s: DataSourceInfo[]) => s.filter((d) => d.kind === "database");
const accessOf = (s: DataSourceInfo[], nameFragment: string): string | undefined =>
  db(s).find((d) => d.name.includes(nameFragment))?.access;

async function sourcesOf(
  src: string,
  language: Language,
  file: string,
  make: () => { extract(tree: any, src: string): DataSourceInfo[] },
): Promise<DataSourceInfo[]> {
  const tree = await parseSource(src, language as any, file);
  return make().extract(tree, src);
}

describe("C# — EF / Dapper / ADO.NET / NHibernate", () => {
  const cs = (body: string) =>
    sourcesOf(
      `using System;\nusing Microsoft.EntityFrameworkCore;\npublic class H {\n  private readonly AppDbContext _context;\n  private readonly System.Data.IDbConnection connection;\n  public async Task M() {\n${body}\n  }\n}`,
      "csharp",
      "H.cs",
      () => new CSharpDataSourceExtractor(),
    );

  it("classifies EF writes", async () => {
    const s = await cs(`    _context.Cars.Add(o);\n    await _context.SaveChangesAsync();\n    await _context.Cars.ExecuteDeleteAsync();`);
    expect(accessOf(s, "Add")).toBe("write");
    expect(accessOf(s, "SaveChangesAsync")).toBe("write");
    expect(accessOf(s, "ExecuteDeleteAsync")).toBe("write");
  });

  it("classifies EF terminal reads", async () => {
    const s = await cs(`    var a = await _context.Cars.ToListAsync();\n    var b = await _context.Cars.FindAsync(1);`);
    expect(accessOf(s, "ToListAsync")).toBe("read");
    expect(accessOf(s, "FindAsync")).toBe("read");
  });

  it("leaves fluent composition unclassified — it neither reads nor writes", async () => {
    const s = await cs(`    var q = _context.Cars.Where(o => o.Id > 1);`);
    expect(accessOf(s, "Where")).toBeUndefined();
  });

  it("classifies Dapper and ADO.NET", async () => {
    const s = await cs(`    connection.Execute("INSERT INTO t VALUES (1)");\n    var r = connection.Query<Car>("SELECT 1");`);
    expect(accessOf(s, "Dapper: Execute")).toBe("write");
    expect(accessOf(s, "Dapper: Query")).toBe("read");
  });
});

describe("Python — SQLAlchemy / Django / pymongo", () => {
  const py = (body: string) => sourcesOf(body, "python", "r.py", () => new PythonDataSourceExtractor());

  it("detects session writes that produced no data source at all before", async () => {
    const s = await py(`def save(session, car):\n    session.add(car)\n    session.commit()\n`);
    expect(db(s).length).toBeGreaterThanOrEqual(2);
    expect(db(s).every((d) => d.access === "write")).toBe(true);
  });

  it("requires a DB-shaped receiver for the generic verbs", async () => {
    const s = await py(`def go(items):\n    items.add(1)\n    seen.delete(2)\n`);
    expect(db(s)).toHaveLength(0);
  });

  it("classifies ORM reads and writes", async () => {
    const s = await py(`def go(db):\n    db.query(Player).all()\n    coll.insert_one({})\n    coll.delete_many({})\n`);
    expect(accessOf(s, "query")).toBe("read");
    expect(accessOf(s, "insert_one")).toBe("write");
    expect(accessOf(s, "delete_many")).toBe("write");
  });

  it("leaves raw execute unclassified — the statement carries the verb", async () => {
    const s = await py(`def go(cursor):\n    cursor.execute("SELECT 1")\n`);
    expect(accessOf(s, "execute")).toBeUndefined();
  });
});

describe("JVM — Spring Data / JDBC", () => {
  const java = (body: string) =>
    sourcesOf(
      `import org.springframework.stereotype.Service;\npublic class S {\n  private CarRepository repo;\n  private org.springframework.jdbc.core.JdbcTemplate jdbcTemplate;\n  public void m() {\n${body}\n  }\n}`,
      "java",
      "S.java",
      () => new JavaKotlinDataSourceExtractor(),
    );

  it("classifies Spring Data exact and derived forms", async () => {
    const s = await java(`    repo.findAll();\n    repo.save(o);\n    repo.deleteById(1L);\n    repo.findByEmail("a");`);
    expect(accessOf(s, "findAll")).toBe("read");
    expect(accessOf(s, "save")).toBe("write");
    expect(accessOf(s, "deleteById")).toBe("write");
    expect(accessOf(s, "findByEmail")).toBe("read");
  });

  it("classifies JdbcTemplate", async () => {
    const s = await java(`    jdbcTemplate.queryForObject("SELECT 1", Integer.class);\n    jdbcTemplate.update("DELETE FROM t");`);
    expect(accessOf(s, "queryForObject")).toBe("read");
    expect(accessOf(s, "update")).toBe("write");
  });
});

describe("PHP — PDO / Eloquent", () => {
  const php = (body: string) => sourcesOf(`<?php\nclass C {\n  public function m() {\n${body}\n  }\n}`, "php", "C.php", () => new PhpDataSourceExtractor());

  it("classifies instance and static model calls", async () => {
    const s = await php(`    $pdo->fetchAll();\n    $model->save();\n    Player::create([]);\n    Player::find(1);`);
    expect(accessOf(s, "fetchAll")).toBe("read");
    expect(accessOf(s, "save")).toBe("write");
    expect(accessOf(s, "create")).toBe("write");
    expect(accessOf(s, "find")).toBe("read");
  });
});

describe("SQL verbs", () => {
  it("maps DML to read/write and leaves DDL unclassified", () => {
    expect(sqlVerbAccess("SELECT")).toBe("read");
    expect(sqlVerbAccess("INSERT INTO")).toBe("write");
    expect(sqlVerbAccess("UPDATE")).toBe("write");
    expect(sqlVerbAccess("DELETE")).toBe("write");
    expect(sqlVerbAccess("TRUNCATE")).toBe("write");
    // A startup `CREATE TABLE IF NOT EXISTS` is not an answer to "who modifies Cars".
    expect(sqlVerbAccess("CREATE")).toBeUndefined();
    expect(sqlVerbAccess("ALTER")).toBeUndefined();
    expect(sqlVerbAccess("DROP")).toBeUndefined();
  });
});

describe("dbVerbTable", () => {
  it("refuses a leaf listed as both read and write", () => {
    expect(() => dbVerbTable(["get", "save"], ["save"])).toThrow(/both read and write/);
  });
});
