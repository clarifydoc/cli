import { describe, it, expect } from "vitest";
import { buildClassIndex } from "./class-index.js";
import { buildImportIndex } from "./import-index.js";
import type { ClassInfo, FileAnalysis, ImportInfo } from "../types/analysis.js";

const cls = (name: string, ext: string | null = null, impl: string[] = []): ClassInfo =>
  ({ name, extends: ext, implements: impl, methods: [], properties: [], line: 1 } as unknown as ClassInfo);

const file = (
  filePath: string,
  classes: ClassInfo[],
  imports: ImportInfo[] = [],
  projectId = "root",
): FileAnalysis =>
  ({
    filePath,
    language: filePath.endsWith(".py") ? "python" : filePath.endsWith(".cs") ? "csharp" : "typescript",
    projectId,
    classes,
    imports,
    exports: [],
    entityRelations: [],
  } as unknown as FileAnalysis);

const imp = (source: string, specifiers: string[]): ImportInfo =>
  ({ source, specifiers, isDefault: false, line: 1 } as unknown as ImportInfo);

function index(files: FileAnalysis[]) {
  return buildClassIndex(files, buildImportIndex(files));
}

describe("buildClassIndex", () => {
  it("resolves a base in the same file, then through an import binding", () => {
    const base = file("app/base.py", [cls("BaseViewSet")]);
    const views = file("app/views.py", [cls("Local"), cls("TagViewSet", "BaseViewSet")], [
      imp(".base", ["BaseViewSet"]),
    ]);
    const idx = index([base, views]);
    expect(idx.resolve("app/views.py", "Local")?.filePath).toBe("app/views.py");
    expect(idx.resolve("app/views.py", "BaseViewSet[Tag]")?.filePath).toBe("app/base.py");
  });

  it("follows a module qualifier through its import", () => {
    const base = file("app/base.py", [cls("BaseViewSet")]);
    const views = file("app/views.py", [cls("V", "base.BaseViewSet")], [imp(".", ["base"])]);
    const idx = index([base, views]);
    const v = idx.classesIn("app/views.py")[0]!;
    expect(idx.supertypes(v)[0]!.ref?.filePath).toBe("app/base.py");
  });

  it("leaves a framework base unresolved and reports where it was imported from", () => {
    const views = file("app/views.py", [cls("TagViewSet", "viewsets.ModelViewSet")], [
      imp("rest_framework", ["viewsets"]),
    ]);
    const idx = index([views]);
    const [s] = idx.supertypes(idx.classesIn("app/views.py")[0]!);
    expect(s).toMatchObject({ name: "ModelViewSet", ref: null, importSource: "rest_framework" });
  });

  it("does not let a package import be shadowed by a same-named project class", () => {
    const local = file("app/other.py", [cls("APIView")]);
    const views = file("app/views.py", [cls("V", "APIView")], [imp("rest_framework.views", ["APIView"])]);
    expect(index([local, views]).resolve("app/views.py", "APIView")).toBeNull();
  });

  it("falls back to the one definition in the type space, and refuses a tie", () => {
    const ctrl = file("Api/Controllers/SeriesController.cs", [cls("SeriesController", "BaseApiController")]);
    const base = file("Api/Controllers/BaseApiController.cs", [cls("BaseApiController")]);
    expect(index([ctrl, base]).resolve(ctrl.filePath, "BaseApiController")?.filePath).toBe(base.filePath);

    const a = file("A/Base.cs", [cls("Base")], [], "a");
    const b = file("B/Base.cs", [cls("Base")], [], "b");
    const user = file("C/User.cs", [cls("User", "Base")], [], "c");
    expect(index([a, b, user]).resolve(user.filePath, "Base")).toBeNull();
  });

  it("walks ancestors depth-first, each once, and survives a cycle", () => {
    const f = file("m.ts", [cls("A", "B", ["IThing"]), cls("B", "C"), cls("C", "A")]);
    const idx = index([f]);
    const a = idx.classesIn("m.ts")[0]!;
    expect(idx.ancestors(a).map((s) => s.name)).toEqual(["B", "C", "IThing"]);
  });

  it("finds transitive descendants", () => {
    const f = file("m.ts", [cls("Base"), cls("Mid", "Base"), cls("Leaf", "Mid"), cls("Other")]);
    const idx = index([f]);
    expect(idx.descendants(idx.classesIn("m.ts")[0]!).map((r) => r.cls.name)).toEqual(["Mid", "Leaf"]);
  });
});
