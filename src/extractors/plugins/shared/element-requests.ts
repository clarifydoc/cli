import type { FileAnalysis } from "../../../types/analysis.js";

/**
 * A server-rendered form or link that requests a LITERAL app path is an HTTP
 * call like any other: give it to the route linker. For each element whose
 * `request.target` is a path, this adds an api-call data source at the
 * element's line (`POST /admin`) and a one-line pseudo-function named after
 * the element's handler, so the call has a containing symbol: the route linker
 * joins the call to the route serving it, `synthesizeApiRouteSymbolLinks`
 * turns that into `<file>::<handler> → <route handler>`, and a click on the
 * element traces through the controller to the database — with the same
 * method, version and origin rules as a `fetch`. Targets that are not paths
 * (a route helper, `Ctl#action`) are left to the plugin's resolver.
 */
export function materializeElementRequests(analysis: FileAnalysis): void {
  const named = new Set(analysis.functions.map((f) => f.name));
  for (const el of analysis.interactiveElements) {
    if (!el.request || !el.handler || !el.request.target.startsWith("/")) continue;
    analysis.dataSources.push({
      kind: "api-call",
      name: `${el.request.method} ${el.request.target}`,
      target: el.request.target,
      calls: [],
      line: el.line,
    });
    if (named.has(el.handler)) continue;
    named.add(el.handler);
    analysis.functions.push({
      name: el.handler,
      params: [],
      returnType: null,
      isAsync: false,
      isExported: false,
      decorators: [],
      calls: [],
      line: el.line,
      endLine: el.line,
    });
  }
}
