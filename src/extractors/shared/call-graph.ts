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
  go: new Set(["call_expression", "composite_literal"]),
  rust: new Set(["call_expression", "macro_invocation"]),
  ruby: new Set(["call", "method_call"]),
  php: new Set(["function_call_expression", "member_call_expression", "object_creation_expression"]),
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

  function addResult(name: string, node: Node) {
    if (name && !isNoise(name) && !seen.has(name)) {
      seen.add(name);
      results.push({
        name,
        kind: "internal",
        target: null,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  function walk(node: Node, isRoot: boolean) {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    // Don't descend into nested function/class definitions (except the root body itself)
    if (!isRoot && NESTED_SCOPE_TYPES.has(node.type)) return;

    // Standard call expressions
    if (callTypes.has(node.type)) {
      const name = resolveCallName(node, language);
      if (name) addResult(name, node);

      // Detect callback arguments: fn(callback) — identifiers passed as args
      if (node.type === "call_expression" || node.type === "method_invocation" || node.type === "call") {
        const args = node.childForFieldName("arguments");
        if (args) {
          for (let j = 0; j < args.childCount; j++) {
            const arg = args.child(j)!;
            if (arg.type === "identifier" && /^[a-zA-Z_]/.test(arg.text) && !isNoise(arg.text)) {
              addResult(arg.text, arg);
            }
          }
        }
      }
    }

    // JSX element references: <ComponentName ... /> counts as using ComponentName
    if (
      (language === "typescript" || language === "javascript") &&
      (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element")
    ) {
      const nameNode = node.childForFieldName("name") ?? node.child(1);
      if (nameNode && /^[A-Z]/.test(nameNode.text)) {
        addResult(nameNode.text, nameNode);
      }
    }

    // Python decorator references: @decorator counts as a call to decorator
    if (language === "python" && node.type === "decorator") {
      const expr = node.child(1); // after @
      if (expr) {
        const name = expr.type === "call" ? resolveCallName(expr, language) : expr.text;
        if (name) addResult(name, expr);
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
 * Extract top-level (module-scope) calls — calls not inside any function or class body.
 * Used for Vue <script setup> where hooks like useUserStore() are at module scope.
 */
export function extractTopLevelCalls(tree: { rootNode: Node }, language: Language): CallInfo[] {
  const callTypes = CALL_TYPES[language];
  if (!callTypes) return [];

  const results: CallInfo[] = [];
  const seen = new Set<string>();

  function walk(node: Node) {
    // Stop at function/class boundaries — those are handled by extractCalls
    if (NESTED_SCOPE_TYPES.has(node.type)) return;
    // Also stop at named function declarations and class declarations
    if (
      node.type === "function_declaration" ||
      node.type === "class_declaration" ||
      node.type === "method_definition"
    ) return;

    if (callTypes.has(node.type)) {
      const name = resolveCallName(node, language);
      if (name && !isNoise(name) && !seen.has(name)) {
        seen.add(name);
        results.push({
          name,
          kind: "internal",
          target: null,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!);
    }
  }

  walk(tree.rootNode);
  return results;
}

/** Build import lookup maps from an imports array */
function buildImportMaps(imports: ImportInfo[]): {
  importMap: Map<string, string>;
  defaultImports: Map<string, string>;
} {
  const importMap = new Map<string, string>();
  const defaultImports = new Map<string, string>();

  for (const imp of imports) {
    if (imp.isType) continue;
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

  return { importMap, defaultImports };
}

/**
 * Classify raw calls using import context and language-specific patterns.
 * Mutates and returns the calls array with updated `kind` and `target`.
 */
export function classifyCalls(
  calls: CallInfo[],
  imports: ImportInfo[],
  language: Language,
  variableAliases?: Map<string, string>,
): CallInfo[] {
  const { importMap, defaultImports } = buildImportMaps(imports);

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

    // 2b. Variable alias resolution: const userStore = useUserStore() → userStore.x resolves to useUserStore's source
    if (variableAliases && call.name.includes(".")) {
      const aliasSource = variableAliases.get(root);
      if (aliasSource) {
        call.kind = "cross-file";
        call.target = aliasSource;
        continue;
      }
    }

    // 2c. Instance variable → imported type matching for qualified calls
    // Java/Kotlin: @Autowired UserService userService → userService.method, import is UserService
    // Python: user_service = UserService() → user_service.method, import is UserService
    if (call.name.includes(".")) {
      // Try capitalizing first letter (Java: userService → UserService)
      if (language === "java" || language === "kotlin") {
        const rootUpper = root.charAt(0).toUpperCase() + root.slice(1);
        const upperSource = importMap.get(rootUpper);
        if (upperSource) {
          call.kind = "cross-file";
          call.target = upperSource;
          continue;
        }
      }

      // Try snake_case → PascalCase (Python: user_service → UserService)
      if (language === "python" && root.includes("_")) {
        const pascal = root.split("_").map(s => s.charAt(0).toUpperCase() + s.slice(1)).join("");
        const pascalSource = importMap.get(pascal);
        if (pascalSource) {
          call.kind = "cross-file";
          call.target = pascalSource;
          continue;
        }
      }

      // Delphi/Pascal: fields prefixed with F → strip F to match unit name
      // e.g., FUserService.Save → strip F → UserService matches import "UserService"
      if (language === "pascal" && root.startsWith("F") && root.length > 1) {
        const stripped = root.slice(1);
        const strippedSource = importMap.get(stripped);
        if (strippedSource) {
          call.kind = "cross-file";
          call.target = strippedSource;
          continue;
        }
      }

      // Try matching root against import source module names
      // Python: user_service matches last segment of "services.user_service"
      const moduleMatch = imports.find(imp =>
        !imp.isType && imp.source.split(".").pop() === root
      );
      if (moduleMatch) {
        call.kind = "cross-file";
        call.target = moduleMatch.source;
        continue;
      }
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
  // Java/Kotlin method_invocation: has "object" and "name" fields — handle first
  // to avoid losing the qualifier (e.g., "userService.searchUsers" → not just "searchUsers")
  if (
    (language === "java" || language === "kotlin") &&
    (node.type === "method_invocation" || node.type === "call_expression")
  ) {
    const nameNode = node.childForFieldName("name");
    const obj = node.childForFieldName("object");
    if (nameNode) {
      return obj ? `${obj.text}.${nameNode.text}` : nameNode.text;
    }
  }

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

/**
 * Extract variable-to-call assignments from module-level code.
 * Returns a map: variable name → import source (resolved through imports).
 * E.g., `const userStore = useUserStore()` → { "userStore": "../stores/users" }
 */
export function extractVariableAliases(
  tree: { rootNode: Node },
  imports: ImportInfo[],
  language: Language,
): Map<string, string> {
  const aliases = new Map<string, string>();
  const { importMap } = buildImportMaps(imports);

  function walk(node: Node) {
    // Stop at function/class boundaries
    if (NESTED_SCOPE_TYPES.has(node.type) ||
        node.type === "function_declaration" ||
        node.type === "class_declaration") return;

    // Match: const/let/var name = importedFn()
    if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (let i = 0; i < node.childCount; i++) {
        const decl = node.child(i)!;
        if (decl.type === "variable_declarator") {
          const nameNode = decl.childForFieldName("name");
          const valueNode = decl.childForFieldName("value");
          if (nameNode && valueNode && valueNode.type === "call_expression") {
            const fnNode = valueNode.childForFieldName("function");
            const fnName = fnNode?.text;
            if (fnName && importMap.has(fnName)) {
              aliases.set(nameNode.text, importMap.get(fnName)!);
            }
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i)!);
    }
  }

  walk(tree.rootNode);
  return aliases;
}

/** Check if a call name is noise (chaining, logging, etc.) */
function isNoise(name: string): boolean {
  const lastDot = name.lastIndexOf(".");
  const shortName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
  return NOISE_CALLS.has(shortName);
}
