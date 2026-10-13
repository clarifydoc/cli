import { describe, it, expect } from "vitest";
import {
  attributeApiCallsToSymbols,
  computeDataFlows,
  computeSymbolReach,
  type SymbolReachInput,
} from "./data-flow-reach.js";
import type {
  FileAnalysis,
  RouteInfo,
  SymbolDataAccess,
  SymbolLink,
  SymbolReachSummary,
} from "../types/analysis.js";

// ─── fixture helpers (mirroring trace-impact.test.ts) ────────────────────────

const link = (sf: string, ss: string, tf: string, ts: string, callName = ss): SymbolLink => ({
  sourceFile: sf,
  sourceSymbol: ss,
  sourceLine: 1,
  callName,
  targetFile: tf,
  targetSymbol: ts,
  targetLine: 1,
});

const dbRow = (file: string, symbol: string, entity: string): SymbolDataAccess => ({
  file,
  symbol,
  symbolLine: 1,
  entity,
  entityMatched: true,
  datastore: "db",
  sites: [],
});

const route = (
  filePath: string,
  path: string,
  httpMethod: string | null,
  handler: string | null,
  line: number,
): RouteInfo & { filePath: string } => ({
  path,
  httpMethod,
  kind: "api",
  handler,
  calls: [],
  middleware: [],
  line,
  filePath,
});

const fns = (filePath: string, ...defs: Array<[string, number, number]>): FileAnalysis =>
  ({
    filePath,
    functions: defs.map(([name, line, endLine]) => ({ name, line, endLine })),
    classes: [],
  }) as unknown as FileAnalysis;

const reachOf = (
  summaries: SymbolReachSummary[],
  file: string,
  symbol: string,
): SymbolReachSummary | undefined => summaries.find((s) => s.file === file && s.symbol === symbol);

// Orders.vue::onSave → api.ts::postOrder → routes.ts::createOrder → service.ts::save,
// where save touches entity "orders".
const chain: SymbolReachInput = {
  symbolLinks: [
    link("web/Orders.vue", "onSave", "web/api.ts", "postOrder"),
    link("web/api.ts", "postOrder", "srv/routes.ts", "createOrder", "POST /api/orders"),
    link("srv/routes.ts", "createOrder", "srv/service.ts", "save"),
  ],
  symbolDataAccess: [dbRow("srv/service.ts", "save", "orders")],
};

