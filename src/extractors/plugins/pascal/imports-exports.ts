import type { Node, Tree } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";

/**
 * `uses Unit1 in 'src\Unit1.pas'` — .dpr project files name each unit's FILE.
 * tree-sitter-pascal ERRORs on the in-clause (the string never reaches the
 * AST), so the paths are scanned from the source and joined to the walked
 * imports by unit name. Only names that ARE imports get rewritten, so an
 * unrelated `for c in 'abc'` match can never invent one.
 */
const USES_IN_RE = /\b([A-Za-z_][\w.]*)\s+in\s+'([^']+)'/g;

export class PascalImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["pascal"];

  override extractImports(tree: Tree, sourceText: string): ImportInfo[] {
    const imports: ImportInfo[] = [];
    this.collectImports(tree.rootNode, imports);

    const paths = new Map<string, string>();
    for (const m of sourceText.matchAll(USES_IN_RE)) {
      paths.set(m[1]!.toLowerCase(), m[2]!.replace(/\\/g, "/"));
    }
    if (paths.size > 0) {
      for (const imp of imports) {
        const p = paths.get(imp.source.toLowerCase());
        // Keep the unit name as the specifier; the source becomes the
        // importer-relative file path, which resolves exactly.
        if (p) imp.source = p.startsWith(".") ? p : "./" + p;
      }
    }
    return imports;
  }

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    this.walkImports(node, imports);
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    this.walkExports(node, exports);
  }

  private walkImports(node: Node, imports: ImportInfo[]): void {
    for (const child of node.children) {

      if (child.type === "declUses") {
        // uses SysUtils, Classes, System.Generics.Collections;
        for (const mod of child.children) {
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
    for (const child of node.children) {

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
    for (const child of node.children) {

      if (child.type === "declProc") {
        const name = this.getProcName(child);
        exports.push({
          name,
          kind: "function",
          line: child.startPosition.row + 1,
        });
      }

      if (child.type === "declTypes") {
        for (const typeDecl of child.children) {
          if (typeDecl.type === "declType") {
            let name = "anonymous";
            let kind: ExportInfo["kind"] = "type";
            for (const part of typeDecl.children) {
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
    for (const child of declProc.children) {
      if (child.type === "identifier") return child.text;
    }
    return "anonymous";
  }
}
