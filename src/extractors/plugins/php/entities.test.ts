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
    // orders owns customer_id (FK) → many; customers is the referenced one side.
    const rels = ciRelationsOf(
      `<?php class Orders_model extends CI_Model {
        function g(){ $this->db->from('orders')->join('customers','orders.customer_id = customers.customer_id'); }
      }`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]!.fromEntity).toBe("orders");
    expect(rels[0]!.toEntity).toBe("customers");
    expect(rels[0]!.cardinality).toBe("many-to-one");
    expect(rels[0]!.foreignKey).toBe("customer_id");
  });

  it("gets the same direction whichever table is the join() argument", () => {
    const rels = ciRelationsOf(
      `<?php class M { function f(){ $this->db->join('order_rows','order_rows.order_id = orders.order_id'); } }`,
    );
    expect(rels).toHaveLength(1);
    expect(rels[0]!.fromEntity).toBe("order_rows"); // owns order_id (not its own PK)
    expect(rels[0]!.toEntity).toBe("orders");
  });

  it("ignores conditions that aren't table.column = table.column", () => {
    expect(ciRelationsOf(`<?php class M { function f(){ $this->db->join('x','1 = 1'); } }`)).toHaveLength(0);
  });

  it("dedupes a relationship joined across many queries", () => {
    const rels = ciRelationsOf(
      `<?php class M {
        function a(){ $this->db->join('customers','orders.customer_id = customers.customer_id'); }
        function b(){ $this->db->join('customers','orders.customer_id = customers.customer_id'); }
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
    const user = { filePath: "app/Models/User.php", language: "php", classes: [model("User")], functions: [], dataSources: [],
      entityRelations: [{ fromEntity: "User", fromField: "accounts", toEntity: "Account", cardinality: "one-to-many", orm: "eloquent", confidence: "EXTRACTED" }] } as unknown as FileAnalysis;
    const account = { filePath: "app/Models/Account.php", language: "php", classes: [{ ...model("Account"), methods: [
      { name: "scopeActive", params: [{ name: "query", type: "Builder" }], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 5, endLine: 8 },
    ] }], functions: [], dataSources: [db("$query->where('active', 1)->get", 6), db("static::where('x', 1)->first", 7)] } as unknown as FileAnalysis;
    const repo = { filePath: "app/Repositories/AccountRepository.php", language: "php", classes: [{
      name: "AccountRepository", extends: null, implements: [], decorators: [], properties: [{ name: "user", type: "User", visibility: "private", isStatic: false, isReadonly: false }],
      methods: [{ name: "find", params: [{ name: "account", type: "Account" }], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 10, endLine: 30 }],
      isExported: true, line: 3, endLine: 40,
    }], functions: [], dataSources: [
      db("Account::where('active', 1)->get", 11),
      db("$this->user->accounts()->where('name', $n)->first", 12),
      db("$account->save", 13),
      db("Carbon::create", 14),
      db("$query->first", 15),
      db("$pdo->query('SELECT 1')->fetchAll", 16),
      { kind: "database", name: "$this->db->get", target: "orders", entity: "orders", line: 17, calls: [] },
    ] } as unknown as FileAnalysis;

    new PhpEntityExtractor().reconcileProject([user, account, repo]);

    expect(repo.dataSources.map((d) => [d.name, d.entity ?? null])).toEqual([
      ["Account::where('active', 1)->get", "Account"],
      ["$this->user->accounts()->where('name', $n)->first", "Account"],
      ["$account->save", "Account"],
      ["$pdo->query('SELECT 1')->fetchAll", null],
      ["$this->db->get", "orders"],
    ]);
    expect(account.dataSources.map((d) => d.entity)).toEqual(["Account", "Account"]);
  });

  it("leaves a project with no Eloquent models untouched", () => {
    const a = { filePath: "x.php", language: "php", classes: [], functions: [], dataSources: [db("Carbon::create", 1)] } as unknown as FileAnalysis;
    new PhpEntityExtractor().reconcileProject([a]);
    expect(a.dataSources).toHaveLength(1);
  });
});
