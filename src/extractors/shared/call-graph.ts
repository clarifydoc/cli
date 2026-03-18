import type { Node } from "web-tree-sitter";
import type { Language } from "../../types/analysis.js";

/**
 * Call expression node types per language.
 * These are the AST node types that represent function/method calls.
 */
const CALL_TYPES: Record<string, Set<string>> = {
  typescript: new Set(["call_expression", "new_expression"]),
  javascript: new Set(["call_expression", "new_expression"]),
  python: new Set(["call"]),
  java: new Set(["method_invocation", "object_creation_expression"]),
  kotlin: new Set(["call_expression"]),
  csharp: new Set(["invocation_expression", "object_creation_expression"]),
  pascal: new Set(["call"]),
};

/**
 * AST node types that define nested functions/classes — don't descend into these
 * when collecting calls for the current function scope.
 */
const NESTED_SCOPE_TYPES = new Set([
  // JS/TS
  "arrow_function",
  "function_expression",
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "class",
  // Python
  "function_definition",
  "class_definition",
  "lambda",
  // Java/Kotlin
  "method_declaration",
  "constructor_declaration",
  "lambda_expression",
  "anonymous_class_body",
  // C#
  "local_function_statement",
  "anonymous_method_expression",
  "lambda_expression",
]);

/** Methods that are noise — chaining, logging, promise utilities, etc. */
const NOISE_CALLS = new Set([
  "then", "catch", "finally",
  "json", "text", "blob", "arrayBuffer", "formData",
  "send", "status", "end",
  "log", "warn", "error", "info", "debug",
  "toString", "valueOf", "toJSON",
  "push", "pop", "shift", "unshift",
  "map", "filter", "reduce", "forEach", "find", "some", "every",
  "keys", "values", "entries",
  "join", "split", "trim", "replace",
  "parseInt", "parseFloat",
  "stringify", "parse",
]);

/**
 * Extract all function/method calls from within a function body node.
 *
 * Returns the call names as they appear in source — simple names for direct calls
 * (e.g. `"createUser"`) and qualified names for member calls (e.g. `"userService.findAll"`).
 *
 * Does NOT descend into nested function definitions, arrow functions, or lambdas.
 */
export function extractCalls(bodyNode: Node | null, language: Language): string[] {
  if (!bodyNode) return [];

  const callTypes = CALL_TYPES[language];
  if (!callTypes) return [];

  const names: string[] = [];
  const visited = new Set<number>();

  function walk(node: Node, isRoot: boolean) {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    // Don't descend into nested function/class definitions (except the root body itself)
    if (!isRoot && NESTED_SCOPE_TYPES.has(node.type)) return;

    if (callTypes.has(node.type)) {
      const name = resolveCallName(node, language);
      if (name && !isNoise(name)) {
        names.push(name);
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, false);
    }
  }

  walk(bodyNode, true);
  return [...new Set(names)];
}

/**
 * Resolve the full call name from a call expression node.
 * Returns qualified names for member calls: "obj.method" instead of just "method".
 */
function resolveCallName(node: Node, language: Language): string | null {
  // JS/TS: call_expression has "function" field; new_expression has "constructor"
  let callee =
    node.childForFieldName("function") ??
    node.childForFieldName("constructor") ??
    node.childForFieldName("name") ??
    node.child(0);

  if (!callee) return null;

  // Python: call node — first child is the function being called
  if (language === "python" && node.type === "call") {
    callee = node.childForFieldName("function") ?? node.child(0);
    if (!callee) return null;
  }

  // Simple identifier: foo()
  if (callee.type === "identifier" || callee.type === "simple_identifier") {
    return callee.text;
  }

  // Member/attribute calls: obj.method() — return full qualified "obj.method"
  if (
    callee.type === "member_expression" ||
    callee.type === "attribute" ||
    callee.type === "field_expression" ||
    callee.type === "selector_expression" ||
    callee.type === "member_access_expression"
  ) {
    return callee.text;
  }

  // Scoped calls: Namespace::method() or Package.Class
  if (
    callee.type === "scoped_identifier" ||
    callee.type === "qualified_name" ||
    callee.type === "dot_qualified_expression"
  ) {
    return callee.text;
  }

  // Java: method_invocation where "name" field is the method
  if (language === "java" || language === "kotlin") {
    const nameNode = node.childForFieldName("name");
    const obj = node.childForFieldName("object");
    if (nameNode) {
      return obj ? `${obj.text}.${nameNode.text}` : nameNode.text;
    }
  }

  // C#: invocation_expression — first child is the expression being invoked
  if (language === "csharp") {
    if (callee.type === "identifier_name") return callee.text;
    if (callee.type === "member_access_expression") return callee.text;
  }

  // new_expression: "new Foo()" → "Foo"
  if (node.type === "new_expression" || node.type === "object_creation_expression") {
    const typeNode =
      node.childForFieldName("type") ??
      node.childForFieldName("constructor");
    if (typeNode) return `new ${typeNode.text}`;
  }

  return null;
}

/** Check if a call name is noise (chaining, logging, etc.) */
function isNoise(name: string): boolean {
  // For qualified calls like "console.log", check the last segment
  const lastDot = name.lastIndexOf(".");
  const shortName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
  return NOISE_CALLS.has(shortName);
}
