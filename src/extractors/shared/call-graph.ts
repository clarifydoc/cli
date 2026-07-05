import type { Node } from "web-tree-sitter";
import type { Language, CallInfo, ImportInfo } from "../../types/analysis.js";
import type { CallExtractionHooks } from "../../types/language-plugin.js";
import { isApiCall, isDatabaseCall } from "./call-patterns.js";

/**
 * Generic call extraction & classification. Everything language-specific —
 * call node types, scope boundaries, name resolution quirks, auto-imported
 * globals, qualified-root heuristics — comes from each plugin's
 * `meta.calls` hooks, pushed in by `extractors/registry.ts` at load time.
 * This module stays a leaf: it is imported from plugin code
 * (functions-classes extractors, routes), so it must not import the
 * registry or any plugin itself.
 */

const callHooksByLanguage = new Map<Language, CallExtractionHooks>();

/**
 * Node types that define nested functions/classes — `extractCalls` doesn't
 * descend into these when collecting calls for the current function scope.
 * Union across all registered plugins (see CallExtractionHooks.nestedScopeTypes).
 */
const NESTED_SCOPE_TYPES = new Set<string>();

/** Call node types whose arguments are scanned for callback identifiers (union). */
const CALLBACK_ARG_NODE_TYPES = new Set<string>();

/** Nested-scope types that are function EXPRESSIONS — descend when anonymous (union). */
const ANONYMOUS_SCOPE_TYPES = new Set<string>();

/** Called by the registry while aggregating plugin metas. */
export function registerCallExtraction(language: Language, hooks: CallExtractionHooks | undefined): void {
  if (!hooks) return;
  callHooksByLanguage.set(language, hooks);
  for (const t of hooks.nestedScopeTypes ?? []) NESTED_SCOPE_TYPES.add(t);
  for (const t of hooks.anonymousScopeTypes ?? []) ANONYMOUS_SCOPE_TYPES.add(t);
  for (const t of hooks.callbackArgNodeTypes ?? []) CALLBACK_ARG_NODE_TYPES.add(t);
}

/**
 * An anonymous function expression (inline JSX handler, effect callback, IIFE)
 * is not a symbol of its own — its calls execute on behalf of the enclosing
 * function, so the call walk continues through it. A function expression bound
 * to a name (`const f = () => {…}`) IS extracted as its own function and stays
 * a boundary.
 */
function isAnonymousFnExpression(node: Node): boolean {
  return ANONYMOUS_SCOPE_TYPES.has(node.type) && node.parent?.type !== "variable_declarator";
}

/** True if the node type opens a nested function/class scope (cross-plugin union). */
export function isNestedScopeType(nodeType: string): boolean {
  return NESTED_SCOPE_TYPES.has(nodeType);
}

