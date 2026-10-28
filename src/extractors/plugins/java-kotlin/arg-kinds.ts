import type { Node } from "web-tree-sitter";

/**
 * What each argument of a Java or Kotlin call is, as its own expression says
 * (`CallInfo.argKinds`), and how a declared type folds to the key the
 * overload chooser compares it with (`calls.overloadTypeKey`). Cheap: one look
 * at each argument's node type, never a walk of the method.
 */

/** Primitive and boxed spellings of both languages → the chooser's keys. */
const VALUE_KEYS: Readonly<Record<string, string>> = {
  int: "int", Integer: "int", Int: "int",
  long: "long", Long: "long",
  short: "short", Short: "short",
  byte: "byte", Byte: "byte",
  float: "float", Float: "float",
  double: "double", Double: "double",
  char: "char", Character: "char", Char: "char",
  boolean: "boolean", Boolean: "boolean",
  String: "string",
  Object: "object", Any: "object",
};

/**
 * The JDK's functional interfaces by result: `Runnable` and the consumers
 * return nothing, suppliers, functions, predicates and operators a value —
 * what tells `asSystem(Runnable)` from `asSystem(Supplier<T>)` for a lambda.
 */
function jdkFunctionalKey(name: string): string | null {
  if (name === "Runnable") return "->0:void";
  if (name === "Callable" || /^(?:Boolean|Int|Long|Double)?Supplier$/.test(name)) return "->0:value";
  if (/^(?:Int|Long|Double)?Consumer$/.test(name)) return "->1:void";
  if (/^(?:Bi|Obj(?:Int|Long|Double))Consumer$/.test(name)) return "->2:void";
  if (/^(?:Int|Long|Double)?(?:Predicate|UnaryOperator)$/.test(name)) return "->1:value";
  if (/^(?:Bi(?:Predicate)?|(?:Int|Long|Double)?BinaryOperator)$/.test(name)) return "->2:value";
  if (/^(?:(?:Int|Long|Double)|To(?:Int|Long|Double)|(?:Int|Long|Double)To(?:Int|Long|Double))?Function$/.test(name)) return "->1:value";
  if (/^(?:Bi|To(?:Int|Long|Double)Bi)Function$/.test(name)) return "->2:value";
  return null;
}

/** The simple name of a type as written: annotations, a package, type arguments and nullability dropped; an array keeps its `[]`. */
function simpleType(type: string): string {
  const t = type.replace(/@[\w.]+(?:\([^)]*\))?\s*/g, "").replace(/\s+/g, "").replace(/\?$/, "");
  const array = /(\[\])+$/.exec(t.replace(/<.*>/s, ""))?.[0] ?? "";
  const base = t.replace(/<.*$/s, "").replace(/(\[\])+$/, "").replace(/\.\.\.$/, "");
  return base.split(".").pop()! + array;
}

/** `Integer` → `int`, `java.lang.String` → `string`, `Supplier<T>` → `->0:value`, `Club<X>` → `Club`. */
export function javaOverloadTypeKey(type: string): string {
  if (/^->/.test(type)) return type;
  const name = simpleType(type);
  return VALUE_KEYS[name] ?? jdkFunctionalKey(name) ?? name;
}

/** Java's keys, plus Kotlin's function types: `() -> Unit` → `->0:void`, `suspend (Club) -> Int` → `->1:value`. */
export function kotlinOverloadTypeKey(type: string): string {
  if (/^->/.test(type)) return type;
  const fnType = /^\(?\s*(?:suspend\s+)?(?:[\w.<>?]+\.)?\(([^()]*)\)\s*->\s*(.+?)\)?\??$/s.exec(type.trim());
  if (fnType) {
    const params = fnType[1]!.trim() ? fnType[1]!.split(",").length : 0;
    return `->${params}:${fnType[2]!.trim() === "Unit" ? "void" : "value"}`;
  }
  if (simpleType(type) === "Unit") return "?";
  return javaOverloadTypeKey(type);
}

