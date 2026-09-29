import { describe, it, expect } from "vitest";
import { resolveRouterMounts } from "./router-mounts.js";
import type { FileAnalysis, RouteInfo } from "../../types/analysis.js";
import type { ImportIndex } from "../../core/import-index.js";

const route = (
  httpMethod: string | null,
  path: string,
  handler: string | null,
  kind: "api" | "frontend" = "api",
): RouteInfo => ({ path, httpMethod, kind, handler, calls: [], middleware: [], line: 1 });

/** Minimal FileAnalysis carrying only what resolveRouterMounts reads. */
const file = (filePath: string, routes: RouteInfo[]): FileAnalysis =>
  ({ filePath, routes } as unknown as FileAnalysis);

/** Stub import index: `imports[mountingFile][localName]` → resolved file path. */
const importIndex = (imports: Record<string, Record<string, string>>): ImportIndex => ({
  localFor: (f, n) => imports[f]?.[n] ?? null,
  sourceFor: () => null,
  namespacesFor: () => [],
});

const apiPaths = (a: FileAnalysis) => a.routes.filter((r) => r.kind === "api").map((r) => r.path).sort();

describe("resolveRouterMounts", () => {
  it("prefixes a mounted router's routes and drops the mount route", () => {
    const server = file("backend/server.js", [route(null, "/api/auth", "authRoutes")]);
    const auth = file("backend/routes/authRoutes.js", [
      route("POST", "/login", "login"),
      route("GET", "/profile", "getProfile"),
    ]);
    const count = resolveRouterMounts([server, auth], importIndex({
      "backend/server.js": { authRoutes: "backend/routes/authRoutes.js" },
    }));

    expect(count).toBe(2);
    // The mount route is removed (router wiring, not an endpoint).
    expect(server.routes).toHaveLength(0);
    expect(apiPaths(auth)).toEqual(["/api/auth/login", "/api/auth/profile"]);
  });

  it("distinguishes same-named bare paths once each router carries its prefix", () => {
    const server = file("server.js", [
      route(null, "/api/admin", "adminRoutes"),
      route(null, "/api/donor", "donorRoutes"),
    ]);
    const admin = file("routes/adminRoutes.js", [route("GET", "/dashboard", "adminDash")]);
    const donor = file("routes/donorRoutes.js", [route("GET", "/dashboard", "donorDash")]);
    resolveRouterMounts([server, admin, donor], importIndex({
      "server.js": { adminRoutes: "routes/adminRoutes.js", donorRoutes: "routes/donorRoutes.js" },
    }));

    expect(admin.routes[0]!.path).toBe("/api/admin/dashboard");
    expect(donor.routes[0]!.path).toBe("/api/donor/dashboard");
  });

  it("composes transitively through a nested router mount", () => {
    const server = file("server.js", [route(null, "/api", "apiRouter")]);
    const api = file("routes/api.js", [route(null, "/users", "usersRouter")]);
    const users = file("routes/users.js", [route("GET", "/:id", "getUser")]);
    resolveRouterMounts([server, api, users], importIndex({
      "server.js": { apiRouter: "routes/api.js" },
      "routes/api.js": { usersRouter: "routes/users.js" },
    }));

    expect(users.routes[0]!.path).toBe("/api/users/:id");
    expect(api.routes).toHaveLength(0); // intermediate mount dropped
  });

  it("duplicates routes when a router is mounted at several prefixes", () => {
    const server = file("server.js", [
      route(null, "/api/v1/users", "usersRouter"),
      route(null, "/api/v2/users", "usersRouter"),
    ]);
    const users = file("routes/users.js", [route("GET", "/", "list")]);
    resolveRouterMounts([server, users], importIndex({
      "server.js": { usersRouter: "routes/users.js" },
    }));

    expect(apiPaths(users)).toEqual(["/api/v1/users", "/api/v2/users"]);
  });

  it("leaves an unmounted (orphan) router and non-router middleware untouched", () => {
    const server = file("server.js", [
      route(null, "/api/auth", "authRoutes"),
      route(null, "/api/doc", "swaggerUi.serve"), // member expr — not a bare router
    ]);
    const auth = file("routes/authRoutes.js", [route("GET", "/me", "me")]);
    const orphan = file("routes/legacy.js", [route("POST", "/login", "login")]); // never mounted
    const count = resolveRouterMounts([server, auth, orphan], importIndex({
      "server.js": { authRoutes: "routes/authRoutes.js" },
    }));

    expect(count).toBe(1);
    expect(auth.routes[0]!.path).toBe("/api/auth/me");
    expect(orphan.routes[0]!.path).toBe("/login"); // unmounted → unchanged
    // The non-router `use` (member-expression handler) stays as-is.
    expect(server.routes).toEqual([route(null, "/api/doc", "swaggerUi.serve")]);
  });

  it("is a no-op when nothing mounts a router", () => {
    const a = file("app.js", [route("GET", "/health", "health")]);
    expect(resolveRouterMounts([a], importIndex({}))).toBe(0);
    expect(a.routes[0]!.path).toBe("/health");
  });
});

describe("resolveRouterMounts — mount-level guards", () => {
  it("a guard on the mount (`app.use('/admin', requireAuth, adminRouter)`) protects every mounted route, as inherited", () => {
    const mount: RouteInfo = {
      ...route(null, "/admin", "adminRoutes"),
      middleware: ["requireAuth"],
      auth: { policies: ["requireAuth"], roles: [], schemes: [], anonymous: false, inherited: false },
    };
    const server = file("server.js", [mount]);
    const admin = file("routes/admin.js", [
      route("GET", "/users", "list"),
      { ...route("DELETE", "/users/:id", "remove"), middleware: ["requireAdmin"], auth: { policies: ["requireAdmin"], roles: [], schemes: [], anonymous: false, inherited: false } },
    ]);
    resolveRouterMounts([server, admin], importIndex({ "server.js": { adminRoutes: "routes/admin.js" } }));
    const [list, remove] = admin.routes;
    expect(list).toMatchObject({ path: "/admin/users", middleware: ["requireAuth"], auth: { policies: ["requireAuth"], inherited: true } });
    expect(remove).toMatchObject({
      path: "/admin/users/{id}".replace("{id}", ":id"),
      middleware: ["requireAuth", "requireAdmin"],
      auth: { policies: ["requireAuth", "requireAdmin"], inherited: false },
    });
  });

  it("leaves mounted routes untouched when the mount declares no guard", () => {
    const server = file("server.js", [route(null, "/api", "apiRoutes")]);
    const api = file("routes/api.js", [route("GET", "/x", "x")]);
    resolveRouterMounts([server, api], importIndex({ "server.js": { apiRoutes: "routes/api.js" } }));
    expect(api.routes[0]!.middleware).toEqual([]);
    expect(api.routes[0]!.auth).toBeUndefined();
  });
});
