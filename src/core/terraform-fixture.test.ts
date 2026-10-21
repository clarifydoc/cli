import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** test-fixtures/sample-terraform, against its hand-written README labels. */
const fixture = resolve("test-fixtures/sample-terraform");

describe.skipIf(!existsSync(fixture))("sample-terraform", () => {
  let dir: string;
  let out: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-tf-"));
    out = join(dir, "sample-terraform");
    await analyze({ projectRoot: fixture, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("puts each API Gateway route on the Lambda handler it invokes, and the browser's calls on them", async () => {
    const s = await loadReportSummary(out);
    expect(s.routeMap.map((r) => `${r.httpMethod} ${r.path} → ${r.filePath} ${r.handler}`).sort()).toEqual([
      "GET /cars/{id} → src/cars/handler.ts getCar",
      "GET /reports/daily → src/reports/main.py daily",
      "POST /cars → src/cars/handler.ts createCar",
    ]);
    expect(s.routeMap.find((r) => r.httpMethod === "POST")?.auth?.schemes).toEqual(["JWT"]);
    expect((s.apiRouteLinks ?? []).map((l) => `${l.method} ${l.url} → ${l.target} ${l.confidence}`).sort()).toEqual([
      "GET /cars/${id} → src/cars/handler.ts EXTRACTED",
      "GET /reports/daily → src/reports/main.py EXTRACTED",
      "POST /cars → src/cars/handler.ts EXTRACTED",
    ]);
  });

  it("deploys the functions with their code and the queue, table and database they reach", async () => {
    const s = await loadReportSummary(out);
    const d = s.deployment!;
    expect(d.services.map((v) => `${v.name} ${v.kind}${v.family ? `/${v.family}` : ""}${v.entryFile ? ` ${v.entryFile}` : ""}`).sort()).toEqual([
      "cars app src/cars/handler.ts",
      "cars-dynamodb datastore/dynamodb",
      "create-car app src/cars/handler.ts",
      "jobs queue/sqs",
      "reporting datastore/postgres",
      "reports app src/reports/main.py",
    ]);
    expect(d.edges.map((e) => `${e.from} → ${e.to} [${e.kind}] ${e.via}`).sort()).toEqual([
      "cars → cars-dynamodb [db] TABLE_NAME",
      "cars → jobs [bus] QUEUE_URL",
      "reports → jobs [bus] event source",
      "reports → reporting [db] DATABASE_URL",
    ]);
    expect((s.envVars ?? []).map((v) => `${v.name} ← ${v.setBy.map((x) => x.service).join(",")}`)).toEqual(["DATABASE_URL ← reports", "TABLE_NAME ← cars"]);
  });
});
