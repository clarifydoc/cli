import { describe, it, expect, beforeAll } from "vitest";
import { glob } from "tinyglobby";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { Language } from "../types/analysis.js";
import type { Cfg } from "../types/control-flow.js";
import { ensureLanguagesLoaded } from "../extractors/registry.js";
import { extractClasses, extractFunctions } from "../extractors/functions-classes/index.js";
import { parseSource, type TreeSitterLanguage } from "../parsers/parser-manager.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { buildControlFlow } from "./control-flow.js";
import { blankNonCode, buildRegexControlFlow, regexStructureMetrics } from "./control-flow-regex.js";
import { controlFlowForFile } from "./control-flow-file.js";
import { Language as TSLanguage, Parser, type Node } from "web-tree-sitter";

const REPO = resolve(__dirname, "../..");
const FIXTURES = resolve(REPO, "test-fixtures");
/**
 * Globs are relative to REPO and run with `cwd`: an absolute pattern built by
 * `resolve()` carries backslashes on Windows, which the glob engine reads as escapes,
 * and the corpus silently comes back empty.
 */
const GLOB = { cwd: REPO, absolute: true } as const;

beforeAll(async () => {
  await ensureLanguagesLoaded([
    "typescript", "csharp", "java",
    "go", "rust", "c", "cpp", "dart", "swift", "perl", "objc", "ruby", "lua", "elixir", "vb",
  ]);
});

describe("blankNonCode", () => {
  const js = { statements: [], regexLiterals: true };

  it("keeps every character's position so line and brace counting survive", () => {
    const source = 'const a = "hello"; // note\nconst b = 1;';
    const out = blankNonCode(source, js);
    expect(out).toHaveLength(source.length);
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("const a =");
    expect(out).not.toContain("hello");
    expect(out).not.toContain("note");
  });

  it("stops a brace inside a string from moving the nesting", () => {
    // The whole point: `"}"` used to close a block that was never open.
    const out = blankNonCode('if (x) { say("}"); }', js);
    expect((out.match(/\}/g) ?? []).length).toBe(1);
  });

  it("stops a brace inside a comment from moving the nesting", () => {
    const out = blankNonCode("if (x) { // } } }\n  y();\n}", js);
    expect((out.match(/\}/g) ?? []).length).toBe(1);
  });

  it("blanks a regex literal but not a division", () => {
    const withRegex = blankNonCode("const r = /a\\}b\\{c/g;", js);
    expect(withRegex).not.toContain("}");
    expect(withRegex).not.toContain("{");

    const division = blankNonCode("const q = total / count;", js);
    expect(division).toContain("total / count");
  });

  it("leaves regex literals alone for a language that has none", () => {
    const c = { statements: [] };
    expect(blankNonCode("int q = a / b / c;", c)).toContain("a / b / c");
  });
});

/**
 * Shape of a graph, as the comparison sees it. Node counts by kind rather than
 * an exact isomorphism: the regex tier cannot be expected to produce the same
 * graph as a parser, only the same reading of the function.
 */
function shape(cfg: Cfg) {
  const count = (kind: string): number => cfg.nodes.filter((n) => n.kind === kind).length;
  return {
    decisions: count("DECISION"),
    loops: count("LOOP"),
    returns: count("RETURN"),
    throws: count("THROW"),
    jumps: count("BREAK_CONTINUE"),
    catches: count("CATCH"),
  };
}

/**
 * The gate for the regex tier.
 *
 * There is no complexity table to check the arithmetic against and no tree to
 * check the structure against — that is the whole reason this tier exists. So
 * it is measured against the one thing that IS ground truth: on a language
 * that has a parser, both tiers can read the same code, and the scanner's
 * answer can be compared to the real one.
 *
 * The thresholds are held a little below what the implementation currently
 * scores, so an ordinary refactor does not trip them but a regression in how
 * the scanner reads code does. They were also what drove the work: the first
 * version scored 44.6% on TypeScript, and measuring it is what identified
 * brace-less `if` bodies, un-skipped callbacks, Allman braces and regex
 * literals as the four things that mattered.
 */
