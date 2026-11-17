/**
 * The call-graph symbol of a route: `route:<METHOD> <path>`, the anchor its own links, reach and data
 * flows hang on. A route a registrar function declares (`RouteInfo.registrar`: a Huma operation) adds
 * ` @<registrar>`, so two registrars of one file declaring the same method and path stay two symbols
 * and one's data never reads as the other's.
 */
export function routeSymbolName(r: { httpMethod?: string | null; path: string; registrar?: string | null }): string {
  return `route:${r.httpMethod ?? "USE"} ${r.path}${r.registrar ? ` @${r.registrar}` : ""}`;
}

/** The `<path>` of a route symbol's text after `route:<METHOD> ` — the registrar suffix cut off. */
export function routeSymbolPath(rest: string): string {
  const at = rest.indexOf(" @");
  return at < 0 ? rest : rest.slice(0, at);
}
