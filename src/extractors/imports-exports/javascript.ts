import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "./base.js";
import type { ImportInfo, ExportInfo, Language } from "./base.js";

export class JavaScriptImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "import_statement") {
        const source = child.childForFieldName("source");
        const sourceText = source ? this.stripQuotes(source.text) : "";

        const info: ImportInfo = {
          source: sourceText,
          specifiers: [],
          isDefault: false,
          isNamespace: false,
          line: child.startPosition.row + 1,
        };

        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j)!;

          if (part.type === "import_clause") {
            for (let k = 0; k < part.childCount; k++) {
              const clause = part.child(k)!;
              if (clause.type === "identifier") {
                info.isDefault = true;
                info.specifiers.push(clause.text);
              } else if (clause.type === "named_imports") {
                for (let l = 0; l < clause.childCount; l++) {
                  const spec = clause.child(l)!;
                  if (spec.type === "import_specifier") {
                    const name =
                      spec.childForFieldName("alias")?.text ??
                      spec.childForFieldName("name")?.text ??
                      spec.text;
                    info.specifiers.push(name);
                  }
                }
              } else if (clause.type === "namespace_import") {
                info.isNamespace = true;
                const alias = clause.childForFieldName("alias") ?? clause.child(1);
                if (alias) info.specifiers.push(alias.text);
              }
            }
          }
        }

        imports.push(info);
      }
    }
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "export_statement") {
        const declaration = child.childForFieldName("declaration");
        const line = child.startPosition.row + 1;

        if (child.text.includes("default")) {
          exports.push({ name: "default", kind: "default", line });
          continue;
        }

        if (declaration) {
          const kind = this.getDeclarationKind(declaration.type);
          const name =
            declaration.childForFieldName("name")?.text ?? "anonymous";
          exports.push({ name, kind, line });
        }

        // Named re-exports: export { x } from './y'
        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j)!;
          if (part.type === "export_clause") {
            for (let k = 0; k < part.childCount; k++) {
              const spec = part.child(k)!;
              if (spec.type === "export_specifier") {
                const name =
                  spec.childForFieldName("alias")?.text ??
                  spec.childForFieldName("name")?.text ??
                  spec.text;
                exports.push({ name, kind: "re-export", line });
              }
            }
          }
        }
      }
    }
  }

  private getDeclarationKind(nodeType: string): ExportInfo["kind"] {
    switch (nodeType) {
      case "function_declaration":
      case "arrow_function":
        return "function";
      case "class_declaration":
        return "class";
      case "type_alias_declaration":
        return "type";
      case "interface_declaration":
        return "interface";
      case "enum_declaration":
        return "enum";
      default:
        return "variable";
    }
  }
}
