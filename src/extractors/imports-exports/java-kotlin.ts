import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "./base.js";
import type { ImportInfo, ExportInfo, Language } from "./base.js";

export class JavaKotlinImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "import_declaration") {
        // Java: import foo.bar.Baz;
        const text = child.text
          .replace(/^import\s+/, "")
          .replace(/;$/, "")
          .replace(/^static\s+/, "")
          .trim();
        const parts = text.split(".");
        const lastPart = parts[parts.length - 1];

        imports.push({
          source: text,
          specifiers: lastPart === "*" ? [] : [lastPart],
          isDefault: false,
          isNamespace: lastPart === "*",
          line: child.startPosition.row + 1,
        });
      }

      // Kotlin: import_list > import_header
      if (child.type === "import_list") {
        for (let j = 0; j < child.childCount; j++) {
          const header = child.child(j)!;
          if (header.type === "import_header") {
            const text = header.text.replace(/^import\s+/, "").trim();
            const isWildcard = text.endsWith(".*") || header.text.includes("*");
            const parts = text.replace(/\.\*$/, "").split(".");
            const lastPart = parts[parts.length - 1];

            imports.push({
              source: text.replace(/\.\*$/, ""),
              specifiers: isWildcard ? [] : [lastPart],
              isDefault: false,
              isNamespace: isWildcard,
              line: header.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    this.walkExports(node, exports);
  }

  private walkExports(node: Node, exports: ExportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "class_declaration") {
        const name = this.getName(child);
        if (this.isPublic(child)) {
          exports.push({ name, kind: "class", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "interface_declaration") {
        const name = this.getName(child);
        if (this.isPublic(child)) {
          exports.push({ name, kind: "interface", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "enum_declaration") {
        const name = this.getName(child);
        exports.push({ name, kind: "enum", line: child.startPosition.row + 1 });
      } else if (child.type === "object_declaration") {
        const name = this.getName(child);
        exports.push({ name, kind: "class", line: child.startPosition.row + 1 });
      } else if (child.type === "function_declaration") {
        // Kotlin top-level functions
        const name = this.getName(child);
        exports.push({ name, kind: "function", line: child.startPosition.row + 1 });
      }

      // Recurse into package/namespace containers
      if (child.type === "program" || child.type === "source_file") {
        this.walkExports(child, exports);
      }
    }
  }

  private getName(node: Node): string {
    const fieldName = node.childForFieldName("name");
    if (fieldName) return fieldName.text;

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "type_identifier" || child.type === "simple_identifier") {
        return child.text;
      }
    }
    return "anonymous";
  }

  private isPublic(node: Node): boolean {
    // Kotlin: public by default, check for private/internal
    // Java: check for public modifier, default to exported
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "modifiers" || child.type === "visibility_modifier") {
        if (child.text.includes("private") || child.text.includes("internal")) {
          return false;
        }
      }
    }
    return true;
  }
}
