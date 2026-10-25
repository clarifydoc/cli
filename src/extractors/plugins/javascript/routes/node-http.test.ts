import { describe, it, expect } from "vitest";
import "../../../registry.js"; // side effect: registers tree-sitter grammars
import { parseSource } from "../../../../parsers/parser-manager.js";
import { javascriptRouteExtractor } from "./index.js";
import type { RouteInfo } from "../../../../types/analysis.js";

async function routesOf(src: string): Promise<RouteInfo[]> {
  const tree = await parseSource(src, "javascript", "server.js");
  return javascriptRouteExtractor.extractRoutes(tree, src, "server.js");
}
const rows = (routes: RouteInfo[]) => routes.map((r) => `${r.httpMethod} ${r.path}`);

describe("raw Node http.createServer dispatch", () => {
  it("serves each path a branch compares with a literal, at the method the same condition names", async () => {
    const routes = await routesOf(`
const server = http.createServer((req, res) => {
  const pathname = url.parse(req.url).pathname || "/";
  if (pathname === "/garage/rebuild" && req.method === "POST") {
    rebuildGarage();
    return res.end("ok");
  }
  if ("GET" === req.method && pathname === "/cars") {
    return res.end(JSON.stringify(listCars()));
  }
  if (req.url === "/health") return res.end("up");
  if (pathname.startsWith("/static/")) return serveStatic(req, res);
  const helper = (p) => { if (p === "/not-a-route") return 1; };
});`);
    expect(rows(routes)).toEqual(["POST /garage/rebuild", "GET /cars", "ALL /health"]);
    expect(routes[0]!.calls.map((c) => c.name)).toContain("rebuildGarage");
  });

  it("reads a named listener and a switch on the path", async () => {
    const routes = await routesOf(`
function handle(request, response) {
  switch (request.url) {
    case "/clubs": return listClubs(response);
    case "/players": return listPlayers(response);
    default: response.end();
  }
}
https.createServer(options, handle).listen(8443);`);
    expect(rows(routes)).toEqual(["ALL /clubs", "ALL /players"]);
  });

  it("reads nothing outside a request listener", async () => {
    expect(await routesOf(`function route(pathname, req) { if (pathname === "/x" && req.method === "GET") go(); }`)).toEqual([]);
  });
});
