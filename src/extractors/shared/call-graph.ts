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
 * Union across all registered plugins (see CallExtractionHooks.nestedScopeTypes);
 * the walk itself uses the per-language sets below.
 */
const NESTED_SCOPE_TYPES = new Set<string>();

/**
 * Per-language scope sets. The walk must not use the cross-plugin union:
 * grammars DO share node names (`arrow_function` is both a JS and a PHP
 * node), so a PHP closure's calls were attributed to its enclosing method
 * only when the JS plugin happened to be loaded — which differs between a
 * worker thread and an in-process run of the same file.
 */
const NESTED_SCOPE_BY_LANGUAGE = new Map<Language, ReadonlySet<string>>();
const ANONYMOUS_SCOPE_BY_LANGUAGE = new Map<Language, ReadonlySet<string>>();
const NO_TYPES: ReadonlySet<string> = new Set();

/** Call node types whose arguments are scanned for callback identifiers (union). */
const CALLBACK_ARG_NODE_TYPES = new Set<string>();

/** Node type → fields that bind a local name there (union, see CallExtractionHooks.bindingSites). */
const BINDING_SITES = new Map<string, Set<string>>();

/** Pattern node type → fields holding further bound names, "*" = all (union). */
const BINDING_PATTERNS = new Map<string, Set<string>>();

/** The leaves of a bound pattern. */
const BOUND_IDENTIFIER_TYPES = new Set(["identifier", "shorthand_property_identifier_pattern"]);

function unionFields(into: Map<string, Set<string>>, from: Readonly<Record<string, readonly string[]>> | undefined): void {
  for (const [type, fields] of Object.entries(from ?? {})) {
    let set = into.get(type);
    if (!set) into.set(type, (set = new Set()));
    for (const f of fields) set.add(f);
  }
}

/** Called by the registry while aggregating plugin metas. */
export function registerCallExtraction(language: Language, hooks: CallExtractionHooks | undefined): void {
  if (!hooks) return;
  callHooksByLanguage.set(language, hooks);
  for (const t of hooks.nestedScopeTypes ?? []) NESTED_SCOPE_TYPES.add(t);
  NESTED_SCOPE_BY_LANGUAGE.set(language, new Set(hooks.nestedScopeTypes ?? []));
  ANONYMOUS_SCOPE_BY_LANGUAGE.set(language, new Set(hooks.anonymousScopeTypes ?? []));
  for (const t of hooks.callbackArgNodeTypes ?? []) CALLBACK_ARG_NODE_TYPES.add(t);
  unionFields(BINDING_SITES, hooks.bindingSites);
  unionFields(BINDING_PATTERNS, hooks.bindingPatterns);
}

/**
 * Add every name `node`'s binding site binds (its parameters, its declarator...).
 * A declarator or assignment whose value is itself a function
 * (`const onClick = () => …`, `f = lambda: …`) binds a function — the plugin
 * extracts it as one — so passing it on stays a callback reference.
 */
function collectBoundNames(site: Node, into: Set<string>, nested: ReadonlySet<string>): void {
  const fields = BINDING_SITES.get(site.type);
  if (!fields) return;
  if (!nested.has(site.type)) {
    const value = site.childForFieldName("value") ?? site.childForFieldName("right");
    if (value && nested.has(value.type)) return;
  }
  for (const field of fields) {
    const bound = site.childForFieldName(field);
    if (bound) collectPatternNames(bound, into);
  }
}

function collectPatternNames(pattern: Node, into: Set<string>): void {
  if (BOUND_IDENTIFIER_TYPES.has(pattern.type)) {
    into.add(pattern.text);
    return;
  }
  const fields = BINDING_PATTERNS.get(pattern.type);
  if (!fields) return;
  if (fields.has("*")) {
    for (const child of pattern.namedChildren) collectPatternNames(child, into);
    return;
  }
  for (const field of fields) {
    const child = pattern.childForFieldName(field);
    if (child) collectPatternNames(child, into);
  }
}

/**
 * An anonymous function expression (inline JSX handler, effect callback, IIFE)
 * is not a symbol of its own — its calls execute on behalf of the enclosing
 * function, so the call walk continues through it. A function expression bound
 * to a name (`const f = () => {…}`) IS extracted as its own function and stays
 * a boundary.
 */
function isAnonymousFnExpression(node: Node, anonymous: ReadonlySet<string>): boolean {
  return anonymous.has(node.type) && node.parent?.type !== "variable_declarator";
}

/** True if the node type opens a nested function/class scope (cross-plugin union). */
export function isNestedScopeType(nodeType: string): boolean {
  return NESTED_SCOPE_TYPES.has(nodeType);
}

