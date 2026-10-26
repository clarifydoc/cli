import type { EntryPointInfo,
  DataEffectKind,
  DataFlowPath,
  FileAnalysis,
  FlowHop,
  ReachedEffect,
  RouteInfo,
  ScreenInfo,
  SymbolDataAccess,
  SymbolLink,
  SymbolReachSummary,
} from "../types/analysis.js";
import { buildSymbolAdjacency, edgeKey, fileOf, keyOf, strongerFirst } from "./symbol-graph.js";
import { byName, innermostAt, spansOf, type SymbolSpan } from "./api-route-symbol-links.js";
import { byOrdinal } from "./ordinal.js";

/**
 * Transitive data-access propagation ("dataflow-lite").
 *
 * The engine already attributes each data-access effect (DB op, queue I/O,
 * outbound api-call) to the function that DIRECTLY performs it. This pass
 * answers the question direct attribution can't: which functions *transitively*
 * reach an effect through the call graph — so a controller that calls a
 * repository that writes the DB is shown to (transitively) touch the DB.
 *
 * It is call-graph reachability, NOT value/alias/branch-aware taint. Borrowed
 * from semgrep's dataflow model only in spirit (propagate an effect along the
 * graph as a per-function summary); it runs over the SAME symbol-link edges the
 * Call Traces / trace-impact passes walk (regular links + synthetic HTTP/MQ
 * links), reusing {@link buildSymbolAdjacency}.
 *
 * Honest limits: a conditionally-executed call is treated as always reachable
 * (over-approximates "reaches a DB write"); recursion/cycles collapse (all
 * members of a cycle share one reach set); it under-approximates where the call
 * graph is incomplete (unresolved dynamic dispatch). Transitive edges are marked
 * INFERRED; direct effects stay EXTRACTED. A caller that reaches an effect only
 * across a name-guess link (an AMBIGUOUS `unique-global*` / `route-scan` edge)
 * is AMBIGUOUS — a path is as sure as its weakest link, and one guessed edge
 * must not read like a chain of resolved calls.
 */

/** Depth cap on transitive propagation (mirrors blast-radius's depth-8 idiom). */
const MAX_DEPTH = 8;
/** Per-symbol stored-effects cap; `effectCounts` keeps the true totals. */
const EFFECTS_CAP = 32;

/** An outbound api-call attributed to its containing symbol (see attributeApiCallsToSymbols). */
export interface SymbolApiCallAccess {
  file: string;
  symbol: string;
  /** The api target/URL the call reaches. */
  resource: string;
}

/**
 * Attribute each outbound `api-call` data source to the function/method that
 * contains it (innermost enclosing span), so outbound HTTP participates in the
 * reach propagation exactly as DB/queue effects do. Mirrors the symbol keying of
 * `attributeDataAccessToSymbols` (`Class.method` | `fn`). Top-level calls with
 * no enclosing symbol are dropped (no trace symbol to attach to); duplicate
 * (file, symbol, resource) rows are collapsed. No new parsing — the api-call
 * data sources are already extracted per file. `projectCalls` are the calls a
 * project pass added with no per-file row (client proxies, gRPC stubs,
 * generated clients); a row at a line that already has a per-file api-call is
 * skipped, so those keep the target they were extracted with.
 */
