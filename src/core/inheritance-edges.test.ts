import { describe, it, expect } from "vitest";
import { enrichGraphFromInheritance } from "./inheritance-edges.js";
import type { FileAnalysis } from "../types/analysis.js";

const cls = (name: string, ext: string | null = null, impl: string[] = []) =>
  ({ name, extends: ext, implements: impl, methods: [], properties: [], decorators: [], isExported: true, line: 1, endLine: 5 });
const file = (filePath: string, classes: ReturnType<typeof cls>[], extra: Partial<FileAnalysis> = {}): FileAnalysis =>
  ({ filePath, language: "csharp", projectId: "root", classes, imports: [], exports: [], functions: [], ...extra } as unknown as FileAnalysis);

describe("enrichGraphFromInheritance", () => {
  it("adds implementation → interface edges no import states (same namespace)", () => {
    const graph: Record<string, string[]> = {};
    enrichGraphFromInheritance(graph, [
      file("Repo/IPlayerRepo.cs", [cls("IPlayerRepo")]),
      file("Repo/SqlPlayerRepo.cs", [cls("SqlPlayerRepo", "BaseRepo<Player>", ["Repo.IPlayerRepo"])]),
      file("Repo/BaseRepo.cs", [cls("BaseRepo")]),
    ]);
    expect(graph["Repo/SqlPlayerRepo.cs"]!.sort()).toEqual(["Repo/BaseRepo.cs", "Repo/IPlayerRepo.cs"]);
  });

  it("leaves imported bases, ORM relation targets and other type spaces alone", () => {
    const graph: Record<string, string[]> = {};
    enrichGraphFromInheritance(graph, [
      file("app/Owner.cs", [cls("Owner")]),
      file("app/License.cs", [cls("License", null, ["Owner"])], {
        entityRelations: [{ fromEntity: "License", fromField: "Owner", toEntity: "Owner", cardinality: "many-to-one" }],
      } as Partial<FileAnalysis>),
      file("src/a.ts", [cls("A", "Base")], { language: "typescript", imports: [{ source: "lib", specifiers: ["Base"], isDefault: false, isNamespace: false, isType: false, line: 1 }] } as Partial<FileAnalysis>),
      file("src/base.ts", [cls("Base")], { language: "typescript" } as Partial<FileAnalysis>),
      file("app/models/tag.rb", [cls("Report", "ApplicationRecord", ["Tag"])], { language: "ruby" } as Partial<FileAnalysis>),
      file("prisma/schema.prisma", [cls("Tag")], { language: "prisma" } as Partial<FileAnalysis>),
    ]);
    expect(graph).toEqual({});
  });

  it("picks the closest of several definitions, and nothing on a tie", () => {
    const graph: Record<string, string[]> = {};
    enrichGraphFromInheritance(graph, [
      file("a/IService.cs", [cls("IService")]),
      file("b/IService.cs", [cls("IService")]),
      file("a/impl/Service.cs", [cls("Service", null, ["IService"])]),
      file("c/Other.cs", [cls("Other", null, ["IService"])]),
    ]);
    expect(graph).toEqual({ "a/impl/Service.cs": ["a/IService.cs"] });
  });
});
