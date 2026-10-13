import type { Node, Tree } from "web-tree-sitter";
import type { ImportInfo, ExportInfo, Language } from "../../types/analysis.js";
import type { TreeSitterLanguage } from "../../parsers/parser-manager.js";
import { runQuery } from "../../parsers/parser-manager.js";
import type { CaptureResult } from "../../types/plugin.js";
import { stripQuotes as sharedStripQuotes, hasChildType as sharedHasChildType } from "../shared/node-helpers.js";

/**
 * Abstract base for language-specific import/export extractors.
 * Each language plugin extends this and implements the collection methods.
 *
 * Subclasses may override `importQuery` to provide a tree-sitter S-expression
 * query for fast import matching. When set, `extractImports` will use the
 * query engine (with caching) instead of a manual tree walk.
 */
export abstract class ImportExportExtractor {
  /** Languages this extractor handles */
  abstract readonly languages: Language[];

  /**
   * Optional tree-sitter S-expression query for matching import nodes.
   * Override to enable query-based extraction (faster for large files).
   * Captures named `@node` will be passed to `importFromCapture()`.
   */
  protected importQuery: string | null = null;

  /** Extract all imports from the AST */
  extractImports(tree: Tree, _sourceText: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    this.collectImports(tree.rootNode, imports);
    return imports;
  }

  /**
   * Query-based import extraction using tree-sitter S-expression queries.
   * Call this from `extractImports` when `importQuery` is set.
   * Returns null if query execution fails (caller should fall back to manual walk).
   */
  protected async extractImportsViaQuery(
    tree: Tree,
    language: TreeSitterLanguage,
  ): Promise<ImportInfo[] | null> {
    if (!this.importQuery) return null;
    try {
      const captures = await runQuery(tree, language, this.importQuery);
      const nodes = captures.get("node") ?? [];
      return nodes.map((c) => this.importFromCapture(c));
    } catch {
      return null;
    }
  }

  /**
   * Convert a query capture into an ImportInfo.
   * Override in subclasses that set `importQuery`.
   */
  protected importFromCapture(_capture: CaptureResult): ImportInfo {
    throw new Error("importFromCapture not implemented");
  }

  /** Extract all exports from the AST. `_filePath` (posix, relative) for extractors whose exports depend on the file's role. */
  extractExports(tree: Tree, _sourceText: string, _filePath?: string): ExportInfo[] {
    const exports: ExportInfo[] = [];
    this.collectExports(tree.rootNode, exports);
    return exports;
  }

  /** Override to collect imports from the AST */
  protected abstract collectImports(node: Node, imports: ImportInfo[]): void;

  /** Override to collect exports from the AST */
  protected abstract collectExports(node: Node, exports: ExportInfo[]): void;

  /** Strip surrounding quotes from a string */
  protected stripQuotes(s: string): string {
    return sharedStripQuotes(s);
  }

  /** Check if a node has a child of a given type */
  protected hasChildType(node: Node, type: string): boolean {
    return sharedHasChildType(node, type);
  }
}

export type { ImportInfo, ExportInfo, Language };
