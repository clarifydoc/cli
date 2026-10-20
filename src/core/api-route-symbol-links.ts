import type { ApiRouteLink, FileAnalysis, SymbolDataAccess, SymbolLink } from "../types/analysis.js";

/**
 * Synthesize cross-tier symbol links from the api↔route join, so the Call
 * Traces graph crosses the HTTP boundary.
 *
 * `linkApiCallsToRoutes` joins an outbound api-call to the backend route
 * serving it — but as DATA (`apiRouteLinks`), not as call-graph edges. The
 * trace view is built purely from `symbolLinks`, so a frontend click handler's
 * trace dead-ended at `fetch()` and the backend handler's trace started fresh:
 * the two halves of the button→API→DB chain never met, and the transitive
 * entity back-propagation could not reach any frontend symbol.
 *
 * This pass turns each EXTRACTED/INFERRED api↔route link into a symbol link:
 *
 *   <frontend fn containing the call>  --"GET /api/orders"-->  <route handler>
 *
 * AMBIGUOUS links are skipped — the target is one of several candidate routes,
 * and a wrong edge would propagate entities into traces that never touch them
 * (same no-guess rule the symbol linker follows).
 *
 * Symbol resolution is structural, not language-specific:
 *  - source: innermost function/method whose span contains the call line;
 *  - target: innermost span at the route line (annotation-routed frameworks
 *    place the route ON the handler method — ASP.NET, Spring, CodeIgniter,
 *    Flask); else the route's `handler` name looked up in the target file,
 *    then project-wide when globally unique (Express's
 *    `router.post('/login', loginUser)` where loginUser lives in a
 *    controllers file).
 */

export interface SymbolSpan {
  symbol: string;
  line: number;
  endLine: number;
}

/** Function + qualified-method spans of one file, for innermost-span lookup. */
export function spansOf(a: FileAnalysis): SymbolSpan[] {
  const spans: SymbolSpan[] = [];
  for (const fn of a.functions ?? []) {
    spans.push({ symbol: fn.name, line: fn.line, endLine: fn.endLine });
  }
  for (const cls of a.classes ?? []) {
    for (const m of cls.methods ?? []) {
      spans.push({ symbol: `${cls.name}.${m.name}`, line: m.line, endLine: m.endLine });
    }
  }
  return spans;
}

/**
 * The narrowest span containing `line`, or `null` when no span covers it.
 *
 * Nested functions and methods produce overlapping spans; the narrowest one
 * is the symbol the reader is actually looking at.
 *
 * @param spans - Spans of one file, from `spansOf`
 * @param line - 1-based source line
 */
export function innermostAt(spans: SymbolSpan[], line: number): SymbolSpan | null {
  let best: SymbolSpan | null = null;
  let bestSpan = Infinity;
  for (const s of spans) {
    if (line >= s.line && line <= s.endLine) {
      const width = s.endLine - s.line;
      if (width < bestSpan) {
        bestSpan = width;
        best = s;
      }
    }
  }
  return best;
}

/** Spans in `spans` matching a bare handler name (`login` or `Auth.login`). */
export function byName(spans: SymbolSpan[], name: string): SymbolSpan[] {
  return spans.filter((s) => s.symbol === name || s.symbol.endsWith(`.${name}`));
}

/**
 * Turn every unambiguous api↔route link into a `SymbolLink` from the function
 * making the call to the handler serving the route (see the module comment).
 *
 * @param links - The `apiRouteLinks` produced by the route linker
 * @param analyses - Every file analysis, used to locate the symbols on both ends
 * @returns New symbol links, one per resolvable link; never mutates `links`
 */
