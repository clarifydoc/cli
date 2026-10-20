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
 * Next.js routes with the file's handlers read: an App Router `route.ts`
 * serves one `api` route per exported HTTP-method handler (`export async
 * function POST`), as SvelteKit's `+server.ts` does; one exporting none keeps
 * the single method-less row.
 */
export function inferNextRoutes(relativePath: string, analysis: FileAnalysis, frameworkIds: string[]): RouteInfo[] {
  const r = inferFileBasedRoute(relativePath, frameworkIds);
  if (!r) return [];
  if (r.kind === "api" && /(?:^|\/)route\.(?:tsx?|jsx?)$/.test(relativePath.replace(/\\/g, "/"))) {
    const handlers = methodRoutes(r.path, analysis);
    if (handlers.length > 0) return handlers;
  }
  return [r];
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

/** A flat-routes file name split at its unescaped dots: `concerts.$city`, `sitemap[.]xml`. */
function flatSegments(name: string): Array<{ text: string; literal: boolean }> {
  const out: Array<{ text: string; literal: boolean }> = [];
  let cur = "";
  let escaped = false;
  let anyEscape = false;
  for (const ch of name) {
    if (ch === "[" && !escaped) {
      escaped = true;
      anyEscape = true;
    } else if (ch === "]" && escaped) escaped = false;
    else if (ch === "." && !escaped) {
      out.push({ text: cur, literal: anyEscape });
      cur = "";
      anyEscape = false;
    } else cur += ch;
  }
  out.push({ text: cur, literal: anyEscape });
  return out;
}

/**
 * The URL a flat-routes module serves (Remix v2, React Router 7's
 * `flatRoutes()`): dots are slashes, `_index` is its parent's index, a
 * `_name` segment is a pathless layout, a trailing `_` leaves its layout but
 * not the path, `$id` is `:id`, `($lang)` is `:lang?`, a lone `$` the splat,
 * `[.]` escapes. Exported for unit tests.
 */
export function flatRoutePath(name: string): string {
  const parts: string[] = [];
  for (const { text, literal } of flatSegments(name)) {
    if (literal) {
      parts.push(text);
      continue;
    }
    if (text === "_index" || text === "index") continue;
    if (text.startsWith("_")) continue;
    const s = text.endsWith("_") ? text.slice(0, -1) : text;
    if (s === "$") parts.push("*");
    else if (/^\(\$(\w+)\)$/.test(s)) parts.push(`:${s.slice(2, -1)}?`);
    else if (/^\((\w[\w-]*)\)$/.test(s)) parts.push(`${s.slice(1, -1)}?`);
    else if (s.startsWith("$")) parts.push(`:${s.slice(1)}`);
    else if (s) parts.push(s);
  }
  return "/" + parts.join("/");
}

/**
 * Remix v2 flat routes under `app/routes/` (and React Router 7 framework
 * mode when its `app/routes.ts` delegates to `flatRoutes()`): a module with a
 * default export is a page; one without is a resource route — its `loader`
 * serves GET, its `action` the other methods (as POST). A folder holds a
 * route in its `route.tsx`; any other file in a folder is a module, not a route.
 */
export function inferFlatRoutes(relativePath: string, analysis: FileAnalysis, frameworkIds: string[], opts: { flatRoutes?: boolean } = {}): RouteInfo[] {
  const applies = frameworkIds.includes("remix") || (frameworkIds.includes("react-router-framework") && opts.flatRoutes === true);
  if (!applies) return [];
  const normalized = relativePath.replace(/\\/g, "/");
  // `app/` by default; React Router's `appDirectory` is often `src/`.
  const m = normalized.match(/^(?:app|src)\/routes\/(.+)\.(?:tsx?|jsx?|mdx?)$/);
  if (!m) return [];
  let name = m[1]!;
  if (name.includes("/")) {
    const folder = name.match(/^([^/]+)\/route$/);
    if (!folder) return [];
    name = folder[1]!;
  }
  // A pathless layout (`_auth`) wraps its children and has no URL of its own.
  const last = flatSegments(name).at(-1)!;
  if (!last.literal && last.text.startsWith("_") && last.text !== "_index") return [];
  const path = flatRoutePath(name);
  const exported = (n: string) => analysis.exports.some((e) => e.name === n) || analysis.functions.some((f) => f.name === n && f.isExported !== false);
  const hasDefault = analysis.exports.some((e) => e.kind === "default" || e.name === "default");
  if (hasDefault) return [route(path, "frontend", { componentPath: null })];
  const line = (n: string) => analysis.functions.find((f) => f.name === n)?.line ?? 1;
  return [
    ...(exported("loader") ? [route(path, "api", { httpMethod: "GET", handler: "loader", line: line("loader") })] : []),
    ...(exported("action") ? [route(path, "api", { httpMethod: "POST", handler: "action", line: line("action") })] : []),
  ];
}

/** A string literal at `i` (after whitespace): its value and where it ends, or null. */
function stringAt(text: string, i: number): { value: string; end: number } | null {
  const m = /^\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/.exec(text.slice(i));
  return m ? { value: m[2]!, end: i + m[0].length } : null;
}

/**
 * React Router 7 framework mode's route config (`app/routes.ts`): `route(path,
 * file, children?)`, `index(file)`, `layout(file, children)` and `...prefix(path,
 * children)`, nested — each a page route at the call's line, its module as
 * the component. `flatRoutes()` there says the folder convention applies too
 * (`inferFlatRoutes`). Read off the text: the config is one literal array.
 */
export function inferReactRouterConfig(relativePath: string, sourceText: string, frameworkIds: string[]): { routes: RouteInfo[]; flatRoutes: boolean } {
  const none = { routes: [], flatRoutes: false };
  if (!frameworkIds.includes("react-router-framework")) return none;
  if (!/^(?:app|src)\/routes\.(?:ts|js|mts|mjs)$/.test(relativePath.replace(/\\/g, "/"))) return none;
  const flatRoutes = /\bflatRoutes\s*\(/.test(sourceText);
  const lineAt = (i: number) => sourceText.slice(0, i).split("\n").length;
  const join = (base: string, p: string) => (p.startsWith("/") ? p : `${base.replace(/\/$/, "")}/${p}`).replace(/\/+/g, "/") || "/";
  const routes: RouteInfo[] = [];

  /** Parse the array whose `[` is at `open` under `base`; returns the index after its `]`. */
  const parseList = (open: number, base: string): number => {
    let i = open + 1;
    while (i < sourceText.length) {
      const rest = sourceText.slice(i);
      const ws = /^[\s,]*(?:\/\/[^\n]*\n[\s,]*|\/\*[\s\S]*?\*\/[\s,]*)*/.exec(rest)![0].length;
      i += ws;
      if (sourceText[i] === "]") return i + 1;
      const call = /^(?:\.\.\.\s*)?(?:await\s+)?(route|index|layout|prefix|flatRoutes)\s*\(/.exec(sourceText.slice(i));
      if (!call) {
        // Something else (a spread of a variable, a comment): skip one balanced item.
        let depth = 0;
        for (; i < sourceText.length; i++) {
          const ch = sourceText[i];
          if (ch === "(" || ch === "[" || ch === "{") depth++;
          else if (ch === ")" || ch === "]" || ch === "}") {
            if (depth === 0) break;
            depth--;
          } else if (ch === "," && depth === 0) break;
        }
        if (sourceText[i] === "]") return i + 1;
        i++;
        continue;
      }
      const kind = call[1]!;
      const at = i;
      let j = i + call[0].length;
      const args: Array<{ value: string } | { list: number }> = [];
      // Read the call's arguments: strings, arrays (children), objects (options, skipped).
      for (;;) {
        const s = stringAt(sourceText, j);
        if (s) {
          args.push({ value: s.value });
          j = s.end;
        } else {
          const k = j + /^\s*/.exec(sourceText.slice(j))![0].length;
          const ch = sourceText[k];
          if (ch === "[") {
            args.push({ list: k });
            j = k;
            break;
          } else if (ch === "{") {
            let depth = 0;
            let q = k;
            for (; q < sourceText.length; q++) {
              if (sourceText[q] === "{") depth++;
              else if (sourceText[q] === "}" && --depth === 0) break;
            }
            j = q + 1;
          } else if (ch === ")") {
            j = k + 1;
            break;
          } else if (ch === ",") j = k + 1;
          else {
            j = k + 1;
            if (k >= sourceText.length) break;
          }
        }
        const k = j + /^\s*,?\s*/.exec(sourceText.slice(j))![0].length;
        if (sourceText[k] === ")") {
          j = k + 1;
          break;
        }
        j = k;
      }
      const strs = args.filter((a): a is { value: string } => "value" in a).map((a) => a.value);
      const list = args.find((a): a is { list: number } => "list" in a);
      const page = (path: string, file: string | undefined) => {
        if (file) routes.push(route(path, "frontend", { componentPath: `./${file.replace(/^\.\//, "")}`, line: lineAt(at) }));
      };
      let childBase = base;
      if (kind === "route") {
        childBase = join(base, strs[0] ?? "");
        page(childBase, strs[1]);
      } else if (kind === "index") page(base, strs[0]);
      else if (kind === "layout") page(base, undefined);
      else if (kind === "prefix") childBase = join(base, strs[0] ?? "");
      i = list ? parseList(list.list, childBase) : j;
      // Close the call around the children.
      const close = /^\s*\)/.exec(sourceText.slice(i));
      if (list && close) i += close[0].length;
    }
    return i;
  };

  const start = sourceText.search(/export\s+default\s*\[/);
  if (start < 0) return { routes, flatRoutes };
  parseList(sourceText.indexOf("[", start), "/");
  return { routes, flatRoutes };
}
