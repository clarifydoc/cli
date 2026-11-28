import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * Express routes registered by a function on the router it is handed: the paths each mount of that router gives,
 * a function two routers reach, a router handed through another function, and the functions no call reaches.
 */
const FILES: Record<string, string> = {
  "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "4.18.0" } }),
  "api/src/clubs.js": `function mountClubs(router) {
  router.get("/list", (req, res) => res.json([]));
}
function mountSquad(router) {
  router.get("/squad", (req, res) => res.json([]));
}
function mountAll(router) {
  mountSquad(router);
}
function mountRetired(router) {
  router.get("/retired", (req, res) => res.json([]));
}
module.exports = { mountClubs, mountSquad, mountAll, mountRetired };
`,
  "api/src/garage.js": `function mountGarage(router) {
  router.get("/cars", (req, res) => res.json([]));
}
function mountOpen(app) {
  app.get("/open/", (req, res) => res.json([]));
}
module.exports = { mountGarage, mountOpen };
`,
  "api/src/app.js": `const express = require("express");
const clubs = require("./clubs");
const { mountGarage, mountOpen } = require("./garage");
const app = express();
const r = express.Router();
const home = express.Router();
const away = express.Router();
clubs.mountClubs(r);
clubs.mountAll(r);
app.use("/clubs", r);
mountGarage(home);
mountGarage(away);
app.use("/home", home);
app.use("/away", away);
mountOpen(app);
mountGarage(app);
app.listen(3000);
`,
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { react: "18.0.0" } }),
  "web/src/clubs.ts": `export function load() { return fetch("/clubs/list"); }
export function loadSquad() { return fetch("/clubs/squad"); }
export function loadCars() { return fetch("/away/cars"); }
`,
};

describe("Express router handed to a function", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-express-router-fn-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const routes = (file: string) => summary.routeMap
    .filter((r) => r.kind === "api" && r.filePath === file)
    .map((r) => `${r.httpMethod ?? "ANY"} ${r.path}`)
    .sort();

  it("a function serves its routes under the prefix its router is mounted at, through a relaying function", () => {
    expect(routes("api/src/clubs.js")).toEqual(["GET /clubs/list", "GET /retired", "GET /clubs/squad"].sort());
  });

  it("a function reached by two routers serves one route per mount; the application itself serves it as written", () => {
    expect(routes("api/src/garage.js")).toEqual(["GET /away/cars", "GET /cars", "GET /home/cars", "GET /open/"]);
  });

  it("the mounts that only carried a router to a function are no routes", () => {
    expect(routes("api/src/app.js")).toEqual([]);
  });

  it("links a client call to the route a function registered", () => {
    const urls = (summary.apiRouteLinks ?? []).filter((l) => l.target === "api/src/clubs.js").map((l) => l.url).sort();
    expect(urls).toEqual(["/clubs/list", "/clubs/squad"]);
  });
});