/** Methods that are noise — chaining, logging, promise utilities, etc. */
export const NOISE_CALLS = new Set([
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
 * Returns CallInfo[] with name, line, and initial kind="internal".
 * Use `classifyCalls()` afterward to categorize using import context.
 *
 * Does NOT descend into nested function definitions, arrow functions, or lambdas.
 */
export function extractCalls(bodyNode: Node | null, language: Language): CallInfo[] {
  if (!bodyNode) return [];

  const hooks = callHooksByLanguage.get(language);
  if (!hooks) return [];
  const callTypes = hooks.callNodeTypes;

  const results: CallInfo[] = [];
  const seen = new Set<string>();
  const visited = new Set<number>();
  const resolve = (n: Node) => resolveCallName(n, language);

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

    // Don't descend into nested function/class definitions (except the root
    // body itself) — those are symbols of their own. Anonymous function
    // expressions are the exception: `onClick={() => addToCart(id)}` has no
    // symbol, so its calls attribute here.
    if (!isRoot && NESTED_SCOPE_TYPES.has(node.type) && !isAnonymousFnExpression(node)) return;

    // Standard call expressions
    if (callTypes.has(node.type)) {
      const name = resolve(node);
      if (name) addResult(name, node);

      // Detect callback arguments: fn(callback) — identifiers passed as args
      if (CALLBACK_ARG_NODE_TYPES.has(node.type)) {
        const args = node.childForFieldName("arguments");
        if (args) {
          for (const arg of args.children) {
            if (arg.type === "identifier" && /^[a-zA-Z_]/.test(arg.text) && !isNoise(arg.text)) {
              addResult(arg.text, arg);
            }
          }
        }
      }
    }

    // Language extras: JSX component references, Python decorators, etc.
    hooks?.collectExtraCalls?.(node, addResult, resolve);

    for (const child of node.children) {
      walk(child, false);
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
  const hooks = callHooksByLanguage.get(language);
  if (!hooks) return [];
  const callTypes = hooks.callNodeTypes;

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

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(tree.rootNode);
  return results;
}

/** Build import lookup maps from an imports array */
export function buildImportMaps(imports: ImportInfo[]): {
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
 * Classify raw calls using import context and language plugin hooks.
 * Mutates and returns the calls array with updated `kind` and `target`.
 */
export function classifyCalls(
  calls: CallInfo[],
  imports: ImportInfo[],
  language: Language,
  variableAliases?: Map<string, string>,
): CallInfo[] {
  const { importMap, defaultImports } = buildImportMaps(imports);
  const hooks = callHooksByLanguage.get(language);

  outer:
  for (const call of calls) {
    // 0. Auto-imported globals (e.g. Vue <script setup> compiler macros)
    const auto = hooks?.classifyAutoImported?.(call.name);
    if (auto) {
      call.kind = "cross-file";
      call.target = auto.target;
      call.confidence = "EXTRACTED";
      continue;
    }

    // 1. Check cross-file: exact match on import specifier
    const directMatch = importMap.get(call.name);
    if (directMatch) {
      call.kind = "cross-file";
      call.target = directMatch;
      call.confidence = "EXTRACTED";
      continue;
    }

    // 2. Check cross-file: qualified call like `importedModule.method`
    const root = call.name.split(".")[0]!;
    const defaultSource = defaultImports.get(root);
    if (defaultSource) {
      call.kind = "cross-file";
      call.target = defaultSource;
      call.confidence = "EXTRACTED";
      continue;
    }

    // Also check named imports used as root of qualified call
    const namedSource = importMap.get(root);
    if (namedSource && call.name.includes(".")) {
      call.kind = "cross-file";
      call.target = namedSource;
      call.confidence = "EXTRACTED";
      continue;
    }

    // 2b. Variable alias resolution: const userStore = useUserStore() → userStore.x
    // resolves to useUserStore's source. A BARE name consults the alias map too —
    // that's a destructured factory member (`const { refreshCart } = useShopCart()`;
    // the later `refreshCart()` call must classify into the composable's module,
    // or every hook/composable-based UI trace dead-ends one hop from the screen).
    if (variableAliases) {
      const aliasSource = variableAliases.get(call.name.includes(".") ? root : call.name);
      if (aliasSource) {
        call.kind = "cross-file";
        call.target = aliasSource;
        // Tracked through a const = importedFn() assignment — one indirection from source
        call.confidence = "INFERRED";
        continue;
      }
    }

    // 2c. Instance variable → imported type matching for qualified calls.
    // The root-name transforms are language conventions supplied by the
    // plugin (Java userService→UserService, Python user_service→UserService,
    // Delphi FUserService→UserService).
    if (call.name.includes(".")) {
      for (const candidate of hooks?.qualifiedRootCandidates?.(root) ?? []) {
        const candidateSource = importMap.get(candidate);
        if (candidateSource) {
          call.kind = "cross-file";
          call.target = candidateSource;
          call.confidence = "INFERRED";
          continue outer;
        }
      }

      // Try matching root against import source module names
      // Python: user_service matches last segment of "services.user_service"
      // Most fuzzy of the heuristics — just the last segment.
      const moduleMatch = imports.find(imp =>
        !imp.isType && imp.source.split(".").pop() === root
      );
      if (moduleMatch) {
        call.kind = "cross-file";
        call.target = moduleMatch.source;
        call.confidence = "AMBIGUOUS";
        continue;
      }
    }

    // 3. Check API call patterns
    if (isApiCall(call.name, language)) {
      call.kind = "api-call";
      call.confidence = "EXTRACTED";
      continue;
    }

    // 4. Check database patterns
    if (isDatabaseCall(call.name, language)) {
      call.kind = "database";
      call.confidence = "EXTRACTED";
      continue;
    }

    // 5. Default: internal — confidence left unset; unresolved internal calls
    // carry no provenance signal.
  }

  return calls;
}

// ─── Call-name resolution ────────────────────────────────────────────────

/** Options for `genericResolveCallName` — plugin hooks use these to splice
 *  language quirks into the generic resolution order. */
export interface GenericResolveOptions {
  /**
   * Replace the generic callee computation (function ?? constructor ?? name
   * ?? child(0)). A null override returns null, matching a failed lookup.
   */
  calleeOverride?: Node | null;
  /**
   * Extra callee-shape handling, tried after the generic identifier /
   * member / scoped checks and before new-expression handling.
   */
  extraCallee?(callee: Node, node: Node): string | null;
}

/**
 * Generic call-name resolution: identifier, member/attribute chains, scoped
 * names, and `new X(...)`. Returns qualified names for member calls
 * ("obj.method" instead of just "method"). Language plugins layer their
 * grammar quirks on top via GenericResolveOptions.
 */
export function genericResolveCallName(node: Node, opts?: GenericResolveOptions): string | null {
  const callee = opts && "calleeOverride" in opts
    ? opts.calleeOverride
    : node.childForFieldName("function") ??
      node.childForFieldName("constructor") ??
      node.childForFieldName("name") ??
      node.child(0);

  if (!callee) return null;

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

  if (opts?.extraCallee) {
    const extra = opts.extraCallee(callee, node);
    if (extra != null) return extra;
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
 * Resolve the full call name from a call expression node, using the
 * language plugin's resolver when it has one.
 */
function resolveCallName(node: Node, language: Language): string | null {
  const hook = callHooksByLanguage.get(language)?.resolveCallName;
  if (hook) return hook(node);
  return genericResolveCallName(node);
}

/** Check if a call name is noise (chaining, logging, etc.) */
function isNoise(name: string): boolean {
  const lastDot = name.lastIndexOf(".");
  const shortName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
  return NOISE_CALLS.has(shortName);
}
