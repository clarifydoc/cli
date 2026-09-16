import { describe, it, expect } from "vitest";
import { buildClassGraph } from "./data-model-blast.js";
import { SYNTHETIC_ENTITY } from "../extractors/entities/base.js";
import { createEmptyAnalysis, type ClassInfo, type FileAnalysis } from "../types/analysis.js";

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
    // types — only the real `TPerson` class belongs in the class graph.
    const synthetic = ["entity", "dfm", SYNTHETIC_ENTITY];
    const graph = buildClassGraph([
      file("PictureFrame.dfm", "dfm", [cls("TPERSON", synthetic, "varchar")]),
      file("T2UFPupils.dfm", "dfm", [cls("TPERSON", synthetic, "varchar")]),
      file("t2ufWaitList.dfm", "dfm", [cls("TPERSON", synthetic, "varchar")]),
      file("model/Person.pas", "pascal", [cls("TPerson")]),
    ]);

    // Only the declared class survives; the external SQL-type nodes the real
    // class's own columns reference are expected and not what this guards.
    expect(graph.nodes.filter((n) => !n.isExternal).map((n) => n.id)).toEqual([
      "model/Person.pas::TPerson",
    ]);
    // The dropped references take their type nodes with them: `varchar` came
    // only from the synthesized tables, `integer` also from the real class.
    expect(graph.nodes.map((n) => n.id)).not.toContain("::varchar");
  });

  it("keeps ORM entity classes, which ARE declared types", () => {
    const graph = buildClassGraph([
      file("model/Person.pas", "pascal", [cls("TPerson", ["entity", "ef-core"])]),
    ]);

    const node = graph.nodes.find((n) => n.name === "TPerson");
    expect(node).toMatchObject({ isEntity: true, orm: "ef-core" });
  });
});
