import { describe, it, expect } from "vitest";
import { buildReportPayload } from "./report-payload.js";
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
  componentGraph: {},
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

  it("encodes file paths on the big arrays as files[] indices", () => {
    expect(payload.symbolLinks[0]).toMatchObject({ sourceFile: 0, targetFile: 1 });
    expect(payload.linkGraph[0]).toMatchObject({ source: 0, target: 1 });
    const b = payload.blastRadius[0];
    expect(b.filePath).toBe(1);
    expect(b.affectedFiles).toEqual([0]);
    expect(b.exportedSymbols[0].callers[0].file).toBe(0);
    expect(b.traceImpact.screens[0].file).toBe(0);
    expect(payload.fileChurn[0].file).toBe(0);
    expect(payload.hotspots[0].file).toBe(0);
  });

  it("keeps non-files[] paths as verbatim strings", () => {
    expect(payload.symbolLinks[1].targetFile).toBe("node_modules/x.ts");
  });

  it("encodes classGraph edges as node indices, keeps node ids", () => {
    expect(payload.classGraph.edges[0]).toMatchObject({ source: 1, target: 0 });
    expect(payload.classGraph.nodes[0].id).toBe("src/b.ts::B");
    expect(payload.classGraph.nodes[0].filePath).toBe(1);
  });

  it("NEVER mutates the summary (it is written to disk afterwards)", () => {
    expect(summary.symbolLinks[0]!.sourceFile).toBe("src/a.ts");
    expect(summary.linkGraph[0]!.source).toBe("src/a.ts");
    expect(summary.blastRadius![0]!.filePath).toBe("src/b.ts");
    expect(summary.blastRadius![0]!.affectedFiles[0]).toBe("src/a.ts");
    expect(summary.blastRadius![0]!.traceImpact!.screens[0]!.file).toBe("src/a.ts");
    expect(summary.classGraph!.edges[0]!.source).toBe("src/a.ts::A");
    expect(summary.fileChurn![0]!.file).toBe("src/a.ts");
  });
});
