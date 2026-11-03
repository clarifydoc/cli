import { describe, it, expect } from "vitest";
import { buildClassGraph } from "./data-model-blast.js";
import { SYNTHETIC_ENTITY } from "../extractors/entities/base.js";
import { createEmptyAnalysis, type ClassInfo, type FileAnalysis, type ImportInfo } from "../types/analysis.js";

function cls(name: string, decorators: string[] = [], columnType = "integer"): ClassInfo {
  return {
    name,
    extends: null,
    implements: [],
    decorators,
    methods: [],
    properties: [{ name: "ID", type: columnType, visibility: "public", isStatic: false, isReadonly: false }],
    isExported: true,
    line: 1,
    endLine: 10,
  };
}

function file(filePath: string, language: "pascal" | "dfm", classes: ClassInfo[]): FileAnalysis {
  const a = createEmptyAnalysis(filePath, language);
  a.classes = classes;
  // A table entity's columns carry type references the same way a class's
  // fields do — this is what pass 2 sees.
  a.typeReferences = classes.flatMap((c) =>
    c.properties.map((p) => ({
      rawType: p.type ?? "unknown",
      typeName: p.type ?? "unknown",
      usageKind: "field" as const,
      sourceFile: filePath,
      sourceLine: 1,
      sourceSymbol: `${c.name}.${p.name}`,
      sourceClass: c.name,
      confidence: "EXTRACTED" as const,
    })),
  );
  return a;
}

describe("buildClassGraph", () => {
  it("keeps synthesized tables out of the graph, one node per real declaration", () => {
    // A Delphi table reconstructed from dataset DML lands in `classes` on every
    // .dfm that queries it (dfm-entities.ts). Those are tables, not declared
    // types — only the real `TPlayer` class belongs in the class graph.
    const synthetic = ["entity", "dfm", SYNTHETIC_ENTITY];
    const graph = buildClassGraph([
      file("SquadFrame.dfm", "dfm", [cls("TPLAYER", synthetic, "varchar")]),
      file("Transfers.dfm", "dfm", [cls("TPLAYER", synthetic, "varchar")]),
      file("Fixtures.dfm", "dfm", [cls("TPLAYER", synthetic, "varchar")]),
      file("model/Player.pas", "pascal", [cls("TPlayer")]),
    ]);

    // Only the declared class survives; the external SQL-type nodes the real
    // class's own columns reference are expected and not what this guards.
    expect(graph.nodes.filter((n) => !n.isExternal).map((n) => n.id)).toEqual([
      "model/Player.pas::TPlayer",
    ]);
    // The dropped references take their type nodes with them: `varchar` came
    // only from the synthesized tables, `integer` also from the real class.
    expect(graph.nodes.map((n) => n.id)).not.toContain("::varchar");
  });

  it("keeps ORM entity classes, which ARE declared types", () => {
    const graph = buildClassGraph([
      file("model/Player.pas", "pascal", [cls("TPlayer", ["entity", "ef-core"])]),
    ]);

    const node = graph.nodes.find((n) => n.name === "TPlayer");
    expect(node).toMatchObject({ isEntity: true, orm: "ef-core" });
  });
});

describe("buildClassGraph — a supertype is the class its qualifier and imports name", () => {
  const imp = (source: string, specifiers: string[], isNamespace = false): ImportInfo =>
    ({ source, specifiers, isDefault: false, isNamespace, isType: false, line: 1 }) as ImportInfo;
  /** A file declaring `classes`, each `[name, ...supertypes as written]` (the first `extends`, the rest `implements`). */
  const source = (filePath: string, language: FileAnalysis["language"], classes: string[][], imports: ImportInfo[] = []): FileAnalysis => {
    const a = createEmptyAnalysis(filePath, language);
    a.imports = imports;
    a.classes = classes.map(([name, ext, ...impl]) => ({ ...cls(name!), properties: [], extends: ext ?? null, implements: impl }));
    a.typeReferences = classes.flatMap(([name, ...supers]) =>
      supers.map((raw, i) => ({
        rawType: raw,
        typeName: raw.replace(/[<[(].*$/s, "").split(".").pop()!,
        usageKind: i === 0 ? ("extends" as const) : ("implements" as const),
        sourceFile: filePath,
        sourceLine: 1,
        sourceSymbol: name!,
        sourceClass: name!,
        confidence: "EXTRACTED" as const,
      })),
    );
    return a;
  };
  const edges = (graph: ReturnType<typeof buildClassGraph>) => graph.edges.map((e) => `${e.source} -> ${e.target}`).sort();

  it("Python: `base.Club`, `league.base.Club` and a second base after `Generic[T]` reach league/base.py, never the namesake beside them", () => {
    const graph = buildClassGraph([
      source("league/__init__.py", "python", []),
      source("cup/base.py", "python", [["Club"]]),
      source("league/base.py", "python", [["Club"]]),
      source("cup/derby.py", "python", [["Derby", "base.Club"]], [imp("league", ["base"])]),
      source("cup/final.py", "python", [["Final", "league.base.Club"]], [imp("league.base", ["league.base"], true)]),
      source("cup/box.py", "python", [["Box", "Generic[T]", "base.Club"]], [imp("typing", ["Generic"]), imp("league", ["base"])]),
    ]);
    expect(edges(graph)).toEqual([
      "cup/box.py::Box -> ::Generic",
      "cup/box.py::Box -> league/base.py::Club",
      "cup/derby.py::Derby -> league/base.py::Club",
      "cup/final.py::Final -> league/base.py::Club",
    ]);
  });

  it("JavaScript: `extends models.Car` on a namespace import is the module's Car", () => {
    const graph = buildClassGraph([
      source("other/car.js", "javascript", [["Car"]]),
      source("models/car.js", "javascript", [["Car"]]),
      source("other/garage.js", "javascript", [["Van", "models.Car"]], [imp("../models/car.js", ["models"], true)]),
    ]);
    expect(edges(graph)).toEqual(["other/garage.js::Van -> models/car.js::Car"]);
  });

  it("Java: an imported base is the class the import names, not the same-package namesake", () => {
    const root = "src/main/java/com/league";
    const graph = buildClassGraph([
      source(`${root}/app/Club.java`, "java", [["Club"]]),
      source(`${root}/cup/Club.java`, "java", [["Club"]]),
      source(`${root}/app/Derby.java`, "java", [["Derby", "Club"]], [imp("com.league.cup.Club", ["Club"])]),
    ]);
    expect(edges(graph)).toEqual([`${root}/app/Derby.java::Derby -> ${root}/cup/Club.java::Club`]);
  });

  it("draws no edge when nothing says which namesake, and another language's class is none", () => {
    const graph = buildClassGraph([
      source("a/Club.cs", "csharp", [["Club"]]),
      source("b/Club.cs", "csharp", [["Club"]]),
      source("c/Derby.cs", "csharp", [["Derby", "Club"]]),
      source("src/models.rs", "rust", [["Model"]]),
      source("app/models.py", "python", [["Scout", "models.Model"]], [imp("django.db", ["models"])]),
    ]);
    expect(edges(graph)).toEqual(["app/models.py::Scout -> ::Model"]);
  });
});
