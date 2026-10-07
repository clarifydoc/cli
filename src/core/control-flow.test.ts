import { describe, it, expect, beforeAll } from "vitest";
import fg from "fast-glob";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { Language } from "../types/analysis.js";
import type { Cfg } from "../types/control-flow.js";
import { ensureLanguagesLoaded } from "../extractors/registry.js";
import { extractClasses, extractFunctions } from "../extractors/functions-classes/index.js";
import { parseSource, type TSNode, type TreeSitterLanguage } from "../parsers/parser-manager.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { buildControlFlow, cyclomaticFromCfg, undrawnStructure } from "./control-flow.js";

/**
 * Corpus globs are relative to the repository and run with `cwd`: an absolute
 * pattern built by `resolve()` carries backslashes on Windows, which fast-glob
 * reads as escapes, and the corpus silently comes back empty.
 */
const REPO = resolve(__dirname, "../..");

async function cfgsFor(source: string, language: TreeSitterLanguage, file: string) {
  const tree = await parseSource(source, language, file);
  const functions = extractFunctions(tree, source, language as Language);
  const classes = extractClasses(tree, source, language as Language);
  const rows = computeComplexity(tree, language as Language, functions, classes);
  return rows.map((row) => ({
    row,
    cfg: buildControlFlow(
      tree,
      language as Language,
      { name: row.functionName, line: row.line, endLine: row.endLine },
      file,
    ),
  }));
}

/** Build one CFG from a snippet, for the shape assertions. */
async function only(source: string, language: TreeSitterLanguage = "typescript"): Promise<Cfg> {
  const built = await cfgsFor(source, language, `probe.${language === "csharp" ? "cs" : "ts"}`);
  const first = built.find((b) => b.cfg !== null);
  if (!first?.cfg) throw new Error("no CFG built for the snippet");
  return first.cfg;
}

/** Edges out of the node whose label contains `needle`. */
function edgesFrom(cfg: Cfg, needle: string) {
  const node = cfg.nodes.find((n) => n.label.includes(needle));
  if (!node) throw new Error(`no node labelled like ${needle}: ${cfg.nodes.map((n) => n.label).join(" | ")}`);
  return cfg.edges.filter((e) => e.from === node.id);
}

function kinds(cfg: Cfg, kind: Cfg["nodes"][number]["kind"]) {
  return cfg.nodes.filter((n) => n.kind === kind);
}