describe("computeSymbolReach", () => {
  it("records a direct effect at distance 0 / EXTRACTED", () => {
    const reach = computeSymbolReach(chain);
    const save = reachOf(reach, "srv/service.ts", "save");
    expect(save?.effects).toEqual([
      {
        kind: "db",
        resource: "orders",
        originFile: "srv/service.ts",
        originSymbol: "save",
        distance: 0,
        confidence: "EXTRACTED",
      },
    ]);
    expect(save?.hasTransitive).toBe(false);
    expect(save?.effectCounts).toEqual({ db: 1 });
  });

  it("propagates the effect to callers with increasing distance / INFERRED", () => {
    const reach = computeSymbolReach(chain);
    const dist = (file: string, symbol: string): number | undefined =>
      reachOf(reach, file, symbol)?.effects[0]?.distance;
    expect(dist("srv/routes.ts", "createOrder")).toBe(1);
    expect(dist("web/api.ts", "postOrder")).toBe(2);
    expect(dist("web/Orders.vue", "onSave")).toBe(3);

    const caller = reachOf(reach, "srv/routes.ts", "createOrder");
    expect(caller?.effects[0]?.confidence).toBe("INFERRED");
    expect(caller?.effects[0]?.originSymbol).toBe("save"); // attributed to the origin
    expect(caller?.hasTransitive).toBe(true);
  });

  it("terminates on a cycle and shares one reach set", () => {
    const reach = computeSymbolReach({
      symbolLinks: [
        link("f.ts", "a", "f.ts", "b"),
        link("f.ts", "b", "f.ts", "a"), // a↔b cycle
      ],
      symbolDataAccess: [dbRow("f.ts", "b", "widgets")],
    });
    // Both members reach the effect; the BFS just terminates (no hang).
    expect(reachOf(reach, "f.ts", "b")?.effects[0]?.distance).toBe(0);
    expect(reachOf(reach, "f.ts", "a")?.effects[0]?.distance).toBe(1);
  });

  it("splits db into db-read/db-write from the dbAccessByLine classification", () => {
    // save writes (line 1), read via a separate site (line 2); a caller inherits both.
    const reach = computeSymbolReach({
      symbolLinks: [link("ctl.ts", "handle", "svc.ts", "save")],
      symbolDataAccess: [
        {
          file: "svc.ts",
          symbol: "save",
          symbolLine: 1,
          entity: "orders",
          entityMatched: true,
          datastore: "db",
          sites: [
            { name: "Order.create", line: 10 },
            { name: "Order.find", line: 12 },
          ],
        },
      ],
      dbAccessByLine: new Map([
        ["svc.ts::10", "write"],
        ["svc.ts::12", "read"],
      ]),
    });
    const save = reachOf(reach, "svc.ts", "save");
    expect(save?.effectCounts).toEqual({ "db-write": 1, "db-read": 1 });
    const handler = reachOf(reach, "ctl.ts", "handle");
    expect(handler?.effects.map((e) => e.kind).sort()).toEqual(["db-read", "db-write"]);
    expect(handler?.effects.every((e) => e.distance === 1 && e.confidence === "INFERRED")).toBe(true);
  });

  it("keeps the coarse db effect when a site is unclassified", () => {
    const reach = computeSymbolReach(chain); // no dbAccessByLine
    expect(reachOf(reach, "srv/service.ts", "save")?.effects[0]?.kind).toBe("db");
  });

  it("returns nothing when there is no data access", () => {
    expect(
      computeSymbolReach({ symbolLinks: chain.symbolLinks, symbolDataAccess: [] }),
    ).toEqual([]);
  });

  it("propagates queue and api-call effects too", () => {
    const reach = computeSymbolReach({
      symbolLinks: [link("h.ts", "handler", "p.ts", "publish")],
      symbolDataAccess: [
        {
          file: "p.ts",
          symbol: "publish",
          symbolLine: 1,
          entity: "OrderCreated",
          entityMatched: false,
          datastore: "orders.exchange",
          access: "queue-publish",
          sites: [],
        },
      ],
      apiCallAccess: [{ file: "p.ts", symbol: "publish", resource: "/ext/notify" }],
    });
    const publish = reachOf(reach, "p.ts", "publish");
    expect(publish?.effectCounts).toEqual({ "queue-publish": 1, "api-call": 1 });
    const handler = reachOf(reach, "h.ts", "handler");
    expect(handler?.effects.map((e) => e.kind).sort()).toEqual(["api-call", "queue-publish"]);
    expect(handler?.effects.every((e) => e.distance === 1)).toBe(true);
  });
});

