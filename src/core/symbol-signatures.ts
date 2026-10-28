import type {
  ClassGraph,
  FileAnalysis,
  FunctionInfo,
  SignatureModel,
  SignatureType,
  SymbolDataAccess,
  SymbolLink,
  SymbolSignature,
} from "../types/analysis.js";
import type { ImportIndex } from "../types/project.js";
import { parseTypeRefs } from "../extractors/shared/type-parser.js";
import { keyOf } from "./symbol-graph.js";

/**
 * The declared signature of every function the Call Traces view can select —
 * an end of a symbol link, or a function that touches data — so the trace
 * diagram can draw the types going in (parameters) and coming out (return).
 *
 * Each type is joined to the project types it names the way the class graph
 * joins a type reference: the one declaration of that name, else the one the
 * file imports, else the one in the same file. A name declared several times
 * that neither settles is left unjoined rather than guessed.
 */
export function buildSymbolSignatures(
  analyses: FileAnalysis[],
  symbolLinks: SymbolLink[],
  dataAccess: SymbolDataAccess[],
  classGraph: ClassGraph,
  importIndex: ImportIndex,
): SymbolSignature[] {
  // file::symbol → the line links land on (picks among overloads).
  const wanted = new Map<string, number | undefined>();
  for (const l of symbolLinks) {
    wanted.set(keyOf(l.targetFile, l.targetSymbol), l.targetLine);
    const src = keyOf(l.sourceFile, l.sourceSymbol);
    if (!wanted.has(src)) wanted.set(src, undefined);
  }
  for (const d of dataAccess) {
    const k = keyOf(d.file, d.symbol);
    if (wanted.get(k) === undefined) wanted.set(k, d.symbolLine);
  }
  if (wanted.size === 0) return [];

  const declared = new Map<string, { name: string; file: string; entity: boolean }[]>();
  for (const n of classGraph.nodes) {
    if (n.isExternal || n.isFile) continue;
    const list = declared.get(n.name) ?? declared.set(n.name, []).get(n.name)!;
    list.push({ name: n.name, file: n.filePath, entity: !!n.isEntity });
  }

  const modelsOf = (type: string | null, a: FileAnalysis): SignatureModel[] | undefined => {
    const out: SignatureModel[] = [];
    for (const ref of parseTypeRefs(type, a.language)) {
      const cands = declared.get(ref.typeName);
      if (!cands?.length) continue;
      let hit = cands.length === 1 ? cands[0] : undefined;
      if (!hit) {
        const from = importIndex.localFor(a.filePath, ref.typeName);
        hit = (from ? cands.find((c) => c.file === from) : undefined) ?? cands.find((c) => c.file === a.filePath);
      }
      if (hit && !out.some((m) => m.name === hit!.name && m.file === hit!.file)) {
        out.push({ name: hit.name, file: hit.file, ...(hit.entity ? { entity: true } : {}) });
      }
    }
    return out.length ? out : undefined;
  };
  const typed = (type: string | null, a: FileAnalysis, name?: string): SignatureType => {
    const models = modelsOf(type, a);
    return { ...(name !== undefined ? { name } : {}), type, ...(models ? { models } : {}) };
  };

  const out: SymbolSignature[] = [];
  const done = new Set<string>();
  const consider = (a: FileAnalysis, fn: FunctionInfo, symbol: string) => {
    const k = keyOf(a.filePath, symbol);
    if (!wanted.has(k) || done.has(k)) return;
    const line = wanted.get(k);
    // An overload other than the one the links land on waits for that one.
    if (line !== undefined && fn.line !== line && overloadAt(a, symbol, line)) return;
    if (fn.params.length === 0 && !fn.returnType) return;
    done.add(k);
    out.push({
      file: a.filePath,
      symbol,
      params: fn.params.map((p) => typed(p.type, a, p.name)),
      ...(fn.returnType ? { returns: typed(fn.returnType, a) } : {}),
    });
  };
  for (const a of analyses) {
    for (const fn of a.functions) consider(a, fn, fn.name);
    for (const cls of a.classes) for (const m of cls.methods) consider(a, m, `${cls.name}.${m.name}`);
  }
  return out;
}

/** Whether the file declares `symbol` at `line` (an overload the links name). */
function overloadAt(a: FileAnalysis, symbol: string, line: number): boolean {
  const dot = symbol.lastIndexOf(".");
  if (dot < 0) return a.functions.some((f) => f.name === symbol && f.line === line);
  const cls = symbol.slice(0, dot), name = symbol.slice(dot + 1);
  return a.classes.some((c) => c.name === cls && c.methods.some((m) => m.name === name && m.line === line));
}
