import { describe, it, expect } from "vitest";
import { computeImpactDiff, renderImpactMarkdown, renderImpactText } from "./impact-diff.js";
import type { BlastRadiusInfo, ProjectAnalysis, TraceImpactInfo } from "../types/analysis.js";

// ─── fixture ────────────────────────────────────────────────────────────────

const impact = (over: Partial<TraceImpactInfo>): TraceImpactInfo => ({
  screens: [],
  screenCount: 0,
  routes: [],
  routeCount: 0,
  entities: [],
  entityCount: 0,
  queues: [],
  queueCount: 0,
  ...over,
});

const blast = (filePath: string, over: Partial<BlastRadiusInfo> = {}): BlastRadiusInfo => ({
  filePath,
  directDependents: 0,
  transitiveDependents: 0,
  impactScore: 0,
  centrality: 0,
  level: "low",
  affectedFiles: [],
  transitiveFiles: [],
  dependsOn: [],
  exportedSymbols: [],
  changeRisk: "safe",
  maxDepth: 0,
  ...over,
});

const ordersScreen = { name: "Orders", file: "web/Orders.vue", route: "/orders" };
const ordersRoute = { method: "POST", path: "/api/orders", file: "srv/routes.ts", line: 6 };

/** Two import islands, joined only by HTTP: Orders.vue imports the frontend
 *  api client; routes.ts imports service.ts imports util.ts. */
const summary = {
  files: ["web/Orders.vue", "web/api.ts", "srv/routes.ts", "srv/service.ts", "srv/service.test.ts", "srv/util.ts"],
  componentGraph: {
    "web/Orders.vue": ["web/api.ts"],
    "srv/routes.ts": ["srv/service.ts"],
    "srv/service.test.ts": ["srv/service.ts"],
    "srv/service.ts": ["srv/util.ts"],
  },
  screens: [{ name: "Orders", filePath: "web/Orders.vue", routePath: "/orders" }],
  routeMap: [
    { path: "/api/orders", httpMethod: "POST", kind: "api", handler: "createOrder", line: 6, filePath: "srv/routes.ts" },
  ],
  blastRadius: [
    blast("srv/service.ts", {
      changeRisk: "moderate",
      affectedFiles: ["srv/routes.ts", "srv/service.test.ts"],
      transitiveFiles: [],
      traceImpact: impact({
        screens: [ordersScreen],
        screenCount: 1,
        routes: [ordersRoute],
        routeCount: 1,
        entities: ["orders"],
        entityCount: 1,
      }),
    }),
    blast("srv/util.ts", {
      affectedFiles: ["srv/service.ts"],
      traceImpact: impact({
        screens: [ordersScreen],
        screenCount: 1,
        entities: ["orders"],
        entityCount: 1,
      }),
    }),
  ],
} as unknown as ProjectAnalysis;

// ─── computeImpactDiff ──────────────────────────────────────────────────────

