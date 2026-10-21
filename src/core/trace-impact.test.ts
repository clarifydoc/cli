import { describe, it, expect } from "vitest";
import { attachTraceImpact, computeTraceImpact, escalateForTraceImpact } from "./trace-impact.js";
import type {
  BlastRadiusInfo,
  FileAnalysis,
  RouteInfo,
  ScreenInfo,
  SymbolDataAccess,
  SymbolLink,
  TraceImpactInfo,
} from "../types/analysis.js";

// ─── fixture helpers ────────────────────────────────────────────────────────

const link = (sf: string, ss: string, tf: string, ts: string, callName = ss): SymbolLink => ({
  sourceFile: sf,
  sourceSymbol: ss,
  sourceLine: 1,
  callName,
  targetFile: tf,
  targetSymbol: ts,
  targetLine: 1,
});

const screen = (filePath: string, name: string, routePath: string | null = null): ScreenInfo =>
  ({ name, formType: "page", caption: null, dimensions: null, components: [], filePath, routePath, navigatesTo: [] });

const route = (
  filePath: string,
  path: string,
  httpMethod: string | null,
  handler: string | null,
  line: number,
  kind: RouteInfo["kind"] = "api",
): RouteInfo & { filePath: string } =>
  ({ path, httpMethod, kind, handler, calls: [], middleware: [], line, filePath });

const dbRow = (file: string, symbol: string, entity: string): SymbolDataAccess =>
  ({ file, symbol, symbolLine: 1, entity, entityMatched: true, datastore: "db", sites: [] });

const queueRow = (
  file: string,
  symbol: string,
  dest: string,
  access: "queue-publish" | "queue-consume",
): SymbolDataAccess =>
  ({ file, symbol, symbolLine: 1, entity: "event", entityMatched: false, datastore: dest, access, sites: [] });

const fns = (filePath: string, ...defs: Array<[string, number, number]>): FileAnalysis =>
  ({
    filePath,
    functions: defs.map(([name, line, endLine]) => ({ name, line, endLine })),
    classes: [],
  } as unknown as FileAnalysis);

