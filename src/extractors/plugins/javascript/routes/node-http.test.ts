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
    expect(await routesOf(`function route(pathname, req) { if (pathname === "/x") go(); }`)).toEqual([]);
  });

  it("keeps a bare path and a bare slash out", async () => {
    const routes = await routesOf(`
http.createServer((req, res) => {
  if (path === "/nope" && req.method === "GET") a();
  if (req.url === "/") b();
  if (req.url === "/cars") c();
});`);
    expect(rows(routes)).toEqual(["ALL /cars"]);
  });
});

describe("route modules dispatched from another file", () => {
  it("reads a verb and a path compared in a module without createServer", async () => {
    const routes = await routesOf(`
export function clubRoutes(ctx) {
  return {
    handle(req, res) {
      const { pathname } = new URL(req.url, "http://x");
      if (req.method === "GET" && pathname === "/api/clubs") { return listClubs(res); }
      if (pathname === "/api/players") { return listPlayers(res); }
    },
  };
}`);
    expect(rows(routes)).toEqual(["GET /api/clubs"]);
    expect(routes[0]!.calls.map((c) => c.name)).toContain("listClubs");
  });

  it("lets an enclosing method if cover nested path ifs, but not its else", async () => {
    const routes = await routesOf(`
function handle(req, res, pathname) {
  if (req.method === "POST") {
    if (pathname === "/api/clubs") create();
  } else {
    if (pathname === "/api/matches") other();
  }
}`);
    expect(rows(routes)).toEqual(["POST /api/clubs"]);
  });

  it("reads || methods all or nothing", async () => {
    const routes = await routesOf(`
function handle(req, res, pathname) {
  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/api/clubs") a();
  if ((req.method === "PUT" || isAdmin(req)) && pathname === "/api/players") b();
}`);
    expect(rows(routes)).toEqual(["GET /api/clubs", "HEAD /api/clubs"]);
  });

  it("never reads !==, and reads a !(…) wrapper by parity", async () => {
    const routes = await routesOf(`
function handle(req, res, pathname) {
  if (req.method !== "POST" && pathname === "/api/clubs") a();
  if (!(req.method !== "DELETE") && pathname === "/api/matches") b();
  if (!(req.method === "PATCH") && pathname === "/api/players") c();
}`);
    expect(rows(routes)).toEqual(["DELETE /api/matches"]);
  });

  it("reads an anchored regex of single-segment groups", async () => {
    const routes = await routesOf(`
function handle(req, res, pathname) {
  if (req.method === "GET" && pathname.match(/^\\/api\\/clubs\\/([^/]+)$/)) a();
  if (req.method === "PUT" && /^\\/api\\/players\\/(\\d+)\\/?$/.test(pathname)) b();
  if (req.method === "GET" && pathname.match(/^\\/api\\/matches\\/(.+)$/)) c();
  if (req.method === "GET" && pathname.match(/\\/api\\/cars\\/([^/]+)$/)) d();
}`);
    expect(rows(routes)).toEqual(["GET /api/clubs/{param}", "PUT /api/players/{param}"]);
  });

  it("folds same-file constants and drops a name declared twice", async () => {
    const routes = await routesOf(`
const CLUBS = "/api/clubs";
const MATCHES = "/api/matches";
function a() { const MATCHES = "/other"; }
function handle(req, res, pathname) {
  if (req.method === "GET" && pathname === CLUBS) x();
  if (req.method === "GET" && pathname === \`\${CLUBS}/top\`) y();
  if (req.method === "GET" && pathname === MATCHES) z();
}`);
    expect(rows(routes)).toEqual(["GET /api/clubs", "GET /api/clubs/top"]);
  });

  it("lets a verb-less row yield to the same path with a verb", async () => {
    const routes = await routesOf(`
http.createServer((req, res) => {
  if (req.url === "/cars") list();
  if (req.url === "/cars" && req.method === "POST") add();
  if (req.url === "/garage") open();
});`);
    expect(rows(routes)).toEqual(["POST /cars", "ALL /garage"]);
  });

  it("ignores startsWith and node:path in a module", async () => {
    const routes = await routesOf(`
function handle(req, res, pathname) {
  if (req.method === "GET" && pathname.startsWith("/api/clubs")) a();
  if (req.method === "GET" && path === "/api/matches") b();
  if (req.method === "GET" && pathname === "/") c();
}`);
    expect(routes).toEqual([]);
  });

  it("reads a route table only when a dispatcher compares both fields and calls the handler", async () => {
    const withLoop = await routesOf(`
const routes = [
  { path: "/api/clubs", method: "GET", handler: listClubs },
  { path: "/api/clubs", method: "POST", handler: createClub },
];
export function dispatch(req, res, pathname) {
  for (const r of routes) {
    if (r.method === req.method && r.path === pathname) return r.handler(req, res);
  }
}`);
    expect(rows(withLoop)).toEqual(["GET /api/clubs", "POST /api/clubs"]);
    expect(withLoop.map((r) => r.handler)).toEqual(["listClubs", "createClub"]);

    const withFind = await routesOf(`
const routes = [{ path: "/api/cars", method: "GET", handler: listCars }];
export const dispatch = (req, res, pathname) => {
  const hit = routes.find((r) => r.method === req.method && r.path === pathname);
  if (hit) hit.handler(req, res);
};`);
    expect(rows(withFind)).toEqual(["GET /api/cars"]);

    // no dispatcher comparing both fields: a table is just data
    expect(await routesOf(`
const routes = [{ path: "/api/clubs", method: "GET", handler: listClubs }];
export function dispatch(req, res) {
  for (const r of routes) { if (r.path === req.url) r.handler(req, res); }
}`)).toEqual([]);
    // a table nothing dispatches
    expect(await routesOf(`
const menu = [{ path: "/api/clubs", method: "GET", handler: listClubs }];
export function show(item) { return item.handler(); }`)).toEqual([]);
  });
});
