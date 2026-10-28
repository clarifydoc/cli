import type { Node } from "web-tree-sitter";
import type { CallInfo, ParamInfo } from "../../../types/analysis.js";

/**
 * What each argument of a C# call is, as its own expression says
 * (`CallInfo.argKinds`), and how a declared type folds to the key the
 * overload chooser compares it with (`calls.overloadTypeKey`): keyword types
 * and their `System` structs alike, delegates by their arity and result.
 */

const VALUE_KEYS: Readonly<Record<string, string>> = {
  int: "int", Int32: "int",
  long: "long", Int64: "long",
  short: "short", Int16: "short",
  byte: "byte", Byte: "byte",
  float: "float", Single: "float",
  double: "double", Double: "double",
  char: "char", Char: "char",
  bool: "boolean", Boolean: "boolean",
  string: "string", String: "string",
  object: "object", Object: "object",
  decimal: "decimal", Decimal: "decimal",
};

/** The top-level type arguments of `Name<A, B<C>>`, as written. */
function typeArgs(type: string): string[] {
  const open = type.indexOf("<");
  if (open < 0) return [];
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < type.length; i++) {
    const c = type[i];
    if (c === "<" || c === "(") depth++;
    else if (c === ">" || c === ")") {
      if (depth === 0) {
        out.push(type.slice(start, i).trim());
        break;
      }
      depth--;
    } else if (c === "," && depth === 0) {
      out.push(type.slice(start, i).trim());
      start = i + 1;
    }
  }
  return out.filter(Boolean);
}

/** `int?` → `int`, `System.String` → `string`, `Action<Club>` → `->1:void`, `Func<Club, bool>` → `->1:value`, `Expression<Func<T>>` → `->0:value`. */
export function csharpOverloadTypeKey(type: string): string {
  if (/^->/.test(type)) return type;
  const t = type.replace(/\s+/g, "").replace(/\?$/, "");
  const base = t.replace(/<.*$/s, "").split(".").pop()!;
  const args = typeArgs(t);
  if (base === "Expression" && args.length === 1) return csharpOverloadTypeKey(args[0]!);
  if (base === "Action") return `->${args.length}:void`;
  if (base === "Func" && args.length > 0) return `->${args.length - 1}:value`;
  if (base === "Predicate" && args.length === 1) return "->1:value";
  const array = /(\[,*\])+$/.exec(base)?.[0] ?? "";
  const name = base.replace(/(\[,*\])+$/, "");
  return (VALUE_KEYS[name] ?? name) + array;
}

const STATEMENT_EXPRESSIONS = new Set([
  "invocation_expression", "object_creation_expression", "assignment_expression", "await_expression",
  "postfix_unary_expression", "prefix_unary_expression",
]);

/** Whether a lambda's block returns a value, not looking into nested lambdas or local functions. */
function blockReturnsValue(block: Node): boolean {
  for (const c of block.namedChildren) {
    if (c.type === "return_statement") {
      if (c.namedChildren.some((x) => x.type !== "comment")) return true;
      continue;
    }
    if (c.type === "lambda_expression" || c.type === "anonymous_method_expression" || c.type === "local_function_statement") continue;
    if (blockReturnsValue(c)) return true;
  }
  return false;
}

/** One C# argument expression's kind (see `CallInfo.argKinds`). */
export function csharpArgKind(node: Node): string {
  switch (node.type) {
    case "string_literal":
    case "verbatim_string_literal":
    case "raw_string_literal":
    case "interpolated_string_expression":
      return "string";
    case "integer_literal":
      return /[uU]/.test(node.text) ? "?" : /[lL]$/.test(node.text) ? "long" : "int";
    case "real_literal":
      return /[fF]$/.test(node.text) ? "float" : /[mM]$/.test(node.text) ? "decimal" : "double";
    case "boolean_literal":
      return "boolean";
    case "character_literal":
      return "char";
    case "null_literal":
      return "null";
    case "object_creation_expression":
    case "cast_expression": {
      const type = node.childForFieldName("type");
      return type ? csharpOverloadTypeKey(type.text) : "?";
    }
    case "typeof_expression":
      return "Type";
    case "identifier":
      return `@${node.text}`;
    case "member_access_expression":
      return node.childForFieldName("expression")?.type === "this_expression" || node.childForFieldName("expression")?.type === "this"
        ? `@${node.childForFieldName("name")?.text ?? ""}` : "?";
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner ? csharpArgKind(inner) : "?";
    }
    case "invocation_expression":
      return node.childForFieldName("function")?.text === "nameof" ? "string" : "?";
    case "lambda_expression": {
      const params = node.childForFieldName("parameters");
      const arity = !params ? 0 : params.type === "identifier" || params.type === "implicit_parameter" ? 1 : params.namedChildren.filter((c) => c.type === "parameter").length;
      const body = node.childForFieldName("body");
      if (!body) return `->${arity}`;
      if (body.type === "block") return `->${arity}:${blockReturnsValue(body) ? "value" : "void"}`;
      return STATEMENT_EXPRESSIONS.has(body.type) ? `->${arity}` : `->${arity}:value`;
    }
    default:
      return "?";
  }
}

