import { describe, it, expect } from "vitest";
import { synthesizeReferencedTableEntities, propagateStiRelations, buildEntityGraph, tableMatchKeys, reconcileEntityInheritance } from "./entity-graph.js";
import type { EntityGraph, EntityRelation, FileAnalysis } from "../types/analysis.js";

/**
 * `synthesizeReferencedTableEntities` adds ER nodes for tables that are queried
 * (a `database` data source's `entity`) but never modeled as an ORM entity —
 * the CodeIgniter/knex/raw-SQL case. It must dedupe against real entities (so
 * ORM projects are untouched) and reject non-table noise.
 */
function analysis(filePath: string, dbEntities: (string | null)[]): FileAnalysis {
  return {
    filePath,
    dataSources: dbEntities.map((entity, i) => ({
      kind: "database" as const,
      name: "q",
      target: entity,
      entity: entity ?? undefined,
      line: i + 1,
      calls: [],
    })),
  } as unknown as FileAnalysis;
}

const graph = (names: string[]): EntityGraph => ({
  nodes: names.map((n) => ({
    id: `f.ts::${n}`,
    name: n,
    orm: "prisma",
    kind: "entity" as const,
    filePath: "f.ts",
    columns: [],
    line: 1,
  })),
  edges: [],
});

describe("synthesizeReferencedTableEntities", () => {
  it("adds an 'inferred' node per referenced table with no entity, deduped", async () => {
    const g = graph([]);
    synthesizeReferencedTableEntities(
      [analysis("m.php", ["cars", "drivers", "cars", "car_parts"])],
      g,
    );
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["car_parts", "cars", "drivers"]);
    expect(g.nodes.every((n) => n.orm === "inferred")).toBe(true);
  });

  it("does NOT duplicate a table that already has an ORM entity (singular/plural)", async () => {
    const g = graph(["Car", "Player"]); // real Prisma entities
    synthesizeReferencedTableEntities(
      [analysis("m.php", ["cars", "players", "photos"])],
      g,
    );
    // cars→Car and players→Player are covered; only photos is new.
    const added = g.nodes.filter((n) => n.orm === "inferred").map((n) => n.name);
    expect(added).toEqual(["photos"]);
  });

  it("matches a query on the physical table an entity maps to, not only its class name", () => {
    const g = graph(["Player"]);
    g.nodes[0]!.table = "app_players"; // `@Table(name = "app_players") class Player`
    synthesizeReferencedTableEntities([analysis("PlayerMapper.xml", ["app_players", "audit_log"])], g);
    expect(g.nodes.filter((n) => n.orm === "inferred").map((n) => n.name)).toEqual(["audit_log"]);
  });

  it("adds no node for a table the querying migration itself creates, renames or drops", () => {
    // Real-repo FP: a table rebuild (`CREATE garages_new`, copy, `DROP garages`, `RENAME garages_new TO garages`).
    const g = graph([]);
    const rebuild = {
      ...analysis("migrations/2022-03-02-210038_rebuild_garages/up.sql", ["garages_new", "old_cars", "drivers"]),
      schemaOps: [
        { op: "create-table", table: "garages_new", line: 1 },
        { op: "drop-table", table: "garages", line: 9 },
        { op: "rename-table", table: "garages_new", to: "garages", line: 10 },
        { op: "rename-table", table: "cars", to: "old_cars", line: 11 },
      ],
    } as FileAnalysis;
    synthesizeReferencedTableEntities([rebuild], g);
    expect(g.nodes.map((n) => n.name)).toEqual(["drivers"]);
  });

  it("adds no node for a name only a test queries", () => {
    const g = graph([]);
    synthesizeReferencedTableEntities(
      [{ ...analysis("src/test/java/com/example/league/MatchServiceTest.java", ["MatchRowSetter"]), language: "java" } as FileAnalysis, analysis("m.php", ["fixtures"])],
      g,
    );
    expect(g.nodes.map((n) => n.name)).toEqual(["fixtures"]);
  });

  it("rejects non-table noise (template/var names) and empty entities", async () => {
    const g = graph([]);
    synthesizeReferencedTableEntities(
      [analysis("c.vue", ["$el", "$backdrop", "a.b.c", null, "real_table"])],
      g,
    );
    expect(g.nodes.map((n) => n.name)).toEqual(["real_table"]);
  });

  it("builds edges from ci-query join relations between table nodes", async () => {
    const g = graph([]);
    const a = {
      filePath: "m.php",
      dataSources: [
        { kind: "database", name: "q", target: "cars", entity: "cars", line: 1, calls: [] },
        { kind: "database", name: "q", target: "drivers", entity: "drivers", line: 2, calls: [] },
      ],
      entityRelations: [
        {
          fromEntity: "cars",
          fromField: "driver_id",
          toEntity: "drivers",
          cardinality: "many-to-one",
          foreignKey: "driver_id",
          orm: "ci-query",
          confidence: "INFERRED",
        },
      ],
    } as unknown as FileAnalysis;

    synthesizeReferencedTableEntities([a], g);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["cars", "drivers"]);
    expect(g.edges).toHaveLength(1);
    const e = g.edges[0]!;
    expect(e.foreignKey).toBe("driver_id");
    // drivers must render as the "one" side, cars as "many".
    const oneSide = e.sourceCardinality === "one" ? e.source : e.target;
    expect(g.nodes.find((n) => n.id === oneSide)!.name).toBe("drivers");
  });

  it("does not emit edges for ORM relations (only ci-query)", async () => {
    const g = graph(["Car", "Driver"]);
    const a = {
      filePath: "m.php",
      dataSources: [],
      entityRelations: [
        { fromEntity: "Car", fromField: "driver", toEntity: "Driver", cardinality: "many-to-one", orm: "eloquent" },
      ],
    } as unknown as FileAnalysis;
    synthesizeReferencedTableEntities([a], g);
    expect(g.edges).toHaveLength(0); // eloquent edges are buildEntityGraph's job
  });
});

