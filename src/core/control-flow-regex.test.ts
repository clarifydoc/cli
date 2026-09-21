import { describe, it, expect, beforeAll } from "vitest";
import fg from "fast-glob";
import { readFile } from "fs/promises";
import { resolve } from "path";
import type { Language } from "../types/analysis.js";
import type { Cfg } from "../types/control-flow.js";
import { ensureLanguagesLoaded } from "../extractors/registry.js";
import { extractClasses, extractFunctions } from "../extractors/functions-classes/index.js";
import { parseSource, type TreeSitterLanguage } from "../parsers/parser-manager.js";
import { computeComplexity } from "./complexity-analyzer.js";
import { buildControlFlow } from "./control-flow.js";
import { blankNonCode, buildRegexControlFlow } from "./control-flow-regex.js";
import { controlFlowForFile } from "./control-flow-file.js";

const REPO = resolve(__dirname, "../..");
const FIXTURES = resolve(REPO, "test-fixtures");

beforeAll(async () => {
  await ensureLanguagesLoaded([
    "typescript", "csharp", "java",
    "go", "rust", "c", "cpp", "dart", "swift", "perl", "objc",
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
}

const MEASURED: Measured[] = [
  {
    language: "typescript",
    globs: [resolve(REPO, "src/**/*.ts")],
    minFunctions: 1200,
    minExact: 0.9,
  },
  { language: "csharp", globs: [`${FIXTURES}/**/*.cs`], minFunctions: 20, minExact: 0.85 },
  { language: "java", globs: [`${FIXTURES}/**/*.java`], minFunctions: 40, minExact: 0.9 },
];

describe.each(MEASURED)("regex tier agrees with the parser — $language", (target) => {
  it("reads the same shape as the parse tree", async () => {
    const files = await fg(target.globs, {
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
    const files = await fg(
      [`${FIXTURES}/**/*.go`, `${FIXTURES}/**/*.rs`, `${FIXTURES}/**/*.c`, `${FIXTURES}/**/*.dart`],
      { ignore: ["**/node_modules/**"] },
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
