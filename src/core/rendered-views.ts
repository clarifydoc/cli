import type { FileAnalysis, RouteInfo, ScreenInfo, SymbolLink } from "../types/analysis.js";

/**
 * Server-rendered pages: a route handler that renders a template by name
 * makes that template's screen the page the route serves —
 *
 *   #[get("/clubs/overview")]
 *   fn clubs_overview() -> Html<String> { render_page("admin/clubs", data) }   // → templates/admin/clubs.hbs
 *   return render_template("league/table.html", rows=rows)                     // → templates/league/table.html
 *   return "garage/list";                                                      // → WEB-INF/views/garage/list.jsp
 *
 * A literal counts when it is the first string argument of a call whose name
 * says it renders (`render`, `template`, `view`, `html`, `page`), the value of
 * a field or key so named (`"page_content": "admin/login"`, `template_name =
 * "x.html"`), or a returned string — and only when it names exactly one
 * template screen by path suffix (`resolveViewBySuffix`'s rule: compound
 * extensions such as `.html.erb` are never part of the name). The handler is
 * the function the route's synthetic symbol links to (else the function at the
 * route's line), and the functions it calls two deep: a helper that renders
 * for several handlers is common, and the nearest render wins.
 *
 * Sets `ScreenInfo.routePath` where the screen had none and records the route
 * in `ScreenInfo.renderedBy`, which the data-flow pass reads: the page shows
 * what its route loaded. Returns how many routes now render a screen.
 */
