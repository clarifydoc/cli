import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { controlFlowForFile } from "./control-flow-file.js";
import { backwardSlice } from "./control-flow-slice.js";

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "clarifydoc-slice-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function sliceOf(name: string, source: string, line: number) {
  const file = join(dir, name);
  writeFileSync(file, source);
  const { cfgs } = await controlFlowForFile({ filePath: file, displayPath: name, line });
  const slice = backwardSlice(cfgs[0]!, readFileSync(file, "utf-8").split("\n"), line)!;
  return { lines: slice.statements.map((s) => [s.line, s.why]), outside: slice.fromOutside };
}

describe("backwardSlice", () => {
  it("keeps both arms that assign the value and the if that picks one, nothing unrelated", async () => {
    const src = [
      "export function search(req: any, db: any, admin: boolean) {",
      '  let sql = "SELECT * FROM orders";',
      "  const limit = 10;",
      "  if (admin) {",
      '    sql = "SELECT * FROM all_orders";',
      "  } else {",
      '    sql += " WHERE owner = " + req.query.user;',
      "  }",
      '  const label = "orders";',
      "  console.log(label);",
      '  return db.query(sql + " LIMIT " + limit);',
      "}",
    ].join("\n");
    const { lines, outside } = await sliceOf("q.ts", src, 11);
    expect(lines).toEqual([[2, "data"], [3, "data"], [4, "control"], [5, "data"], [7, "data"], [11, "criterion"]]);
    expect(outside).toEqual(["admin", "db", "req"]);
  });

  it("follows a loop variable to what it iterates, in Python", async () => {
    const src = [
      "def total(orders, rate):",
      "    acc = 0",
      "    unused = 1",
      "    for o in orders:",
      "        acc += o.price * rate",
      "    return acc",
    ].join("\n");
    const { lines, outside } = await sliceOf("t.py", src, 6);
    expect(lines).toEqual([[2, "data"], [4, "data"], [5, "data"], [6, "criterion"]]);
    expect(outside).toEqual(["orders", "rate"]);
  });
});
