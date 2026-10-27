import type { Node, Tree } from "web-tree-sitter";
import { ImportExportExtractor } from "../../imports-exports/base.js";
import type { ImportInfo, ExportInfo, Language } from "../../imports-exports/base.js";
import { stripQuotes } from "../../shared/node-helpers.js";
import { spawnImports } from "../shared/process-spawns.js";
import { escapeRegex } from "../shared/path-utils.js";

/** Initializer node types that make a `const` export a function. */
const FUNCTION_VALUE_TYPES: ReadonlySet<string> = new Set([
  "arrow_function", "function_expression", "function", "generator_function",
]);

/**
 * The names an exported declaration binds. A `const`/`let`/`var` statement
 * has no `name` field — its declarators do, and one statement can bind
 * several (`export const a = 1, b = 2`) or destructure (`export const { a, b }
 * = obj`). Reading only the statement's `name` recorded every such export as
 * "anonymous".
 */
function declaredNames(declaration: Node): string[] {
  if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
    const names: string[] = [];
    for (const d of declaration.children) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      if (name) collectPatternNames(name, names);
    }
    return names;
  }
  // `export declare const x: T` / `export declare function f(): void`.
  if (declaration.type === "ambient_declaration") {
    return declaration.namedChildren.flatMap((c) => declaredNames(c));
  }
  const name = declaration.childForFieldName("name")?.text;
  return name ? [name] : [];
}

function collectPatternNames(node: Node, out: string[]): void {
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.push(node.text);
      return;
    case "pair_pattern": {
      const value = node.childForFieldName("value");
      if (value) collectPatternNames(value, out);
      return;
    }
    case "assignment_pattern": {
      const left = node.childForFieldName("left");
      if (left) collectPatternNames(left, out);
      return;
    }
    case "object_assignment_pattern":
    case "rest_pattern":
    case "object_pattern":
    case "array_pattern":
      for (const c of node.namedChildren) collectPatternNames(c, out);
      return;
  }
}

/** One static import: what it binds, and where the statement is written. */
export interface ImportBindings {
  info: ImportInfo;
  names: string[];
  /** 0-based row of the statement's first line. */
  row: number;
  text: string;
}

/** The names an `import` statement binds in the file: default, named (by alias), namespace. */
function localBindings(stmt: Node): string[] {
  const out: string[] = [];
  for (const part of stmt.children) {
    if (part.type !== "import_clause") continue;
    for (const clause of part.children) {
      if (clause.type === "identifier") out.push(clause.text);
      else if (clause.type === "named_imports") {
        for (const spec of clause.children) {
          if (spec.type !== "import_specifier") continue;
          const local = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
          if (local) out.push(local.text);
        }
      } else if (clause.type === "namespace_import") {
        const ids = clause.children.filter((c) => c.type === "identifier");
        const alias = ids[ids.length - 1];
        if (alias) out.push(alias.text);
      }
    }
  }
  return out;
}

/**
 * Mark the bindings nothing else in the file mentions. Read off the text with
 * the import statements blanked, so a name counts as used wherever it is
 * written — a comment or a string included: an unused import is an
 * accusation, and this errs toward withholding it. `x.Name` is a property,
 * not the binding; `...Name` is the binding. A file with JSX uses `React`
 * (the classic runtime), and a `@jsx` pragma uses the factory it names.
 */
export function markUnusedBindings(sourceText: string, imports: ImportBindings[]): void {
  // Each statement found by its own text from the start of its row: rows are lines in any encoding.
  const lineStarts = [0];
  for (let i = 0; i < sourceText.length; i++) if (sourceText.charCodeAt(i) === 10) lineStarts.push(i + 1);
  let text = sourceText;
  for (const b of imports) {
    const at = text.indexOf(b.text, lineStarts[b.row] ?? 0);
    if (at >= 0) text = text.slice(0, at) + b.text.replace(/[^\n]/g, " ") + text.slice(at + b.text.length);
  }
  const hasJsx = /<\/|\/>/.test(text);
  const pragma = /@jsx(?:Frag)?\s+([\w$.]+)/.exec(sourceText)?.[1]?.split(".")[0];
  for (const b of imports) {
    const unused = b.names.filter((name) => {
      if ((name === "React" && hasJsx) || name === pragma) return false;
      const escaped = escapeRegex(name);
      return !new RegExp(`(?<![\\w$])(?<!(?<!\\.)\\.)${escaped}(?![\\w$])`).test(text);
    });
    if (unused.length) b.info.unused = unused;
  }
}

