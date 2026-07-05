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