describe("ORM-suffix dedupe (JPA `XEntity` classes vs repository-derived names)", () => {
  it("does NOT synthesize a node when a real `<name>Entity` class covers the table", () => {
    const g = graph(["DriverEntity", "CachedItemEntity"]);
    synthesizeReferencedTableEntities(
      [analysis("a.java", ["driver", "cachedItem"])],
      g,
    );
    expect(g.nodes.filter((n) => n.orm === "inferred")).toEqual([]);
  });

  it("still synthesizes genuinely unmodeled tables next to Entity-suffixed ones", () => {
    const g = graph(["DriverEntity"]);
    synthesizeReferencedTableEntities([analysis("a.java", ["driver", "auditlog"])], g);
    expect(g.nodes.filter((n) => n.orm === "inferred").map((n) => n.name)).toEqual(["auditlog"]);
  });
});

describe("propagateStiRelations — STI subclasses inherit their base's relations", () => {
  const entityClass = (name: string, ext: string | null) => ({
    name,
    extends: ext,
    decorators: ["entity", "active-record"],
    properties: [],
    methods: [],
    implements: [],
    line: 1,
    endLine: 2,
    isExported: true,
  });
  const file = (
    filePath: string,
    classes: ReturnType<typeof entityClass>[],
    entityRelations: Partial<EntityRelation>[] = [],
  ): FileAnalysis => ({ filePath, classes, entityRelations } as unknown as FileAnalysis);

  const rel = (from: string, field: string, to: string): Partial<EntityRelation> => ({
    fromEntity: from,
    fromField: field,
    toEntity: to,
    cardinality: "many-to-one",
    orm: "active-record",
    confidence: "EXTRACTED",
  });

  it("re-homes a base's relations onto a cross-file STI subclass chain", () => {
    const analyses = [
      file("change_request.rb", [entityClass("ChangeRequest", "IdaModel")], [
        rel("ChangeRequest", "referee", "Referee"),
        rel("ChangeRequest", "department", "Department"),
      ]),
      file("duty_change_request.rb", [entityClass("DutyChangeRequest", "ChangeRequest")], [
        rel("DutyChangeRequest", "duty", "Duty"),
      ]),
      // Grandchild in a separate file, declaring NO relations of its own.
      file("time_duty_change_request.rb", [entityClass("TimeDutyChangeRequest", "DutyChangeRequest")]),
      file("referee.rb", [entityClass("Referee", "IdaModel")]),
      file("department.rb", [entityClass("Department", "IdaModel")]),
      file("duty.rb", [entityClass("Duty", "IdaModel")]),
    ];

    propagateStiRelations(analyses);

    const relsOf = (fp: string) =>
      (analyses.find((a) => a.filePath === fp)!.entityRelations ?? []).map((r) => `${r.fromEntity}.${r.fromField}->${r.toEntity}`);

    // DutyChangeRequest keeps its own `duty` and inherits referee+department.
    expect(relsOf("duty_change_request.rb").sort()).toEqual([
      "DutyChangeRequest.department->Department",
      "DutyChangeRequest.duty->Duty",
      "DutyChangeRequest.referee->Referee",
    ]);
    // The grandchild inherits all three, transitively.
    expect(relsOf("time_duty_change_request.rb").sort()).toEqual([
      "TimeDutyChangeRequest.department->Department",
      "TimeDutyChangeRequest.duty->Duty",
      "TimeDutyChangeRequest.referee->Referee",
    ]);
    // Inherited copies are marked INFERRED (only declared ones stay EXTRACTED).
    const inherited = analyses
      .find((a) => a.filePath === "time_duty_change_request.rb")!
      .entityRelations!;
    expect(inherited.every((r) => r.confidence === "INFERRED")).toBe(true);

    // End-to-end: the grandchild is now connected in the graph, not an island.
    const g = buildEntityGraph(analyses);
    const nid = (n: string) => g.nodes.find((x) => x.name === n)!.id;
    const touches = (aName: string, bName: string) =>
      g.edges.some(
        (e) =>
          (e.source === nid(aName) && e.target === nid(bName)) ||
          (e.source === nid(bName) && e.target === nid(aName)),
      );
    for (const target of ["Referee", "Department", "Duty"]) {
      expect(touches("TimeDutyChangeRequest", target)).toBe(true);
    }
  });

  it("does not duplicate a relation the subclass overrides, and is a no-op without STI", () => {
    const analyses = [
      file("base.rb", [entityClass("Base", "ApplicationRecord")], [rel("Base", "owner", "Player")]),
      // Child overrides `owner` to point at Admin instead of Player.
      file("child.rb", [entityClass("Child", "Base")], [
        { ...rel("Child", "owner", "Admin") },
      ]),
      file("player.rb", [entityClass("Player", "ApplicationRecord")]),
      file("admin.rb", [entityClass("Admin", "ApplicationRecord")]),
    ];
    propagateStiRelations(analyses);
    const childRels = analyses.find((a) => a.filePath === "child.rb")!.entityRelations!;
    // Only the child's own `owner->Admin`; the base's `owner->Player` is NOT added
    // (same field = an override).
    expect(childRels.map((r) => `${r.fromField}->${r.toEntity}`)).toEqual(["owner->Admin"]);

    // A standalone entity with no entity ancestor is untouched.
    const solo = [file("s.rb", [entityClass("Solo", "ApplicationRecord")], [rel("Solo", "x", "Y")])];
    propagateStiRelations(solo);
    expect(solo[0]!.entityRelations).toHaveLength(1);
  });
});