export function synthesizeApiRouteSymbolLinks(
  links: ApiRouteLink[],
  analyses: FileAnalysis[],
): SymbolLink[] {
  if (links.length === 0) return [];

  const spanCache = new Map<string, SymbolSpan[]>();
  const fileOf = new Map<string, FileAnalysis>();
  for (const a of analyses) fileOf.set(a.filePath, a);
  const spansFor = (filePath: string): SymbolSpan[] => {
    let spans = spanCache.get(filePath);
    if (!spans) {
      const a = fileOf.get(filePath);
      spans = a ? spansOf(a) : [];
      spanCache.set(filePath, spans);
    }
    return spans;
  };

  // Project-wide handler-name index, built lazily — only Express-style repos
  // (handler defined in another file) ever need it.
  let globalByName: Map<string, Array<{ file: string; span: SymbolSpan }>> | null = null;
  const globalLookup = (name: string) => {
    if (!globalByName) {
      globalByName = new Map();
      for (const a of analyses) {
        for (const s of spansFor(a.filePath)) {
          const leaf = s.symbol.split(".").pop()!;
          let arr = globalByName.get(leaf);
          if (!arr) globalByName.set(leaf, (arr = []));
          arr.push({ file: a.filePath, span: s });
        }
      }
    }
    const candidates = globalByName.get(name) ?? [];
    // Unique-or-nothing: a name defined in several files is not guessable.
    return candidates.length === 1 ? candidates[0]! : null;
  };

  // A base-class method's request resolved for one subclass is that
  // subclass's inherited member making it: `MealPlanAPI.createOne` in the
  // subclass's file, not the `BaseCRUDAPI.createOne` every subclass shares —
  // else a click on any subclass would reach every subclass's route.
  let classes: Map<string, FileAnalysis[]> | null = null;
  const subclassMember = (link: ApiRouteLink & { viaSubclass?: string }, baseSymbol: string): { file: string; symbol: string; line: number } | null => {
    if (!link.viaSubclass) return null;
    if (!classes) {
      classes = new Map();
      for (const a of analyses) for (const c of a.classes ?? []) (classes.get(c.name) ?? classes.set(c.name, []).get(c.name)!).push(a);
    }
    const project = fileOf.get(link.source)?.projectId;
    const files = (classes.get(link.viaSubclass) ?? []).filter((a) => a.projectId === project);
    if (files.length !== 1) return null;
    const cls = files[0]!.classes.find((c) => c.name === link.viaSubclass)!;
    return { file: files[0]!.filePath, symbol: `${link.viaSubclass}.${baseSymbol.split(".").pop()}`, line: cls.line };
  };

  const out: SymbolLink[] = [];
  // One trace edge per subclass a fanned-out base request was resolved for.
  const hops = links.flatMap((l): Array<ApiRouteLink & { viaSubclass?: string }> => (l.viaSubclasses?.length ? l.viaSubclasses.map((v) => ({ ...l, viaSubclass: v })) : [l]));
  for (const link of hops) {
    if (link.confidence === "AMBIGUOUS") continue;

    let src = innermostAt(spansFor(link.source), link.sourceLine);
    if (!src) continue; // top-level call (module scope) — no trace symbol to anchor
    let sourceFile = link.source;
    let sourceLine = link.sourceLine;
    const member = subclassMember(link, src.symbol);
    if (member) {
      sourceFile = member.file;
      sourceLine = member.line;
      src = { symbol: member.symbol, line: member.line, endLine: member.line };
    }

    // Target: enclosing span at the route line, else handler-name resolution.
    let targetFile = link.target;
    let tgt = innermostAt(spansFor(link.target), link.targetLine);
    // The route the link landed on: by line and path, else the one route at
    // that line serving the call's method (the link's path can be the one the
    // call reached it by — a version alias, a forwarded prefix).
    const routeRow = () => {
      const atLine = (fileOf.get(link.target)?.routes ?? []).filter((r) => r.kind === "api" && r.line === link.targetLine);
      const byPath = atLine.find((r) => r.path === link.routePath);
      if (byPath) return byPath;
      const byMethod = atLine.filter((r) => !link.method || r.httpMethod === link.method);
      return byMethod.length === 1 ? byMethod[0] : undefined;
    };
    // The enclosing span is the handler for an annotated method (`@GetMapping`
    // on `getUser`); for a route REGISTERED inside a function — Go's
    // `func RegisterTaskRoutes(api) { Register(api, op, tasksRead) }`, an
    // Express `setupRoutes(app)` — it is the registrar, which never calls the
    // handler. The route's own `route:<METHOD> <path>` symbol links to what it
    // runs, so anchor there.
    if (tgt && link.handler && tgt.symbol.split(".").pop() !== link.handler.split(".").pop()) {
      const route = routeRow();
      if (route) tgt = { symbol: `route:${route.httpMethod ?? "USE"} ${route.path}`, line: route.line, endLine: route.line };
    }
    if (!tgt && link.handler) {
      const local = byName(spansFor(link.target), link.handler);
      if (local.length >= 1) {
        tgt = local[0]!; // same-file: first match (duplicates within a file are rare)
      } else {
        const global = globalLookup(link.handler);
        if (global) {
          tgt = global.span;
          targetFile = global.file;
        }
      }
    }
    if (!tgt) {
      // An inline handler (`router.get("/profiles/:u", auth.optional, async (req, res) => …)`,
      // the ordinary Express style) has no named span at the route line, and
      // `handler` holds the middleware's name. The route's own synthetic
      // symbol is still there: `symbol-linker` mints `route:<METHOD> <path>`
      // for every route and links it to whatever the route runs — the same
      // anchor `computeDataFlows` uses. Without it the trace, and every
      // screen's reach, stopped at the HTTP boundary of such backends.
      const route = routeRow();
      if (route) tgt = { symbol: `route:${route.httpMethod ?? "USE"} ${route.path}`, line: route.line, endLine: route.line };
    }
    if (!tgt) continue;
    // A self-edge (route handler calling its own endpoint) adds no trace value.
    if (sourceFile === targetFile && src.symbol === tgt.symbol) continue;

    out.push({
      sourceFile,
      sourceSymbol: src.symbol,
      sourceLine,
      callName: `${link.method ?? "HTTP"} ${link.routePath}`,
      targetFile,
      targetSymbol: tgt.symbol,
      targetLine: tgt.line,
      confidence: link.confidence,
      strategy: "api-route",
      relation: "http",
    });
  }
  return out;
}