interface Measured {
  language: TreeSitterLanguage;
  globs: string[];
  /** Fewest functions that must be compared, so the gate cannot go quiet. */
  minFunctions: number;
  /** Lowest acceptable share of functions whose shape matches exactly. */
  minExact: number;
  /** Lowest shares whose regex nesting depth / cognitive complexity equal the parser's. */
  minNesting: number;
  minCognitive: number;
}

const MEASURED: Measured[] = [
  {
    language: "typescript",
    globs: ["src/**/*.ts"],
    minFunctions: 1200,
    minExact: 0.9,
    // TypeScript's ternaries (and the `?` of its types) are invisible to a line
    // scanner; it never takes this path in production, having a parser.
    minNesting: 0.8,
    minCognitive: 0.55,
  },
  { language: "csharp", globs: ["test-fixtures/**/*.cs"], minFunctions: 20, minExact: 0.85, minNesting: 0.93, minCognitive: 0.93 },
  { language: "java", globs: ["test-fixtures/**/*.java"], minFunctions: 40, minExact: 0.9, minNesting: 0.95, minCognitive: 0.95 },
];

/**
 * The TypeScript corpus is this repository's own source, so the gate's cost
 * grows with every line added to `src/`. A few seconds alone, but CI runs all
 * test files at once on a small runner and the 5 s default is a wall-clock
 * guess that the growing corpus outran.
 */
const CORPUS_TIMEOUT_MS = 120_000;

describe.each(MEASURED)("regex tier agrees with the parser — $language", { timeout: CORPUS_TIMEOUT_MS }, (target) => {
  it("reads the same shape as the parse tree", async () => {
    const files = await glob(target.globs, {
      ...GLOB,
      ignore: ["**/node_modules/**", "**/*.test.ts", "**/*.d.ts", "**/obj/**", "**/bin/**"],
    });

    let compared = 0;
    let exact = 0;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      let tree;
      try {
        tree = await parseSource(source, target.language, file);
      } catch {
        continue;
      }
      const language = target.language as Language;
      const functions = extractFunctions(tree, source, language);
      const classes = extractClasses(tree, source, language);

      for (const row of computeComplexity(tree, language, functions, classes)) {
        const ref = { name: row.functionName, line: row.line, endLine: row.endLine };
        const parsed = buildControlFlow(tree, language, ref, file);
        const scanned = buildRegexControlFlow(source, language, ref, file);
        if (!parsed || !scanned) continue;
        compared++;
        const a = shape(parsed);
        const b = shape(scanned);
        if (JSON.stringify(a) === JSON.stringify(b)) exact++;
      }
    }

    expect(compared).toBeGreaterThanOrEqual(target.minFunctions);
    expect(exact / compared).toBeGreaterThanOrEqual(target.minExact);
  });
});

/**
 * The gate for keyword-delimited languages. None of them has a parser in the
 * product, so the ground truth comes from tree-sitter-ruby, a dev dependency
 * used only here: what the parse tree says a method contains — branches
 * (`if`/`unless`/`elsif` and their modifiers, each `case` and its arms), loops,
 * returns, `raise`, jumps, `rescue` clauses — outside the blocks and lambdas
 * both tiers treat as closures. Measured on chatwoot's 10,477 methods at 98.9%
 * and match-centre's 4,704 at 98.0% when written; the threshold sits below that.
 */
