import type { FileAnalysis, SymbolLink, CallInfo } from "../types/analysis.js";
import { resolveTarget, buildFilePathMap } from "../extractors/shared/link-scoring.js";

interface SymbolDef {
  name: string;
  line: number;
  endLine: number;
}

/**
 * Build a cross-file symbol link table that maps every resolvable call
 * to the function/method definition it targets.
 *
 * Runs as a post-analysis pass after all files have been individually analyzed.
 */
export function buildSymbolLinks(analyses: FileAnalysis[]): SymbolLink[] {
  const filePathMap = buildFilePathMap(analyses);
  const symbolIndex = buildSymbolIndex(analyses);
  const links: SymbolLink[] = [];

  for (const analysis of analyses) {
    const sourceFile = analysis.filePath;

    // Functions
    for (const fn of analysis.functions) {
      for (const call of fn.calls) {
        const link = resolveCallToDefinition(
          sourceFile, fn.name, call, filePathMap, symbolIndex,
        );
        if (link) links.push(link);
      }
    }

    // Class methods
    for (const cls of analysis.classes) {
      for (const method of cls.methods) {
        const sourceSymbol = `${cls.name}.${method.name}`;
        for (const call of method.calls) {
          const link = resolveCallToDefinition(
            sourceFile, sourceSymbol, call, filePathMap, symbolIndex,
          );
          if (link) links.push(link);
        }
      }
    }

    // Route handlers
    for (const route of analysis.routes) {
      const sourceSymbol = `route:${route.httpMethod ?? "USE"} ${route.path}`;

      // Link route → its handler method (e.g., route:GET /api/users → getAllUsers)
      if (route.handler) {
        const handlerLink = resolveCallToDefinition(
          sourceFile, sourceSymbol,
          { name: route.handler, kind: "internal", target: null, line: route.line },
          filePathMap, symbolIndex,
        );
        if (handlerLink) links.push(handlerLink);
      }

      // Link route → functions it calls
      for (const call of route.calls) {
        const link = resolveCallToDefinition(
          sourceFile, sourceSymbol, call, filePathMap, symbolIndex,
        );
        if (link) links.push(link);
      }
    }

    // Data source callbacks (lifecycle hooks, watchers)
    for (const ds of analysis.dataSources) {
      for (const call of ds.calls) {
        const link = resolveCallToDefinition(
          sourceFile, ds.name, call, filePathMap, symbolIndex,
        );
        if (link) links.push(link);
      }
    }
  }

  // Deduplicate links (same source→target with same call can appear from handler + calls)
  const seen = new Set<string>();
  const deduped: SymbolLink[] = [];
  for (const link of links) {
    const key = `${link.sourceFile}::${link.sourceSymbol}::${link.targetFile}::${link.targetSymbol}::${link.callName}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(link);
    }
  }

  return deduped;
}

/**
 * Build a per-file symbol index from all analyses.
 * Maps filePath → Map<symbolName → SymbolDef>
 */
function buildSymbolIndex(
  analyses: FileAnalysis[],
): Map<string, Map<string, SymbolDef>> {
  const index = new Map<string, Map<string, SymbolDef>>();

  for (const analysis of analyses) {
    const fileSymbols = new Map<string, SymbolDef>();

    // Functions
    for (const fn of analysis.functions) {
      fileSymbols.set(fn.name, {
        name: fn.name,
        line: fn.line,
        endLine: fn.endLine,
      });
    }

    // Class methods (store both qualified and unqualified names)
    for (const cls of analysis.classes) {
      // The class itself
      fileSymbols.set(cls.name, {
        name: cls.name,
        line: cls.line,
        endLine: cls.endLine,
      });

      for (const method of cls.methods) {
        const qualified = `${cls.name}.${method.name}`;
        fileSymbols.set(qualified, {
          name: qualified,
          line: method.line,
          endLine: method.endLine,
        });
        // Also store unqualified as fallback (if not already taken by a function)
        if (!fileSymbols.has(method.name)) {
          fileSymbols.set(method.name, {
            name: qualified,
            line: method.line,
            endLine: method.endLine,
          });
        }
      }
    }

    // Exports (fill in symbols not already captured by functions/methods)
    for (const exp of analysis.exports) {
      if (!fileSymbols.has(exp.name)) {
        fileSymbols.set(exp.name, {
          name: exp.name,
          line: exp.line,
          endLine: exp.line,
        });
      }
    }

    index.set(analysis.filePath, fileSymbols);
  }

  return index;
}

/**
 * Try to resolve a single call to its definition site.
 * Returns a SymbolLink if resolution succeeds, null otherwise.
 */
function resolveCallToDefinition(
  sourceFile: string,
  sourceSymbol: string,
  call: CallInfo,
  filePathMap: Map<string, string>,
  symbolIndex: Map<string, Map<string, SymbolDef>>,
): SymbolLink | null {
  // Skip API and database calls — they don't resolve to project symbols
  if (call.kind === "api-call" || call.kind === "database") return null;

  let targetFile: string | null;

  if (call.kind === "cross-file" && call.target) {
    // Resolve import source to actual file path
    targetFile = resolveTarget(call.target, sourceFile, filePathMap);
    if (!targetFile) return null;
  } else if (call.kind === "internal") {
    // Internal calls resolve within the same file
    targetFile = sourceFile;
  } else {
    return null;
  }

  // Look up the symbol in the target file
  const fileSymbols = symbolIndex.get(targetFile);
  if (!fileSymbols) return null;

  // Extract leaf name: "userStore.fetchUsers" → "fetchUsers"
  const leafName = call.name.includes(".")
    ? call.name.split(".").pop()!
    : call.name;

  // Try exact call name first, then leaf name
  const def = fileSymbols.get(call.name) ?? fileSymbols.get(leafName);
  if (!def) return null;

  return {
    sourceFile,
    sourceSymbol,
    sourceLine: call.line,
    callName: call.name,
    targetFile,
    targetSymbol: def.name,
    targetLine: def.line,
  };
}
