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
\tusers.Register(v1.Group("/users"))
\tv1.Use(AuthMiddleware(true))
\tusers.Account(v1.Group("/user"))
\tadmin.Setup(v1)
\tr.GET("/ping", ping)
}`;

describe("Go routes registered by a function on the router it is handed", () => {
  it("marks routes on a router parameter as the function's, and records calls handing a router on", () => {
    const users = file("users/routers.go", `package users

func Register(router *gin.RouterGroup) {
\trouter.POST("", Registration)
\trouter.POST("/login", Login)
}`);
    expect(users.routes.map((r) => `${r.httpMethod} ${r.path} ${r.owner}`)).toEqual(["POST / fn:Register", "POST /login fn:Register"]);
    const main = file("main.go", MAIN);
    expect(main.routeFacts!.filter((f) => f.kind === ROUTER_CALL).map((f) => {
      const d = f.data as { callee: string; prefix: string; relative: boolean; guards: Array<{ text: string }> };
      return `${d.callee} ${d.prefix} ${d.relative} [${d.guards.map((g) => g.text).join(",")}]`;
    })).toEqual([
      "users.Register /api/users false []",
      "users.Account /api/user false [AuthMiddleware(true)]",
      "admin.Setup /api false [AuthMiddleware(true)]",
    ]);
    expect(main.routes.map((r) => `${r.httpMethod} ${r.path} ${r.owner ?? "-"}`)).toEqual(["GET /ping -"]);
  });

  it("prefixes each function's routes through the calls that reach it, composing nested registrations", () => {
    const main = file("main.go", MAIN, [["users", "github.com/acme/app/users"], ["admin", "github.com/acme/app/internal/admin"]]);
    const users = file("users/routers.go", `package users

func Register(router *gin.RouterGroup) {
\trouter.POST("/login", Login)
}

func Account(router *gin.RouterGroup) {
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
    goRouterFnResolver.resolve([main, users, admin], {} as ProjectContext);
    const all = [main, users, admin].flatMap((a) => a.routes).map((r) => `${r.httpMethod} ${r.path} [${r.middleware.join(",")}]${r.auth ? ` auth=${[...r.auth.roles, ...r.auth.policies].join("+")}` : ""}`);
    expect(all).toEqual([
      "GET /ping []",
      "POST /api/users/login []",
      "GET /api/user [AuthMiddleware(true)] auth=AuthMiddleware",
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
    const billing = file("services/billing/handlers/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/invoices", A)\n}`);
    const shipping = file("services/shipping/handlers/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/parcels", B)\n}`);
    goRouterFnResolver.resolve([main, billing, shipping], {} as ProjectContext);
    expect(billing.routes.map((r) => r.path)).toEqual(["/billing/invoices"]);
    expect(shipping.routes.map((r) => r.path)).toEqual(["/parcels"]);

    // Two packages equally near (both one directory in from services/): neither.
    const cmd = file("services/cmd/main.go", `func main() {\n\tr := gin.Default()\n\th.Register(r.Group("/x"))\n}`);
    const a = file("services/a/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/a", A)\n}`);
    const b = file("services/b/routes.go", `func Register(r *gin.RouterGroup) {\n\tr.GET("/b", B)\n}`);
    goRouterFnResolver.resolve([cmd, a, b], {} as ProjectContext);
    expect([a, b].flatMap((f) => f.routes).map((r) => r.path)).toEqual(["/a", "/b"]);
  });
});
