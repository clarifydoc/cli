import type { DefinitionAnswerFile } from "./answers-source.js";
import type { DefinitionQuery } from "./lsp-enhancer.js";
import { answerFrom, normalize, scipPathMapper, type DocumentSource, type ScipDocument, type ScipIndex } from "./scip.js";

/**
 * The in-memory equivalent of `scipFileAnswers` — the oracle its tests hold
 * the streaming reader to. Not used by the analyzer.
 */

/**
 * Several indexes as one: a polyglot repository has one per indexer, and
 * SCIP merges by concatenating documents. Each index's paths are mapped to
 * the analysis's on their own (they may have been built at different roots);
 * a document the analysis does not have is left out. A path two indexers
 * both cover stays two documents — each keeps its own encoding and its own
 * `local N` symbols.
 */
export function mergeScip(indexes: readonly ScipIndex[], analysisFiles?: ReadonlySet<string>): ScipIndex {
  const documents: ScipDocument[] = [];
  for (const index of indexes) {
    const map = analysisFiles ? scipPathMapper(index.documents, analysisFiles) : normalize;
    for (const d of index.documents) {
      const path = map(normalize(d.path));
      if (path) documents.push({ ...d, path });
    }
  }
  const tools = [...new Set(indexes.map((i) => i.tool).filter((t): t is string => !!t))];
  return { ...(indexes[0]?.projectRoot ? { projectRoot: indexes[0].projectRoot } : {}), ...(tools.length ? { tool: tools[0]!, tools } : {}), documents };
}

/**
 * Answers to the layer-2 questions from a SCIP index. Local symbols
 * (`local N`) resolve within their document; a definition outside the
 * analysis (a dependency's sources) is not a target.
 */
export function scipAnswers(
  index: ScipIndex,
  queries: readonly DefinitionQuery[],
  mapPath: (p: string) => string | null = normalize,
  /** The text of a 0-based line of an analysis file, for a document whose offsets are not UTF-16 and which carries no text. */
  lineText?: (path: string, line0: number) => string | undefined,
): DefinitionAnswerFile {
  const documents: DocumentSource = function* () {
    for (const d of index.documents) {
      const path = mapPath(normalize(d.path));
      if (path) yield path === d.path ? d : { ...d, path };
    }
  };
  return { source: "scip", servers: index.tools ?? [index.tool ?? "scip"], answers: answerFrom(documents, queries, lineText) };
}