/** Receiver heads naming the instance itself, across languages. */
const SELF_CALL = /^(?:this|self|super|\$this|Self|base|MyBase|Me)(?:\(\))?(?:\.|->|::)/;

/** Longest run of self-calls followed inside a base class to its per-subclass request. */
const MAX_INHERITED_DEPTH = 4;

/**
 * Calls that landed on an inherited method (`SymbolLink.viaType`) move onto
 * the receiver class's own member when the HTTP pass gave that member an edge
 * of its own (a base request resolved per subclass, above): the click on a
 * meal plan reaches the meal-plan route, not every CRUD route. A base method
 * that reaches such a request only through its own `this.list()` gets a copy
 * on the subclass (`UsersService.listAll` → `UsersService.list` → route),
 * made only where it leads to one; a method the subclass overrides is where
 * its self-call dispatches. Then the in-memory `viaType` fields are dropped
 * from every link. Mutates `links`; returns the copied edges.
 */
export function moveInheritedCallsToSubclasses(
  links: SymbolLink[],
  httpLinks: readonly SymbolLink[],
  analyses: readonly FileAnalysis[] = [],
): SymbolLink[] {
  const members = new Map<string, number>();
  for (const h of httpLinks) members.set(`${h.sourceFile}::${h.sourceSymbol}`, h.sourceLine);
  const added: SymbolLink[] = [];
  if (members.size > 0 && links.some((l) => l.viaType)) {
    const outgoing = new Map<string, SymbolLink[]>();
    for (const l of links) {
      if (l.relation === "reference") continue;
      const k = `${l.sourceFile}::${l.sourceSymbol}`;
      (outgoing.get(k) ?? outgoing.set(k, []).get(k)!).push(l);
    }
    const fileOf = new Map(analyses.map((a) => [a.filePath, a]));
    const classIn = (file: string, name: string) => fileOf.get(file)?.classes.find((c) => c.name === name);
    // `reaches`: the member makes the subclass's own request, or a copy leading to one.
    type Member = { symbol: string; line: number; reaches: boolean };
    const memo = new Map<string, Member | null>();
    const onSubclass = (cls: string, clsFile: string, baseFile: string, baseSymbol: string, depth: number): Member | null => {
      const method = baseSymbol.slice(baseSymbol.lastIndexOf(".") + 1);
      const symbol = `${cls}.${method}`;
      const own = members.get(`${clsFile}::${symbol}`);
      if (own !== undefined) return { symbol, line: own, reaches: true };
      const decl = classIn(clsFile, cls);
      const override = decl?.methods.find((m) => m.name === method);
      if (override) return depth > 0 ? { symbol, line: override.line, reaches: false } : null;
      const key = `${clsFile}::${symbol}`;
      if (memo.has(key)) return memo.get(key)!;
      memo.set(key, null);
      if (depth >= MAX_INHERITED_DEPTH || !baseSymbol.includes(".")) return null;
      const outs = outgoing.get(`${baseFile}::${baseSymbol}`) ?? [];
      const via = outs.map((o) => (SELF_CALL.test(o.callName) && o.targetSymbol.includes(".") ? onSubclass(cls, clsFile, o.targetFile, o.targetSymbol, depth + 1) : null));
      if (!via.some((v) => v?.reaches)) return null;
      const line = decl?.line ?? 1;
      outs.forEach((o, i) => {
        const v = via[i];
        added.push({ ...o, sourceFile: clsFile, sourceSymbol: symbol, sourceLine: line, ...(v ? { targetFile: clsFile, targetSymbol: v.symbol, targetLine: v.line } : {}) });
      });
      const hit = { symbol, line, reaches: true };
      memo.set(key, hit);
      return hit;
    };
    for (const l of links) {
      if (!l.viaType || !l.viaTypeFile) continue;
      const hit = onSubclass(l.viaType, l.viaTypeFile, l.targetFile, l.targetSymbol, 0);
      if (!hit?.reaches) continue;
      l.targetFile = l.viaTypeFile;
      l.targetSymbol = hit.symbol;
      l.targetLine = hit.line;
    }
  }
  for (const l of [...links, ...added]) {
    delete l.viaType;
    delete l.viaTypeFile;
  }
  return added;
}

