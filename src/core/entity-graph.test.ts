import { describe, it, expect } from "vitest";
import { synthesizeReferencedTableEntities } from "./entity-graph.js";
import type { EntityGraph, FileAnalysis } from "../types/analysis.js";

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
