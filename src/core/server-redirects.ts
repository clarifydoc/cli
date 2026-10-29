import type { FileAnalysis, RouteInfo, SymbolLink } from "../types/analysis.js";
import { routeHandlers, type Span } from "./route-handlers.js";

/**
 * Server redirects: where a route's handler sends the browser on to —
 *
 *   res.redirect("/login")                    redirect(url_for("table"))
 *   return "redirect:/clubs";                 return RedirectToAction("Index", "Clubs");
 *   redirect_to "/garage"                     header("Location: /match/" . $id);
 *
 * A path counts when it is the literal of a call named for redirecting, a
 * Spring `redirect:` view name or a `Location` header, and starts with one
 * slash (an app path; a URL to another host is no page of the app). A name
 * counts when the redirect hands it to `url_for`/`reverse`, `RedirectToAction`
 * or an `action:` argument: it resolves to the route whose handler has that
 * name — the redirecting handler's own file first, then the one such route in
 * its sub-project, the controller named beside it when there is one. A name
 * two routes answer to resolves to nothing.
 *
 * Only the handler's own body is read (the function the route's symbol links
 * to, else the route's lines up to the next route of its file): a helper that
 * redirects for many handlers is not followed. Sets `RouteInfo.redirectsTo` on
 * API routes; returns how many routes redirect.
 */
export function attachServerRedirects(
  routes: ReadonlyArray<RouteInfo & { filePath: string; projectId?: string }>,
  analyses: readonly FileAnalysis[],
  symbolLinks: readonly SymbolLink[],
  sourceOf: (file: string) => string | undefined,
): number {
  const api = routes.filter((r) => r.kind === "api");
  if (api.length === 0) return 0;
  const handlers = routeHandlers(analyses, symbolLinks);
  const linesOf = new Map<string, string[]>();
  const lines = (file: string): string[] => {
    let l = linesOf.get(file);
    if (!l) linesOf.set(file, (l = (sourceOf(file) ?? "").split("\n")));
    return l;
  };
  // Route lines per file, to cut a body shared by several inline routes at the next one.
  const routeLines = new Map<string, number[]>();
  for (const r of api) (routeLines.get(r.filePath) ?? routeLines.set(r.filePath, []).get(r.filePath)!).push(r.line);
  for (const l of routeLines.values()) l.sort((a, b) => a - b);
  // Handler leaf name → its routes, for the redirects that name an action.
  const byHandler = new Map<string, Array<RouteInfo & { filePath: string; projectId?: string }>>();
  for (const r of api) {
    const leaf = r.handler?.split(/[.#:]/).pop();
    if (leaf) (byHandler.get(leaf) ?? byHandler.set(leaf, []).get(leaf)!).push(r);
  }

  const bodyOf = (route: RouteInfo & { filePath: string }): Array<{ file: string; text: string[] }> => {
    const out: Array<{ file: string; text: string[] }> = [];
    for (const ref of handlers.handlersOf(route)) {
      const span: Span | null = handlers.spanOf(ref);
      if (!span) continue;
      let { line, endLine } = span;
      // A function declaring several routes (an Express setup, a Sinatra file): this route's lines only.
      if (ref.file === route.filePath && line <= route.line && route.line <= endLine) {
        const others = routeLines.get(route.filePath) ?? [];
        if (others.some((l) => l !== route.line && l >= line && l <= endLine)) {
          line = route.line;
          endLine = Math.min(endLine, (others.find((l) => l > route.line) ?? endLine + 1) - 1);
        }
      }
      out.push({ file: ref.file, text: lines(ref.file).slice(line - 1, endLine) });
    }
    if (out.length === 0) {
      // No function holds it: the route's own lines, as far as its inline calls go.
      const last = Math.max(route.line, ...(route.calls ?? []).map((c) => c.line));
      out.push({ file: route.filePath, text: lines(route.filePath).slice(route.line - 1, last) });
    }
    return out;
  };

  const resolveName = (name: string, controller: string | undefined, route: RouteInfo & { filePath: string; projectId?: string }, file: string): string | null => {
    const parts = name.split(/[.:]/);
    const leaf = parts.pop()!;
    const qualifier = (controller ?? parts.join(".")).toLowerCase();
    let cands = (byHandler.get(leaf) ?? []).filter((r) => (r.projectId ?? "root") === (route.projectId ?? "root"));
    if (qualifier) {
      // `RedirectToAction("Index", "Clubs")`, `url_for("clubs.show")`: the controller or blueprint the name sits in.
      cands = cands.filter((r) => `${r.filePath} ${r.handler ?? ""}`.toLowerCase().includes(qualifier));
    } else {
      const same = cands.filter((r) => r.filePath === file || r.filePath === route.filePath);
      if (same.length > 0) cands = same;
    }
    const gets = cands.filter((r) => !r.httpMethod || r.httpMethod === "GET");
    if (gets.length > 0) cands = gets;
    const paths = new Set(cands.map((r) => r.path));
    return paths.size === 1 ? [...paths][0]! : null;
  };

  let count = 0;
  for (const route of api) {
    const out = new Set<string>();
    for (const { file, text } of bodyOf(route)) {
      for (const line of text) {
        if (!REDIRECT_LINE.test(line)) continue;
        for (const p of redirectPaths(line)) if (p !== route.path) out.add(p);
        for (const n of redirectNames(line)) {
          const p = resolveName(n.name, n.controller, route, file);
          if (p && p !== route.path) out.add(p);
        }
      }
    }
    if (out.size === 0) continue;
    route.redirectsTo = [...out];
    count++;
  }
  return count;
}

const REDIRECT_LINE = /redirect|\bLocation\b/i;
const LIT = String.raw`["'\x60]([^"'\x60\n]*)["'\x60]`;
/** The literal a call named for redirecting is handed, after a status code or a keyword (`res.redirect(302, "/x")`, `RedirectResponse(url="/x")`). */
const REDIRECT_CALL = new RegExp(String.raw`[\w.:$]*redirect[\w$]*\s*!?\s*\(\s*(?:[^()"'\x60;]{0,60}?,\s*)?(?:\w+\s*[=:]\s*)?(?:~p)?${LIT}`, "gi");
/** The same without parentheses (Ruby, Groovy): `redirect_to "/garage", notice: "…"`. */
const REDIRECT_BARE = new RegExp(String.raw`\bredirect(?:_to)?\s+${LIT}`, "g");
/** A view name that is a redirect (Spring MVC, Struts): `"redirect:/clubs"`. */
const REDIRECT_VIEW = /["'\x60]redirect:([^"'\x60\n]*)["'\x60]/g;
/** A `Location` header: `header("Location: /x")`, `setHeader("Location", "/x")`, `{ Location: "/x" }`. */
const LOCATION = /\bLocation["']?\s*[:,=]\s*["'\x60]?\s*(\/[^"'\x60\s]*)/g;

/** A literal continued by concatenation: `+`, `.`, `..`, `<>`, `&`, `~`. */
const CONCAT = /^\s*["'\x60]?\s*(?:\+|\.\.?|<>|&|~)\s*[\w$@(]/;

/** The app paths a line redirects to, with interpolations as `{}`. */
export function redirectPaths(line: string): string[] {
  const out = new Set<string>();
  for (const re of [REDIRECT_CALL, REDIRECT_BARE, REDIRECT_VIEW, LOCATION]) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      // `"/match/" . $id`, `"/clubs/" + id`: the literal is the path up to a parameter.
      const joined = CONCAT.test(line.slice(m.index! + m[0].length));
      const p = appPath(joined && m[1]!.endsWith("/") ? m[1]! + "{}" : m[1]!);
      if (p) out.add(p);
    }
  }
  return [...out];
}

