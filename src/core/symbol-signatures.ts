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
import type { RowLines } from "./owner-paths.js";

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
  rowLines?: RowLines,
): SymbolSignature[] {
  // file::symbol → the lines links land on (they pick among overloads and among same-named nested members), and whether a row
  // names it without a line (a link's source, a function touching data with no line): the first declaration then answers.
  const wanted = new Map<string, { lines: Set<number> }>();
  const want = (k: string, line: number | undefined): void => {
    let w = wanted.get(k);
    if (!w) wanted.set(k, (w = { lines: new Set() }));
    if (line !== undefined) w.lines.add(line);
  };
  for (const l of symbolLinks) {
    want(keyOf(l.targetFile, l.targetSymbol), l.targetLine);
    const src = keyOf(l.sourceFile, l.sourceSymbol);
    if (!wanted.has(src)) want(src, undefined);
  }
  for (const d of dataAccess) {
    const k = keyOf(d.file, d.symbol);
    if (!wanted.has(k) || wanted.get(k)!.lines.size === 0) want(k, d.symbolLine);
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
    const w = wanted.get(k);
    if (!w) return;
    // Each declaration the links land on has its row; an overload no link lands on waits for the ones that are landed on.
    const landed = w.lines.has(fn.line);
    if (!landed && w.lines.size > 0 && [...w.lines].some((line) => overloadAt(a, symbol, line))) return;
    const once = landed ? `${k}|${fn.line}` : k;
    if (done.has(once)) return;
    if (fn.params.length === 0 && !fn.returnType) return;
    done.add(once);
    const row: SymbolSignature = {
      file: a.filePath,
      symbol,
      params: fn.params.map((p) => typed(p.type, a, p.name)),
      ...(fn.returnType ? { returns: typed(fn.returnType, a) } : {}),
    };
    // `qualifyNestedSymbols` spells the symbol as the link ending here does, by the line the function starts on.
    rowLines?.set(row, fn.line);
    out.push(row);
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
