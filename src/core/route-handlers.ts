import type { FileAnalysis, RouteInfo, SymbolLink } from "../types/analysis.js";

/** A function the analysis knows by file and symbol (`Class.method` for a method). */
export interface HandlerRef {
  file: string;
  symbol: string;
}

/** The lines a function or class body spans, 1-based and inclusive. */
export interface Span {
  line: number;
  endLine: number;
}

/**
 * How a route reaches the code it runs, for the passes that read a handler's
 * body (`rendered-views.ts`, `server-redirects.ts`): the function the route's
 * synthetic symbol links to — the route's own handler when two routes share
 * the symbol (Rocket ranks) — else the function at the route's line; then the
 * functions each of them calls, by the symbol links.
 */
export interface RouteHandlers {
  handlersOf(route: RouteInfo & { filePath: string }): HandlerRef[];
  spanOf(ref: HandlerRef): Span | null;
  calleesOf(ref: HandlerRef): HandlerRef[];
}

export function routeHandlers(analyses: readonly FileAnalysis[], symbolLinks: readonly SymbolLink[]): RouteHandlers {
  const byPath = new Map(analyses.map((a) => [a.filePath, a]));
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
  return {
    handlersOf(route) {
      let refs: HandlerRef[] = (linksFrom.get(`${route.filePath}\0route:${route.httpMethod ?? "USE"} ${route.path}`) ?? []).map((l) => ({
        file: l.targetFile,
        symbol: l.targetSymbol,
      }));
      const own = route.handler ? refs.filter((f) => f.symbol.split(".").pop() === route.handler!.split(/[.#:]/).pop()) : [];
      if (own.length > 0) refs = own;
      if (refs.length === 0) {
        const a = byPath.get(route.filePath);
        const at = a ? fnSymbol(a, route.line) : null;
        if (at) refs = [{ file: route.filePath, symbol: at.symbol }];
      }
      return refs;
    },
    spanOf({ file, symbol }) {
      const a = byPath.get(file);
      if (!a) return null;
      const dot = symbol.lastIndexOf(".");
      if (dot > 0) {
        const m = a.classes.find((c) => c.name === symbol.slice(0, dot))?.methods.find((x) => x.name === symbol.slice(dot + 1));
        if (m) return m;
      }
      // A class the route is anchored on (a class-based view stating `template_name`): its body.
      return a.functions.find((f) => f.name === symbol) ?? a.classes.find((c) => c.name === symbol) ?? null;
    },
    calleesOf({ file, symbol }) {
      return (linksFrom.get(`${file}\0${symbol}`) ?? []).map((l) => ({ file: l.targetFile, symbol: l.targetSymbol }));
    },
  };
}
