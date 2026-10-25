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
 * `fleet` (GET /api/parts) and `cars` (GET+POST /api/cars), so a call
 * matched on its path alone cannot tell them apart: every label below is only
 * reachable by following the call to the service it names.
 *
 *   cars    FleetClient       typed HttpClient (AddHttpClient<FleetClient>),
 *                             BaseAddress = Configuration["Services:Fleet"]
 *                             → compose `Services__Fleet: http://fleet:8080`
 *                             → appsettings.json `http://localhost:5102`, which is
 *                               fleet's launchSettings URL and compose port.
 *                             appsettings.Test.json points at legacy: a test
 *                             profile never decides where production calls go.
 *   cars    IFleetApi         a Refit interface, its `[Get]` the request;
 *                             AddRefitClient<IFleetApi>() gets the same
 *                             `Services:Fleet` base → fleet, not legacy.
 *   cars    CarsController    _factory.CreateClient("legacy") → named client
 *                             `http://legacy:8080` → legacy.
 *   cars    PaymentsClient    https://api.stripe.com — a third party.
 *   worker  buyCar            fetch(`${process.env.CARS_URL}/api/cars`, POST)
 *                             → compose worker `CARS_URL: http://cars:8080`.
 *   worker  stockOf           axios.create({ baseURL: process.env.FLEET_URL })
 *                             → compose worker `FLEET_URL: http://fleet:8080`.
 *   web     api.ts            same-origin fetch("/api/…") → vite.config.ts proxy
 *                             `/api` → http://localhost:5100, the gateway's
 *                             launchSettings URL and compose port → the gateway's
 *                             YARP routes → cars / fleet; `/api/stock/{**rest}`
 *                             is rewritten to `/api/parts/{**rest}`. The gateway
 *                             serves no route itself.
 *   billing DriverLookup      a JAX-RS proxy of person's published API, built
 *                             by a Spring XML factory bean (clients.xml) —
 *                             no URL on the calling side at all. Each call
 *                             invokes an operation of `com.shop.person.api.
 *                             PersonRepository`, which person-api declares
 *                             (@GET/@POST) and person-service implements.
 *   billing ClubClient        a Feign client named only `league`: the name
 *                             league registers under in discovery
 *                             (`spring.application.name`), its routes served
 *                             under `server.servlet.context-path: /league`.
 *   billing SponsorBilling    a WebClient built on `http://league/league` —
 *                             the same discovery name, then the uri.
 */
const FIXTURE = resolve(__dirname, "..", "..", "test-fixtures", "sample-microservices");

const EXPECTED = [
  { call: "cars/Clients/FleetClient.cs:12", route: "GET /api/parts", at: "fleet/Controllers/PartsController.cs:9" },
  { call: "cars/Clients/FleetClient.cs:14", route: "GET /api/parts/{id}", at: "fleet/Controllers/PartsController.cs:12" },
  { call: "cars/Clients/IFleetApi.cs:7", route: "GET /api/parts/{id}", at: "fleet/Controllers/PartsController.cs:12" },
  { call: "cars/Controllers/CarsController.cs:37", route: "GET /api/parts", at: "legacy/Controllers/PartsController.cs:11" },
  { call: "worker/src/index.ts:6", route: "POST /api/cars", at: "cars/Controllers/CarsController.cs:26" },
  { call: "worker/src/index.ts:15", route: "GET /api/parts/{id}", at: "fleet/Controllers/PartsController.cs:12" },
  { call: "web/src/api.ts:2", route: "POST /api/cars", at: "cars/Controllers/CarsController.cs:26" },
  { call: "web/src/api.ts:7", route: "GET /api/parts", at: "fleet/Controllers/PartsController.cs:9" },
  { call: "web/src/api.ts:12", route: "GET /api/parts/{id}", at: "fleet/Controllers/PartsController.cs:12" },
  { call: "billing/src/main/java/com/shop/billing/DriverLookup.java:11", route: "GET /v1/persons/{personId}", at: "person/person-api/src/main/java/com/shop/person/api/PersonRepository.java:15" },
  { call: "billing/src/main/java/com/shop/billing/DriverLookup.java:16", route: "POST /v1/persons", at: "person/person-api/src/main/java/com/shop/person/api/PersonRepository.java:19" },
  { call: "billing/src/main/java/com/shop/billing/ClubClient.java:8", route: "GET /league/clubs/{id}", at: "league/src/main/java/com/shop/league/ClubController.java:9" },
  { call: "billing/src/main/java/com/shop/billing/SponsorBilling.java:10", route: "POST /league/clubs/{id}/sponsors", at: "league/src/main/java/com/shop/league/ClubController.java:14" },
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
    expect(origin("cars/Clients/FleetClient.cs", 12)).toMatchObject({ project: "fleet", confidence: "EXTRACTED" });
    expect(origin("cars/Clients/IFleetApi.cs", 7)).toMatchObject({ project: "fleet", confidence: "EXTRACTED" });
    expect(origin("cars/Controllers/CarsController.cs", 37)).toMatchObject({ project: "legacy", host: "legacy" });
    expect(origin("worker/src/index.ts", 6)).toMatchObject({ project: "cars", host: "cars" });
    expect(origin("worker/src/index.ts", 15)).toMatchObject({ project: "fleet", host: "fleet" });
    expect(origin("cars/Clients/PaymentsClient.cs", 9)).toMatchObject({ host: "api.stripe.com", external: true });
    expect(origin("cars/Clients/PaymentsClient.cs", 9)).not.toHaveProperty("project");
    // A discovery name: the project whose spring.application.name it is.
    expect(origin("billing/src/main/java/com/shop/billing/ClubClient.java", 8)).toMatchObject({ project: "league", host: "league", confidence: "EXTRACTED" });
    // Two hops: the dev proxy to the gateway, the gateway's route to the service.
    expect(origin("web/src/api.ts", 12)).toMatchObject({ project: "fleet", host: "fleet", confidence: "EXTRACTED" });
    expect(origin("web/src/api.ts", 12)!.evidence.filter((e) => e.step === "proxy").map((e) => e.file)).toEqual([
      "web/vite.config.ts",
      "gateway/appsettings.json",
    ]);
  });

  it("lifts the links to the services that depend on each other", () => {
    const deps = (summary.projectDependencies ?? []).map((d) => [d.from, d.to, d.kind, d.links, d.deployment?.via ?? null]);
    expect(deps).toEqual([
      ["billing", "league", "http", 2, null],
      ["billing", "person-person-api", "http", 2, null],
      // docker-compose.yml: cars `Services__Fleet: http://fleet:8080`.
      ["cars", "fleet", "http", 3, "Services__Fleet"],
      ["cars", "legacy", "http", 1, null],
      ["web", "cars", "http", 1, null],
      ["web", "fleet", "http", 2, null],
      ["worker", "cars", "http", 1, "CARS_URL"],
      ["worker", "fleet", "http", 1, "FLEET_URL"],
    ]);
  });
});
