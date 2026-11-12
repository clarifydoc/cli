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
 * A model passed by keyword (`model_count(model=Club)`, reported as `model=Club`
 * after the positional arguments) binds the parameter of that name. A function that hands
 * its own parameter on to such a helper (`def total(model): return model_count(model)`)
 * is a helper of that parameter itself, up to three levels. An argument naming anything
 * else (a non-entity class, a local, a parameter nothing hands on) binds nothing.
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
  // The argument a call hands a parameter: by keyword (`name=value`), else by position.
  const argFor = (call: { args?: string[] }, param: string, index: number): string => {
    const kw = call.args?.find((x) => x.startsWith(`${param}=`) && x[param.length + 1] !== "=");
    if (kw) return kw.slice(param.length + 1).trim();
    const at = call.args?.[index] ?? "";
    return /^[A-Za-z_]\w*=(?!=)/.test(at) ? "" : at;
  };
  const helpersOf = (link: SymbolLink) => {
    const all = helpers.get(`${link.targetFile}::${link.targetSymbol}`);
    // Two nested helpers of one name in a file: the link's target line says which.
    return all && new Set(all.map((h) => h.line)).size > 1 ? all.filter((h) => h.line === link.targetLine) : all;
  };
  const callsOf = (link: SymbolLink) => {
    const caller = byFile.get(link.sourceFile);
    const leaf = leafOf(link.callName);
    const fn = caller ? callerOf(caller, link.sourceLine) : undefined;
    return { caller, fn, calls: fn?.calls?.filter((c) => c.args && leafOf(c.name) === leaf) ?? [] };
  };

  // A function that hands its own parameter on to a helper's model parameter is a helper of that
  // parameter itself: the helper's rows are carried to it, at its own parameter's position.
  for (let pass = 0; pass < 2; pass++) {
    let grew = false;
    for (const link of links) {
      if (link.confidence === "AMBIGUOUS") continue;
      const rows = helpersOf(link);
      if (!rows?.length) continue;
      const { caller, fn, calls } = callsOf(link);
      if (!caller || !fn) continue;
      const key = `${link.sourceFile}::${link.sourceSymbol}`;
      for (const call of calls) {
        for (const { row, index } of rows) {
          const arg = argFor(call, row.entityParameter!, index);
          const own = /^[a-z_]\w*$/.test(arg) ? fn.params.findIndex((p) => p.name === arg) : -1;
          if (own < 0) continue;
          const held = helpers.get(key) ?? helpers.set(key, []).get(key)!;
          if (held.some((h) => h.index === own && h.row.name === row.name && h.row.line === row.line && h.row.access === row.access)) continue;
          held.push({ row: { ...row, entityParameter: arg }, index: own, line: fn.line });
          grew = true;
        }
      }
    }
    if (!grew) break;
  }

  let added = 0;
  for (const link of links) {
    if (link.confidence === "AMBIGUOUS") continue;
    const rows = helpersOf(link);
    if (!rows?.length) continue;
    const { caller, calls } = callsOf(link);
    if (!caller) continue;
    for (const call of calls) {
      for (const { row, index } of rows) {
        const model = /^(?:[A-Za-z_]\w*(?:\.|::))*([A-Z]\w*)$/.exec(argFor(call, row.entityParameter!, index))?.[1];
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
