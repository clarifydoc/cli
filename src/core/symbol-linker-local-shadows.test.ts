import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis, SymbolLink } from "../types/analysis.js";

/**
 * A bare call `kickoff()` reaches a same-file module-level `kickoff` only where no scope between the call and the
 * module binds the name: the caller's own locals (any assignment, lambda, loop, `with`/`except … as`, destructuring,
 * an import inside the function, resolved or not), and the locals of the functions enclosing it. A function the engine
 * knows (a nested `def`, a local arrow) is still what its name calls. Each project keeps decoys whose link must stay.
 */
const PROJECTS: Record<string, Record<string, string>> = {
  python: {
    "pyproject.toml": "[project]\nname = \"league\"\n",
    "league/__init__.py": "",
    "league/desk.py": `def kickoff():
    return 1


def imported():
    from absent_league_pkg import kickoff
    return kickoff()


def outer():
    from absent_league_pkg import kickoff

    def inner():
        return kickoff()
    return inner


def renamed():
    from absent_league_pkg import whistle as kickoff
    return kickoff()


def via_lambda():
    kickoff = lambda: 2
    return kickoff()


def via_value():
    kickoff = compute()
    return kickoff()


def via_with():
    with opener() as kickoff:
        return kickoff()


def via_loop(handlers):
    for kickoff in handlers:
        kickoff()


def maker():
    kickoff = compute()

    def run():
        return kickoff()
    return run


def via_param(kickoff):
    return kickoff()


def via_nested():
    def kickoff():
        return 3
    return kickoff()


def plain():
    return kickoff()


class Squad:
    from absent_league_pkg import kickoff

    def method(self):
        return kickoff()
`,
    "league/bench.py": `def kickoff():
    return 1


def sign():
    kickoff = compute()
    return kickoff()


def other():
    def kickoff():
        return 3
    return kickoff()


def lone():
    kickoff = compute()
    return kickoff()


def plain():
    return kickoff()
`,
    "league/util.py": `def helper():
    return 1
`,
    "league/pitch.py": `from league.util import helper


def fixed():
    from league.util import helper
    return helper()


def own():
    return helper()
`,
  },
  typescript: {
    "package.json": "{\"name\":\"league\"}\n",
    "src/desk.ts": `export function kickoff() { return 1; }

export async function viaImport() {
  const { kickoff } = await import("absent-league-pkg");
  return kickoff();
}

export function viaRequire() {
  const { kickoff } = require("absent-league-pkg");
  return kickoff();
}

export function viaLoop(handlers: Array<() => void>) {
  for (const kickoff of handlers) kickoff();
}

export function viaValue() {
  const kickoff = compute();
  return kickoff();
}

export function viaBlock() {
  { const kickoff = compute(); kickoff(); }
}

export function closure() {
  const kickoff = compute();
  return () => kickoff();
}

export function viaParam(kickoff: () => void) {
  return kickoff();
}

export function viaArrow() {
  const kickoff = () => 2;
  return kickoff();
}

export function viaNested() {
  function kickoff() { return 3; }
  return kickoff();
}

export function plain() {
  return kickoff();
}
`,
  },
  wrapped: {
    "package.json": "{\"name\":\"league\"}\n",
    "src/lib.js": `(function (factory) {
  factory(window.$);
})(function ($) {
  function flatten(items) {
    return items.map(function (i) { return flatten(i); });
  }
  function set(a) { return a; }
  var state = util.throttle(function () { return 1; });
  var api = {
    each(flatten, fn) {
      if (typeof flatten === "string") { flatten = false; }
      return fn;
    },
  };
  function remove() { return state(); }
  function sort() { return set(flatten([])); }
  function shadowed() {
    var set = compute();
    return set(1);
  }
  return { remove: remove, sort: sort, shadowed: shadowed, api: api };
});
`,
  },
  go: {
    "go.mod": "module example.com/league\n\ngo 1.21\n",
    "league/desk.go": `package league

func kickoff() int { return 1 }

func viaLiteral() int {
	kickoff := func() int { return 2 }
	return kickoff()
}

func viaRange(handlers []func() int) int {
	for _, kickoff := range handlers {
		kickoff()
	}
	return 0
}

func viaSelf() int {
	kickoff := kickoff()
	return kickoff
}

func viaWrapped() string {
	kickoff, err := fmt.Sprint(kickoff())
	return kickoff + err
}

func plain() int { return kickoff() }
`,
  },
  kotlin: {
    "build.gradle.kts": "plugins { kotlin(\"jvm\") }\n",
    "src/main/kotlin/league/Desk.kt": `package league

fun kickoff(): Int = 1

fun viaLocalFun(): Int {
    fun kickoff(): Int = 2
    return kickoff()
}

fun viaVal(compute: () -> (() -> Int)): Int {
    val kickoff = compute()
    return kickoff()
}

fun viaLambda(handlers: List<() -> Int>) {
    handlers.forEach { kickoff -> kickoff() }
}

fun viaSelf(): Int {
    val kickoff = kickoff()
    return kickoff
}

fun plain(): Int = kickoff()
`,
  },
};

const results: Record<string, ProjectAnalysis> = {};
const roots: string[] = [];

