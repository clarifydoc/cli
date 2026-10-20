import type { Confidence, DataFlowPath, EntryPointInfo, FileAnalysis, PatternEntry, PatternInfo, RouteInfo, SecurityIssue, SymbolLink } from "../types/analysis.js";
import { buildSymbolAdjacency, edgeKey, fileOf, keyOf } from "./symbol-graph.js";
import { innermostAt, spansOf } from "./api-route-symbol-links.js";

/** Findings about what is done with input — the ones a request can feed. */
const INPUT_SINKS: ReadonlySet<SecurityIssue["category"]> = new Set([
  "sql-injection", "command-injection", "subprocess-shell", "eval-exec", "xss",
  "deserialization", "pickle", "xxe", "path-traversal", "ssrf", "open-redirect",
]);
/** Longest call chain followed back from a finding. */
const MAX_HOPS = 8;
/** Entry points kept per finding (nearest first). */
const MAX_ENTRIES = 5;

/**
 * Which API routes reach each input-sink finding: from the function the
 * finding sits in, back along callers to the routes' own symbols
 * (`route:POST /search`), over resolved links only — a name-guessed edge is
 * not grounds to say a request reaches a sink. "SQL injection at repo.ts:42"
 * becomes "…reachable from POST /search, 2 hops", which is what decides
 * whether it is exploitable from outside and what to fix first. Not taint: a
 * route that reaches the function may not pass it request data.
 *
 * Sets `SecurityIssue.entries`; returns how many findings got one.
 */
export function attachFindingEntries(
  issues: SecurityIssue[],
  analyses: readonly FileAnalysis[],
  symbolLinks: readonly SymbolLink[],
): number {
  // Another tool's finding asks the same question whatever it is about.
  const sinks = issues.filter((i) => INPUT_SINKS.has(i.category) || i.tool);
  if (sinks.length === 0) return 0;
  const { reverse, confidence } = buildSymbolAdjacency(symbolLinks);
  // API routes only, by their synthetic symbol: a frontend router path is a
  // page, not a request from outside.
  const apiRoutes = new Set<string>();
  for (const a of analyses) {
    for (const r of a.routes ?? []) {
      if (r.kind === "api") apiRoutes.add(keyOf(a.filePath, `route:${r.httpMethod ?? "USE"} ${r.path}`));
    }
  }
  if (apiRoutes.size === 0) return 0;
  const entryOf = (key: string): Omit<PatternEntry, "distance" | "confidence"> | undefined =>
    apiRoutes.has(key) ? { kind: "route", entry: key.slice(key.indexOf("::") + 2 + "route:".length), file: fileOf(key) } : undefined;
  const walk = entryWalker(analyses, reverse, confidence, entryOf);
  let attached = 0;
  for (const issue of sinks) {
    const entries = walk(issue.filePath, issue.line);
    if (entries.length > 0) {
      issue.entries = entries.map((e) => ({ route: e.entry, file: e.file, distance: e.distance, confidence: e.confidence }));
      attached++;
    }
  }
  return attached;
}

/** Patterns that cost time on the path that runs them. */
const PERFORMANCE_PATTERNS: ReadonlySet<PatternInfo["kind"]> = new Set(["query-in-loop", "blocking-in-async"]);

/**
 * Who pays for each performance pattern: the API routes and named entry
 * points (MCP tools, editor and CLI commands that name their handler) whose
 * call chain reaches the function holding it, nearest first, over resolved
 * links only. A query per loop pass behind `GET /orders` costs every request;
 * the same loop in a CLI subcommand costs one run, and in code nothing reaches
 * it may cost nothing. `role` says which: `request` when a route reaches it,
 * else `command`; absent when no entry was found within reach.
 *
 * Sets `PatternInfo.entries` / `role`; returns how many patterns got one.
 */
export function attachPatternEntries(
  patterns: PatternInfo[],
  analyses: readonly FileAnalysis[],
  symbolLinks: readonly SymbolLink[],
  entryPoints: ReadonlyArray<EntryPointInfo & { filePath: string }> = [],
): number {
  const perf = patterns.filter((p) => PERFORMANCE_PATTERNS.has(p.kind));
  if (perf.length === 0) return 0;
  const { reverse, confidence } = buildSymbolAdjacency(symbolLinks);
  const entryAt = new Map<string, Omit<PatternEntry, "distance" | "confidence">>();
  for (const a of analyses) {
    for (const r of a.routes ?? []) {
      if (r.kind !== "api") continue;
      const label = `${r.httpMethod ?? "USE"} ${r.path}`;
      entryAt.set(keyOf(a.filePath, `route:${label}`), { kind: "route", entry: label, file: a.filePath });
    }
  }
  // A registration that names its handler, found among the registering file's own functions.
  const spansByFile = new Map(analyses.map((a) => [a.filePath, spansOf(a)]));
  for (const ep of entryPoints) {
    if (!ep.handler) continue;
    const span = (spansByFile.get(ep.filePath) ?? []).find((s) => s.symbol === ep.handler || s.symbol.endsWith(`.${ep.handler}`));
    if (!span) continue;
    const key = keyOf(ep.filePath, span.symbol);
    if (!entryAt.has(key)) entryAt.set(key, { kind: ep.kind, entry: ep.name, file: ep.filePath });
  }
  if (entryAt.size === 0) return 0;
  const walk = entryWalker(analyses, reverse, confidence, (key) => entryAt.get(key));
  let attached = 0;
  for (const p of perf) {
    const entries = walk(p.filePath, p.line);
    if (entries.length === 0) continue;
    p.entries = entries;
    p.role = entries.some((e) => e.kind === "route") ? "request" : "command";
    attached++;
  }
  return attached;
}

