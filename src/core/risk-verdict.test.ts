import { describe, it, expect } from "vitest";
import { attachRiskVerdicts, classifyRiskVerdict, describeReasons, type FileRiskInput } from "./risk-verdict.js";
import { escalateForTraceImpact } from "./trace-impact.js";
import {
  createEmptyAnalysis,
  type BlastRadiusInfo,
  type ResponsibilityProfile,
  type TraceImpactInfo,
  type TypeUsageSummary,
} from "../types/analysis.js";

/**
 * The verdict is a JUDGEMENT, not an extracted fact, so what these tests pin
 * is the decision table: which arm of the cascade fires on which evidence,
 * that the level ladder differs per category (the whole point — five
 * importers of an interface is not five importers of a util), and that no
 * verdict is ever unexplained.
 */

const blast = (over: Partial<BlastRadiusInfo> = {}): BlastRadiusInfo => ({
  filePath: "src/m.ts",
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

const reach = (over: Partial<TraceImpactInfo> = {}): TraceImpactInfo => ({
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

const profile = (over: Partial<ResponsibilityProfile> = {}): ResponsibilityProfile => ({
  filePath: "src/m.ts",
  boundaries: [],
  roles: [],
  concernCount: 0,
  externalPackageCount: 0,
  readsState: false,
  writesState: false,
  emitsEvents: false,
  consumesEvents: false,
  servesRequests: false,
  callsExternal: false,
  evidenceCount: 0,
  evidence: [],
  ...over,
});

const typeUsage = (over: Partial<TypeUsageSummary> = {}): TypeUsageSummary => ({
  typeName: "T",
  definedAt: { line: 1, isInterface: true },
  usageByKind: {},
  totalUsages: 1,
  usedByFiles: [],
  usagesByFile: [],
  impactScore: 0,
  level: "low",
  changeRisk: "safe",
  ...over,
});

const input = (over: Partial<FileRiskInput> = {}): FileRiskInput => ({
  blast: blast(),
  declaresEntity: false,
  abstractPattern: false,
  ...over,
});

describe("classifyRiskVerdict — the cascade", () => {
  it("classifies a used exported interface as foundation", () => {
    const v = classifyRiskVerdict(
      input({ blast: blast({ directDependents: 3, typeUsages: [typeUsage({ totalUsages: 12 })] }) }),
    );
    expect(v.category).toBe("foundation");
    expect(v.reasons).toContain("exported_interface_in_use");
  });

  it("does not call a mixed-concern module a foundation just because it exports a type", () => {
    // sample-pressure's orders.ts: declares `Order` at the top, then does
    // persistence, transport, messaging and auth. The interface is incidental.
    const v = classifyRiskVerdict(
      input({
        blast: blast({ directDependents: 3, typeUsages: [typeUsage({ totalUsages: 12 })] }),
        profile: profile({ concernCount: 4, callsExternal: true, boundaries: ["database", "queue", "http"] }),
      }),
    );
    expect(v.category).toBe("boundary");
    expect(v.reasons).not.toContain("exported_interface_in_use");
  });

  it("still calls a model file a foundation, ORM import and all", () => {
    // One concern (persistence) is what a model file legitimately carries, so
    // the gate above must not disqualify it.
    const v = classifyRiskVerdict(
      input({
        declaresEntity: true,
        blast: blast({ directDependents: 4, typeUsages: [typeUsage({ totalUsages: 9 })] }),
        profile: profile({ concernCount: 1, boundaries: ["database"] }),
      }),
    );
    expect(v.category).toBe("foundation");
  });

  it("classifies an ER entity declaration as foundation even with no importers", () => {
    const v = classifyRiskVerdict(input({ declaresEntity: true }));
    expect(v.category).toBe("foundation");
    expect(v.reasons).toContain("declares_data_entity");
  });

  it("classifies a route-serving file as boundary, with no fan-in required", () => {
    const v = classifyRiskVerdict(input({ profile: profile({ servesRequests: true }) }));
    expect(v.category).toBe("boundary");
    expect(v.reasons).toContain("serves_api_routes");
  });

  it("classifies a file between a screen and an entity as flow", () => {
    const v = classifyRiskVerdict(
      input({ blast: blast({ traceImpact: reach({ screenCount: 2, entityCount: 1 }) }) }),
    );
    expect(v.category).toBe("flow");
    expect(v.reasons).toContain("on_ui_to_data_path");
  });

  it("classifies a widely-imported file with no other evidence as shared", () => {
    const v = classifyRiskVerdict(input({ blast: blast({ directDependents: 9 }) }));
    expect(v.category).toBe("shared");
    expect(v.reasons).toContain("many_dependents");
  });

  it("classifies a leaf as localized", () => {
    const v = classifyRiskVerdict(input({ blast: blast({ directDependents: 1 }) }));
    expect(v.category).toBe("localized");
    expect(v.reasons).toEqual(["low_fan_in"]);
  });

  it("falls back to unknown, and still says why", () => {
    const v = classifyRiskVerdict(input({ blast: blast({ directDependents: 3, level: "medium" }) }));
    expect(v.category).toBe("unknown");
    expect(v.level).toBe("medium"); // deferred to the import graph
    expect(v.reasons).toEqual(["no_classifying_evidence", "fallback_to_import_graph_level"]);
  });

  it("is first-match-wins for the category but keeps evidence from lower arms", () => {
    // Both a foundation type AND heavily imported: foundation wins, but the
    // fan-in is still recorded rather than thrown away.
    const v = classifyRiskVerdict(
      input({ declaresEntity: true, blast: blast({ directDependents: 20, transitiveDependents: 30 }) }),
    );
    expect(v.category).toBe("foundation");
    expect(v.reasons).toEqual(
      expect.arrayContaining(["declares_data_entity", "many_dependents", "many_transitive_dependents"]),
    );
  });

  it("never returns an empty reasons list", () => {
    const cases: FileRiskInput[] = [
      input(),
      input({ blast: blast({ directDependents: 50 }) }),
      input({ declaresEntity: true }),
      input({ profile: profile({ callsExternal: true }) }),
      input({ blast: blast({ traceImpact: reach({ screenCount: 1, entityCount: 1 }) }) }),
    ];
    for (const c of cases) expect(classifyRiskVerdict(c).reasons.length).toBeGreaterThan(0);
  });
});

describe("classifyRiskVerdict — the level ladder is per category", () => {
  it("makes a foundation type critical at 5 importers", () => {
    const at = (n: number) =>
      classifyRiskVerdict(input({ declaresEntity: true, blast: blast({ directDependents: n }) })).level;
    expect(at(0)).toBe("low");
    expect(at(1)).toBe("medium");
    expect(at(2)).toBe("high");
    expect(at(5)).toBe("critical");
  });

  it("needs 15 importers for the same verdict on shared internals", () => {
    const at = (n: number) => classifyRiskVerdict(input({ blast: blast({ directDependents: n }) })).level;
    // 5 is where `shared` starts firing at all; it is only "medium" there.
    expect(at(5)).toBe("medium");
    expect(at(8)).toBe("high");
    expect(at(15)).toBe("critical");
  });

  it("grades shared internals on transitive reach when that is what fired it", () => {
    // extractors/shared/call-patterns.ts in this repo: 2 direct importers,
    // 254 transitive of 469 files. Grading on direct importers alone called
    // that "low".
    const at = (transitive: number) =>
      classifyRiskVerdict(
        input({ totalFiles: 469, blast: blast({ directDependents: 2, transitiveDependents: transitive }) }),
      );
    expect(at(8).category).toBe("shared");
    expect(at(8).level).toBe("medium"); // never "low" once the category fired
    expect(at(120).level).toBe("high"); // a quarter of the codebase
    expect(at(254).level).toBe("critical"); // over half
  });

  it("uses a share, so the same counts mean different things in different repos", () => {
    const at = (totalFiles: number) =>
      classifyRiskVerdict(
        input({ totalFiles, blast: blast({ directDependents: 2, transitiveDependents: 120 }) }),
      ).level;
    expect(at(200)).toBe("critical"); // 120 of 200 files is most of the repo
    expect(at(5000)).toBe("medium"); // 120 of 5000 is a corner of it
  });

  it("falls back to direct importers when no project size is known", () => {
    const v = classifyRiskVerdict(input({ blast: blast({ directDependents: 2, transitiveDependents: 400 }) }));
    expect(v.category).toBe("shared");
    expect(v.level).toBe("medium");
  });

  it("grades a boundary by the traffic crossing it, not by importers", () => {
    const at = (screens: number) =>
      classifyRiskVerdict(
        input({
          profile: profile({ servesRequests: true }),
          blast: blast({ directDependents: 40, traceImpact: reach({ screenCount: screens }) }),
        }),
      ).level;
    // 40 importers would be `critical` for shared internals; for a boundary
    // what matters is reach.
    expect(at(0)).toBe("medium");
    expect(at(3)).toBe("high");
    expect(at(8)).toBe("critical");
  });

  it("grades flow on both ends at once", () => {
    const at = (up: number, down: number) =>
      classifyRiskVerdict(
        input({ blast: blast({ traceImpact: reach({ screenCount: up, entityCount: down }) }) }),
      ).level;
    expect(at(1, 1)).toBe("medium");
    expect(at(3, 1)).toBe("high");
    expect(at(5, 3)).toBe("critical");
  });

  it("keeps localized low however the import graph scored it", () => {
    const v = classifyRiskVerdict(input({ blast: blast({ directDependents: 1, level: "critical" }) }));
    expect(v.category).toBe("localized");
    expect(v.level).toBe("low");
  });
});

describe("classifyRiskVerdict — the cross-tier escalation is named", () => {
  it("records cross_tier_escalation exactly when the escalation fires", () => {
    // Reach that escalates (1 screen + 1 entity raises a safe/low entry).
    const escalating = blast({ traceImpact: reach({ screenCount: 1, entityCount: 1 }) });
    const before = { risk: escalating.changeRisk, level: escalating.level };
    escalateForTraceImpact(escalating);
    expect(escalating.changeRisk).not.toBe(before.risk); // it really did mutate
    expect(classifyRiskVerdict(input({ blast: escalating })).reasons).toContain("cross_tier_escalation");

    // Reach that does not: downstream only.
    const inert = blast({ traceImpact: reach({ entityCount: 2 }) });
    escalateForTraceImpact(inert);
    expect(inert.changeRisk).toBe("safe");
    expect(classifyRiskVerdict(input({ blast: inert })).reasons).not.toContain("cross_tier_escalation");
  });
});

describe("classifyRiskVerdict — behaviour at risk and confidence", () => {
  it("names screens, routes and data without emitting a path", () => {
    const v = classifyRiskVerdict(
      input({
        blast: blast({
          traceImpact: reach({
            screens: [{ name: "Orders", file: "src/pages/Orders.tsx", route: "/orders" }],
            screenCount: 1,
            routes: [{ method: "GET", path: "/api/orders", file: "src/api/orders.ts", line: 3 }],
            routeCount: 1,
            entities: ["Order", "OrderLine"],
            entityCount: 2,
          }),
        }),
      }),
    );
    expect(v.behaviourAtRisk).toEqual(["Orders screen (/orders)", "GET /api/orders", "data: Order, OrderLine"]);
    // Free text cannot be page-encoded, so it must never carry a path.
    for (const b of v.behaviourAtRisk) expect(b).not.toContain("src/");
  });

  it("falls back to the responsibility profile when there is no cross-tier reach", () => {
    const v = classifyRiskVerdict(input({ profile: profile({ servesRequests: true, writesState: true }) }));
    expect(v.behaviourAtRisk).toEqual(["serves API requests", "writes persistent state"]);
  });

  it("caps behaviourAtRisk", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `S${i}`, file: `s${i}.tsx`, route: null }));
    const v = classifyRiskVerdict(
      input({ blast: blast({ traceImpact: reach({ screens: many, screenCount: 12 }) }) }),
    );
    expect(v.behaviourAtRisk.length).toBeLessThanOrEqual(8);
  });

  it("drops confidence when evidence sources are missing", () => {
    const thin = classifyRiskVerdict(input({ blast: blast({ directDependents: 9 }) }));
    const full = classifyRiskVerdict(
      input({
        blast: blast({ directDependents: 9, traceImpact: reach({ screenCount: 1 }) }),
        profile: profile(),
        analysis: createEmptyAnalysis("src/m.ts", "typescript"),
        layer: "services",
      }),
    );
    expect(thin.confidence).toBe(0);
    expect(full.confidence).toBe(1);
  });
});

