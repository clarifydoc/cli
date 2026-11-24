import type { FileAnalysis, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { GENERIC_DECORATOR } from "./functions-classes.js";

/**
 * S4 dispatch: `setGeneric("describe", …)` declares the function `describe`, and each
 * `setMethod("describe", "Club", …)` is a body it may run. A call to `describe` fans out to every such
 * method of the project (INFERRED: which one runs depends on the argument's class, which the call does not state).
 */
export class RGenericResolver implements DispatchResolver {
  readonly id = "s4-generic";
  readonly languages: Language[] = ["r"];
  readonly priority = 60;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const r = analyses.filter((a) => a.language === "r");
    const generics = new Set<string>();
    for (const a of r) for (const f of a.functions) if (f.decorators.includes(GENERIC_DECORATOR)) generics.add(f.name);
    if (generics.size === 0) return [];
    const methods = new Map<string, Array<{ file: string; symbol: string; line: number }>>();
    for (const a of r) {
      for (const cls of a.classes) {
        for (const m of cls.methods) {
          if (!generics.has(m.name)) continue;
          const list = methods.get(m.name) ?? methods.set(m.name, []).get(m.name)!;
          list.push({ file: a.filePath, symbol: `${cls.name}.${m.name}`, line: m.line });
        }
      }
    }
    const links: SymbolLink[] = [];
    const seen = new Set<string>();
    const callers = (a: FileAnalysis) => [...a.functions.map((f) => ({ symbol: f.name, calls: f.calls })), ...a.classes.flatMap((c) => c.methods.map((m) => ({ symbol: `${c.name}.${m.name}`, calls: m.calls })))];
    for (const a of r) {
      for (const caller of callers(a)) {
        for (const call of caller.calls) {
          for (const target of methods.get(call.name) ?? []) {
            const key = `${a.filePath}\0${caller.symbol}\0${call.line}\0${target.file}\0${target.symbol}`;
            if (seen.has(key)) continue;
            seen.add(key);
            links.push({ sourceFile: a.filePath, sourceSymbol: caller.symbol, sourceLine: call.line, callName: call.name, targetFile: target.file, targetSymbol: target.symbol, targetLine: target.line, confidence: "INFERRED" });
          }
        }
      }
    }
    return links;
  }
}
