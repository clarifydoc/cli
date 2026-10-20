import { describe, it, expect } from "vitest";
import { resolveDataSourceStringConstants, enrichFileDataSources, resolveImportSource } from "./import-index.js";
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

describe("Delphi dataset calls are not entities", () => {
  const pascal = (names: string[]): FileAnalysis => ({
    ...createEmptyAnalysis("Players.pas", "pascal"),
    dataSources: names.map((name, i) => ({
      kind: "database" as const,
      name,
      target: name.split(".")[0]!,
      calls: [],
      line: i + 1,
    })),
  });

  it("does not turn a dataset component into a table", () => {
    // `Query.FieldByName` is component.method, not Model.findOne — naming the
    // receiver invented tables called DataSet/Query/ADataSet across a whole Delphi app.
    const a = pascal(["Query.FieldByName", "DataSet.Open", "ADataSet.Post", "IBDataset.Locate"]);
    enrichFileDataSources(a);
    expect(a.dataSources.map((d) => d.entity)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("leaves the entity empty so the form's component→table map can fill it", () => {
    const a = pascal(["dsPlayerInfo.Open"]);
    enrichFileDataSources(a);
    // Empty, not "dsPlayerInfo" — resolveDataSourceStringConstants only
    // backfills the physical table while entity is still unset.
    expect(a.dataSources[0]!.entity).toBeUndefined();
  });

  it("still reads a real entity from a non-dataset call chain", () => {
    const a = pascal(["prisma.user.findMany"]);
    enrichFileDataSources(a);
    expect(a.dataSources[0]!.entity).toBe("user");
  });

  it("does not change other languages", () => {
    const a: FileAnalysis = {
      ...createEmptyAnalysis("app.ts", "typescript"),
      dataSources: [{ kind: "database", name: "User.findOne", target: "User", calls: [], line: 1 }],
    };
    enrichFileDataSources(a);
    expect(a.dataSources[0]!.entity).toBe("User");
  });
});

describe("resolveImportSource — Python relative imports", () => {
  const known = new Set(["pkg/cli.py", "pkg/graph.py", "pkg/__init__.py", "pkg/tools/build.py", "pkg/tools/__init__.py"]);

  it("resolves dotted relative modules against the importer's package", () => {
    expect(resolveImportSource("pkg/cli.py", ".graph", known, "GraphStore")).toBe("pkg/graph.py");
    expect(resolveImportSource("pkg/tools/build.py", "..graph", known, "GraphStore")).toBe("pkg/graph.py");
  });

  it("prefers the module a `from . import x` names over the package's __init__", () => {
    expect(resolveImportSource("pkg/cli.py", ".", known, "graph")).toBe("pkg/graph.py");
    expect(resolveImportSource("pkg/cli.py", ".", known, "VERSION")).toBe("pkg/__init__.py");
    expect(resolveImportSource("pkg/cli.py", ".tools", known, "build")).toBe("pkg/tools/build.py");
  });
});

describe("resolveImportSource — TypeScript ESM specifiers", () => {
  it("resolves `./x.js` to the `.ts` source beside it (and `.mjs` to `.mts`, `.jsx` to `.tsx`)", () => {
    const known = new Set(["src/client/client.gen.ts", "src/lib/util.mts", "src/ui/Button.tsx", "src/plain.js"]);
    expect(resolveImportSource("src/client/sdk.gen.ts", "./client.gen.js", known)).toBe("src/client/client.gen.ts");
    expect(resolveImportSource("src/index.ts", "./lib/util.mjs", known)).toBe("src/lib/util.mts");
    expect(resolveImportSource("src/index.ts", "./ui/Button.jsx", known)).toBe("src/ui/Button.tsx");
    // A real `.js` file still wins.
    expect(resolveImportSource("src/index.ts", "./plain.js", known)).toBe("src/plain.js");
  });
});

describe("an API label is not a call chain", () => {
  it("reads no entity from `ADO.NET: ExecuteScalar` or `Settings: GetSetting`, and still reads `User.findOne`", () => {
    const a: FileAnalysis = {
      ...createEmptyAnalysis("app.cs", "csharp"),
      dataSources: ["ADO.NET: ExecuteScalar", "Cache: GetValue", "User.findOne"].map((name, i) => ({ kind: "database" as const, name, target: null, calls: [], line: i + 1 })),
    };
    enrichFileDataSources(a);
    expect(a.dataSources.map((d) => d.entity)).toEqual([undefined, undefined, "User"]);
  });
});
