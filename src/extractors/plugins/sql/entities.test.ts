import { describe, it, expect } from "vitest";
import { migrationVersion, schemaOpsOf } from "./entities.js";

describe("SQL schema operations", () => {
  it("reads ALTER actions, inline and table-level foreign keys, renames and drops", () => {
    const ops = schemaOpsOf(`
CREATE TABLE IF NOT EXISTS "cars" (
  id bigint PRIMARY KEY,
  driver_id bigint REFERENCES drivers(id),
  CONSTRAINT fk_shop FOREIGN KEY (shop_id) REFERENCES shops (id)
);
ALTER TABLE ONLY cars
  ADD COLUMN IF NOT EXISTS note text,
  ADD CONSTRAINT pk_x PRIMARY KEY (id),
  DROP CONSTRAINT old_fk,
  DROP COLUMN legacy,
  RENAME COLUMN note TO remark;
ALTER TABLE cars CHANGE COLUMN remark remarks TEXT; -- MySQL
ALTER TABLE cars RENAME TO used_cars;
RENAME TABLE a TO b;
DROP TABLE IF EXISTS x, y CASCADE;
/* ALTER TABLE ghosts ADD COLUMN boo int; */
`.split("\n")).map((o) => [o.op, o.table, o.column ?? "", o.to ?? ""].join(" ").trim());
    expect(ops).toEqual([
      "create-table cars",
      "add-foreign-key cars driver_id drivers",
      "add-foreign-key cars shop_id shops",
      "add-column cars note",
      "drop-column cars legacy",
      "rename-column cars note remark",
      "rename-column cars remark remarks",
      "rename-table cars  used_cars",
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
    // Diesel: one directory per migration.
    expect(v("migrations/sqlite/2022-03-02-210038_rebuild_garages/up.sql")).toBe("20220302210038");
    expect(v("migrations/sqlite/2022-03-02-210038_rebuild_garages/down.sql")).toBeNull();
    expect([v("db/U10__x.sql"), v("db/R__views.sql"), v("migrations/000002_add.down.sql"), v("db/schema.sql")]).toEqual([null, null, null, null]);
  });
});

describe("schema statements split by GO", () => {
  it("reads each batch of a script without semicolons", () => {
    const ops = schemaOpsOf(`CREATE TABLE [dbo].[Clubs] (
  [Id] INT NOT NULL PRIMARY KEY
)
GO
CREATE TABLE [dbo].[Players] (
  [Id] INT NOT NULL PRIMARY KEY,
  [ClubId] INT NOT NULL REFERENCES [dbo].[Clubs]([Id])
)
GO`.split("\n"));
    expect(ops.map((o) => `${o.op} ${o.table}${o.to ? ` → ${o.to}` : ""} @${o.line}`)).toEqual([
      "create-table dbo.Clubs @1",
      "create-table dbo.Players @5",
      "add-foreign-key dbo.Players → dbo.Clubs @5",
    ]);
  });
});
