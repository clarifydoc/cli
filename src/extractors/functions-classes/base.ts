import type { Node, Tree } from "web-tree-sitter";
import type {
  FunctionInfo,
  ClassInfo,
  ParamInfo,
  PropertyInfo,
  Language,
} from "../../types/analysis.js";
import { findChildByType as sharedFindChildByType } from "../shared/node-helpers.js";

/**
 * Abstract base for language-specific function/class extractors.
 * Each language plugin extends this and implements the extraction methods.
 */
export abstract class FunctionClassExtractor {
  /** Languages this extractor handles */
  abstract readonly languages: Language[];

  /** Extract top-level functions from the AST */
  extractFunctions(tree: Tree, _sourceText: string): FunctionInfo[] {
    const functions: FunctionInfo[] = [];
    this.collectFunctions(tree.rootNode, functions);
    return functions;
  }

  /** Extract classes/interfaces from the AST */
  extractClasses(tree: Tree, _sourceText: string): ClassInfo[] {
    const classes: ClassInfo[] = [];
    this.collectClasses(tree.rootNode, classes);
    return classes;
  }

  /** Override to collect top-level functions from the AST */
  protected abstract collectFunctions(node: Node, functions: FunctionInfo[]): void;

  /** Override to collect classes from the AST */
  protected abstract collectClasses(node: Node, classes: ClassInfo[]): void;

  /** Find the first child of a given type */
  protected findChildByType(node: Node, type: string): Node | null {
    return sharedFindChildByType(node, type);
  }
}

export type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language };
