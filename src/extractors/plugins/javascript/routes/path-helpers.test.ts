import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../../core/analyzer.js";
import { loadReportSummary } from "../../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../../types/analysis.js";

/**
 * Express routes registered by shapes a single call does not show: a handler
 * a factory builds, and a helper handed the router and the path.
 */
const FILES: Record<string, string> = {
  "api/package.json": JSON.stringify({ name: "league-api", dependencies: { express: "4.18.0" } }),
  "api/src/handlers.js": `function createUploadHandler(opts) {
  return async (req, res) => { res.json({ ok: true, dir: opts.dir }); };
}
module.exports = { createUploadHandler };
`,
  "api/src/progress.js": `function mountProgress(app, routePath) {
  app.get(routePath, (req, res) => res.json({ progress: 1 }));
}
function mountStandings(app, standingsPath) {
  app.get(standingsPath, (req, res) => res.json([]));
}
function registerFixtures(app) {
  app.get("/api/fixtures", (req, res) => res.json([]));
}
module.exports = { mountProgress, mountStandings, registerFixtures };
`,
  "api/src/server.js": `const express = require("express");
const { createUploadHandler } = require("./handlers");
const { mountProgress } = require("./progress");
const limiter = (req, res, next) => next();
const app = express();
app.post("/api/clubs/upload", limiter, createUploadHandler({ dir: "/tmp" }));
app.post(
  "/api/players/upload",
  limiter,
  createUploadHandler({ dir: "/tmp/players" }),
);
mountProgress(app, "/api/clubs/:id/progress");
mountProgress(app, "/api/players/:id/progress");
mountProgress(app, ("/api/seasons/:id/progress" as const));
app.listen(3000);
`,
  "web/package.json": JSON.stringify({ name: "league-web", dependencies: { react: "18.0.0", axios: "1.6.0" } }),
  "web/src/clubs.ts": `import { api } from "./client";
export function saveClub(club: { name: string }) {
  return api.post("/api/clubs", toPayload(club));
}
export function clubProgress(id: string) {
  return fetch(\`/api/clubs/\${id}/progress\`);
}
function toPayload(club: { name: string }) { return { name: club.name }; }
`,
  "web/src/client.ts": `import axios from "axios";
export const api = axios.create({ baseURL: "/" });
`,
};

describe("Express route shapes", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-path-helpers-"));
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

  const routes = (prefix: string) => summary.routeMap
    .filter((r) => r.kind === "api" && (r.filePath ?? "").startsWith(prefix))
    .map((r) => [r.httpMethod, r.path, r.handler, r.pathUnresolved ? "unresolved" : null].filter(Boolean).join(" "))
    .sort();

  it("a handler a factory builds is a route, on one line or several", () => {
    expect(routes("api/src/server.js")).toEqual([
      "POST /api/clubs/upload createUploadHandler",
      "POST /api/players/upload createUploadHandler",
    ]);
  });

  it("a helper handed the path serves its route at each path a call hands it; one no call binds keeps the unknown path", () => {
    expect(routes("api/src/progress.js")).toEqual([
      "GET /${standingsPath} unresolved",
      "GET /api/clubs/:id/progress",
      "GET /api/fixtures",
      "GET /api/players/:id/progress",
      "GET /api/seasons/:id/progress",
    ]);
  });

  it("a client request whose payload is a call is no route", () => {
    expect(routes("web/")).toEqual([]);
  });

  it("links a client call to the route a helper registered", () => {
    const link = (summary.apiRouteLinks ?? []).find((l) => l.url.includes("/progress"));
    expect(link?.target).toBe("api/src/progress.js");
  });
});
