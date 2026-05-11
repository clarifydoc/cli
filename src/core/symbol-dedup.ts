import type { SymbolLink } from "../types/analysis.js";
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
