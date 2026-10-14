import type { FileAnalysis, RouteInfo } from "../../../../types/analysis.js";

/**
 * Routes that a meta-framework derives from where a file sits rather than from
 * a route table in code: Next.js (`pages/`, `app/`), Nuxt (`pages/`), SvelteKit
 * (`src/routes/`) and Expo Router (`app/`). Each convention runs only under its
 * own framework — a `pages/` folder in a React Router or plain Vue app is a
 * folder name, not a router.
 *
 * Per file and path-only (SvelteKit and Expo API routes also read the file's
 * exported HTTP-method handlers). Directory routers configured in a Vite
 * config (`unplugin-vue-router`, `vite-plugin-pages`) are a project-level pass:
 * `file-based.ts`.
 */

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function route(path: string, kind: "frontend" | "api", extra: Partial<RouteInfo> = {}): RouteInfo {
  return { path, httpMethod: null, kind, handler: null, calls: [], middleware: [], line: 1, ...extra };
}

/**
 * A route directory (`users/[id]`, `(shop)/cart`, `blog/[[...slug]]`) as the
 * URL it serves. Shared by every convention here, which agree on the brackets:
 *   - `(group)` folders organize files and are not in the URL;
 *   - `@slot` folders (Next.js parallel routes) render into a parent, not a URL;
 *   - a trailing `index` is its parent's path;
 *   - `[[...x]]` / `[...x]` → `*`, `[[x]]` → `:x?`, `[x]` → `:x`.
 */
export function routeFromSegments(dir: string): string {
  const segments = dir
    .split("/")
    .filter((s) => s.length > 0 && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
  if (segments[segments.length - 1] === "index") segments.pop();
  const mapped = segments.map((s) =>
    s
      .replace(/\[\[\.\.\.(\w+)\]\]/g, "*")
      .replace(/\[\.\.\.(\w+)\]/g, "*")
      .replace(/\[\[(\w+)\]\]/g, ":$1?")
      .replace(/\[(\w+)\]/g, ":$1"),
  );
  return "/" + mapped.join("/");
}

/** The exported HTTP-method handlers of a file (`export function GET`, `export const POST = …`). */
function exportedMethods(analysis: FileAnalysis): string[] {
  const methods = new Set<string>();
  for (const fn of analysis.functions) if (HTTP_METHODS.has(fn.name)) methods.add(fn.name);
  for (const exp of analysis.exports) if (HTTP_METHODS.has(exp.name)) methods.add(exp.name);
  return [...methods];
}

function methodRoutes(path: string, analysis: FileAnalysis): RouteInfo[] {
  return exportedMethods(analysis).map((method) =>
    route(path, "api", {
      httpMethod: method,
      handler: method,
      line: analysis.functions.find((f) => f.name === method)?.line ?? 1,
    }),
  );
}

/**
 * Next.js or Nuxt: the route a page or route-handler file serves, or null.
 * Exported for unit tests.
 */
export function inferFileBasedRoute(relativePath: string, frameworkIds: string[]): RouteInfo | null {
  const isNextjs = frameworkIds.includes("nextjs");
  const isNuxt = frameworkIds.includes("nuxt");
  if (!isNextjs && !isNuxt) return null;
  const normalized = relativePath.replace(/\\/g, "/");

  if (isNuxt) {
    const page = normalized.match(/^pages\/(.+)\.vue$/);
    if (page) return route(routeFromSegments(page[1]!), "frontend");
  }
  if (!isNextjs) return null;

  // pages/ router: every file is a page, `pages/api/**` an API route.
  const pages = normalized.match(/^(?:src\/)?pages\/(.+)\.(?:tsx?|jsx?)$/);
  if (pages) {
    const file = pages[1]!;
    if (/(?:^|\/)_(?:app|document|error)$/.test(file)) return null;
    const path = routeFromSegments(file);
    if (path === "/api") return null;
    return route(path, path.startsWith("/api/") ? "api" : "frontend");
  }

  // app/ router: a folder is a URL segment; `page` renders it, `route` handles requests.
  const app = normalized.match(/^(?:src\/)?app\/(?:(.+)\/)?(page|route)\.(?:tsx?|jsx?)$/);
  if (app) return route(routeFromSegments(app[1] ?? ""), app[2] === "page" ? "frontend" : "api");

  return null;
}

/**
 * SvelteKit under `src/routes/`: `+page.svelte` is a page; `+server.ts` is an
 * endpoint with one `api` route per exported HTTP-method handler.
 */
export function inferSvelteKitRoutes(relativePath: string, analysis: FileAnalysis, frameworkIds: string[]): RouteInfo[] {
  if (!frameworkIds.includes("sveltekit")) return [];
  const normalized = relativePath.replace(/\\/g, "/");

  const page = normalized.match(/^(?:src\/)?routes\/(.*)\+page\.svelte$/);
  if (page) return [route(routeFromSegments(page[1]!), "frontend", { componentPath: null })];

  const server = normalized.match(/^(?:src\/)?routes\/(.*)\+server\.(?:tsx?|jsx?)$/);
  if (server) return methodRoutes(routeFromSegments(server[1]!), analysis);

  return [];
}

/**
 * Expo Router under `app/` (or `src/app/`): every component file is a screen at
 * its path — `(group)` folders and `index` dropped, brackets as in Next.js.
 * `_layout` files wrap a folder's screens and `+not-found` / `+html` are
 * special files, so none is a route. `name+api.ts` is an API route serving
 * `/name`, one per exported HTTP-method handler.
 *
 * Not applied in a Next.js project, whose `app/` means its own router.
 */
export function inferExpoRouterRoutes(relativePath: string, analysis: FileAnalysis, frameworkIds: string[]): RouteInfo[] {
  if (!frameworkIds.includes("expo-router") || frameworkIds.includes("nextjs")) return [];
  const normalized = relativePath.replace(/\\/g, "/");
  const m = normalized.match(/^(?:src\/)?app\/(.+)\.(?:tsx?|jsx?)$/);
  if (!m) return [];
  const file = m[1]!;
  const base = file.slice(file.lastIndexOf("/") + 1);

  const api = file.match(/^(.*)\+api$/);
  if (api) return methodRoutes(routeFromSegments(api[1]!), analysis);
  if (base.startsWith("_") || base.startsWith("+")) return [];
  return [route(routeFromSegments(file), "frontend", { componentPath: null })];
}
