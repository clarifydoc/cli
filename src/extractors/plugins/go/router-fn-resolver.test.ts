import { describe, it, expect } from "vitest";
import { extractGoRoutes, FUNC_REF, goFunctionValueNames } from "./routes.js";
import { ROUTER_CALL } from "../shared/router-functions.js";
import { goRouterFnResolver } from "./router-fn-resolver.js";
import { createEmptyAnalysis, type FileAnalysis, type RouteFact } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import { buildImportIndex } from "../../../core/import-index.js";
import { buildModuleValueLookup } from "../../../core/module-values.js";

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

describe("two types with a RegisterRoutes method", () => {
  it("joins the call to the method of the value's declared type (real-repo FP: a second type lost the first one's prefix)", () => {
    const routes = file("pkg/routes/routes.go", `package routes

func registerMigrations(m *echo.Group) {
\tcsvImporter.RegisterRoutes(m.Group("/migration"))
}`);
    routes.functions.push({ name: "registerMigrations", localTypes: [{ name: "csvImporter", type: "csvpkg.ClubImporter" }] } as never);
    const csv = file("pkg/csv/handler.go", `package csv

func (c *ClubImporter) RegisterRoutes(g *echo.Group) {
\tg.GET("/csv/status", c.Status)
}`);
    const generic = file("pkg/handler/handler_file.go", `package handler

func (h *FileImporter) RegisterRoutes(g *echo.Group) {
\tg.GET("/"+h.Name()+"/status", h.Status)
}`);
    routes.functions.push({ name: "setup", calls: [{ name: "registerMigrations" }] } as never);
    goRouterFnResolver.resolve([routes, csv, generic], {} as ProjectContext);
    expect(csv.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /migration/csv/status"]);
  });
});

describe("Go route prefixes held in another package", () => {
  it("serves routes under a package-level router another file sets from another package's constant", () => {
    const consts = { ...createEmptyAnalysis("internal/config/const.go", "go"), moduleValues: { ApiUri: "/api/v1", DownloadUri: "${ApiUri}/dl" } };
    const start = file("internal/server/start.go", `package server

import (
\t"github.com/example/league/internal/config"
)

func newRouter(conf *config.Config) *gin.Engine {
\trouter := gin.New()
\tAPIv1 = router.Group(conf.BaseUri(config.ApiUri), APIMiddleware(conf))
\treturn router
}`, [["config", "github.com/example/league/internal/config"]]);
    const routes = file("internal/server/routes.go", `package server

import (
\t"github.com/example/league/internal/api"
\t"github.com/example/league/internal/config"
)

var APIv1 *gin.RouterGroup

func registerRoutes(router *gin.Engine, conf *config.Config) {
\tapi.GetClubs(APIv1)
\tdl := router.Group(config.DownloadUri)
\tdl.GET("/:hash", api.Download)
\tunknown := router.Group(config.Elsewhere + "/garage")
\tunknown.GET("/cars", api.Cars)
}`, [["api", "github.com/example/league/internal/api"], ["config", "github.com/example/league/internal/config"]]);
    const clubs = file("internal/api/clubs.go", `package api

func GetClubs(router *gin.RouterGroup) {
\trouter.GET("/clubs", listClubs)
}`);
    start.functions.push({ name: "newRouter", calls: [{ name: "registerRoutes" }] } as never);
    const analyses = [consts, start, routes, clubs];
    const importIndex = buildImportIndex(analyses);
    goRouterFnResolver.resolve(analyses, { importIndex, moduleValue: buildModuleValueLookup(analyses, importIndex) } as unknown as ProjectContext);
    expect(clubs.routes.map((r) => `${r.httpMethod} ${r.path} ${r.middleware.join(",")}`)).toEqual(["GET /api/v1/clubs APIMiddleware(conf)"]);
    // A base no package states is not part of the route, as `cfg.Base + "/x"` is read in the file.
    expect(routes.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /api/v1/dl/:hash", "GET /garage/cars"]);
  });

  it("hands on nothing through a package router no file of the package sets", () => {
    const routes = file("internal/server/routes.go", `package server

var APIv1 *gin.RouterGroup

func registerRoutes(router *gin.Engine) {
\tapi.GetClubs(APIv1)
}`, [["api", "github.com/example/league/internal/api"]]);
    const clubs = file("internal/api/clubs.go", `package api

func GetClubs(router *gin.RouterGroup) {
\trouter.GET("/clubs", listClubs)
}`);
    goRouterFnResolver.resolve([routes, clubs], {} as ProjectContext);
    expect(clubs.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /clubs"]);
  });
});

describe("middleware a router function inherits from its mount site", () => {
  it("names the mount's guard functions, with the file of the mount, on the routes registered in the other package", () => {
    const file = (filePath: string, src: string, imports: Array<[string, string]> = []): FileAnalysis => {
      const facts: RouteFact[] = [];
      const routes = extractGoRoutes(src.split("\n"), facts);
      return {
        ...createEmptyAnalysis(filePath, "go"),
        routes,
        routeFacts: facts,
        imports: imports.map(([alias, source]) => ({ source, specifiers: [alias], isDefault: false, isNamespace: false, isType: false, line: 1 })),
      };
    };
    const main = file("main.go", `package main

func main() {
\tr := gin.Default()
\tapi := r.Group("/api", auth.Required(), gin.Logger())
\tclubs.Register(api)
\tgarages.Register(r.Group("/open"))
}`, [["clubs", "example.com/league/clubs"], ["garages", "example.com/league/garages"]]);
    const clubs = file("clubs/clubs.go", `package clubs

func Register(r *gin.RouterGroup) {
\tr.GET("/clubs", List)
}`);
    const garages = file("garages/garages.go", `package garages

func Register(r *gin.RouterGroup) {
\tr.GET("/garages", List)
}`);
    goRouterFnResolver.resolve([main, clubs, garages], {} as ProjectContext);
    const row = (a: FileAnalysis) => a.routes.map((r) => `${r.path} [${r.middleware.join(", ")}] calls=${(r.middlewareCalls ?? []).join(",")} inherited=${(r.inheritedMiddleware ?? []).map((m) => `${m.file}:${m.calls.join(",")}`).join(";")}`);
    expect(row(clubs)).toEqual(["/api/clubs [auth.Required(), gin.Logger()] calls= inherited=main.go:auth.Required,gin.Logger"]);
    expect(row(garages)).toEqual(["/open/garages [] calls= inherited="]);
  });
});

describe("a register function nothing calls", () => {
  const caller = (name: string, calls: string[]): FileAnalysis => ({ ...createEmptyAnalysis("main.go", "go"), functions: [{ name, calls: calls.map((c) => ({ name: c })) } as never] });
  const routes = () => file("league/routes.go", `package league

func registerClubs(g *gin.RouterGroup) { g.GET("/clubs", listClubs) }
func registerOld(g *gin.RouterGroup) { g.GET("/legacy", listClubs) }
func registerRelay(g *gin.RouterGroup) {
\tregisterDeep(g.Group("/deep"))
}
func registerDeep(g *gin.RouterGroup) { g.GET("/cars", listCars) }
func Export(g *gin.RouterGroup) { g.GET("/library", list) }`);
  const paths = (a: FileAnalysis) => a.routes.map((r) => `${r.httpMethod} ${r.path}`);

  it("drops its routes and the routes of functions only it hands a router to", () => {
    const main = file("league/main.go", `package league

func main() {
\tr := gin.Default()
\tregisterClubs(r.Group("/api/v2"))
}`);
    main.functions.push({ name: "main", calls: [{ name: "registerClubs" }] } as never);
    const r = routes();
    goRouterFnResolver.resolve([main, r], {} as ProjectContext);
    // Export is exported in a package no scanned file imports: a library's entry point keeps its path.
    expect(paths(r)).toEqual(["GET /api/v2/clubs", "GET /library"]);
  });

  it("keeps a function stored or handed on as a value (real-repo FP: a docs registrar assigned to a variable)", () => {
    const wire = file("league/wire.go", "package league");
    wire.routeFacts!.push({ kind: FUNC_REF, line: 0, data: { names: goFunctionValueNames(["var registerDocs = league.registerOld", "var table = []func(*gin.RouterGroup){", "\tregisterRelay,", "}"]) } });
    const r = routes();
    goRouterFnResolver.resolve([wire, r], {} as ProjectContext);
    expect(paths(r)).toEqual(["GET /legacy", "GET /deep/cars", "GET /library"]);
    expect(goFunctionValueNames(["x := register(a.b, coach, err, nil)", "var f = pkg.Mount", "\treturn &Handler"])).toEqual(["b", "coach", "Mount", "Handler"]);
  });

  it("keeps a function a call anywhere names, and an exported one in an imported package is dead when nobody calls it", () => {
    const r = routes();
    goRouterFnResolver.resolve([caller("boot", ["registerOld", "registerRelay"]), r], {} as ProjectContext);
    expect(paths(r)).toEqual(["GET /legacy", "GET /deep/cars", "GET /library"]);
    const lib = file("garage/cars.go", `package garage

func Mount(g *gin.RouterGroup) { g.GET("/cars", list) }`);
    const user = { ...createEmptyAnalysis("main.go", "go"), imports: [{ source: "example.com/league/garage", specifiers: ["garage"], isDefault: false, isNamespace: false, isType: false, line: 1 }] };
    goRouterFnResolver.resolve([user, lib], {} as ProjectContext);
    expect(paths(lib)).toEqual([]);
  });
});