/** A Java numeric literal's key: `1L` → long, `2f` → float, `2.0` → double. */
function javaNumberKey(node: Node): string {
  const text = node.text;
  if (node.type === "decimal_floating_point_literal" || node.type === "hex_floating_point_literal") return /[fF]$/.test(text) ? "float" : "double";
  return /[lL]$/.test(text) ? "long" : "int";
}

/** Whether a statement-shaped expression body could be a `void` lambda's (`() -> save(x)`) as well as a value one. */
const JAVA_STATEMENT_EXPRESSIONS = new Set([
  "method_invocation", "object_creation_expression", "assignment_expression", "update_expression",
]);

/** Whether a lambda's block returns a value (`return x;`), not looking into nested lambdas or classes. */
function blockReturnsValue(block: Node, lambdaType: string, classBody: string): boolean {
  for (const c of block.namedChildren) {
    if (c.type === "return_statement" || c.type === "jump_expression") {
      if (c.namedChildren.some((x) => x.type !== "line_comment" && x.type !== "block_comment")) return true;
      continue;
    }
    if (c.type === lambdaType || c.type === classBody) continue;
    if (blockReturnsValue(c, lambdaType, classBody)) return true;
  }
  return false;
}

/** One Java argument's kind (see `CallInfo.argKinds`). */
export function javaArgKind(node: Node): string {
  switch (node.type) {
    case "string_literal":
    case "text_block":
      return "string";
    case "decimal_integer_literal":
    case "hex_integer_literal":
    case "octal_integer_literal":
    case "binary_integer_literal":
    case "decimal_floating_point_literal":
    case "hex_floating_point_literal":
      return javaNumberKey(node);
    case "true":
    case "false":
      return "boolean";
    case "character_literal":
      return "char";
    case "null_literal":
      return "null";
    case "object_creation_expression": {
      // An anonymous class (`new Runnable() { … }`) is the interface it implements.
      const type = node.childForFieldName("type");
      return type ? javaOverloadTypeKey(type.text) : "?";
    }
    case "array_creation_expression": {
      const type = node.childForFieldName("type");
      return type ? `${simpleType(type.text)}[]` : "?";
    }
    case "class_literal":
      return "Class";
    case "cast_expression": {
      const type = node.childForFieldName("type");
      return type ? javaOverloadTypeKey(type.text) : "?";
    }
    case "identifier":
      return `@${node.text}`;
    case "field_access":
      return node.childForFieldName("object")?.type === "this" ? `@${node.childForFieldName("field")?.text ?? ""}` : "?";
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner ? javaArgKind(inner) : "?";
    }
    case "unary_expression": {
      const operand = node.childForFieldName("operand");
      const op = node.childForFieldName("operator")?.text ?? node.child(0)?.text;
      if (op === "!") return "boolean";
      const k = operand ? javaArgKind(operand) : "?";
      return k === "int" || k === "long" || k === "float" || k === "double" ? k : "?";
    }
    case "binary_expression": {
      // `"a" + 1` is a string; a comparison or a logical operator a boolean.
      const op = node.childForFieldName("operator")?.text;
      if (op && /^(?:==|!=|<|>|<=|>=|&&|\|\|)$/.test(op)) return "boolean";
      if (op === "+") {
        const l = node.childForFieldName("left");
        const r = node.childForFieldName("right");
        if ((l && javaArgKind(l) === "string") || (r && javaArgKind(r) === "string")) return "string";
      }
      return "?";
    }
    case "instanceof_expression":
      return "boolean";
    case "lambda_expression": {
      const params = node.childForFieldName("parameters");
      const arity = !params ? 0 : params.type === "identifier" ? 1 : params.namedChildren.filter((c) => c.type !== "line_comment" && c.type !== "block_comment").length;
      const body = node.childForFieldName("body");
      if (!body) return `->${arity}`;
      if (body.type === "block") return `->${arity}:${blockReturnsValue(body, "lambda_expression", "class_body") ? "value" : "void"}`;
      return JAVA_STATEMENT_EXPRESSIONS.has(body.type) ? `->${arity}` : `->${arity}:value`;
    }
    default:
      return "?";
  }
}

