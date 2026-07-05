import type { Node, Tree } from "web-tree-sitter";
import type { DataMutationInfo, DataSourceInfo, Language } from "../types/analysis.js";
import { dataSourceExtractorFor } from "./data-sources/index.js";
import { dataMutationExtractorFor } from "./data-mutations/index.js";

/**
 * Extract data sources and data mutations in ONE shared tree walk.
 *
 * Both extractor families are stateless per-node visitors over a full
 * pre-order traversal, so when a language has both, walking once and feeding
 * each visitor per node produces exactly the same two result arrays as the
 * two separate `extract` calls — at half the traversal cost (the walks are a
 * top per-file profile item on AST-heavy corpora).
 */
export function extractDataAccess(
  tree: Tree,
  sourceText: string,
  language: Language,
): { dataSources: DataSourceInfo[]; dataMutations: DataMutationInfo[] } {
  const sourceExt = dataSourceExtractorFor(language);
  const mutationExt = dataMutationExtractorFor(language);

  const dataSources: DataSourceInfo[] = [];
  const dataMutations: DataMutationInfo[] = [];

  if (sourceExt && mutationExt) {
    sourceExt.beginFile(tree, sourceText);
    mutationExt.beginFile(tree, sourceText);
    try {
      const walk = (node: Node): void => {
        sourceExt.visitOne(node, dataSources);
        mutationExt.visitOne(node, dataMutations);
        for (const child of node.children) walk(child);
      };
      walk(tree.rootNode);
    } finally {
      sourceExt.endFile();
      mutationExt.endFile();
    }
    return { dataSources, dataMutations };
  }

  return {
    dataSources: sourceExt ? sourceExt.extract(tree, sourceText) : dataSources,
    dataMutations: mutationExt ? mutationExt.extract(tree, sourceText) : dataMutations,
  };
}
