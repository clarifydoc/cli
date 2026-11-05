import { describe, it, expect } from "vitest";
import { inferExpoRouterRoutes, inferFileBasedRoute, inferNextRoutes } from "../extractors/plugins/javascript/routes/file-routes.js";
import type { FileAnalysis } from "../types/analysis.js";

const path = (rel: string, frameworks: string[]) => inferFileBasedRoute(rel, frameworks)?.path ?? null;

describe("inferFileBasedRoute — each convention under its own framework only", () => {
  it("routes Next.js pages/ and app/ files only when the project is Next.js", () => {
    expect(path("pages/players/[id].tsx", ["nextjs", "react"])).toBe("/players/:id");
    expect(path("src/app/settings/page.tsx", ["nextjs"])).toBe("/settings");
    // A React Router app (or a Vue one) keeps page components in `pages/` too;
    // that is a folder name, not a router.
    expect(path("pages/PlayerEditPage.tsx", ["react", "react-router"])).toBeNull();
    expect(path("pages/PlayerEditPage.tsx", ["vue", "vue-router"])).toBeNull();
  });

  it("routes Nuxt pages/*.vue only when the project is Nuxt — Vue alone is not Nuxt", () => {
    expect(path("pages/players/[id].vue", ["nuxt", "vue"])).toBe("/players/:id");
    expect(path("pages/LoginPage.vue", ["vue", "vue-router"])).toBeNull();
    // ...and a Nuxt project does not get Next.js routes for its .ts files.
    expect(path("pages/helpers.ts", ["nuxt", "vue"])).toBeNull();
  });

  it("routes a Nuxt 4 app/pages/ tree, and a src/pages/ one", () => {
    expect(path("app/pages/g/[clubSlug]/squad.vue", ["nuxt", "vue"])).toBe("/g/:clubSlug/squad");
    expect(path("app/pages/login.vue", ["nuxt", "vue"])).toBe("/login");
    expect(path("src/pages/fixtures/index.vue", ["nuxt", "vue"])).toBe("/fixtures");
  });
});

describe("Next.js App Router paths", () => {
  it("serves the root page and route handler at /", () => {
    expect(path("app/page.tsx", ["nextjs"])).toBe("/");
    expect(path("src/app/page.jsx", ["nextjs"])).toBe("/");
    expect(inferFileBasedRoute("app/route.ts", ["nextjs"])).toMatchObject({ path: "/", kind: "api" });
  });

  it("leaves route groups and parallel-route slots out of the URL", () => {
    expect(path("app/(shop)/garage/page.tsx", ["nextjs"])).toBe("/garage");
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
    expect(inferFileBasedRoute("pages/api/players.ts", ["nextjs"])).toMatchObject({ path: "/api/players", kind: "api" });
  });
});

