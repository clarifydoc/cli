import { describe, it, expect } from "vitest";
import { buildReportPayload, SYMBOL_LINK_STRATEGIES, SYMBOL_LINK_RELATIONS } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Wire-encoding contract: the payload's big arrays carry files[]-index refs
 * (decoded client-side by application/spa/src/report/decode.ts), unknown paths
 * stay verbatim strings, and — critically — the in-memory summary is NEVER
 * mutated, because writeProjectSummary runs after buildReportPayload.
 */

const summary = {
  projectRoot: "C:/proj",
  analyzedAt: "t",
  detectedFrameworks: [],
  subProjects: [],
  fileProjects: {},
  files: ["src/a.ts", "src/b.ts"],
  componentGraph: { "src/a.ts": ["src/b.ts"] },
  complexity: [
    {
      filePath: "src/a.ts", totalComplexity: 5, maxComplexity: 5, averageComplexity: 5,
      functions: [{ functionName: "f", complexity: 5, line: 1, endLine: 9 }],
    },
  ],
  linkGraph: [{ source: "src/a.ts", target: "src/b.ts", proximity: 1, reason: "import", calls: [] }],
  routeMap: [],
  apiCalls: [],
  screens: [],
  interactiveElements: [],
  componentUsage: [],
  events: [],
  symbolLinks: [
    {
      sourceFile: "src/a.ts", sourceSymbol: "f", sourceLine: 1, callName: "g",
      targetFile: "src/b.ts", targetSymbol: "g", targetLine: 2,
    },
    {
      sourceFile: "src/a.ts", sourceSymbol: "f", sourceLine: 3, callName: "x",
      targetFile: "node_modules/x.ts", targetSymbol: "x", targetLine: 1, // not in files[]
    },
  ],
  blastRadius: [
    {
      filePath: "src/b.ts",
      directDependents: 1,
      transitiveDependents: 0,
      impactScore: 1,
      centrality: 1,
      level: "low",
      affectedFiles: ["src/a.ts"],
      transitiveFiles: [],
      dependsOn: [],
      exportedSymbols: [{ name: "g", usedByCount: 1, callers: [{ file: "src/a.ts", line: 1 }] }],
      changeRisk: "safe",
      maxDepth: 1,
      traceImpact: {
        screens: [{ name: "S", file: "src/a.ts", route: "/" }],
        screenCount: 1,
        routes: [], routeCount: 0, entities: [], entityCount: 0, queues: [], queueCount: 0,
      },
    },
  ],
  classGraph: {
    nodes: [
      { id: "src/b.ts::B", name: "B", filePath: "src/b.ts", isInterface: false, isExternal: false, isFile: false, inboundCount: 1, outboundCount: 0 },
      { id: "src/a.ts::A", name: "A", filePath: "src/a.ts", isInterface: false, isExternal: false, isFile: false, inboundCount: 0, outboundCount: 1 },
    ],
    edges: [{ source: "src/a.ts::A", target: "src/b.ts::B", byKind: { field: 1 }, total: 1, category: "data" }],
  },
  fileChurn: [{ file: "src/a.ts", commits: 2, additions: 1, deletions: 0, lastTouched: "t", authors: ["r"], authorCount: 1 }],
  hotspots: [{ file: "src/a.ts", score: 1, commits: 2, totalComplexity: 5 }],
} as unknown as ProjectAnalysis;

