import { describe, it, expect } from "vitest";
import { AiosqlQueryResolver } from "./aiosql.js";
import { namedQueries } from "../sql/named-queries.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const SQL = `-- name: add-report-to-favorites!
INSERT INTO favorites (player_id, report_id)
VALUES (:player_id, :report_id);


-- name: get-report-by-slug^
SELECT id, slug FROM reports
WHERE slug = :slug;
`;

describe("named-query .sql files", () => {
  it("makes each `-- name:` block a function spanning its statement, the operator suffix dropped", () => {
    expect(namedQueries(SQL.split("\n")).map((f) => [f.name, f.line, f.endLine, f.decorators[0]])).toEqual([
      ["add-report-to-favorites", 1, 3, '@named-query("add-report-to-favorites")'],
      ["get-report-by-slug", 6, 8, '@named-query("get-report-by-slug")'],
    ]);
  });

  it("reads HugSQL/PugSQL and sqlc headers", () => {
    expect(namedQueries(["-- :name find-player :? :1", "SELECT 1;", "-- name: GetScout :one", "SELECT 2;"]).map((f) => f.name)).toEqual(["find-player", "GetScout"]);
  });
});

const py = (filePath: string, o: Partial<FileAnalysis>): FileAnalysis =>
  ({ filePath, language: "python", projectId: "root", imports: [], exports: [], functions: [], classes: [], ...o }) as unknown as FileAnalysis;
const setup = (calls: string[]) => ({ name: "<setup>", line: 1, endLine: 1, params: [], calls: calls.map((name) => ({ name, kind: "cross-file", target: "aiosql", line: 3 })), decorators: [], returnType: null, isAsync: false, isExported: false });

describe("aiosql calls", () => {
  const sql = { filePath: "app/db/queries/sql/reports.sql", language: "sql", projectId: "root", functions: namedQueries(SQL.split("\n")), classes: [], imports: [], exports: [] } as unknown as FileAnalysis;
  const loader = py("app/db/queries/queries.py", { functions: [setup(["aiosql.from_path", "pathlib.Path"])] as never });
  const repo = (calls: Array<{ name: string; target: string }>) =>
    py("app/db/repositories/reports.py", {
      classes: [{ name: "ReportsRepository", methods: [{ name: "get_report", line: 10, endLine: 20, params: [], decorators: [], calls: calls.map((c) => ({ ...c, kind: "cross-file", line: 12 })) }] }] as never,
    });

  it("links `queries.get_report_by_slug` to the block of that name under the loader's directory", () => {
    const links = new AiosqlQueryResolver().resolve([sql, loader, repo([{ name: "queries.get_report_by_slug", target: "app.db.queries.queries" }])]);
    expect(links.map((l) => `${l.sourceSymbol} → ${l.targetFile}::${l.targetSymbol}@${l.targetLine}`)).toEqual([
      "ReportsRepository.get_report → app/db/queries/sql/reports.sql::get-report-by-slug@6",
    ]);
  });

  it("links nothing for an object from a module that loads no queries, or a name no block has", () => {
    const resolver = new AiosqlQueryResolver();
    expect(resolver.resolve([sql, loader, repo([{ name: "queries.get_report_by_slug", target: "app.services.other" }])])).toEqual([]);
    expect(resolver.resolve([sql, loader, repo([{ name: "queries.drop_everything", target: "app.db.queries.queries" }])])).toEqual([]);
  });
});