/** Java: each argument's kind, or null when the call passes none or none is known. */
export function javaArgKinds(node: Node): string[] | null {
  const args = node.childForFieldName("arguments");
  if (!args || args.namedChildCount === 0) return null;
  const kinds = args.namedChildren
    .filter((c) => c.type !== "line_comment" && c.type !== "block_comment")
    .map(javaArgKind);
  return kinds.some((k) => k !== "?") ? kinds : null;
}

/** One Kotlin argument expression's kind. */
export function kotlinArgKind(node: Node): string {
  switch (node.type) {
    case "string_literal":
    case "line_string_literal":
    case "multi_line_string_literal":
      return "string";
    case "integer_literal":
    case "hex_literal":
    case "bin_literal":
      return "int";
    case "long_literal":
      return "long";
    case "real_literal":
      return /[fF]$/.test(node.text) ? "float" : "double";
    case "boolean_literal":
      return "boolean";
    case "character_literal":
      return "char";
    case "null":
      return "null";
    case "simple_identifier":
      return `@${node.text}`;
    case "parenthesized_expression": {
      const inner = node.namedChildren[0];
      return inner ? kotlinArgKind(inner) : "?";
    }
    case "as_expression": {
      const type = node.namedChildren[node.namedChildCount - 1];
      return type ? kotlinOverloadTypeKey(type.text) : "?";
    }
    case "navigation_expression": {
      // `this.y` is the field; `Club::class` reads as a callable reference.
      const [head, suffix] = node.namedChildren;
      if (head?.type === "this_expression" && suffix) return `@${suffix.text.replace(/^\./, "")}`;
      return "?";
    }
    case "call_expression": {
      // `ByteArray(2)`, `Club(name)`: a capitalized plain callee is a construction.
      const callee = node.child(0);
      return callee?.type === "simple_identifier" && /^[A-Z]/.test(callee.text) ? kotlinOverloadTypeKey(callee.text) : "?";
    }
    case "annotated_lambda":
    case "lambda_literal": {
      const lambda = node.type === "lambda_literal" ? node : node.namedChildren.find((c) => c.type === "lambda_literal");
      const params = lambda?.namedChildren.find((c) => c.type === "lambda_parameters");
      // Without parameters a lambda takes none or one (`it`); its last expression is its value, so its result is open.
      return params ? `->${params.namedChildren.length}` : "->";
    }
    default:
      return "?";
  }
}

/**
 * Kotlin: each argument's kind, a trailing lambda last, or null when the call
 * passes none, none is known, or an argument is named (named arguments may
 * come in any order) or spread.
 */
export function kotlinArgKinds(node: Node): string[] | null {
  // `save(o) { … }` parses as a call of the call `save(o)`: the inner node reads both suffixes.
  if (node.child(0)?.type === "call_expression") return null;
  const suffixes = node.children.filter((c) => c.type === "call_suffix");
  const outer = node.parent?.type === "call_expression" && node.parent.child(0)?.id === node.id ? node.parent : null;
  for (const c of outer?.children ?? []) if (c.type === "call_suffix") suffixes.push(c);
  const kinds: string[] = [];
  for (const part of suffixes.flatMap((s) => s.children)) {
    if (part.type === "annotated_lambda") kinds.push(kotlinArgKind(part));
    else if (part.type === "value_arguments") {
      for (const arg of part.namedChildren) {
        if (arg.type !== "value_argument") continue;
        if (arg.children.some((c) => c.type === "=") || arg.text.trimStart().startsWith("*")) return null;
        const expr = arg.namedChildren[arg.namedChildCount - 1];
        kinds.push(expr ? kotlinArgKind(expr) : arg.text.trim() === "null" ? "null" : "?");
      }
    }
  }
  return kinds.some((k) => k !== "?") ? kinds : null;
}

