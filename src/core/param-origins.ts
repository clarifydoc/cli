import type { ApiRouteLink, CallArgOrigin, CallInfo, Confidence, FileAnalysis, FunctionInfo, ParamOrigin, PropBinding, RouteInfo, ScreenInfo, SymbolLink } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";

/**
 * Which value feeds a slot of an API call's URL — the screen's route
 * parameter, a literal, or nothing the analysis can name — followed back from
 * the call through the functions that hand it on (`ProjectAnalysis.paramOrigins`).
 *
 *   pages/ClubPage.tsx    const { id } = useParams();  useClub(Number(id))   ← route-param `id`
 *   hooks/useClub.ts      useClub(id)            → api.getClub(id)           arg 0
 *   api/clubs.ts          getClub(id)            → http.get(`/clubs/${id}`)  slot `id`
 *   ClubsController       GET /api/clubs/{id}    param id: Long, route
 *
 * Language-agnostic: the plugins report where each call's arguments come from
 * (`CallInfo.argOrigins`); this joins them over the symbol links. Value-flow
 * lite, not taint analysis: no tracking through object fields or reassigned
 * variables, a call the linker did not resolve ends the walk as `unknown`.
 */

const MAX_DEPTH = 8;
const MAX_PER_SLOT = 16;

interface Fn {
  file: string;
  symbol: string;
  fn: FunctionInfo;
}

const RANK: Record<Confidence, number> = { EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 0 };
const weakest = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);

/** `${id}`, `${encodeURIComponent(slug)}`, `${String(n)}`, `${this.props.match.params.id}`. */
const SLOT = /\$\{\s*(?:(?:encodeURIComponent|encodeURI|encode|String|Number)\s*\(\s*)?([A-Za-z_$][\w$.]*)\s*\)?\s*\}/g;
/** An OpenAPI path template's placeholder (`/clubs/{id}`), filled from a request object (`DataSourceInfo.pathValues`). */
const BRACE_SLOT = /(?<!\$)\{([A-Za-z_$][\w$]*)\}/g;
/** A slot that reads the router itself: a route parameter (or query value) at the call. */
const DIRECT = /^(?:this\.)?(?:props\.)?(?:match\.params|\$route\.params)\.([\w$]+)$/;
const DIRECT_QUERY = /^(?:this\.)?\$route\.query\.([\w$]+)$/;
/** A slot that reads the component's own prop (`${props.clubId}`). */
const DIRECT_PROP = /^(?:this\.)?props\.([\w$]+)$/;

