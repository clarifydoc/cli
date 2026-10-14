import { describe, it, expect } from "vitest";
import { inferExpoRouterRoutes, inferFileBasedRoute } from "../extractors/plugins/javascript/routes/file-routes.js";
import type { FileAnalysis } from "../types/analysis.js";

const path = (rel: string, frameworks: string[]) => inferFileBasedRoute(rel, frameworks)?.path ?? null;

describe("inferFileBasedRoute — each convention under its own framework only", () => {
  it("routes Next.js pages/ and app/ files only when the project is Next.js", () => {
    expect(path("pages/users/[id].tsx", ["nextjs", "react"])).toBe("/users/:id");
    expect(path("src/app/settings/page.tsx", ["nextjs"])).toBe("/settings");
    // A React Router app (or a Vue one) keeps page components in `pages/` too;
    // that is a folder name, not a router.
    expect(path("pages/UserEditPage.tsx", ["react", "react-router"])).toBeNull();
    expect(path("pages/UserEditPage.tsx", ["vue", "vue-router"])).toBeNull();
  });

  it("routes Nuxt pages/*.vue only when the project is Nuxt — Vue alone is not Nuxt", () => {
    expect(path("pages/users/[id].vue", ["nuxt", "vue"])).toBe("/users/:id");
    expect(path("pages/LoginPage.vue", ["vue", "vue-router"])).toBeNull();
    // ...and a Nuxt project does not get Next.js routes for its .ts files.
    expect(path("pages/helpers.ts", ["nuxt", "vue"])).toBeNull();
  });
});

describe("Next.js App Router paths", () => {
  it("serves the root page and route handler at /", () => {
    expect(path("app/page.tsx", ["nextjs"])).toBe("/");
    expect(path("src/app/page.jsx", ["nextjs"])).toBe("/");
    expect(inferFileBasedRoute("app/route.ts", ["nextjs"])).toMatchObject({ path: "/", kind: "api" });
  });

  it("leaves route groups and parallel-route slots out of the URL", () => {
    expect(path("app/(shop)/cart/page.tsx", ["nextjs"])).toBe("/cart");
    expect(path("app/(marketing)/page.tsx", ["nextjs"])).toBe("/");
    expect(path("app/dashboard/@stats/page.tsx", ["nextjs"])).toBe("/dashboard");
  });

  it("maps optional and catch-all segments", () => {
    expect(path("app/docs/[[...slug]]/page.tsx", ["nextjs"])).toBe("/docs/*");
    expect(path("pages/blog/[...slug].tsx", ["nextjs"])).toBe("/blog/*");
    expect(path("pages/shop/[[id]].tsx", ["nextjs"])).toBe("/shop/:id?");
  });

  it("keeps the pages/ router's special files out", () => {
    expect(path("pages/_app.tsx", ["nextjs"])).toBeNull();
    expect(path("pages/_document.tsx", ["nextjs"])).toBeNull();
    expect(path("pages/_error.tsx", ["nextjs"])).toBeNull();
    expect(inferFileBasedRoute("pages/api/users.ts", ["nextjs"])).toMatchObject({ path: "/api/users", kind: "api" });
  });
});

describe("Expo Router", () => {
  const file = (exports: string[] = []) =>
    ({ functions: exports.map((name, i) => ({ name, line: i + 3 })), exports: [] }) as unknown as FileAnalysis;
  const expo = (rel: string, frameworks = ["expo-router", "react-native"], exports?: string[]) =>
    inferExpoRouterRoutes(rel, file(exports), frameworks);

  it("makes every app/ component a screen at its path", () => {
    expect(expo("app/index.tsx")).toMatchObject([{ path: "/", kind: "frontend" }]);
    expect(expo("app/(tabs)/settings.tsx")).toMatchObject([{ path: "/settings", kind: "frontend" }]);
    expect(expo("app/user/[id].tsx")).toMatchObject([{ path: "/user/:id" }]);
    expect(expo("src/app/(auth)/login/index.tsx")).toMatchObject([{ path: "/login" }]);
  });

  it("skips layouts and special files", () => {
    expect(expo("app/_layout.tsx")).toEqual([]);
    expect(expo("app/(tabs)/_layout.tsx")).toEqual([]);
    expect(expo("app/+not-found.tsx")).toEqual([]);
    expect(expo("app/+html.tsx")).toEqual([]);
  });

  it("serves a +api file once per exported HTTP method", () => {
    const routes = expo("app/users/[id]+api.ts", undefined, ["GET", "DELETE", "helper"]);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.kind}`)).toEqual(["GET /users/:id api", "DELETE /users/:id api"]);
  });

  it("only in an Expo Router project, and never over Next.js's app/", () => {
    expect(expo("app/index.tsx", ["react-native"])).toEqual([]);
    expect(expo("app/page.tsx", ["expo-router", "nextjs"])).toEqual([]);
    expect(expo("components/Button.tsx")).toEqual([]);
  });
});
