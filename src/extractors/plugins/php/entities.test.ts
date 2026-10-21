import { describe, it, expect } from "vitest";
import { PhpEntityExtractor } from "./entities.js";
import type { EntityRelation, FileAnalysis } from "../../../types/analysis.js";

/**
 * CodeIgniter has no schema/FK metadata (tables are bare strings), so a
 * query-builder `->join('table', 'a.x = b.y')` ON condition is the only
 * relationship signal. The extractor derives a `many → one` relation, taking
 * direction from the FK column name — not from which table was joined.
 */
function ciRelationsOf(src: string): EntityRelation[] {
  const lines = src.split("\n");
  const analysis = { filePath: "m.php", classes: [] } as unknown as FileAnalysis;
  return new PhpEntityExtractor()
    .extract({ analysis, sourceText: src, lines })
    .relations.filter((r) => r.orm === "ci-query");
}

describe("CodeIgniter query-builder join relations", () => {
  it("orients many→one from the FK column, not the joined table", () => {
    // cars owns driver_id (FK) → many; drivers is the referenced one side.
    const rels = ciRelationsOf(
      `<?php class Cars_model extends CI_Model {
        function g(){ $this->db->from('cars')->join('drivers','cars.driver_id = drivers.driver_id'); }
      }`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]!.fromEntity).toBe("cars");
    expect(rels[0]!.toEntity).toBe("drivers");
    expect(rels[0]!.cardinality).toBe("many-to-one");
    expect(rels[0]!.foreignKey).toBe("driver_id");
  });

  it("gets the same direction whichever table is the join() argument", () => {
    const rels = ciRelationsOf(
      `<?php class M { function f(){ $this->db->join('car_rows','car_rows.car_id = cars.car_id'); } }`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]!.fromEntity).toBe("car_rows"); // owns car_id (not its own PK)
    expect(rels[0]!.toEntity).toBe("cars");
  });

  it("ignores conditions that aren't table.column = table.column", () => {
    expect(ciRelationsOf(`<?php class M { function f(){ $this->db->join('x','1 = 1'); } }`)).toHaveLength(0);
  });

  it("dedupes a relationship joined across many queries", () => {
    const rels = ciRelationsOf(
      `<?php class M {
        function a(){ $this->db->join('drivers','cars.driver_id = drivers.driver_id'); }
        function b(){ $this->db->join('drivers','cars.driver_id = drivers.driver_id'); }
      }`,
    );
    expect(rels).toHaveLength(1);
  });
});

/**
 * Project-level Eloquent join: a `Model::verb` row is a query only when the
 * project declares `Model`; a relation chain names its table through the
 * model that declares the relation; verb-sharing facades are removed.
 */
describe("Eloquent access resolution across files", () => {
  const db = (name: string, line: number): any => ({ kind: "database", name, target: null, line, calls: [] });
  const model = (name: string): any => ({
    name, extends: "Model", implements: [], decorators: ["entity", "eloquent"], methods: [], properties: [], isExported: true, line: 1, endLine: 20,
  });

  it("sets the entity from the static root, a relation call, a typed receiver or the enclosing model, and drops the rest", () => {
    const player = { filePath: "app/Models/Player.php", language: "php", classes: [model("Player")], functions: [], dataSources: [],
      entityRelations: [{ fromEntity: "Player", fromField: "clubs", toEntity: "Club", cardinality: "one-to-many", orm: "eloquent", confidence: "EXTRACTED" }] } as unknown as FileAnalysis;
    const club = { filePath: "app/Models/Club.php", language: "php", classes: [{ ...model("Club"), methods: [
      { name: "scopeActive", params: [{ name: "query", type: "Builder" }], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 5, endLine: 8 },
    ] }], functions: [], dataSources: [db("$query->where('active', 1)->get", 6), db("static::where('x', 1)->first", 7)] } as unknown as FileAnalysis;
    const repo = { filePath: "app/Repositories/ClubRepository.php", language: "php", classes: [{
      name: "ClubRepository", extends: null, implements: [], decorators: [], properties: [{ name: "player", type: "Player", visibility: "private", isStatic: false, isReadonly: false }],
      methods: [{ name: "find", params: [{ name: "club", type: "Club" }], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 10, endLine: 30 }],
      isExported: true, line: 3, endLine: 40,
    }], functions: [], dataSources: [
      db("Club::where('active', 1)->get", 11),
      db("$this->player->clubs()->where('name', $n)->first", 12),
      db("$club->save", 13),
      db("Carbon::create", 14),
      db("$query->first", 15),
      db("$pdo->query('SELECT 1')->fetchAll", 16),
      { kind: "database", name: "$this->db->get", target: "cars", entity: "cars", line: 17, calls: [] },
    ] } as unknown as FileAnalysis;

    new PhpEntityExtractor().reconcileProject([player, club, repo]);

    expect(repo.dataSources.map((d) => [d.name, d.entity ?? null])).toEqual([
      ["Club::where('active', 1)->get", "Club"],
      ["$this->player->clubs()->where('name', $n)->first", "Club"],
      ["$club->save", "Club"],
      ["$pdo->query('SELECT 1')->fetchAll", null],
      ["$this->db->get", "cars"],
    ]);
    expect(club.dataSources.map((d) => d.entity)).toEqual(["Club", "Club"]);
  });

  it("leaves a project with no Eloquent models untouched", () => {
    const a = { filePath: "x.php", language: "php", classes: [], functions: [], dataSources: [db("Carbon::create", 1)] } as unknown as FileAnalysis;
    new PhpEntityExtractor().reconcileProject([a]);
    expect(a.dataSources).toHaveLength(1);
  });
});
