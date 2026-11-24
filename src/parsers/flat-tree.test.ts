import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import type { Node } from "web-tree-sitter";
import { ensureLanguagesLoaded, pluginFor } from "../extractors/registry.js"; // side effect: registers tree-sitter grammars
import { parseSource, parseWebAssemblyTree, runQuery } from "./parser-manager.js";
import { parseErrorsOf } from "../core/coverage.js";
import { getLanguageForFile } from "./language-map.js";
import { flattenTree, FlatNode, FlatTree } from "./flat-tree.js";
import { normalizeSource } from "./normalize-source.js";

const FIXTURES = join(import.meta.dirname, "../../test-fixtures");

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git") continue;
      yield* files(p);
    } else if (st.size < 200_000) yield p;
  }
}

const pt = (p: { row: number; column: number }) => `${p.row}:${p.column}`;
const brief = (n: Node | FlatNode | null) => (n ? `${n.type}@${n.startIndex}-${n.endIndex}` : null);

/** Every member of the used subset, real node against flat node, in a parallel walk; returns the first differences. */
function compare(real: Node, flat: FlatNode, ids: Map<number, FlatNode>, diffs: string[], sampleEvery: number, counter: { n: number }): void {
  const where = `${brief(real)}`;
  const same = (what: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b) && diffs.length < 20) diffs.push(`${where} ${what}: real ${JSON.stringify(a)} flat ${JSON.stringify(b)}`);
  };
  same("type", real.type, flat.type);
  same("typeId", real.typeId, flat.typeId);
  same("isNamed", real.isNamed, flat.isNamed);
  same("isMissing", real.isMissing, flat.isMissing);
  same("isError", real.isError, flat.isError);
  same("hasError", real.hasError, flat.hasError);
  same("startIndex", real.startIndex, flat.startIndex);
  same("endIndex", real.endIndex, flat.endIndex);
  same("startPosition", pt(real.startPosition), pt(flat.startPosition));
  same("endPosition", pt(real.endPosition), pt(flat.endPosition));
  same("text", real.text, flat.text);
  same("childCount", real.childCount, flat.childCount);
  same("namedChildCount", real.namedChildCount, flat.namedChildCount);
  same("descendantCount", real.descendantCount, flat.descendantCount);
  same("parent", brief(real.parent), brief(flat.parent));
  same("nextSibling", brief(real.nextSibling), brief(flat.nextSibling));
  same("previousSibling", brief(real.previousSibling), brief(flat.previousSibling));
  same("nextNamedSibling", brief(real.nextNamedSibling), brief(flat.nextNamedSibling));
  same("previousNamedSibling", brief(real.previousNamedSibling), brief(flat.previousNamedSibling));
  same("firstChild", brief(real.firstChild), brief(flat.firstChild));
  same("lastChild", brief(real.lastChild), brief(flat.lastChild));
  same("firstNamedChild", brief(real.firstNamedChild), brief(flat.firstNamedChild));
  same("lastNamedChild", brief(real.lastNamedChild), brief(flat.lastNamedChild));
  same("children", real.children.map(brief), flat.children.map(brief));
  same("namedChildren", real.namedChildren.map(brief), flat.namedChildren.map(brief));
  const fields = new Set<string>(["no_such_field"]);
  for (let i = 0; i < real.childCount; i++) {
    same(`child(${i})`, brief(real.child(i)), brief(flat.child(i)));
    const name = real.fieldNameForChild(i);
    same(`fieldNameForChild(${i})`, name, flat.fieldNameForChild(i));
    if (name) fields.add(name);
  }
  for (let i = 0; i < real.namedChildCount; i++) same(`namedChild(${i})`, brief(real.namedChild(i)), brief(flat.namedChild(i)));
  same("child(out of range)", brief(real.child(real.childCount)), brief(flat.child(real.childCount)));
  for (const f of fields) {
    same(`childForFieldName(${f})`, brief(real.childForFieldName(f)), brief(flat.childForFieldName(f)));
    same(`childrenForFieldName(${f})`, real.childrenForFieldName(f).map(brief), flat.childrenForFieldName(f).map(brief));
  }
  // id equality: the same node reached twice has the same id; two nodes never share one.
  const up = real.parent;
  if (up && diffs.length < 20) {
    // The real node's id is the same for every wrapper minted for it (a child reached through its parent, or from the sibling before it).
    const via = up.children.find((c) => c.startIndex === real.startIndex && c.endIndex === real.endIndex && c.type === real.type);
    if (via && via.id !== real.id) diffs.push(`${where} real id unstable`);
    if (up.id === real.id) diffs.push(`${where} real id equals its parent's`);
  }
  const seen = ids.get(real.id);
  if (seen && seen !== flat && diffs.length < 20) diffs.push(`${where} real id shared with another flat node`);
  ids.set(real.id, flat);
  if (flat.id !== flat.tree.rootNode.id + flat.index) diffs.push(`${where} flat id not stable`);
  if (counter.n++ % sampleEvery === 0 || real.parent === null) {
    const types = [...new Set(real.descendantsOfType(["identifier", "(", "string"]).map((n) => n.type))];
    for (const t of [...types, "identifier", ["identifier", "string_literal", "block"]]) {
      same(`descendantsOfType(${JSON.stringify(t)})`, real.descendantsOfType(t as never).map(brief), flat.descendantsOfType(t as never).map(brief));
    }
    // Anonymous and named types of the tree itself, by name.
    const names = [...new Set(real.children.map((c) => c.type))];
    if (names.length) same(`descendantsOfType(children types)`, real.descendantsOfType(names).map(brief), flat.descendantsOfType(names).map(brief));
  }
  const rk = real.children;
  const fk = flat.children;
  for (let i = 0; i < rk.length; i++) compare(rk[i]!, fk[i]!, ids, diffs, sampleEvery, counter);
}

