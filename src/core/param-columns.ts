import type { CallInfo, Confidence, DataSourceInfo, FileAnalysis, FunctionInfo, ParamColumn, RouteInfo, SymbolLink } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";

/**
 * Which route parameter a data statement filters on — the backend half of
 * `paramOrigins` (`ProjectAnalysis.paramColumns`):
 *
 *   profile.controller.ts  GET /profiles/:username   getProfile(req.params.username)   ← route parameter
 *   profile.service.ts     getProfile(name)          prisma.user.findUnique({ where: { username: name } })
 *                                                    → user.username
 *
 * Language-agnostic: the plugins report where each call's arguments come from
 * (`CallInfo.argOrigins`) and which fields a statement's filter compares with
 * a value of known origin (`DataSourceInfo.whereFields`); this follows a
 * route's parameter forward over the symbol links — from the route's own
 * calls (an inline handler reading the request), or from the handler
 * function's parameter of the same name — to each statement filtering on it.
 * A call the linker did not resolve ends the walk.
 */

const MAX_DEPTH = 6;
const MAX_PER_ROUTE = 32;

const RANK: Record<Confidence, number> = { EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 0 };
const weakest = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);

interface Fn {
  file: string;
  symbol: string;
  fn: FunctionInfo;
}

/** What the walk carries: an argument position of the function, or a request value read inline by name. */
type Slot = { kind: "param"; index: number } | { kind: "route-param" | "query-param"; name: string };

type Origin = NonNullable<CallInfo["argOrigins"]>[number]["origin"];

const matches = (o: Origin, slot: Slot): boolean =>
  slot.kind === "param" ? o.kind === "param" && o.index === slot.index : o.kind === slot.kind && o.name === slot.name;

