import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";

export class CSharpImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["csharp"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (const child of node.children) {
      if (child.type === "using_directive") {
        imports.push(this.parseUsingDirective(child));
      }
    }
  }

  /** Parse `using System.Linq;`, `using static System.Math;`, `using Foo = Bar.Baz;` */
  private parseUsingDirective(node: Node): ImportInfo {
    let isStatic = false;
    let source = "";
    let alias: string | null = null;

    // Walk children to extract the namespace via AST rather than text regex
    for (const child of node.children) {

      // "static" keyword
      if (child.text === "static") {
        isStatic = true;
        continue;
      }

      // The namespace/type name: qualified_name, identifier, or name_equals (for alias)
      if (child.type === "qualified_name" || child.type === "identifier_name") {
        source = child.text;
        continue;
      }
      if (child.type === "identifier" && !source) {
        source = child.text;
        continue;
      }

      // Alias: `using Alias = Namespace.Type`
      if (child.type === "name_equals") {
        alias = child.childForFieldName("name")?.text ?? null;
        continue;
      }
    }

    // Fallback to the `name` field
    if (!source) {
      const nameNode = node.childForFieldName("name");
      if (nameNode) {
        source = nameNode.text;
      }
    }

    // Last resort: strip keywords from text
    if (!source) {
      source = node.text
        .replace(/^using\s+/, "")
        .replace(/^static\s+/, "")
        .replace(/;$/, "")
        .trim();
    }

    const specifiers = alias ? [alias] : [];

    return {
      source,
      specifiers,
      isDefault: false,
      isNamespace: !isStatic && !alias,
      isType: false,
      line: node.startPosition.row + 1,
    };
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    this.walkCsharpNode(node, exports);
  }

  private walkCsharpNode(node: Node, exports: ExportInfo[]): void {
    for (const child of node.children) {

      if (
        child.type === "namespace_declaration" ||
        child.type === "file_scoped_namespace_declaration"
      ) {
        const body = child.childForFieldName("body");
        if (body) this.walkCsharpNode(body, exports);
        this.walkCsharpNode(child, exports);
      } else if (child.type === "class_declaration") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (this.isPublic(child)) {
          exports.push({ name, kind: "class", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "interface_declaration") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (this.isPublic(child)) {
          exports.push({ name, kind: "interface", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "enum_declaration") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (this.isPublic(child)) {
          exports.push({ name, kind: "enum", line: child.startPosition.row + 1 });
        }
      }
    }
  }

  private isPublic(node: Node): boolean {
    for (const child of node.children) {
      if (child.type === "modifier" && child.text === "public") return true;
    }
    return true; // Default to treating as exported
  }
}