describe("buildReportPayload wire encoding", () => {
  const payload = buildReportPayload(summary);
  const strOf = (i: unknown) => payload.wireStrings![i as number];

  it("emits symbolLinks as tuples with files[]-index and wireStrings-index refs", () => {
    const t = payload.symbolLinks[0];
    expect(Array.isArray(t)).toBe(true);
    expect(t[0]).toBe(0); // sourceFile → files[0]
    expect(t[4]).toBe(1); // targetFile → files[1]
    expect(strOf(t[1])).toBe("f");
    expect(strOf(t[3])).toBe("g");
    expect(strOf(t[5])).toBe("g");
    expect(t[2]).toBe(1);
    expect(t[6]).toBe(2);
    expect(t.length).toBe(7); // no resolvedBy/confidence/navigational → meta omitted
  });

  it("packs resolvedBy/confidence/navigational into the meta slot", () => {
    const withMeta = buildReportPayload({
      ...(summary as object),
      symbolLinks: [
        {
          sourceFile: "src/a.ts", sourceSymbol: "f", sourceLine: 1, callName: "g",
          targetFile: "src/b.ts", targetSymbol: "g", targetLine: 2,
          resolvedBy: "lsp", confidence: "INFERRED", navigational: true,
        },
      ],
    } as unknown as ProjectAnalysis);
    expect(withMeta.symbolLinks[0][7]).toBe(2 * 100 + 2 * 10 + 1);
  });

  it("packs strategy and relation into higher decades, leaving the old ones alone", () => {
    const withMeta = buildReportPayload({
      ...(summary as object),
      symbolLinks: [
        {
          sourceFile: "src/a.ts", sourceSymbol: "f", sourceLine: 1, callName: "g",
          targetFile: "src/b.ts", targetSymbol: "g", targetLine: 2,
          resolvedBy: "lsp", confidence: "INFERRED", navigational: true,
          strategy: "unique-global", relation: "calls",
        },
      ],
    } as unknown as ProjectAnalysis);
    const meta = withMeta.symbolLinks[0][7] as number;
    // The three original fields keep their exact decades, so an OLD decoder
    // reading a NEW artifact still gets them right.
    expect(Math.floor(meta / 100) % 10).toBe(2); // resolvedBy: lsp
    expect(Math.floor(meta / 10) % 10).toBe(2); // confidence: INFERRED
    expect(meta % 10).toBe(1); // navigational
    expect(SYMBOL_LINK_STRATEGIES[(Math.floor(meta / 1000) % 100) - 1]).toBe("unique-global");
    expect(SYMBOL_LINK_RELATIONS[Math.floor(meta / 100000) - 1]).toBe("calls");
  });

  it("collapses every dispatch:<id> strategy to one report-side code", () => {
    const enc = (strategy: string) =>
      (buildReportPayload({
        ...(summary as object),
        symbolLinks: [
          {
            sourceFile: "src/a.ts", sourceSymbol: "f", sourceLine: 1, callName: "g",
            targetFile: "src/b.ts", targetSymbol: "g", targetLine: 2, strategy,
          },
        ],
      } as unknown as ProjectAnalysis).symbolLinks[0][7] as number);
    // The resolver id is an open set; the report only needs the kind. The exact
    // id survives in project-summary.json, which is what lsp:compare reads.
    expect(enc("dispatch:mediatr")).toBe(enc("dispatch:webflow"));
    expect(enc("dispatch:mediatr")).not.toBe(enc("direct"));
  });

  /**
   * The encoder lives here and the decoder lives in application/spa, a package
   * that cannot import this one — the two enum orders are kept in step by hand.
   * This test removes the "by hand": it encodes with the real encoder and
   * decodes with the real SPA decoder, so a reordered or truncated alphabet on
   * either side fails here rather than silently mislabelling every published
   * report.
   */
  it("round-trips through the SPA decoder, which is a separate package", async () => {
    // Imported through a variable so `tsc --noEmit` does not try to pull a file
    // outside this package's rootDir into the program (TS6059). The point of
    // the test is the RUNTIME round-trip against the real decoder, not its
    // types — vitest resolves the specifier, tsc stays out of it.
    const decoderPath = "../../application/spa/src/report/decode.js";
    const { decodePayload } = (await import(/* @vite-ignore */ decoderPath)) as {
      decodePayload: (p: unknown) => { symbolLinks: unknown };
    };
    const cases = [
      { strategy: "direct", relation: "calls" },
      { strategy: "unique-global-blind", relation: "calls" },
      { strategy: "lsp-reference", relation: "reference", resolvedBy: "lsp" },
      { strategy: "interface-fanout", relation: "implements", navigational: true },
      { strategy: "api-route", relation: "http", confidence: "AMBIGUOUS" },
    ];
    for (const c of cases) {
      const encoded = buildReportPayload({
        ...(summary as object),
        symbolLinks: [
          {
            sourceFile: "src/a.ts", sourceSymbol: "f", sourceLine: 1, callName: "g",
            targetFile: "src/b.ts", targetSymbol: "g", targetLine: 2, ...c,
          },
        ],
      } as unknown as ProjectAnalysis);
      const decoded = decodePayload(JSON.parse(JSON.stringify(encoded)));
      expect((decoded.symbolLinks as unknown as Array<Record<string, unknown>>)[0]).toMatchObject(c);
    }
  });

  it("emits linkGraph and complexity as tuples", () => {
    const l = payload.linkGraph[0];
    expect(l[0]).toBe(0);
    expect(l[1]).toBe(1);
    expect(l[2]).toBe(1); // proximity
    expect(strOf(l[3])).toBe("import");

    const c = payload.complexity[0];
    expect(c[0]).toBe(0); // filePath → files[0]
    expect(c[1]).toBe(5); // total
    expect(c[4]).toEqual([[expect.any(Number), 5, 1, 9]]);
    expect(strOf(c[4][0][0])).toBe("f");
  });

  it("emits componentGraph as [fileRef, depRefs[]] pairs", () => {
    expect(payload.componentGraph).toEqual([[0, [1]]]);
  });

  it("encodes blast/churn/hotspot file paths as files[] indices", () => {
    const b = payload.blastRadius[0];
    expect(b.filePath).toBe(1);
    expect(b.affectedFiles).toEqual([0]);
    expect(b.exportedSymbols[0].callers[0].file).toBe(0);
    expect(b.traceImpact.screens[0].file).toBe(0);
    expect(payload.fileChurn[0].file).toBe(0);
    expect(payload.hotspots[0].file).toBe(0);
  });

  it("keeps non-files[] paths as verbatim strings", () => {
    expect(payload.symbolLinks[1][4]).toBe("node_modules/x.ts");
  });

  it("encodes classGraph edges as node indices, keeps node ids", () => {
    expect(payload.classGraph.edges[0]).toMatchObject({ source: 1, target: 0 });
    expect(payload.classGraph.nodes[0].id).toBe("src/b.ts::B");
    expect(payload.classGraph.nodes[0].filePath).toBe(1);
  });

  it("NEVER mutates the summary (it is written to disk afterwards)", () => {
    expect(summary.symbolLinks[0]!.sourceFile).toBe("src/a.ts");
    expect(summary.linkGraph[0]!.source).toBe("src/a.ts");
    expect(summary.componentGraph["src/a.ts"]).toEqual(["src/b.ts"]);
    expect(summary.complexity![0]!.filePath).toBe("src/a.ts");
    expect(summary.complexity![0]!.functions[0]!.functionName).toBe("f");
    expect(summary.blastRadius![0]!.filePath).toBe("src/b.ts");
    expect(summary.blastRadius![0]!.affectedFiles[0]).toBe("src/a.ts");
    expect(summary.blastRadius![0]!.traceImpact!.screens[0]!.file).toBe("src/a.ts");
    expect(summary.classGraph!.edges[0]!.source).toBe("src/a.ts::A");
    expect(summary.fileChurn![0]!.file).toBe("src/a.ts");
  });
});
