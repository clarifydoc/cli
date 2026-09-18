import { describe, it, expect } from "vitest";
import "../extractors/registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../parsers/parser-manager.js";
import { computeComplexity, aggregateComplexity } from "./complexity-analyzer.js";
import type { ComplexityInfo, FunctionInfo, Language } from "../types/analysis.js";

/**
 * The cyclomatic number is the pre-existing metric and must not move; the
 * cognitive number is the new one. The pairs below are the cases where the two
 * are supposed to DISAGREE — that disagreement is the whole point of adding it.
 */

const fn = (name: string, line: number, endLine: number, params = 0): FunctionInfo => ({
  name,
  params: Array.from({ length: params }, (_, i) => ({ name: `p${i}`, type: null, defaultValue: null })),
  returnType: null,
  isAsync: false,
  isExported: false,
  decorators: [],
  calls: [],
  line,
  endLine,
});

async function measure(src: string, language: Language, file: string, params = 0): Promise<ComplexityInfo> {
  const tree = await parseSource(src, language as any, file);
  const lines = src.split("\n").length;
  const [row] = computeComplexity(tree, language, [fn("f", 1, lines, params)], []);
  return row;
}

describe("computeComplexity — cognitive vs cyclomatic (TypeScript)", () => {
  it("scores a branch-free body at zero cognitive and one cyclomatic", async () => {
    const row = await measure(`function f(a: number) {\n  return a + 1;\n}`, "typescript", "f.ts", 1);
    expect(row.complexity).toBe(1);
    expect(row.cognitive).toBe(0);
    expect(row.nestingDepth).toBe(0);
    expect(row.paramCount).toBe(1);
  });

  it("gives three flat ifs and three nested ifs the same cyclomatic but different cognitive", async () => {
    const flat = await measure(
      `function f(a, b, c) {
  if (a) return 1;
  if (b) return 2;
  if (c) return 3;
  return 0;
}`,
      "typescript",
      "flat.ts",
    );
    const nested = await measure(
      `function f(a, b, c) {
  if (a) {
    if (b) {
      if (c) {
        return 3;
      }
    }
  }
  return 0;
}`,
      "typescript",
      "nested.ts",
    );
    expect(flat.complexity).toBe(4);
    expect(nested.complexity).toBe(4);
    // flat: 1 + 1 + 1; nested: 1 + 2 + 3
    expect(flat.cognitive).toBe(3);
    expect(nested.cognitive).toBe(6);
    expect(flat.nestingDepth).toBe(1);
    expect(nested.nestingDepth).toBe(3);
  });

  it("treats `else if` as a continuation: +1 with no nesting penalty", async () => {
    const row = await measure(
      `function f(a) {
  if (a === 1) {
    return 1;
  } else if (a === 2) {
    return 2;
  } else if (a === 3) {
    return 3;
  }
  return 0;
}`,
      "typescript",
      "elseif.ts",
    );
    expect(row.complexity).toBe(4);
    expect(row.cognitive).toBe(3);
    expect(row.nestingDepth).toBe(1);
  });

  it("charges a branch inside a callback one extra level", async () => {
    const row = await measure(
      `function f(xs) {
  xs.forEach((x) => {
    if (x) {
      log(x);
    }
  });
}`,
      "typescript",
      "cb.ts",
    );
    // if at depth 1 (inside the arrow function) → 1 + 1
    expect(row.complexity).toBe(2);
    expect(row.cognitive).toBe(2);
    expect(row.nestingDepth).toBe(2);
  });

  it("counts logical operators once each in both metrics", async () => {
    const row = await measure(`function f(a, b, c) {\n  return a && b || c;\n}`, "typescript", "ops.ts");
    expect(row.complexity).toBe(3);
    expect(row.cognitive).toBe(2);
  });
});

describe("computeComplexity — other grammars", () => {
  it("treats Python elif as a continuation and nests inside for", async () => {
    const row = await measure(
      `def f(xs):
    for x in xs:
        if x == 1:
            pass
        elif x == 2:
            pass
    return 0
`,
      "python",
      "f.py",
    );
    // for (1) + if inside for (1+1) + elif (1) = 4
    expect(row.complexity).toBe(4);
    expect(row.cognitive).toBe(4);
    expect(row.nestingDepth).toBe(2);
  });

  it("charges a C# branch inside a lambda one extra level", async () => {
    const src = `class C {
  void F(int[] xs) {
    xs.ToList().ForEach(x => {
      if (x > 0) { Log(x); }
    });
  }
}`;
    const tree = await parseSource(src, "csharp" as any, "C.cs");
    const [row] = computeComplexity(tree, "csharp", [], [
      {
        name: "C", extends: null, implements: [], decorators: [], properties: [], isExported: true, line: 1, endLine: 7,
        methods: [fn("F", 2, 6, 1)],
      },
    ]);
    expect(row.functionName).toBe("C.F");
    expect(row.complexity).toBe(2);
    expect(row.cognitive).toBe(2);
    expect(row.paramCount).toBe(1);
  });
});

describe("aggregateComplexity", () => {
  it("sums and maxes the cognitive fields when rows carry them", () => {
    const [agg] = aggregateComplexity([
      {
        filePath: "a.ts",
        complexities: [
          { functionName: "x", complexity: 3, line: 1, endLine: 5, cognitive: 4, nestingDepth: 2, paramCount: 1 },
          { functionName: "y", complexity: 1, line: 6, endLine: 8, cognitive: 0, nestingDepth: 0, paramCount: 0 },
        ],
      },
    ]);
    expect(agg.totalComplexity).toBe(4);
    expect(agg.maxComplexity).toBe(3);
    expect(agg.totalCognitive).toBe(4);
    expect(agg.maxCognitive).toBe(4);
    expect(agg.maxNestingDepth).toBe(2);
  });

  it("leaves the cognitive aggregates out for rows from an older extractor", () => {
    const [agg] = aggregateComplexity([
      { filePath: "a.ts", complexities: [{ functionName: "x", complexity: 3, line: 1, endLine: 5 }] },
    ]);
    expect(agg.totalComplexity).toBe(3);
    expect(agg).not.toHaveProperty("totalCognitive");
    expect(agg).not.toHaveProperty("maxNestingDepth");
  });
});
