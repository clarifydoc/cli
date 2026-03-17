import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "./base.js";
import type { ImportInfo, ExportInfo, Language } from "./base.js";

export class CSharpImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["csharp"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "using_directive") {
        const name = child.childForFieldName("name")?.text ?? child.text;
        imports.push({
          source: name.replace(/^using\s+/, "").replace(/;$/, "").trim(),
          specifiers: [],
          isDefault: false,
          isNamespace: true,
          line: child.startPosition.row + 1,
        });
      }
    }
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    this.walkCsharpNode(node, exports);
  }

  private walkCsharpNode(node: Node, exports: ExportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

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
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "modifier" && child.text === "public") return true;
    }
    return true; // Default to treating as exported
  }
}
