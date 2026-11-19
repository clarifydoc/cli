import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import "../../registry.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { goLiteralParams } from "./literal-params.js";

/**
 * A package-level value types a call on its name in any file of the package, and a function literal's parameters type
 * the calls in its body. `Garage` declares namesake `Save`/`Open` methods no call here is on.
 */
const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.22\n",
  "squad/store.go": `package squad

type Store struct{}

func (s *Store) Save(id int) {}

type Cache struct{}

func (c *Cache) Save() {}

func NewStore() *Store { return &Store{} }

type Garage struct{}

func (g *Garage) Save() {}

func (g *Garage) Open() {}
`,
  "squad/vars.go": `package squad

var store = NewStore()

var cache Cache

func SameFile() { store.Save(1) }
`,
  "squad/use.go": `package squad

func Use() {
\tstore.Save(2)
\tcache.Save()
}

func ShadowParam(store *Garage) { store.Save() }

func ShadowLocal() {
\tcache := &Garage{}
\tcache.Save()
}

func ShadowUnknown(g *Garage) {
\tstore := g.Pick()
\tstore.Save()
}

func ShadowLiteral() {
\tfunc(cache *Garage) { cache.Save() }(nil)
}

func Literals() {
\trun := func(g *Garage) { g.Open() }
\trun(nil)
\tfunc(s *Store) { s.Save(3) }(nil)
}

func Outside() {
\trun := func(store *Garage) { store.Open() }
\trun(nil)
\tstore.Save(5)
}

func Clashing() {
\ta := func(x *Garage) { x.Open() }
\tb := func(x *Store) { x.Save(4) }
\ta(nil)
\tb(nil)
}
`,
  "other/other.go": `package other

type Boat struct{}

func (b *Boat) Save() {}

func (b *Boat) Open() {}

func Use() { store.Save() }
`,
};

describe("goLiteralParams", () => {
  it("reads named parameters of literals with a body, grouped names included, and skips types, unnamed and variadic ones", () => {
    const r = goLiteralParams([
      "run := func(g *Garage, h, k Store) error {",
      "var typ func(t *Boat)",
      "f := func(*Boat) {}",
      "v := func(xs ...Car) {}",
    ]);
    expect([...r.typed].sort((a, b) => a.name.localeCompare(b.name))).toEqual([{ name: "g", type: "*Garage" }, { name: "h", type: "Store" }, { name: "k", type: "Store" }]);
    expect([...r.names].sort()).toEqual(["g", "h", "k", "xs"]);
  });
});

describe.each([["ANTLR", undefined], ["regex", "no-antlr"]])("Go package values and literal parameters (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-go-pkg-values-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const targets = (from: string) =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol === from)
      .filter((l) => l.callName.includes("."))
      .map((l) => `${l.callName} -> ${l.targetSymbol}`)
      .sort();

  it("types a package value from a constructor or a written type, in its own file and its siblings", () => {
    expect(targets("SameFile")).toEqual(["store.Save -> Store.Save"]);
    expect(targets("Use")).toEqual(["cache.Save -> Cache.Save", "store.Save -> Store.Save"]);
  });

  it("is shadowed by a parameter, a local and a literal's parameter of the same name", () => {
    expect(targets("ShadowParam")).toEqual(["store.Save -> Garage.Save"]);
    expect(targets("ShadowLocal")).toEqual(["cache.Save -> Garage.Save"]);
    expect(targets("ShadowLiteral")).toEqual(["cache.Save -> Garage.Save"]);
    expect(targets("ShadowUnknown").filter((t) => t.startsWith("store."))).toEqual([]);
  });

  it("leaves another package's call on a namesake name alone", () => {
    expect(targets("Use").length).toBe(2);
    expect(summary.symbolLinks!.filter((l) => l.sourceFile === "other/other.go" && l.callName === "store.Save")).toEqual([]);
  });

  it("types a function literal's parameters, never the namesake type's method", () => {
    expect(targets("Literals")).toEqual(["g.Open -> Garage.Open", "s.Save -> Store.Save"]);
  });

  it("reads a name used outside its literal as the package value there", () => {
    expect(targets("Outside").filter((t) => t.startsWith("store.Save"))).toEqual(["store.Save -> Store.Save"]);
  });

  it("leaves a name two literals type differently untyped", () => {
    expect(targets("Clashing")).toEqual([]);
  });
});