describe("flat tree equals the real tree", () => {
  const sources: Array<{ name: string; text: string }> = [];
  for (const p of files(FIXTURES)) {
    const lang = getLanguageForFile(p);
    if (lang) sources.push({ name: relative(FIXTURES, p), text: normalizeSource(readFileSync(p, "utf-8")) });
  }
  // What the analyzer parses of a single-file component is its script, after the plugin's preprocess.
  const components = sources.filter((s) => /\.(?:vue|svelte)$/.test(s.name));

  // Non-ASCII spellings: the index units of a JS string input, in columns and in text.
  sources.push(
    { name: "unicode.ts", text: 'const été = "café ☕ 🏟️";\nexport function équipe(joueur: string) { return `⚽ ${joueur}`; }\n' },
    { name: "unicode.py", text: 'club = "Zürich 🏟"\ndef équipe():\n    return "⚽ ✓"\n' },
    { name: "unicode.cs", text: 'class Équipe { string Nom = "日本 🚗"; void Jouer() { var x = "é"; } }\n' },
    { name: "unicode.java", text: 'class Équipe { String nom = "日本 🚗"; void jouer() { var x = "é"; } }\n' },
    { name: "unicode.kt", text: 'class Équipe { val nom = "日本 🚗"\n  fun jouer() { val x = "é" } }\n' },
    { name: "unicode.php", text: '<?php\n$nom = "日本 🚗";\nfunction équipe($joueur) { return "⚽ $joueur"; }\n' },
    // A hidden zero-width MISSING token (the automatic semicolon), alone and beside an ERROR node of the same file.
    { name: "hidden-missing.kt", text: 'class Équipe { val nom = "日本"\n  fun jouer() { val x = "é" } }\n' },
    { name: "hidden-missing-error.kt", text: 'class Équipe { val nom = "日本"\n  fun jouer() { val x = "é" } }\nfun ( { class = ;\n' },
    { name: "broken.py", text: "def (:\n  class 😀 = \nx = 1\n" },
    { name: "broken.java", text: "class A { void m( { int x = ; } }\n" },
    { name: "broken.kt", text: "class A { fun m( { val x = ; } }\n" },
    { name: "broken.php", text: "<?php\nfunction ( { class = ;\n$a = 1;\n" },
    { name: "broken.ts", text: "function ( { class 😀 = ;\nconst a = 1;\n" },
    { name: "unicode.fs", text: 'module Équipe\nlet nom = "日本 🚗"\nlet jouer x = "⚽ é"\n' },
    { name: "unicode.sh", text: '#!/bin/bash\nnom="日本 🚗"\njouer() { echo "⚽ é"; }\n' },
    { name: "unicode.r", text: 'nom <- "日本 🚗"\njouer <- function(x) { paste("⚽ é", x) }\n' },
    { name: "unicode.jl", text: 'nom = "日本 🚗"\nfunction jouer(x)\n  return "⚽ é"\nend\n' },
    { name: "unicode.zig", text: 'const nom = "日本 🚗";\npub fn jouer() void { _ = "⚽ é"; }\n' },
    { name: "unicode.ml", text: 'let nom = "日本 🚗"\nlet jouer x = "⚽ é" ^ x\n' },
    { name: "unicode.pas", text: "unit Equipe;\ninterface\nconst Nom = '日本 🚗';\nimplementation\nend.\n" },
    { name: "broken.fs", text: "let ( = \nmodule 😀 = \nlet x = 1\n" },
    { name: "broken.sh", text: "if [ ; then\nfoo() { echo \"😀\n" },
    { name: "broken.r", text: "f <- function( { x = \n😀 <- 1\n" },
    { name: "broken.jl", text: "function ( \n  x = \nend end 😀\n" },
    { name: "broken.zig", text: "pub fn ( void { const = ;\n" },
    { name: "broken.ml", text: "let ( = \nmodule 😀 = struct\n" },
    { name: "broken.pas", text: "unit ; interface procedure ( ; implementation 😀 end.\n" },
    { name: "broken.cs", text: "class A { void M( { int x = ; } }\n" },
  );

  it("answers every used member alike for each fixture tree", async () => {
    await ensureLanguagesLoaded(["typescript", "javascript", "python", "java", "kotlin", "php", "fsharp", "bash", "r", "julia", "zig", "ocaml", "pascal"]);
    const scripts: Array<{ name: string; text: string }> = [];
    for (const c of components) {
      const pre = pluginFor("typescript")?.preprocess?.(c.text, c.name);
      if (pre && !("skip" in pre)) scripts.push({ name: `${c.name}.script.${pre.language === "javascript" ? "js" : "ts"}`, text: pre.sourceText });
    }
    let compared = 0;
    const perLanguage = new Map<string, number>();
    const skipped: string[] = [];
    const errors: string[] = [];
    for (const { name, text } of [...sources, ...scripts]) {
      const lang = getLanguageForFile(name);
      let tree;
      try {
        tree = await parseWebAssemblyTree(text, lang as never, name);
      } catch {
        skipped.push(name);
        continue;
      }
      const flat = flattenTree(tree, text);
      expect(flat).toBeInstanceOf(FlatTree);
      expect(flat.count).toBe(tree.rootNode.descendantCount);
      const diffs: string[] = [];
      compare(tree.rootNode, flat.rootNode, new Map(), diffs, 25, { n: 0 });
      if (diffs.length) errors.push(`${name}:\n  ${diffs.slice(0, 4).join("\n  ")}`);
      compared++;
      perLanguage.set(String(lang), (perLanguage.get(String(lang)) ?? 0) + 1);
    }
    expect(compared).toBeGreaterThan(100);
    // Every language the feature covers has real fixture files compared, not only the inline sources above.
    for (const l of ["fsharp", "bash", "r", "julia", "zig", "ocaml", "pascal"]) expect(perLanguage.get(l) ?? 0, l).toBeGreaterThan(2);
    expect(errors.length ? [`${errors.length} files differ: ${errors.map((e) => e.split(":")[0]).join(", ")}`, ...errors.slice(0, 5)] : []).toEqual([]);
  }, 600_000);

  it("counts parse errors, runs queries and parses through the feature as the real tree does", async () => {
    for (const name of ["broken.ts", "broken.cs", "unicode.cs"]) {
      const text = sources.find((s) => s.name === name)!.text;
      const lang = getLanguageForFile(name) as never;
      const real = await parseWebAssemblyTree(text, lang, name);
      const flat = flattenTree(real, text);
      expect(parseErrorsOf(flat as never, text.length)).toEqual(parseErrorsOf(real, text.length));
      const query = "(identifier) @id";
      const viaReal = await runQuery(real, lang, query);
      expect(await runQuery(flat as never, lang, query)).toEqual(viaReal);
    }
    const prior = process.env.CLARIFYDOC_FEATURES;
    process.env.CLARIFYDOC_FEATURES = "flat-tree";
    try {
      expect(await parseSource("class Car { }\n", "csharp", "Car.cs")).toBeInstanceOf(FlatTree);
      expect(await parseSource("const car = 1;\n", "typescript", "car.ts")).toBeInstanceOf(FlatTree);
      expect(await parseSource("class Car:\n    pass\n", "python", "car.py")).toBeInstanceOf(FlatTree);
      expect(await parseSource("class Car { }\n", "java", "Car.java")).toBeInstanceOf(FlatTree);
      expect(await parseSource("class Car\n", "kotlin", "Car.kt")).toBeInstanceOf(FlatTree);
      expect(await parseSource("<?php class Car {}\n", "php", "Car.php")).toBeInstanceOf(FlatTree);
      expect(await parseSource("let car = 1\n", "fsharp", "car.fs")).toBeInstanceOf(FlatTree);
      expect(await parseSource("car=1\n", "bash", "car.sh")).toBeInstanceOf(FlatTree);
      expect(await parseSource("car <- 1\n", "r", "car.r")).toBeInstanceOf(FlatTree);
      expect(await parseSource("car = 1\n", "julia", "car.jl")).toBeInstanceOf(FlatTree);
      expect(await parseSource("const car = 1;\n", "zig", "car.zig")).toBeInstanceOf(FlatTree);
      expect(await parseSource("let car = 1\n", "ocaml", "car.ml")).toBeInstanceOf(FlatTree);
      expect(await parseSource("unit Car;\ninterface\nimplementation\nend.\n", "pascal", "Car.pas")).toBeInstanceOf(FlatTree);
    } finally {
      if (prior === undefined) delete process.env.CLARIFYDOC_FEATURES;
      else process.env.CLARIFYDOC_FEATURES = prior;
    }
  });
});
