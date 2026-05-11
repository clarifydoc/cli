import type { Confidence } from "../../types/analysis.js";

/**
 * Rank scales for the EXTRACTED / INFERRED / AMBIGUOUS scale. Two scales
 * exist because two questions get asked of the same enum:
 *
 *   BEST_RANK     — used by dedup paths: "which entry should win when
 *                   multiple SymbolLinks / TypeReferences resolve to the
 *                   same target?" Higher = more certain → keep this one.
 *
 *   SURPRISE_RANK — inverse, used only by the topology surprise scorer:
 *                   "which connection is most worth flagging for a human?"
 *                   Higher = more uncertain → more interesting to surface.
 *
 * Centralising both prevents a future copy-paste from picking the wrong
 * scale silently.
 */
export const BEST_RANK: Record<Confidence, number> = {
  EXTRACTED: 3,
  INFERRED: 2,
  AMBIGUOUS: 1,
};

export const SURPRISE_RANK: Record<Confidence, number> = {
  EXTRACTED: 1,
  INFERRED: 2,
  AMBIGUOUS: 3,
};

/**
 * Pick the more-certain of two confidence values. Used when merging
 * multiple pieces of evidence onto the same edge.
 */
export function bestConfidence(a: Confidence | undefined, b: Confidence | undefined): Confidence | undefined {
  if (!a) return b;
  if (!b) return a;
  return BEST_RANK[a] >= BEST_RANK[b] ? a : b;
}
