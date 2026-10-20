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
  url: "/api/orders",
  target: "server/Controllers/OrdersController.cs",
  targetLine: 20,
  handler: "GetAll",
  routePath: "/api/orders",
  confidence: "EXTRACTED",
  ...over,
});

describe("synthesizeApiRouteSymbolLinks", () => {
  const frontend = fa("web/src/api.ts", { functions: [fn("loadOrders", 10, 15)] });

  it("links the enclosing frontend function to the enclosing route method (annotation-routed)", () => {
    const backend = fa("server/Controllers/OrdersController.cs", {
      classes: [{ name: "OrdersController", methods: [fn("GetAll", 18, 25)] }] as any,
    });
    const [l] = synthesizeApiRouteSymbolLinks([link()], [frontend, backend]);
    expect(l).toMatchObject({
      sourceFile: "web/src/api.ts",
      sourceSymbol: "loadOrders",
      targetFile: "server/Controllers/OrdersController.cs",
      targetSymbol: "OrdersController.GetAll",
      callName: "GET /api/orders",
      confidence: "EXTRACTED",
    });
  });

  it("falls back to the handler NAME in the route file when the route line is top-level (Express)", () => {
    const routes = fa("server/routes/orders.js", { functions: [fn("listOrders", 30, 40)] });
    const [l] = synthesizeApiRouteSymbolLinks(
      [link({ target: "server/routes/orders.js", targetLine: 5, handler: "listOrders" })],
      [frontend, routes],
    );
    expect(l?.targetSymbol).toBe("listOrders");
  });

  it("resolves a handler defined in ANOTHER file when the name is globally unique", () => {
    const routes = fa("server/routes/orders.js"); // route def file, no functions
    const controller = fa("server/controllers/orderController.js", { functions: [fn("listOrders", 8, 20)] });
    const [l] = synthesizeApiRouteSymbolLinks(
      [link({ target: "server/routes/orders.js", targetLine: 5, handler: "listOrders" })],
      [frontend, routes, controller],
    );
    expect(l?.targetFile).toBe("server/controllers/orderController.js");
    expect(l?.targetSymbol).toBe("listOrders");
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

  it("starts a base-class request resolved for a subclass at that subclass's member, and moves inherited calls onto it", () => {
    // `this.requests.post(this.baseRoute)` in BaseCRUDAPI.createOne, fanned out
    // per subclass: each URL is its subclass's, so its edge starts there.
    const base = fa("web/api/base.ts", { classes: [{ name: "BaseCRUDAPI", methods: [fn("createOne", 5, 8)], line: 1 }] } as any);
    const meals = fa("web/api/mealplans.ts", { classes: [{ name: "MealPlanAPI", methods: [], line: 3 }] } as any);
    const books = fa("web/api/cookbooks.ts", { classes: [{ name: "CookbookAPI", methods: [], line: 4 }] } as any);
    const alias = fa("web/api/plan-alias.ts", { classes: [{ name: "PlanAliasAPI", methods: [], line: 2 }] } as any);
    const backend = fa("srv/meals.py", { classes: [{ name: "Meals", methods: [fn("create", 10, 20)] }] } as any);
    const backend2 = fa("srv/books.py", { classes: [{ name: "Books", methods: [fn("create", 10, 20)] }] } as any);
    const http = synthesizeApiRouteSymbolLinks(
      [
        link({ source: "web/api/base.ts", sourceLine: 6, method: "POST", target: "srv/meals.py", targetLine: 12, handler: "create", routePath: "/api/mealplans", viaSubclasses: ["MealPlanAPI", "PlanAliasAPI"] }),
        link({ source: "web/api/base.ts", sourceLine: 6, method: "POST", target: "srv/books.py", targetLine: 12, handler: "create", routePath: "/api/cookbooks", viaSubclasses: ["CookbookAPI"] }),
      ],
      [base, meals, books, alias, backend, backend2],
    );
    expect(http.map((l) => `${l.sourceFile}::${l.sourceSymbol} → ${l.targetFile}`)).toEqual([
      "web/api/mealplans.ts::MealPlanAPI.createOne → srv/meals.py",
      "web/api/plan-alias.ts::PlanAliasAPI.createOne → srv/meals.py",
      "web/api/cookbooks.ts::CookbookAPI.createOne → srv/books.py",
    ]);
    const click: SymbolLink = {
      sourceFile: "web/AddMeal.vue", sourceSymbol: "add", sourceLine: 9, callName: "api.mealplans.createOne",
      targetFile: "web/api/base.ts", targetSymbol: "BaseCRUDAPI.createOne", targetLine: 5, viaType: "MealPlanAPI", viaTypeFile: "web/api/mealplans.ts",
    };
    const other: SymbolLink = { ...click, sourceSymbol: "other", viaType: "UnlinkedAPI", viaTypeFile: "web/api/unlinked.ts" };
    moveInheritedCallsToSubclasses([click, other], http);
    expect(click).toEqual({ ...click, targetFile: "web/api/mealplans.ts", targetSymbol: "MealPlanAPI.createOne", targetLine: 3 });
    expect("viaType" in click).toBe(false);
    expect([other.targetSymbol, "viaType" in other]).toEqual(["BaseCRUDAPI.createOne", false]);
  });

  it("skips AMBIGUOUS links and top-level (unanchored) calls", () => {
    const backend = fa("server/Controllers/OrdersController.cs", {
      classes: [{ name: "OrdersController", methods: [fn("GetAll", 18, 25)] }] as any,
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
    entity: "order.placed",
    entityMatched: false,
    datastore: "shop-events",
    sites: [{ name: "x", line: 3 }],
    ...over,
  });

  it("links a publish to every consume naming the same destination", () => {
    const out = synthesizeQueueSymbolLinks([
      row({ file: "Pub.cs", symbol: "Pub.Send", access: "queue-publish", datastore: "order-placed" }),
      row({ file: "Con.cs", symbol: "Con.Start", access: "queue-consume", datastore: "order-placed" }),
      row({ file: "worker.js", symbol: "main", access: "queue-consume", datastore: "order-placed" }),
    ]);
    expect(out.map((l) => `${l.sourceSymbol}->${l.targetSymbol}`)).toEqual(["Pub.Send->Con.Start", "Pub.Send->main"]);
    expect(out[0]!.callName).toBe("MQ order-placed");
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