describe("computeDataFlows", () => {
  it("emits a route→DB source→sink row for a handler that transitively reaches a DB write", () => {
    const reach = computeSymbolReach(chain);
    const flows = computeDataFlows(
      reach,
      [route("srv/routes.ts", "/api/orders", "POST", "createOrder", 6)],
      [fns("srv/routes.ts", ["createOrder", 5, 15])],
    );
    expect(flows).toEqual([
      {
        entryKind: "route",
        entryLabel: "POST /api/orders",
        entryFile: "srv/routes.ts",
        effect: "db",
        resource: "orders",
        distance: 1,
        confidence: "INFERRED",
      },
    ]);
  });

  it("emits a screen row for whatever any function of the screen's file reaches, at the shortest distance", () => {
    // The mission question as a row: which screen ends up touching which table.
    // `web/Orders.vue` reaches `orders` only through postOrder → POST
    // /api/orders → createOrder → save (3 hops); a second symbol of the same
    // file reaching it in more hops must not lengthen the distance.
    const reach = computeSymbolReach({
      ...chain,
      symbolLinks: [...chain.symbolLinks, link("web/Orders.vue", "render", "web/Orders.vue", "onSave")],
    });
    const flows = computeDataFlows(
      reach,
      [],
      [fns("web/Orders.vue", ["render", 1, 4], ["onSave", 5, 9])],
      [{ name: "Orders", filePath: "web/Orders.vue", routePath: "/orders" }],
    );
    expect(flows).toEqual([
      {
        entryKind: "screen",
        entryLabel: "Orders /orders",
        entryFile: "web/Orders.vue",
        effect: "db",
        resource: "orders",
        distance: 3,
        confidence: "INFERRED",
      },
    ]);
  });

  it("names a routeless screen by name alone, and skips a screen that reaches nothing", () => {
    const reach = computeSymbolReach(chain);
    const flows = computeDataFlows(reach, [], [fns("web/Orders.vue", ["onSave", 5, 9]), fns("web/Empty.vue", ["x", 1, 2])], [
      { name: "OrderForm", filePath: "web/Orders.vue", routePath: null },
      { name: "Empty", filePath: "web/Empty.vue", routePath: "/empty" },
    ]);
    expect(flows.map((f) => `${f.entryKind} ${f.entryLabel}`)).toEqual(["screen OrderForm"]);
  });

  it("is empty when no route handler resolves to a reaching symbol", () => {
    const reach = computeSymbolReach(chain);
    const flows = computeDataFlows(reach, [], []);
    expect(flows).toEqual([]);
  });

  it("resolves a route with an inline handler through its synthetic route symbol", () => {
    // `router.get("/orders", auth, async (req, res) => …)` — plain Express, and
    // the shape every RealWorld controller uses. There is no function span at
    // the route's line and `handler` holds the MIDDLEWARE's name, so both of
    // the name-based fallbacks miss and the route used to resolve to nothing.
    // `symbol-linker` already mints `route:GET /orders` and links it onward, so
    // the effects were sitting in the reach summary one lookup away — which is
    // how the accuracy eval found `clarifydoc_data_flows` reporting "no data
    // flows" on a repo with 19 cross-tier links and 5 file→table edges.
    const reach = computeSymbolReach({
      symbolLinks: [
        link("srv/ctrl.ts", "route:GET /orders", "srv/repo.ts", "listOrders", "listOrders"),
      ],
      symbolDataAccess: [dbRow("srv/repo.ts", "listOrders", "orders")],
      apiCallAccess: [],
      dbAccessByLine: new Map(),
    });

    const flows = computeDataFlows(
      reach,
      [route("srv/ctrl.ts", "/orders", "GET", "auth.optional", 12)],
      [fns("srv/ctrl.ts")], // no named function anywhere near line 12
    );

    expect(flows).toEqual([
      expect.objectContaining({
        entryKind: "route",
        entryLabel: "GET /orders",
        entryFile: "srv/ctrl.ts",
        resource: "orders",
        distance: 1,
      }),
    ]);
  });

  it("prefers the route's own symbol over whatever function encloses its line", () => {
    // A route registered inside `registerRoutes()` must attribute to the route,
    // not to the registrar — otherwise every route in the file collapses onto
    // one entry carrying the union of their effects.
    const reach = computeSymbolReach({
      symbolLinks: [link("srv/ctrl.ts", "route:GET /orders", "srv/repo.ts", "listOrders", "listOrders")],
      symbolDataAccess: [dbRow("srv/repo.ts", "listOrders", "orders")],
      apiCallAccess: [],
      dbAccessByLine: new Map(),
    });

    const flows = computeDataFlows(
      reach,
      [route("srv/ctrl.ts", "/orders", "GET", null, 12)],
      [fns("srv/ctrl.ts", ["registerRoutes", 1, 40])],
    );

    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ entryLabel: "GET /orders", resource: "orders" });
  });
});

