import type { Confidence, FileAnalysis, SecurityIssue, SymbolLink } from "../types/analysis.js";
import { buildSymbolAdjacency, edgeKey, fileOf, keyOf } from "./symbol-graph.js";
import { innermostAt, spansOf } from "./api-route-symbol-links.js";

/** Findings about what is done with input — the ones a request can feed. */
const INPUT_SINKS: ReadonlySet<SecurityIssue["category"]> = new Set([
  "sql-injection", "command-injection", "subprocess-shell", "eval-exec", "xss",
  "deserialization", "pickle", "xxe",
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
  const sinks = issues.filter((i) => INPUT_SINKS.has(i.category));
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
  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const spanCache = new Map<string, ReturnType<typeof spansOf>>();
  const entriesFrom = new Map<string, NonNullable<SecurityIssue["entries"]>>();
  let attached = 0;
  for (const issue of sinks) {
    const a = byFile.get(issue.filePath);
    if (!a) continue;
    let spans = spanCache.get(a.filePath);
    if (!spans) spanCache.set(a.filePath, (spans = spansOf(a)));
    const at = innermostAt(spans, issue.line);
    if (!at) continue;
    const start = keyOf(issue.filePath, at.symbol);
    let entries = entriesFrom.get(start);
    if (!entries) {
      entries = [];
      const dist = new Map([[start, 0]]);
      const queue = [start];
      for (let qi = 0; qi < queue.length && entries.length < MAX_ENTRIES; qi++) {
        const cur = queue[qi]!;
        const d = dist.get(cur)!;
        const symbol = cur.slice(cur.indexOf("::") + 2);
        if (apiRoutes.has(cur)) {
          entries.push({
            route: symbol.slice("route:".length),
            file: fileOf(cur),
            distance: d,
            confidence: (d <= 1 ? "EXTRACTED" : "INFERRED") as Confidence,
          });
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
    }
    if (entries.length > 0) {
      issue.entries = entries;
      attached++;
    }
  }
  return attached;
}
