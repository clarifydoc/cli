import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "./base.js";
import type { ImportInfo, ExportInfo, Language } from "./base.js";
import { stripQuotes } from "../node-helpers.js";

export class JavaScriptImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      // Static: import ... from "module"
      if (child.type === "import_statement") {
        imports.push(this.parseImportStatement(child));
        continue;
      }

      // require() calls: const x = require("module")
      if (
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        this.extractRequireCalls(child, imports);
        continue;
      }

      // expression_statement can contain require() or dynamic import()
      if (child.type === "expression_statement") {
        const expr = child.child(0);
        if (expr) this.extractCallImports(expr, imports, child.startPosition.row + 1);
      }
    }
  }

  private parseImportStatement(node: Node): ImportInfo {
    const source = node.childForFieldName("source");
    const sourceText = source ? stripQuotes(source.text) : "";

    // Detect type-only imports: `import type { Foo } from ...`
    let isType = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "type" || child.text === "type") {
        // Check if "type" keyword appears before the import clause
        const next = node.child(i + 1);
        if (next && (next.type === "import_clause" || next.type === "named_imports")) {
          isType = true;
        }
        break;
      }
    }

    const info: ImportInfo = {
      source: sourceText,
      specifiers: [],
      isDefault: false,
      isNamespace: false,
      isType,
      line: node.startPosition.row + 1,
    };

    for (let j = 0; j < node.childCount; j++) {
      const part = node.child(j)!;

      if (part.type === "import_clause") {
        for (let k = 0; k < part.childCount; k++) {
          const clause = part.child(k)!;
          if (clause.type === "identifier") {
            info.isDefault = true;
            info.specifiers.push(clause.text);
          } else if (clause.type === "named_imports") {
            for (let l = 0; l < clause.childCount; l++) {
              const spec = clause.child(l)!;
              if (spec.type === "import_specifier") {
                const name =
                  spec.childForFieldName("alias")?.text ??
                  spec.childForFieldName("name")?.text ??
                  spec.text;
                info.specifiers.push(name);
              }
            }
          } else if (clause.type === "namespace_import") {
            info.isNamespace = true;
            const alias = clause.childForFieldName("alias") ?? clause.child(1);
            if (alias) info.specifiers.push(alias.text);
          }
        }
      }
    }

    // Side-effect import: `import "module"` — no clause, no specifiers
    return info;
  }

  /** Extract require("module") from variable declarations */
  private extractRequireCalls(declNode: Node, imports: ImportInfo[]): void {
    for (let i = 0; i < declNode.childCount; i++) {
      const decl = declNode.child(i)!;
      if (decl.type !== "variable_declarator") continue;

      const name = decl.childForFieldName("name");
      const value = decl.childForFieldName("value");
      if (!value || value.type !== "call_expression") continue;

      const callee = value.childForFieldName("function");
      if (callee?.text !== "require") continue;

      const args = value.childForFieldName("arguments");
      if (!args || args.childCount < 2) continue;

      const firstArg = args.child(1);
      if (!firstArg || firstArg.type !== "string") continue;

      const source = stripQuotes(firstArg.text);
      const specifiers: string[] = [];
      let isDefault = false;
      let isNamespace = false;

      if (name) {
        if (name.type === "identifier") {
          // const foo = require("bar") — default-like import
          specifiers.push(name.text);
          isDefault = true;
        } else if (name.type === "object_pattern") {
          // const { a, b } = require("bar") — destructured
          for (let j = 0; j < name.childCount; j++) {
            const prop = name.child(j)!;
            if (prop.type === "shorthand_property_identifier_pattern" || prop.type === "identifier") {
              specifiers.push(prop.text);
            } else if (prop.type === "pair_pattern") {
              const alias = prop.childForFieldName("value");
              specifiers.push(alias?.text ?? prop.text);
            }
          }
        }
      }

      imports.push({
        source,
        specifiers,
        isDefault,
        isNamespace,
        isType: false,
        line: declNode.startPosition.row + 1,
      });
    }
  }

  /** Extract dynamic import() or bare require() from expressions */
  private extractCallImports(node: Node, imports: ImportInfo[], line: number): void {
    if (node.type !== "call_expression") return;

    const callee = node.childForFieldName("function");
    if (!callee) return;

    // Dynamic import("module") or require("module") as standalone expression
    if (callee.type === "import" || callee.text === "require") {
      const args = node.childForFieldName("arguments");
      if (!args || args.childCount < 2) return;

      const firstArg = args.child(1);
      if (!firstArg || firstArg.type !== "string") return;

      imports.push({
        source: stripQuotes(firstArg.text),
        specifiers: [],
        isDefault: false,
        isNamespace: false,
        isType: false,
        line,
      });
    }
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "export_statement") {
        const declaration = child.childForFieldName("declaration");
        const line = child.startPosition.row + 1;

        if (child.text.includes("default")) {
          exports.push({ name: "default", kind: "default", line });
          continue;
        }

        if (declaration) {
          const kind = this.getDeclarationKind(declaration.type);
          const name =
            declaration.childForFieldName("name")?.text ?? "anonymous";
          exports.push({ name, kind, line });
        }

        // Named re-exports: export { x } from './y'
        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j)!;
          if (part.type === "export_clause") {
            for (let k = 0; k < part.childCount; k++) {
              const spec = part.child(k)!;
              if (spec.type === "export_specifier") {
                const name =
                  spec.childForFieldName("alias")?.text ??
                  spec.childForFieldName("name")?.text ??
                  spec.text;
                exports.push({ name, kind: "re-export", line });
              }
            }
          }
        }
      }
    }
  }

  private getDeclarationKind(nodeType: string): ExportInfo["kind"] {
    switch (nodeType) {
      case "function_declaration":
      case "arrow_function":
        return "function";
      case "class_declaration":
        return "class";
      case "type_alias_declaration":
        return "type";
      case "interface_declaration":
        return "interface";
      case "enum_declaration":
        return "enum";
      default:
        return "variable";
    }
  }
}
