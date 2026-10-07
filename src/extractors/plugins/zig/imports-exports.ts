import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../../types/analysis.js";
import { CONTAINER_TYPES, declValue, importSource, isPub } from "./syntax.js";

/**
 * `const db = @import("db.zig");` imports a file, relative to the importing
 * one; `@import("zap")` a package (named in `build.zig`), `@import("std")`
 * the standard library. `const Router = @import("router.zig").Router;` binds
 * one declaration of it. Every `pub` declaration of the file is an export.
 */
export class ZigImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["zig"];

  protected collectImports(root: Node, imports: ImportInfo[]): void {
    for (const call of root.descendantsOfType("builtin_function")) {
      const source = importSource(call);
      if (!source) continue;
      const decl = call.parent?.type === "variable_declaration" ? call.parent
        : call.parent?.type === "field_expression" && call.parent.parent?.type === "variable_declaration" ? call.parent.parent : null;
      const bound = decl?.namedChildren[0]?.type === "identifier" ? decl.namedChildren[0].text : null;
      const isFile = /\.zig$/.test(source);
      imports.push({
        source: isFile && !/^\.{1,2}\//.test(source) ? `./${source}` : source,
        specifiers: bound ? [bound] : [],
        isDefault: false,
        isNamespace: call.parent?.type !== "field_expression",
        isType: false,
        line: call.startPosition.row + 1,
      });
    }
  }

  protected collectExports(root: Node, exports: ExportInfo[]): void {
    for (const child of root.namedChildren) {
      if (!isPub(child)) continue;
      const line = child.startPosition.row + 1;
      if (child.type === "function_declaration") {
        const name = child.childForFieldName("name")?.text;
        if (name) exports.push({ name, kind: "function", line });
      } else if (child.type === "variable_declaration") {
        const name = child.namedChildren[0]?.text;
        const value = declValue(child);
        if (name) exports.push({ name, kind: value && CONTAINER_TYPES.has(value.type) ? (value.type === "enum_declaration" ? "enum" : "class") : "variable", line });
      }
    }
  }
}
