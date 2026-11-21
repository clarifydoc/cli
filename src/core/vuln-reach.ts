import type { EntryPointInfo, ExternalPackage, FileAnalysis, RouteInfo, SymbolLink, VulnerableReach } from "../types/analysis.js";
import { buildSymbolAdjacency, edgeKey, keyOf } from "./symbol-graph.js";
import { inlineRouteDefinitions } from "./route-symbol.js";
import { spansOf, type SymbolSpan } from "./api-route-symbol-links.js";
import { isTestFile } from "./test-file-detector.js";

/**
 * Whether the project reaches the functions an advisory states as vulnerable. Post-analysis: the facts are
 * the calls and imports every file already carries (`xlib.Unmarshal(…)` under `import "…/xlib"`) and the
 * symbol links; nothing is read per file.
 *
 * A call is a hit when its head is a name the file imports FROM the advisory's import path and its member is
 * a listed symbol. A hit is `reachable` when the symbol links lead back from its function to a route handler
 * or entry point (shortest chain, capped, never across a name-guess edge); `called` when they do not. A
 * listed method (`Decoder.Decode`) is not named by a package-qualified call, so an advisory stating one that
 * nothing else reaches is `not-judged`, never `not-called`. An advisory with no function data gets no
 * verdict at all.
 */
const MAX_DEPTH = 8;
const MAX_CALLS = 5;

interface Root {
  label: string;
}