beforeAll(async () => {
  for (const [lang, files] of Object.entries(PROJECTS)) {
    const root = await mkdtemp(join(tmpdir(), `local-shadows-${lang}-`));
    roots.push(root);
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), content);
    }
    const out = join(root, ".out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false });
    results[lang] = await loadReportSummary(out);
  }
}, 180_000);

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const linksOf = (lang: string, sourceSymbol: string, callName = "kickoff", file?: string): SymbolLink[] =>
  (results[lang]!.symbolLinks ?? []).filter((l) => l.sourceSymbol === sourceSymbol && l.callName === callName && (!file || l.sourceFile.endsWith(file)));

describe("symbol-linker — a local binding shadows a same-file function of its name", () => {
  describe("Python", () => {
    it.each(["imported", "outer", "inner", "renamed", "via_lambda", "via_value", "via_with", "via_loop", "maker", "run", "via_param"])(
      "links nothing from %s", (fn) => {
        expect(linksOf("python", fn, "kickoff", "desk.py")).toEqual([]);
      });

    it("still links the nested def, the module function and the class body's call to the module", () => {
      expect(linksOf("python", "via_nested", "kickoff", "desk.py")[0]).toMatchObject({ targetFile: "league/desk.py", targetLine: 56 });
      expect(linksOf("python", "plain", "kickoff", "desk.py")[0]).toMatchObject({ targetFile: "league/desk.py", targetLine: 1 });
      expect(linksOf("python", "Squad.method", "kickoff", "desk.py")[0]).toMatchObject({ targetFile: "league/desk.py", targetLine: 1 });
    });

    it("lets a nested namesake elsewhere in the file hide no local binding", () => {
      expect(linksOf("python", "sign", "kickoff", "bench.py")).toEqual([]);
      expect(linksOf("python", "lone", "kickoff", "bench.py")).toEqual([]);
      expect(linksOf("python", "other", "kickoff", "bench.py")[0]).toMatchObject({ targetFile: "league/bench.py", targetLine: 11 });
      expect(linksOf("python", "plain", "kickoff", "bench.py")[0]).toMatchObject({ targetFile: "league/bench.py", targetLine: 1 });
    });

    it("keeps an import inside a function that resolves to a project file", () => {
      expect(linksOf("python", "fixed", "helper")[0]).toMatchObject({ targetFile: "league/util.py" });
      expect(linksOf("python", "own", "helper")[0]).toMatchObject({ targetFile: "league/util.py" });
    });
  });

  describe("TypeScript", () => {
    it.each(["viaImport", "viaRequire", "viaLoop", "viaValue", "viaBlock", "closure", "viaParam"])("links nothing from %s", (fn) => {
      expect(linksOf("typescript", fn)).toEqual([]);
    });

    it("keeps the local arrow, the nested function and the plain call", () => {
      expect(linksOf("typescript", "viaArrow")[0]).toMatchObject({ targetLine: 36 });
      expect(linksOf("typescript", "viaNested")[0]).toMatchObject({ targetLine: 41 });
      expect(linksOf("typescript", "plain")[0]).toMatchObject({ targetLine: 1 });
    });
  });

  describe("a factory-wrapped bundle", () => {
    it("keeps a function declared in the wrapper, a var holding a callback, and a method's own parameter", () => {
      expect(linksOf("wrapped", "flatten", "flatten")[0]).toMatchObject({ targetLine: 4 });
      expect(linksOf("wrapped", "sort", "flatten")[0]).toMatchObject({ targetLine: 4 });
      expect(linksOf("wrapped", "sort", "set")[0]).toMatchObject({ targetLine: 7 });
      expect(linksOf("wrapped", "remove", "state")[0]).toMatchObject({ targetLine: 8 });
    });
    it("still links nothing from a function binding the name itself", () => {
      expect(linksOf("wrapped", "shadowed", "set")).toEqual([]);
    });
  });

  describe("Go", () => {
    it("links nothing from a function literal bound to the name or a range variable", () => {
      expect(linksOf("go", "viaLiteral")).toEqual([]);
      expect(linksOf("go", "viaRange")).toEqual([]);
    });
    it("keeps the plain call and a name declared from a call of the function itself", () => {
      expect(linksOf("go", "plain")[0]).toMatchObject({ targetLine: 3 });
      expect(linksOf("go", "viaSelf")[0]).toMatchObject({ targetLine: 3 });
      expect(linksOf("go", "viaWrapped")[0]).toMatchObject({ targetLine: 3 });
    });
  });

  describe("Kotlin", () => {
    it("links nothing from a local fun, a local val or a lambda variable", () => {
      expect(linksOf("kotlin", "viaLocalFun")).toEqual([]);
      expect(linksOf("kotlin", "viaVal")).toEqual([]);
      expect(linksOf("kotlin", "viaLambda")).toEqual([]);
    });
    it("keeps the plain call and a val declared from a call of the function itself", () => {
      expect(linksOf("kotlin", "plain")[0]).toMatchObject({ targetLine: 3 });
      expect(linksOf("kotlin", "viaSelf")[0]).toMatchObject({ targetLine: 3 });
    });
  });
});
