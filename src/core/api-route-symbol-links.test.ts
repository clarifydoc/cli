import { describe, it, expect } from "vitest";
import { moveInheritedCallsToSubclasses, synthesizeApiRouteSymbolLinks, synthesizeQueueSymbolLinks } from "./api-route-symbol-links.js";
import type { ApiRouteLink, FileAnalysis, SymbolDataAccess, SymbolLink } from "../types/analysis.js";

/**
 * Cross-tier trace edges. Without these, the Call Traces graph stops at the
 * HTTP boundary: a click handler's trace dead-ends at fetch() and the route
 * handler's trace starts fresh — the two halves never meet.
 */

function fa(filePath: string, over: Partial<FileAnalysis> = {}): FileAnalysis {
  return {
    filePath,
    functions: [],
    classes: [],
    imports: [],
    exports: [],
    dataSources: [],
    ...over,
  } as unknown as FileAnalysis;
}

function fn(name: string, line: number, endLine: number) {
  return { name, params: [], returnType: null, isAsync: false, isExported: false, decorators: [], calls: [], line, endLine };
}

const link = (over: Partial<ApiRouteLink> = {}): ApiRouteLink => ({
  source: "web/src/api.ts",
  sourceLine: 12,
  method: "GET",
  url: "/api/cars",
  target: "server/Controllers/CarsController.cs",
  targetLine: 20,
  handler: "GetAll",
  routePath: "/api/cars",
  confidence: "EXTRACTED",
  ...over,
});