export class JavaScriptImportExportExtractor extends ImportExportExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  // Set per extractImports() call (synchronous), consumed by collectImports.
  private mayHaveDynamicImport = true;
  /** A plugin or router loaded inline where it is registered: `register(require("./clubs"))`, `use("/api", require("./api"))`. */
  private mayRegisterRequire = false;

  /** Each static import's local bindings and the statement's text range, for the unused check. */
  private bindings: ImportBindings[] = [];

  extractImports(tree: Tree, sourceText: string, opts: { embedded?: boolean } = {}): ImportInfo[] {
    this.mayHaveDynamicImport = sourceText.includes("import(");
    this.mayRegisterRequire = sourceText.includes("require(") && /\.(?:register|use)\s*\(/.test(sourceText);
    this.bindings = [];
    const imports = super.extractImports(tree, sourceText, opts);
    // Scripts it starts as processes (`fork("./worker.js")`): run, not loaded.
    imports.push(...spawnImports(sourceText, "js"));
    // A template beside the script (Vue, Svelte) uses imports the script never mentions.
    if (!opts.embedded && this.bindings.length) markUnusedBindings(sourceText, this.bindings);
    this.bindings = [];
    return imports;
  }

  protected collectImports(node: Node, imports: ImportInfo[]): void {
    for (const child of node.children) {

      // Static: import ... from "module"
      if (child.type === "import_statement") {
        const info = this.parseImportStatement(child);
        imports.push(info);
        const names = localBindings(child);
        if (names.length) this.bindings.push({ info, names, row: child.startPosition.row, text: child.text });
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
    // import edges to the lazily-loaded module. The substring gate skips the
    // walk for the common case of a file with no `import(` at all.
    if (this.mayHaveDynamicImport) this.collectDynamicImports(node, imports);
    if (this.mayRegisterRequire) this.collectRegisteredRequires(node, imports);
  }

  /**
   * `fastify.register(require("./clubs"), { prefix })`, `server.register({ plugin: require("./players") })`,
   * `app.use("/api", require("./routes/api"))`: the module is loaded where it is registered, with no
   * binding — an import with no specifiers, which the router mount pass resolves by its source.
   */
  private collectRegisteredRequires(node: Node, imports: ImportInfo[]): void {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const method = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
      if (method === "register" || method === "use") {
        const visit = (arg: Node, depth: number): void => {
          const source = requiredSource(arg);
          if (source !== null) {
            imports.push({ source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: arg.startPosition.row + 1 });
          } else if (depth < 2 && (arg.type === "object" || arg.type === "array")) {
            for (const child of arg.namedChildren) visit(child.type === "pair" ? child.childForFieldName("value") ?? child : child, depth + 1);
          }
        };
        for (const arg of node.childForFieldName("arguments")?.namedChildren ?? []) visit(arg, 0);
      }
    }
    for (const child of node.namedChildren) this.collectRegisteredRequires(child, imports);
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
            dynamic: true,
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
                // The local name is what the file calls; the module defines the original.
                info.specifiers.push(alias ?? originalName);
                if (alias && alias !== originalName) (info.aliases ??= {})[alias] = originalName;
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
      if (child.type !== "export_statement") continue;
      const line = child.startPosition.row + 1;
      const kids = child.children;

      // `export default …`, and TS's `export = …`. Read off the keyword token —
      // the statement's text contains "default" whenever a name does
      // (`export const defaultOptions`), which used to make those "default".
      if (kids.some((k) => k.type === "default" || k.type === "=")) {
        // The module's own name for it: `export default Club;`, `export default class Club …`.
        const value = child.childForFieldName("value") ?? child.childForFieldName("declaration");
        const local = value?.type === "identifier" ? value.text : value && /^(?:class|function_declaration|abstract_class_declaration|class_declaration)$/.test(value.type) ? value.childForFieldName("name")?.text : undefined;
        // `export default new Agents()`: the module's default is an instance of its class.
        const instanceOf = value?.type === "new_expression" ? value.childForFieldName("constructor") : null;
        exports.push({ name: "default", kind: "default", line, ...(local ? { sourceName: local } : {}), ...(instanceOf?.type === "identifier" ? { instanceOf: instanceOf.text } : {}) });
        continue;
      }

      const declaration = child.childForFieldName("declaration");
      if (declaration) {
        const kind = this.getDeclarationKind(declaration);
        for (const name of declaredNames(declaration)) exports.push({ name, kind, line });
      }

      // Re-exports carry the module they forward from, so a reader can follow
      // a barrel (`export { x } from "./x"`, `export * from "./y"`) to the file
      // that declares the name. A local `export { x }` has no source.
      const sourceNode = child.childForFieldName("source");
      const source = sourceNode ? stripQuotes(sourceNode.text) : undefined;
      for (const part of kids) {
        if (part.type === "export_clause") {
          const specs = part.children;
          for (let i = 0; i < specs.length; i++) {
            const spec = specs[i]!;
            if (spec.type !== "export_specifier") continue;
            const original = spec.childForFieldName("name")?.text ?? spec.text;
            // A reserved word as the exported name (`export { del as delete }`) parses
            // as an ERROR node after the specifier; its last token is the name.
            const next = specs[i + 1];
            const reserved = next?.type === "ERROR" && next.childCount === 2 && next.child(0)?.type === "as" ? next.child(1)?.text : undefined;
            const alias = spec.childForFieldName("alias")?.text ?? reserved;
            const info: ExportInfo = { name: alias ?? original, kind: "re-export", line };
            if (source !== undefined) info.source = source;
            if (alias && alias !== original) info.sourceName = original;
            exports.push(info);
          }
        } else if (part.type === "namespace_export" && source !== undefined) {
          // export * as ns from "./y" — `ns` stands for the whole module.
          const id = [...part.children].reverse().find((c) => c.type === "identifier" || c.type === "string");
          if (id) exports.push({ name: stripQuotes(id.text), kind: "re-export", line, source, sourceName: "*" });
        } else if (part.type === "*" && source !== undefined) {
          exports.push({ name: "*", kind: "re-export", line, source });
        }
      }
    }
  }

  private getDeclarationKind(declaration: Node): ExportInfo["kind"] {
    // `export const f = () => …` declares a function under a variable.
    if (declaration.type === "lexical_declaration" || declaration.type === "variable_declaration") {
      const declarators = declaration.children.filter((c) => c.type === "variable_declarator");
      const value = declarators.length === 1 ? declarators[0]!.childForFieldName("value") : null;
      return value && FUNCTION_VALUE_TYPES.has(value.type) ? "function" : "variable";
    }
    if (declaration.type === "ambient_declaration") {
      const inner = declaration.namedChildren.find((c) => c.type !== "comment");
      return inner ? this.getDeclarationKind(inner) : "variable";
    }
    switch (declaration.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature":
      case "arrow_function":
        return "function";
      case "class_declaration":
      case "abstract_class_declaration":
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

/** `require("./x")` → `./x`; anything else → null. */
export function requiredSource(node: Node): string | null {
  if (node.type !== "call_expression" || node.childForFieldName("function")?.text !== "require") return null;
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  return args.length === 1 && args[0]!.type === "string" ? stripQuotes(args[0]!.text) : null;
}
