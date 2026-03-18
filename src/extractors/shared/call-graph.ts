import type { Node } from "web-tree-sitter";
import type { Language, CallInfo, ImportInfo } from "../../types/analysis.js";
import { isApiCall, isDatabaseCall } from "./call-patterns.js";

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
  pascal: new Set(["exprCall"]),
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

/** Vue 3 <script setup> compiler macros — auto-imported, not in imports array */
const VUE_COMPILER_MACROS = new Set([
  "defineProps", "defineEmits", "defineExpose", "defineOptions",
  "defineModel", "defineSlots", "withDefaults", "emit",
]);

/**
 * Extract all function/method calls from within a function body node.
 *
 * Returns CallInfo[] with name, line, and initial kind="internal".
 * Use `classifyCalls()` afterward to categorize using import context.
 *
 * Does NOT descend into nested function definitions, arrow functions, or lambdas.
 */
export function extractCalls(bodyNode: Node | null, language: Language): CallInfo[] {
  if (!bodyNode) return [];

  const callTypes = CALL_TYPES[language];
  if (!callTypes) return [];

  const results: CallInfo[] = [];
  const seen = new Set<string>();
  const visited = new Set<number>();

  function walk(node: Node, isRoot: boolean) {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    // Don't descend into nested function/class definitions (except the root body itself)
    if (!isRoot && NESTED_SCOPE_TYPES.has(node.type)) return;

    if (callTypes.has(node.type)) {
      const name = resolveCallName(node, language);
      if (name && !isNoise(name) && !seen.has(name)) {
        seen.add(name);
        results.push({
          name,
          kind: "internal",
          target: null,
          line: node.startPosition.row + 1,
        });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!, false);
    }
  }

  walk(bodyNode, true);
  return results;
}

/**
 * Classify raw calls using import context and language-specific patterns.
 * Mutates and returns the calls array with updated `kind` and `target`.
 */
export function classifyCalls(
  calls: CallInfo[],
  imports: ImportInfo[],
  language: Language,
): CallInfo[] {
  // Build import lookup: specifier name → import source
  const importMap = new Map<string, string>();
  const defaultImports = new Map<string, string>();

  for (const imp of imports) {
    if (imp.isType) continue; // skip type-only imports

    for (const spec of imp.specifiers) {
      importMap.set(spec, imp.source);
    }

    if (imp.isDefault && imp.specifiers.length > 0) {
      defaultImports.set(imp.specifiers[0]!, imp.source);
    }

    if (imp.isNamespace && imp.specifiers.length > 0) {
      defaultImports.set(imp.specifiers[0]!, imp.source);
    }
  }

  for (const call of calls) {
    // 0. Vue compiler macros (auto-imported, not in imports array)
    if (VUE_COMPILER_MACROS.has(call.name)) {
      call.kind = "cross-file";
      call.target = "vue";
      continue;
    }

    // 1. Check cross-file: exact match on import specifier
    const directMatch = importMap.get(call.name);
    if (directMatch) {
      call.kind = "cross-file";
      call.target = directMatch;
      continue;
    }

    // 2. Check cross-file: qualified call like `importedModule.method`
    const root = call.name.split(".")[0]!;
    const defaultSource = defaultImports.get(root);
    if (defaultSource) {
      call.kind = "cross-file";
      call.target = defaultSource;
      continue;
    }

    // Also check named imports used as root of qualified call
    const namedSource = importMap.get(root);
    if (namedSource && call.name.includes(".")) {
      call.kind = "cross-file";
      call.target = namedSource;
      continue;
    }

    // 3. Check API call patterns
    if (isApiCall(call.name, language)) {
      call.kind = "api-call";
      continue;
    }

    // 4. Check database patterns
    if (isDatabaseCall(call.name, language)) {
      call.kind = "database";
      continue;
    }

    // 5. Default: internal
  }

  return calls;
}

/**
 * Resolve the full call name from a call expression node.
 * Returns qualified names for member calls: "obj.method" instead of just "method".
 */
function resolveCallName(node: Node, language: Language): string | null {
  let callee =
    node.childForFieldName("function") ??
    node.childForFieldName("constructor") ??
    node.childForFieldName("name") ??
    node.child(0);

  if (!callee) return null;

  if (language === "python" && node.type === "call") {
    callee = node.childForFieldName("function") ?? node.child(0);
    if (!callee) return null;
  }

  if (callee.type === "identifier" || callee.type === "simple_identifier") {
    return callee.text;
  }

  if (
    callee.type === "member_expression" ||
    callee.type === "attribute" ||
    callee.type === "field_expression" ||
    callee.type === "selector_expression" ||
    callee.type === "member_access_expression"
  ) {
    return callee.text;
  }

  if (
    callee.type === "scoped_identifier" ||
    callee.type === "qualified_name" ||
    callee.type === "dot_qualified_expression"
  ) {
    return callee.text;
  }

  if (language === "java" || language === "kotlin") {
    const nameNode = node.childForFieldName("name");
    const obj = node.childForFieldName("object");
    if (nameNode) {
      return obj ? `${obj.text}.${nameNode.text}` : nameNode.text;
    }
  }

  if (language === "csharp") {
    if (callee.type === "identifier_name") return callee.text;
    if (callee.type === "member_access_expression") return callee.text;
  }

  // Pascal: exprCall with exprDot or identifier as first child
  if (language === "pascal" && node.type === "exprCall") {
    if (callee.type === "exprDot") return callee.text;
    if (callee.type === "identifier") return callee.text;
    if (callee.type === "inherited") return callee.text;
  }

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
  const lastDot = name.lastIndexOf(".");
  const shortName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
  return NOISE_CALLS.has(shortName);
}