/** `/clubs/${id}?tab=x` → `/clubs/{}`; null for anything that is not one app path. */
function appPath(raw: string): string | null {
  const p = raw
    .replace(/\$\{[^}]*\}|#\{[^}]*\}|\{[^}]*\}|%[sd]/g, "{}")
    .split(/[?#]/)[0]!
    .trim();
  if (!p.startsWith("/") || p.startsWith("//")) return null;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** A route named rather than spelled: `url_for("table")`, `RedirectToAction("Index", "Clubs")`, `action: "list"`. */
const NAMED = [
  /\b(?:url_for|reverse|reverse_lazy)\s*\(\s*["']([\w.:]+)["']/g,
  /\bRedirectToAction\s*\(\s*(?:"(\w+)"|nameof\(\s*(?:\w+\.)*(\w+)\s*\))(?:\s*,\s*(?:"(\w+)"|nameof\(\s*(\w+)\s*\)))?/g,
  /\baction\s*(?::|=>|=)\s*[:"']?(\w+)/g,
];
const CONTROLLER_ARG = /\bcontroller\s*(?::|=>|=)\s*[:"']?(\w+)/;

export function redirectNames(line: string): Array<{ name: string; controller?: string }> {
  const out: Array<{ name: string; controller?: string }> = [];
  const keyed = CONTROLLER_ARG.exec(line)?.[1];
  for (const re of NAMED) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      const name = m[1] ?? m[2];
      if (!name) continue;
      const controller = (m[3] ?? m[4] ?? (re === NAMED[2] ? keyed : undefined))?.replace(/Controller$/, "");
      out.push(controller ? { name, controller } : { name });
    }
  }
  return out;
}