/**
 * Synthesize publisher→consumer symbol links across a message broker, from the
 * queue attributions `attributeDataAccessToSymbols` produced: a publish and a
 * consume naming the SAME destination (exchange/queue/topic label) form a flow
 * edge, so a trace follows the message — click → API → handler → publish →
 * consumer → DB write. Labels that resolve only at runtime differ textually
 * and produce no edge (correct: no evidence they meet).
 */
export function synthesizeQueueSymbolLinks(rows: SymbolDataAccess[]): SymbolLink[] {
  const consumersByDest = new Map<string, SymbolDataAccess[]>();
  for (const r of rows) {
    if (r.access !== "queue-consume" || !r.datastore) continue;
    let arr = consumersByDest.get(r.datastore);
    if (!arr) consumersByDest.set(r.datastore, (arr = []));
    arr.push(r);
  }
  if (consumersByDest.size === 0) return [];

  const out: SymbolLink[] = [];
  for (const pub of rows) {
    if (pub.access !== "queue-publish" || !pub.datastore) continue;
    for (const con of consumersByDest.get(pub.datastore) ?? []) {
      if (pub.file === con.file && pub.symbol === con.symbol) continue;
      out.push({
        sourceFile: pub.file,
        sourceSymbol: pub.symbol,
        sourceLine: pub.sites[0]?.line ?? pub.symbolLine,
        callName: `MQ ${pub.datastore}`,
        targetFile: con.file,
        targetSymbol: con.symbol,
        targetLine: con.symbolLine,
        confidence: "INFERRED",
        strategy: "queue",
        relation: "mq",
      });
    }
  }
  return out;
}
