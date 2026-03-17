import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "./base.js";
import type { ImportInfo, ExportInfo, Language } from "./base.js";

export class PascalImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["pascal"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    this.walkImports(node, imports);
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    this.walkExports(node, exports);
  }

  private walkImports(node: Node, imports: ImportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "declUses") {
        // uses SysUtils, Classes, System.Generics.Collections;
        for (let j = 0; j < child.childCount; j++) {
          const mod = child.child(j)!;
          if (mod.type === "moduleName") {
            const name = mod.text;
            imports.push({
              source: name,
              specifiers: [name],
              isDefault: false,
              isNamespace: true,
              isType: false,
              line: mod.startPosition.row + 1,
            });
          }
        }
      }

      // Recurse into unit/program/library/interface/implementation
      if (
        child.type === "unit" ||
        child.type === "program" ||
        child.type === "library" ||
        child.type === "interface" ||
        child.type === "implementation" ||
        child.type === "root"
      ) {
        this.walkImports(child, imports);
      }
    }
  }

  private walkExports(node: Node, exports: ExportInfo[]): void {
    // In Pascal, exports are: interface-level procedures/functions and type declarations
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      // Only export things from the interface section
      if (child.type === "interface") {
        this.walkInterfaceExports(child, exports);
      }

      // Recurse into unit/program/library
      if (
        child.type === "unit" ||
        child.type === "program" ||
        child.type === "library" ||
        child.type === "root"
      ) {
        this.walkExports(child, exports);
      }
    }
  }

  private walkInterfaceExports(node: Node, exports: ExportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "declProc") {
        const name = this.getProcName(child);
        exports.push({
          name,
          kind: "function",
          line: child.startPosition.row + 1,
        });
      }

      if (child.type === "declTypes") {
        for (let j = 0; j < child.childCount; j++) {
          const typeDecl = child.child(j)!;
          if (typeDecl.type === "declType") {
            let name = "anonymous";
            let kind: ExportInfo["kind"] = "type";
            for (let k = 0; k < typeDecl.childCount; k++) {
              const part = typeDecl.child(k)!;
              if (part.type === "identifier") name = part.text;
              if (part.type === "declClass") kind = "class";
              if (part.type === "declIntf") kind = "interface";
              if (part.type === "declEnum") kind = "enum";
            }
            exports.push({
              name,
              kind,
              line: typeDecl.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  private getProcName(declProc: Node): string {
    for (let i = 0; i < declProc.childCount; i++) {
      const child = declProc.child(i)!;
      if (child.type === "identifier") return child.text;
    }
    return "anonymous";
  }
}
