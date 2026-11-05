import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { FileAnalysis, SubProject } from "../types/analysis.js";

/**
 * Same-named definitions in several sub-projects: the one project the caller's
 * build declares it references (`SubProject.references`) wins; two referenced
 * projects, or none, stay unresolved; the caller's own project is never weighed.
 */

const method = (name: string) => ({ name, line: 3, endLine: 5, params: [], calls: [], returnType: null as string | null, isAsync: false, isExported: true, decorators: [] });

const service = (filePath: string, projectId: string): FileAnalysis =>
  ({
    filePath, projectId, language: "csharp", functions: [], imports: [], exports: [], routes: [], dataSources: [],
    classes: [{ name: "ClubService", kind: "class", extends: null, implements: [], methods: [method("Promote")], properties: [], decorators: [], isExported: true, line: 1, endLine: 9 }],
  }) as unknown as FileAnalysis;

const controller = (projectId: string): FileAnalysis =>
  ({
    filePath: `${projectId}/ClubController.cs`, projectId, language: "csharp", functions: [], imports: [], exports: [], routes: [], dataSources: [],
    classes: [{
      name: "ClubController", kind: "class", extends: null, implements: [], properties: [], decorators: [], isExported: true, line: 1, endLine: 20,
      methods: [{
        ...method("Go"),
        calls: [{ name: "svc.Promote", kind: "internal", target: null, line: 8 }],
        localTypes: [{ name: "svc", type: "ClubService" }],
      }],
    }],
  }) as unknown as FileAnalysis;

const project = (id: string, references?: string[]): SubProject =>
  ({ id, name: id, root: id, kind: "dotnet", markers: [], ...(references ? { references: references.map((r) => ({ project: r, file: `${id}/${id}.csproj` })) } : {}) }) as SubProject;

const targets = (analyses: FileAnalysis[], projects: SubProject[]) =>
  buildSymbolLinks(analyses, projects)
    .filter((l) => l.sourceFile === "Web/ClubController.cs" && l.callName === "svc.Promote")
    .map((l) => l.targetFile);

describe("symbol-linker — declared project references break a cross-project tie", () => {
  const all = () => [controller("Web"), service("Core/ClubService.cs", "Core"), service("Legacy/ClubService.cs", "Legacy")];

  it("prefers the definition in the one project the caller declares", () => {
    expect(targets(all(), [project("Web", ["Core"]), project("Core"), project("Legacy")])).toEqual(["Core/ClubService.cs"]);
  });

  it("follows a reference through the projects it references", () => {
    expect(targets(all(), [project("Web", ["Mid"]), project("Mid", ["Core"]), project("Core"), project("Legacy")])).toEqual(["Core/ClubService.cs"]);
  });

  it("stays unresolved without a declaration", () => {
    expect(targets(all(), [project("Web"), project("Core"), project("Legacy")])).toEqual([]);
  });

  it("stays unresolved when two referenced projects both define the name", () => {
    expect(targets(all(), [project("Web", ["Core", "Legacy"]), project("Core"), project("Legacy")])).toEqual([]);
  });

  it("never weighs a reference against a definition in the caller's own project", () => {
    const own = [...all(), service("Web/ClubService.cs", "Web")];
    expect(targets(own, [project("Web", ["Core"]), project("Core"), project("Legacy")])).toEqual(["Web/ClubService.cs"]);
  });
});
