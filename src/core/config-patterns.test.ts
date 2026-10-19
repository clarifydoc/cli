import { describe, it, expect } from "vitest";
import { validateExtract } from "./config-patterns.js";

describe("validateExtract", () => {
  it("keeps what it can use, and says what it dropped", () => {
    const warnings: string[] = [];
    const got = validateExtract({
      httpCalls: [{ call: "apiGet", method: "get" }, { call: "not a name" }],
      routes: [{ call: "app.route", methodArg: 0, pathArg: 1 }],
      db: [{ call: "repo.save", tableArg: 0, access: "write" }, { call: "db.raw" }],
    }, (m) => warnings.push(m));
    expect(got).toEqual({
      httpCalls: [{ call: "apiGet", method: "GET" }],
      routes: [{ call: "app.route", methodArg: 0, pathArg: 1 }],
      db: [{ call: "repo.save", tableArg: 0, access: "write" }],
    });
    expect(warnings).toEqual([
      'extract.httpCalls[1] needs a "call" (a function or method name); ignored',
      'extract.db[1] (db.raw) needs "tableArg" or "sqlArg"; ignored',
    ]);
    expect(validateExtract(["x"], (m) => warnings.push(m))).toBeUndefined();
  });
});
