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
