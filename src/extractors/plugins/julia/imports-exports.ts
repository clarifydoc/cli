import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../../types/analysis.js";
import { calleeName, stringValue } from "./syntax.js";

/**
 * `using Genie, LibPQ` / `import HTTP` / `using Genie.Router: route` bring a
 * package or module in; `include("db.jl")` pastes a file into the including
 * one, relative to it — its names come into scope (`importsShareScope`).
 */
export class JuliaImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["julia"];

  protected collectImports(root: Node, imports: ImportInfo[]): void {
    const visit = (node: Node) => {
      const line = node.startPosition.row + 1;
      if (node.type === "using_statement" || node.type === "import_statement") {
        for (const c of node.namedChildren) {
          const target = c.type === "selected_import" ? c.namedChildren[0] : c;
          const source = target?.type === "identifier" ? target.text : target?.type === "scoped_identifier" ? target.text : null;
          if (source) imports.push({ source, specifiers: [], isDefault: false, isNamespace: true, isType: false, line });
        }
        return;
      }
      if (node.type === "call_expression" && calleeName(node.namedChildren[0]) === "include") {
        const path = stringValue(node.namedChildren.find((c) => c.type === "argument_list")?.namedChildren[0]);
        if (path) imports.push({ source: /^\.{1,2}\//.test(path) ? path : `./${path}`, specifiers: [], isDefault: false, isNamespace: false, isType: false, line });
        return;
      }
      for (const c of node.namedChildren) visit(c);
    };
    visit(root);
  }

  protected collectExports(_node: Node, _exports: ExportInfo[]): void {}
}