describe("tableMatchKeys", () => {
  it("strips an `entity` affix on either side, so repository-derived names meet the class", () => {
    // `RepositoryClass` → access entity "Class" must meet the `EntityClass` node,
    // just as `ClassRepository` → "Class" meets `ClassEntity`.
    expect(tableMatchKeys("EntityClass")).toContain("class");
    expect(tableMatchKeys("ClassEntity")).toContain("class");
    expect(tableMatchKeys("EntityRooms")).toContain("room");
    expect(tableMatchKeys("Entity")).toEqual(["entity"]);
    expect(tableMatchKeys("PlayerProgresses")).toContain("playerprogress");
    expect(tableMatchKeys("Matches")).toContain("match");
    expect(tableMatchKeys("Categories")).toContain("category");
  });
});

describe("buildEntityGraph — an API contract split into several documents", () => {
  const spec = (filePath: string, props: string[]): FileAnalysis =>
    ({
      filePath,
      language: "openapi",
      projectId: "root",
      classes: [
        { name: "Club", decorators: ["entity", "openapi"], properties: props.map((p) => ({ name: p, type: "string" })), line: 3 },
        { name: "Player", decorators: ["entity", "openapi"], properties: [{ name: "id", type: "integer" }], line: 9 },
      ],
      entityRelations: [{ fromEntity: "Club", fromField: "captain", toEntity: "Player", cardinality: "many-to-one", orm: "openapi" }],
    }) as unknown as FileAnalysis;

  it("keeps one node per schema name and shape, and one edge between them", () => {
    const g = buildEntityGraph([spec("swagger/swagger.json", ["id", "name"]), spec("swagger/tag_groups/league.json", ["id", "name"]), spec("swagger/v2.json", ["id", "name", "city"])]);
    expect(g.nodes.map((n) => `${n.filePath}::${n.name}`)).toEqual([
      "swagger/swagger.json::Club",
      "swagger/swagger.json::Player",
      "swagger/v2.json::Club",
    ]);
    expect(g.edges).toHaveLength(2);
  });

  it("leaves the schemas out where the code declares the tables (real-repo FP: 388 of 507 nodes)", () => {
    const code = { filePath: "League.Database/Entities/Club.cs", language: "csharp", projectId: "league-database", classes: [{ name: "Club", decorators: ["entity", "ef-core"], properties: [], line: 1 }] } as unknown as FileAnalysis;
    const g = buildEntityGraph([spec("openapi.json", ["id", "name"]), code]);
    expect(g.nodes.map((n) => n.id)).toEqual(["League.Database/Entities/Club.cs::Club"]);
  });
});

