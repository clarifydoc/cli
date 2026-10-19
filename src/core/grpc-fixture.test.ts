import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-grpc, against the contract rows its README labels by hand. */
const fixture = resolve("test-fixtures/sample-grpc");

describe.skipIf(!existsSync(fixture))("sample-grpc", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-grpc-"));
    out = join(dir, "sample-grpc");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves each rpc at its gRPC path and its grpc-gateway binding", async () => {
    const s = await loadReportSummary(out);
    expect(s.routeMap.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`).sort()).toEqual([
      "GET /v1/orders/{id} GetOrder",
      "POST /acme.orders.v1.OrderService/CreateOrder CreateOrder",
      "POST /acme.orders.v1.OrderService/GetOrder GetOrder",
      "POST /acme.orders.v1.OrderService/WatchOrders WatchOrders",
      "POST /helloworld.Greeter/SayHello SayHello",
      "POST /v1/orders CreateOrder",
    ]);
    const create = s.routeMap.find((r) => r.path === "/v1/orders");
    expect(Object.keys(create?.requestSchema?.properties ?? {})).toEqual(["customerId", "items", "labels"]);
  });

  it("joins every rpc to the method implementing it, and the browser through the gateway to the table", async () => {
    const s = await loadReportSummary(out);
    const joins = s.symbolLinks.filter((l) => l.strategy === "spec-join").map((l) => `${l.sourceSymbol} -> ${l.targetFile} ${l.targetSymbol}`);
    expect(joins.sort()).toEqual([
      "route:GET /v1/orders/{id} -> go-orders/server/orders.go OrderServer.GetOrder",
      "route:POST /acme.orders.v1.OrderService/CreateOrder -> go-orders/server/orders.go OrderServer.CreateOrder",
      "route:POST /acme.orders.v1.OrderService/GetOrder -> go-orders/server/orders.go OrderServer.GetOrder",
      "route:POST /acme.orders.v1.OrderService/WatchOrders -> go-orders/server/orders.go OrderServer.WatchOrders",
      "route:POST /helloworld.Greeter/SayHello -> py-greeter/greeter_server.py Greeter.SayHello",
      "route:POST /v1/orders -> go-orders/server/orders.go OrderServer.CreateOrder",
    ]);
    expect((s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} ${l.url}`).sort()).toEqual([
      "web/src/orders.ts POST /v1/orders",
      // A bare fetch(url) states no method; the GET route is the one it reaches.
      "web/src/orders.ts null /v1/orders/${id}",
    ]);
    const flows = (s.dataFlows ?? []).filter((p) => p.resource === "orders").map((p) => `${p.entryLabel} ${p.effect}`);
    expect(flows).toContain("GET /v1/orders/{id} db-read");
    expect(flows).toContain("POST /v1/orders db-write");
  });
});
