/**
 * The call-graph symbol of a route: `route:<METHOD> <path>`, the anchor its own links, reach and data
 * flows hang on. A route a registrar function declares (`RouteInfo.registrar`: a Huma operation) adds
 * ` @<registrar>`, so two registrars of one file declaring the same method and path stay two symbols
 * and one's data never reads as the other's.
 */
export function routeSymbolName(r: { httpMethod?: string | null; path: string; registrar?: string | null }): string {
  return `route:${r.httpMethod ?? "USE"} ${r.path}${r.registrar ? ` @${r.registrar}` : ""}`;
}

/** A route row's symbol with its method upper-cased, as the linker writes it (`route:GET /clubs`, `route:USE /x`). */
export function routeSymbolOf(r: { httpMethod?: string | null; path: string; registrar?: string | null }): string {
  return routeSymbolName({ ...r, httpMethod: (r.httpMethod ?? "USE").toUpperCase() });
}

/** A route whose handler is written inline (no named handler, its body's end line stated): its own source span. */
export function hasInlineHandler(r: { handler?: string | null; handlerEndLine?: number | null }): boolean {
  return !r.handler && !!r.handlerEndLine;
}

/** The `<path>` of a route symbol's text after `route:<METHOD> ` — the registrar suffix cut off. */
export function routeSymbolPath(rest: string): string {
  const at = rest.indexOf(" @");
  return at < 0 ? rest : rest.slice(0, at);
}

/** A route written with an inline handler as a definition: its symbol, file and the span of its body. */
export interface InlineRouteDefinition {
  /** `route:<METHOD> <path>` — the symbol the linker anchors the route's own links on. */
  symbol: string;
  file: string;
  line: number;
  endLine: number;
}

const INLINE_DEFINITIONS = new WeakMap<object, InlineRouteDefinition[]>();

/**
 * Every route of the final route map whose handler is written inline, once per analysis (memoized on the
 * row array): the definitions a tool looks a `route:` symbol up in, where a named handler's function table
 * has no row for it. Rows without a file or with an end line before their start are no definition.
 */
export function inlineRouteDefinitions(project: { routeMap?: ReadonlyArray<{ handler?: string | null; handlerEndLine?: number | null; httpMethod?: string | null; path: string; registrar?: string | null; filePath?: string; line: number }> }): InlineRouteDefinition[] {
  const rows = project.routeMap;
  if (!rows) return [];
  const known = INLINE_DEFINITIONS.get(rows);
  if (known) return known;
  const out: InlineRouteDefinition[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!hasInlineHandler(r) || !r.filePath || r.handlerEndLine! < r.line) continue;
    const symbol = routeSymbolOf(r);
    const key = `${r.filePath}::${symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol, file: r.filePath, line: r.line, endLine: r.handlerEndLine! });
  }
  INLINE_DEFINITIONS.set(rows, out);
  return out;
}
