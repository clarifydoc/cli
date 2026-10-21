import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** A frontend-only repository checked against the OpenAPI document its backend publishes, from outside the tree. */
describe("external API specs", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-specs-"));
    await mkdir(join(dir, "web", "src"), { recursive: true });
    await mkdir(join(dir, "web", ".clarifydoc"), { recursive: true });
    await writeFile(join(dir, "web", "package.json"), JSON.stringify({ name: "web", dependencies: { react: "18.3.1" } }));
    await writeFile(join(dir, "web", "src", "api.ts"), [
      'export const getCar = (id: string) => fetch(`/api/cars/${id}`);',
      'export const createCar = () => fetch("/api/cars", { method: "POST" });',
      'export const listPlayers = () => fetch("/api/players");',
      'export const nowhere = () => fetch("/api/nowhere");',
    ].join("\n"));
    await writeFile(join(dir, "cars.yaml"), [
      "openapi: 3.0.3", "info: { title: Cars, version: '1' }", "paths:",
      "  /api/cars/{id}:", "    get: { operationId: getCar, responses: { '200': { description: ok } } }",
      "  /api/cars:", "    post: { operationId: createCar, responses: { '201': { description: ok } } }",
    ].join("\n"));
    await writeFile(join(dir, "players.json"), JSON.stringify({ openapi: "3.0.3", info: { title: "Players", version: "1" }, paths: { "/api/players": { get: { responses: { 200: { description: "ok" } } } } } }));
    // One spec from the option, one from the project config.
    await writeFile(join(dir, "web", ".clarifydoc", "config.json"), JSON.stringify({ specs: ["../players.json"] }));
    await analyze({ projectRoot: join(dir, "web"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true, specs: [join(dir, "cars.yaml")] });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links the calls to the specs' operations, and leaves the rest unmatched", async () => {
    const s = await loadReportSummary(join(dir, "out"));
    expect((s.apiRouteLinks ?? []).map((l) => `${l.method ?? "GET"} ${l.url} → ${l.target}`).sort()).toEqual([
      "GET /api/cars/${id} → @spec/cars.yaml",
      "GET /api/players → @spec/players.json",
      "POST /api/cars → @spec/cars.yaml",
    ]);
    expect((s.apiRouteLinkStats?.misses ?? []).map((m) => m.url)).toEqual(["/api/nowhere"]);
  });
});
