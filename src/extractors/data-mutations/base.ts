import type { Node, Tree } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../types/analysis.js";

/**
 * Abstract base for language-specific data-mutation extractors.
 * Each language plugin extends this and implements `walkNode`.
 */
export abstract class DataMutationExtractor {
  /** Languages this extractor handles */
  abstract readonly languages: Language[];

  /** Extract all data mutations from the given AST */
  extract(tree: Tree, sourceText: string): DataMutationInfo[] {
    this.beginFile(tree, sourceText);
    try {
      const mutations: DataMutationInfo[] = [];
      this.walk(tree.rootNode, mutations);
      return mutations;
    } finally {
      this.endFile();
    }
  }

  /**
   * Per-file setup/teardown for stateful extractors. Fused walks (which call
   * `visitOne` instead of `extract`) MUST bracket the traversal with these so
   * per-file state is initialized.
   */
  beginFile(_tree: Tree, _sourceText: string): void {}
  endFile(): void {}

  /** Recursively walk the AST; override `visitNode` to collect mutations */
  protected walk(node: Node, mutations: DataMutationInfo[]): void {
    this.visitNode(node, mutations);
    for (const child of node.children) {
      this.walk(child, mutations);
    }
  }

  /** Inspect one node without recursing — for fused walks that share a single traversal. */
  visitOne(node: Node, mutations: DataMutationInfo[]): void {
    this.visitNode(node, mutations);
  }

  /** Inspect a single AST node and push any mutations found */
  protected abstract visitNode(node: Node, mutations: DataMutationInfo[]): void;

  /** Truncate a string to `maxLen`, appending "..." if exceeded */
  protected truncate(s: string | null, maxLen: number): string | null {
    if (!s) return null;
    return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
  }
}
