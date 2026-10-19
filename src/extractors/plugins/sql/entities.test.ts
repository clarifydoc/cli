import { describe, it, expect } from "vitest";
import { migrationVersion, schemaOpsOf } from "./entities.js";

describe("SQL schema operations", () => {
  it("reads ALTER actions, inline and table-level foreign keys, renames and drops", () => {
    const ops = schemaOpsOf(`
CREATE TABLE IF NOT EXISTS "orders" (
  id bigint PRIMARY KEY,
  customer_id bigint REFERENCES customers(id),
  CONSTRAINT fk_shop FOREIGN KEY (shop_id) REFERENCES shops (id)
);
ALTER TABLE ONLY orders
  ADD COLUMN IF NOT EXISTS note text,
  ADD CONSTRAINT pk_x PRIMARY KEY (id),
  DROP CONSTRAINT old_fk,
  DROP COLUMN legacy,
  RENAME COLUMN note TO remark;
ALTER TABLE orders CHANGE COLUMN remark remarks TEXT; -- MySQL
ALTER TABLE orders RENAME TO purchase_orders;
RENAME TABLE a TO b;
DROP TABLE IF EXISTS x, y CASCADE;
/* ALTER TABLE ghosts ADD COLUMN boo int; */
`.split("\n")).map((o) => [o.op, o.table, o.column ?? "", o.to ?? ""].join(" ").trim());
    expect(ops).toEqual([
      "create-table orders",
      "add-foreign-key orders customer_id customers",
      "add-foreign-key orders shop_id shops",
      "add-column orders note",
      "drop-column orders legacy",
      "rename-column orders note remark",
      "rename-column orders remark remarks",
      "rename-table orders  purchase_orders",
      "rename-table a  b",
      "drop-table x",
      "drop-table y",
    ]);
  });

  it("orders versioned migrations and leaves out undo, down and repeatable scripts", () => {
    const v = (p: string) => migrationVersion(p)?.join(".") ?? null;
    expect(v("db/migration/V10__x.sql")).toBe("10");
    expect(v("db/migration/V1_2__x.sql")).toBe("1.2");
    expect(v("migrations/000002_add.up.sql")).toBe("2");
    expect(v("migrations/20240101120000_init.sql")).toBe("20240101120000");
    expect([v("db/U10__x.sql"), v("db/R__views.sql"), v("migrations/000002_add.down.sql"), v("db/schema.sql")]).toEqual([null, null, null, null]);
  });
});
