import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "./base.js";
import type { ImportInfo, ExportInfo, Language } from "./base.js";

export class PythonImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["python"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "import_statement") {
        // import foo, bar
        const names: string[] = [];
        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j)!;
          if (part.type === "dotted_name" || part.type === "aliased_import") {
            names.push(part.text);
          }
        }
        imports.push({
          source: names[0] ?? child.text,
          specifiers: names,
          isDefault: false,
          isNamespace: true,
          line: child.startPosition.row + 1,
        });
      } else if (child.type === "import_from_statement") {
        // from foo import bar, baz
        const module = child.childForFieldName("module_name")?.text ?? "";
        const specifiers: string[] = [];
        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j)!;
          if (
            part.type === "dotted_name" &&
            part !== child.childForFieldName("module_name")
          ) {
            specifiers.push(part.text);
          } else if (part.type === "aliased_import") {
            specifiers.push(part.text);
          }
        }
        imports.push({
          source: module,
          specifiers,
          isDefault: false,
          isNamespace: false,
          line: child.startPosition.row + 1,
        });
      }
    }
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    // In Python, top-level functions and classes are "exports"
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "function_definition") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (!name.startsWith("_")) {
          exports.push({
            name,
            kind: "function",
            line: child.startPosition.row + 1,
          });
        }
      } else if (child.type === "class_definition") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (!name.startsWith("_")) {
          exports.push({
            name,
            kind: "class",
            line: child.startPosition.row + 1,
          });
        }
      }
    }
  }
}
