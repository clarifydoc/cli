import type { Node, Tree } from "web-tree-sitter";
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

  /**
   * `import foo`, `import foo.bar`, `import foo as f, bar as b` — one import
   * per module, its source the module's dotted path and its specifier the name
   * it binds. The alias used to become the source (`import app.models as m`
   * recorded source "m"), and every module after the first in one statement
   * was dropped, so neither could ever resolve to a file.
   */
  private parseImportStatement(node: Node, imports: ImportInfo[], isType: boolean): void {
    for (const part of node.children) {
      let source: string | undefined;
      let bound: string | undefined;
      if (part.type === "dotted_name") {
        source = bound = part.text;
      } else if (part.type === "aliased_import") {
        source = part.childForFieldName("name")?.text;
        bound = part.childForFieldName("alias")?.text ?? source;
      }
      if (!source || !bound) continue;
      imports.push({
        source,
        specifiers: [bound],
        isDefault: false,
        isNamespace: true,
        isType,
        line: node.startPosition.row + 1,
      });
    }
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
            pushAliased(spec, specifiers);
          }
        }
        continue;
      }

      // Bare specifiers after "import" keyword (no import_list wrapper)
      if (part.type === "dotted_name" || part.type === "identifier") {
        specifiers.push(part.text);
      } else if (part.type === "aliased_import") {
        pushAliased(part, specifiers);
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

  /**
   * When the file being read is a package's `__init__.py`, the directories on
   * its path — the package names an absolute import of its own tree starts
   * with (set per `extractExports` call).
   */
  private packageDirs: ReadonlySet<string> | null = null;

  override extractExports(tree: Tree, sourceText: string, filePath?: string): ExportInfo[] {
    this.packageDirs = filePath && /(?:^|\/)__init__\.pyi?$/.test(filePath)
      ? new Set(filePath.split("/").slice(0, -1))
      : null;
    try {
      return super.extractExports(tree, sourceText, filePath);
    } finally {
      this.packageDirs = null;
    }
  }

  protected collectExports(node: Node, exports: ExportInfo[]): void {
    // In Python, top-level functions and classes are "exports"
    for (const child of node.children) {
      if (child.type === "import_from_statement") {
        reExportsOf(child, exports, this.packageDirs);
        continue;
      }

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

/**
 * What a module-level `from … import` forwards: a package's `__init__.py`
 * publishing its modules (`from .dependencies import *`, `from .user import
 * User as Account`) — the names a caller importing the package finds there.
 * Relative imports name the package's own modules; `import *` forwards
 * whatever it imports. A package's `__init__.py` also publishes what it names
 * absolutely from its own tree (`from app.services.user import UserService`
 * in `app/services/__init__.py` — the module's root is a directory on the
 * file's path; `from typing import Any` is a dependency, not its API).
 * Recorded as `re-export` exports with their `source`.
 */
function reExportsOf(stmt: Node, exports: ExportInfo[], packageDirs: ReadonlySet<string> | null): void {
  const module = stmt.childForFieldName("module_name")?.text ?? "";
  if (!module) return;
  const line = stmt.startPosition.row + 1;
  const wildcard = stmt.children.some((c) => c.type === "wildcard_import");
  if (wildcard) {
    exports.push({ name: "*", kind: "re-export", line, source: module });
    return;
  }
  if (!module.startsWith(".") && !packageDirs?.has(module.split(".")[0]!)) return;
  const moduleNode = stmt.childForFieldName("module_name");
  const inModule = (n: Node): boolean => !!moduleNode && n.startIndex >= moduleNode.startIndex && n.endIndex <= moduleNode.endIndex;
  for (const part of stmt.descendantsOfType(["dotted_name", "aliased_import"])) {
    if (inModule(part) || part.parent?.type === "aliased_import") continue;
    if (part.type === "aliased_import") {
      const name = part.childForFieldName("name")?.text;
      const alias = part.childForFieldName("alias")?.text;
      if (!name) continue;
      const entry: ExportInfo = { name: alias ?? name, kind: "re-export", line, source: module };
      if (alias && alias !== name) entry.sourceName = name;
      exports.push(entry);
    } else if (!part.text.includes(".")) {
      exports.push({ name: part.text, kind: "re-export", line, source: module });
    }
  }
}

/**
 * `bar as b`: the local name first (what call classification looks up), then
 * the imported name when it differs — `from pkg import sub as s` loads
 * `pkg/sub.py`, which only the original name can find.
 */
function pushAliased(node: Node, specifiers: string[]): void {
  const name = node.childForFieldName("name")?.text;
  const alias = node.childForFieldName("alias")?.text;
  specifiers.push(alias ?? name ?? node.text);
  if (alias && name && alias !== name) specifiers.push(name);
}