/**
 * Type the variable arguments (`@name`) of a method's calls by what the method
 * itself declares — its parameters, its locals with a stated type or a
 * self-typed initializer (`String s = …`, `val n = 1L`, `var c = new Club()`) —
 * which, unlike `localTypes`, keeps primitives and strings. A lambda's untyped
 * parameter is unknown (`?`), so a field of that name never stands in for it.
 * What stays `@name` is left to the linker (fields, inherited state).
 */
export function typeVariableArgs(
  calls: readonly import("../../../types/analysis.js").CallInfo[],
  params: readonly import("../../../types/analysis.js").ParamInfo[],
  body: Node | null,
  language: "java" | "kotlin",
): void {
  if (!body || !calls.some((c) => c.argKinds?.some((k) => k.startsWith("@")))) return;
  const typeKey = language === "java" ? javaOverloadTypeKey : kotlinOverloadTypeKey;
  const argKind = language === "java" ? javaArgKind : kotlinArgKind;
  const known = new Map<string, string>();
  for (const p of params) if (!p.isReceiver) known.set(p.name, p.type ? typeKey(p.type) : "?");
  const declare = (name: string | undefined, type: string | undefined | null, init?: Node | null): void => {
    if (!name || known.has(name)) return;
    if (type && type !== "var") known.set(name, typeKey(type));
    else {
      const k = init ? argKind(init) : "?";
      known.set(name, k.startsWith("@") ? "?" : k);
    }
  };
  const visit = (n: Node): void => {
    switch (n.type) {
      case "local_variable_declaration": {
        const type = n.childForFieldName("type")?.text;
        for (const c of n.namedChildren) if (c.type === "variable_declarator") declare(c.childForFieldName("name")?.text, type, c.childForFieldName("value"));
        break;
      }
      case "enhanced_for_statement":
        declare(n.childForFieldName("name")?.text, n.childForFieldName("type")?.text);
        break;
      case "catch_formal_parameter":
        declare(n.childForFieldName("name")?.text, n.namedChildren.find((c) => c.type === "catch_type")?.text);
        break;
      case "lambda_expression": {
        const ps = n.childForFieldName("parameters");
        if (ps?.type === "identifier") declare(ps.text, null);
        else for (const p of ps?.namedChildren ?? []) {
          if (p.type === "identifier") declare(p.text, null);
          else if (p.type === "formal_parameter") declare(p.childForFieldName("name")?.text, p.childForFieldName("type")?.text);
        }
        break;
      }
      case "property_declaration": {
        const decl = n.namedChildren.find((c) => c.type === "variable_declaration");
        const name = decl?.namedChildren.find((c) => c.type === "simple_identifier")?.text;
        const type = decl?.namedChildren.find((c) => c.type !== "simple_identifier")?.text;
        const eq = n.children.findIndex((c) => c.type === "=");
        declare(name, type, eq >= 0 ? n.children[eq + 1] : null);
        break;
      }
      case "lambda_parameters":
        for (const p of n.namedChildren) {
          const name = p.namedChildren.find((c) => c.type === "simple_identifier")?.text;
          const type = p.namedChildren.find((c) => c.type !== "simple_identifier")?.text;
          declare(name, type);
        }
        break;
      case "for_statement":
        if (language === "kotlin") {
          const decl = n.namedChildren.find((c) => c.type === "variable_declaration");
          declare(decl?.namedChildren.find((c) => c.type === "simple_identifier")?.text, decl?.namedChildren.find((c) => c.type !== "simple_identifier")?.text);
        }
        break;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  for (const c of calls) {
    if (!c.argKinds?.some((k) => k.startsWith("@"))) continue;
    c.argKinds = c.argKinds.map((k) => (k.startsWith("@") ? known.get(k.slice(1)) ?? k : k));
  }
}
