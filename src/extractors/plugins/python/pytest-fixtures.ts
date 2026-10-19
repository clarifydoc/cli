import type { FileAnalysis, FunctionInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { FIXTURE_DECORATOR } from "./functions-classes.js";

/**
 * pytest fixtures: a test names a fixture as a parameter and pytest passes in
 * what the fixture returns — `def test_save(user): user.save()` calls
 * `User.save` when the `user` fixture returns a `User`. Nothing in the test
 * file says so, and the fixture usually lives in a `conftest.py` the test
 * never imports, so the linker cannot see the edge.
 *
 * A parameter is a fixture when the test's own module defines one of that
 * name, else the nearest `conftest.py` in its directory or above (pytest's own
 * lookup). Its type is the fixture's declared return type, or — unannotated —
 * the one class its body returns or yields (set by the extractor). A
 * generator's `Iterator[User]` / `Generator[User, …]` yields a `User`. The
 * class must be defined once in the project, with the method called.
 */
export class PytestFixtureResolver implements DispatchResolver {
  readonly id = "pytest-fixture";
  readonly languages: Language[] = ["python"];
  readonly priority = 60;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const fixturesIn = new Map<string, Map<string, FunctionInfo>>();
    for (const a of analyses) {
      const own = new Map<string, FunctionInfo>();
      for (const fn of a.functions) {
        const dec = fn.decorators.find((d) => FIXTURE_DECORATOR.test(d));
        if (!dec) continue;
        own.set(/\bname\s*=\s*["']([^"']+)["']/.exec(dec)?.[1] ?? fn.name, fn);
      }
      if (own.size > 0) fixturesIn.set(a.filePath, own);
    }
    if (fixturesIn.size === 0) return [];

    const classFiles = new Map<string, FileAnalysis[]>();
    for (const a of analyses) {
      for (const c of a.classes) {
        const list = classFiles.get(c.name);
        if (list) list.push(a);
        else classFiles.set(c.name, [a]);
      }
    }

    const fixtureFor = (testFile: string, name: string): FunctionInfo | undefined => {
      const local = fixturesIn.get(testFile)?.get(name);
      if (local) return local;
      for (let dir = testFile.slice(0, testFile.lastIndexOf("/")); ; dir = dir.slice(0, Math.max(0, dir.lastIndexOf("/")))) {
        const hit = fixturesIn.get(dir ? `${dir}/conftest.py` : "conftest.py")?.get(name);
        if (hit || !dir) return hit;
      }
    };

    const links: SymbolLink[] = [];
    for (const a of analyses) {
      const tests: Array<{ fn: FunctionInfo; symbol: string }> = a.functions
        .filter((f) => f.name.startsWith("test"))
        .map((fn) => ({ fn, symbol: fn.name }));
      for (const c of a.classes) {
        if (!c.name.startsWith("Test")) continue;
        for (const m of c.methods) if (m.name.startsWith("test")) tests.push({ fn: m, symbol: `${c.name}.${m.name}` });
      }
      for (const { fn, symbol } of tests) {
        for (const p of fn.params) {
          if (p.type || p.name === "self") continue;
          const fixture = fixtureFor(a.filePath, p.name);
          const typeName = fixture?.returnType ? yieldedType(fixture.returnType) : null;
          if (!typeName) continue;
          for (const call of fn.calls) {
            const [head, member, ...rest] = call.name.split(".");
            if (head !== p.name || !member || rest.length > 0) continue;
            const hit = methodOf(classFiles, typeName, member);
            if (!hit) continue;
            links.push({
              sourceFile: a.filePath,
              sourceSymbol: symbol,
              sourceLine: call.line,
              callName: call.name,
              targetFile: hit.file,
              targetSymbol: hit.symbol,
              targetLine: hit.line,
              confidence: "INFERRED",
            });
          }
        }
      }
    }
    return links;
  }
}

/** `User` / `models.User` / `Iterator[User]` / `Generator[User, None, None]` → `User`. */
function yieldedType(written: string): string | null {
  const t = written.replace(/\s+/g, "");
  const gen = /^(?:typing\.|collections\.abc\.)?(?:Iterator|Generator|AsyncIterator|AsyncGenerator|Iterable)\[([^,\]]+)/.exec(t);
  const inner = (gen ? gen[1]! : t).replace(/^["']|["']$/g, "");
  const leaf = inner.split(".").pop()!;
  return /^[A-Za-z_]\w*$/.test(leaf) ? leaf : null;
}

/** `member` on the one project class named `typeName`, or the nearest base along its first-base chain that defines it. */
function methodOf(classFiles: ReadonlyMap<string, FileAnalysis[]>, typeName: string, member: string): { file: string; symbol: string; line: number } | null {
  let name: string | null = typeName;
  const seen = new Set<string>();
  while (name && !seen.has(name) && seen.size < 6) {
    seen.add(name);
    const decl = classFiles.get(name);
    if (!decl || decl.length !== 1) return null;
    const cls = decl[0]!.classes.find((c) => c.name === name)!;
    const method = cls.methods.find((m) => m.name === member);
    if (method) return { file: decl[0]!.filePath, symbol: `${cls.name}.${method.name}`, line: method.line };
    name = cls.extends?.split(".").pop()?.replace(/\[.*$/, "") ?? null;
  }
  return null;
}