/**
 * Each argument's kind, or null when the call passes none, none is known, or
 * an argument is named (named arguments may come in any order). A `ref` /
 * `out` / `in` argument is unknown.
 */
export function csharpArgKinds(node: Node): string[] | null {
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const kinds: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "argument") continue;
    if (arg.childForFieldName("name") || arg.children.some((c) => c.type === ":" || c.type === "name_colon")) return null;
    if (arg.children.some((c) => c.type === "ref" || c.type === "out" || c.type === "in")) {
      kinds.push("?");
      continue;
    }
    const expr = arg.namedChildren[arg.namedChildCount - 1];
    kinds.push(expr ? csharpArgKind(expr) : "?");
  }
  return kinds.some((k) => k !== "?") ? kinds : null;
}

/**
 * Type the variable arguments (`@name`) of a member's calls by what the
 * member declares — its parameters and locals with a stated type or a
 * self-typed initializer, primitives and strings included. A lambda's untyped
 * parameter is unknown, so a field of that name never stands in for it. What
 * stays `@name` is left to the linker (fields).
 */
export function typeCsharpVariableArgs(calls: readonly CallInfo[], params: readonly ParamInfo[], body: Node | null): void {
  if (!body || !calls.some((c) => c.argKinds?.some((k) => k.startsWith("@")))) return;
  const known = new Map<string, string>();
  for (const p of params) if (!p.isReceiver) known.set(p.name, p.type ? csharpOverloadTypeKey(p.type) : "?");
  const declare = (name: string | undefined, type: string | undefined | null, init?: Node | null): void => {
    if (!name || known.has(name)) return;
    if (type && type !== "var") known.set(name, csharpOverloadTypeKey(type));
    else {
      const k = init ? csharpArgKind(init) : "?";
      known.set(name, k.startsWith("@") ? "?" : k);
    }
  };
  const visit = (n: Node): void => {
    switch (n.type) {
      case "variable_declaration": {
        const type = n.childForFieldName("type")?.text;
        for (const d of n.namedChildren) {
          if (d.type !== "variable_declarator") continue;
          const name = d.childForFieldName("name")?.text ?? d.namedChildren.find((c) => c.type === "identifier")?.text;
          const init = d.namedChildren[d.namedChildCount - 1];
          declare(name, type, init && init.text !== name ? init : null);
        }
        break;
      }
      case "foreach_statement":
        declare(n.childForFieldName("left")?.text, n.childForFieldName("type")?.text);
        break;
      case "catch_declaration":
        declare(n.childForFieldName("name")?.text, n.childForFieldName("type")?.text);
        break;
      case "lambda_expression": {
        const ps = n.childForFieldName("parameters");
        if (ps?.type === "identifier" || ps?.type === "implicit_parameter") declare(ps.text, null);
        else for (const p of ps?.namedChildren ?? []) {
          if (p.type === "parameter") declare(p.childForFieldName("name")?.text, p.childForFieldName("type")?.text);
        }
        break;
      }
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  for (const c of calls) {
    if (!c.argKinds?.some((k) => k.startsWith("@"))) continue;
    c.argKinds = c.argKinds.map((k) => (k.startsWith("@") ? known.get(k.slice(1)) ?? k : k));
  }
}