describe("buildEntityGraph — a schema table and the entity mapping it", () => {
  const cls = (name: string, decorators: string[], props: string[], tableName?: string) =>
    ({ name, decorators, properties: props.map((p) => ({ name: p, type: null })), line: 1, methods: [], implements: [], ...(tableName ? { tableName } : {}) });
  const fileOf = (filePath: string, classes: unknown[], entityRelations: EntityRelation[] = []) =>
    ({ filePath, language: filePath.endsWith(".sql") ? "sql" : "rust", projectId: "root", classes, entityRelations }) as unknown as FileAnalysis;

  it("are one node, the entity's, and the script's foreign key joins it", () => {
    // Real-repo FP: every table twice — once from the migrations, once as the Diesel model.
    const g = buildEntityGraph([
      fileOf("migrations/2019-09-12-100000_create/up.sql", [cls("clubs", ["table"], ["uuid", "name"]), cls("players", ["table"], ["uuid", "club_uuid"]), cls("transfer_log", ["table"], ["id"])], [
        { fromEntity: "players", fromField: "club_uuid", toEntity: "clubs", cardinality: "many-to-one", foreignKey: "club_uuid", orm: "sql", confidence: "EXTRACTED" },
      ]),
      fileOf("src/db/models/club.rs", [cls("Club", ["entity", "diesel"], ["uuid", "name"], "clubs")]),
      fileOf("src/db/models/player.rs", [cls("Player", ["entity", "diesel"], ["uuid", "club_uuid"])]),
    ]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["migrations/2019-09-12-100000_create/up.sql::transfer_log", "src/db/models/club.rs::Club", "src/db/models/player.rs::Player"]);
    expect(g.edges.map((e) => `${e.source} ${e.target}`)).toEqual(["src/db/models/club.rs::Club src/db/models/player.rs::Player"]);
  });
});

describe("reconcileEntityInheritance", () => {
  it("does not make a code DTO an entity because an API schema shares its base's name (real-repo FP: 8 DTO nodes)", () => {
    const schema = { filePath: "openapi.json", language: "openapi", classes: [{ name: "ClubPublicDto", decorators: ["entity", "openapi"], properties: [], line: 1 }] } as unknown as FileAnalysis;
    const dto = { name: "ClubDto", extends: "ClubPublicDto", decorators: [] as string[], properties: [], line: 3 };
    const code = { filePath: "League.Models/ClubDto.cs", language: "csharp", classes: [dto] } as unknown as FileAnalysis;
    reconcileEntityInheritance([schema, code]);
    expect(dto.decorators).toEqual([]);
  });
});
