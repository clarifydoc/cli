import { describe, it, expect } from "vitest";
import "../../registry.js";
import { createEmptyAnalysis, type FileAnalysis } from "../../../types/analysis.js";
import { namedQueries } from "../sql/named-queries.js";
import { DriftQueryResolver } from "./drift-queries.js";

const DRIFT = `import '../table/club.dart';

clubStandings:
SELECT c.id, c.name FROM club_entity c
ORDER BY c.points DESC;

clubSquad(:club_id AS INTEGER):
SELECT p.* FROM player_entity p WHERE p.club_id = :club_id;
`;

describe("Drift named queries", () => {
  it("reads each `name:` block of a .drift file as a query", () => {
    expect(namedQueries(DRIFT.split("\n")).map((q) => `${q.name} ${q.line}-${q.endLine}`)).toEqual(["clubStandings 3-5", "clubSquad 7-8"]);
  });

  it("links a call through the generated accessor to the query of that file", () => {
    const drift: FileAnalysis = { ...createEmptyAnalysis("lib/db/query/club_table.drift", "sql"), functions: namedQueries(DRIFT.split("\n")) };
    const repo: FileAnalysis = {
      ...createEmptyAnalysis("lib/repositories/club.repository.dart", "dart"),
      functions: [{ name: "standings", params: [], returnType: null, isAsync: false, isExported: true, decorators: [], line: 4, endLine: 6,
        calls: [{ name: "_db.clubTableDrift.clubStandings", kind: "internal", target: null, line: 5 }, { name: "_db.clubTableDrift.missing", kind: "internal", target: null, line: 6 }] }],
    };
    expect(new DriftQueryResolver().resolve([drift, repo]).map((l) => `${l.sourceSymbol}:${l.sourceLine} → ${l.targetFile}#${l.targetSymbol}`)).toEqual([
      "standings:5 → lib/db/query/club_table.drift#clubStandings",
    ]);
  });
});
