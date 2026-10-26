import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";

/**
 * Drift's generated accessors for a `.drift` file's named queries:
 * `merged_asset.drift` declares `mergedBucket: SELECT …`, and Drift generates
 * a `mergedAssetDrift` accessor on the database whose `mergedBucket(…)` runs
 * it — `_db.mergedAssetDrift.mergedBucket(…)`. Each such call links to the
 * named query (a function of the `.drift` file, which the SQL plugin reads),
 * where the tables it reads are. The accessor names the file: its camel-cased
 * base name plus `Drift`; a file name shared by two `.drift` files names neither.
 */
export class DriftQueryResolver implements DispatchResolver {
  readonly id = "drift-query";
  readonly languages: Language[] = ["dart", "sql"];
  readonly priority = 57;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const byAccessor = new Map<string, FileAnalysis | null>();
    for (const a of analyses) {
      if (a.language !== "sql" || !a.filePath.endsWith(".drift")) continue;
      const base = a.filePath.slice(a.filePath.lastIndexOf("/") + 1, -".drift".length);
      const accessor = base.replace(/[_-]+([a-z0-9])/g, (_m, c: string) => c.toUpperCase()) + "Drift";
      byAccessor.set(accessor, byAccessor.has(accessor) ? null : a);
    }
    if (byAccessor.size === 0) return [];
    const links: SymbolLink[] = [];
    for (const a of analyses) {
      if (a.language !== "dart") continue;
      const fns = [...a.functions, ...a.classes.flatMap((c) => c.methods.map((m) => ({ ...m, name: `${c.name}.${m.name}` })))];
      for (const fn of fns) {
        for (const call of fn.calls) {
          const m = /(?:^|\.)([a-z]\w*Drift)\.([A-Za-z_]\w*)$/.exec(call.name);
          const file = m ? byAccessor.get(m[1]!) : undefined;
          const query = file?.functions.find((q) => q.name === m![2]);
          if (!file || !query) continue;
          links.push({
            sourceFile: a.filePath,
            sourceSymbol: fn.name,
            sourceLine: call.line,
            callName: call.name,
            targetFile: file.filePath,
            targetSymbol: query.name,
            targetLine: query.line,
            confidence: "EXTRACTED",
          });
        }
      }
    }
    return links;
  }
}