describe("synthesizeApiRouteSymbolLinks", () => {
  const frontend = fa("web/src/api.ts", { functions: [fn("loadCars", 10, 15)] });

  it("links the enclosing frontend function to the enclosing route method (annotation-routed)", () => {
    const backend = fa("server/Controllers/CarsController.cs", {
      classes: [{ name: "CarsController", methods: [fn("GetAll", 18, 25)] }] as any,
    });
    const [l] = synthesizeApiRouteSymbolLinks([link()], [frontend, backend]);
    expect(l).toMatchObject({
      sourceFile: "web/src/api.ts",
      sourceSymbol: "loadCars",
      targetFile: "server/Controllers/CarsController.cs",
      targetSymbol: "CarsController.GetAll",
      callName: "GET /api/cars",
      confidence: "EXTRACTED",
    });
  });

  it("falls back to the handler NAME in the route file when the route line is top-level (Express)", () => {
    const routes = fa("server/routes/cars.js", { functions: [fn("listCars", 30, 40)] });
    const [l] = synthesizeApiRouteSymbolLinks(
      [link({ target: "server/routes/cars.js", targetLine: 5, handler: "listCars" })],
      [frontend, routes],
    );
    expect(l?.targetSymbol).toBe("listCars");
  });

  it("resolves a handler defined in ANOTHER file when the name is globally unique", () => {
    const routes = fa("server/routes/cars.js"); // route def file, no functions
    const controller = fa("server/controllers/carController.js", { functions: [fn("listCars", 8, 20)] });
    const [l] = synthesizeApiRouteSymbolLinks(
      [link({ target: "server/routes/cars.js", targetLine: 5, handler: "listCars" })],
      [frontend, routes, controller],
    );
    expect(l?.targetFile).toBe("server/controllers/carController.js");
    expect(l?.targetSymbol).toBe("listCars");
  });

  it("does NOT guess when the handler name exists in several files", () => {
    const a = fa("server/a.js", { functions: [fn("handler", 1, 5)] });
    const b = fa("server/b.js", { functions: [fn("handler", 1, 5)] });
    const out = synthesizeApiRouteSymbolLinks(
      [link({ target: "server/routes.js", targetLine: 3, handler: "handler" })],
      [frontend, fa("server/routes.js"), a, b],
    );
    expect(out).toHaveLength(0);
  });

  it("targets the route's synthetic symbol when the handler is inline (Express)", () => {
    // `router.get("/profiles/:username", auth.optional, async (req, res) => …)`:
    // no span at the route line, and `handler` is the middleware's name. The
    // symbol linker's `route:GET /profiles/:username` is still there — without
    // it, no frontend call in such a repo crossed into the backend at all.
    const backend = fa("server/profile.controller.ts", {
      routes: [{ path: "/profiles/:username", httpMethod: "GET", kind: "api", handler: "auth.optional", calls: [], middleware: [], line: 14 }],
    } as any);
    const out = synthesizeApiRouteSymbolLinks(
      [link({ target: "server/profile.controller.ts", targetLine: 14, handler: "auth.optional", routePath: "/profiles/:username" })],
      [frontend, backend],
    );
    expect(out.map((l) => `${l.targetFile}::${l.targetSymbol}`)).toEqual(["server/profile.controller.ts::route:GET /profiles/:username"]);
  });

  it("targets the route's symbol, not the function that registers it", () => {
    // `func RegisterTaskRoutes(api huma.API) { Register(api, op, tasksRead) }`:
    // the route line sits inside the registrar, which never calls the handler;
    // the route's own symbol is what links to `tasksRead`.
    const backend = fa("pkg/routes/tasks.go", {
      functions: [fn("RegisterTaskRoutes", 10, 40), fn("tasksRead", 50, 70)],
      routes: [{ path: "/tasks/{task}", httpMethod: "GET", kind: "api", handler: "tasksRead", calls: [], middleware: [], line: 14 }],
    } as any);
    const out = synthesizeApiRouteSymbolLinks(
      [link({ target: "pkg/routes/tasks.go", targetLine: 14, handler: "tasksRead", routePath: "/tasks/{task}" })],
      [frontend, backend],
    );
    expect(out.map((l) => l.targetSymbol)).toEqual(["route:GET /tasks/{task}"]);
  });

  it("targets the route's symbol for a route with no handler registered inside a function, and the function a route is declared on", () => {
    // `r.GET("/ping", timeout.New(…))` in a `main` that migrates: the plugin read no handler, and `main` is no part
    // of the request. A route on a method's first line (a decorator with no handler named) is that method's.
    const backend = fa("cmd/main.go", {
      functions: [fn("main", 10, 60), fn("ping", 70, 75)],
      routes: [
        { path: "/ping", httpMethod: "GET", kind: "api", handler: null, calls: [], middleware: [], line: 30 },
        { path: "/health", httpMethod: "GET", kind: "api", handler: null, calls: [], middleware: [], line: 70 },
      ],
    } as any);
    const out = synthesizeApiRouteSymbolLinks(
      [
        link({ target: "cmd/main.go", targetLine: 30, handler: null, routePath: "/ping" }),
        link({ target: "cmd/main.go", targetLine: 70, handler: null, routePath: "/health" }),
      ],
      [frontend, backend],
    );
    expect(out.map((l) => l.targetSymbol)).toEqual(["route:GET /ping", "ping"]);
  });

  it("targets the route serving the call's method among routes sharing the line and the path", () => {
    // A framework-supplied CRUD set anchored on its class's line: one path, four methods.
    const backend = fa("league/views.py", {
      classes: [{ name: "ClubViewSet", line: 8, endLine: 20, methods: [] }],
      routes: ["GET", "PUT", "PATCH", "DELETE"].map((m) => ({ path: "/api/clubs/{pk}/", httpMethod: m, kind: "api", handler: `ClubViewSet.${m.toLowerCase()}`, calls: [], middleware: [], line: 8 })),
    } as any);
    const out = synthesizeApiRouteSymbolLinks(
      [link({ method: "PATCH", target: "league/views.py", targetLine: 8, handler: "ClubViewSet.partial_update", routePath: "/api/clubs/{pk}/" })],
      [frontend, backend],
    );
    expect(out.map((l) => l.targetSymbol)).toEqual(["route:PATCH /api/clubs/{pk}/"]);
  });

  it("starts a base-class request resolved for a subclass at that subclass's member, and moves inherited calls onto it", () => {
    // `this.requests.post(this.baseRoute)` in BaseCRUDAPI.createOne, fanned out
    // per subclass: each URL is its subclass's, so its edge starts there.
    const base = fa("web/api/base.ts", { classes: [{ name: "BaseCRUDAPI", methods: [fn("createOne", 5, 8)], line: 1 }] } as any);
    const trainings = fa("web/api/trainingplans.ts", { classes: [{ name: "TrainingPlanAPI", methods: [], line: 3 }] } as any);
    const plays = fa("web/api/playbooks.ts", { classes: [{ name: "PlaybookAPI", methods: [], line: 4 }] } as any);
    const alias = fa("web/api/plan-alias.ts", { classes: [{ name: "PlanAliasAPI", methods: [], line: 2 }] } as any);
    const backend = fa("srv/training.py", { classes: [{ name: "Training", methods: [fn("create", 10, 20)] }] } as any);
    const backend2 = fa("srv/plays.py", { classes: [{ name: "Plays", methods: [fn("create", 10, 20)] }] } as any);
    const http = synthesizeApiRouteSymbolLinks(
      [
        link({ source: "web/api/base.ts", sourceLine: 6, method: "POST", target: "srv/training.py", targetLine: 12, handler: "create", routePath: "/api/trainingplans", viaSubclasses: ["TrainingPlanAPI", "PlanAliasAPI"] }),
        link({ source: "web/api/base.ts", sourceLine: 6, method: "POST", target: "srv/plays.py", targetLine: 12, handler: "create", routePath: "/api/playbooks", viaSubclasses: ["PlaybookAPI"] }),
      ],
      [base, trainings, plays, alias, backend, backend2],
    );
    expect(http.map((l) => `${l.sourceFile}::${l.sourceSymbol} → ${l.targetFile}`)).toEqual([
      "web/api/trainingplans.ts::TrainingPlanAPI.createOne → srv/training.py",
      "web/api/plan-alias.ts::PlanAliasAPI.createOne → srv/training.py",
      "web/api/playbooks.ts::PlaybookAPI.createOne → srv/plays.py",
    ]);
    const click: SymbolLink = {
      sourceFile: "web/AddTraining.vue", sourceSymbol: "add", sourceLine: 9, callName: "api.trainingplans.createOne",
      targetFile: "web/api/base.ts", targetSymbol: "BaseCRUDAPI.createOne", targetLine: 5, viaType: "TrainingPlanAPI", viaTypeFile: "web/api/trainingplans.ts",
    };
    const other: SymbolLink = { ...click, sourceSymbol: "other", viaType: "UnlinkedAPI", viaTypeFile: "web/api/unlinked.ts" };
    moveInheritedCallsToSubclasses([click, other], http);
    expect(click).toEqual({ ...click, targetFile: "web/api/trainingplans.ts", targetSymbol: "TrainingPlanAPI.createOne", targetLine: 3 });
    expect("viaType" in click).toBe(false);
    expect([other.targetSymbol, "viaType" in other]).toEqual(["BaseCRUDAPI.createOne", false]);
  });

  it("skips AMBIGUOUS links and top-level (unanchored) calls", () => {
    const backend = fa("server/Controllers/CarsController.cs", {
      classes: [{ name: "CarsController", methods: [fn("GetAll", 18, 25)] }] as any,
    });
    expect(synthesizeApiRouteSymbolLinks([link({ confidence: "AMBIGUOUS" })], [frontend, backend])).toHaveLength(0);
    expect(synthesizeApiRouteSymbolLinks([link({ sourceLine: 500 })], [frontend, backend])).toHaveLength(0);
  });
});

