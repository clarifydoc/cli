import { describe, it, expect } from "vitest";
import { resolveDataSourceStringConstants } from "./import-index.js";
import { createEmptyAnalysis, type FileAnalysis, type DataSourceInfo } from "../types/analysis.js";

function file(
  filePath: string,
  opts: { constants?: Record<string, string>; sources?: Partial<DataSourceInfo>[] } = {},
): FileAnalysis {
  const a = createEmptyAnalysis(filePath, filePath.endsWith(".pas") ? "pascal" : "dfm");
  if (opts.constants) a.stringConstants = opts.constants;
  a.dataSources = (opts.sources ?? []).map((s) => ({
    kind: "database",
    name: s.name ?? "x",
    target: s.target ?? null,
    calls: [],
    line: 1,
    ...s,
  })) as DataSourceInfo[];
  return a;
}

describe("resolveDataSourceStringConstants", () => {
  it("resolves through the project-wide union (the C++ header-macro case)", () => {
    const dao = file("src/dao.cpp", { sources: [{ target: "CUE_TABLE", entity: "CUE_TABLE" }] });
    resolveDataSourceStringConstants([
      file("src/schema.h", { constants: { CUE_TABLE: "cues" } }),
      dao,
    ]);
    expect(dao.dataSources[0]).toMatchObject({ target: "cues", entity: "cues" });
  });

  it("leaves project-wide CONFLICTING names unresolved", () => {
    const user = file("a/dao.cpp", { sources: [{ target: "T", entity: "T" }] });
    resolveDataSourceStringConstants([
      file("a/x.h", { constants: { T: "alpha" } }),
      file("b/y.h", { constants: { T: "beta" } }),
      user,
    ]);
    expect(user.dataSources[0]!.target).toBe("T");
  });

  it("companion scope wins where the global union is conflicted (IDE-default FDTable1 across projects)", () => {
    const pasA = file("proj-a/fMain.pas", { sources: [{ name: "FDTable1.Open", target: "FDTable1" }] });
    const pasB = file("proj-b/fMain.pas", { sources: [{ name: "FDTable1.Open", target: "FDTable1" }] });
    resolveDataSourceStringConstants([
      file("proj-a/fMain.fmx", { constants: { FDTable1: "squad" } }),
      file("proj-b/fMain.fmx", { constants: { FDTable1: "employee" } }),
      pasA,
      pasB,
    ]);
    // Each companion unit resolves to ITS form's table despite the global conflict.
    expect(pasA.dataSources[0]).toMatchObject({ target: "squad", entity: "squad" });
    expect(pasB.dataSources[0]).toMatchObject({ target: "employee", entity: "employee" });
  });

  it("backfills a missing entity when the target names a resolvable constant", () => {
    const pas = file("app/UReport.pas", { sources: [{ name: "qrySales.Open", target: "qrySales" }] });
    resolveDataSourceStringConstants([
      file("app/UReport.dfm", { constants: { qrySales: "sales" } }),
      pas,
    ]);
    expect(pas.dataSources[0]!.entity).toBe("sales");
  });

  it("falls back case-insensitively (Pascal casing drifts between form and code)", () => {
    const pas = file("app/UMain.pas", { sources: [{ name: "QrySales.Open", target: "QrySales" }] });
    resolveDataSourceStringConstants([
      file("app/UMain.dfm", { constants: { qrySales: "sales" } }),
      pas,
    ]);
    expect(pas.dataSources[0]).toMatchObject({ target: "sales", entity: "sales" });
  });

  it("never rewrites an entity that resolved to a real table already", () => {
    const pas = file("app/U.pas", { sources: [{ name: "SELECT", target: "orders", entity: "orders" }] });
    resolveDataSourceStringConstants([
      file("app/U.dfm", { constants: { qryX: "invoices" } }),
      pas,
    ]);
    expect(pas.dataSources[0]).toMatchObject({ target: "orders", entity: "orders" });
  });

  it("ignores non-database sources", () => {
    const pas = file("app/U.pas", {
      sources: [{ kind: "api-call", name: "GET", target: "qryX" } as Partial<DataSourceInfo>],
    });
    resolveDataSourceStringConstants([file("app/U.dfm", { constants: { qryX: "t" } }), pas]);
    expect(pas.dataSources[0]!.target).toBe("qryX");
  });
});
