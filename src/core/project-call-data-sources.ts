import type { FileAnalysis, SymbolLink, SymbolLinkStrategy } from "../types/analysis.js";

/**
 * Database data sources that are really calls into the project's own code.
 *
 * Data-source extractors recognise ORM access partly by method name
 * (`X.Comments.create(…)` reads as a write on entity `Comments`), and a name
 * cannot tell an ORM from the project's own API client, service or in-memory
 * store. realworld's browser components showed a DIRECT database write from
 * `agent.Comments.create(…)` — a call into the frontend's HTTP client; Ix's
 * `client.health()` on its own HTTP client, a NestJS controller's
 * `this.users.findOne()` on the injected service, a plain in-memory Ruby class
 * all counted as database access.
 *
 * The symbol linker can tell: when it resolves the call, with evidence, to a
 * function the project defines, the call is project code, and whatever that
 * function does to a datastore is attributed inside it and reached
 * transitively. Such data sources are dropped from the in-memory analyses
 * before the data-access graph, the per-symbol attribution and the
 * responsibility profiles read them. Per-file JSON keeps the raw extraction.
 *
 * Kept, because the project definition is not where the access happens:
 *  - a method of an ORM entity class (`entity`/`table` marker) — an
 *    ActiveRecord scope calling `where` on implicit self carries its query in
 *    a shape the extractors may not see;
 *  - a method of an interface — a Spring Data `findByEmail` IS the query, and
 *    its implementation is generated, not in the project.
 *
 * Returns the number of data sources dropped.
 */
export function demoteProjectCallDataSources(
  analyses: FileAnalysis[],
  symbolLinks: readonly SymbolLink[],
): number {
  const linkAt = new Map<string, SymbolLink>();
  for (const l of symbolLinks) {
    if (l.confidence === "AMBIGUOUS" || !l.strategy || !MEMBER_RESOLVING.has(l.strategy)) continue;
    linkAt.set(siteKey(l.sourceFile, l.sourceLine, l.callName), l);
  }
  if (linkAt.size === 0) return 0;

  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  let dropped = 0;
  for (const a of analyses) {
    if (!a.dataSources?.some((ds) => ds.kind === "database")) continue;
    a.dataSources = a.dataSources.filter((ds) => {
      if (ds.kind !== "database") return true;
      const link = linkAt.get(siteKey(a.filePath, ds.line, ds.name));
      if (!link || isPersistenceBoundary(byFile.get(link.targetFile), link.targetSymbol)) return true;
      dropped++;
      return false;
    });
  }
  return dropped;
}

/**
 * Strategies that resolve the call's OWN member with evidence. Excluded:
 * `factory-via` links the factory, not the member; `unique-global*` and
 * `type-argument` are name heuristics; `constructor`, `import-*`, `route-*`
 * are not member resolutions.
 */
const MEMBER_RESOLVING = new Set<SymbolLinkStrategy>([
  "direct", "inheritance", "interface-redirect", "injection", "deep-qualified", "class-name",
]);

function siteKey(file: string, line: number, callName: string): string {
  return `${file}\u0000${line}\u0000${callName}`;
}

/** The target is an ORM entity (or one of its methods) or an interface method. */
function isPersistenceBoundary(target: FileAnalysis | undefined, symbol: string): boolean {
  if (!target) return false;
  const className = symbol.includes(".") ? symbol.slice(0, symbol.indexOf(".")) : symbol;
  const cls = target.classes?.find((c) => c.name === className);
  if (!cls) return false;
  if (cls.kind === "interface") return true;
  const decorators = cls.decorators ?? [];
  return decorators.includes("entity") || decorators.includes("table");
}
