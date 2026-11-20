import type { ProjectAnalysis } from "../types/analysis.js";
import { proposedHunks, symbolsOfChange } from "./changed-symbols.js";
import { computeImpactDiff, type ImpactDiffResult } from "./impact-diff.js";

/**
 * The impact of an edit not made yet — what `clarifydoc_impact proposed=…` computes: the contents are
 * compared with the files as `root` holds them, the diff's lines judged against the analysis in
 * `analysisDir`, member by member. `null` content proposes deleting the file.
 */
export async function impactOfContents(
  summary: ProjectAnalysis,
  analysisDir: string,
  root: string,
  contents: ReadonlyMap<string, string | null>,
  baseLabel = "proposed edit",
): Promise<ImpactDiffResult> {
  const files = [...contents.keys()];
  const hunks = await proposedHunks(root, contents);
  return computeImpactDiff(summary, files, { baseLabel, symbols: await symbolsOfChange(root, analysisDir, summary, files, hunks, contents) });
}