const blastEntry = (filePath: string, over: Partial<BlastRadiusInfo> = {}): BlastRadiusInfo => ({
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

// The miniature cross-tier chain used by most tests:
//   Cars.vue (screen "/cars") ── onSave → api.ts::postCar
//   postCar ──"POST /api/cars"→ routes.ts::createCar         (synthetic HTTP edge)
//   createCar → service.ts::save                              (regular call)
//   service.ts::save touches entity "cars"
const chain = {
  symbolLinks: [
    link("web/Cars.vue", "onSave", "web/api.ts", "postCar"),
    link("web/api.ts", "postCar", "srv/routes.ts", "createCar", "POST /api/cars"),
    link("srv/routes.ts", "createCar", "srv/service.ts", "save"),
  ],
  screens: [screen("web/Cars.vue", "Cars", "/cars")],
  routes: [route("srv/routes.ts", "/api/cars", "POST", "createCar", 6)],
  symbolDataAccess: [dbRow("srv/service.ts", "save", "cars")],
  analyses: [fns("srv/routes.ts", ["createCar", 5, 15])],
};

// ─── computeTraceImpact ─────────────────────────────────────────────────────

describe("computeTraceImpact — cross-tier chain", () => {
  const impacts = computeTraceImpact(chain);

  it("labels the deepest file with the screen and route that reach it", () => {
    const svc = impacts.get("srv/service.ts")!;
    expect(svc).toBeDefined();
    expect(svc.screens.map((s) => s.name)).toEqual(["Cars"]);
    expect(svc.screens[0]).toEqual({ name: "Cars", file: "web/Cars.vue", route: "/cars" });
    expect(svc.routes).toEqual([{ method: "POST", path: "/api/cars", file: "srv/routes.ts", line: 6 }]);
    expect(svc.entities).toEqual(["cars"]);
  });

  it("propagates entities upstream to the screen through the HTTP edge", () => {
    const vue = impacts.get("web/Cars.vue")!;
    expect(vue.entities).toEqual(["cars"]);
    // A screen trivially reaches its own file.
    expect(vue.screens.map((s) => s.name)).toEqual(["Cars"]);
  });

  it("gives the route file both directions", () => {
    const rt = impacts.get("srv/routes.ts")!;
    expect(rt.screens.map((s) => s.name)).toEqual(["Cars"]);
    expect(rt.entities).toEqual(["cars"]);
    expect(rt.routeCount).toBe(1); // its own route
  });

  it("does not mark the frontend service as impacting the backend route", () => {
    // Changing web/api.ts cannot change what POST /api/cars does — the route
    // BFS runs forward from the handler, never sideways to callers.
    const api = impacts.get("web/api.ts")!;
    expect(api.routeCount).toBe(0);
    expect(api.screens.map((s) => s.name)).toEqual(["Cars"]);
    expect(api.entities).toEqual(["cars"]);
  });
});

describe("computeTraceImpact — routes", () => {
  it("resolves a handler defined in another file via the unique-name lookup", () => {
    const impacts = computeTraceImpact({
      symbolLinks: [link("srv/controllers.ts", "savePlayer", "srv/repo.ts", "insert")],
      screens: [],
      routes: [route("srv/routes.ts", "/players", "POST", "savePlayer", 3)],
      symbolDataAccess: [],
      analyses: [fns("srv/routes.ts"), fns("srv/controllers.ts", ["savePlayer", 10, 20])],
    });
    expect(impacts.get("srv/controllers.ts")!.routes.map((r) => r.path)).toEqual(["/players"]);
    expect(impacts.get("srv/repo.ts")!.routes.map((r) => r.path)).toEqual(["/players"]);
  });

  it("never guesses: an unresolvable handler only labels the declaring file", () => {
    const impacts = computeTraceImpact({
      symbolLinks: [link("srv/routes.ts", "unrelated", "srv/service.ts", "save")],
      screens: [],
      routes: [route("srv/routes.ts", "/mystery", "GET", "nope", 100)],
      symbolDataAccess: [],
      analyses: [fns("srv/routes.ts", ["unrelated", 1, 3])],
    });
    expect(impacts.get("srv/routes.ts")!.routes.map((r) => r.path)).toEqual(["/mystery"]);
    expect(impacts.get("srv/service.ts")?.routeCount ?? 0).toBe(0);
  });

  it("ignores frontend routes (screens cover that side)", () => {
    const impacts = computeTraceImpact({
      symbolLinks: [],
      screens: [],
      routes: [route("web/router.ts", "/cars", null, "Cars", 1, "frontend")],
      symbolDataAccess: [],
      analyses: [],
    });
    expect(impacts.size).toBe(0);
  });
});

describe("computeTraceImpact — queues", () => {
  it("follows the MQ edge so a publisher inherits the consumer's entities", () => {
    const impacts = computeTraceImpact({
      symbolLinks: [
        link("pub.ts", "send", "con.ts", "handle", "MQ cars-x"), // synthetic MQ edge
        link("con.ts", "handle", "db.ts", "persist"),
      ],
      screens: [],
      routes: [],
      symbolDataAccess: [
        queueRow("pub.ts", "send", "cars-x", "queue-publish"),
        queueRow("con.ts", "handle", "cars-x", "queue-consume"),
        dbRow("db.ts", "persist", "cars"),
      ],
      analyses: [],
    });
    const pub = impacts.get("pub.ts")!;
    expect(pub.queues).toEqual(["cars-x"]);
    expect(pub.entities).toEqual(["cars"]);
    const con = impacts.get("con.ts")!;
    expect(con.queues).toEqual(["cars-x"]);
    expect(con.entities).toEqual(["cars"]);
  });
});

describe("computeTraceImpact — robustness", () => {
  it("terminates on cycles and labels every member", () => {
    const impacts = computeTraceImpact({
      symbolLinks: [
        link("a.ts", "f", "b.ts", "g"),
        link("b.ts", "g", "a.ts", "f"),
      ],
      screens: [screen("a.ts", "A")],
      routes: [],
      symbolDataAccess: [],
      analyses: [],
    });
    expect(impacts.get("a.ts")!.screens.map((s) => s.name)).toEqual(["A"]);
    expect(impacts.get("b.ts")!.screens.map((s) => s.name)).toEqual(["A"]);
  });

  it("caps lists at 12 but reports true totals", () => {
    const screens: ScreenInfo[] = [];
    const links: SymbolLink[] = [];
    for (let i = 0; i < 15; i++) {
      screens.push(screen(`web/S${i}.vue`, `S${i}`, `/s${i}`));
      links.push(link(`web/S${i}.vue`, "onClick", "shared/util.ts", "run"));
    }
    const impacts = computeTraceImpact({
      symbolLinks: links,
      screens,
      routes: [],
      symbolDataAccess: [],
      analyses: [],
    });
    const util = impacts.get("shared/util.ts")!;
    expect(util.screens).toHaveLength(12);
    expect(util.screenCount).toBe(15);
  });

  it("dedupes several screen entries for the same file, preferring the routed one", () => {
    const impacts = computeTraceImpact({
      symbolLinks: [],
      screens: [screen("web/P.vue", "P-unrouted", null), screen("web/P.vue", "P", "/p")],
      routes: [],
      symbolDataAccess: [],
      analyses: [],
    });
    const p = impacts.get("web/P.vue")!;
    expect(p.screens).toEqual([{ name: "P", file: "web/P.vue", route: "/p" }]);
    expect(p.screenCount).toBe(1);
  });

  it("returns an empty map when there is nothing cross-tier", () => {
    const impacts = computeTraceImpact({
      symbolLinks: [link("a.ts", "f", "b.ts", "g")],
      screens: [],
      routes: [],
      symbolDataAccess: [],
      analyses: [],
    });
    expect(impacts.size).toBe(0);
  });
});

// ─── escalation ─────────────────────────────────────────────────────────────

const impactOf = (over: Partial<TraceImpactInfo>): TraceImpactInfo => ({
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

describe("escalateForTraceImpact", () => {
  it("leaves entries without traceImpact untouched", () => {
    const info = blastEntry("a.ts");
    escalateForTraceImpact(info);
    expect(info.changeRisk).toBe("safe");
    expect(info.level).toBe("low");
  });

  it("a file on a UI→data path cannot be safe/low", () => {
    const info = blastEntry("a.ts", { traceImpact: impactOf({ screenCount: 1, entityCount: 1 }) });
    escalateForTraceImpact(info);
    expect(info.changeRisk).toBe("moderate");
    expect(info.level).toBe("medium");
  });

  it("wide upstream + real downstream escalates to dangerous/high", () => {
    const info = blastEntry("a.ts", { traceImpact: impactOf({ screenCount: 8, entityCount: 3 }) });
    escalateForTraceImpact(info);
    expect(info.changeRisk).toBe("dangerous");
    expect(info.level).toBe("high");
  });

  it("never downgrades an already-critical entry", () => {
    const info = blastEntry("a.ts", {
      level: "critical",
      changeRisk: "dangerous",
      traceImpact: impactOf({ screenCount: 1, entityCount: 1 }),
    });
    escalateForTraceImpact(info);
    expect(info.level).toBe("critical");
    expect(info.changeRisk).toBe("dangerous");
  });
});

// ─── attachTraceImpact ──────────────────────────────────────────────────────

describe("attachTraceImpact", () => {
  it("annotates existing entries and appends zero-scored ones for graph-absent files", () => {
    const blast = [blastEntry("srv/service.ts", { impactScore: 3.5, changeRisk: "safe" })];
    const count = attachTraceImpact(blast, chain);

    expect(count).toBeGreaterThan(0);
    const svc = blast.find((b) => b.filePath === "srv/service.ts")!;
    expect(svc.traceImpact!.screens.map((s) => s.name)).toEqual(["Cars"]);
    expect(svc.changeRisk).toBe("moderate"); // escalated: screen + entity reach

    // Cars.vue had no import-graph entry → synthetic zero-scored entry appended.
    const vue = blast.find((b) => b.filePath === "web/Cars.vue")!;
    expect(vue).toBeDefined();
    expect(vue.impactScore).toBe(0);
    expect(vue.traceImpact!.entities).toEqual(["cars"]);
  });
});