describe("computeImpactDiff", () => {
  it("unions cross-tier reach over the changed set and dedupes", () => {
    const r = computeImpactDiff(summary, ["srv/service.ts", "srv/util.ts"]);
    expect(r.changedFiles).toEqual(["srv/service.ts", "srv/util.ts"]);
    expect(r.screens).toEqual([ordersScreen]); // same screen from both files → one entry
    expect(r.screenCount).toBe(1);
    expect(r.routes).toEqual([ordersRoute]);
    expect(r.entities).toEqual(["orders"]);
    expect(r.truncated).toBe(false);
  });

  it("normalizes separators, ./ prefixes and case when matching changed paths", () => {
    const r = computeImpactDiff(summary, ["srv\\service.ts", "./SRV/UTIL.TS", "docs/readme.md"]);
    expect(r.changedFiles).toEqual(["srv/service.ts", "srv/util.ts"]);
    expect(r.unknownFiles).toEqual(["docs/readme.md"]);
  });

  it("collects dependents (minus the changed set) and the tests to run", () => {
    const r = computeImpactDiff(summary, ["srv/service.ts"]);
    expect(r.dependents).toEqual(["srv/routes.ts", "srv/service.test.ts"]);
    expect(r.tests).toEqual(["srv/service.test.ts"]);
  });

  it("chains end at the NEAREST anchor — a route file on the backend island", () => {
    const r = computeImpactDiff(summary, ["srv/service.ts"]);
    expect(r.chains).toEqual([{ path: ["srv/service.ts", "srv/routes.ts"], endsAt: "route" }]);
  });

  it("chains end at a screen file on the frontend island", () => {
    const r = computeImpactDiff(summary, ["web/api.ts"]);
    expect(r.chains).toEqual([{ path: ["web/api.ts", "web/Orders.vue"], endsAt: "screen" }]);
  });

  it("rolls risk up from blast changeRisk and cross-tier reach", () => {
    const r = computeImpactDiff(summary, ["srv/service.ts"]);
    expect(r.risk.level).toBe("moderate");
    expect(r.risk.reasons.join(" ")).toContain("moderate to change");

    const dangerousSummary = {
      ...(summary as object),
      blastRadius: [
        blast("srv/service.ts", { changeRisk: "dangerous", traceImpact: impact({}) }),
      ],
    } as unknown as ProjectAnalysis;
    expect(computeImpactDiff(dangerousSummary, ["srv/service.ts"]).risk.level).toBe("high");
  });

  it("is low-risk and empty for changed files with no blast presence", () => {
    const r = computeImpactDiff(summary, ["srv/service.test.ts"]);
    expect(r.risk.level).toBe("low");
    expect(r.screenCount).toBe(0);
    expect(r.tests).toEqual(["srv/service.test.ts"]); // the changed test itself
  });

  it("flags truncation when a contributing capped list overflowed", () => {
    const truncSummary = {
      ...(summary as object),
      blastRadius: [
        blast("srv/service.ts", {
          traceImpact: impact({ screens: [ordersScreen], screenCount: 20 }), // capped upstream
        }),
      ],
    } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(truncSummary, ["srv/service.ts"]);
    expect(r.truncated).toBe(true);
  });

  it("carries removed files and the base label through", () => {
    const r = computeImpactDiff(summary, [], { removedFiles: ["old\\gone.ts"], baseLabel: "HEAD~3" });
    expect(r.removedFiles).toEqual(["old/gone.ts"]);
    expect(r.baseLabel).toBe("HEAD~3");
  });
});

// ─── renderers ──────────────────────────────────────────────────────────────

describe("impact renderers", () => {
  const r = computeImpactDiff(summary, ["srv/service.ts"], { baseLabel: "HEAD" });

  it("text output leads with risk and lists each tier", () => {
    const text = renderImpactText(r);
    expect(text).toContain("Risk: MODERATE");
    expect(text).toContain("Screens reached (1):");
    expect(text).toContain("Orders  /orders  (web/Orders.vue)");
    expect(text).toContain("POST /api/orders  (srv/routes.ts:6)");
    expect(text).toContain("Tests to run (1):");
    expect(text).toContain("srv/routes.ts → srv/service.ts  [route]");
  });

  it("markdown output is a valid table with backticked values", () => {
    const md = renderImpactMarkdown(r);
    expect(md).toContain("### ClarifyDoc impact — **MODERATE** risk");
    expect(md).toContain("|---|---|");
    expect(md).toContain("`srv/service.ts`");
    expect(md).toContain("`POST /api/orders`");
  });
});

describe("computeImpactDiff — usually changed with", () => {
  it("lists the co-change partners a diff leaves out, strongest first", () => {
    const withHistory = {
      ...summary,
      coChange: [
        { a: "srv/service.ts", b: "web/api.ts", count: 6, score: 0.8, hidden: true },
        { a: "srv/routes.ts", b: "srv/service.ts", count: 3, score: 0.4 },
        { a: "srv/util.ts", b: "web/Orders.vue", count: 3, score: 0.5 },
      ],
    } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(withHistory, ["srv/service.ts"]);
    expect(r.missingCoChanges).toEqual([
      { file: "web/api.ts", with: "srv/service.ts", count: 6, score: 0.8, hidden: true },
      { file: "srv/routes.ts", with: "srv/service.ts", count: 3, score: 0.4 },
    ]);
    expect(r.risk.reasons.some((x) => x.includes("usually changed with it (web/api.ts)"))).toBe(true);
    expect(renderImpactMarkdown(r)).toContain("Usually changed with");
  });
});

