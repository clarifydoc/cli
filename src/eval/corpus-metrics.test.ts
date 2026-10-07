import { describe, it, expect } from "vitest";
import {
  computeCorpusMetrics,
  linkRecords,
  diffCorpusLinks,
  isJoinableTarget,
  startsWithHole,
  type CorpusSummary,
  type CorpusLink,
} from "./corpus-metrics.js";

function link(over: Partial<CorpusLink>): CorpusLink {
  return {
    source: "web/api.ts",
    sourceLine: 1,
    method: "GET",
    url: "/api/x",
    target: "srv/x.ts",
    targetLine: 10,
    confidence: "EXTRACTED",
    ...over,
  };
}

describe("isJoinableTarget", () => {
  it("accepts app-relative paths and loopback origins, rejects words and other hosts", () => {
    expect(isJoinableTarget("/api/users")).toBe(true);
    expect(isJoinableTarget("series/all")).toBe(true);
    expect(isJoinableTarget("http://localhost:5000/api/x")).toBe(true);
    expect(isJoinableTarget("https://api.github.com/repos")).toBe(false);
    expect(isJoinableTarget("page")).toBe(false);
    expect(isJoinableTarget("mailto:a/b")).toBe(false);
    expect(isJoinableTarget(null)).toBe(false);
  });
});

describe("startsWithHole", () => {
  it("detects an unresolved leading base in either spelling", () => {
    expect(startsWithHole("${this.baseUrl}email/all")).toBe(true);
    expect(startsWithHole("{}series/{}")).toBe(true);
    expect(startsWithHole("/api/${id}")).toBe(false);
  });
});

describe("computeCorpusMetrics", () => {
  const summary: CorpusSummary = {
    files: ["web/api.ts", "web/api.spec.ts", "gen/client.ts", "srv/x.ts", "spec/openapi.json"],
    generatedRoots: ["gen"],
    fileLayerMap: { "web/api.spec.ts": "test", "web/api.ts": "services" },
    routeMap: [
      { path: "/api/x", httpMethod: "GET", kind: "api", filePath: "srv/x.ts" },
      { path: "/api/x", httpMethod: "GET", kind: "api", filePath: "spec/openapi.json" },
      { path: "/y", httpMethod: "GET", kind: "api", filePath: "srv/x.ts", prefixUnresolved: "base:Api" },
      { path: "/home", kind: "frontend", filePath: "web/home.vue" },
    ],
    apiCalls: [
      { target: "/api/x", filePath: "web/api.ts" },
      { target: "page", filePath: "web/api.ts" },
      { target: "page", filePath: "web/api.spec.ts" },
      { target: "${this.baseUrl}email/all", filePath: "web/api.ts" },
      { target: "/api/x", filePath: "gen/client.ts", baseExpr: "basePath" },
      { target: "https://example.com/a", filePath: "web/api.ts" },
    ],
    apiRouteLinks: [
      link({}),
      link({ source: "web/api.spec.ts", target: "spec/openapi.json", confidence: "AMBIGUOUS" }),
      link({ url: "${this.itemRoute(id)}/duplicate", matchedVia: "exact", sourceLine: 7 }),
      link({ source: "gen/client.ts", url: "/x", matchedVia: "base-unresolved:/api", confidence: "INFERRED" }),
    ],
    componentGraph: { a: ["b", "c"], b: ["c"] },
    layerViolations: [{ sourceFile: "a" }, { sourceFile: "a" }, { sourceFile: "b" }],
    securityIssues: [
      { severity: "high", filePath: "a" },
      { severity: "critical", filePath: "a" },
      { severity: "medium", filePath: "b" },
      { severity: "low", filePath: "b" },
    ],
    healthScore: {
      score: 36,
      grade: "F",
      penalties: [
        { reason: "4 critical/high security issue(s)", points: 20 },
        { reason: "43 layer violation(s)", points: 10 },
        { reason: "10 circular dependency cycle(s)", points: 17 },
      ],
    },
    deadCode: { files: [1, 2], exports: [1] },
  };
  const m = computeCorpusMetrics(summary, { isContractFile: (f) => f.endsWith(".json") });

  it("splits files and calls by role", () => {
    expect(m.files).toEqual({ analyzed: 5, test: 1, generated: 1 });
    expect(m.apiCalls.byRole).toEqual({ production: 4, test: 1, generated: 1 });
  });

  it("separates code routes from contract routes and counts unresolved prefixes", () => {
    expect(m.routes).toEqual({ api: 3, code: 2, contract: 1, prefixUnresolved: 1, frontend: 1 });
  });

  it("counts bare-word targets only in production code", () => {
    expect(m.apiCalls.noSlashTargets).toBe(1);
    expect(m.apiCalls.joinable).toBe(3);
    expect(m.apiCalls.joinableProduction).toBe(2);
    expect(m.apiCalls.leadingHole).toBe(1);
    expect(m.apiCalls.baseUnresolved).toBe(1);
  });

  it("classifies links by role, tier and where they land", () => {
    expect(m.links.byRole).toEqual({ production: 2, test: 1, generated: 1 });
    expect(m.links.toContract).toBe(1);
    expect(m.links.toCode).toBe(3);
    expect(m.links.byMatchedVia).toEqual({ exact: 3, "base-unresolved:/api": 1 });
    expect(m.links.productionByConfidence).toEqual({ EXTRACTED: 2 });
  });

  it("flags a leading hole that matched as a path, but not one the linker knew was a base", () => {
    expect(m.links.leadingWildcard).toBe(1);
  });

  it("measures the component graph and quality inputs", () => {
    expect(m.graph).toEqual({ nodes: 3, edges: 3, maxIn: 2 });
    expect(m.quality).toEqual({
      layerViolations: 3,
      layerViolationSourceFiles: 2,
      securityCriticalHigh: 2,
      securityMedium: 1,
      securityCriticalHighFiles: 1,
    });
  });

  it("maps health penalties to dimensions", () => {
    expect(m.health).toEqual({
      score: 36,
      grade: "F",
      penalties: { securityCriticalHigh: 20, layers: 10, cycles: 17 },
    });
  });

  it("measures an old summary with missing fields as zero, not a crash", () => {
    const empty = computeCorpusMetrics({});
    expect(empty.links.total).toBe(0);
    expect(empty.health.score).toBeNull();
    expect(empty.links.productionLinkedPct).toBe(0);
  });
});