describe("keyword-delimited regex tier agrees with tree-sitter-ruby", { timeout: CORPUS_TIMEOUT_MS }, () => {
  const CLOSURE = new Set(["block", "do_block", "lambda", "method", "singleton_method", "class", "module", "singleton_class"]);
  const truth = (method: Node) => {
    const t = { decisions: 0, loops: 0, returns: 0, throws: 0, jumps: 0, catches: 0 };
    const walk = (n: Node, top: boolean): void => {
      if (!top && CLOSURE.has(n.type)) return;
      switch (n.type) {
        case "if": case "unless": case "elsif": case "if_modifier": case "unless_modifier": t.decisions++; break;
        case "case": case "case_match":
          t.decisions++;
          for (const c of n.namedChildren) if (c && (c.type === "when" || c.type === "in_clause" || c.type === "else")) t.decisions++;
          break;
        case "while": case "until": case "for": case "while_modifier": case "until_modifier": t.loops++; break;
        case "return": t.returns++; break;
        case "break": case "next": case "redo": case "retry": t.jumps++; break;
        case "rescue": t.catches++; break;
        case "identifier": case "call": {
          const name = n.type === "identifier" ? n.text : n.childForFieldName("method")?.text;
          const receiver = n.type === "call" ? n.childForFieldName("receiver") : null;
          if ((name === "raise" || name === "fail") && !receiver && (n.type === "call" || n.parent?.type !== "call")) t.throws++;
          break;
        }
      }
      for (const c of n.namedChildren) if (c) walk(c, false);
    };
    walk(method, true);
    return t;
  };

  it("reads the same shape as the Ruby parse tree", async () => {
    await parseSource("const x = 1;", "typescript", "init.ts"); // initializes the runtime
    const parser = new Parser();
    parser.setLanguage(await TSLanguage.load(resolve(REPO, "node_modules/tree-sitter-ruby/tree-sitter-ruby.wasm")));
    const files = await glob(["test-fixtures/**/*.rb"], { ...GLOB, ignore: ["**/node_modules/**"] });
    let compared = 0;
    let exact = 0;
    for (const file of files) {
      const source = await readFile(file, "utf8");
      const tree = parser.parse(source);
      if (!tree) continue;
      for (const m of tree.rootNode.descendantsOfType(["method", "singleton_method"])) {
        if (!m) continue;
        const ref = { name: m.childForFieldName("name")?.text ?? "?", line: m.startPosition.row + 1, endLine: m.endPosition.row + 1 };
        const scanned = buildRegexControlFlow(source, "ruby", ref, file);
        if (!scanned) continue;
        compared++;
        if (JSON.stringify(truth(m)) === JSON.stringify(shape(scanned))) exact++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(50);
    expect(exact / compared).toBeGreaterThanOrEqual(0.95);
  });
});

describe("keyword-delimited languages — what each spec reads", () => {
  const draw = (language: Language, source: string) => {
    const lines = source.split("\n").length;
    const cfg = buildRegexControlFlow(source, language, { name: "f", line: 1, endLine: lines }, `x.${language}`);
    expect(cfg?.approximate).toBe(true);
    return shape(cfg!);
  };

  it("Ruby: modifiers, case arms with string labels, def-level rescue, closures skipped", () => {
    expect(draw("ruby", `def f(x)
  return if x.nil?
  raise ArgumentError, 'bad' unless x.valid?
  case x.kind
  when 'a' then go
  when 'b'
    stop
  else
    other
  end
  items.each do |i|
    return i if i.ok?
  end
rescue StandardError => e
  log(e)
end`)).toMatchObject({ decisions: 6, returns: 1, throws: 1, catches: 1 });
  });

  it("Lua: if/elseif chains, loops, one-line guards, repeat-until", () => {
    expect(draw("lua", `function M.f(t)
  if not t then return nil end
  for i = 1, #t do
    if t[i] == 0 then
      break
    elseif t[i] < 0 then
      error("negative")
    end
  end
  repeat
    t = step(t)
  until done(t)
  return t
end`)).toMatchObject({ decisions: 3, loops: 2, returns: 2, throws: 1, jumps: 1 });
  });

  it("Elixir: case arms, keyword if, with/else, rescue, fn closures skipped", () => {
    expect(draw("elixir", `def f(x) do
  if x == nil, do: raise(ArgumentError)
  case fetch(x) do
    {:ok, v} -> v
    {:error, e} -> raise e
  end
  Enum.map(x, fn y -> if y, do: 1 end)
rescue
  e -> log(e)
end`)).toMatchObject({ decisions: 4, throws: 2, catches: 1 });
  });

  it("VB: block and one-line If, Select Case, Try/Catch, Exit Function, any casing", () => {
    expect(draw("vb", `Public Function F(x As Integer) As Integer
    If x < 0 Then Return -1
    Select Case x
        Case 0
            Return 0
        Case Else
            x = x - 1
    End Select
    For Each i In items
        If i Is Nothing Then
            Exit For
        ElseIf i.Bad Then
            Throw New Exception("bad")
        end if
    Next
    Try
        Save()
    Catch ex As Exception
        Exit Function
    End Try
    Return x
End Function`)).toMatchObject({ decisions: 6, loops: 1, returns: 4, throws: 1, jumps: 1, catches: 1 });
  });
});

/**
 * Cognitive complexity and nesting depth for the regex path come from the same
 * synthesized structure, so they are gated the same way: on the languages with a
 * parser, the regex numbers are compared with the parsed tier's.
 */
describe.each(MEASURED)("regex structure metrics agree with the parser — $language", { timeout: CORPUS_TIMEOUT_MS }, (target) => {
  it("gives the same nesting depth and cognitive complexity", async () => {
    const files = await glob(target.globs, {
      ...GLOB,
      ignore: ["**/node_modules/**", "**/*.test.ts", "**/*.d.ts", "**/obj/**", "**/bin/**"],
    });
    let compared = 0;
    let nesting = 0;
    let cognitive = 0;
    for (const file of files) {
      const source = await readFile(file, "utf8");
      let tree;
      try {
        tree = await parseSource(source, target.language, file);
      } catch {
        continue;
      }
      const language = target.language as Language;
      const functions = extractFunctions(tree, source, language);
      const classes = extractClasses(tree, source, language);
      const sourceLines = source.split("\n");
      for (const row of computeComplexity(tree, language, functions, classes)) {
        if (row.cognitive === undefined || row.nestingDepth === undefined) continue;
        const scanned = regexStructureMetrics(sourceLines, language, { name: row.functionName, line: row.line, endLine: row.endLine });
        if (!scanned) continue;
        compared++;
        if (scanned.nestingDepth === row.nestingDepth) nesting++;
        if (scanned.cognitive === row.cognitive) cognitive++;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(target.minFunctions);
    expect(nesting / compared).toBeGreaterThanOrEqual(target.minNesting);
    expect(cognitive / compared).toBeGreaterThanOrEqual(target.minCognitive);
  });
});

describe("regex tier — the languages that have only it", () => {
  const cases: { file: string; language: string; expect: Partial<ReturnType<typeof shape>> }[] = [
    {
      file: `${FIXTURES}/sample-go-api/handler/user_handler.go`,
      language: "go",
      // `GetUser` guards two calls with `if err != nil { … return }`.
      expect: { decisions: 2, returns: 2 },
    },
  ];

  for (const probe of cases) {
    it(`draws ${probe.language} from its source`, async () => {
      const result = await controlFlowForFile({
        filePath: probe.file,
        functionName: "GetUser",
      });
      const cfg = result.cfgs[0];
      expect(cfg).toBeDefined();
      // Everything from this tier must announce itself as inferred.
      expect(cfg!.approximate).toBe(true);
      expect(shape(cfg!)).toMatchObject(probe.expect);
    });
  }

  it("marks every graph it produces as approximate, and the parsed ones not at all", async () => {
    const scanned = await controlFlowForFile({
      filePath: `${FIXTURES}/sample-go-api/handler/user_handler.go`,
    });
    expect(scanned.cfgs.length).toBeGreaterThan(0);
    for (const cfg of scanned.cfgs) expect(cfg.approximate).toBe(true);

    const parsed = await controlFlowForFile({
      filePath: `${FIXTURES}/sample-backend/services/userService.ts`,
    });
    expect(parsed.cfgs.length).toBeGreaterThan(0);
    for (const cfg of parsed.cfgs) expect(cfg.approximate).toBeUndefined();
  });

  it("never loops or runs away on real source", async () => {
    // A scanner must terminate whatever it is handed. Pathological nesting and
    // unbalanced delimiters are the two ways this kind of code hangs.
    const files = await glob(
      ["test-fixtures/**/*.go", "test-fixtures/**/*.rs", "test-fixtures/**/*.c", "test-fixtures/**/*.dart"],
      { ...GLOB, ignore: ["**/node_modules/**"] },
    );
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const result = await controlFlowForFile({ filePath: file }).catch(() => null);
      if (!result) continue;
      for (const cfg of result.cfgs) {
        expect(cfg.nodes.length).toBeGreaterThan(0);
        // Every edge names a node that exists — the invariant that a graph is
        // a graph at all.
        const ids = new Set(cfg.nodes.map((n) => n.id));
        for (const edge of cfg.edges) {
          expect(ids.has(edge.from)).toBe(true);
          expect(ids.has(edge.to)).toBe(true);
        }
      }
    }
  });
});
