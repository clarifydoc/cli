import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";

export class PythonImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["python"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "import_statement") {
        this.parseImportStatement(child, imports);
      } else if (child.type === "import_from_statement") {
        this.parseImportFromStatement(child, imports);
      }
    }
  }

  /** `import foo`, `import foo.bar`, `import foo as f, bar as b` */
  private parseImportStatement(node: Node, imports: ImportInfo[]): void {
    const names: string[] = [];
    for (let j = 0; j < node.childCount; j++) {
      const part = node.child(j)!;
      if (part.type === "dotted_name") {
        names.push(part.text);
      } else if (part.type === "aliased_import") {
        // `import foo as f` — extract the original module name
        const original = part.childForFieldName("name");
        const alias = part.childForFieldName("alias");
        names.push(alias?.text ?? original?.text ?? part.text);
      }
    }
    imports.push({
      source: names[0] ?? node.text,
      specifiers: names,
      isDefault: false,
      isNamespace: true,
      isType: false,
      line: node.startPosition.row + 1,
    });
  }

  /** `from foo import bar, baz`, `from foo import *`, `from foo import bar as b` */
  private parseImportFromStatement(node: Node, imports: ImportInfo[]): void {
    const moduleNode = node.childForFieldName("module_name");
    const module = moduleNode?.text ?? "";
    // Track module node position to avoid matching it as a specifier
    const moduleRow = moduleNode?.startPosition.row ?? -1;
    const moduleCol = moduleNode?.startPosition.column ?? -1;
    const specifiers: string[] = [];
    let isNamespace = false;
    let pastImportKeyword = false;

    for (let j = 0; j < node.childCount; j++) {
      const part = node.child(j)!;

      // Track when we pass the "import" keyword — specifiers come after it
      if (part.text === "import" && part.type !== "dotted_name") {
        pastImportKeyword = true;
        continue;
      }
      if (part.text === "from") continue;

      // Skip the module name (appears before "import" keyword)
      if (
        !pastImportKeyword &&
        part.startPosition.row === moduleRow &&
        part.startPosition.column === moduleCol
      ) continue;

      // Wildcard: from foo import *
      if (part.type === "wildcard_import") {
        isNamespace = true;
        continue;
      }

      // Only collect specifiers that appear after "import"
      if (!pastImportKeyword) continue;

      // Named specifiers inside import_list: from foo import bar, baz
      if (part.type === "import_list" || part.type === "import_from_statement_body") {
        for (let k = 0; k < part.childCount; k++) {
          const spec = part.child(k)!;
          if (spec.type === "dotted_name" || spec.type === "identifier") {
            specifiers.push(spec.text);
          } else if (spec.type === "aliased_import") {
            const alias = spec.childForFieldName("alias");
            specifiers.push(alias?.text ?? spec.childForFieldName("name")?.text ?? spec.text);
          }
        }
        continue;
      }

      // Bare specifiers after "import" keyword (no import_list wrapper)
      if (part.type === "dotted_name" || part.type === "identifier") {
        specifiers.push(part.text);
      } else if (part.type === "aliased_import") {
        const alias = part.childForFieldName("alias");
        specifiers.push(alias?.text ?? part.childForFieldName("name")?.text ?? part.text);
      }
    }

    imports.push({
      source: module,
      specifiers,
      isDefault: false,
      isNamespace,
      isType: false,
      line: node.startPosition.row + 1,
    });
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    // In Python, top-level functions and classes are "exports"
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "function_definition") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (!name.startsWith("_")) {
          exports.push({ name, kind: "function", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "class_definition") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (!name.startsWith("_")) {
          exports.push({ name, kind: "class", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "decorated_definition") {
        // Decorated functions/classes are also exports
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j)!;
          if (inner.type === "function_definition") {
            const name = inner.childForFieldName("name")?.text ?? "anonymous";
            if (!name.startsWith("_")) {
              exports.push({ name, kind: "function", line: inner.startPosition.row + 1 });
            }
          } else if (inner.type === "class_definition") {
            const name = inner.childForFieldName("name")?.text ?? "anonymous";
            if (!name.startsWith("_")) {
              exports.push({ name, kind: "class", line: inner.startPosition.row + 1 });
            }
          }
        }
      }
    }
  }
}
