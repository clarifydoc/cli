import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";
import { stripQuotes } from "../../shared/node-helpers.js";

export class JavaScriptImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (const child of node.children) {

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

      // expression_statement can contain a bare require()
      if (child.type === "expression_statement") {
        const expr = child.child(0);
        if (expr) this.extractCallImports(expr, imports, child.startPosition.row + 1);
      }
    }

    // Dynamic import("…") can appear anywhere, not just as a top-level
    // statement — most commonly a lazy-loaded route component
    // (`{ component: () => import("./main.vue") }`), `await import(...)`, or a
    // conditional import. Walk the whole subtree so these still register as
    // import edges to the lazily-loaded module.
    this.collectDynamicImports(node, imports);
  }

  /** Recursively collect every dynamic `import("module")` call in the subtree. */
  private collectDynamicImports(node: Node, imports: ImportInfo[]): void {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      if (callee && callee.type === "import") {
        const args = node.childForFieldName("arguments");
        const firstArg = args?.child(1);
        if (firstArg && firstArg.type === "string") {
          imports.push({
            source: stripQuotes(firstArg.text),
            specifiers: [],
            isDefault: false,
            isNamespace: false,
            isType: false,
            line: node.startPosition.row + 1,
          });
        }
      }
    }
    for (const child of node.children) this.collectDynamicImports(child, imports);
  }

  private parseImportStatement(node: Node): ImportInfo {
    const source = node.childForFieldName("source");
    const sourceText = source ? stripQuotes(source.text) : "";

    // Detect type-only imports: `import type { Foo } from ...`
    let isType = false;
    const kids = node.children;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      if (child.type === "type" || child.text === "type") {
        // Check if "type" keyword appears before the import clause
        const next = kids[i + 1];
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

    for (const part of node.children) {

      if (part.type === "import_clause") {
        for (const clause of part.children) {
          if (clause.type === "identifier") {
            info.isDefault = true;
            info.specifiers.push(clause.text);
          } else if (clause.type === "named_imports") {
            for (const spec of clause.children) {
              if (spec.type === "import_specifier") {
                const originalName = spec.childForFieldName("name")?.text ?? spec.text;
                const alias = spec.childForFieldName("alias")?.text;
                // Store the alias (local name) for call classification
                info.specifiers.push(alias ?? originalName);
                // Also store original name if aliased, so symbol resolution can find it
                if (alias && alias !== originalName) {
                  info.specifiers.push(originalName);
                }
              }
            }
          } else if (clause.type === "namespace_import") {
            info.isNamespace = true;
            // Children are: `*`, `as`, identifier. Pick the trailing
            // identifier — `child(1)` returns the `as` keyword.
            let alias: Node | null = clause.childForFieldName("alias");
            if (!alias) {
              const kids = clause.children;
              for (let m = kids.length - 1; m >= 0; m--) {
                const c = kids[m]!;
                if (c.type === "identifier") { alias = c; break; }
              }
            }
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
    for (const decl of declNode.children) {
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
          for (const prop of name.children) {
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

  /** Extract a bare top-level require("module") expression statement. */
  private extractCallImports(node: Node, imports: ImportInfo[], line: number): void {
    if (node.type !== "call_expression") return;

    const callee = node.childForFieldName("function");
    if (!callee) return;

    // Dynamic import() is handled separately by collectDynamicImports (it can be
    // nested arbitrarily); here we only catch a standalone require("module").
    if (callee.text === "require") {
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
    for (const child of node.children) {

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
        for (const part of child.children) {
          if (part.type === "export_clause") {
            for (const spec of part.children) {
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