export function linkRenderedViews(
  routes: ReadonlyArray<RouteInfo & { filePath: string }>,
  analyses: readonly FileAnalysis[],
  screens: ScreenInfo[],
  symbolLinks: readonly SymbolLink[],
  sourceOf: (file: string) => string | undefined,
): number {
  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
  const pages = screens.filter((s) => byPath.has(s.filePath));
  if (pages.length === 0) return 0;

  const linksFrom = new Map<string, SymbolLink[]>();
  for (const l of symbolLinks) {
    const k = `${l.sourceFile}\0${l.sourceSymbol}`;
    (linksFrom.get(k) ?? linksFrom.set(k, []).get(k)!).push(l);
  }
  const fnSymbol = (a: FileAnalysis, line: number): { symbol: string; line: number; endLine: number } | null => {
    let best: { symbol: string; line: number; endLine: number } | null = null;
    const consider = (symbol: string, f: { line: number; endLine: number }) => {
      if (f.line <= line && line <= f.endLine && (!best || f.line >= best.line)) best = { symbol, line: f.line, endLine: f.endLine };
    };
    for (const f of a.functions) consider(f.name, f);
    for (const c of a.classes) for (const m of c.methods) consider(`${c.name}.${m.name}`, m);
    return best;
  };
  const spanOf = (file: string, symbol: string): { line: number; endLine: number } | null => {
    const a = byPath.get(file);
    if (!a) return null;
    const dot = symbol.lastIndexOf(".");
    if (dot > 0) {
      const m = a.classes.find((c) => c.name === symbol.slice(0, dot))?.methods.find((x) => x.name === symbol.slice(dot + 1));
      if (m) return m;
    }
    return a.functions.find((f) => f.name === symbol) ?? null;
  };

  const viewsCache = new Map<string, string[]>();
  const viewsIn = (file: string, span: { line: number; endLine: number }): string[] => {
    const key = `${file}\0${span.line}`;
    const hit = viewsCache.get(key);
    if (hit) return hit;
    const text = sourceOf(file)?.split("\n").slice(span.line - 1, span.endLine).join("\n") ?? "";
    const out = text ? viewLiterals(text) : [];
    viewsCache.set(key, out);
    return out;
  };

  const resolveCache = new Map<string, ScreenInfo | null>();
  const resolve = (view: string, from: FileAnalysis): ScreenInfo | null => {
    const key = `${view}\0${from.projectId ?? ""}\0${from.language}`;
    if (resolveCache.has(key)) return resolveCache.get(key)!;
    const rel = view.replace(/\\/g, "/").replace(/^\.?\/+/, "");
    const escaped = rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = /\.\w+$/.test(rel) ? new RegExp(`(^|/)${escaped}$`) : new RegExp(`(^|/)${escaped}(\\.\\w+)+$`);
    // A template is another language's file: the handler's own sources are code.
    let hits = pages.filter((s) => re.test(s.filePath) && byPath.get(s.filePath)!.language !== from.language);
    if (hits.length > 1) {
      const same = hits.filter((s) => byPath.get(s.filePath)!.projectId === from.projectId);
      if (same.length > 0) hits = same;
    }
    const files = new Set(hits.map((s) => s.filePath));
    const out = files.size === 1 ? hits[0]! : null;
    resolveCache.set(key, out);
    return out;
  };

  let linked = 0;
  for (const route of routes) {
    // A page is what a GET serves: a POST that renders does so to re-show a form or an error.
    if (route.kind !== "api" || (route.httpMethod && route.httpMethod !== "GET")) continue;
    const a = byPath.get(route.filePath);
    if (!a) continue;
    // The handler: what the route's synthetic symbol dispatches to, else the function at its line.
    let frontier: Array<{ file: string; symbol: string }> = (linksFrom.get(`${route.filePath}\0route:${route.httpMethod ?? "USE"} ${route.path}`) ?? []).map((l) => ({
      file: l.targetFile,
      symbol: l.targetSymbol,
    }));
    // Two routes at one method and path (Rocket ranks) share the synthetic symbol: the route's own handler picks.
    const own = route.handler ? frontier.filter((f) => f.symbol.split(".").pop() === route.handler!.split(/[.#:]/).pop()) : [];
    if (own.length > 0) frontier = own;
    if (frontier.length === 0) {
      const at = fnSymbol(a, route.line);
      if (at) frontier = [{ file: route.filePath, symbol: at.symbol }];
    }
    const seen = new Set<string>();
    let screen: ScreenInfo | null = null;
    for (let depth = 0; depth < 3 && frontier.length > 0 && !screen; depth++) {
      const found = new Set<ScreenInfo>();
      const next: Array<{ file: string; symbol: string }> = [];
      for (const { file, symbol } of frontier) {
        const k = `${file}\0${symbol}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const span = spanOf(file, symbol);
        const from = byPath.get(file);
        if (!span || !from) continue;
        for (const v of viewsIn(file, span)) {
          const s = resolve(v, from);
          if (s) found.add(s);
        }
        for (const l of linksFrom.get(k) ?? []) next.push({ file: l.targetFile, symbol: l.targetSymbol });
      }
      // One page per route: a handler that renders several (an error page beside the normal one) names none.
      if (found.size === 1) screen = [...found][0]!;
      else if (found.size > 1) break;
      frontier = next;
    }
    if (!screen) continue;
    const by = { filePath: route.filePath, method: route.httpMethod ?? null, path: route.path, line: route.line };
    const list = (screen.renderedBy ??= []);
    if (list.some((r) => r.filePath === by.filePath && r.method === by.method && r.path === by.path)) continue;
    list.push(by);
    if (!screen.routePath) screen.routePath = route.path;
    linked++;
  }
  return linked;
}

const NAME = String.raw`["'\x60]([^"'\x60\s{}$<>]+)["'\x60]`;
/** The first string argument of a call named for rendering: `render_template("x")`, `Page::new("a/b", …)`, `c.HTML(200, "x.tmpl")`. */
const RENDER_CALL = new RegExp(String.raw`[\w.:$]*(?:render|template|view|html|page)[\w$]*(?:::new)?\s*!?\s*\(\s*(?:[^()"'\x60;]{0,80}?,\s*)?${NAME}`, "gi");
/** A field, key or keyword argument named for the view: `"page_content": "admin/login"`, `template_name = "x.html"`, `view: 'x'`. */
const VIEW_FIELD = new RegExp(String.raw`["']?\w*(?:template|view|page)\w*["']?\s*(?::|=>?|=)\s*${NAME}`, "gi");
/** A handler returning the view's name (Spring MVC, Struts, Grails). */
const RETURN_NAME = new RegExp(String.raw`\breturn\s+${NAME}`, "g");

/** The template names a function body states, by the three shapes above. */
export function viewLiterals(text: string): string[] {
  const out = new Set<string>();
  for (const re of [RENDER_CALL, VIEW_FIELD, RETURN_NAME]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const v = m[1]!;
      // A URL or a bare word with no letters is not a view name.
      if (/^(?:https?:|\/\/)/.test(v) || !/[A-Za-z0-9]/.test(v)) continue;
      out.add(v);
    }
  }
  return [...out];
}
