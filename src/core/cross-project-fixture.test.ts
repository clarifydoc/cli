import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Service-to-service links on `test-fixtures/sample-microservices`, scored
 * against labels written BY HAND from that fixture's source — never from the
 * tool's own output.
 *
 * Three .NET APIs and a Node worker. `legacy` serves the same paths as
 * `inventory` (GET /api/items) and `orders` (GET+POST /api/orders), so a call
 * matched on its path alone cannot tell them apart: every label below is only
 * reachable by following the call to the service it names.
 *
 *   orders  InventoryClient   typed HttpClient (AddHttpClient<InventoryClient>),
 *                             BaseAddress = Configuration["Services:Inventory"]
 *                             → compose `Services__Inventory: http://inventory:8080`
 *                             → appsettings.json `http://localhost:5102`, which is
 *                               inventory's launchSettings URL and compose port.
 *                             appsettings.Test.json points at legacy: a test
 *                             profile never decides where production calls go.
 *   orders  OrdersController  _factory.CreateClient("legacy") → named client
 *                             `http://legacy:8080` → legacy.
 *   orders  PaymentsClient    https://api.stripe.com — a third party.
 *   worker  placeOrder        fetch(`${process.env.ORDERS_URL}/api/orders`, POST)
 *                             → compose worker `ORDERS_URL: http://orders:8080`.
 *   worker  stockOf           axios.create({ baseURL: process.env.INVENTORY_URL })
 *                             → compose worker `INVENTORY_URL: http://inventory:8080`.
 *   web     api.ts            same-origin fetch("/api/…") → vite.config.ts proxy
 *                             `/api` → http://localhost:5100, the gateway's
 *                             launchSettings URL and compose port → the gateway's
 *                             YARP routes → orders / inventory; `/api/stock/{**rest}`
 *                             is rewritten to `/api/items/{**rest}`. The gateway
 *                             serves no route itself.
 *   billing CustomerLookup    a JAX-RS proxy of person's published API, built
 *                             by a Spring XML factory bean (clients.xml) —
 *                             no URL on the calling side at all. Each call
 *                             invokes an operation of `com.shop.person.api.
 *                             PersonRepository`, which person-api declares
 *                             (@GET/@POST) and person-service implements.
 */
const FIXTURE = resolve(__dirname, "..", "..", "test-fixtures", "sample-microservices");

const EXPECTED = [
  { call: "orders/Clients/InventoryClient.cs:12", route: "GET /api/items", at: "inventory/Controllers/ItemsController.cs:9" },
  { call: "orders/Clients/InventoryClient.cs:14", route: "GET /api/items/{id}", at: "inventory/Controllers/ItemsController.cs:12" },
  { call: "orders/Controllers/OrdersController.cs:37", route: "GET /api/items", at: "legacy/Controllers/ItemsController.cs:11" },
  { call: "worker/src/index.ts:6", route: "POST /api/orders", at: "orders/Controllers/OrdersController.cs:26" },
  { call: "worker/src/index.ts:15", route: "GET /api/items/{id}", at: "inventory/Controllers/ItemsController.cs:12" },
  { call: "web/src/api.ts:2", route: "POST /api/orders", at: "orders/Controllers/OrdersController.cs:26" },
  { call: "web/src/api.ts:7", route: "GET /api/items", at: "inventory/Controllers/ItemsController.cs:9" },
  { call: "web/src/api.ts:12", route: "GET /api/items/{id}", at: "inventory/Controllers/ItemsController.cs:12" },
  { call: "billing/src/main/java/com/shop/billing/CustomerLookup.java:11", route: "GET /v1/persons/{personId}", at: "person/person-api/src/main/java/com/shop/person/api/PersonRepository.java:15" },
  { call: "billing/src/main/java/com/shop/billing/CustomerLookup.java:16", route: "POST /v1/persons", at: "person/person-api/src/main/java/com/shop/person/api/PersonRepository.java:19" },
];

let out: string | undefined;
let summary: ProjectAnalysis;

beforeAll(async () => {
  out = mkdtempSync(join(tmpdir(), "clarifydoc-microservices-"));
  await analyze({ projectRoot: FIXTURE, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  summary = await loadReportSummary(out);
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe("service-to-service links — hand-labelled fixture", () => {
  it("links each call to the route of the service it names, and only those", () => {
    const links = (summary.apiRouteLinks ?? []).map((l) => ({
      call: `${l.source}:${l.sourceLine}`,
      route: `${l.method} ${l.routePath}`,
      at: `${l.target}:${l.targetLine}`,
      confidence: l.confidence,
    }));
    const byCall = (a: { call: string }, b: { call: string }) => (a.call < b.call ? -1 : a.call > b.call ? 1 : 0);
    expect(links.sort(byCall)).toEqual(EXPECTED.map((e) => ({ ...e, confidence: "EXTRACTED" })).sort(byCall));
  });

  it("says which service each call reaches, and that the third party is outside", () => {
    const origin = (file: string, line: number) =>
      summary.apiCalls.find((c) => c.filePath === file && c.line === line)?.origin;
    expect(origin("orders/Clients/InventoryClient.cs", 12)).toMatchObject({ project: "inventory", confidence: "EXTRACTED" });
    expect(origin("orders/Controllers/OrdersController.cs", 37)).toMatchObject({ project: "legacy", host: "legacy" });
    expect(origin("worker/src/index.ts", 6)).toMatchObject({ project: "orders", host: "orders" });
    expect(origin("worker/src/index.ts", 15)).toMatchObject({ project: "inventory", host: "inventory" });
    expect(origin("orders/Clients/PaymentsClient.cs", 9)).toMatchObject({ host: "api.stripe.com", external: true });
    expect(origin("orders/Clients/PaymentsClient.cs", 9)).not.toHaveProperty("project");
    // Two hops: the dev proxy to the gateway, the gateway's route to the service.
    expect(origin("web/src/api.ts", 12)).toMatchObject({ project: "inventory", host: "inventory", confidence: "EXTRACTED" });
    expect(origin("web/src/api.ts", 12)!.evidence.filter((e) => e.step === "proxy").map((e) => e.file)).toEqual([
      "web/vite.config.ts",
      "gateway/appsettings.json",
    ]);
  });

  it("lifts the links to the services that depend on each other", () => {
    const deps = (summary.projectDependencies ?? []).map((d) => [d.from, d.to, d.kind, d.links, d.deployment?.via ?? null]);
    expect(deps).toEqual([
      ["billing", "person-person-api", "http", 2, null],
      // docker-compose.yml: orders `Services__Inventory: http://inventory:8080`.
      ["orders", "inventory", "http", 2, "Services__Inventory"],
      ["orders", "legacy", "http", 1, null],
      ["web", "inventory", "http", 2, null],
      ["web", "orders", "http", 1, null],
      ["worker", "inventory", "http", 1, "INVENTORY_URL"],
      ["worker", "orders", "http", 1, "ORDERS_URL"],
    ]);
  });
});
