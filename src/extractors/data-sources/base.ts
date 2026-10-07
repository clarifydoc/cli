import type { Node, Tree } from "web-tree-sitter";
import type { DataSourceInfo, CallInfo, FileAnalysis, Language } from "../../types/analysis.js";
import type { ProjectContext } from "../../types/project.js";

/** An api-call row aggregated across the project: the data source plus the file it was found in. */
export type ProjectApiCall = DataSourceInfo & { filePath: string };
import { getCallName } from "../shared/node-helpers.js";

/**
 * Abstract base for language-specific data-source extractors.
 * Each language plugin extends this and implements `visitNode`.
 */
export abstract class DataSourceExtractor {
  /** Languages this extractor handles */
  abstract readonly languages: Language[];

  /** Extract all data sources from the given AST */
  extract(tree: Tree, sourceText: string): DataSourceInfo[] {
    this.beginFile(tree, sourceText);
    try {
      const sources: DataSourceInfo[] = [];
      this.walk(tree.rootNode, sources);
      return sources;
    } finally {
      this.endFile();
    }
  }

  /**
   * Per-file setup/teardown for stateful extractors. Fused walks (which call
   * `visitOne` instead of `extract`) MUST bracket the traversal with these so
   * per-file state (e.g. URL-const or table-alias maps) is initialized.
   */
  beginFile(_tree: Tree, _sourceText: string): void {}
  endFile(): void {}

  /** Recursively walk the AST; calls `visitNode` on each node */
  protected walk(node: Node, sources: DataSourceInfo[]): void {
    this.visitNode(node, sources);
    for (const child of node.children) {
      this.walk(child, sources);
    }
  }

  /** Inspect one node without recursing — for fused walks that share a single traversal. */
  visitOne(node: Node, sources: DataSourceInfo[]): void {
    this.visitNode(node, sources);
  }

  /** Inspect a single AST node and push any data sources found */
  protected abstract visitNode(node: Node, sources: DataSourceInfo[]): void;

  /**
   * Optional project-level pass over EVERY api-call row in the project — from
   * any language, since a helper defined in TypeScript is called from Vue and
   * Svelte files too. Rewrites targets in place (a URL-builder call → the URL
   * it builds) and returns how many it rewrote. Runs on the aggregated copies
   * only, before the cross-tier linker; per-file JSON is untouched.
   */
  resolveProject?(calls: ProjectApiCall[], analyses: FileAnalysis[], ctx: ProjectContext): number;

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
