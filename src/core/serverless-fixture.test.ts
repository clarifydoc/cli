import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-serverless, against the routes its README labels by hand. */
const fixture = resolve("test-fixtures/sample-serverless");

describe.skipIf(!existsSync(fixture))("sample-serverless", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-serverless-"));
    out = join(dir, "sample-serverless");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("puts every descriptor route on the function that serves it", async () => {
    const s = await loadReportSummary(out);
    const routes = s.routeMap.map((r) => `${r.httpMethod ?? "ANY"} ${r.path} ${r.filePath} ${r.handler}`);
    expect(routes.sort()).toEqual([
      "ANY /legacy/{proxy+} users-service/serverless.yml bin/legacy",
      "GET /orders cdk-app/lambda/orders.ts list",
      "GET /orders/{id} cdk-app/src/handlers/get-order.ts handler",
      "GET /reports cdk-app/py/report.py main",
      "POST /reports cdk-app/py/report.py main",
      "GET /greet/{name} sam-java/HelloWorldFunction/src/main/java/helloworld/App.java App.handleRequest",
      "GET /hello sam-app/hello_world/app.py lambda_handler",
      "GET /users users-service/src/handlers/users.ts list",
      "GET /users/{id} users-service/src/handlers/users.ts get",
      "POST /hello sam-app/hello_world/app.py lambda_handler",
      "POST /users users-service/src/handlers/users.ts create",
    ].sort());
    expect(s.routeMap.find((r) => r.path === "/users/{id}")?.auth?.schemes).toEqual(["authorize"]);
  });

  it("links the web client's calls to those handlers, and the handlers to the table", async () => {
    const s = await loadReportSummary(out);
    const links = (s.apiRouteLinks ?? []).map((l) => `${l.source} -> ${l.target}`);
    expect(new Set(links)).toEqual(new Set([
      "web/src/api.ts -> users-service/src/handlers/users.ts",
      "web/src/api.ts -> sam-app/hello_world/app.py",
    ]));
    expect(links.length).toBe(4);
    const flows = (s.dataFlows ?? []).filter((p) => p.resource === "users").map((p) => `${p.entryLabel} ${p.effect}`);
    expect(flows.sort()).toEqual(["GET /users db-read", "GET /users/{id} db-read", "POST /users db-write"]);
  });
});
