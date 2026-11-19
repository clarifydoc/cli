import { describe, it, expect } from "vitest";
import { inferAstroMiddlewareFacts, astroMiddlewareGuards } from "../extractors/plugins/javascript/routes/astro-middleware.js";
import { inferAstroRoutes } from "../extractors/plugins/javascript/routes/file-routes.js";
import type { FileAnalysis, RouteInfo } from "../types/analysis.js";
import type { ProjectContext } from "../types/project.js";

const ASTRO = ["astro"];

const sessionGate = `
import { defineMiddleware } from 'astro:middleware';
export const onRequest = defineMiddleware(async (context, next) => {
  if (!context.cookies.get('session')) return context.redirect('/login');
  return next();
});
`;

const headerOnly = `
import { defineMiddleware } from 'astro:middleware';
export const onRequest = defineMiddleware(async (context, next) => {
  const res = await next();
  res.headers.set('x-club', 'north');
  return res;
});
`;

const decoyOnRequest = `
export function onRequest(req: any, reply: any, done: () => void) {
  if (!req.cookies?.session) return reply.redirect('/login');
  done();
}
`;

/** The project-relative path of a file in a sub-project named by its first folder. */
const within = (filePath: string, projectId?: string) => (projectId ? filePath.slice(projectId.length + 1) : filePath);

function page(filePath: string, projectId?: string, methods: string[] = []): FileAnalysis {
  const rel = within(filePath, projectId);
  const functions = methods.map((name) => ({
    name,
    params: [],
    returnType: null,
    isAsync: true,
    isExported: true,
    decorators: [],
    calls: [],
    line: 1,
  }));
  const exports = methods.map((name) => ({ name, kind: "named" as const, line: 1 }));
  const shell = { functions, exports, routes: [] } as unknown as FileAnalysis;
  const routes = inferAstroRoutes(rel, shell, ASTRO);
  return { filePath, language: "typescript", projectId, functions, exports, routes: routes.map((r): RouteInfo => ({ ...r })), routeFacts: [] } as unknown as FileAnalysis;
}

function middlewareFile(filePath: string, source: string, projectId?: string): FileAnalysis {
  const facts = inferAstroMiddlewareFacts(within(filePath, projectId), source, ASTRO);
  return { filePath, language: "typescript", projectId, routes: [], routeFacts: facts } as unknown as FileAnalysis;
}

const ctx = { projectRootOf: (id: string) => id } as unknown as ProjectContext;
const guarded = (a: FileAnalysis) => a.routes[0]?.middleware ?? [];

describe("Astro onRequest middleware as a guard", () => {
  it("emits a fact only for src/middleware that checks the caller", () => {
    expect(inferAstroMiddlewareFacts("src/middleware.ts", sessionGate, ASTRO)).toHaveLength(1);
    expect(inferAstroMiddlewareFacts("src/middleware/index.ts", sessionGate, ASTRO)).toHaveLength(1);
    expect(inferAstroMiddlewareFacts("src/middleware.ts", headerOnly, ASTRO)).toEqual([]);
    expect(inferAstroMiddlewareFacts("src/lib/garage.ts", decoyOnRequest, ASTRO)).toEqual([]);
    expect(inferAstroMiddlewareFacts("src/middleware.ts", sessionGate, ["react"])).toEqual([]);
  });

  it("takes sequence(requireAuth) and onRequest = requireLogin as guards by name", () => {
    expect(
      inferAstroMiddlewareFacts(
        "src/middleware.ts",
        `import { sequence } from 'astro:middleware';\nexport const onRequest = sequence(requireAuth, trackVisit);\n`,
        ASTRO,
      ),
    ).toHaveLength(1);
    expect(
      inferAstroMiddlewareFacts("src/middleware.ts", `export const onRequest = requireLogin;\n`, ASTRO),
    ).toHaveLength(1);
    expect(
      inferAstroMiddlewareFacts(
        "src/middleware.ts",
        `import { sequence } from 'astro:middleware';\nexport const onRequest = sequence(trackVisit, setLocale);\n`,
        ASTRO,
      ),
    ).toEqual([]);
  });

  it("guards every Astro page and endpoint of the same sub-project", () => {
    const mw = middlewareFile("src/middleware.ts", sessionGate);
    const clubs = page("src/pages/clubs.astro");
    const about = page("src/pages/about.astro");
    const api = page("src/pages/api/garages.ts", undefined, ["GET"]);
    astroMiddlewareGuards.resolve([mw, clubs, about, api], ctx);
    expect(guarded(clubs)).toEqual(["onRequest"]);
    expect(guarded(about)).toEqual(["onRequest"]);
    expect(guarded(api)).toEqual(["onRequest"]);
    expect(clubs.routes[0]!.auth).toMatchObject({ anonymous: false });
  });

  it("is no guard when the middleware only sets headers", () => {
    const mw = middlewareFile("src/middleware.ts", headerOnly);
    const clubs = page("src/pages/clubs.astro");
    astroMiddlewareGuards.resolve([mw, clubs], ctx);
    expect(guarded(clubs)).toEqual([]);
  });

  it("does not apply a decoy onRequest outside src/middleware", () => {
    const decoy = middlewareFile("src/lib/garage.ts", decoyOnRequest);
    const clubs = page("src/pages/clubs.astro");
    astroMiddlewareGuards.resolve([decoy, clubs], ctx);
    expect(guarded(clubs)).toEqual([]);
    expect(decoy.routeFacts).toEqual([]);
  });

  it("does not leak into another sub-project", () => {
    const mw = middlewareFile("clubs-web/src/middleware.ts", sessionGate, "clubs-web");
    const own = page("clubs-web/src/pages/clubs.astro", "clubs-web");
    const other = page("fixtures-web/src/pages/clubs.astro", "fixtures-web");
    astroMiddlewareGuards.resolve([mw, own, other], ctx);
    expect(guarded(own)).toEqual(["onRequest"]);
    expect(guarded(other)).toEqual([]);
  });

  it("does not guard a non-Astro page file", () => {
    const mw = middlewareFile("src/middleware.ts", sessionGate);
    const vue = {
      filePath: "src/pages/clubs.vue",
      language: "typescript",
      routes: [{ path: "/clubs", httpMethod: null, kind: "frontend", handler: null, calls: [], middleware: [], line: 1 }],
      routeFacts: [],
    } as unknown as FileAnalysis;
    astroMiddlewareGuards.resolve([mw, vue], ctx);
    expect(guarded(vue)).toEqual([]);
  });
});
