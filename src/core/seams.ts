/**
 * The seam sketch of a god file: the groups its own call graph already forms,
 * what each one touches and what moving it out would cost.
 *
 * A god object graded `high` "holds separable work" — two or more groups of
 * functions that never call each other (`sibling-graph.ts`). Saying so is
 * half an answer; this names the groups. For each: its functions, the lines
 * they span (what moves), the boundaries it touches (from the responsibility
 * profile's evidence), and its callers outside the file — a function no
 * other file calls moves without touching another file, one that is called
 * changes its callers' imports. "No other file calls it" is what the links
 * show, not a visibility: a framework, reflection or a JSX tag can still
 * reach it.
 */
import type { BoundaryKind, FileAnalysis, FileSeam, ResponsibilityProfile, SymbolLink } from "../types/analysis.js";
import type { SiblingGraph } from "./sibling-graph.js";

/** A group needs this many functions to be a seam, as the god-object grade counts groups. */
const MIN_SEAM_FUNCTIONS = 3;
/** Seams reported per file, and function names listed per seam. */
const MAX_SEAMS = 5;
const MAX_FUNCTIONS = 12;

/** Inbound cross-file callers per `file\0symbol`, built once for the project. */
export function crossFileCallers(links: readonly SymbolLink[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const l of links) {
    if (l.sourceFile === l.targetFile) continue;
    const key = `${l.targetFile}\u0000${l.targetSymbol}`;
    (out.get(key) ?? out.set(key, new Set()).get(key)!).add(l.sourceFile);
  }
  return out;
}

/**
 * The seams of one file: each connected group of at least three functions,
 * largest first. Empty when fewer than two such groups exist — then the file
 * has no seam its call graph shows.
 */
export function seamsOf(
  analysis: FileAnalysis,
  graph: SiblingGraph,
  callers: ReadonlyMap<string, ReadonlySet<string>>,
  profile: ResponsibilityProfile | undefined,
): FileSeam[] {
  const groups = graph.components.filter((c) => new Set(c).size >= MIN_SEAM_FUNCTIONS);
  if (groups.length < 2) return [];
  const span = new Map(graph.nodes.map((n) => [n.symbol, n]));
  const evidence = (profile?.evidence ?? []).filter((e) => e.line !== undefined);
  return groups.slice(0, MAX_SEAMS).map((members) => {
    // Overloads share one name: a group lists each name once.
    const group = [...new Set(members)];
    let lines = 0;
    let moves = 0;
    let externalFacing = 0;
    const callerFiles = new Set<string>();
    const boundaries = new Set<BoundaryKind>();
    for (const symbol of group) {
      const s = span.get(symbol);
      if (s) {
        lines += s.endLine - s.line + 1;
        for (const e of evidence) if (e.line! >= s.line && e.line! <= s.endLine) boundaries.add(e.kind);
      }
      const from = callers.get(`${analysis.filePath}\u0000${symbol}`);
      if (from?.size) {
        externalFacing++;
        for (const f of from) callerFiles.add(f);
      } else {
        moves++;
      }
    }
    return {
      functions: group.slice(0, MAX_FUNCTIONS),
      functionCount: group.length,
      lines,
      boundaries: [...boundaries].sort(),
      moves,
      externalFacing,
      callerFiles: callerFiles.size,
    };
  });
}

/** One line per seam, for the god-object detail and the suggestion. */
export function describeSeams(seams: readonly FileSeam[]): string {
  return seams
    .map((s) => {
      // `League::MatchesController.show` reads as `show` — the file already names its class.
      const short = s.functions.slice(0, 3).map((f) => f.slice(f.lastIndexOf(".") + 1));
      const names = short.join(", ") + (s.functionCount > 3 ? ` +${s.functionCount - 3}` : "");
      const touches = s.boundaries.length ? `, touches ${s.boundaries.join("/")}` : "";
      const cost = s.externalFacing
        ? `${s.externalFacing} called from ${s.callerFiles} other file(s)`
        : "no caller in another file observed";
      return `[${names}] ${s.functionCount} functions, ${s.lines} lines${touches}; ${cost}`;
    })
    .join(" · ");
}