export function computeParamColumns(input: {
  analyses: readonly FileAnalysis[];
  symbolLinks: readonly SymbolLink[];
  routes: ReadonlyArray<RouteInfo & { filePath?: string }>;
}): ParamColumn[] {
  const { analyses } = input;
  if (!analyses.some((a) => a.dataSources.some((d) => d.whereFields))) return [];
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const fnsOf = new Map<string, Fn[]>();
  const fnsIn = (file: string): Fn[] => {
    let list = fnsOf.get(file);
    if (!list) {
      const a = byFile.get(file);
      list = a ? [...a.functions.map((fn) => ({ file, symbol: fn.name, fn })), ...a.classes.flatMap((c) => c.methods.map((m) => ({ file, symbol: `${c.name}.${m.name}`, fn: m })))] : [];
      fnsOf.set(file, list);
    }
    return list;
  };
  const fnNamed = (file: string, symbol: string) => fnsIn(file).find((f) => f.symbol === symbol);
  /** The innermost function of the file spanning `line`. */
  const innermost = (file: string, line: number): Fn | undefined => {
    let best: Fn | undefined;
    for (const f of fnsIn(file)) {
      if (f.fn.name.startsWith("<") || line < f.fn.line || line > f.fn.endLine) continue;
      if (!best || f.fn.endLine - f.fn.line < best.fn.endLine - best.fn.line) best = f;
    }
    return best;
  };
  // The statements with filter fields, by the function they sit in.
  const statementsOf = new Map<string, DataSourceInfo[]>();
  for (const a of analyses) {
    for (const d of a.dataSources) {
      if (d.kind !== "database" || !d.whereFields) continue;
      const owner = innermost(a.filePath, d.line);
      if (!owner) continue;
      const k = `${owner.file}::${owner.symbol}`;
      (statementsOf.get(k) ?? statementsOf.set(k, []).get(k)!).push(d);
    }
  }
  if (statementsOf.size === 0) return [];
  const linksFrom = new Map<string, SymbolLink[]>();
  for (const l of input.symbolLinks) {
    if (l.relation === "reference" || l.relation === "http" || l.navigational) continue;
    const k = `${l.sourceFile}::${l.sourceSymbol}`;
    (linksFrom.get(k) ?? linksFrom.set(k, []).get(k)!).push(l);
  }
  const leaf = (name: string) => name.split(".").pop() ?? name;
  /** The links one call made, by line and name. */
  const linksOfCall = (file: string, symbol: string, call: CallInfo): SymbolLink[] =>
    (linksFrom.get(`${file}::${symbol}`) ?? []).filter((l) => l.sourceLine === call.line && leaf(l.callName) === leaf(call.name) && !l.strategy?.startsWith("dispatch:"));

  type Row = Omit<ParamColumn, "route">;
  const walk = (file: string, symbol: string, calls: readonly CallInfo[], slot: Slot, hops: ParamColumn["hops"], depth: number, confidence: Confidence, seen: Set<string>, out: Row[]): void => {
    const key = `${file}::${symbol}#${slot.kind === "param" ? slot.index : `${slot.kind}:${slot.name}`}`;
    if (seen.has(key) || depth > MAX_DEPTH || out.length >= MAX_PER_ROUTE) return;
    seen.add(key);
    for (const d of statementsOf.get(`${file}::${symbol}`) ?? []) {
      for (const w of d.whereFields!) {
        if (!matches(w.origin, slot)) continue;
        out.push({
          column: { entity: d.entity ?? null, field: w.field, file, line: d.line, ...(d.access ? { access: d.access } : {}), call: d.name },
          hops,
          ...(w.transform ? { transform: w.transform } : {}),
          confidence,
        });
      }
    }
    for (const call of calls) {
      for (const arg of call.argOrigins ?? []) {
        // A property of an object argument arrives as a field of the callee's parameter: not followed.
        if (arg.field !== undefined || !matches(arg.origin, slot)) continue;
        for (const link of linksOfCall(file, symbol, call)) {
          const target = fnNamed(link.targetFile, link.targetSymbol);
          if (!target || arg.index >= target.fn.params.length) continue;
          const hop = { file: link.targetFile, symbol: link.targetSymbol, line: target.fn.line, arg: arg.index };
          walk(target.file, target.symbol, target.fn.calls, { kind: "param", index: arg.index }, [...hops, hop], depth + 1, weakest(confidence, link.confidence ?? "INFERRED"), seen, out);
        }
      }
    }
  };

  const out: ParamColumn[] = [];
  for (const r of input.routes) {
    if (r.kind !== "api" || !r.filePath) continue;
    const params = (r.params ?? []).filter((p) => p.binding === "route" || p.binding === "query");
    if (params.length === 0) continue;
    const routeSymbol = `route:${r.httpMethod ?? "USE"} ${r.path}`;
    const rows: Array<Row & { param: string; binding: string }> = [];
    for (const p of params) {
      const found: Row[] = [];
      // An inline handler reading the request: the route's own calls.
      walk(r.filePath, routeSymbol, r.calls ?? [], { kind: p.binding === "query" ? "query-param" : "route-param", name: p.name }, [], 0, "EXTRACTED", new Set(), found);
      // A handler function: its parameter of the route parameter's name.
      for (const link of linksFrom.get(`${r.filePath}::${routeSymbol}`) ?? []) {
        if (!r.handler || leaf(link.callName) !== leaf(r.handler)) continue;
        const handler = fnNamed(link.targetFile, link.targetSymbol);
        const index = handler ? handler.fn.params.findIndex((x) => x.name === p.name) : -1;
        if (!handler || index < 0) continue;
        const hop = { file: handler.file, symbol: handler.symbol, line: handler.fn.line, arg: index };
        walk(handler.file, handler.symbol, handler.fn.calls, { kind: "param", index }, [hop], 0, link.confidence ?? "INFERRED", new Set(), found);
      }
      for (const row of found) rows.push({ ...row, param: p.name, binding: p.binding! });
    }
    const seen = new Set<string>();
    for (const row of rows) {
      const k = `${row.param}|${row.column.file}:${row.column.line}|${row.column.field}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const { param, binding, ...rest } = row;
      out.push({ route: { file: r.filePath, line: r.line, method: r.httpMethod ?? null, path: r.path, param, binding }, ...rest });
    }
  }
  return out.sort((a, b) => byOrdinal(a.route.file, b.route.file) || a.route.line - b.route.line || byOrdinal(a.route.param, b.route.param) || byOrdinal(a.column.file, b.column.file) || a.column.line - b.column.line || byOrdinal(a.column.field, b.column.field));
}