export function attributeApiCallsToSymbols(
  analyses: FileAnalysis[],
  projectCalls: ReadonlyArray<{ filePath?: string; line: number; target?: string | null }> = [],
): SymbolApiCallAccess[] {
  const out: SymbolApiCallAccess[] = [];
  const seen = new Set<string>();
  const perFileLines = new Set<string>();
  const spansByFile = new Map<string, ReturnType<typeof spansOf>>();
  const attribute = (file: string, spans: ReturnType<typeof spansOf>, line: number, target: string | null | undefined) => {
    const resource = (target ?? "").trim();
    if (!resource) return;
    const at = innermostAt(spans, line);
    if (!at) return; // module-level call — no trace symbol to attach to
    const key = `${file} ${at.symbol} ${resource}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file, symbol: at.symbol, resource });
  };
  for (const a of analyses) {
    const spans = spansOf(a);
    if (spans.length === 0) continue;
    spansByFile.set(a.filePath, spans);
    for (const ds of a.dataSources ?? []) {
      if (ds.kind !== "api-call") continue;
      perFileLines.add(`${a.filePath}:${ds.line}`);
      attribute(a.filePath, spans, ds.line, ds.target);
    }
  }
  for (const c of projectCalls) {
    if (!c.filePath || perFileLines.has(`${c.filePath}:${c.line}`)) continue;
    const spans = spansByFile.get(c.filePath);
    if (spans) attribute(c.filePath, spans, c.line, c.target);
  }
  return out;
}

/**
 * Inputs to `computeSymbolReach`: the call graph and every directly attributed
 * effect that propagation starts from.
 */
export interface SymbolReachInput {
  symbolLinks: SymbolLink[];
  /** DB + queue effects, direct-attributed (from attributeDataAccessToSymbols). */
  symbolDataAccess: SymbolDataAccess[];
  /** Outbound api-call effects, direct-attributed (from attributeApiCallsToSymbols). */
  apiCallAccess?: SymbolApiCallAccess[];
  /**
   * `${file}::${line}::${entity}` (lowercased; a write wins), else
   * `${file}::${line}`, → read/write for DB access sites the plugins could
   * classify (ORM verb) plus any `db-write` mutation line. Splits the coarse
   * `db` effect into `db-read`/`db-write`; a site absent from the map stays the
   * coarse `db` effect (honest "unclassified"). Built in the analyzer so core
   * never inspects method names.
   */
  dbAccessByLine?: Map<string, "read" | "write">;
  /**
   * Reads whose table is a type parameter of the performing method's class
   * (see `attributeGenericDataAccess`). Each is bound along the call chain
   * through the links' `typeArgs` and becomes an ordinary effect at the first
   * caller that closes the parameter over a concrete type.
   */
  genericDataAccess?: GenericDataAccess[];
  /** A class's own type parameters, in order (`file`, class name). */
  typeParametersOf?: (file: string, className: string) => readonly string[] | undefined;
  /** The resource name a bound type argument reaches as (the ER node it matches). */
  canonicalEntity?: (raw: string) => string;
}

/** A database access whose entity is the `parameter`-th type parameter of the class declaring `symbol`. */
export interface GenericDataAccess {
  file: string;
  symbol: string;
  parameter: number;
  access?: "read" | "write";
}

/**
 * Attribute each `database` row whose table is a class type parameter
 * (`DataSourceInfo.entityTypeParameter`) to its innermost method, with the
 * parameter's position in that method's class.
 */
export function attributeGenericDataAccess(analyses: FileAnalysis[]): GenericDataAccess[] {
  const out: GenericDataAccess[] = [];
  for (const a of analyses) {
    const rows = (a.dataSources ?? []).filter((ds) => ds.kind === "database" && ds.entityTypeParameter);
    if (rows.length === 0) continue;
    const spans = spansOf(a);
    for (const ds of rows) {
      const at = innermostAt(spans, ds.line);
      const dot = at ? at.symbol.lastIndexOf(".") : -1;
      if (!at || dot <= 0) continue;
      const cls = a.classes.find((c) => c.name === at.symbol.slice(0, dot));
      const parameter = cls?.typeParameters?.indexOf(ds.entityTypeParameter!) ?? -1;
      if (parameter < 0) continue;
      out.push({ file: a.filePath, symbol: at.symbol, parameter, ...(ds.access ? { access: ds.access } : {}) });
    }
  }
  return out;
}

interface Seed {
  key: string;
  kind: DataEffectKind;
  resource: string;
  originFile: string;
  originSymbol: string;
  /** Hops from the origin already walked (a bound generic access); 0 for a direct one. */
  dist?: number;
  /** For a bound generic access: the hops below `key` down to the performing method. */
  tail?: FlowHop[];
}

/** `List<Club>?`, `League.Club[]` → `Club`; null when not a plain type name. */
function boundTypeName(arg: string): string | null {
  const bare = arg.replace(/<.*$/s, "").replace(/[?\[\]\s]+$/, "").split(/\.|::/).pop() ?? "";
  return /^[A-Z]\w*$/.test(bare) ? bare : null;
}

const symbolOf = (key: string): string => key.slice(key.indexOf("::") + 2);

/**
 * Compute, for every symbol, the set of data-access effects it reaches through
 * the call graph (directly at distance 0, transitively at distance ≥ 1).
 */
export function computeSymbolReach(input: SymbolReachInput): SymbolReachSummary[] {
  return computeSymbolReachWithWitness(input).reach;
}

/** Witness paths of a reach computation (see `computeSymbolReachWithWitness`). */
export interface ReachWitness {
  /**
   * The call path by which the symbol `key` reaches the effect (kind,
   * resource): `key` first, the performing function last, each hop but the
   * last with the line of the call that leads on. Null when it does not reach it.
   */
  pathOf(key: string, kind: DataEffectKind, resource: string): FlowHop[] | null;
}

/**
 * `computeSymbolReach`, keeping the walk's parent pointers so a reached effect
 * can name the functions it passes through — "reaches `audit_log` in 4 hops"
 * is checkable only when the 4 are named.
 */
export function computeSymbolReachWithWitness(input: SymbolReachInput): { reach: SymbolReachSummary[]; witness: ReachWitness } {
  const { reverse, confidence: edgeConfidence, callLine } = buildSymbolAdjacency(input.symbolLinks);
  // (kind, resource) → reached symbol → the callee it was reached from.
  const parents = new Map<string, Map<string, string | null>>();
  // (kind, resource) → a bound generic access's root → the hops below it.
  const tails = new Map<string, Map<string, FlowHop[]>>();
  const witness: ReachWitness = {
    pathOf(key, kind, resource) {
      const parent = parents.get(`${kind} ${resource}`);
      if (!parent?.has(key)) return null;
      const hops: FlowHop[] = [];
      for (let cur: string | null | undefined = key; cur && hops.length <= MAX_DEPTH; cur = parent.get(cur)) {
        const next = parent.get(cur);
        const hop: FlowHop = { file: fileOf(cur), symbol: symbolOf(cur) };
        const line = next ? callLine.get(edgeKey(cur, next)) : undefined;
        if (line !== undefined) hop.line = line;
        hops.push(hop);
        const tail = next ? undefined : tails.get(`${kind} ${resource}`)?.get(cur);
        if (tail) {
          const below = callLine.get(edgeKey(cur, keyOf(tail[0]!.file, tail[0]!.symbol)));
          if (below !== undefined) hop.line = below;
          hops.push(...tail.map((h) => ({ ...h })));
        }
      }
      return hops;
    },
  };
  // `reverse` walks callee → caller; the link it follows is caller → callee.
  const guessed = (callee: string, caller: string): boolean =>
    edgeConfidence.get(edgeKey(caller, callee)) === "AMBIGUOUS";
  const dbAccessByLine = input.dbAccessByLine;

  // ── Seeds: every DIRECT effect, keyed to its containing symbol ──
  const seeds: Seed[] = [];
  for (const row of input.symbolDataAccess) {
    const key = keyOf(row.file, row.symbol);
    if (row.access === "queue-publish" || row.access === "queue-consume") {
      const resource = (row.datastore ?? row.entity ?? "").trim();
      if (resource) {
        seeds.push({ key, kind: row.access, resource, originFile: row.file, originSymbol: row.symbol });
      }
    } else {
      const resource = (row.entity ?? "").trim();
      if (resource) {
        // Split the coarse `db` effect by the read/write classification of each
        // call site (a symbol that both reads and writes an entity seeds both).
        const kinds = new Set<DataEffectKind>();
        for (const site of row.sites) {
          const acc = dbAccessByLine?.get(`${row.file}::${site.line}::${resource.toLowerCase()}`) ?? dbAccessByLine?.get(`${row.file}::${site.line}`);
          kinds.add(acc === "write" ? "db-write" : acc === "read" ? "db-read" : "db");
        }
        if (kinds.size === 0) kinds.add("db");
        for (const kind of kinds) {
          seeds.push({ key, kind, resource, originFile: row.file, originSymbol: row.symbol });
        }
      }
    }
  }
  for (const a of input.apiCallAccess ?? []) {
    const resource = (a.resource ?? "").trim();
    if (resource) {
      seeds.push({ key: keyOf(a.file, a.symbol), kind: "api-call", resource, originFile: a.file, originSymbol: a.symbol });
    }
  }
  if (input.genericDataAccess?.length) seeds.push(...bindGenericAccess(input, reverse, callLine, guessed));
  if (seeds.length === 0) return { reach: [], witness };

  // Group by (kind, resource) so one reverse-BFS covers every function that
  // reaches that effect — bounding the number of BFS runs to the count of
  // distinct data resources (the scaling guarantee).
  const groups = new Map<string, Seed[]>();
  for (const s of seeds) {
    const gk = `${s.kind} ${s.resource}`;
    let g = groups.get(gk);
    if (!g) groups.set(gk, (g = []));
    g.push(s);
  }

  const bySymbol = new Map<string, ReachedEffect[]>();
  const addEffect = (key: string, eff: ReachedEffect): void => {
    let arr = bySymbol.get(key);
    if (!arr) bySymbol.set(key, (arr = []));
    arr.push(eff);
  };

  for (const group of groups.values()) {
    const { kind, resource } = group[0]!;
    // Multi-source reverse-BFS: roots (direct performers) at distance 0; each
    // reached symbol records the effect at its shortest hop, attributed to the
    // nearest origin. The visited set terminates cycles. Two tiers: resolved
    // links first, so a caller reachable without a guess is recorded that way;
    // then the walk resumes from everything reached and may cross guessed
    // links, and whatever it adds is AMBIGUOUS.
    const visited = new Set<string>();
    const parent = new Map<string, string | null>();
    parents.set(`${kind} ${resource}`, parent);
    type Hop = { key: string; dist: number; oFile: string; oSym: string; guessed: boolean };
    const reached: Hop[] = [];
    // Roots that start further out (bound generic accesses) join the queue when
    // its frontier reaches their distance, so every symbol keeps its shortest one.
    const pending: Array<Hop & { tail?: FlowHop[] }> = [];
    const walk = (queue: Hop[], allowGuess: boolean): void => {
      let qi = 0;
      let pi = 0;
      while (qi < queue.length || pi < pending.length) {
        while (pi < pending.length && (qi >= queue.length || pending[pi]!.dist <= queue[qi]!.dist)) {
          const root = pending[pi++]!;
          if (visited.has(root.key)) continue;
          visited.add(root.key);
          parent.set(root.key, null);
          if (root.tail) {
            let t = tails.get(`${kind} ${resource}`);
            if (!t) tails.set(`${kind} ${resource}`, (t = new Map()));
            t.set(root.key, root.tail);
          }
          queue.splice(qi, 0, { key: root.key, dist: root.dist, oFile: root.oFile, oSym: root.oSym, guessed: false });
        }
        if (qi >= queue.length) break;
        const cur = queue[qi++]!;
        if (!allowGuess || cur.guessed) reached.push(cur);
        if (cur.dist >= MAX_DEPTH) continue;
        for (const next of reverse.get(cur.key) ?? []) {
          if (visited.has(next)) continue;
          const viaGuess = guessed(cur.key, next);
          if (viaGuess && !allowGuess) continue;
          visited.add(next);
          parent.set(next, cur.key);
          queue.push({ key: next, dist: cur.dist + 1, oFile: cur.oFile, oSym: cur.oSym, guessed: cur.guessed || viaGuess });
        }
      }
    };
    const roots: Hop[] = [];
    for (const s of group) {
      if (s.dist) {
        pending.push({ key: s.key, dist: s.dist, oFile: s.originFile, oSym: s.originSymbol, guessed: false, ...(s.tail ? { tail: s.tail } : {}) });
      } else if (!visited.has(s.key)) {
        visited.add(s.key);
        parent.set(s.key, null);
        roots.push({ key: s.key, dist: 0, oFile: s.originFile, oSym: s.originSymbol, guessed: false });
      }
    }
    pending.sort((a, b) => a.dist - b.dist);
    walk(roots, false);
    pending.length = 0;
    walk([...reached], true);
    for (const cur of reached) {
      addEffect(cur.key, {
        kind,
        resource,
        originFile: cur.oFile,
        originSymbol: cur.oSym,
        distance: cur.dist,
        confidence: cur.guessed ? "AMBIGUOUS" : cur.dist === 0 ? "EXTRACTED" : "INFERRED",
      });
    }
  }

  // ── Assemble per-symbol summaries ──
  const out: SymbolReachSummary[] = [];
  for (const [key, effects] of bySymbol) {
    effects.sort(
      (a, b) =>
        a.distance - b.distance ||
        byOrdinal(a.kind, b.kind) ||
        byOrdinal(a.resource, b.resource),
    );
    const effectCounts: Partial<Record<DataEffectKind, number>> = {};
    for (const e of effects) effectCounts[e.kind] = (effectCounts[e.kind] ?? 0) + 1;
    out.push({
      file: fileOf(key),
      symbol: symbolOf(key),
      effects: effects.slice(0, EFFECTS_CAP),
      effectCounts,
      hasTransitive: effects.some((e) => e.distance >= 1),
    });
  }
  out.sort((a, b) => byOrdinal(a.file, b.file) || byOrdinal(a.symbol, b.symbol));
  return { reach: out, witness };
}

/**
 * Bind each generic access (a read of `TModel` in `Repository<TModel>.All`)
 * along the reverse call graph: a call inside the class keeps the parameter, a
 * link whose `typeArgs` close it moves it to the caller's own parameter or —
 * once it names a type — ends the walk with an ordinary seed at that caller,
 * carrying the hops walked. A caller that states no binding ends nothing: the
 * table is never guessed. Guessed (AMBIGUOUS) links are not crossed.
 */
function bindGenericAccess(
  input: SymbolReachInput,
  reverse: ReadonlyMap<string, string[]>,
  callLine: ReadonlyMap<string, number>,
  guessed: (callee: string, caller: string) => boolean,
): Seed[] {
  const bindings = new Map<string, Array<Array<string | null>>>();
  for (const l of input.symbolLinks) {
    if (!l.typeArgs) continue;
    const ek = edgeKey(keyOf(l.sourceFile, l.sourceSymbol), keyOf(l.targetFile, l.targetSymbol));
    let list = bindings.get(ek);
    if (!list) bindings.set(ek, (list = []));
    list.push(l.typeArgs);
  }
  const classOf = (key: string): string | null => {
    const sym = symbolOf(key);
    const dot = sym.lastIndexOf(".");
    return dot > 0 ? sym.slice(0, dot) : null;
  };
  const best = new Map<string, Seed>();
  for (const g of input.genericDataAccess ?? []) {
    const kind: DataEffectKind = g.access === "write" ? "db-write" : g.access === "read" ? "db-read" : "db";
    type State = { key: string; param: number; dist: number; prev: State | null };
    const start: State = { key: keyOf(g.file, g.symbol), param: g.parameter, dist: 0, prev: null };
    const seen = new Set<string>([`${start.key}\0${start.param}`]);
    const queue: State[] = [start];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi]!;
      if (cur.dist + 1 > MAX_DEPTH) continue;
      const curClass = classOf(cur.key);
      for (const caller of reverse.get(cur.key) ?? []) {
        if (guessed(cur.key, caller)) continue;
        const callerClass = classOf(caller);
        const bound = bindings.get(edgeKey(caller, cur.key));
        const outcomes: Array<{ param: number } | { type: string }> = [];
        if (bound) {
          const params = callerClass ? input.typeParametersOf?.(fileOf(caller), callerClass) ?? [] : [];
          for (const args of bound) {
            const arg = args[cur.param];
            if (!arg) continue;
            const own = params.indexOf(arg);
            if (own >= 0) outcomes.push({ param: own });
            else {
              const type = boundTypeName(arg);
              if (type) outcomes.push({ type });
            }
          }
        } else if (callerClass && callerClass === curClass && fileOf(caller) === fileOf(cur.key)) {
          outcomes.push({ param: cur.param });
        }
        for (const o of outcomes) {
          if ("param" in o) {
            const sk = `${caller}\0${o.param}`;
            if (seen.has(sk)) continue;
            seen.add(sk);
            queue.push({ key: caller, param: o.param, dist: cur.dist + 1, prev: cur });
            continue;
          }
          const resource = input.canonicalEntity?.(o.type) ?? o.type;
          const id = `${caller}\0${kind}\0${resource}`;
          if ((best.get(id)?.dist ?? Infinity) <= cur.dist + 1) continue;
          const tail: FlowHop[] = [];
          for (let h: State | null = cur; h; h = h.prev) {
            const hop: FlowHop = { file: fileOf(h.key), symbol: symbolOf(h.key) };
            const line = h.prev ? callLine.get(edgeKey(h.key, h.prev.key)) : undefined;
            if (line !== undefined) hop.line = line;
            tail.push(hop);
          }
          best.set(id, { key: caller, kind, resource, originFile: g.file, originSymbol: g.symbol, dist: cur.dist + 1, tail });
        }
      }
    }
  }
  return [...best.values()];
}

/**
 * Total emitted source→sink rows cap (a convenience view; symbolReach holds
 * the full data). Past it every entry keeps its closest effects, the same
 * number each — never the first entries' rows and nothing for the rest.
 */
const FLOWS_CAP = 20_000;

/**
 * Derive source→sink rows: each API route's handler symbol, resolved to a
 * reach summary, yields one row per reached effect. The payoff query — e.g.
 * filter on `effect === "db-write"` for "handlers that reach a DB write".
 * Deduped by (entry, effect, resource) keeping the shortest distance.
 *
 * Route-handler resolution takes the route's own synthetic `route:<METHOD>
 * <path>` symbol when the reach summary has one, and otherwise mirrors
 * trace-impact / synthesizeApiRouteSymbolLinks: innermost span at the route
 * line, else the handler name in the declaring file, else a project-wide
 * unique-or-nothing name lookup.
 */
/** How an entry point reads in a data flow's label. */
const ENTRY_LABEL: Record<EntryPointInfo["kind"], string> = {
  "mcp-tool": "MCP tool",
  "editor-command": "command",
  "lm-tool": "LM tool",
  "cli-command": "CLI",
  "scheduled-job": "scheduled job",
  "message-consumer": "consumer of",
};

export function computeDataFlows(
  reach: SymbolReachSummary[],
  routes: Array<RouteInfo & { filePath: string }>,
  analyses: FileAnalysis[],
  screens: readonly Pick<ScreenInfo, "name" | "filePath" | "routePath" | "renderedBy" | "codeFiles">[] = [],
  witness?: ReachWitness,
  /** MCP tools, editor and CLI commands (`ProjectAnalysis.entryPoints`): entries when they name their handler. */
  entryPoints: ReadonlyArray<EntryPointInfo & { filePath: string }> = [],
): DataFlowPath[] {
  // The hop list when it says more than the entry itself (distance ≥ 1).
  const viaOf = (key: string, e: ReachedEffect): { via?: FlowHop[] } => {
    if (!witness || e.distance === 0) return {};
    const via = witness.pathOf(key, e.kind, e.resource);
    return via && via.length > 1 ? { via } : {};
  };
  const reachByKey = new Map<string, SymbolReachSummary>();
  for (const r of reach) reachByKey.set(keyOf(r.file, r.symbol), r);
  if (reachByKey.size === 0) return [];

  const analysisOf = new Map<string, FileAnalysis>();
  for (const a of analyses) analysisOf.set(a.filePath, a);
  const spanCache = new Map<string, SymbolSpan[]>();
  const spansFor = (filePath: string): SymbolSpan[] => {
    let spans = spanCache.get(filePath);
    if (!spans) {
      const a = analysisOf.get(filePath);
      spans = a ? spansOf(a) : [];
      spanCache.set(filePath, spans);
    }
    return spans;
  };
  // Project-wide handler-name index (unique-or-nothing), built lazily.
  let globalByName: Map<string, string[]> | null = null;
  const globalLookup = (name: string): string | null => {
    if (!globalByName) {
      globalByName = new Map();
      for (const a of analyses) {
        for (const s of spansFor(a.filePath)) {
          const leaf = s.symbol.split(".").pop()!;
          let arr = globalByName.get(leaf);
          if (!arr) globalByName.set(leaf, (arr = []));
          arr.push(keyOf(a.filePath, s.symbol));
        }
      }
    }
    const candidates = globalByName.get(name) ?? [];
    return candidates.length === 1 ? candidates[0]! : null;
  };

  const seen = new Set<string>();
  const out: DataFlowPath[] = [];
  for (const route of routes) {
    if (route.kind !== "api") continue;
    const spans = spansFor(route.filePath);

    // The route's own synthetic symbol first. `symbol-linker` mints
    // `route:<METHOD> <path>` for every route and links it to whatever the
    // route dispatches to, so this key exists whether or not the handler has a
    // name — and it is the route, rather than something the route is merely
    // near. Without it, a framework that takes an inline handler
    // (`router.get("/articles", auth.optional, async (req, res) => …)`, the
    // ordinary Express style) resolved to nothing at all: there is no function
    // span at the route's line and `handler` holds the middleware's name, so
    // both fallbacks below miss. That showed up as
    // `clarifydoc_data_flows` returning "no data flows" on a repository whose
    // reach summary already carried the effects, one lookup away.
    let key: string | null = null;
    const synthetic = keyOf(route.filePath, `route:${route.httpMethod ?? "USE"} ${route.path}`);
    if (reachByKey.has(synthetic)) {
      key = synthetic;
    } else {
      const at = innermostAt(spans, route.line);
      if (at) {
        key = keyOf(route.filePath, at.symbol);
      } else if (route.handler) {
        const local = byName(spans, route.handler);
        if (local.length >= 1) key = keyOf(route.filePath, local[0]!.symbol);
        else key = globalLookup(route.handler);
      }
    }
    if (!key) continue;
    const r = reachByKey.get(key);
    if (!r) continue;

    const entryLabel = `${route.httpMethod ?? ""} ${route.path}`.trim();
    for (const e of r.effects) {
      const dk = `${route.filePath} ${entryLabel} ${e.kind} ${e.resource}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      out.push({
        entryKind: "route",
        entryLabel,
        entryFile: route.filePath,
        effect: e.kind,
        resource: e.resource,
        distance: e.distance,
        confidence: e.confidence,
        ...viaOf(key, e),
      });
    }
  }

  // Screens: the mission question — which screen ends up touching which
  // table. A screen is its page file; it reaches whatever any of that file's
  // functions reach (its JSX children are calls, and the cross-tier HTTP links
  // carry the reach on into the backend), at the shortest distance. A
  // file's `(reference)` pseudo-symbol is left out: importing a module runs
  // none of its effects. A page with no functions (a JSP, a template) reaches
  // through its `<component>` pseudo-symbol, which its tags' events anchor on;
  // the frontend route the screen is (a Web Flow flow, whose actions run on its
  // own synthetic symbol) reaches what the page does.
  const frontendKeys = new Map<string, string[]>();
  for (const r of routes) {
    if (r.kind !== "frontend") continue;
    const k = keyOf(r.filePath, `route:${r.httpMethod ?? "USE"} ${r.path}`);
    if (reachByKey.has(k)) (frontendKeys.get(r.path) ?? frontendKeys.set(r.path, []).get(r.path)!).push(k);
  }
  for (const screen of screens) {
    const keys = [
      ...[...spansFor(screen.filePath).map((s) => s.symbol), "<component>"].map((symbol) => keyOf(screen.filePath, symbol)),
      // Its code-behind (a Delphi form's unit): every function there is the form's.
      ...(screen.codeFiles ?? []).filter((f) => f !== screen.filePath).flatMap((f) => spansFor(f).map((s) => keyOf(f, s.symbol))),
      ...(screen.routePath ? (frontendKeys.get(screen.routePath) ?? []) : []),
      // A server-rendered template shows what the routes rendering it load.
      ...(screen.renderedBy ?? []).map((r) => keyOf(r.filePath, `route:${r.method ?? "USE"} ${r.path}`)),
    ];
    const best = new Map<string, { e: ReachedEffect; key: string }>();
    for (const spanKey of keys) {
      const r = reachByKey.get(spanKey);
      for (const e of r?.effects ?? []) {
        const ek = `${e.kind} ${e.resource}`;
        const prev = best.get(ek)?.e;
        // The surest path first, then the shortest.
        const order = prev ? strongerFirst(e.confidence, prev.confidence) || e.distance - prev.distance : -1;
        if (order < 0) best.set(ek, { e, key: spanKey });
      }
    }
    if (best.size === 0) continue;
    const entryLabel = screen.routePath ? `${screen.name} ${screen.routePath}` : screen.name;
    for (const { e, key } of best.values()) {
      const dk = `${screen.filePath} screen ${entryLabel} ${e.kind} ${e.resource}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      out.push({
        entryKind: "screen",
        entryLabel,
        entryFile: screen.filePath,
        effect: e.kind,
        resource: e.resource,
        distance: e.distance,
        confidence: e.confidence,
        ...viaOf(key, e),
      });
    }
  }
  // Commands and tools: what an agent's tool call or a CLI subcommand ends up writing. Only a
  // registration that names its handler: an inline one's calls belong to the function around it.
  for (const ep of entryPoints) {
    if (!ep.handler) continue;
    const local = byName(spansFor(ep.filePath), ep.handler);
    const key = local.length >= 1 ? keyOf(ep.filePath, local[0]!.symbol) : globalLookup(ep.handler);
    const r = key ? reachByKey.get(key) : undefined;
    if (!key || !r) continue;
    const entryLabel = `${ENTRY_LABEL[ep.kind]} ${ep.name}`;
    for (const e of r.effects) {
      const dk = `${ep.filePath} command ${entryLabel} ${e.kind} ${e.resource}`;
      if (seen.has(dk)) continue;
      seen.add(dk);
      out.push({ entryKind: "command", entryLabel, entryFile: ep.filePath, effect: e.kind, resource: e.resource, distance: e.distance, confidence: e.confidence, ...viaOf(key, e) });
    }
  }
  return sortFlows(fairCap(out, FLOWS_CAP));
}

/** At most `cap` rows: each entry's closest effects, as many per entry as fit for all. */
export function fairCap(flows: DataFlowPath[], cap: number): DataFlowPath[] {
  if (flows.length <= cap) return flows;
  const byEntry = new Map<string, DataFlowPath[]>();
  for (const f of flows) {
    const k = `${f.entryKind} ${f.entryFile} ${f.entryLabel}`;
    (byEntry.get(k) ?? byEntry.set(k, []).get(k)!).push(f);
  }
  const groups = [...byEntry.values()];
  for (const g of groups) g.sort((a, b) => a.distance - b.distance);
  // The largest per-entry quota whose total fits.
  let lo = 0;
  let hi = Math.max(...groups.map((g) => g.length));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (groups.reduce((n, g) => n + Math.min(g.length, mid), 0) <= cap) lo = mid;
    else hi = mid - 1;
  }
  return groups.flatMap((g) => g.slice(0, lo));
}

/** Sort flows in place by entry label, effect and resource, for stable output. */
function sortFlows(flows: DataFlowPath[]): DataFlowPath[] {
  return flows.sort(
    (a, b) =>
      byOrdinal(a.entryLabel, b.entryLabel) ||
      byOrdinal(a.effect, b.effect) ||
      byOrdinal(a.resource, b.resource),
  );
}
