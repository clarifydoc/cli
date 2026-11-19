import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { FileAnalysis } from "../types/analysis.js";
import { applyExtractPatterns, validateExtract } from "./config-patterns.js";

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

describe("applyExtractPatterns column", () => {
  it("states the 0-based UTF-16 column of the call, after a non-ASCII prefix too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clarifydoc-col-"));
    try {
      writeFileSync(join(dir, "a.ts"), 'apiGet("/cars");\n  const x = "é🚗"; apiGet("/clubs");\n');
      const a = { filePath: "a.ts", language: "typescript", dataSources: [] } as unknown as FileAnalysis;
      await applyExtractPatterns([a], dir, { httpCalls: [{ call: "apiGet", method: "GET" }] });
      expect(a.dataSources.map((d) => [d.target, d.line, d.column])).toEqual([["/cars", 1, 0], ["/clubs", 2, 19]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
