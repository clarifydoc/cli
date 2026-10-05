import type { Node } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";

/**
 * Statements that hold other statements. An import is a statement, so it can
 * only sit directly in one of these — never inside an expression — and the
 * import walk descends nothing else, keeping it to the statement skeleton
 * rather than the whole tree.
 */
const STATEMENT_CONTAINERS = new Set([
  "block",
  "if_statement", "elif_clause", "else_clause",
  "try_statement", "except_clause", "except_group_clause", "finally_clause",
  "with_statement", "for_statement", "while_statement",
  "match_statement", "case_clause",
  "function_definition", "class_definition", "decorated_definition",
]);

/** `if TYPE_CHECKING:` / `if typing.TYPE_CHECKING:` — the branch only a type checker runs. */
function isTypeCheckingGuard(ifStatement: Node): boolean {
  const condition = ifStatement.childForFieldName("condition")?.text;
  return condition === "TYPE_CHECKING" || condition === "typing.TYPE_CHECKING";
}

export class PythonImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["python"];

  /**
   * Imports at any statement depth, not just module level: a function-local
   * `from x import y` (the usual way to break an import cycle or defer a
   * heavy module), the `try: import ujson as json / except ImportError:`
   * fallback, and `if TYPE_CHECKING:` blocks. Missing the local one left
   * every call through it classified as internal and unlinkable. Imports
   * under a TYPE_CHECKING guard are type-only (`isType`) — they exist for
   * annotations and never bind at runtime.
   */
  protected collectImports(node: Node, imports: ImportInfo[], typeOnly = false): void {
    let typeCheckingBranch: number | undefined;
    if (node.type === "if_statement" && isTypeCheckingGuard(node)) {
      typeCheckingBranch = node.childForFieldName("consequence")?.id;
    }
    for (const child of node.children) {
      if (child.type === "import_statement") {
        this.parseImportStatement(child, imports, typeOnly);
      } else if (child.type === "import_from_statement") {
        this.parseImportFromStatement(child, imports, typeOnly);
      } else if (STATEMENT_CONTAINERS.has(child.type)) {
        this.collectImports(child, imports, typeOnly || child.id === typeCheckingBranch);
      }
    }
  }

  /** `import foo`, `import foo.bar`, `import foo as f, bar as b` */
  private parseImportStatement(node: Node, imports: ImportInfo[], isType: boolean): void {
    const names: string[] = [];
    for (const part of node.children) {
      if (part.type === "dotted_name") {
        names.push(part.text);
      } else if (part.type === "aliased_import") {
        // `import foo as f` — extract the original module name
        const original = part.childForFieldName("name");
        const alias = part.childForFieldName("alias");
        names.push(alias?.text ?? original?.text ?? part.text);
      }
    }
    imports.push({
      source: names[0] ?? node.text,
      specifiers: names,
      isDefault: false,
      isNamespace: true,
      isType,
      line: node.startPosition.row + 1,
    });
  }

  /** `from foo import bar, baz`, `from foo import *`, `from foo import bar as b` */
  private parseImportFromStatement(node: Node, imports: ImportInfo[], isType: boolean): void {
    const moduleNode = node.childForFieldName("module_name");
    const module = moduleNode?.text ?? "";
    // Track module node position to avoid matching it as a specifier
    const moduleRow = moduleNode?.startPosition.row ?? -1;
    const moduleCol = moduleNode?.startPosition.column ?? -1;
    const specifiers: string[] = [];
    let isNamespace = false;
    let pastImportKeyword = false;

    for (const part of node.children) {

      // Track when we pass the "import" keyword — specifiers come after it
      if (part.text === "import" && part.type !== "dotted_name") {
        pastImportKeyword = true;
        continue;
      }
      if (part.text === "from") continue;

      // Skip the module name (appears before "import" keyword)
      if (
        !pastImportKeyword &&
        part.startPosition.row === moduleRow &&
        part.startPosition.column === moduleCol
      ) continue;

      // Wildcard: from foo import *
      if (part.type === "wildcard_import") {
        isNamespace = true;
        continue;
      }

      // Only collect specifiers that appear after "import"
      if (!pastImportKeyword) continue;

      // Named specifiers inside import_list: from foo import bar, baz
      if (part.type === "import_list" || part.type === "import_from_statement_body") {
        for (const spec of part.children) {
          if (spec.type === "dotted_name" || spec.type === "identifier") {
            specifiers.push(spec.text);
          } else if (spec.type === "aliased_import") {
            const alias = spec.childForFieldName("alias");
            specifiers.push(alias?.text ?? spec.childForFieldName("name")?.text ?? spec.text);
          }
        }
        continue;
      }

      // Bare specifiers after "import" keyword (no import_list wrapper)
      if (part.type === "dotted_name" || part.type === "identifier") {
        specifiers.push(part.text);
      } else if (part.type === "aliased_import") {
        const alias = part.childForFieldName("alias");
        specifiers.push(alias?.text ?? part.childForFieldName("name")?.text ?? part.text);
      }
    }

    imports.push({
      source: module,
      specifiers,
      isDefault: false,
      isNamespace,
      isType,
      line: node.startPosition.row + 1,
    });
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    // In Python, top-level functions and classes are "exports"
    for (const child of node.children) {

      if (child.type === "function_definition") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (!name.startsWith("_")) {
          exports.push({ name, kind: "function", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "class_definition") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        if (!name.startsWith("_")) {
          exports.push({ name, kind: "class", line: child.startPosition.row + 1 });
        }
      } else if (child.type === "decorated_definition") {
        // Decorated functions/classes are also exports
        for (const inner of child.children) {
          if (inner.type === "function_definition") {
            const name = inner.childForFieldName("name")?.text ?? "anonymous";
            if (!name.startsWith("_")) {
              exports.push({ name, kind: "function", line: inner.startPosition.row + 1 });
            }
          } else if (inner.type === "class_definition") {
            const name = inner.childForFieldName("name")?.text ?? "anonymous";
            if (!name.startsWith("_")) {
              exports.push({ name, kind: "class", line: inner.startPosition.row + 1 });
            }
          }
        }
      }
    }
  }
}
