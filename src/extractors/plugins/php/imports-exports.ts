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
 * and `require`/`include` (and their `_once` forms) of a path the file
 * spells statically — the included file's functions come into scope (the
 * manifest's `importsShareScope`):
 *
 *   require_once __DIR__ . '/lib/db.php';      // ./lib/db.php, beside the file
 *   require dirname(__DIR__) . '/config.php';  // ../config.php
 *   include 'inc/header.php';                  // as written: include_path first
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
    // Includes sit anywhere — inside functions, conditionals, loops.
    const text = node.text;
    if (!text.includes("require") && !text.includes("include")) return;
    const walk = (n: Node): void => {
      if (INCLUDE_TYPES.has(n.type)) {
        const operand = n.namedChildren[0];
        const path = operand ? includePath(operand) : null;
        if (path) {
          imports.push({ source: path, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: n.startPosition.row + 1 });
        }
        return;
      }
      for (const c of n.namedChildren) walk(c);
    };
    walk(node);
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
    // tree-sitter-php ≥0.23 puts `function`/`const` inside each clause
    // (`use App\{Models\User, function helpers\fmt}` mixes them).
    const own = clause.children.find((c) => c.type === "function" || c.type === "const")?.type as "function" | "const" | undefined;
    if (own) useType = own;
    // tree-sitter-php ≥0.23 writes the alias as a bare `name` after `as` (field `alias`).
    let afterAs = false;
    for (const c of clause.children) {
      if (c.type === "as") {
        afterAs = true;
      } else if (afterAs && c.type === "name") {
        alias = c.text;
      } else if (
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
    const declared = segments[segments.length - 1]!;
    const leaf = alias ?? declared;

    imports.push({
      source: cleanPath,
      specifiers: [leaf],
      isDefault: false,
      isNamespace: false,
      isType: useType === null,
      line,
      // `use App\Models\Player as Footballer`: the file's `Footballer` is the namespace's `Player`.
      ...(leaf !== declared ? { aliases: { [leaf]: declared } } : {}),
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

const INCLUDE_TYPES = new Set(["require_expression", "require_once_expression", "include_expression", "include_once_expression"]);

/** The file's own directory, `__DIR__` / `dirname(__FILE__)`, as a marker `includePath` anchors on. */
const SELF_DIR = "\0";

/**
 * A directory the application defines at bootstrap — CodeIgniter's
 * `APPPATH` / `BASEPATH` / `FCPATH`, WordPress's `ABSPATH`. Where it points
 * is set at runtime, so a path under it is known only as a tail: resolved by
 * the one file whose path ends with it.
 */
const APP_ROOT = "\u0001";
const APP_ROOT_CONSTANTS = new Set(["APPPATH", "BASEPATH", "FCPATH", "ROOTPATH", "SYSTEMPATH", "WRITEPATH", "ABSPATH", "BASE_PATH", "APP_PATH", "ROOT_PATH"]);

/**
 * The path an include operand spells: `./x.php` / `../x.php` when anchored on
 * the file's own directory, the literal path otherwise (PHP looks it up on the
 * include_path, then beside the including script). Null for an absolute path
 * or one holding a variable.
 */
function includePath(operand: Node): string | null {
  const raw = staticPath(operand);
  if (raw === null || raw === "") return null;
  if (raw.startsWith(SELF_DIR)) {
    let rest = raw.slice(SELF_DIR.length);
    let up = 0;
    while (rest.startsWith("/..")) { up++; rest = rest.slice(3); }
    // `dirname(__DIR__) . 'x'` with no separator is no path we can place, nor a directory a file.
    if (!rest.startsWith("/") || !/\.[A-Za-z0-9]+$/.test(rest)) return null;
    const prefix = up === 0 ? "." : Array(up).fill("..").join("/");
    return prefix + rest;
  }
  if (raw.startsWith(APP_ROOT)) {
    // `APPPATH.'/libraries/x.php'` → `libraries/x.php`, matched by path suffix.
    const rest = raw.slice(APP_ROOT.length).replace(/^\/+/, "");
    return !rest.includes(APP_ROOT) && !rest.includes(SELF_DIR) && /\.[A-Za-z0-9]+$/.test(rest) ? rest : null;
  }
  if (raw.includes(SELF_DIR) || raw.includes(APP_ROOT) || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw) || !/\.[A-Za-z0-9]+$/.test(raw)) return null;
  return raw.replace(/^\.\//, "");
}

/** A string expression's value when it is static: literals, `.` concatenation, `__DIR__`, `dirname(…)`. */
function staticPath(n: Node): string | null {
  switch (n.type) {
    case "parenthesized_expression": {
      const inner = n.namedChildren[0];
      return inner ? staticPath(inner) : null;
    }
    case "string":
    case "encapsed_string": {
      let out = "";
      for (const c of n.namedChildren) {
        if (c.type === "string_content" || c.type === "string_value") out += c.text;
        else if (c.type === "escape_sequence") out += c.text.slice(1);
        else return null; // an interpolated variable
      }
      return out;
    }
    case "binary_expression": {
      if (n.childForFieldName("operator")?.text !== "." && n.children[1]?.text !== ".") return null;
      const l = n.childForFieldName("left") ?? n.namedChildren[0];
      const r = n.childForFieldName("right") ?? n.namedChildren[1];
      if (!l || !r) return null;
      const a = staticPath(l);
      const b = a === null ? null : staticPath(r);
      return a === null || b === null ? null : a + b;
    }
    case "name":
      return n.text === "__DIR__" ? SELF_DIR : APP_ROOT_CONSTANTS.has(n.text) ? APP_ROOT : null;
    case "function_call_expression": {
      // dirname(__FILE__) is the file's directory; dirname(__DIR__, n) climbs n.
      if (n.childForFieldName("function")?.text.toLowerCase() !== "dirname") return null;
      const args = (n.childForFieldName("arguments")?.namedChildren ?? []).map((a) => a.namedChildren[0] ?? a);
      const subject = args[0];
      if (!subject || subject.type !== "name") return null;
      const levels = args[1] ? Number(args[1].text) : 1;
      if (!Number.isInteger(levels) || levels < 1) return null;
      if (subject.text === "__FILE__") return SELF_DIR + "/..".repeat(levels - 1);
      if (subject.text === "__DIR__") return SELF_DIR + "/..".repeat(levels);
      return null;
    }
    default:
      return null;
  }
}