describe("synthesizeQueueSymbolLinks", () => {
  const row = (over: Partial<SymbolDataAccess>): SymbolDataAccess => ({
    file: "f.cs",
    symbol: "S.m",
    symbolLine: 1,
    entity: "car.sold",
    entityMatched: false,
    datastore: "shop-events",
    sites: [{ name: "x", line: 3 }],
    ...over,
  });

  it("links a publish to every consume naming the same destination", () => {
    const out = synthesizeQueueSymbolLinks([
      row({ file: "Pub.cs", symbol: "Pub.Send", access: "queue-publish", datastore: "car-sold" }),
      row({ file: "Con.cs", symbol: "Con.Start", access: "queue-consume", datastore: "car-sold" }),
      row({ file: "worker.js", symbol: "main", access: "queue-consume", datastore: "car-sold" }),
    ]);
    expect(out.map((l) => `${l.sourceSymbol}->${l.targetSymbol}`)).toEqual(["Pub.Send->Con.Start", "Pub.Send->main"]);
    expect(out[0]!.callName).toBe("MQ car-sold");
  });

  it("creates no edge across DIFFERENT destinations or for plain DB rows", () => {
    const out = synthesizeQueueSymbolLinks([
      row({ file: "Pub.cs", symbol: "Pub.Send", access: "queue-publish", datastore: "a" }),
      row({ file: "Con.cs", symbol: "Con.Start", access: "queue-consume", datastore: "b" }),
      row({ file: "Db.cs", symbol: "Db.Save" }), // database access, no `access`
    ]);
    expect(out).toHaveLength(0);
  });
});