/** Receivers that name the current instance, across the supported languages. */
const OWN_INSTANCE_RECEIVERS = new Set(["this", "self", "cls", "Self", "$this"]);

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
  const receiverTypeOf = hooks.receiverTypeOf;
  const nested = NESTED_SCOPE_BY_LANGUAGE.get(language) ?? NO_TYPES;
  const anonymous = ANONYMOUS_SCOPE_BY_LANGUAGE.get(language) ?? NO_TYPES;

  const visited = new Set<number>();
  const resolve = (n: Node) => resolveCallName(n, language);

  // Candidates in walk order. A callback-argument reference is only kept if
  // the scope does not bind that name itself, which is known once the walk
  // has seen the whole body — so the decision waits, and the order stays the
  // walk's.
  const candidates: Array<{
    name: string; line: number; column: number; isReference: boolean;
    receiver?: { type: string; qualifier?: string } | null;
  }> = [];
  const boundHere = new Set<string>();

  const push = (name: string, node: Node, isReference: boolean, receiver?: { type: string; qualifier?: string } | null) => {
    candidates.push({ name, line: node.startPosition.row + 1, column: node.startPosition.column, isReference, receiver });
  };
  const addResult = (name: string, node: Node) => {
    if (name) push(name, node, false);
  };

  function walk(node: Node, isRoot: boolean) {
    if (visited.has(node.id)) return;
    visited.add(node.id);

    // Don't descend into nested function/class definitions (except the root
    // body itself) — those are symbols of their own. Anonymous function
    // expressions are the exception: `onClick={() => addToCart(id)}` has no
    // symbol, so its calls attribute here.
    if (!isRoot && nested.has(node.type) && !isAnonymousFnExpression(node, anonymous)) return;

    // Parameters, declarators, assignment targets, loop variables — every
    // scope this walk attributes to the function (incl. inline arrows).
    collectBoundNames(node, boundHere, nested);

    // Standard call expressions
    if (callTypes.has(node.type)) {
      const name = resolve(node);
      if (name) push(name, node, false, receiverTypeOf?.(node));

      // Detect callback arguments: fn(callback) — identifiers passed as args
      if (CALLBACK_ARG_NODE_TYPES.has(node.type)) {
        const args = node.childForFieldName("arguments");
        if (args) {
          for (const arg of args.children) {
            if (arg.type === "identifier" && /^[a-zA-Z_]/.test(arg.text)) {
              push(arg.text, arg, true);
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

  // A body's parameters live on its function node, outside the walk.
  if (!BINDING_SITES.has(bodyNode.type) && bodyNode.parent) collectBoundNames(bodyNode.parent, boundHere, nested);
  walk(bodyNode, true);

  const results: CallInfo[] = [];
  const seen = new Set<string>();
  const held: HeldCall[] = [];
  for (const c of candidates) {
    if (c.isReference && boundHere.has(c.name)) continue;
    if (seen.has(c.name)) continue;
    const call: CallInfo = { name: c.name, kind: "internal", target: null, line: c.line, column: c.column };
    if (c.receiver && (c.receiver.type || c.receiver.qualifier)) {
      // The expression names its receiver's type (or the key it was looked
      // up by) — a member call on a container lookup is never Array#find.
      if (c.receiver.type) call.receiverType = c.receiver.type;
      if (c.receiver.qualifier) call.receiverQualifier = c.receiver.qualifier;
    } else if (isNoise(c.name)) {
      seen.add(c.name);
      if (!c.isReference && c.name.includes(".")) held.push({ index: results.length, call });
      continue;
    }
    seen.add(c.name);
    results.push(call);
  }
  if (held.length > 0) HELD_NOISE_CALLS.set(results, held);
  return results;
}

/** A call dropped as noise by its leaf name, and where it would have stood. */
interface HeldCall {
  /** Position in the result array it was dropped from (before later insertions). */
  index: number;
  call: CallInfo;
}

/**
 * Member calls held back as noise ONLY because of their leaf name
 * (`repo.find`, `notifier.send`, `$this->parser->parse`), keyed by the result
 * array they were dropped from. Whether `find` is Array#find or a repository
 * method depends on the receiver's declared type, which the extractor that
 * calls `extractCalls` with a bare body cannot see — so the decision is
 * deferred to `restoreHeldCalls`, run by the per-file pipeline once params,
 * properties and locals are known. A path that never restores keeps the old
 * behaviour exactly: the calls stay dropped.
 */
const HELD_NOISE_CALLS = new WeakMap<CallInfo[], HeldCall[]>();

/** Hold `call` back from `results` (regex-path counterpart of the tree-sitter walk). */
export function holdNoiseCall(results: CallInfo[], call: CallInfo): void {
  let held = HELD_NOISE_CALLS.get(results);
  if (!held) HELD_NOISE_CALLS.set(results, (held = []));
  held.push({ index: results.length, call });
}

/**
 * Put back the held calls of `calls` that `keep` accepts, at the position the
 * walk found them. Returns how many were restored. Consumes the held set.
 */
export function restoreHeldCalls(calls: CallInfo[], keep: (call: CallInfo) => boolean): number {
  const held = HELD_NOISE_CALLS.get(calls);
  if (!held) return 0;
  HELD_NOISE_CALLS.delete(calls);
  let inserted = 0;
  for (const h of held) {
    if (!keep(h.call)) continue;
    calls.splice(h.index + inserted, 0, h.call);
    inserted++;
  }
  return inserted;
}

/**
 * Extract top-level (module-scope) calls — calls not inside any function or class body.
 * Used for Vue <script setup> where hooks like useUserStore() are at module scope.
 */
export function extractTopLevelCalls(tree: { rootNode: Node }, language: Language): CallInfo[] {
  const hooks = callHooksByLanguage.get(language);
  if (!hooks) return [];
  const callTypes = hooks.callNodeTypes;
  const receiverTypeOf = hooks.receiverTypeOf;
  const nested = NESTED_SCOPE_BY_LANGUAGE.get(language) ?? NO_TYPES;

  const results: CallInfo[] = [];
  const seen = new Set<string>();

  function walk(node: Node) {
    // Stop at function/class boundaries — those are handled by extractCalls
    if (nested.has(node.type)) return;
    // Also stop at named function declarations and class declarations
    if (
      node.type === "function_declaration" ||
      node.type === "class_declaration" ||
      node.type === "method_definition"
    ) return;

    if (callTypes.has(node.type)) {
      const name = resolveCallName(node, language);
      if (name && !seen.has(name)) {
        seen.add(name);
        const call: CallInfo = {
          name,
          kind: "internal",
          target: null,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        };
        // Same rules as `extractCalls`: a lookup chained into the call names
        // its receiver; a noise-named member call is held for the
        // typed-receiver pass rather than dropped.
        const receiver = receiverTypeOf?.(node);
        if (receiver && (receiver.type || receiver.qualifier)) {
          if (receiver.type) call.receiverType = receiver.type;
          if (receiver.qualifier) call.receiverQualifier = receiver.qualifier;
          results.push(call);
        } else if (!isNoise(name)) {
          results.push(call);
        } else if (name.includes(".")) {
          holdNoiseCall(results, call);
        }
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
  variableAliases?: Map<string, string | import("../../types/language-plugin.js").VariableAliasBinding>,
  /**
   * Names this file defines — functions (with the root of a dotted one:
   * `requests` for `requests.get`) and classes. See step 2d.
   */
  localSymbols?: ReadonlySet<string>,
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
      const alias = variableAliases.get(call.name.includes(".") ? root : call.name);
      if (alias) {
        call.kind = "cross-file";
        call.target = typeof alias === "string" ? alias : alias.source;
        // Tracked through a const = importedFn() assignment — one indirection from source
        call.confidence = "INFERRED";
        // Remember the factory the receiver came from: when the member doesn't
        // exist in the target module (a library-made object like a tanstack
        // mutation), the linker links the factory instead (CallInfo.via).
        if (typeof alias !== "string" && alias.factory) call.via = alias.factory;
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

    // 2d. The file's own code. A call whose root names something this file
    // defines — `requests.get(…)` on a local namespace object, a bare
    // `create(…)` beside `def create` — is a call into the project, whatever
    // its method is called. Steps 3-4 guess from names for receivers we cannot
    // see; applied here they labelled it `database`, and both the symbol
    // linker and the LSP enhancer skip that kind, so it could never resolve.
    if (localSymbols?.has(root)) continue;

    // 3. Check API call patterns
    if (isApiCall(call.name, language)) {
      call.kind = "api-call";
      call.confidence = "EXTRACTED";
      continue;
    }

    // 4. Check database patterns. A method on the receiver's own instance
    // (`this.exec(…)`, `self.repo.update(…)`) is not database evidence by its
    // name alone — that is the class's own method or field, which the linker
    // can follow. A known DB client root still is.
    const ownInstance = call.name.includes(".") && OWN_INSTANCE_RECEIVERS.has(root);
    if (isDatabaseCall(call.name, language, !ownInstance)) {
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