describe("attachRiskVerdicts", () => {
  it("classifies every row and counts only the ones it could name", () => {
    const rows = [
      blast({ filePath: "src/entity.ts" }),
      blast({ filePath: "src/hub.ts", directDependents: 9 }),
      blast({ filePath: "src/odd.ts", directDependents: 3 }), // no evidence → unknown
    ];
    const named = attachRiskVerdicts(rows, {
      analyses: [],
      entityGraph: {
        nodes: [
          { id: "src/entity.ts::Order", name: "Order", orm: "prisma", kind: "entity", filePath: "src/entity.ts", columns: [], line: 1 },
        ],
        edges: [],
      },
    });
    expect(rows.map((r) => r.verdict?.category)).toEqual(["foundation", "shared", "unknown"]);
    expect(named).toBe(2);
  });

  it("picks up dataclass/abc patterns as foundation evidence", () => {
    const rows = [blast({ filePath: "src/dto.py" })];
    attachRiskVerdicts(rows, {
      analyses: [],
      patterns: [
        { kind: "dataclass", name: "Order", filePath: "src/dto.py", line: 2, confidence: "high", detail: "" },
      ],
    });
    expect(rows[0]!.verdict!.category).toBe("foundation");
    expect(rows[0]!.verdict!.reasons).toContain("abstract_or_dataclass");
  });
});

