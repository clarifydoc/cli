import type { Node, Tree } from "web-tree-sitter";
import type { ImportInfo, ExportInfo, Language } from "../../types/analysis.js";

/**
 * Abstract base for language-specific import/export extractors.
 * Each language plugin extends this and implements the collection methods.
 */
export abstract class ImportExportExtractor {
  /** Languages this extractor handles */
  abstract readonly languages: Language[];

  /** Extract all imports from the AST */
  extractImports(tree: Tree, _sourceText: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    this.collectImports(tree.rootNode, imports);
    return imports;
  }

  /** Extract all exports from the AST */
  extractExports(tree: Tree, _sourceText: string): ExportInfo[] {
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
    if (
      (s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith("'") && s.endsWith("'"))
    ) {
      return s.slice(1, -1);
    }
    return s;
  }

  /** Check if a node has a child of a given type */
  protected hasChildType(node: Node, type: string): boolean {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)!.type === type) return true;
    }
    return false;
  }
}

export type { ImportInfo, ExportInfo, Language };
