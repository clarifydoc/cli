/**
 * Go function values followed through locals, parameters, struct fields, returns, maps, slices and package
 * variables to the call that runs them (`value-flow` links), through the real per-file pipeline and the linker.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { buildSymbolLinks } from "../../../core/symbol-linker.js";
import type { FileAnalysis } from "../../../types/analysis.js";

async function analyzeAll(files: Record<string, string>): Promise<FileAnalysis[]> {
  const root = await mkdtemp(join(tmpdir(), "go-vf-"));
  const out = await mkdtemp(join(tmpdir(), "go-vf-out-"));
  const analyses: FileAnalysis[] = [];
  for (const [rel, src] of Object.entries(files)) {
    await mkdir(join(root, dirname(rel)), { recursive: true });
    await writeFile(join(root, rel), src);
  }
  for (const rel of Object.keys(files)) {
    const result = await analyzeFile({
      file: { absolutePath: join(root, rel), relativePath: rel, language: "go" },
      frameworkIds: [],
      projectId: "root",
      outputOpts: { outputDir: out, pretty: false },
      verbose: false,
      projectRoot: root,
      tsconfigAliases: new Map(),
    } as never);
    analyses.push(result!.analysis);
  }
  return analyses;
}

/** The `value-flow` links, as `source: callName -> target`. */
function valueFlowLinks(analyses: FileAnalysis[]): string[] {
  return buildSymbolLinks(analyses)
    .filter((l) => l.strategy === "value-flow")
    .map((l) => `${l.sourceSymbol}: ${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
    .sort();
}

const league = [
  "package league",
  "",
  "type Club struct {",
  "\tonSave func(string)",
  "\thooks  []func(string)",
  "}",
  "",
  "func save(name string)    {}",
  "func release(name string) {}",
  "func (c *Club) kick(n string) {}",
  "",
  "// the wrapper that runs whatever it is given",
  "func wrap(f func(string)) {",
  "\tf(\"x\")",
  "}",
  "",
  "func local() {",
  "\th := save",
  "\tg := h",
  "\twrap(g)",
  "}",
  "",
  "func (c *Club) Store()  { c.onSave = save }",
  "func (c *Club) Fire()   { c.onSave(\"a\") }",
  "func (c *Club) Add()    { c.hooks = append(c.hooks, release) }",
  "func (c *Club) FireAll() {",
  "\tfor _, hook := range c.hooks {",
  "\t\thook(\"b\")",
  "\t}",
  "}",
  "",
  "func makeHandler() func(string) { return save }",
  "func viaFactory() {",
  "\th := makeHandler()",
  "\th(\"z\")",
  "}",
  "",
  "func table() {",
  "\thandlers := map[string]func(string){\"save\": save, \"release\": release}",
  "\thandlers[\"save\"](\"x\")",
  "}",
  "",
  "func pair() {",
  "\ta, b := save, release",
  "\ta(\"1\")",
  "\tb(\"2\")",
  "}",
  "",
  "func methodValue(c *Club) {",
  "\tk := c.kick",
  "\tk(\"q\")",
  "}",
  "",
  "func (c *Club) Bind() {",
  "\tk := c.kick",
  "\tgo k(\"r\")",
  "}",
  "",
  "var onSave = save",
  "",
  "func viaPackageVar() { onSave(\"p\") }",
  "",
].join("\n");

const decoy = [
  "package garage",
  "",
  "func f(s string)        {}",
  "func h(s string)        {}",
  "func onSave(s string)   {}",
  "func hook(s string)     {}",
  "func k(s string)        {}",
  "func a(s string)        {}",
  "func b(s string)        {}",
  "",
].join("\n");

describe("Go function values", () => {
  it("follows a function through locals, wrappers, fields, factories, collections, pairs, method values and package variables", async () => {
    const analyses = await analyzeAll({ "league/club.go": league, "garage/decoy.go": decoy });
    expect(valueFlowLinks(analyses)).toEqual([
      "Club.Bind: k -> league/club.go::Club.kick",
      "Club.Fire: c.onSave -> league/club.go::save",
      "Club.FireAll: hook -> league/club.go::release",
      "methodValue: k -> league/club.go::Club.kick",
      "pair: a -> league/club.go::save",
      "pair: b -> league/club.go::release",
      "table: handlers[] -> league/club.go::save",
      "viaFactory: h -> league/club.go::save",
      "viaPackageVar: onSave -> league/club.go::save",
      "wrap: f -> league/club.go::save",
    ]);
  });

  it("never links a held value to a same-named function elsewhere", async () => {
    const analyses = await analyzeAll({ "league/club.go": league, "garage/decoy.go": decoy });
    const links = buildSymbolLinks(analyses).filter((l) => l.targetFile === "garage/decoy.go" && l.sourceFile === "league/club.go");
    expect(links).toEqual([]);
  });

  it("a local named like a function, declared from a call of it, still calls the function", async () => {
    const analyses = await analyzeAll({
      "league/pool.go": ["package league", "", "func pool() int { return 1 }", "", "func list() int {", "\tpool := pool()", "\treturn pool", "}", ""].join("\n"),
    });
    expect(valueFlowLinks(analyses)).toEqual([]);
    const plain = buildSymbolLinks(analyses).filter((l) => l.sourceSymbol === "list");
    expect(plain.map((l) => `${l.callName} -> ${l.targetSymbol} [${l.strategy}]`)).toEqual(["pool -> pool [direct]"]);
  });

  it("holds a value the call does not run back: a plain function named like a local stays resolved", async () => {
    const analyses = await analyzeAll({
      "league/ref.go": ["package league", "", "func report(n string) {}", "func caller() {", "\treport(\"x\")", "}", ""].join("\n"),
    });
    expect(valueFlowLinks(analyses)).toEqual([]);
    const plain = buildSymbolLinks(analyses).filter((l) => l.sourceSymbol === "caller");
    expect(plain.map((l) => `${l.callName} -> ${l.targetSymbol}`)).toEqual(["report -> report"]);
  });
});

describe("Go function values: registries, literal factories and name collisions", () => {
  it("a package slice filled in init and run by element", async () => {
    const analyses = await analyzeAll({
      "league/hooks.go": [
        "package league",
        "",
        "var hooks []func(string)",
        "",
        "func save(n string)    {}",
        "func release(n string) {}",
        "",
        "func init() { hooks = append(hooks, save) }",
        "",
        "func fireAll() {",
        "\tfor _, h := range hooks {",
        "\t\th(\"b\")",
        "\t}",
        "}",
        "",
      ].join("\n"),
    });
    expect(valueFlowLinks(analyses)).toEqual(["fireAll: h -> league/hooks.go::save"]);
  });

  it("a package-level function literal that returns a function is a factory", async () => {
    const analyses = await analyzeAll({
      "league/factory.go": [
        "package league",
        "",
        "func save(n string) {}",
        "",
        "var mk = func() func(string) { return save }",
        "",
        "func useMk() {",
        "\th := mk()",
        "\th(\"b\")",
        "}",
        "",
      ].join("\n"),
    });
    expect(valueFlowLinks(analyses)).toEqual(["useMk: h -> league/factory.go::save"]);
  });

  it("a name that is a function-typed field on one type and a method on another keeps the method's link", async () => {
    const analyses = await analyzeAll({
      "league/srv.go": [
        "package league",
        "",
        "type Srv struct{ Handler func(string) }",
        "type Other struct{}",
        "",
        "func (o *Other) Handler(s string) {}",
        "",
        "func call(o *Other) { o.Handler(\"c\") }",
        "",
      ].join("\n"),
    });
    expect(valueFlowLinks(analyses)).toEqual([]);
    const plain = buildSymbolLinks(analyses).filter((l) => l.sourceSymbol === "call");
    expect(plain.map((l) => `${l.callName} -> ${l.targetSymbol}`)).toEqual(["o.Handler -> Other.Handler"]);
  });

  it("a short declaration of a name from itself reads the outer one", async () => {
    const analyses = await analyzeAll({
      "league/shadow.go": [
        "package league",
        "",
        "func save(n string) {}",
        "",
        "func outer() { inner(save) }",
        "func inner(h func(string)) {",
        "\th := h",
        "\th(\"d\")",
        "}",
        "",
      ].join("\n"),
    });
    expect(valueFlowLinks(analyses)).toEqual(["inner: h -> league/shadow.go::save"]);
  });
});
