import type { CallInfo, ClassInfo, Confidence, DataSourceInfo, FileAnalysis, FunctionInfo, ParamColumn, RouteInfo, SymbolLink } from "../types/analysis.js";
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
 * A handler built for a type that binds the request into an instance of it
 * (`RouteInfo.handlerTypes`) hands the type's methods the parameter as the
 * field the binder writes it into (`PropertyInfo.boundFrom`); the walk then
 * carries that field — of the receiver, and of whatever parameter the object
 * or a literal holding it is handed to. A call the linker did not resolve
 * ends the walk.
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

/**
 * What the walk carries: an argument position of the function, a request value
 * read inline by name, or a field of an object — the method's receiver
 * (`of: -1`) or the parameter at `of` — that holds it.
 */
type Slot = { kind: "param"; index: number } | { kind: "route-param" | "query-param"; name: string } | { kind: "field"; of: number; name: string };

type Origin = NonNullable<CallInfo["argOrigins"]>[number]["origin"];

const matches = (o: Origin, slot: Slot): boolean => {
  if (slot.kind === "param") return o.kind === "param" && o.index === slot.index;
  if (slot.kind === "field") return slot.of < 0 ? o.kind === "receiver-field" && o.name === slot.name : o.kind === "param-field" && o.index === slot.of && o.member === slot.name;
  return (o.kind === slot.kind || o.kind === "request-param") && o.name === slot.name;
};

/** The whole object a field slot lives in, as an argument hands it on (`load(s, p)`, `p.load(s)`). */
const handsObject = (o: Origin, slot: Slot): boolean =>
  slot.kind === "field" && (slot.of < 0 ? o.kind === "receiver" : o.kind === "param" && o.index === slot.of);

