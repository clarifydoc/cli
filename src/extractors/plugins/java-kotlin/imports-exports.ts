import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";
import { getNameFromNode } from "../../shared/node-helpers.js";

export class JavaKotlinImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (const child of node.children) {

      // Java: import_declaration
      if (child.type === "import_declaration") {
        imports.push(this.parseJavaImport(child));
      }

      // Kotlin: import_list > import_header
      if (child.type === "import_list") {
        for (const header of child.children) {
          if (header.type === "import_header") {
            imports.push(this.parseKotlinImport(header));
          }
        }
      }
    }
  }

  /** Parse Java `import foo.bar.Baz;` or `import static foo.bar.Baz.method;` */
  private parseJavaImport(node: Node): ImportInfo {
    let isStatic = false;
    let importPath = "";

    for (const child of node.children) {
      // "static" keyword
      if (child.text === "static") {
        isStatic = true;
        continue;
      }
      // The actual path: scoped_identifier or identifier
      if (
        child.type === "scoped_identifier" ||
        child.type === "identifier"
      ) {
        importPath = child.text;
        continue;
      }
      // Wildcard: import foo.bar.*
      if (child.type === "asterisk") {
        importPath = importPath ? importPath + ".*" : "*";
      }
    }

    // Fallback if AST traversal didn't find the path
    if (!importPath) {
      importPath = node.text
        .replace(/^import\s+/, "")
        .replace(/^static\s+/, "")
        .replace(/;$/, "")
        .trim();
    }

    const parts = importPath.split(".");
    const lastPart = parts[parts.length - 1];
    const isWildcard = lastPart === "*";

    return {
      source: isWildcard ? parts.slice(0, -1).join(".") : importPath,
      specifiers: isWildcard ? [] : [lastPart],
      isDefault: false,
      isNamespace: isWildcard,
      isType: !isStatic && false, // Java doesn't have type-only imports
      line: node.startPosition.row + 1,
    };
  }

  /** Parse Kotlin `import foo.bar.Baz` or `import foo.bar.*` via AST */
  private parseKotlinImport(node: Node): ImportInfo {
    // Kotlin import_header children: "import" keyword, identifier/dot_qualified_expression
    let importPath = "";
    let isWildcard = false;
    // `import garage.Mechanic as Fixer`: the file calls it `Fixer`.
    let alias: string | undefined;

    for (const child of node.children) {
      if (child.type === "import_alias") {
        alias = child.namedChildren.find((c) => c.type === "type_identifier" || c.type === "simple_identifier")?.text;
        continue;
      }

      // The import path is a dot_qualified_expression or identifier
      if (
        child.type === "dot_qualified_expression" ||
        child.type === "identifier" ||
        child.type === "simple_identifier"
      ) {
        importPath = child.text;
        continue;
      }
      // Wildcard: import foo.bar.*
      if (child.type === "multi_import" || child.text === "*") {
        isWildcard = true;
      }
    }

    // Fallback to text parsing
    if (!importPath) {
      importPath = node.text.replace(/^import\s+/, "").trim();
    }

    if (importPath.endsWith(".*")) {
      isWildcard = true;
      importPath = importPath.slice(0, -2);
    }

    const parts = importPath.split(".");
    const lastPart = parts[parts.length - 1]!;
    const aliased = !isWildcard && alias && alias !== lastPart ? alias : undefined;

    return {
      source: importPath,
      specifiers: isWildcard ? [] : [aliased ?? lastPart],
      isDefault: false,
      isNamespace: isWildcard,
      isType: false,
      line: node.startPosition.row + 1,
      ...(aliased ? { aliases: { [aliased]: lastPart } } : {}),
    };
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    this.walkExports(node, exports);
  }

  private walkExports(node: Node, exports: ExportInfo[]): void {
    for (const child of node.children) {

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
    return getNameFromNode(node) ?? "anonymous";
  }

  private isPublic(node: Node): boolean {
    for (const child of node.children) {
      if (child.type === "modifiers" || child.type === "visibility_modifier") {
        if (child.text.includes("private") || child.text.includes("internal")) {
          return false;
        }
      }
    }
    return true;
  }
}
