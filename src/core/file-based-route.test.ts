import { describe, it, expect } from "vitest";
import { inferFileBasedRoute } from "./file-analyzer.js";

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
