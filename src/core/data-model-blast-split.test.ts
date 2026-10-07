import { describe, it, expect } from "vitest";
import { buildClassGraph } from "./data-model-blast.js";
import type { FileAnalysis } from "../types/analysis.js";

const cls = (name: string, o: { properties?: number; methods?: number; extends?: string } = {}) => ({
  name, extends: o.extends ?? null, implements: [], decorators: [], isExported: true, line: 1, endLine: 9,
  properties: Array.from({ length: o.properties ?? 0 }, (_, i) => ({ name: `p${i}`, type: "int", visibility: null, isStatic: false, isReadonly: false })),
  methods: Array.from({ length: o.methods ?? 0 }, (_, i) => ({ name: `m${i}`, params: [], returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: 2, endLine: 3 })),
});
const file = (filePath: string, language: string, classes: ReturnType<typeof cls>[], typeReferences: unknown[] = []): FileAnalysis =>
  ({ filePath, language, projectId: "root", classes, imports: [], exports: [], functions: [], typeReferences } as unknown as FileAnalysis);
const ref = (sourceFile: string, sourceClass: string, typeName: string) =>
  ({ rawType: typeName, typeName, usageKind: "field", sourceFile, sourceLine: 1, sourceSymbol: sourceClass, sourceClass });

describe("buildClassGraph — types split across files", () => {
  it("draws one node for a Go struct and its method stubs, at the richest part", () => {
    const g = buildClassGraph([
      file("repo/pg.go", "go", [cls("PgRepo", { properties: 2 })]),
      file("repo/pg_find.go", "go", [cls("PgRepo", { methods: 1 })], [ref("repo/pg_find.go", "PgRepo", "DB")]),
      file("repo/db.go", "go", [cls("DB", { properties: 1 })]),
      file("svc/svc.go", "go", [cls("Svc", { properties: 1 })], [ref("svc/svc.go", "Svc", "PgRepo")]),
    ]);
    const pg = g.nodes.filter((n) => n.name === "PgRepo");
    expect(pg.map((n) => n.id)).toEqual(["repo/pg.go::PgRepo"]);
    expect(pg[0]!.isInterface).toBe(false);
    expect(g.edges.map((e) => `${e.source}→${e.target}`).sort()).toEqual([
      "repo/pg.go::PgRepo→repo/db.go::DB",
      "svc/svc.go::Svc→repo/pg.go::PgRepo",
    ]);
  });

  it("keeps same-named classes of one directory apart where types do not span files", () => {
    const g = buildClassGraph([
      file("app/a.py", "python", [cls("Svc", { methods: 1 })]),
      file("app/b.py", "python", [cls("Svc", { methods: 1 })]),
    ]);
    expect(g.nodes.filter((n) => n.name === "Svc").length).toBe(2);
  });
});