export function attachVulnerableReach(
  packages: readonly ExternalPackage[],
  analyses: readonly FileAnalysis[],
  symbolLinks: readonly SymbolLink[],
  routes: ReadonlyArray<RouteInfo & { filePath: string }>,
  entryPoints: ReadonlyArray<EntryPointInfo & { filePath: string }> = [],
): number {
  const wanted = packages.filter((p) => p.advisories?.some((a) => a.functions?.length));
  if (wanted.length === 0) return 0;

  const spansCache = new Map<string, SymbolSpan[]>();
  const spansFor = (a: FileAnalysis): SymbolSpan[] => {
    let s = spansCache.get(a.filePath);
    if (!s) spansCache.set(a.filePath, (s = spansOf(a)));
    return s;
  };
  const analysisOf = new Map(analyses.map((a) => [a.filePath, a] as const));
  // The project's functions by leaf name, for a handler declared in another file (`intake.Handle`): the one
  // function of that name, as the data-flow pass reads it — never one of several.
  let byLeaf: Map<string, string[]> | null = null;
  const resolveHandler = (file: string, name: string): string | null => {
    const leaf = name.split(".").pop()!;
    const a = analysisOf.get(file);
    if (a) {
      const spans = spansFor(a);
      if (spans.some((s) => s.symbol === name)) return keyOf(file, name);
      const here = spans.filter((s) => s.symbol.split(".").pop() === leaf);
      if (here.length === 1) return keyOf(file, here[0]!.symbol);
    }
    if (!byLeaf) {
      byLeaf = new Map();
      for (const x of analyses) {
        for (const s of spansFor(x)) {
          const l = s.symbol.split(".").pop()!;
          (byLeaf.get(l) ?? byLeaf.set(l, []).get(l)!).push(keyOf(x.filePath, s.symbol));
        }
      }
    }
    const all = byLeaf.get(leaf) ?? [];
    return all.length === 1 ? all[0]! : null;
  };

  // Where a walk may stop: a route's handler (or its inline body), an entry point's handler.
  const roots = new Map<string, Root>();
  for (const r of routes) {
    if (r.kind !== "api" || !r.handler) continue;
    const key = resolveHandler(r.filePath, r.handler);
    if (key && !roots.has(key)) roots.set(key, { label: `${r.httpMethod ?? "ANY"} ${r.path}`.trim() });
  }
  const inlineByFile = new Map<string, Array<{ symbol: string; line: number; endLine: number; label: string }>>();
  const routeAt = new Map(routes.map((r) => [`${r.filePath}\0${r.line}`, r] as const));
  for (const d of inlineRouteDefinitions({ routeMap: routes })) {
    const route = routeAt.get(`${d.file}\0${d.line}`);
    const label = route ? `${route.httpMethod ?? "ANY"} ${route.path}`.trim() : d.symbol;
    (inlineByFile.get(d.file) ?? inlineByFile.set(d.file, []).get(d.file)!).push({ symbol: d.symbol, line: d.line, endLine: d.endLine, label });
  }
  for (const [file, defs] of inlineByFile) for (const d of defs) roots.set(keyOf(file, d.symbol), { label: d.label });
  // A route whose handler body is written inline anchors its links on its own `route:<METHOD> <path>` symbol.
  for (const l of symbolLinks) {
    if (!l.sourceSymbol.startsWith("route:") || l.relation === "reference" || l.navigational) continue;
    const key = keyOf(l.sourceFile, l.sourceSymbol);
    if (!roots.has(key)) roots.set(key, { label: l.sourceSymbol.slice("route:".length) });
  }
  for (const e of entryPoints) {
    if (!e.handler) continue;
    const key = resolveHandler(e.filePath, e.handler);
    if (key && !roots.has(key)) roots.set(key, { label: `${e.kind} ${e.name}` });
  }

  const adj = buildSymbolAdjacency(symbolLinks);
  /** Shortest chain from a root down to `start`, entry first. */
  const chainTo = (start: string): { root: Root; path: string[] } | null => {
    const first = roots.get(start);
    if (first) return { root: first, path: [start] };
    const parent = new Map<string, string>([[start, ""]]);
    let frontier = [start];
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const caller of adj.reverse.get(node) ?? []) {
          if (parent.has(caller) || adj.confidence.get(edgeKey(caller, node)) === "AMBIGUOUS") continue;
          parent.set(caller, node);
          const root = roots.get(caller);
          if (root) {
            const path = [caller];
            for (let cur = parent.get(caller)!; cur; cur = parent.get(cur)!) path.push(cur);
            return { root, path };
          }
          next.push(caller);
        }
      }
      frontier = next;
    }
    return null;
  };

  let judged = 0;
  for (const pkg of wanted) {
    for (const adv of pkg.advisories ?? []) {
      if (!adv.functions?.length) continue;
      const symbolsByPath = new Map(adv.functions.map((f) => [f.path, new Set(f.symbols.filter((s) => !s.includes(".")))] as const));
      const hasMethods = adv.functions.some((f) => f.symbols.some((s) => s.includes(".")));
      const calls: NonNullable<VulnerableReach["calls"]> = [];
      let reachable = false;
      // An import the call head cannot be matched to: a dot import, or a specifier that is no plain package
      // name (`yaml.v3`, `v2`, `go-yaml`) because the language names it by the path's last segment.
      let unreadable = false;
      for (const a of analyses) {
        if (isTestFile(a.filePath, a.language)) continue;
        // The local names this file gives each vulnerable import path.
        const heads = new Map<string, Set<string>>();
        for (const imp of a.imports ?? []) {
          const symbols = symbolsByPath.get(imp.source);
          if (!symbols?.size || imp.isType) continue;
          if (imp.inScope || (imp.specifiers ?? []).some((n) => n !== "_" && !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(n) || /^v\d+$/.test(n))) unreadable = true;
          for (const name of imp.specifiers ?? []) {
            if (name !== "_" && name !== ".") heads.set(name, symbols);
          }
        }
        if (heads.size === 0) continue;
        const inline = inlineByFile.get(a.filePath) ?? [];
        const sites: Array<{ caller: string; key: string | null; inline?: (typeof inline)[number]; line: number; symbol: string }> = [];
        const visit = (caller: string, fnCalls: ReadonlyArray<{ name: string; line: number }> | undefined): void => {
          for (const c of fnCalls ?? []) {
            const dot = c.name.indexOf(".");
            if (dot < 0 || c.name.indexOf(".", dot + 1) >= 0) continue;
            const symbols = heads.get(c.name.slice(0, dot));
            const member = c.name.slice(dot + 1);
            if (!symbols?.has(member)) continue;
            const inl = inline.find((i) => c.line >= i.line && c.line <= i.endLine);
            sites.push({ caller, key: inl ? keyOf(a.filePath, inl.symbol) : keyOf(a.filePath, caller), ...(inl ? { inline: inl } : {}), line: c.line, symbol: member });
          }
        };
        for (const fn of a.functions ?? []) visit(fn.name, fn.calls);
        for (const cls of a.classes ?? []) for (const m of cls.methods ?? []) visit(`${cls.name}.${m.name}`, m.calls);
        for (const s of sites) {
          const found = s.inline ? { root: { label: s.inline.label }, path: [s.key!] } : chainTo(s.key!);
          if (found) reachable = true;
          if (calls.length < MAX_CALLS || (found && !calls.some((c) => c.from))) {
            const row = {
              symbol: s.symbol, file: a.filePath, line: s.line, caller: s.caller,
              ...(found ? { from: found.root.label, path: found.path } : {}),
            };
            // A reached call outranks an unreached one when the cap is full.
            if (calls.length >= MAX_CALLS) calls[calls.findIndex((c) => !c.from)] = row;
            else calls.push(row);
          }
        }
      }
      calls.sort((x, y) => Number(!!y.from) - Number(!!x.from) || (x.path?.length ?? 0) - (y.path?.length ?? 0));
      const status: VulnerableReach["status"] = reachable ? "reachable" : calls.length ? "called" : hasMethods || unreadable ? "not-judged" : "not-called";
      adv.reach = { status, ...(calls.length ? { calls } : {}) };
      judged++;
    }
  }
  return judged;
}
