import { describe, it, expect } from "vitest";
import { buildSymbolLinks } from "./symbol-linker.js";
import type { CallInfo, ClassInfo, FileAnalysis, FunctionInfo, ImportInfo } from "../types/analysis.js";

/**
 * Member sources a call has to reach beyond a class's own body: a PHP trait a class `use`s, an interface
 * inherited through an abstract base, a `static::` / `Me.` self call, and a module table a Lua `require`
 * binds. Hand-built analyses, as a plugin emits them.
 */

const call = (name: string, line = 10, kind: CallInfo["kind"] = "internal", target: string | null = null): CallInfo => ({ name, kind, target, line });
const method = (name: string, line: number, calls: CallInfo[] = [], extra: Partial<FunctionInfo> = {}): FunctionInfo =>
  ({ name, line, endLine: line, params: [], calls, returnType: null, isAsync: false, isExported: true, decorators: [], ...extra });
const cls = (name: string, o: Partial<ClassInfo> = {}): ClassInfo => ({
  name, kind: "class", extends: null, implements: [], methods: [], properties: [], decorators: [], isExported: true, line: 1, endLine: 30, ...o,
});
const imp = (source: string, specifiers: string[], isNamespace = false): ImportInfo =>
  ({ source, specifiers, isDefault: false, isNamespace, isType: false, line: 1 });
const file = (filePath: string, language: string, classes: ClassInfo[], extra: Partial<FileAnalysis> = {}): FileAnalysis =>
  ({ filePath, projectId: "root", language, functions: [], classes, imports: [], exports: [], routes: [], dataSources: [], ...extra } as unknown as FileAnalysis);

const reach = (analyses: FileAnalysis[]) =>
  buildSymbolLinks(analyses).map((l) => `${l.sourceFile}::${l.sourceSymbol} -> ${l.targetFile}::${l.targetSymbol} (${l.strategy})`);

describe("a PHP trait is a member source", () => {
  const trait = file("Ranks.php", "php", [cls("Ranks", { methods: [method("rank", 3)] })]);
  const service = file("ClubService.php", "php", [cls("ClubService", { implements: ["Ranks"], mixins: [{ name: "Ranks", kind: "include" }] })]);
  const decoy = file("Decoy.php", "php", [cls("Decoy", { methods: [method("rank", 3)] })]);

  it("links a call on a typed receiver to the trait's method, never a namesake's", () => {
    const consumer = file("Ctl.php", "php", [cls("Ctl", {
      properties: [{ name: "svc", type: "ClubService", visibility: "private", isStatic: false, isReadonly: false }],
      methods: [method("show", 5, [call("this.svc.rank", 5)])],
    })]);
    const links = reach([trait, service, decoy, consumer]);
    expect(links).toContain("Ctl.php::Ctl.show -> Ranks.php::Ranks.rank (injection)");
    expect(links.some((l) => l.includes("Decoy.php::"))).toBe(false);
  });
});

describe("an interface is inherited through an abstract base", () => {
  const repo = file("Repo.java", "java", [cls("Repo", { kind: "interface", methods: [method("persist", 2)] })]);
  const baseRepo = file("BaseRepo.java", "java", [cls("BaseRepo", { abstract: true, implements: ["Repo"] })]);
  const clubRepo = file("ClubRepo.java", "java", [cls("ClubRepo", { extends: "BaseRepo", methods: [method("persist", 4)] })]);
  const midRepo = file("MidRepo.java", "java", [cls("MidRepo", { abstract: true, extends: "BaseRepo" })]);
  const leafRepo = file("LeafRepo.java", "java", [cls("LeafRepo", { extends: "MidRepo", methods: [method("persist", 6)] })]);
  const other = file("Other.java", "java", [cls("Other", { methods: [method("persist", 3)] })]);

  it("fans the interface method out to each class below the base that overrides it", () => {
    const links = reach([repo, baseRepo, clubRepo, midRepo, leafRepo, other]);
    expect(links).toContain("Repo.java::Repo.persist -> ClubRepo.java::ClubRepo.persist (interface-fanout)");
    expect(links).toContain("Repo.java::Repo.persist -> LeafRepo.java::LeafRepo.persist (interface-fanout)");
    expect(links.some((l) => l.includes("Other.java::"))).toBe(false);
  });

  it("adds nothing where the base's subclasses do not implement the method", () => {
    const links = reach([repo, baseRepo, file("Idle.java", "java", [cls("Idle", { extends: "BaseRepo" })]), other]);
    expect(links.filter((l) => l.includes("interface-fanout"))).toEqual([]);
  });
});

describe("a self call on the class's own receiver", () => {
  it("links `static::helper()` and a VB `Me.` / `MyClass.` call to the enclosing class's member", () => {
    const php = file("Stat.php", "php", [cls("Stat", { methods: [method("helper", 3), method("go", 4, [call("static.helper", 4)])] })]);
    const other = file("Other.php", "php", [cls("Other", { methods: [method("helper", 3)] })]);
    const vb = file("Form.vb", "vb", [cls("Form1", { methods: [method("Helper", 3), method("Load", 5, [call("Me.Helper", 5), call("MyClass.Helper", 6)])] })]);
    const links = reach([php, other, vb]);
    expect(links).toContain("Stat.php::Stat.go -> Stat.php::Stat.helper (direct)");
    expect(links.filter((l) => l.startsWith("Form.vb::Form1.Load -> Form.vb::Form1.Helper")).length).toBe(2);
    expect(links.some((l) => l.includes("Other.php::"))).toBe(false);
  });
});

describe("a module table a `require` binds", () => {
  const referee = file("referee.lua", "lua", [cls("M", { methods: [method("kickoff", 3)] })]);
  const decoy = file("decoy.lua", "lua", [cls("D", { methods: [method("kickoff", 3)] })]);

  it("links `r.kickoff()` to the module class of the file `r` is bound to", () => {
    const main = file("main.lua", "lua", [], {
      imports: [imp("referee", ["r"], true)],
      functions: [method("play", 5, [call("r.kickoff", 6, "internal")])],
    });
    const links = reach([main, referee, decoy]);
    expect(links).toContain("main.lua::play -> referee.lua::M.kickoff (import-file)");
    expect(links.some((l) => l.includes("decoy.lua::"))).toBe(false);
  });
});
