import type { ApiRouteLink, CallArgOrigin, CallInfo, Confidence, FileAnalysis, FunctionInfo, ParamOrigin, RouteInfo, ScreenInfo, SymbolLink } from "../types/analysis.js";
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

export function computeParamOrigins(input: {
  analyses: readonly FileAnalysis[];
  symbolLinks: readonly SymbolLink[];
  apiRouteLinks: readonly ApiRouteLink[];
  routes: ReadonlyArray<RouteInfo & { filePath?: string }>;
  screens: readonly ScreenInfo[];
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
  for (const l of input.symbolLinks) {
    if (l.relation === "reference" || l.navigational || l.sourceSymbol.startsWith("(")) continue;
    const k = `${l.targetFile}::${l.targetSymbol}`;
    (callersOf.get(k) ?? callersOf.set(k, []).get(k)!).push(l);
  }
  const screensOf = new Map<string, ScreenInfo[]>();
  for (const s of input.screens) (screensOf.get(s.filePath) ?? screensOf.set(s.filePath, []).get(s.filePath)!).push(s);
  const linkOf = new Map<string, ApiRouteLink>();
  for (const l of input.apiRouteLinks) if (!linkOf.has(`${l.source}:${l.sourceLine}`)) linkOf.set(`${l.source}:${l.sourceLine}`, l);
  const routeAt = new Map<string, RouteInfo & { filePath?: string }>();
  for (const r of input.routes) if (r.filePath) routeAt.set(`${r.filePath}:${r.line}`, r);

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
      const arg: CallArgOrigin | undefined = dispatched ? undefined : call?.argOrigins?.find((a) => a.index === index && a.field === field);
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
      out.push({ origin: urlOrigin(o.kind, o.name, link.sourceFile, link.sourceLine), hops: [hop, ...hops], confidence: conf });
    }
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
        if (direct) {
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