describe("Next.js App Router route handlers", () => {
  const file = (names: string[]) => ({ functions: names.map((name, i) => ({ name, line: i + 3 })), exports: [] }) as unknown as FileAnalysis;

  it("serves one api route per exported method handler, and one method-less row for a file exporting none", () => {
    expect(inferNextRoutes("app/api/webhooks/route.ts", file(["POST", "helper"]), ["nextjs"])).toMatchObject([{ path: "/api/webhooks", kind: "api", httpMethod: "POST", handler: "POST", line: 3 }]);
    expect(inferNextRoutes("src/app/api/players/[id]/route.ts", file(["GET", "DELETE"]), ["nextjs"]).map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /api/players/:id", "DELETE /api/players/:id"]);
    expect(inferNextRoutes("app/api/legacy/route.ts", file([]), ["nextjs"])).toMatchObject([{ path: "/api/legacy", httpMethod: null }]);
    expect(inferNextRoutes("app/players/page.tsx", file(["GET"]), ["nextjs"])).toMatchObject([{ path: "/players", kind: "frontend", httpMethod: null }]);
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
    expect(expo("app/player/[id].tsx")).toMatchObject([{ path: "/player/:id" }]);
    expect(expo("src/app/(auth)/login/index.tsx")).toMatchObject([{ path: "/login" }]);
  });

  it("skips layouts and special files", () => {
    expect(expo("app/_layout.tsx")).toEqual([]);
    expect(expo("app/(tabs)/_layout.tsx")).toEqual([]);
    expect(expo("app/+not-found.tsx")).toEqual([]);
    expect(expo("app/+html.tsx")).toEqual([]);
  });

  it("serves a +api file once per exported HTTP method", () => {
    const routes = expo("app/players/[id]+api.ts", undefined, ["GET", "DELETE", "helper"]);
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.kind}`)).toEqual(["GET /players/:id api", "DELETE /players/:id api"]);
  });

  it("only in an Expo Router project, and never over Next.js's app/", () => {
    expect(expo("app/index.tsx", ["react-native"])).toEqual([]);
    expect(expo("app/page.tsx", ["expo-router", "nextjs"])).toEqual([]);
    expect(expo("components/Button.tsx")).toEqual([]);
  });
});

describe("Remix / React Router flat routes", () => {
  it("maps a flat-routes file name to the URL it serves", async () => {
    const { flatRoutePath } = await import("../extractors/plugins/javascript/routes/file-routes.js");
    const cases: Array<[string, string]> = [
      ["_index", "/"],
      ["about", "/about"],
      ["concerts.$city", "/concerts/:city"],
      ["concerts._index", "/concerts"],
      ["concerts_.mine", "/concerts/mine"],
      ["_auth.login", "/login"],
      ["($lang).docs", "/:lang?/docs"],
      ["(en).docs", "/en?/docs"],
      ["files.$", "/files/*"],
      ["sitemap[.]xml", "/sitemap.xml"],
    ];
    for (const [name, path] of cases) expect(flatRoutePath(name), name).toBe(path);
  });

  it("reads React Router 7's route config, nested, with its pages", async () => {
    const { inferReactRouterConfig } = await import("../extractors/plugins/javascript/routes/file-routes.js");
    const src = [
      'import { index, layout, prefix, route } from "@react-router/dev/routes";',
      "export default [",
      '  index("routes/home.tsx"),',
      '  layout("routes/shell.tsx", [route("login", "routes/login.tsx")]),',
      '  ...prefix("concerts", [index("routes/c/home.tsx"), route(":city", "routes/c/city.tsx", { id: "x" })]),',
      '  route("/abs", "routes/abs.tsx", [route("child", "routes/child.tsx")]),',
      "] satisfies RouteConfig;",
    ].join("\n");
    const out = inferReactRouterConfig("app/routes.ts", src, ["react-router-framework"]);
    expect(out.routes.map((r) => [r.path, r.componentPath, r.line])).toEqual([
      ["/", "./routes/home.tsx", 3],
      ["/login", "./routes/login.tsx", 4],
      ["/concerts", "./routes/c/home.tsx", 5],
      ["/concerts/:city", "./routes/c/city.tsx", 5],
      ["/abs", "./routes/abs.tsx", 6],
      ["/abs/child", "./routes/child.tsx", 6],
    ]);
    expect(out.flatRoutes).toBe(false);
    expect(inferReactRouterConfig("app/routes.ts", src, ["react-router"]).routes).toEqual([]);
    expect(inferReactRouterConfig("app/routes.ts", "export default flatRoutes() satisfies RouteConfig;", ["react-router-framework"]).flatRoutes).toBe(true);
  });
});

describe("Next.js pages/api handlers", () => {
  it("take the default export through its middleware, one row per method its body branches on", () => {
    const src = [
      "import type { NextApiHandler } from 'next';",
      "const handler: NextApiHandler = async ({ method, query }, res) => {",
      "  switch (method) {",
      "    case 'GET': return res.json(await getSquad(query.club));",
      "    case 'POST': return res.json(await addPlayer(query.club));",
      "  }",
      "};",
      "export default withLogging(handler);",
    ].join("\n");
    const file = { functions: [{ name: "handler", line: 2, endLine: 7 }], exports: [] } as unknown as FileAnalysis;
    expect(inferNextRoutes("pages/api/squad.ts", file, ["nextjs"], src).map((r) => `${r.httpMethod} ${r.path} ${r.handler} ${r.line}`)).toEqual([
      "GET /api/squad handler 2",
      "POST /api/squad handler 2",
    ]);
    const plain = "export default async function standings(req, res) {\n  res.json([]);\n}";
    const one = { functions: [{ name: "standings", line: 1, endLine: 3 }], exports: [] } as unknown as FileAnalysis;
    expect(inferNextRoutes("pages/api/standings.ts", one, ["nextjs"], plain)).toMatchObject([{ path: "/api/standings", httpMethod: null, handler: "standings" }]);
  });
});

describe("Next.js pages/api method sets", () => {
  const rows = (rel: string, src: string, fns: Array<{ name: string; line: number; endLine: number }> = []) =>
    inferNextRoutes(rel, { functions: fns, exports: [] } as unknown as FileAnalysis, ["nextjs"], src).map((r) => `${r.httpMethod} ${r.path}`);

  it("an OPTIONS preflight guard is not what the handler serves", () => {
    const src = "export default function handler(req, res) {\n  if (req.method === 'OPTIONS') { res.status(200).end(); return; }\n  res.json([]);\n}";
    expect(rows("pages/api/clubs.ts", src, [{ name: "handler", line: 1, endLine: 4 }])).toEqual(["null /api/clubs"]);
  });

  it("a POST branch with an else serves the other methods as well", () => {
    const src = "export default function handler(req, res) {\n  if (req.method === 'POST') { res.status(201).json({}); } else { res.json([]); }\n}";
    expect(rows("pages/api/players.ts", src, [{ name: "handler", line: 1, endLine: 3 }])).toEqual(["POST /api/players", "null /api/players"]);
    const guard = "export default function handler(req, res) {\n  if (req.method !== 'POST') return res.status(405).end();\n  res.json({});\n}";
    expect(rows("pages/api/players.ts", guard, [{ name: "handler", line: 1, endLine: 4 }])).toEqual(["POST /api/players"]);
  });

  it("reads next-connect chains, wrapper tables and handler maps", () => {
    const chain = "import nc from 'next-connect';\nconst handler = nc().get(list).patch(update);\nexport default handler;";
    expect(rows("pages/api/cars.ts", chain)).toEqual(["GET /api/cars", "PATCH /api/cars"]);
    const wrapped = "import withMethods from '../../lib/m';\nexport default withMethods({ GET: list, DELETE: remove });";
    expect(rows("pages/api/trainers.ts", wrapped)).toEqual(["GET /api/trainers", "DELETE /api/trainers"]);
    const lazy = "export default defaultHandler({\n  GET: import('./_get'),\n  POST: import('./_post'),\n});";
    expect(rows("pages/api/fixtures.ts", lazy)).toEqual(["GET /api/fixtures", "POST /api/fixtures"]);
    const map = "const handlers = { GET: list, POST: add };\nexport default function h(req, res) { return handlers[req.method](req, res); }";
    expect(rows("pages/api/garages.ts", map, [{ name: "h", line: 2, endLine: 2 }])).toEqual(["GET /api/garages", "POST /api/garages"]);
  });

  it("a pages/api file with no default export is a helper, not a route", () => {
    expect(rows("pages/api/_lib/respond.ts", "export function respond(res, d) { res.json(d); }")).toEqual([]);
    expect(rows("pages/api/_get.ts", "export const getAll = (req, res) => res.json([]);")).toEqual([]);
    expect(rows("pages/api/lazy.ts", "export { handler as default } from './impl';")).toEqual(["null /api/lazy"]);
  });
});

describe("Next.js App Router private folders and interception", () => {
  it("leaves _private folders and interception segments out of the routes", () => {
    expect(path("app/cars/_parts/page.tsx", ["nextjs"])).toBeNull();
    expect(path("app/cars/_parts/deep/page.tsx", ["nextjs"])).toBeNull();
    expect(path("app/cars/(.)car/page.tsx", ["nextjs"])).toBeNull();
    expect(path("app/cars/(..)garage/[id]/page.tsx", ["nextjs"])).toBeNull();
    expect(path("app/cars/(...)garage/page.tsx", ["nextjs"])).toBeNull();
    expect(path("app/cars/[id]/page.tsx", ["nextjs"])).toBe("/cars/:id");
  });
});

