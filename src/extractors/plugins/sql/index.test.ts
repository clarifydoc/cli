import { describe, it, expect } from "vitest";
import { sqlSpec } from "./index.js";

const rows = (sql: string) => sqlSpec.extractDataSources!(sql.split("\n"), []);

describe("SQL DML rows name their table", () => {
  it("sets entity to the bare table of INSERT / UPDATE / DELETE / SELECT", () => {
    const out = rows(`INSERT INTO public.person (name) VALUES ('a');
UPDATE "game" SET title = 'x';
DELETE FROM [dbo].[Cars] WHERE id = 1;
SELECT id FROM community WHERE id = 2;`);
    expect(out.map((r) => [r.name, r.entity, r.access])).toEqual([
      ["INSERT INTO", "person", "write"],
      ["UPDATE", "game", "write"],
      ["DELETE", "Cars", "write"],
      ["SELECT", "community", "read"],
    ]);
  });

  it("reads a SELECT whose FROM is on a later line, and skips table functions", () => {
    const out = rows(`SELECT p.id,
       p.name
  FROM person p
 WHERE p.id = 1;
SELECT * FROM generate_series(1, 3);`);
    expect(out.map((r) => r.entity)).toEqual(["person"]);
  });
});

describe("SQL DML rows skip relations that are not tables", () => {
  it("drops CTEs, transition tables, catalogs and a wrapped ON UPDATE CASCADE", () => {
    const out = rows(`WITH recent AS (SELECT id FROM game)
SELECT * FROM recent;
SELECT relname FROM pg_class;
SELECT * FROM information_schema.views;
    player_id int REFERENCES person ON
    UPDATE CASCADE ON DELETE CASCADE;
CREATE TRIGGER t AFTER DELETE ON ball REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION f();
SELECT count(*) FROM
  old_rows;`);
    expect(out.filter((r) => r.entity).map((r) => r.entity)).toEqual([]);
  });
});