describe("diffCorpusLinks", () => {
  const before = linkRecords({
    apiRouteLinks: [
      link({ sourceLine: 1, target: "a.ts" }),
      link({ sourceLine: 2, target: "b.ts" }),
      link({ sourceLine: 3, target: "c.ts", confidence: "AMBIGUOUS" }),
      link({ sourceLine: 4 }),
    ],
  });
  const after = linkRecords({
    apiRouteLinks: [
      link({ sourceLine: 1, target: "a.ts" }),
      link({ sourceLine: 2, target: "z.ts" }),
      link({ sourceLine: 3, target: "c.ts", confidence: "EXTRACTED" }),
      link({ sourceLine: 5 }),
    ],
  });
  const d = diffCorpusLinks(before, after);

  it("tells a retarget from a removal plus an addition", () => {
    expect(d.retargeted).toHaveLength(1);
    expect(d.retargeted[0].before.route).toBe("b.ts:10");
    expect(d.retargeted[0].after.route).toBe("z.ts:10");
    expect(d.removed.map((r) => r.call)).toEqual(["web/api.ts:4 GET /api/x"]);
    expect(d.added.map((r) => r.call)).toEqual(["web/api.ts:5 GET /api/x"]);
  });

  it("reports a confidence change on the same route as requalified", () => {
    expect(d.requalified).toHaveLength(1);
    expect(d.requalified[0].after.confidence).toBe("EXTRACTED");
    expect(d.unchanged).toBe(1);
  });

  it("keeps two identical calls on one line distinct", () => {
    const recs = linkRecords({ apiRouteLinks: [link({}), link({ target: "b.ts" })] });
    expect(recs.map((r) => r.call)).toEqual(["web/api.ts:1 GET /api/x", "web/api.ts:1 GET /api/x #2"]);
  });
});