describe("computeImpactDiff — owners and reviewers", () => {
  it("names CODEOWNERS owners and the changed files' authors, the author left out", () => {
    const s = {
      ...summary,
      codeOwners: { file: "CODEOWNERS", rules: [{ pattern: "/srv/", owners: ["@backend"] }] },
      fileChurn: [
        { file: "srv/service.ts", commits: 9, additions: 0, deletions: 0, lastTouched: "", authors: [], authorCount: 3, authorShares: [{ name: "Me", commits: 5 }, { name: "Ana", commits: 3 }, { name: "Bo", commits: 1 }] },
        { file: "srv/util.ts", commits: 2, additions: 0, deletions: 0, lastTouched: "", authors: [], authorCount: 1, authorShares: [{ name: "Bo", commits: 2 }] },
      ],
    } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(s, ["srv/service.ts", "srv/util.ts"], { author: "me" });
    expect(r.owners).toEqual([{ owner: "@backend", files: 2 }]);
    // Equal commits: the one who knows more of the changed files first.
    expect(r.reviewers).toEqual([{ name: "Bo", files: 2, commits: 3 }, { name: "Ana", files: 1, commits: 3 }]);
  });
});

describe("consumer standing", () => {
  const link = (sf: string, ss: string, tf: string, ts: string, line = 1) =>
    ({ sourceFile: sf, sourceSymbol: ss, sourceLine: line, callName: ts, targetFile: tf, targetSymbol: ts, targetLine: 1, confidence: "EXTRACTED" });
  const withLinks = {
    ...summary,
    files: [...(summary as { files: string[] }).files, "srv/jobs.ts", "srv/report.ts"],
    symbolLinks: [
      link("srv/routes.ts", "createOrder", "srv/service.ts", "place", 7),
      link("srv/jobs.ts", "nightly", "srv/service.ts", "place", 3),
      link("srv/report.ts", "monthly", "srv/service.ts", "place", 12),
      link("srv/service.ts", "retry", "srv/service.ts", "place", 40),
      link("srv/service.test.ts", "test_place", "srv/service.ts", "place", 5),
      link("srv/service.test.ts", "test_create", "srv/routes.ts", "createOrder", 9),
    ],
    testCoverage: {
      files: [{ file: "srv/report.ts", total: 10, covered: 4, functions: [{ name: "monthly", line: 10, endLine: 20, total: 10, covered: 4 }] }],
    },
  } as unknown as ProjectAnalysis;

  it("says, for each caller of a changed function, whether it was updated, is covered, is a test, or is unverified", () => {
    const r = computeImpactDiff(withLinks, ["srv/service.ts"], {
      symbols: {
        changed: [
          { file: "srv/service.ts", symbol: "place", line: 1, endLine: 30 },
          { file: "srv/service.ts", symbol: "retry", line: 35, endLine: 50 },
        ],
        moduleLevel: [],
      },
    });
    const standing = Object.fromEntries(r.symbolImpact!.direct.map((c) => [c.symbol, [c.standing, c.coveredBy?.symbol]]));
    expect(standing).toEqual({
      createOrder: ["covered", "test_create"],
      nightly: ["unverified", undefined],
      monthly: ["covered", undefined],
      retry: ["updated", undefined],
      test_place: ["test", undefined],
    });
    const text = renderImpactText(r);
    expect(text).toContain("1 updated, 2 covered, 1 tests, 1 unverified");
    // The ones to read come first.
    expect(text.indexOf("nightly")).toBeLessThan(text.indexOf("createOrder"));
    expect(renderImpactMarkdown(r)).toContain("check: `nightly`");
  });
});

describe("patch coverage", () => {
  it("lists the changed lines the coverage report says no test ran", () => {
    const withCoverage = {
      ...summary,
      testCoverage: { sources: [], total: 20, covered: 12, unmatched: [], files: [{ file: "srv/service.ts", total: 20, covered: 12, uncovered: "4-6,15-18" }] },
    } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(withCoverage, ["srv/service.ts"], {
      symbols: { changed: [], moduleLevel: ["srv/service.ts"], hunks: new Map([["srv/service.ts", [[3, 5], [16, 16], [30, 31]] as const]]) },
    });
    expect(r.patchCoverage).toEqual({ uncoveredLines: 3, files: [{ file: "srv/service.ts", changedLines: 6, uncovered: "4-5,16" }] });
    expect(renderImpactText(r)).toContain("Changed lines no test runs: 3");
    expect(renderImpactMarkdown(r)).toContain("`srv/service.ts:4-5,16`");
  });
});

