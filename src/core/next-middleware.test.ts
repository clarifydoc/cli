import { describe, it, expect } from "vitest";
import { inferNextMiddlewareFacts, matcherCovers, nextMiddlewareGuards, readMatchers } from "../extractors/plugins/javascript/routes/next-middleware.js";
import { inferFileBasedRoute } from "../extractors/plugins/javascript/routes/file-routes.js";
import type { FileAnalysis, RouteInfo } from "../types/analysis.js";
import type { ProjectContext } from "../types/project.js";

const NEXT = ["nextjs", "react"];

const sessionGate = (config: string) => `
import { NextResponse } from 'next/server';
export function middleware(req) {
  if (!req.cookies.get('session')) return NextResponse.redirect(new URL('/login', req.url));
  return NextResponse.next();
}
${config}
`;

const headerOnly = `
import { NextResponse } from 'next/server';
export function middleware(req) {
  const res = NextResponse.next();
  res.headers.set('x-club', 'north');
  return res;
}
export const config = { matcher: ['/dashboard/:path*'] };
`;

/** The project-relative path of a file in a sub-project named by its first folder. */
const within = (filePath: string, projectId?: string) => (projectId ? filePath.slice(projectId.length + 1) : filePath);

function page(filePath: string, projectId?: string): FileAnalysis {
  const r = inferFileBasedRoute(within(filePath, projectId), ["nextjs"])!;
  const route: RouteInfo = { path: r.path, httpMethod: null, kind: r.kind, handler: null, calls: [], middleware: [], line: 1 };
  return { filePath, language: "typescript", projectId, routes: [route], routeFacts: [] } as unknown as FileAnalysis;
}

function middlewareFile(filePath: string, source: string, projectId?: string): FileAnalysis {
  const facts = inferNextMiddlewareFacts(within(filePath, projectId), source, NEXT);
  return { filePath, language: "typescript", projectId, routes: [], routeFacts: facts } as unknown as FileAnalysis;
}

const ctx = { projectRootOf: (id: string) => id } as unknown as ProjectContext;
const guarded = (a: FileAnalysis) => a.routes[0]!.middleware;

describe("readMatchers", () => {
  it("reads a string, an array, and { source } objects; a conditional one is left out", () => {
    expect(readMatchers(`export const config = { matcher: '/dashboard/:path*' }`)).toEqual(["/dashboard/:path*"]);
    expect(readMatchers(`export const config = { matcher: ['/a', "/b/:id"] }`)).toEqual(["/a", "/b/:id"]);
    expect(readMatchers(`export const config = { matcher: [{ source: '/a' }, { source: '/b', has: [{ type: 'header', key: 'x' }] }] }`)).toEqual(["/a"]);
    expect(readMatchers(`export const middleware = () => {}`)).toBeNull();
    expect(readMatchers(`export const config = { matcher: routes }`)).toBeUndefined();
  });
});

describe("matcherCovers", () => {
  it("follows path-to-regexp forms", () => {
    expect(matcherCovers(["/dashboard/:path*"], "/dashboard")).toBe(true);
    expect(matcherCovers(["/dashboard/:path*"], "/dashboard/clubs/:id")).toBe(true);
    expect(matcherCovers(["/dashboard/:path*"], "/about")).toBe(false);
    expect(matcherCovers(["/api/:path+"], "/api")).toBe(false);
    expect(matcherCovers(["/api/:path+"], "/api/clubs")).toBe(true);
    expect(matcherCovers(["/clubs/:id"], "/clubs/:id")).toBe(true);
    expect(matcherCovers(["/dashboard"], "/dashboard/clubs")).toBe(false);
  });
  it("follows a negative-lookahead catch-all", () => {
    const m = ["/((?!api|_next/static|_next/image|favicon.ico).*)"];
    expect(matcherCovers(m, "/")).toBe(true);
    expect(matcherCovers(m, "/squad/:id")).toBe(true);
    expect(matcherCovers(m, "/api/clubs")).toBe(false);
  });
  it("covers everything without a matcher", () => expect(matcherCovers(null, "/x")).toBe(true));
});

describe("Next.js middleware as a guard", () => {
  it("guards the pages and handlers the matcher covers, and not the rest", () => {
    const mw = middlewareFile("middleware.ts", sessionGate(`export const config = { matcher: ['/dashboard/:path*', '/api/:path*'] };`));
    const dash = page("app/dashboard/page.tsx");
    const api = page("app/api/clubs/route.ts");
    const about = page("app/about/page.tsx");
    nextMiddlewareGuards.resolve([mw, dash, api, about], ctx);
    expect(guarded(dash)).toEqual(["middleware.ts"]);
    expect(guarded(api)).toEqual(["middleware.ts"]);
    expect(guarded(about)).toEqual([]);
    expect(dash.routes[0]!.auth).toMatchObject({ anonymous: false });
  });

  it("covers every route when the config has no matcher, and works from src/", () => {
    const mw = middlewareFile("src/middleware.ts", sessionGate(""));
    const p = page("src/pages/squad.tsx");
    nextMiddlewareGuards.resolve([mw, p], ctx);
    expect(guarded(p)).toEqual(["middleware.ts"]);
  });

  it("is no guard when the middleware only sets headers", () => {
    expect(inferNextMiddlewareFacts("middleware.ts", headerOnly, NEXT)).toEqual([]);
    const mw = middlewareFile("middleware.ts", headerOnly);
    const dash = page("app/dashboard/page.tsx");
    nextMiddlewareGuards.resolve([mw, dash], ctx);
    expect(guarded(dash)).toEqual([]);
  });

  it("takes a guard-named middleware and a library wrapper as guards", () => {
    expect(inferNextMiddlewareFacts("middleware.ts", `export default function requireLogin(req) { return x; }`, NEXT)).toHaveLength(1);
    expect(inferNextMiddlewareFacts("proxy.ts", `export { default } from "next-auth/middleware";`, NEXT)).toHaveLength(1);
  });

  it("guards nothing when the matcher cannot be read, or the project is not Next.js", () => {
    expect(inferNextMiddlewareFacts("middleware.ts", sessionGate(`export const config = { matcher: routes };`), NEXT)).toEqual([]);
    expect(inferNextMiddlewareFacts("middleware.ts", sessionGate(""), ["react"])).toEqual([]);
  });

  it("applies a root middleware to root routes only, a src/ one to src/ routes", () => {
    const mw = middlewareFile("middleware.ts", sessionGate(""));
    const inSrc = page("src/app/squad/page.tsx");
    nextMiddlewareGuards.resolve([mw, inSrc], ctx);
    expect(guarded(inSrc)).toEqual([]);
  });

  it("does not leak into another sub-project", () => {
    const mw = middlewareFile("clubs-web/middleware.ts", sessionGate(`export const config = { matcher: ['/dashboard/:path*'] };`), "clubs-web");
    const own = page("clubs-web/app/dashboard/page.tsx", "clubs-web");
    const other = page("fixtures-web/app/dashboard/page.tsx", "fixtures-web");
    nextMiddlewareGuards.resolve([mw, own, other], ctx);
    expect(guarded(own)).toEqual(["middleware.ts"]);
    expect(guarded(other)).toEqual([]);
  });
});
