import type { Node, Tree } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../../types/analysis.js";
import { stringValue } from "./syntax.js";

/**
 * `open Shop.Domain` — a module or namespace whose names come into scope
 * without being named (the manifest's `importsShareScope`). In a script,
 * `#load "helpers.fsx"` loads a file and `#r "nuget: Dapper"` a package.
 */
export class FSharpImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["fsharp"];

  extractImports(tree: Tree, _sourceText: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    this.collectImports(tree.rootNode, imports);
    return imports;
  }

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (const child of node.namedChildren) {
      const line = child.startPosition.row + 1;
      if (child.type === "import_decl") {
        const source = child.namedChildren.find((c) => c.type === "long_identifier")?.text;
        if (source) imports.push({ source, specifiers: [source.split(".").pop()!], isDefault: false, isNamespace: true, isType: false, line });
      } else if (child.type === "fsi_directive_decl") {
        const arg = child.namedChildren.map(stringValue).find((v) => v !== null) ?? null;
        const directive = /^#(\w+)/.exec(child.text)?.[1];
        if (!arg) continue;
        if (directive === "load") {
          const source = /^\.{0,2}\//.test(arg) ? arg : `./${arg}`;
          imports.push({ source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line });
        } else if (directive === "r") {
          const pkg = /^nuget:\s*([^,\s]+)/i.exec(arg)?.[1];
          if (pkg) imports.push({ source: pkg, specifiers: [], isDefault: false, isNamespace: true, isType: false, line });
        }
      } else if (/^(?:named_module|namespace|module_defn)$/.test(child.type)) {
        this.collectImports(child, imports);
      }
    }
  }

  protected collectExports(_node: Node, _exports: ExportInfo[]): void {}
}
