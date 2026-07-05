import { describe, it, expect } from "vitest";
import { synthesizeApiRouteSymbolLinks, synthesizeQueueSymbolLinks } from "./api-route-symbol-links.js";
import type { ApiRouteLink, FileAnalysis, SymbolDataAccess } from "../types/analysis.js";

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