const slotKey = (slot: Slot): string => (slot.kind === "param" ? String(slot.index) : slot.kind === "field" ? `${slot.of}.${slot.name}` : `${slot.kind}:${slot.name}`);

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
  /** The function a link lands on: of overloads sharing a name, the one declared at the link's target line. */
  const fnNamed = (file: string, symbol: string, line?: number) => {
    const named = fnsIn(file).filter((f) => f.symbol === symbol);
    return (named.length > 1 && line !== undefined ? named.find((f) => f.fn.line === line) : undefined) ?? named[0];
  };
  const overloaded = (f: Fn): boolean => fnsIn(f.file).filter((x) => x.symbol === f.symbol).length > 1;
  /** Two declared types, nullability and namespaces aside; an undeclared one agrees with anything. */
  const sameType = (a: string | null | undefined, b: string | null | undefined): boolean => {
    const norm = (t: string) => t.replace(/\s+/g, "").replace(/\?$/, "").replace(/^(?:[\w]+\.)+/, "");
    return !a || !b || norm(a) === norm(b);
  };
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
      // Keyed by the declaration's line too: overloads share a name.
      const k = `${owner.file}::${owner.symbol}@${owner.fn.line}`;
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
  /**
   * The links one call made, by line and name. A framework dispatch (a bus
   * message, a named query a loader exposes) hands its arguments on by its own
   * rules, so it is followed only for an argument handed by name.
   */
  const linksOfCall = (file: string, symbol: string, call: CallInfo, byName: boolean): SymbolLink[] =>
    (linksFrom.get(`${file}::${symbol}`) ?? []).filter((l) => l.sourceLine === call.line && leaf(l.callName) === leaf(call.name) && (byName || !l.strategy?.startsWith("dispatch:")));

  /**
   * The fields of class `name` a binder writes the request value `slot` into. Of several classes of
   * that name, the declaration in the method's own file, else in its directory, else the only one.
   */
  let boundIn: Map<string, Array<{ file: string; fields: NonNullable<ClassInfo["properties"]> }>> | undefined;
  const boundFields = (name: string, file: string, slot: Slot): string[] => {
    if (!boundIn) {
      boundIn = new Map();
      for (const a of analyses) {
        for (const c of a.classes) {
          const fields = (c.properties ?? []).filter((x) => x.boundFrom);
          if (fields.length > 0) (boundIn.get(c.name) ?? boundIn.set(c.name, []).get(c.name)!).push({ file: a.filePath, fields });
        }
      }
    }
    const all = boundIn.get(name) ?? [];
    const dir = (f: string) => f.slice(0, f.lastIndexOf("/") + 1);
    const here = all.filter((c) => c.file === file);
    const near = here.length > 0 ? here : all.filter((c) => dir(c.file) === dir(file));
    const decl = near.length > 0 ? near : all.length === 1 ? all : [];
    if (slot.kind !== "route-param" && slot.kind !== "query-param") return [];
    return [...new Set(decl.flatMap((c) => c.fields.filter((x) => x.boundFrom!.kind === slot.kind && x.boundFrom!.name === slot.name).map((x) => x.name)))];
  };

  type Row = Omit<ParamColumn, "route">;
  const walk = (file: string, symbol: string, at: number | null, calls: readonly CallInfo[], slot: Slot, hops: ParamColumn["hops"], depth: number, confidence: Confidence, seen: Set<string>, out: Row[]): void => {
    const key = `${file}::${symbol}@${at}#${slotKey(slot)}`;
    if (seen.has(key) || depth > MAX_DEPTH || out.length >= MAX_PER_ROUTE) return;
    seen.add(key);
    for (const d of statementsOf.get(`${file}::${symbol}@${at}`) ?? []) {
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
        // What the callee receives the value as: its parameter, a field of its parameter (a
        // property of an object argument, or the object itself handed on), or — for a call made
        // on the object (`index` -1) — a field of its own receiver.
        const whole = handsObject(arg.origin, slot);
        if (!whole && !matches(arg.origin, slot)) continue;
        // A call made on some other object, or the object nested in another one's literal.
        if ((arg.index < 0 && !whole) || (whole && arg.field !== undefined)) continue;
        const field = whole ? (slot as Extract<Slot, { kind: "field" }>).name : arg.field;
        // A property of an object argument is followed only where the callee can read it by name.
        if (field !== undefined && field.includes(".")) continue;
        for (const link of linksOfCall(file, symbol, call, arg.param !== undefined)) {
          const target = fnNamed(link.targetFile, link.targetSymbol, link.targetLine);
          if (!target) continue;
          let next: Slot;
          let index: number;
          if (arg.index < 0) {
            index = -1;
            next = { kind: "field", of: -1, name: field! };
          } else {
            // Handed by name: the callee's parameter of that name, wherever it sits. An extension
            // method's receiver parameter is written before the dot (`clubs.ForLeague(id)`).
            const shift = target.fn.params[0]?.isReceiver && call.name.includes(".") ? 1 : 0;
            index = arg.param !== undefined ? target.fn.params.findIndex((p) => p.name === arg.param) : arg.index + shift;
            if (index < 0 || index >= target.fn.params.length) continue;
            // Of overloads sharing a name the linker may have picked the wrong one: followed only when the declared types agree.
            if (slot.kind === "param" && overloaded(target) && !sameType(fnNamed(file, symbol, at ?? undefined)?.fn.params[slot.index]?.type, target.fn.params[index]!.type)) continue;
            next = field !== undefined ? { kind: "field", of: index, name: field } : { kind: "param", index };
          }
          const hop = { file: link.targetFile, symbol: link.targetSymbol, line: target.fn.line, arg: index, ...(field !== undefined ? { field } : {}) };
          walk(target.file, target.symbol, target.fn.line, target.fn.calls, next, [...hops, hop], depth + 1, weakest(confidence, link.confidence ?? "INFERRED"), seen, out);
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
      walk(r.filePath, routeSymbol, null, r.calls ?? [], { kind: p.binding === "query" ? "query-param" : "route-param", name: p.name }, [], 0, "EXTRACTED", new Set(), found);
      // A callee the framework hands the route's parameters by name (a FastAPI `Depends(x)`): its
      // parameter of that name — and so on through the dependencies it asks for in turn.
      const viaDependencies = (file: string, symbol: string, calls: readonly CallInfo[], hops: ParamColumn["hops"], confidence: Confidence, depth: number, visited: Set<string>): void => {
        const byName = new Set(calls.filter((c) => c.routeParamsByName).map((c) => `${c.line}|${leaf(c.name)}`));
        if (byName.size === 0) return;
        for (const link of linksFrom.get(`${file}::${symbol}`) ?? []) {
          if (!byName.has(`${link.sourceLine}|${leaf(link.callName)}`)) continue;
          const dep = fnNamed(link.targetFile, link.targetSymbol, link.targetLine);
          const k = dep && `${dep.file}::${dep.symbol}@${dep.fn.line}`;
          if (!dep || visited.has(k!)) continue;
          visited.add(k!);
          const conf = weakest(confidence, link.confidence ?? "INFERRED");
          const index = dep.fn.params.findIndex((x) => x.name === p.name);
          if (index >= 0) walk(dep.file, dep.symbol, dep.fn.line, dep.fn.calls, { kind: "param", index }, [...hops, { file: dep.file, symbol: dep.symbol, line: dep.fn.line, arg: index }], 0, conf, new Set(), found);
          if (depth < MAX_DEPTH) viaDependencies(dep.file, dep.symbol, dep.fn.calls, [...hops, { file: dep.file, symbol: dep.symbol, line: dep.fn.line, arg: -1 }], conf, depth + 1, visited);
        }
      };
      viaDependencies(r.filePath, routeSymbol, r.calls ?? [], [], "EXTRACTED", 0, new Set());
      // The handler function: its parameter of that name. Any other function the route runs (a
      // `before_action` callback, a guard) sees the same request: its own reads of the parameter.
      const requestSlot: Slot = { kind: p.binding === "query" ? "query-param" : "route-param", name: p.name };
      for (const link of linksFrom.get(`${r.filePath}::${routeSymbol}`) ?? []) {
        if (!r.handler || leaf(link.callName) !== leaf(r.handler)) {
          const callee = fnNamed(link.targetFile, link.targetSymbol, link.targetLine);
          if (callee) walk(callee.file, callee.symbol, callee.fn.line, callee.fn.calls, requestSlot, [{ file: callee.file, symbol: callee.symbol, line: callee.fn.line, arg: -1 }], 0, link.confidence ?? "INFERRED", new Set(), found);
          continue;
        }
        const handler = fnNamed(link.targetFile, link.targetSymbol, link.targetLine);
        if (!handler) continue;
        const index = handler.fn.params.findIndex((x) => x.name === (p.variable ?? p.name));
        if (index >= 0) {
          const hop = { file: handler.file, symbol: handler.symbol, line: handler.fn.line, arg: index };
          walk(handler.file, handler.symbol, handler.fn.line, handler.fn.calls, { kind: "param", index }, [hop], 0, link.confidence ?? "INFERRED", new Set(), found);
        } else {
          // The handler reads it off the request itself (`req.params.slug`, `request.args.get("season")`).
          const hop = { file: handler.file, symbol: handler.symbol, line: handler.fn.line, arg: -1 };
          walk(handler.file, handler.symbol, handler.fn.line, handler.fn.calls, requestSlot, [hop], 0, link.confidence ?? "INFERRED", new Set(), found);
        }
      }
      // A handler built for a type binds the request into an instance of it (`RouteInfo.handlerTypes`: a Go
      // `WebHandler{EmptyStruct: … &models.Club{}}` serving `h.ReadOneWeb`, which `c.Bind`s it): each method
      // of that type the route runs reads the parameter as the field the binder writes it into
      // (`PropertyInfo.boundFrom`) — `p.ID` in `func (p *Club) ReadOne(…)`.
      if (r.handlerTypes?.length) {
        const types = new Set(r.handlerTypes.map((t) => leaf(t.replace(/[^\w.]/g, ""))));
        for (const link of linksFrom.get(`${r.filePath}::${routeSymbol}`) ?? []) {
          const callee = fnNamed(link.targetFile, link.targetSymbol, link.targetLine);
          const dot = callee ? callee.symbol.lastIndexOf(".") : -1;
          if (!callee || dot < 0 || !types.has(callee.symbol.slice(0, dot))) continue;
          for (const field of boundFields(callee.symbol.slice(0, dot), callee.file, requestSlot)) {
            const hop = { file: callee.file, symbol: callee.symbol, line: callee.fn.line, arg: -1, field };
            walk(callee.file, callee.symbol, callee.fn.line, callee.fn.calls, { kind: "field", of: -1, name: field }, [hop], 0, link.confidence ?? "INFERRED", new Set(), found);
          }
        }
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

/**
 * The entity of each row whose statement named none when the walk ran: a
 * project pass that settles it later (an association chain joined to its
 * model) fills the statement's `entity`, and the row takes it. A statement
 * that pass removed (a collection sharing the verb, no model) takes its row
 * with it. In place.
 */
export function fillParamColumnEntities(rows: ParamColumn[], analyses: readonly FileAnalysis[]): void {
  if (!rows.some((r) => r.column.entity === null)) return;
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k]!;
    if (r.column.entity !== null) continue;
    const d = byFile.get(r.column.file)?.dataSources.find((x) => x.kind === "database" && x.line === r.column.line && x.name === r.column.call);
    if (!d) rows.splice(k, 1);
    else if (d.entity) r.column.entity = d.entity;
  }
}
