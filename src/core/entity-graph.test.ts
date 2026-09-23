import { describe, it, expect } from "vitest";
import { synthesizeReferencedTableEntities, propagateStiRelations, buildEntityGraph, tableMatchKeys } from "./entity-graph.js";
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
      [analysis("m.php", ["orders", "customers", "orders", "order_rows"])],
      g,
    );
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["customers", "order_rows", "orders"]);
    expect(g.nodes.every((n) => n.orm === "inferred")).toBe(true);
  });

  it("does NOT duplicate a table that already has an ORM entity (singular/plural)", async () => {
    const g = graph(["Order", "User"]); // real Prisma entities
    synthesizeReferencedTableEntities(
      [analysis("m.php", ["orders", "users", "photos"])],
      g,
    );
    // orders→Order and users→User are covered; only photos is new.
    const added = g.nodes.filter((n) => n.orm === "inferred").map((n) => n.name);
    expect(added).toEqual(["photos"]);
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
        { kind: "database", name: "q", target: "orders", entity: "orders", line: 1, calls: [] },
        { kind: "database", name: "q", target: "customers", entity: "customers", line: 2, calls: [] },
      ],
      entityRelations: [
        {
          fromEntity: "orders",
          fromField: "customer_id",
          toEntity: "customers",
          cardinality: "many-to-one",
          foreignKey: "customer_id",
          orm: "ci-query",
          confidence: "INFERRED",
        },
      ],
    } as unknown as FileAnalysis;

    synthesizeReferencedTableEntities([a], g);
    expect(g.nodes.map((n) => n.name).sort()).toEqual(["customers", "orders"]);
    expect(g.edges).toHaveLength(1);
    const e = g.edges[0]!;
    expect(e.foreignKey).toBe("customer_id");
    // customers must render as the "one" side, orders as "many".
    const oneSide = e.sourceCardinality === "one" ? e.source : e.target;
    expect(g.nodes.find((n) => n.id === oneSide)!.name).toBe("customers");
  });

  it("does not emit edges for ORM relations (only ci-query)", async () => {
    const g = graph(["Order", "Customer"]);
    const a = {
      filePath: "m.php",
      dataSources: [],
      entityRelations: [
        { fromEntity: "Order", fromField: "customer", toEntity: "Customer", cardinality: "many-to-one", orm: "eloquent" },
      ],
    } as unknown as FileAnalysis;
    synthesizeReferencedTableEntities([a], g);
    expect(g.edges).toHaveLength(0); // eloquent edges are buildEntityGraph's job
  });
});

describe("ORM-suffix dedupe (JPA `XEntity` classes vs repository-derived names)", () => {
  it("does NOT synthesize a node when a real `<name>Entity` class covers the table", () => {
    const g = graph(["CustomerEntity", "CachedItemEntity"]);
    synthesizeReferencedTableEntities(
      [analysis("a.java", ["customer", "cachedItem"])],
      g,
    );
    expect(g.nodes.filter((n) => n.orm === "inferred")).toEqual([]);
  });

  it("still synthesizes genuinely unmodeled tables next to Entity-suffixed ones", () => {
    const g = graph(["CustomerEntity"]);
    synthesizeReferencedTableEntities([analysis("a.java", ["customer", "auditlog"])], g);
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
        rel("ChangeRequest", "employee", "Employee"),
        rel("ChangeRequest", "department", "Department"),
      ]),
      file("duty_change_request.rb", [entityClass("DutyChangeRequest", "ChangeRequest")], [
        rel("DutyChangeRequest", "duty", "Duty"),
      ]),
      // Grandchild in a separate file, declaring NO relations of its own.
      file("time_duty_change_request.rb", [entityClass("TimeDutyChangeRequest", "DutyChangeRequest")]),
      file("employee.rb", [entityClass("Employee", "IdaModel")]),
      file("department.rb", [entityClass("Department", "IdaModel")]),
      file("duty.rb", [entityClass("Duty", "IdaModel")]),
    ];

    propagateStiRelations(analyses);

    const relsOf = (fp: string) =>
      (analyses.find((a) => a.filePath === fp)!.entityRelations ?? []).map((r) => `${r.fromEntity}.${r.fromField}->${r.toEntity}`);

    // DutyChangeRequest keeps its own `duty` and inherits employee+department.
    expect(relsOf("duty_change_request.rb").sort()).toEqual([
      "DutyChangeRequest.department->Department",
      "DutyChangeRequest.duty->Duty",
      "DutyChangeRequest.employee->Employee",
    ]);
    // The grandchild inherits all three, transitively.
    expect(relsOf("time_duty_change_request.rb").sort()).toEqual([
      "TimeDutyChangeRequest.department->Department",
      "TimeDutyChangeRequest.duty->Duty",
      "TimeDutyChangeRequest.employee->Employee",
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
    for (const target of ["Employee", "Department", "Duty"]) {
      expect(touches("TimeDutyChangeRequest", target)).toBe(true);
    }
  });

  it("does not duplicate a relation the subclass overrides, and is a no-op without STI", () => {
    const analyses = [
      file("base.rb", [entityClass("Base", "ApplicationRecord")], [rel("Base", "owner", "User")]),
      // Child overrides `owner` to point at Admin instead of User.
      file("child.rb", [entityClass("Child", "Base")], [
        { ...rel("Child", "owner", "Admin") },
      ]),
      file("user.rb", [entityClass("User", "ApplicationRecord")]),
      file("admin.rb", [entityClass("Admin", "ApplicationRecord")]),
    ];
    propagateStiRelations(analyses);
    const childRels = analyses.find((a) => a.filePath === "child.rb")!.entityRelations!;
    // Only the child's own `owner->Admin`; the base's `owner->User` is NOT added
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
  });
});