/**
 * Breadth-first back from the function holding a line, along callers, to the
 * entries `entryOf` recognises — never past one, never over an AMBIGUOUS
 * edge, at most MAX_HOPS calls and MAX_ENTRIES entries. Memoized per function.
 */
function entryWalker(
  analyses: readonly FileAnalysis[],
  reverse: ReturnType<typeof buildSymbolAdjacency>["reverse"],
  confidence: ReturnType<typeof buildSymbolAdjacency>["confidence"],
  entryOf: (key: string) => Omit<PatternEntry, "distance" | "confidence"> | undefined,
): (filePath: string, line: number) => PatternEntry[] {
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const spanCache = new Map<string, ReturnType<typeof spansOf>>();
  const entriesFrom = new Map<string, PatternEntry[]>();
  return (filePath, line) => {
    const a = byFile.get(filePath);
    if (!a) return [];
    let spans = spanCache.get(a.filePath);
    if (!spans) spanCache.set(a.filePath, (spans = spansOf(a)));
    const at = innermostAt(spans, line);
    if (!at) return [];
    const start = keyOf(filePath, at.symbol);
    const known = entriesFrom.get(start);
    if (known) return known;
    const entries: PatternEntry[] = [];
    const dist = new Map([[start, 0]]);
    const queue = [start];
    for (let qi = 0; qi < queue.length && entries.length < MAX_ENTRIES; qi++) {
      const cur = queue[qi]!;
      const d = dist.get(cur)!;
      const entry = entryOf(cur);
      if (entry) {
        entries.push({ ...entry, distance: d, confidence: (d <= 1 ? "EXTRACTED" : "INFERRED") as Confidence });
        continue;
      }
      if (d >= MAX_HOPS) continue;
      for (const caller of reverse.get(cur) ?? []) {
        if (dist.has(caller) || confidence.get(edgeKey(caller, cur)) === "AMBIGUOUS") continue;
        dist.set(caller, d + 1);
        queue.push(caller);
      }
    }
    entriesFrom.set(start, entries);
    return entries;
  };
}

/** Methods that change state. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * API routes that explicitly waive authentication (`[AllowAnonymous]`,
 * `permitAll`, `withoutMiddleware('auth')` — `RouteInfo.auth.anonymous`) with a
 * mutating method, whose data flows write the database: anyone can change
 * stored data through them. Some are meant to be public (sign-up, password
 * reset, a webhook), which the message asks to confirm — a route with no
 * declared auth at all is "unknown", never flagged.
 */
/**
 * A GET or HEAD route whose data flow writes a table: a safe method that
 * changes state can be triggered by a link, a prefetch or a crawler, and no
 * CSRF defence covers it. The finding names the tables written.
 */
export function safeMethodWriteFindings(
  routes: ReadonlyArray<RouteInfo & { filePath: string }>,
  dataFlows: readonly DataFlowPath[],
): SecurityIssue[] {
  const writes = new Map<string, Set<string>>();
  for (const f of dataFlows) {
    if (f.entryKind !== "route" || f.effect !== "db-write") continue;
    const key = `${f.entryFile}\u0000${f.entryLabel}`;
    (writes.get(key) ?? writes.set(key, new Set()).get(key)!).add(f.resource);
  }
  const out: SecurityIssue[] = [];
  for (const r of routes) {
    const method = (r.httpMethod ?? "").toUpperCase();
    if (r.kind !== "api" || (method !== "GET" && method !== "HEAD")) continue;
    const label = `${method} ${r.path}`;
    const tables = writes.get(`${r.filePath}\u0000${label}`);
    if (!tables?.size) continue;
    const named = [...tables].sort();
    out.push({
      category: "safe-method-write",
      severity: "medium",
      message: `${label} writes ${named.slice(0, 3).join(", ")}${named.length > 3 ? ` and ${named.length - 3} more` : ""}: a ${method} can be sent by a link, a prefetch or a crawler, and CSRF defences do not cover it. Use POST/PUT/DELETE for a change.`,
      filePath: r.filePath,
      line: r.line,
      snippet: `${label}${r.handler ? ` → ${r.handler}` : ""}`,
      cwe: "CWE-650",
    });
  }
  return out;
}

export function anonymousWriteFindings(
  routes: ReadonlyArray<RouteInfo & { filePath: string }>,
  dataFlows: readonly DataFlowPath[],
): SecurityIssue[] {
  const writes = new Map<string, Set<string>>();
  for (const f of dataFlows) {
    if (f.entryKind !== "route" || f.effect !== "db-write") continue;
    const key = `${f.entryFile}\u0000${f.entryLabel}`;
    (writes.get(key) ?? writes.set(key, new Set()).get(key)!).add(f.resource);
  }
  const out: SecurityIssue[] = [];
  for (const r of routes) {
    const method = (r.httpMethod ?? "").toUpperCase();
    if (r.kind !== "api" || r.auth?.anonymous !== true || !MUTATING.has(method)) continue;
    const label = `${method} ${r.path}`;
    const tables = writes.get(`${r.filePath}\u0000${label}`);
    if (!tables?.size) continue;
    const named = [...tables].sort();
    out.push({
      category: "missing-auth",
      severity: "medium",
      message: `${label} allows anonymous callers and writes ${named.slice(0, 3).join(", ")}${named.length > 3 ? ` and ${named.length - 3} more` : ""}. Confirm it is meant to be public (sign-up, password reset, a webhook).`,
      filePath: r.filePath,
      line: r.line,
      snippet: `${label}${r.handler ? ` → ${r.handler}` : ""}`,
      cwe: "CWE-306",
    });
  }
  return out;
}