/** Every node is reachable from ENTRY — the check that catches a dropped edge. */
function reachable(cfg: Cfg): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of cfg.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const seen = new Set([cfg.entry]);
  const queue = [cfg.entry];
  for (let i = 0; i < queue.length; i++) {
    for (const next of out.get(queue[i]!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

beforeAll(async () => {
  await ensureLanguagesLoaded([
    "typescript", "csharp", "python", "php", "java", "kotlin", "pascal",
  ]);
});

describe("buildControlFlow — graph shapes", () => {
  it("draws both arms of an if/else and rejoins them", async () => {
    const cfg = await only(`
      function f(a: number) {
        if (a > 0) { log(a); } else { log(-a); }
        done();
      }
    `);
    const out = edgesFrom(cfg, "a > 0");
    expect(out.map((e) => e.label).sort()).toEqual(["false", "true"]);
    expect(kinds(cfg, "MERGE")).toHaveLength(1);
  });

  it("does not invent a rejoin when both arms leave the function", async () => {
    const cfg = await only(`
      function f(a: number) {
        if (a > 0) { return 1; } else { return 2; }
      }
    `);
    expect(kinds(cfg, "MERGE")).toHaveLength(0);
    expect(kinds(cfg, "RETURN")).toHaveLength(2);
    for (const ret of kinds(cfg, "RETURN")) {
      expect(cfg.edges.some((e) => e.from === ret.id && e.to === cfg.exit)).toBe(true);
    }
  });

  it("treats `else if` as a second decision, not a nested block", async () => {
    const cfg = await only(`
      function f(a: number) {
        if (a > 2) { x(); } else if (a > 1) { y(); } else { z(); }
      }
    `);
    expect(kinds(cfg, "DECISION")).toHaveLength(2);
  });

  it("closes a loop with a back edge and exits on the false branch", async () => {
    const cfg = await only(`
      function f(n: number) {
        while (n > 0) { n--; }
        return n;
      }
    `);
    const loop = kinds(cfg, "LOOP");
    expect(loop).toHaveLength(1);
    expect(cfg.edges.some((e) => e.to === loop[0]!.id && e.back)).toBe(true);
    expect(cfg.edges.some((e) => e.from === loop[0]!.id && e.label === "false")).toBe(true);
  });

  it("sends `break` past the loop and `continue` back to its head", async () => {
    const cfg = await only(`
      function f(xs: number[]) {
        for (const x of xs) {
          if (x < 0) continue;
          if (x > 10) break;
          use(x);
        }
        after();
      }
    `);
    const loop = kinds(cfg, "LOOP")[0]!;
    const jumps = kinds(cfg, "BREAK_CONTINUE");
    expect(jumps).toHaveLength(2);

    const cont = jumps.find((n) => n.label.startsWith("continue"))!;
    expect(cfg.edges.some((e) => e.from === cont.id && e.to === loop.id && e.back)).toBe(true);

    // `break` must not land back on the loop head — that is the classic
    // structured-CFG bug, and it inverts the meaning of the diagram.
    const brk = jumps.find((n) => n.label.startsWith("break"))!;
    expect(cfg.edges.some((e) => e.from === brk.id && e.to === loop.id)).toBe(false);
    expect(cfg.edges.some((e) => e.from === brk.id)).toBe(true);
  });

  it("runs a do/while body before its test", async () => {
    const cfg = await only(`
      function f(n: number) {
        do { n--; } while (n > 0);
        return n;
      }
    `);
    const head = cfg.nodes.find((n) => n.kind === "MERGE")!;
    const test = kinds(cfg, "LOOP")[0]!;
    // ENTRY reaches the body before the test, and the test loops back.
    expect(cfg.edges.some((e) => e.from === cfg.entry && e.to === head.id)).toBe(true);
    expect(cfg.edges.some((e) => e.from === test.id && e.to === head.id && e.back)).toBe(true);
  });

  it("gives a switch one arm per case and falls through an empty one", async () => {
    const cfg = await only(`
      function f(a: number) {
        switch (a) {
          case 1: one(); break;
          case 2:
          case 3: twoOrThree(); break;
          default: other();
        }
      }
    `);
    const arms = cfg.nodes.filter((n) => n.nodeType === "switch_case" || n.nodeType === "switch_default");
    expect(arms.map((a) => a.label)).toEqual(["1", "2", "3", "default"]);
    // The empty `case 2:` falls into `case 3`'s statements.
    const two = arms.find((a) => a.label === "2")!;
    const three = arms.find((a) => a.label === "3")!;
    expect(cfg.edges.some((e) => e.from === two.id && e.to === three.id)).toBe(true);
  });

  it("routes an explicit throw to the enclosing catch, and past it when there is none", async () => {
    const guarded = await only(`
      function f() {
        try { throw new Error("x"); } catch (e) { handle(e); }
      }
    `);
    const thrown = kinds(guarded, "THROW")[0]!;
    const caught = kinds(guarded, "CATCH")[0]!;
    expect(guarded.edges.some((e) => e.from === thrown.id && e.to === caught.id)).toBe(true);

    const bare = await only(`function f() { throw new Error("x"); }`);
    const loose = kinds(bare, "THROW")[0]!;
    expect(bare.edges.some((e) => e.from === loose.id && e.to === bare.exit)).toBe(true);
  });

  it("reaches a finally from the return that jumps over it", async () => {
    // `try { return … } finally { … }` has no normal exit out of the guarded
    // block, so before the unwind edges existed the entire finally body was
    // emitted with nothing pointing at it — drawn, but floating. Real code in
    // this repo has this shape (`withStdoutProtected`, `DataSourceExtractor`).
    const cfg = await only(`
      function f() {
        try { return risky(); } finally { cleanup(); }
      }
    `);
    const ret = kinds(cfg, "RETURN")[0]!;
    const cleanup = cfg.nodes.find((n) => n.label.includes("cleanup"))!;
    expect(cfg.edges).toContainEqual({ from: ret.id, to: cleanup.id, label: "finally", unwind: true });
    // The return still says where control actually goes.
    expect(cfg.edges.some((e) => e.from === ret.id && e.to === cfg.exit)).toBe(true);
    for (const node of cfg.nodes) expect(reachable(cfg).has(node.id)).toBe(true);
  });

  it("sends a throw to the first catch clause, which is the one tested first", async () => {
    const cfg = await only(
      `
      class C {
        public int M(System.Collections.Generic.List<int> xs) {
          try { throw new System.InvalidOperationException("x"); }
          catch (System.InvalidOperationException e) { return -1; }
          catch { return -2; }
        }
      }
      `,
      "csharp",
    );
    const thrown = kinds(cfg, "THROW")[0]!;
    const catches = kinds(cfg, "CATCH");
    expect(catches).toHaveLength(2);
    const target = cfg.edges.find((e) => e.from === thrown.id && e.label === "throws")!.to;
    expect(target).toBe(catches[0]!.id);
    expect(target).not.toBe(catches[1]!.id);
  });

  it("does not draw a finally detour for a throw its own try catches", async () => {
    // The caught throw runs the finally by way of the catch clause, and that
    // path is already in the graph; a second dotted edge straight to the
    // finally claims a route that does not exist.
    const cfg = await only(`
      function f() {
        try { throw new Error("x"); } catch (e) { handle(e); } finally { cleanup(); }
      }
    `);
    const thrown = kinds(cfg, "THROW")[0]!;
    expect(cfg.edges.some((e) => e.from === thrown.id && e.unwind)).toBe(false);

    // An UNCAUGHT throw does leave, and must show the detour.
    const uncaught = await only(`
      function f() {
        try { throw new Error("x"); } finally { cleanup(); }
      }
    `);
    const loose = kinds(uncaught, "THROW")[0]!;
    expect(uncaught.edges.some((e) => e.from === loose.id && e.unwind)).toBe(true);
  });

  it("flags a finally rather than drawing an edge it cannot model", async () => {
    const cfg = await only(`
      function f() {
        try { risky(); } catch (e) { handle(e); } finally { cleanup(); }
      }
    `);
    expect(cfg.hasFinally).toBe(true);
  });

  it("counts a nested loop's own head and keeps every node reachable", async () => {
    const cfg = await only(`
      function f(xs: number[][]) {
        for (const row of xs) {
          for (const cell of row) {
            if (cell > 0) { total += cell; }
          }
        }
        return total;
      }
    `);
    expect(kinds(cfg, "LOOP")).toHaveLength(2);
    const seen = reachable(cfg);
    for (const node of cfg.nodes) expect(seen.has(node.id)).toBe(true);
  });

  it("reports branches hidden inside a statement rather than losing them", async () => {
    const cfg = await only(`
      function f(a: number, b: number) {
        const x = a > 0 ? 1 : 2;
        return x;
      }
    `);
    const hiding = cfg.nodes.find((n) => n.inlineBranches > 0);
    expect(hiding?.inlineBranches).toBe(1);
  });

  it("does not descend into a callback, but still counts what it hides", async () => {
    const cfg = await only(`
      function f(xs: number[]) {
        xs.forEach((x) => { if (x > 0) { use(x); } });
      }
    `);
    // One statement, not a branch of the outer function's control flow…
    expect(kinds(cfg, "DECISION")).toHaveLength(0);
    // …but the branch inside it is still reported.
    expect(cfg.nodes.some((n) => n.inlineBranches === 1)).toBe(true);
  });

  it("builds C# from the same tables", async () => {
    const cfg = await only(
      `
      class C {
        public int Everything(System.Collections.Generic.List<int> xs) {
          int total = 0;
          foreach (var x in xs) { if (x < 0) { continue; } total += x; }
          switch (total) { case 1: total = 10; break; default: total = 0; break; }
          try { total++; } catch (System.Exception e) { total = -1; } finally { total = 0; }
          return total;
        }
      }
      `,
      "csharp",
    );
    expect(kinds(cfg, "LOOP")).toHaveLength(1);
    expect(kinds(cfg, "CATCH")).toHaveLength(1);
    expect(cfg.hasFinally).toBe(true);
    expect(cfg.nodes.some((n) => n.nodeType === "switch_section")).toBe(true);
    const seen = reachable(cfg);
    for (const node of cfg.nodes) expect(seen.has(node.id)).toBe(true);
  });

  it("refuses rather than drawing the wrong body when the function cannot be located", async () => {
    const source = `function f() { return 1; }`;
    const tree = await parseSource(source, "typescript", "probe.ts");
    const cfg = buildControlFlow(
      tree,
      "typescript" as Language,
      { name: "ghost", line: 400, endLine: 500 },
      "probe.ts",
    );
    expect(cfg).toBeNull();
  });
});


/**
 * The gates.
 *
 * Two of them, because one alone has a blind spot the other covers.
 *
 * **Arithmetic** — `cyclomaticFromCfg` counts what the graph modelled;
 * `computeComplexity` counts branch nodes in the same body with the same
 * tables. They must agree exactly, over every function in the corpus. It is
 * the sharper check: a region walked twice or an arm dropped shows up as a
 * number that differs.
 *
 * It can only see what the complexity table counts, though, and a table can be
 * wrong. Pascal's names five node types its grammar does not have, so every
 * Delphi function reports complexity 1 and both sides of the arithmetic agree
 * no matter what the graph does.
 *
 * **Structural** — `undrawnStructure` walks the source instead and requires a
 * graph node for every construct the language gave a structural role. It needs
 * no table to be right, so it holds where the arithmetic is blind, and it
 * names what went missing. It is what caught a nested `else if` chain dropping
 * its final `else` in Java, Kotlin and TypeScript — invisible to the
 * arithmetic, because an `else` block with no branch in it changes no count.
 *
 * **Coverage** — and a corpus that stops exercising a construct must fail
 * loudly rather than go on reporting a green check for code it no longer
 * reaches. The first version of this gate passed with a deliberate bug in the
 * builder because the fixtures contain no `switch` at all.
 */
const PROBES = resolve(__dirname, "__fixtures__");

interface Corpus {
  label: string;
  language: TreeSitterLanguage;
  globs: string[];
  /** Read as text, parsed as `language` regardless of the name on disk. */
  probe: string;
  /** Node types the corpus must contain, or the gate is weaker than it reads. */
  required: string[];
  /** Fewest graphs the corpus should yield — a guard against it going quiet. */
  minGraphs: number;
}

const CORPORA: Corpus[] = [
  {
    label: "TypeScript",
    language: "typescript",
    globs: ["src/**/*.ts"],
    probe: resolve(PROBES, "control-flow-typescript-probe.ts.txt"),
    required: [
      "if_statement", "else_clause", "while_statement", "do_statement",
      "for_statement", "for_in_statement", "switch_statement", "switch_case",
      "switch_default", "try_statement", "catch_clause", "finally_clause",
      "break_statement", "continue_statement", "labeled_statement",
      "throw_statement", "ternary_expression",
    ],
    minGraphs: 500,
  },
  {
    label: "C#",
    language: "csharp",
    globs: ["test-fixtures/sample-csharp-api/**/*.cs", "test-fixtures/sample-fullstack-cqrs/**/*.cs"],
    probe: resolve(PROBES, "control-flow-csharp-probe.cs.txt"),
    required: [
      "if_statement", "while_statement", "do_statement", "for_statement",
      "foreach_statement", "switch_statement", "switch_section", "try_statement",
      "catch_clause", "finally_clause", "break_statement", "continue_statement",
      "using_statement", "lock_statement", "goto_statement",
      "conditional_expression",
    ],
    minGraphs: 15,
  },
  {
    label: "Python",
    language: "python",
    globs: ["test-fixtures/**/*.py"],
    probe: resolve(PROBES, "control-flow-python-probe.py.txt"),
    required: [
      "if_statement", "elif_clause", "else_clause", "while_statement",
      "for_statement", "try_statement", "except_clause", "finally_clause",
      "break_statement", "continue_statement", "raise_statement",
      "with_statement", "match_statement", "case_clause",
      "conditional_expression",
    ],
    minGraphs: 20,
  },
  {
    label: "PHP",
    language: "php",
    globs: ["test-fixtures/**/*.php"],
    probe: resolve(PROBES, "control-flow-php-probe.php.txt"),
    required: [
      "if_statement", "else_if_clause", "else_clause", "while_statement",
      "do_statement", "for_statement", "foreach_statement", "switch_statement",
      "case_statement", "default_statement", "try_statement", "catch_clause",
      "finally_clause", "break_statement", "continue_statement",
      "throw_expression", "conditional_expression",
    ],
    minGraphs: 25,
  },
  {
    label: "Java",
    language: "java",
    globs: ["test-fixtures/**/*.java"],
    probe: resolve(PROBES, "control-flow-java-probe.java.txt"),
    required: [
      "if_statement", "while_statement", "do_statement", "for_statement",
      "enhanced_for_statement", "switch_expression", "switch_block_statement_group",
      "switch_label", "try_statement", "catch_clause", "finally_clause",
      "break_statement", "continue_statement", "labeled_statement",
      "throw_statement", "synchronized_statement", "ternary_expression",
    ],
    minGraphs: 40,
  },
  {
    label: "Kotlin",
    language: "kotlin",
    globs: ["test-fixtures/**/*.kt"],
    probe: resolve(PROBES, "control-flow-kotlin-probe.kt.txt"),
    required: [
      "if_expression", "while_statement", "do_while_statement", "for_statement",
      "when_expression", "when_entry", "try_expression", "catch_block",
      "finally_block", "jump_expression",
    ],
    minGraphs: 5,
  },
  {
    label: "Pascal",
    language: "pascal",
    globs: ["test-fixtures/**/*.pas"],
    probe: resolve(PROBES, "control-flow-pascal-probe.pas.txt"),
    required: ["ifElse", "while", "repeat", "for", "case", "caseCase", "try", "exceptionHandler"],
    minGraphs: 30,
  },
];

async function corpusSources(corpus: Corpus): Promise<{ file: string; source: string }[]> {
  const files = await fg(corpus.globs, {
    cwd: REPO,
    absolute: true,
    ignore: [
      "**/node_modules/**", "**/vendor/**", "**/obj/**", "**/bin/**",
      "**/*.d.ts", "**/*.test.ts",
    ],
  });
  const out = [{ file: `probe.${corpus.language}`, source: await readFile(corpus.probe, "utf8") }];
  for (const file of files) out.push({ file, source: await readFile(file, "utf8") });
  return out;
}

/**
 * The TypeScript corpus is this repository's own source, so every gate below
 * grows with `src/` — a few seconds alone, but CI runs all test files at once
 * on a small runner and the 5 s default is a wall-clock guess that the growing
 * corpus outran.
 */
const CORPUS_TIMEOUT_MS = 120_000;

describe.each(CORPORA)("buildControlFlow — $label corpus", { timeout: CORPUS_TIMEOUT_MS }, (corpus) => {
  it("covers the constructs it claims to", async () => {
    const present = new Set<string>();
    for (const { file, source } of await corpusSources(corpus)) {
      let tree;
      try {
        tree = await parseSource(source, corpus.language, file);
      } catch {
        continue;
      }
      const walk = (n: TSNode): void => {
        present.add(n.type);
        for (const c of n.children) walk(c);
      };
      walk(tree.rootNode);
    }
    expect([...corpus.required].filter((t) => !present.has(t))).toEqual([]);
  });

  it("cyclomatic read off the graph matches the metric", async () => {
    const mismatches: string[] = [];
    let checked = 0;

    for (const { file, source } of await corpusSources(corpus)) {
      for (const { row, cfg } of await cfgsFor(source, corpus.language, file)) {
        if (!cfg) continue;
        checked++;
        const fromGraph = cyclomaticFromCfg(cfg, corpus.language as Language);
        if (fromGraph !== row.complexity) {
          mismatches.push(
            `${file}:${row.line} ${row.functionName} — metric ${row.complexity}, graph ${fromGraph}`,
          );
        }
      }
    }

    expect(checked).toBeGreaterThanOrEqual(corpus.minGraphs);
    expect(mismatches.slice(0, 20)).toEqual([]);
  });

  it("draws every control-flow construct in the body", async () => {
    const undrawn: string[] = [];

    for (const { file, source } of await corpusSources(corpus)) {
      let tree;
      try {
        tree = await parseSource(source, corpus.language, file);
      } catch {
        continue;
      }
      for (const { row, cfg } of await cfgsFor(source, corpus.language, file)) {
        if (!cfg) continue;
        const missing = undrawnStructure(
          tree,
          corpus.language as Language,
          { name: row.functionName, line: row.line, endLine: row.endLine },
          cfg,
        );
        if (missing.length > 0) {
          undrawn.push(
            `${file}:${row.line} ${row.functionName} — ${missing
              .map((m) => `${m.type}@${m.line}`)
              .slice(0, 4)
              .join(", ")}`,
          );
        }
      }
    }

    expect(undrawn.slice(0, 20)).toEqual([]);
  });

  it("leaves no node unreachable from the entry", async () => {
    const orphans: string[] = [];

    for (const { file, source } of await corpusSources(corpus)) {
      for (const { row, cfg } of await cfgsFor(source, corpus.language, file)) {
        if (!cfg) continue;
        const seen = reachable(cfg);
        const lost = cfg.nodes.filter((n) => !seen.has(n.id));
        if (lost.length > 0) {
          orphans.push(
            `${file}:${row.line} ${row.functionName} — ${lost.length} unreachable: ${lost
              .map((n) => `${n.kind} "${n.label}"`)
              .slice(0, 3)
              .join(", ")}`,
          );
        }
      }
    }

    expect(orphans.slice(0, 20)).toEqual([]);
  });
});
