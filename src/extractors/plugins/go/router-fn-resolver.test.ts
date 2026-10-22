import { describe, it, expect } from "vitest";
import { extractGoRoutes } from "./routes.js";
import { ROUTER_CALL } from "../shared/router-functions.js";
import { goRouterFnResolver } from "./router-fn-resolver.js";
import { createEmptyAnalysis, type FileAnalysis, type RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

function file(filePath: string, src: string, imports: Array<[string, string]> = []): FileAnalysis {
  const facts: RouteFact[] = [];
  const routes = extractGoRoutes(src.split("\n"), facts);
  return {
    ...createEmptyAnalysis(filePath, "go"),
    routes,
    routeFacts: facts,
    imports: imports.map(([alias, source]) => ({ source, specifiers: [alias], isDefault: false, isNamespace: false, isType: false, line: 1 })),
  };
}

const MAIN = `package main

func main() {
\tr := gin.Default()
\tv1 := r.Group("/api")
\tplayers.Register(v1.Group("/players"))
\tv1.Use(AuthMiddleware(true))
\tplayers.Club(v1.Group("/player"))
\tadmin.Setup(v1)
\tr.GET("/ping", ping)
}`;

describe("Go routes registered by a function on the router it is handed", () => {
  it("marks routes on a router parameter as the function's, and records calls handing a router on", () => {
    const players = file("players/routers.go", `package players

func Register(router *gin.RouterGroup) {
\trouter.POST("", Registration)
\trouter.POST("/login", Login)
}`);
    expect(players.routes.map((r) => `${r.httpMethod} ${r.path} ${r.owner}`)).toEqual(["POST / fn:Register", "POST /login fn:Register"]);
    const main = file("main.go", MAIN);
    expect(main.routeFacts!.filter((f) => f.kind === ROUTER_CALL).map((f) => {
      const d = f.data as { callee: string; prefix: string; relative: boolean; guards: Array<{ text: string }> };
      return `${d.callee} ${d.prefix} ${d.relative} [${d.guards.map((g) => g.text).join(",")}]`;
    })).toEqual([
      "players.Register /api/players false []",
      "players.Club /api/player false [AuthMiddleware(true)]",
      "admin.Setup /api false [AuthMiddleware(true)]",
    ]);
    expect(main.routes.map((r) => `${r.httpMethod} ${r.path} ${r.owner ?? "-"}`)).toEqual(["GET /ping -"]);
  });

  it("prefixes each function's routes through the calls that reach it, composing nested registrations", () => {
    const main = file("main.go", MAIN, [["players", "github.com/acme/app/players"], ["admin", "github.com/acme/app/internal/admin"]]);
    const players = file("players/routers.go", `package players

func Register(router *gin.RouterGroup) {
\trouter.POST("/login", Login)
}

func Club(router *gin.RouterGroup) {
\trouter.GET("", Me)
}`);
    const admin = file("internal/admin/routes.go", `package admin

func Setup(rg *gin.RouterGroup) {
\tg := rg.Group("/admin", RequireRole("admin"))
\treports(g)
}

func reports(r *gin.RouterGroup) {
\tr.GET("/reports", ListReports)
}`);
    goRouterFnResolver.resolve([main, players, admin], {} as ProjectContext);
    const all = [main, players, admin].flatMap((a) => a.routes).map((r) => `${r.httpMethod} ${r.path} [${r.middleware.join(",")}]${r.auth ? ` auth=${[...r.auth.roles, ...r.auth.policies].join("+")}` : ""}`);
    expect(all).toEqual([
      "GET /ping []",
      "POST /api/players/login []",
      "GET /api/player [AuthMiddleware(true)] auth=AuthMiddleware",
      "GET /api/admin/reports [AuthMiddleware(true),RequireRole(\"admin\")] auth=admin+AuthMiddleware",
    ]);
  });

  it("leaves a function two packages could be alone", () => {
    const main = file("main.go", `func main() {\n\tr := gin.Default()\n\th.Register(r.Group("/x"))\n}`);
    const a = file("a/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/a", A)\n}`);
    const b = file("b/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/b", B)\n}`);
    goRouterFnResolver.resolve([main, a, b], {} as ProjectContext);
    expect([a, b].flatMap((f) => f.routes).map((r) => r.path)).toEqual(["/a", "/b"]);
  });

  it("of two packages, takes the one nearest the caller — and only when one is nearest", () => {
    const main = file("services/billing/main.go", `func main() {\n\tr := gin.Default()\n\th.Register(r.Group("/billing"))\n}`);
    const billing = file("services/billing/handlers/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/bills", A)\n}`);
    const shipping = file("services/shipping/handlers/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/parcels", B)\n}`);
    goRouterFnResolver.resolve([main, billing, shipping], {} as ProjectContext);
    expect(billing.routes.map((r) => r.path)).toEqual(["/billing/bills"]);
    expect(shipping.routes.map((r) => r.path)).toEqual(["/parcels"]);

    // Two packages equally near (both one directory in from services/): neither.
    const cmd = file("services/cmd/main.go", `func main() {\n\tr := gin.Default()\n\th.Register(r.Group("/x"))\n}`);
    const a = file("services/a/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/a", A)\n}`);
    const b = file("services/b/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/b", B)\n}`);
    goRouterFnResolver.resolve([cmd, a, b], {} as ProjectContext);
    expect([a, b].flatMap((f) => f.routes).map((r) => r.path)).toEqual(["/a", "/b"]);
  });
});

describe("a router a function builds and returns, mounted by its caller", () => {
  it("serves the function's routes under the mount's prefix (real-repo FP: 527 API routes at web paths)", () => {
    const api = file("routers/api/v1/api.go", `package v1

func Routes() *web.Router {
\tm := web.NewRouter()
\tm.Group("/clubs", func() {
\t\tm.Get("", club.List)
\t\tm.Get("/{id}", club.Get)
\t})
\treturn m
}`);
    const init = file("routers/init.go", `package routers

func NormalRoutes() *web.Router {
\tr := web.NewRouter()
\tr.Mount("/api/v1", apiv1.Routes())
\tr.Post("/-/fetch-redirect", common.FetchRedirect)
\treturn r
}`, [["apiv1", "example.com/league/routers/api/v1"]]);
    goRouterFnResolver.resolve([api, init], {} as ProjectContext);
    expect(api.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /api/v1/clubs", "GET /api/v1/clubs/{id}"]);
    expect(init.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["POST /-/fetch-redirect"]);
  });
});

describe("a method call on a value that hands its router on", () => {
  it("reaches the type's method, not the caller's own free function of that name (real-repo FP: the whole API under /migration)", () => {
    const routes = file("pkg/routes/routes.go", `package routes

func RegisterRoutes(e *echo.Echo) {
\tapi := e.Group("/api/v1")
\tapi.GET("/clubs", clubs)
\tregisterMigrations(api)
}

func registerMigrations(m *echo.Group) {
\tfileMigrator.RegisterRoutes(m.Group("/migration"))
}`);
    const handler = file("pkg/modules/migration/handler/handler_file.go", `package handler

func (h *FileMigratorWeb) RegisterRoutes(g *echo.Group) {
\tg.PUT("/club-import", h.Migrate)
}`);
    goRouterFnResolver.resolve([routes, handler], {} as ProjectContext);
    expect(routes.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /api/v1/clubs"]);
    expect(handler.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["PUT /api/v1/migration/club-import"]);
  });
});
