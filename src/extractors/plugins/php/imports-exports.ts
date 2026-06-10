import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";

/**
 * PHP `use` declarations. Three shapes the grammar produces:
 *
 *   use App\Models\User;
 *   use App\Models\User as U;
 *   use App\Models\{User, Post as P};   // namespace_use_group
 *
 * PHP has no "exports" — top-level classes/functions are universally visible.
 * We surface them as ExportInfo for consistency with other languages.
 */
export class PhpImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["php"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (const child of node.children) {
      if (child.type === "namespace_use_declaration") {
        this.parseUse(child, imports);
      }
    }
  }

  private parseUse(node: Node, imports: ImportInfo[]): void {
    const line = node.startPosition.row + 1;
    const useType = this.parseUseType(node); // "function" | "const" | null

    // Grouped: `use App\Models\{User, Post as P}` — find a namespace_name prefix
    // followed by a namespace_use_group.
    const group = this.findChild(node, "namespace_use_group");
    if (group) {
      const prefix = this.findChild(node, "namespace_name")?.text ?? "";
      for (const clause of group.children) {
        if (clause.type === "namespace_use_clause" || clause.type === "namespace_use_group_clause") {
          this.pushClause(clause, imports, line, prefix, useType);
        }
      }
      return;
    }

    // Flat: one or more `namespace_use_clause` direct children.
    for (const clause of node.children) {
      if (clause.type === "namespace_use_clause") {
        this.pushClause(clause, imports, line, "", useType);
      }
    }
  }

  private pushClause(
    clause: Node,
    imports: ImportInfo[],
    line: number,
    prefix: string,
    useType: "function" | "const" | null,
  ): void {
    // First name-shaped child = the qualified path.
    let pathText = "";
    let alias: string | null = null;
    for (const c of clause.children) {
      if (
        !pathText &&
        (c.type === "qualified_name" ||
          c.type === "namespace_name" ||
          c.type === "name")
      ) {
        pathText = c.text;
      } else if (c.type === "namespace_aliasing_clause" || c.type === "namespace_use_alias_clause") {
        const aliasNode = this.findChild(c, "name");
        if (aliasNode) alias = aliasNode.text;
      }
    }
    if (!pathText) return;

    const fullPath = prefix ? `${prefix}\\${pathText}` : pathText;
    const cleanPath = fullPath.replace(/^\\/, "");
    const segments = cleanPath.split("\\");
    const leaf = alias ?? segments[segments.length - 1]!;

    imports.push({
      source: cleanPath,
      specifiers: [leaf],
      isDefault: false,
      isNamespace: false,
      isType: useType === null,
      line,
    });
  }

  /** Detect `use function ...` / `use const ...`. */
  private parseUseType(node: Node): "function" | "const" | null {
    for (const c of node.children) {
      const t = c.text.toLowerCase();
      if (t === "function") return "function";
      if (t === "const") return "const";
      // Stop scanning once we've hit the actual clause(s).
      if (c.type === "namespace_use_clause" || c.type === "namespace_use_group") break;
    }
    return null;
  }

  private findChild(node: Node, type: string): Node | null {
    for (const c of node.children) {
      if (c.type === type) return c;
    }
    return null;
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    // Top-level functions and classes are implicitly public in PHP.
    for (const child of node.children) {
      if (child.type === "function_definition") {
        const name = child.childForFieldName("name")?.text;
        if (name) exports.push({ name, kind: "function", line: child.startPosition.row + 1 });
      } else if (child.type === "class_declaration") {
        const name = child.childForFieldName("name")?.text;
        if (name) exports.push({ name, kind: "class", line: child.startPosition.row + 1 });
      } else if (child.type === "interface_declaration") {
        const name = child.childForFieldName("name")?.text;
        if (name) exports.push({ name, kind: "interface", line: child.startPosition.row + 1 });
      } else if (child.type === "trait_declaration" || child.type === "enum_declaration") {
        const name = child.childForFieldName("name")?.text;
        if (name) exports.push({ name, kind: "class", line: child.startPosition.row + 1 });
      } else if (child.type === "namespace_definition") {
        // Walk into namespace bodies — exports still bubble up to file scope.
        const body = child.childForFieldName("body") ?? this.findChildDirect(child, "compound_statement");
        if (body) this.collectExports(body, exports);
      }
    }
  }

  private findChildDirect(node: Node, type: string): Node | null {
    for (const c of node.children) {
      if (c.type === type) return c;
    }
    return null;
  }
}
