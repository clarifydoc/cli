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
      "GET /v1/cars/{id} GetCar",
      "POST /acme.cars.v1.CarService/CreateCar CreateCar",
      "POST /acme.cars.v1.CarService/GetCar GetCar",
      "POST /acme.cars.v1.CarService/WatchCars WatchCars",
      "POST /helloworld.Greeter/SayHello SayHello",
      "POST /v1/cars CreateCar",
    ]);
    const create = s.routeMap.find((r) => r.path === "/v1/cars");
    expect(Object.keys(create?.requestSchema?.properties ?? {})).toEqual(["driverId", "items", "labels"]);
  });

  it("joins every rpc to the method implementing it, and the browser through the gateway to the table", async () => {
    const s = await loadReportSummary(out);
    const joins = s.symbolLinks.filter((l) => l.strategy === "spec-join").map((l) => `${l.sourceSymbol} -> ${l.targetFile} ${l.targetSymbol}`);
    expect(joins.sort()).toEqual([
      "route:GET /v1/cars/{id} -> go-cars/server/cars.go CarServer.GetCar",
      "route:POST /acme.cars.v1.CarService/CreateCar -> go-cars/server/cars.go CarServer.CreateCar",
      "route:POST /acme.cars.v1.CarService/GetCar -> go-cars/server/cars.go CarServer.GetCar",
      "route:POST /acme.cars.v1.CarService/WatchCars -> go-cars/server/cars.go CarServer.WatchCars",
      "route:POST /helloworld.Greeter/SayHello -> py-greeter/greeter_server.py Greeter.SayHello",
      "route:POST /v1/cars -> go-cars/server/cars.go CarServer.CreateCar",
    ]);
    expect((s.apiRouteLinks ?? []).map((l) => `${l.source} ${l.method} ${l.url}`).sort()).toEqual([
      "checkout/main.go POST /acme.cars.v1.CarService/CreateCar",
      "checkout/main.go POST /acme.cars.v1.CarService/GetCar",
      "dotnet-caller/GreeterCaller.cs POST /helloworld.Greeter/SayHello",
      "py-greeter/greeter_client.py POST /helloworld.Greeter/SayHello",
      "web/src/cars.ts GET /v1/cars/${id}",
      "web/src/cars.ts POST /v1/cars",
    ]);
    // A stub call traces on to the server method implementing the rpc, across languages.
    const traces = s.symbolLinks.filter((l) => l.callName.startsWith("POST /") && !l.sourceFile.startsWith("web/")).map((l) => `${l.sourceSymbol} -> ${l.targetSymbol}`);
    expect(traces.sort()).toEqual([
      "Checkout.Place -> CarServer.CreateCar",
      "GreeterCaller.Greet -> Greeter.SayHello",
      "main -> CarServer.GetCar",
      "run -> Greeter.SayHello",
    ]);
    const flows = (s.dataFlows ?? []).filter((p) => p.resource === "cars").map((p) => `${p.entryLabel} ${p.effect}`);
    expect(flows).toContain("GET /v1/cars/{id} db-read");
    expect(flows).toContain("POST /v1/cars db-write");
  });
});
