import type { FileAnalysis, SymbolLink } from "../types/analysis.js";
import { BEST_RANK as CONFIDENCE_RANK } from "../extractors/shared/confidence.js";

/**
 * Lightweight entity dedup for SymbolLinks.
 *
 * The symbol-linker already dedupes on the literal key
 * `sourceFile::sourceSymbol::targetFile::targetSymbol::callName`. This pass
 * adds one more layer: collapse links whose `callName` differs only in case
 * or punctuation (e.g. `user_service.find` vs `userService.find`) once they
 * already point at the same `(sourceFile, targetFile, targetSymbol)` triple.
 *
 * Ported from graphify-7's `deduplicate_by_label` (the simpler exact-norm
 * path — we deliberately skip its MinHash + Jaro-Winkler upgrade, which is
 * overkill at our scale).
 */

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * A reverse-reference edge (an import naming a symbol), not a call.
 *
 * Prefers the typed `relation`, falling back to the `"(reference)"` sentinel
 * for links that predate the field — links deserialized from an artifact
 * written before it existed, and the many tests that build links by hand. The
 * sentinel remains the wire representation of `sourceSymbol`; this is only
 * about not asking every consumer to know that.
 */
export function isReferenceLink(l: SymbolLink): boolean {
  if (l.relation !== undefined) return l.relation === "reference";
  return l.sourceSymbol === "(reference)";
}

/**
 * Drop reverse-reference links (see {@link isReferenceLink}) that are
 * artifacts of polymorphism / name collisions rather than real dependencies.
 * Both fool reference resolution into producing *wrong-direction* edges that
 * fabricate circular dependencies and inflate coupling:
 *
 *   1. Same-name definition collision — several files define an identical
 *      qualified symbol (three microservices each with
 *      `class InternalsController { Ping() }`). LSP `references` (or a name-keyed
 *      text scan) reports each replica's own definition as a "reference" to the
 *      others → fully-connected clique → bogus cycle. Signature: the *source*
 *      file already defines the exact qualified symbol the reference points at.
 *
 *   2. Base→derived virtual dispatch — a base class's virtual/abstract method
 *      call resolves (via `references`) to every subclass override, so the base
 *      "references" each subclass (`BaseConsumerBroker` → `RoleConsumerBroker`…).
 *      A base does not depend on its subclasses. Signature: the *target*'s class
 *      transitively extends a class defined in the *source* file.
 *
 * Both are gated on the qualified `Class.method` form and only applied to
 * `(reference)` links, so real call/definition edges are untouched.
 */
export function dropNameCollisionReferences(
  links: SymbolLink[],
  analyses: FileAnalysis[],
): SymbolLink[] {
  const definedByFile = new Map<string, Set<string>>();
  const parentOf = new Map<string, string>(); // className → its base/parent class name
  const filesDefiningClass = new Map<string, Set<string>>(); // className → files that declare it
  for (const a of analyses) {
    const names = new Set<string>();
    for (const fn of a.functions ?? []) names.add(fn.name);
    for (const cls of a.classes ?? []) {
      names.add(cls.name);
      for (const m of cls.methods ?? []) names.add(`${cls.name}.${m.name}`);
      if (cls.extends) parentOf.set(cls.name, bareTypeName(cls.extends));
      let set = filesDefiningClass.get(cls.name);
      if (!set) filesDefiningClass.set(cls.name, (set = new Set()));
      set.add(a.filePath);
    }
    definedByFile.set(a.filePath, names);
  }

  /** Walk `className`'s ancestry; true if any ancestor class is declared in `file`. */
  const ancestorDefinedIn = (className: string, file: string): boolean => {
    const seen = new Set<string>();
    let cur = parentOf.get(className);
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      if (filesDefiningClass.get(cur)?.has(file)) return true;
      cur = parentOf.get(cur);
    }
    return false;
  };

  return links.filter((l) => {
    if (!isReferenceLink(l) || l.sourceFile === l.targetFile) return true;
    const symbol = l.targetSymbol || l.callName;
    // Only the qualified `Class.method` form is a strong artifact signal.
    if (!symbol.includes(".")) return true;
    // (1) source defines the exact same qualified symbol → name collision.
    if (definedByFile.get(l.sourceFile)?.has(symbol)) return false;
    // (2) target's class derives from a class in the source file → base→derived
    //     virtual-dispatch back-edge.
    const targetClass = symbol.slice(0, symbol.indexOf("."));
    if (targetClass && ancestorDefinedIn(targetClass, l.sourceFile)) return false;
    return true;
  });
}

/** Strip generics/namespace from a base-type reference (`Foo.Bar<T>` → `Bar`). */
function bareTypeName(type: string): string {
  let t = type.trim().replace(/<.*$/, "");
  const dot = t.lastIndexOf(".");
  if (dot >= 0) t = t.slice(dot + 1);
  return t.trim();
}

/**
 * Collapse duplicate symbol links: the same caller, target symbol and
 * (normalized) call name keep one edge. The higher-confidence duplicate wins;
 * on a tie the earliest source line does, so the report points at the first
 * occurrence.
 *
 * @param links - Links in discovery order
 * @returns A new array; the survivors keep their first-seen position
 */
export function dedupSymbolLinks(links: SymbolLink[]): SymbolLink[] {
  const seen = new Map<string, number>();
  const result: SymbolLink[] = [];

  for (const link of links) {
    // Include sourceSymbol so distinct callers (e.g. route handler vs.
    // helper function in the same file) don't get collapsed into one edge.
    // The normalization on callName is the only loosening over the upstream
    // dedup — it catches case/punctuation variants pointing at the same
    // target symbol from the same caller.
    const key = [
      link.sourceFile,
      link.sourceSymbol,
      link.targetFile,
      link.targetSymbol,
      normalize(link.callName),
    ].join("::");

    const existingIdx = seen.get(key);
    if (existingIdx === undefined) {
      seen.set(key, result.length);
      result.push(link);
      continue;
    }

    const existing = result[existingIdx]!;
    const existingRank = existing.confidence ? CONFIDENCE_RANK[existing.confidence] : 0;
    const newRank = link.confidence ? CONFIDENCE_RANK[link.confidence] : 0;
    if (newRank > existingRank) {
      result[existingIdx] = link;
    } else if (newRank === existingRank && link.sourceLine < existing.sourceLine) {
      // Tiebreak: keep the earliest source line so the report points at the
      // first occurrence rather than a later duplicate.
      result[existingIdx] = link;
    }
  }
  return result;
}
