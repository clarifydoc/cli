import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { functionJsonEntryPoints, functionJsonRoutes } from "./function-json.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

const clubs = JSON.stringify({
  scriptFile: "../dist/Clubs/index.js",
  bindings: [
    { authLevel: "function", type: "httpTrigger", direction: "in", name: "req", methods: ["get", "post"], route: "clubs/{id?}" },
    { type: "http", direction: "out", name: "res" },
  ],
}, null, 2);

describe("Azure Functions function.json", () => {
  it("reads an HTTP trigger per method, the folder's name standing in for a missing route", () => {
    expect(functionJsonRoutes(clubs, "Clubs").map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual([
      "GET /clubs/{id?} ../dist/Clubs/index.default",
      "POST /clubs/{id?} ../dist/Clubs/index.default",
    ]);
    const bare = JSON.stringify({ bindings: [{ type: "httpTrigger", direction: "in", name: "req" }] });
    expect(functionJsonRoutes(bare, "Players").map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual([
      "null /Players index.default|__init__.main|run.Run",
    ]);
    const compiled = JSON.stringify({ scriptFile: "../bin/League.dll", entryPoint: "League.Functions.Matches.Run", bindings: [{ type: "httpTrigger", route: "matches" }] });
    expect(functionJsonRoutes(compiled, "Matches")[0]?.handler).toBe("League.Functions.Matches::Run");
  });

  it("reads a timer as a scheduled job and a queue trigger as a consumer", () => {
    const timer = JSON.stringify({ bindings: [{ type: "timerTrigger", name: "t", schedule: "0 0 6 * * *" }] });
    const queue = JSON.stringify({ bindings: [{ type: "queueTrigger", name: "m", queueName: "transfers" }] });
    expect(functionJsonEntryPoints(timer, "Standings").map((e) => `${e.kind} ${e.name} ${e.schedule}`)).toEqual(["scheduled-job Standings 0 0 6 * * *"]);
    expect(functionJsonEntryPoints(queue, "Transfers").map((e) => `${e.kind} ${e.name}`)).toEqual(["message-consumer transfers"]);
    expect(functionJsonRoutes(timer, "Standings")).toEqual([]);
  });
});

describe("Azure Functions function.json in a project", () => {
  let dir: string;
  const files: Record<string, string> = {
    "fn/host.json": `{ "version": "2.0" }`,
    "fn/package.json": `{ "name": "league-functions" }`,
    "fn/Clubs/function.json": clubs,
    "fn/src/Clubs/index.ts": `export default async function listClubs(context: unknown, req: unknown): Promise<void> {\n  return;\n}\n`,
    "py/host.json": `{ "version": "2.0", "extensions": { "http": { "routePrefix": "" } } }`,
    "py/requirements.txt": "azure-functions\n",
    "py/Players/function.json": JSON.stringify({ scriptFile: "__init__.py", bindings: [{ type: "httpTrigger", direction: "in", name: "req", methods: ["get"], route: "players" }] }),
    "py/Players/__init__.py": `import azure.functions as func\n\ndef main(req: func.HttpRequest) -> func.HttpResponse:\n    return func.HttpResponse("ok")\n`,
  };
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-azfn-"));
    for (const [f, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "app", f)), { recursive: true });
      await writeFile(join(dir, "app", f), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("anchors each route on the function its folder runs, under host.json's prefix", async () => {
    const summary = await loadReportSummary(join(dir, "out"));
    const rows = summary.routeMap.map((r) => `${r.httpMethod ?? "*"} ${r.path} ${r.filePath} ${r.handler}`).sort();
    expect(rows).toEqual([
      "GET /api/clubs/{id?} fn/src/Clubs/index.ts listClubs",
      "GET /players py/Players/__init__.py main",
      "POST /api/clubs/{id?} fn/src/Clubs/index.ts listClubs",
    ]);
  });
});
