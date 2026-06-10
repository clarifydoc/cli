import type { Node, Tree } from "web-tree-sitter";
import type { DataSourceInfo, CallInfo, Language } from "../../types/analysis.js";
import { getCallName } from "../shared/node-helpers.js";

/**
 * Abstract base for language-specific data-source extractors.
 * Each language plugin extends this and implements `visitNode`.
 */
export abstract class DataSourceExtractor {
  /** Languages this extractor handles */
  abstract readonly languages: Language[];

  /** Extract all data sources from the given AST */
  extract(tree: Tree, _sourceText: string): DataSourceInfo[] {
    const sources: DataSourceInfo[] = [];
    this.walk(tree.rootNode, sources);
    return sources;
  }

  /** Recursively walk the AST; calls `visitNode` on each node */
  protected walk(node: Node, sources: DataSourceInfo[]): void {
    this.visitNode(node, sources);
    for (const child of node.children) {
      this.walk(child, sources);
    }
  }

  /** Inspect a single AST node and push any data sources found */
  protected abstract visitNode(node: Node, sources: DataSourceInfo[]): void;

  /** Create a DataSourceInfo with default calls: [] */
  protected ds(info: Omit<DataSourceInfo, "calls"> & { calls?: CallInfo[] }): DataSourceInfo {
    return { ...info, calls: info.calls ?? [] };
  }

  /** Extract a function name from an identifier or member_expression node */
  protected getFunctionName(node: Node | null): string | null {
    if (!node) return null;
    return getCallName(node) ?? (node.type === "identifier" ? node.text : null);
  }
}
