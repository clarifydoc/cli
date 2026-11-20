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
