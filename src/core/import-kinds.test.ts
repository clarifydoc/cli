import { describe, expect, it } from "vitest";
import { runtimeGraph, typeOnlyEdges } from "./import-kinds.js";
import { buildComponentGraph } from "./analyzer.js";
import { findCircularDeps } from "./health-scorer.js";
import { classifyFileLayers } from "./layer-analyzer.js";
import type { FileAnalysis } from "../types/analysis.js";

const file = (filePath: string, imports: Array<{ source: string; isType?: boolean }>): FileAnalysis =>
  ({
    filePath, language: "typescript", projectId: "root",
    imports: imports.map((i) => ({ source: i.source, specifiers: ["X"], isDefault: false, isNamespace: false, isType: !!i.isType, line: 1 })),
    exports: [{ name: "X", kind: "class", line: 1 }], functions: [], classes: [], subComponents: [], routes: [], dataSources: [], dataMutations: [],
  }) as unknown as FileAnalysis;

describe("type-only import edges", () => {
  it("records an edge every import of which is `import type`, and drops it from the runtime graph", () => {
    const out: Record<string, string[]> = {};
    const graph = buildComponentGraph([
      file("src/a.ts", [{ source: "./b" }]),
      file("src/b.ts", [{ source: "./a", isType: true }]),
      file("src/c.ts", [{ source: "./d", isType: true }, { source: "./d" }]),
      file("src/d.ts", [{ source: "./c" }]),
    ], out);
    expect(out).toEqual({ "src/b.ts": ["src/a.ts"] });
    expect(findCircularDeps(graph)).toHaveLength(2);
    // a ⇄ b closes only through a type import; c ⇄ d is a runtime cycle.
    expect(findCircularDeps(runtimeGraph(graph, typeOnlyEdges(out, [])))).toEqual([expect.arrayContaining(["src/c.ts", "src/d.ts"])]);
  });

  it("keeps an edge a call goes along, whatever the import says", () => {
    const link = { sourceFile: "src/b.ts", sourceSymbol: "run", sourceLine: 3, targetFile: "src/a.ts", targetSymbol: "X", targetLine: 1, callName: "X" } as never;
    expect(typeOnlyEdges({ "src/b.ts": ["src/a.ts"] }, [link])).toEqual({});
  });
});

describe("layers from what a file does", () => {
  it("places a file no path rule places by its routes, entities, screens or database access, and says why", () => {
    const facts: Record<string, Partial<FileAnalysis>> = {
      "src/x/orders.ts": { routes: [{ kind: "api" }, { kind: "api" }] as never },
      "src/x/order.ts": { classes: [{ name: "Order", decorators: ["entity"] }] as never },
    };
    const reasons: Record<string, string> = {};
    const layers = classifyFileLayers(["src/x/orders.ts", "src/x/order.ts", "src/services/billing.ts", "src/x/misc.ts"], undefined, (f) => {
      const a = facts[f];
      if (a?.routes?.length) return { layer: "ui", reason: `it declares ${a.routes.length} API routes` };
      if (a?.classes?.length) return { layer: "data", reason: "it defines the entity Order" };
      return null;
    }, reasons);
    expect(layers).toEqual({ "src/x/orders.ts": "ui", "src/x/order.ts": "data", "src/services/billing.ts": "services", "src/x/misc.ts": "unknown" });
    expect(reasons["src/x/orders.ts"]).toBe("it declares 2 API routes");
    expect(reasons["src/services/billing.ts"]).toBe("its folder (services)");
    expect(reasons["src/x/misc.ts"]).toMatch(/no path rule/);
  });
});