describe("classifyRiskVerdict — the summary sentence", () => {
    it("pluralises the reach clause", () => {
      const at = (screens: number) =>
        classifyRiskVerdict(
          input({
            profile: profile({ servesRequests: true }),
            blast: blast({ traceImpact: reach({ screenCount: screens, entityCount: 1 }) }),
          }),
        ).summary;
      expect(at(1)).toContain("reached by 1 screen or route.");
      expect(at(4)).toContain("reached by 4 screens or routes.");
    });
});

describe("describeReasons", () => {
  it("labels known ids and passes unknown ones through", () => {
    expect(describeReasons(["many_dependents", "a_rule_from_the_future"])).toBe(
      "many direct dependents, a_rule_from_the_future",
    );
  });
});

describe("classifyRiskVerdict — defect history", () => {
  it("names a file fixed again and again, not one fixed once", () => {
    expect(classifyRiskVerdict(input({ history: { commits: 8, fixes: 4 } })).reasons).toContain("fix_prone");
    expect(classifyRiskVerdict(input({ history: { commits: 8, fixes: 1 } })).reasons).not.toContain("fix_prone");
    // Three fixes in a hundred commits is a busy file, not a fragile one.
    expect(classifyRiskVerdict(input({ history: { commits: 100, fixes: 3 } })).reasons).not.toContain("fix_prone");
  });
});