describe("attributeApiCallsToSymbols", () => {
  it("attributes an outbound api-call to its enclosing function", () => {
    const analysis = {
      filePath: "svc.ts",
      functions: [{ name: "loadUser", line: 3, endLine: 8 }],
      classes: [],
      dataSources: [{ kind: "api-call", name: "get", target: "/api/users/{}", line: 5, calls: [] }],
    } as unknown as FileAnalysis;
    expect(attributeApiCallsToSymbols([analysis])).toEqual([
      { file: "svc.ts", symbol: "loadUser", resource: "/api/users/{}" },
    ]);
  });

  it("drops a module-level api-call with no enclosing symbol", () => {
    const analysis = {
      filePath: "top.ts",
      functions: [],
      classes: [],
      dataSources: [{ kind: "api-call", name: "get", target: "/ping", line: 1, calls: [] }],
    } as unknown as FileAnalysis;
    expect(attributeApiCallsToSymbols([analysis])).toEqual([]);
  });
});

describe("computeSymbolReach — a path is as sure as its weakest link", () => {
  const guess = (sf: string, ss: string, tf: string, ts: string): SymbolLink => ({
    ...link(sf, ss, tf, ts), confidence: "AMBIGUOUS", strategy: "unique-global-blind",
  });
  const effectOf = (reach: SymbolReachSummary[], file: string, symbol: string) =>
    reach.find((r) => r.file === file && r.symbol === symbol)?.effects[0];

  it("marks a caller that reaches an effect only across a guessed link AMBIGUOUS", () => {
    const reach = computeSymbolReach({
      symbolLinks: [
        guess("a.ts", "report", "repo.ts", "Repo.save"),
        link("b.ts", "handler", "a.ts", "report"),
        link("c.ts", "checkout", "repo.ts", "Repo.save"),
      ],
      symbolDataAccess: [dbRow("repo.ts", "Repo.save", "orders")],
    });
    expect(effectOf(reach, "c.ts", "checkout")).toMatchObject({ distance: 1, confidence: "INFERRED" });
    expect(effectOf(reach, "a.ts", "report")).toMatchObject({ distance: 1, confidence: "AMBIGUOUS" });
    // Everything above a guess inherits it.
    expect(effectOf(reach, "b.ts", "handler")).toMatchObject({ distance: 2, confidence: "AMBIGUOUS" });
  });

  it("prefers a longer resolved path over a shorter guessed one", () => {
    const reach = computeSymbolReach({
      symbolLinks: [
        guess("h.ts", "handler", "repo.ts", "Repo.save"),
        link("h.ts", "handler", "s.ts", "Service.run"),
        link("s.ts", "Service.run", "repo.ts", "Repo.save"),
      ],
      symbolDataAccess: [dbRow("repo.ts", "Repo.save", "orders")],
    });
    expect(effectOf(reach, "h.ts", "handler")).toMatchObject({ distance: 2, confidence: "INFERRED" });
  });
});

describe("computeDataFlows — witness paths", () => {
  it("names every function between the route and the effect, with the call lines", async () => {
    const { computeSymbolReachWithWitness } = await import("./data-flow-reach.js");
    const at = (l: SymbolLink, line: number): SymbolLink => ({ ...l, sourceLine: line });
    const { reach, witness } = computeSymbolReachWithWitness({
      symbolLinks: [
        at(link("routes.ts", "route:POST /orders", "ctl.ts", "OrderController.create"), 3),
        at(link("ctl.ts", "OrderController.create", "svc.ts", "OrderService.place"), 12),
        at(link("svc.ts", "OrderService.place", "repo.ts", "OrderRepo.save"), 40),
      ],
      symbolDataAccess: [dbRow("repo.ts", "OrderRepo.save", "orders")],
    });
    const flows = computeDataFlows(reach, [route("routes.ts", "/orders", "POST", null, 3)], [], [], witness);
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ distance: 3 });
    expect(flows[0]!.via).toEqual([
      { file: "routes.ts", symbol: "route:POST /orders", line: 3 },
      { file: "ctl.ts", symbol: "OrderController.create", line: 12 },
      { file: "svc.ts", symbol: "OrderService.place", line: 40 },
      { file: "repo.ts", symbol: "OrderRepo.save" },
    ]);
  });
});
