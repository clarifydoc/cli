import type { DataSourceInfo, FileAnalysis, FunctionInfo, SymbolLink } from "../types/analysis.js";
import { innermostAt, spansOf } from "./api-route-symbol-links.js";

/**
 * A helper whose statement queries the model its caller hands it:
 *
 *     def statistics(self):
 *         def model_count(model):
 *             return self.session.scalar(select(func.count(model.id)))
 *         return LeagueStats(clubs=model_count(Club), players=model_count(Player))
 *
 * The helper's own row carries `entityParameter: "model"` and no entity; the
 * call site is where the model is. For every resolved call into such a
 * function (a link at least INFERRED) whose argument at that parameter's
 * position (`CallInfo.args`, as written) names a class the project declares as
 * an entity, this adds a row of the same access at the call site naming that
 * class, in the caller's file — so the data-access pass attributes it to the
 * calling function and every route reaching that function reaches the table.
 * An argument naming anything else (a non-entity class, a local, the caller's
 * own parameter) binds nothing. One level deep, like the channel factories.
 * In memory only; per-file JSON is untouched.
 *
 * Returns the number of rows added.
 */
export function expandEntityParameters(analyses: readonly FileAnalysis[], links: readonly SymbolLink[]): number {
  const helpers = new Map<string, Array<{ row: DataSourceInfo; index: number; line: number }>>();
  for (const a of analyses) {
    const rows = (a.dataSources ?? []).filter((d) => d.kind === "database" && d.entityParameter && !d.entity);
    if (rows.length === 0) continue;
    const spans = spansOf(a);
    for (const row of rows) {
      const at = innermostAt(spans, row.line);
      const fn = at ? functionAt(a, at.symbol, at.line) : undefined;
      const index = fn ? fn.params.findIndex((p) => p.name === row.entityParameter) : -1;
      if (!at || !fn || index < 0) continue;
      const key = `${a.filePath}::${at.symbol}`;
      (helpers.get(key) ?? helpers.set(key, []).get(key)!).push({ row, index, line: fn.line });
    }
  }
  if (helpers.size === 0) return 0;

  // Classes the project declares as entities, by bare name.
  const entities = new Set<string>();
  for (const a of analyses) {
    for (const c of a.classes ?? []) {
      const d = c.decorators ?? [];
      if (d.includes("entity") || d.includes("table")) entities.add(c.name.split(/\.|::/).pop()!);
    }
  }
  if (entities.size === 0) return 0;

  const byFile = new Map(analyses.map((a) => [a.filePath, a]));
  const spanCache = new Map<string, ReturnType<typeof spansOf>>();
  // The function a link's call sits in. A link stands for every call of that name in it
  // (the linker keeps one per caller and callee), so each of them is read for its argument.
  const callerOf = (a: FileAnalysis, line: number): FunctionInfo | undefined => {
    const spans = spanCache.get(a.filePath) ?? spanCache.set(a.filePath, spansOf(a)).get(a.filePath)!;
    const at = innermostAt(spans, line);
    return at ? functionAt(a, at.symbol, at.line) : undefined;
  };
  const leafOf = (name: string) => name.replace(/\(.*$/, "").split(/\.|->|::/).pop()!;

  let added = 0;
  for (const link of links) {
    if (link.confidence === "AMBIGUOUS") continue;
    const all = helpers.get(`${link.targetFile}::${link.targetSymbol}`);
    // Two nested helpers of one name in a file: the link's target line says which.
    const rows = all && new Set(all.map((h) => h.line)).size > 1 ? all.filter((h) => h.line === link.targetLine) : all;
    const caller = rows?.length ? byFile.get(link.sourceFile) : undefined;
    if (!rows || !caller) continue;
    const leaf = leafOf(link.callName);
    for (const call of callerOf(caller, link.sourceLine)?.calls?.filter((c) => c.args && leafOf(c.name) === leaf) ?? []) {
      for (const { row, index } of rows) {
        const model = /^(?:[A-Za-z_]\w*(?:\.|::))*([A-Z]\w*)$/.exec(call.args![index] ?? "")?.[1];
        if (!model || !entities.has(model)) continue;
        const exists = caller.dataSources.some((d) => d.kind === "database" && d.line === call.line && d.entity === model && d.access === row.access);
        if (exists) continue;
        caller.dataSources.push({ kind: "database", name: row.name, target: model, entity: model, line: call.line, ...(row.access ? { access: row.access } : {}), calls: [] });
        added++;
      }
    }
  }
  return added;
}

/** The function or method `symbol` (`fn` or `Class.method`) declared at `line`. */
function functionAt(a: FileAnalysis, symbol: string, line: number): FunctionInfo | undefined {
  const dot = symbol.lastIndexOf(".");
  const method = dot > 0 ? a.classes.find((c) => c.name === symbol.slice(0, dot))?.methods.find((m) => m.name === symbol.slice(dot + 1) && m.line === line) : undefined;
  return method ?? a.functions.find((f) => f.name === symbol && f.line === line);
}