export function computeParamOrigins(input: {
  analyses: readonly FileAnalysis[];
  symbolLinks: readonly SymbolLink[];
  apiRouteLinks: readonly ApiRouteLink[];
  routes: ReadonlyArray<RouteInfo & { filePath?: string }>;
  screens: readonly ScreenInfo[];
  /** File → the files it imports: where a markup binding's component tag resolves. */
  componentGraph?: Readonly<Record<string, readonly string[]>>;
}): ParamOrigin[] {
  const { analyses } = input;
  if (!analyses.some((a) => hasOrigins(a))) return [];
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const fnsOf = new Map<string, Fn[]>();
  const fnAt = (file: string): Fn[] => {
    let list = fnsOf.get(file);
    if (!list) {
      const a = byFile.get(file);
      list = a ? [...a.functions.map((fn) => ({ file, symbol: fn.name, fn })), ...a.classes.flatMap((c) => c.methods.map((m) => ({ file, symbol: `${c.name}.${m.name}`, fn: m })))] : [];
      fnsOf.set(file, list);
    }
    return list;
  };
  const fnNamed = (file: string, symbol: string) => fnAt(file).find((f) => f.symbol === symbol);
  const innermost = (file: string, line: number): Fn | undefined => {
    let best: Fn | undefined;
    for (const f of fnAt(file)) {
      if (f.fn.name.startsWith("<") || line < f.fn.line || line > f.fn.endLine) continue;
      if (!best || f.fn.endLine - f.fn.line < best.fn.endLine - best.fn.line) best = f;
    }
    return best;
  };
  const callersOf = new Map<string, SymbolLink[]>();
  const linked = new Set(input.symbolLinks.map((l) => `${l.sourceFile}\0${l.sourceSymbol}\0${l.sourceLine}\0${l.callName}`));
  for (const l of input.symbolLinks) {
    if (l.relation === "reference" || l.navigational || l.sourceSymbol.startsWith("(")) continue;
    const k = `${l.targetFile}::${l.targetSymbol}`;
    const list = callersOf.get(k) ?? callersOf.set(k, []).get(k)!;
    list.push(l);
    // One link stands for every call of that name in its caller (`load(params.id, page)` and
    // `load(params.id)`): each other site handing on known values is a caller of its own.
    if ((l.relation ?? "calls") !== "calls" || l.strategy?.startsWith("dispatch:")) continue;
    const site = fnNamed(l.sourceFile, l.sourceSymbol)?.fn.calls.find((c) => c.line === l.sourceLine && c.name === l.callName);
    if (!site) continue;
    for (const c of fnNamed(l.sourceFile, l.sourceSymbol)!.fn.calls) {
      if (c === site || c.name !== site.name || c.key !== site.key || !c.argOrigins || linked.has(`${l.sourceFile}\0${l.sourceSymbol}\0${c.line}\0${c.name}`)) continue;
      list.push({ ...l, sourceLine: c.line });
    }
  }
  const screensOf = new Map<string, ScreenInfo[]>();
  for (const s of input.screens) (screensOf.get(s.filePath) ?? screensOf.set(s.filePath, []).get(s.filePath)!).push(s);
  const linkOf = new Map<string, ApiRouteLink>();
  for (const l of input.apiRouteLinks) if (!linkOf.has(`${l.source}:${l.sourceLine}`)) linkOf.set(`${l.source}:${l.sourceLine}`, l);
  const routeAt = new Map<string, RouteInfo & { filePath?: string }>();
  for (const r of input.routes) if (r.filePath) routeAt.set(`${r.filePath}:${r.line}`, r);

  // A component's props: what each parent's markup binds them to, and what the route rendering it hands them.
  const rendering = new Map<string, Array<RouteInfo & { filePath?: string }>>();
  for (const r of input.routes) {
    if (r.kind !== "frontend" || !r.propsFromRoute || !r.componentPath) continue;
    // The component as a file, or as the router file imports it (`component: ClubView`).
    const router = r.filePath ? byFile.get(r.filePath) : undefined;
    const file = byFile.has(r.componentPath) ? r.componentPath : router ? childFile(router, r.componentPath.replace(/^.*\//, "").replace(/\.\w+$/, ""), input.componentGraph?.[router.filePath] ?? []) : null;
    if (file) (rendering.get(file) ?? rendering.set(file, []).get(file)!).push(r);
  }
  const boundTo = new Map<string, Array<{ file: string; binding: PropBinding }>>();
  for (const a of analyses) {
    for (const b of a.propBindings ?? []) {
      const child = childFile(a, b.component, input.componentGraph?.[a.filePath] ?? []);
      if (child) (boundTo.get(`${child}\0${b.prop}`) ?? boundTo.set(`${child}\0${b.prop}`, []).get(`${child}\0${b.prop}`)!).push({ file: a.filePath, binding: b });
    }
  }

  /** The call of `link` in its source function, by line and name. */
  const callOf = (link: SymbolLink): CallInfo | undefined => {
    const src = fnNamed(link.sourceFile, link.sourceSymbol);
    const leaf = (link.callName ?? "").split(".").pop();
    return src?.fn.calls.find((c) => c.line === link.sourceLine && (!leaf || c.name.split(".").pop() === leaf))
      ?? src?.fn.calls.find((c) => c.line === link.sourceLine);
  };

  type Leaf = { origin: ParamOrigin["origin"]; hops: ParamOrigin["hops"]; confidence: Confidence };
  /** Every origin of parameter `index` of `target` — or of its property `field` — through its callers. */
  const walk = (target: Fn, index: number, field: string | undefined, depth: number, seen: Set<string>, hops: ParamOrigin["hops"], confidence: Confidence, out: Leaf[]): void => {
    const key = `${target.file}::${target.symbol}#${index}${field ? `.${field}` : ""}`;
    if (seen.has(key) || out.length >= MAX_PER_SLOT * 4) return;
    seen.add(key);
    for (const link of (callersOf.get(`${target.file}::${target.symbol}`) ?? []).slice().sort((a, b) => byOrdinal(a.sourceFile, b.sourceFile) || a.sourceLine - b.sourceLine)) {
      const call = callOf(link);
      const conf = weakest(confidence, link.confidence ?? "INFERRED");
      const hop = { file: link.sourceFile, symbol: link.sourceSymbol, line: link.sourceLine, arg: index, ...(field ? { field } : {}) };
      // A framework dispatch (an emitted event, a bus message) hands its arguments on by its own rules, not by position.
      const dispatched = link.strategy?.startsWith("dispatch:") ?? false;
      // An argument handed by name lands on the parameter of that name.
      const lands = (a: CallArgOrigin) => (a.param !== undefined ? a.param === target.fn.params[index]?.name : a.index === index);
      const arg: CallArgOrigin | undefined = dispatched ? undefined : call?.argOrigins?.find((a) => lands(a) && a.field === field);
      if (!arg) {
        out.push({ origin: { kind: "unknown", file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
        continue;
      }
      const o = arg.origin;
      if (o.kind === "param") {
        const caller = fnNamed(link.sourceFile, link.sourceSymbol);
        const at = caller ? caller.fn.params.findIndex((p) => p.name === o.name) : -1;
        if (!caller || at < 0 || depth >= MAX_DEPTH) {
          out.push({ origin: { kind: "unknown", file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
          continue;
        }
        walk(caller, at, undefined, depth + 1, seen, [hop, ...hops], conf, out);
        continue;
      }
      if (o.kind === "literal") {
        out.push({ origin: { kind: "literal", value: o.value, file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
        continue;
      }
      if (o.kind === "prop") {
        propOrigins(link.sourceFile, o.name, link.sourceLine, depth + 1, seen, [hop, ...hops], conf, out);
        continue;
      }
      if (o.kind === "invoked") {
        const caller = fnNamed(link.sourceFile, link.sourceSymbol);
        if (!caller || depth >= MAX_DEPTH) {
          out.push({ origin: { kind: "unknown", file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
          continue;
        }
        invoked(caller, o.via, o.index, o.field, 0, depth + 1, seen, [hop, ...hops], conf, out);
        continue;
      }
      // A server's merged request value is no screen's URL.
      out.push({ origin: o.kind === "request-param" ? { kind: "unknown", file: link.sourceFile, line: link.sourceLine } : urlOrigin(o.kind, o.name, link.sourceFile, link.sourceLine), hops: [hop, ...hops], confidence: conf });
    }
  };

  /**
   * A callback a library invokes (`mutationFn: ({ id }) => …` inside `owner`)
   * receives what its invoker is handed: the calls named one of `via`
   * (`mutation.mutateAsync({ id })`) linked to `owner` — or to a function that
   * returns what `owner` builds, up the callers with no such call of their own
   * (`deleteClubOptions` → `useDeleteClub` → the screen) — then on as any argument.
   */
  const invoked = (owner: Fn, via: readonly string[], index: number, field: string | undefined, up: number, depth: number, seen: Set<string>, hops: ParamOrigin["hops"], confidence: Confidence, out: Leaf[]): void => {
    const key = `${owner.file}::${owner.symbol}!${index}${field ? `.${field}` : ""}`;
    if (seen.has(key) || up > 3 || out.length >= MAX_PER_SLOT * 4) return;
    seen.add(key);
    const callers = (callersOf.get(`${owner.file}::${owner.symbol}`) ?? []).slice().sort((a, b) => byOrdinal(a.sourceFile, b.sourceFile) || a.sourceLine - b.sourceLine);
    const invokes = (l: SymbolLink) => via.includes((l.callName ?? "").split(".").pop() ?? "");
    const invokingCallers = new Set(callers.filter(invokes).map((l) => `${l.sourceFile}::${l.sourceSymbol}`));
    for (const link of callers) {
      const conf = weakest(confidence, link.confidence ?? "INFERRED");
      if (invokes(link)) {
        // The invoker's argument at `index` (or its property `field`) is the callback's.
        const call = callOf(link);
        const hop = { file: link.sourceFile, symbol: link.sourceSymbol, line: link.sourceLine, arg: index, ...(field ? { field } : {}) };
        // The property itself, else the whole argument it is read off (`mutateAsync(club)` for `club.id`).
        const own = call?.argOrigins?.find((a) => a.index === index && a.field === field);
        const whole = own || !field ? undefined : call?.argOrigins?.find((a) => a.index === index && a.field === undefined && a.origin.kind === "param");
        const arg = own ?? whole;
        const caller = fnNamed(link.sourceFile, link.sourceSymbol);
        if (!arg || !caller) {
          out.push({ origin: { kind: "unknown", file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
          continue;
        }
        const o = arg.origin;
        if (o.kind === "param") {
          const at = caller.fn.params.findIndex((p) => p.name === o.name);
          if (at >= 0 && depth < MAX_DEPTH) walk(caller, at, whole ? field : undefined, depth + 1, seen, [hop, ...hops], conf, out);
          else out.push({ origin: { kind: "unknown", file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
        } else if (o.kind === "literal") out.push({ origin: { kind: "literal", value: o.value, file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
        else if (o.kind === "prop") propOrigins(link.sourceFile, o.name, link.sourceLine, depth + 1, seen, [hop, ...hops], conf, out);
        else if (o.kind === "invoked") out.push({ origin: { kind: "unknown", file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
        else if (o.kind === "request-param") out.push({ origin: { kind: "unknown", file: link.sourceFile, line: link.sourceLine }, hops: [hop, ...hops], confidence: conf });
        else out.push({ origin: urlOrigin(o.kind, o.name, link.sourceFile, link.sourceLine), hops: [hop, ...hops], confidence: conf });
        continue;
      }
      // A caller that only builds or hands on what `owner` returns: its own callers invoke it.
      if (invokingCallers.has(`${link.sourceFile}::${link.sourceSymbol}`)) continue;
      const caller = fnNamed(link.sourceFile, link.sourceSymbol);
      if (caller) invoked(caller, via, index, field, up + 1, depth, seen, [{ file: link.sourceFile, symbol: link.sourceSymbol, line: link.sourceLine, arg: index, ...(field ? { field } : {}) }, ...hops], conf, out);
    }
  };

  /**
   * Prop `prop` of the component in `file`: the URL value the route rendering
   * it hands that prop (Vue Router `props`), and the value each parent's markup
   * binds to it — followed further up when that is the parent's own prop.
   */
  const propOrigins = (file: string, prop: string, line: number, depth: number, seen: Set<string>, hops: ParamOrigin["hops"], confidence: Confidence, out: Leaf[]): void => {
    const key = `${file}::prop:${prop}`;
    if (seen.has(key) || depth > MAX_DEPTH || out.length >= MAX_PER_SLOT * 4) return;
    seen.add(key);
    let found = false;
    for (const r of rendering.get(file) ?? []) {
      const given = r.propsFromRoute === true
        ? (namesParam(r.path, prop) ? { kind: "route-param" as const, name: prop } : undefined)
        : r.propsFromRoute?.find((e) => e.prop === prop);
      if (!given) continue;
      found = true;
      const screen = (screensOf.get(file) ?? []).find((s) => s.routePath === r.path) ?? screensOf.get(file)?.[0];
      out.push({
        origin: { kind: given.kind, name: given.name, file, line, ...(screen ? { screen: screen.name } : {}), routePath: r.path, ...(given.kind === "route-param" ? { inRoutePath: namesParam(r.path, given.name) } : {}) },
        hops: [{ file: r.filePath ?? file, symbol: `route:${r.path}`, line: r.line, arg: 0, field: prop }, ...hops],
        confidence,
      });
    }
    for (const { file: parent, binding } of (boundTo.get(`${file}\0${prop}`) ?? []).slice().sort((a, b) => byOrdinal(a.file, b.file) || a.binding.line - b.binding.line)) {
      found = true;
      const hop = { file: parent, symbol: `<${binding.component}>`, line: binding.line, arg: 0, field: prop };
      const conf = weakest(confidence, "INFERRED");
      const o = binding.origin;
      if (o.kind === "prop") propOrigins(parent, o.name, binding.line, depth + 1, seen, [hop, ...hops], conf, out);
      else if (o.kind === "literal") out.push({ origin: { kind: "literal", value: o.value, file: parent, line: binding.line }, hops: [hop, ...hops], confidence: conf });
      else if (o.kind === "route-param" || o.kind === "query-param") out.push({ origin: urlOrigin(o.kind, o.name, parent, binding.line), hops: [hop, ...hops], confidence: conf });
      else out.push({ origin: { kind: "unknown", file: parent, line: binding.line }, hops: [hop, ...hops], confidence: conf });
    }
    if (!found) out.push({ origin: { kind: "unknown", file, line }, hops, confidence });
  };

  /** A route or query value read in `file`, with the screen that file is and whether its route path names it. */
  const urlOrigin = (kind: "route-param" | "query-param", name: string, file: string, line: number): ParamOrigin["origin"] => {
    const own = screensOf.get(file) ?? [];
    const screen = (kind === "route-param" ? own.find((s) => s.routePath && namesParam(s.routePath, name)) : undefined) ?? own.find((s) => s.routePath) ?? own[0];
    const routePath = screen?.routePath ?? undefined;
    const inRoutePath = kind === "route-param" && routePath ? namesParam(routePath, name) : undefined;
    return { kind, name, file, line, ...(screen ? { screen: screen.name } : {}), ...(routePath ? { routePath } : {}), ...(inRoutePath !== undefined ? { inRoutePath } : {}) };
  };

  const rows: ParamOrigin[] = [];
  const emit = (sink: ParamOrigin["sink"], leaves: Leaf[], route: ParamOrigin["route"] | undefined, link: ApiRouteLink | undefined): void => {
    if (leaves.length === 0) return;
    for (const leaf of dedupe(leaves).slice(0, MAX_PER_SLOT)) {
      rows.push({
        sink,
        origin: leaf.origin,
        hops: leaf.hops,
        ...(route ? { route } : {}),
        confidence: link ? weakest(leaf.confidence, link.confidence) : leaf.confidence,
      });
    }
  };
  for (const a of analyses) {
    for (const ds of a.dataSources ?? []) {
      if (ds.kind !== "api-call" || !ds.target || !(ds.target.includes("${") || ds.pathValues)) continue;
      const fn = innermost(a.filePath, ds.line);
      const link = linkOf.get(`${a.filePath}:${ds.line}`);
      for (const m of ds.target.matchAll(SLOT)) {
        const slot = m[1]!;
        // A value is a whole path segment or a query value (`/clubs/${id}`, `?season=${year}`);
        // a slot glued to other text (`/api${url}`) is a URL the caller composes, not a parameter.
        const before = ds.target[m.index! - 1];
        const after = ds.target[m.index! + m[0]!.length];
        if (!(before === "/" || before === "=") || !(after === undefined || after === "/" || after === "?" || after === "&" || after === "#")) continue;
        const sink = { file: a.filePath, line: ds.line, url: ds.target, slot };
        const leaves: Leaf[] = [];
        const direct = DIRECT.exec(slot) ?? DIRECT_QUERY.exec(slot);
        const ownProp = direct ? null : DIRECT_PROP.exec(slot);
        if (ownProp) {
          propOrigins(a.filePath, ownProp[1]!, ds.line, 0, new Set(), [], "EXTRACTED", leaves);
        } else if (direct) {
          leaves.push({ origin: urlOrigin(DIRECT.test(slot) ? "route-param" : "query-param", direct[1]!, a.filePath, ds.line), hops: [], confidence: "EXTRACTED" });
        } else {
          const at = fn && !slot.includes(".") ? fn.fn.params.findIndex((p) => p.name === slot) : -1;
          if (!fn || at < 0) continue; // a local or a member: not followed
          walk(fn, at, undefined, 0, new Set(), [], "EXTRACTED", leaves);
        }
        emit(sink, leaves, link ? routeParam(link, ds.target, m[0]!, routeAt) : undefined, link);
      }
      // A generated SDK's operation: `{id}` filled from its argument's `path` object.
      if (ds.pathValues && fn) {
        for (const m of ds.target.matchAll(BRACE_SLOT)) {
          const slot = m[1]!;
          const leaves: Leaf[] = [];
          walk(fn, ds.pathValues.index, `${ds.pathValues.field}.${slot}`, 0, new Set(), [], "EXTRACTED", leaves);
          emit({ file: a.filePath, line: ds.line, url: ds.target, slot }, leaves, link ? routeParam(link, ds.target, m[0]!, routeAt) : undefined, link);
        }
      }
    }
  }
  return rows;
}

/**
 * The file a markup tag renders, among the files the parent imports: the one
 * its import of that name points at, else the one file named like the tag.
 */
function childFile(a: FileAnalysis, tag: string, imported: readonly string[]): string | null {
  const name = tag.includes("-") ? tag.replace(/(^|-)([a-z0-9])/g, (_m, _d, c: string) => c.toUpperCase()) : tag;
  const stem = (f: string) => f.replace(/\.[\w]+$/, "");
  const source = a.imports.find((i) => i.specifiers.includes(name) || i.specifiers.includes(tag))?.source;
  if (source) {
    const tail = stem(source.replace(/^(?:\.\.?\/)+|^[@~]\/?/, ""));
    const hits = imported.filter((f) => { const s = stem(f); return s === tail || s.endsWith(`/${tail}`) || s.endsWith(`/${tail}/index`); });
    if (hits.length === 1) return hits[0]!;
  }
  const named = imported.filter((f) => stem(f).split("/").pop() === name);
  return named.length === 1 ? named[0]! : null;
}

function hasOrigins(a: FileAnalysis): boolean {
  return a.functions.some((f) => f.calls.some((c) => c.argOrigins)) || a.classes.some((c) => c.methods.some((m) => m.calls.some((x) => x.argOrigins)));
}

/** One row per origin: the shortest hop chain kept. */
function dedupe<T extends { origin: ParamOrigin["origin"]; hops: unknown[] }>(leaves: T[]): T[] {
  const best = new Map<string, T>();
  for (const l of leaves) {
    const o = l.origin;
    const k = `${o.kind}|${"name" in o ? o.name : "value" in o ? o.value : ""}|${o.file}|${o.line}`;
    const prev = best.get(k);
    if (!prev || l.hops.length < prev.hops.length) best.set(k, l);
  }
  return [...best.values()];
}

/** Does a client route path declare parameter `name` (`/clubs/:id`, `/@:username`, `[id]`, `{id}`)? */
function namesParam(routePath: string, name: string): boolean {
  return routePath.split("/").some((seg) => {
    const m = /:([\w$]+)\??$/.exec(seg) ?? /^\[(?:\.\.\.)?([\w$]+)\]$/.exec(seg) ?? /^\{([\w$]+)\}$/.exec(seg);
    return m?.[1] === name;
  });
}

/** Path segments of a URL as written: no scheme or host, no query, no trailing slash. */
function segments(url: string): string[] {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "").split(/[?#]/)[0]!.split("/").filter(Boolean);
}

/**
 * The route parameter a slot binds: the client's segment and the route's
 * aligned from the end (the base each side adds sits at the front), then the
 * route's declared binding and type for that name.
 */
function routeParam(link: ApiRouteLink, url: string, slotText: string, routeAt: Map<string, RouteInfo & { filePath?: string }>): ParamOrigin["route"] | undefined {
  const client = segments(url);
  const at = client.findIndex((s) => s.includes(slotText));
  if (at < 0) return undefined;
  const fromEnd = client.length - 1 - at;
  const routeSegs = segments(link.routePath);
  const seg = routeSegs[routeSegs.length - 1 - fromEnd];
  const name = seg ? /^(?::([\w$]+)\??|\{([\w$]+)(?::[^}]*)?\}|<(?:[\w]+:)?([\w$]+)>|\[(?:\.\.\.)?([\w$]+)\])$/.exec(seg) : null;
  const param = name ? (name[1] ?? name[2] ?? name[3] ?? name[4])! : null;
  if (!param) return undefined;
  const route = routeAt.get(`${link.target}:${link.targetLine}`);
  const declared = route?.params?.find((p) => p.name === param);
  return {
    file: link.target,
    line: link.targetLine,
    method: link.method,
    path: link.routePath,
    param,
    ...(declared?.binding ? { binding: declared.binding } : {}),
    ...(declared?.type ? { type: declared.type } : {}),
  };
}
