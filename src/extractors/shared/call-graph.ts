import type { Node } from "web-tree-sitter";
import type { Language, CallInfo, CallArgOrigin, ImportInfo } from "../../types/analysis.js";
import type { CallExtractionHooks } from "../../types/language-plugin.js";
import { dbRootRefused, isApiCall, isDatabaseCall, isDatabaseHandleOrigin } from "./call-patterns.js";

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
/** Per language: the parents that bind an anonymous scope to a name (`variable_declarator` always does). */
const NAMED_BINDING_BY_LANGUAGE = new Map<Language, ReadonlySet<string>>();
const LOCAL_DECLARATION_BY_LANGUAGE = new Map<Language, ReadonlySet<string>>();
const NO_TYPES: ReadonlySet<string> = new Set();

/** Per language: call node types whose arguments are scanned for callback identifiers. */
const CALLBACK_ARG_BY_LANGUAGE = new Map<Language, ReadonlySet<string>>();

/**
 * Per language, as the scope sets above and for the same reason (`assignment_expression`
 * is a JS and a Java node, and only JS binds a callable name by assigning it):
 * node type → fields that bind a local name there (CallExtractionHooks.bindingSites),
 * and pattern node type → fields holding further bound names, "*" = all.
 */
type FieldTable = ReadonlyMap<string, ReadonlySet<string>>;
interface BindingTables { sites: FieldTable; patterns: FieldTable; opaque: ReadonlySet<string> }
const BINDINGS_BY_LANGUAGE = new Map<Language, BindingTables>();
/** Per language: the node types the `extractCalls` walk reads on a node — scope boundaries, binding sites, calls. */
const READ_TYPES_BY_LANGUAGE = new Map<Language, ReadonlySet<string>>();
const NO_BINDINGS: BindingTables = { sites: new Map(), patterns: new Map(), opaque: new Set() };

/** The leaves of a bound pattern. */
const BOUND_IDENTIFIER_TYPES = new Set(["identifier", "shorthand_property_identifier_pattern"]);

function fieldTable(from: Readonly<Record<string, readonly string[]>> | undefined): FieldTable {
  return new Map(Object.entries(from ?? {}).map(([type, fields]) => [type, new Set(fields)]));
}

/** Called by the registry while aggregating plugin metas. */
export function registerCallExtraction(language: Language, hooks: CallExtractionHooks | undefined): void {
  if (!hooks) return;
  callHooksByLanguage.set(language, hooks);
  for (const t of hooks.nestedScopeTypes ?? []) NESTED_SCOPE_TYPES.add(t);
  NESTED_SCOPE_BY_LANGUAGE.set(language, new Set(hooks.nestedScopeTypes ?? []));
  ANONYMOUS_SCOPE_BY_LANGUAGE.set(language, new Set(hooks.anonymousScopeTypes ?? []));
  NAMED_BINDING_BY_LANGUAGE.set(language, new Set(["variable_declarator", ...(hooks.namedBindingTypes ?? [])]));
  LOCAL_DECLARATION_BY_LANGUAGE.set(language, new Set(hooks.localDeclarationTypes ?? []));
  CALLBACK_ARG_BY_LANGUAGE.set(language, new Set(hooks.callbackArgNodeTypes ?? []));
  const bindings = { sites: fieldTable(hooks.bindingSites), patterns: fieldTable(hooks.bindingPatterns), opaque: new Set(hooks.unextractedFunctionValues ?? []) };
  BINDINGS_BY_LANGUAGE.set(language, bindings);
  READ_TYPES_BY_LANGUAGE.set(language, new Set([...(hooks.nestedScopeTypes ?? []), ...hooks.callNodeTypes, ...bindings.sites.keys(), ...(hooks.perNodeTypes ?? [])]));
}

/**
 * Add every name `node`'s binding site binds (its parameters, its declarator...).
 * A declarator or assignment whose value is itself a function
 * (`const onClick = () => …`, `f = lambda: …`) binds a function — the plugin
 * extracts it as one — so passing it on stays a callback reference. `values`
 * (a bare call's view, `unextractedFunctionValues`): a function value the plugin
 * does not extract is a value the function holds, so its name is bound.
 */
function collectBoundNames(site: Node, into: Set<string>, nested: ReadonlySet<string>, tables: BindingTables, type: string = site.type, values = false): void {
  const fields = tables.sites.get(type);
  if (!fields) return;
  if (!nested.has(type)) {
    const value = site.childForFieldName("value") ?? site.childForFieldName("right");
    if (value && nested.has(value.type) && !(values && tables.opaque.has(value.type))) return;
  }
  for (const field of fields) {
    // "*": every name the site lists (`nonlocal a, b`).
    if (field === "*") for (const child of site.namedChildren) collectPatternNames(child, into, tables.patterns);
    const bound = field === "*" ? null : site.childForFieldName(field);
    if (bound) collectPatternNames(bound, into, tables.patterns);
  }
}

/** Whether a node type is a function with a parameter list (a binding site holding `parameters`/`parameter`). */
function isFunctionLike(type: string, tables: BindingTables): boolean {
  const fields = tables.sites.get(type);
  return !!fields && (fields.has("parameters") || fields.has("parameter"));
}

/**
 * The names a function's own body binds: its statements' binding sites, never those of a function or class written
 * inside it, anonymous or not (a callback's parameter assigned in its body is the callback's).
 */
function collectLocalsOf(fn: Node, into: Set<string>, nested: ReadonlySet<string>, anonymous: ReadonlySet<string>, tables: BindingTables, callTypes: ReadonlySet<string>): void {
  const body = fn.childForFieldName("body");
  if (!body) return;
  const visit = (node: Node): void => {
    const type = node.type;
    // Another function's names (an anonymous one's parameters and locals too) are its own, not the enclosing one's.
    // (A method of an object literal is such a function too, whether or not the plugin lists it as a scope.)
    if (nested.has(type) || isFunctionLike(type, tables)) return;
    // `var state = wrap(function () {…})`: the plugin extracts the callback as a function of that name — the
    // declaration a sibling's call reaches, not a value shadowing it.
    const value = node.childForFieldName("value");
    const handsOnFunction = !!value && callTypes.has(value.type) && !!value.childForFieldName("arguments")?.namedChildren.some((a) => nested.has(a.type));
    if (!handsOnFunction) collectBoundNames(node, into, nested, tables, type, true);
    for (const child of node.namedChildren) visit(child);
  };
  visit(body);
}

function collectPatternNames(pattern: Node, into: Set<string>, patterns: FieldTable): void {
  if (BOUND_IDENTIFIER_TYPES.has(pattern.type)) {
    into.add(pattern.text);
    return;
  }
  const fields = patterns.get(pattern.type);
  if (!fields) return;
  if (fields.has("*")) {
    for (const child of pattern.namedChildren) collectPatternNames(child, into, patterns);
    return;
  }
  for (const field of fields) {
    const child = pattern.childForFieldName(field);
    if (child) collectPatternNames(child, into, patterns);
  }
}

/**
 * An anonymous function expression (inline JSX handler, effect callback, IIFE)
 * is not a symbol of its own — its calls execute on behalf of the enclosing
 * function, so the call walk continues through it. A function expression bound
 * to a name (`const f = () => {…}`) IS extracted as its own function and stays
 * a boundary. A method declared directly in an anonymous class body (listed as
 * an anonymous scope) is no symbol either: it runs on behalf of the function
 * that constructs the object.
 */
function isAnonymousFnExpression(node: Node, anonymous: ReadonlySet<string>, named: ReadonlySet<string> = DEFAULT_NAMED_BINDING, locals: ReadonlySet<string> = NO_TYPES): boolean {
  const parent = node.parent;
  if (!anonymous.has(node.type)) return !!parent && anonymous.has(parent.type);
  if (!parent || !named.has(parent.type)) return true;
  // A declarator of a local (`Runnable r = () -> …`) names a value, not a function the plugin extracts.
  // The declaration is the declarator's parent or, where a grammar nests a list between them, its grandparent.
  const declaration = parent.parent;
  return !!declaration && (locals.has(declaration.type) || (!!declaration.parent && locals.has(declaration.parent.type)));
}
const DEFAULT_NAMED_BINDING: ReadonlySet<string> = new Set(["variable_declarator"]);

/**
 * Whether a function's name is that of one written in place and handed on — a held callback
 * (`CallExtractionHooks.heldFunction`: `<toast.action@17>`, `<items[].run@3#2>`) or a template's
 * (`<ClubCard:onPick@9>`): named for where it is written, run on behalf of whatever it sits in.
 */
export function isHandedOnName(name: string): boolean {
  return HANDED_ON_NAME.test(name);
}
const HANDED_ON_NAME = /^<.+@\d+(?:#\d+)?>$/;

/** True if the node type opens a nested function/class scope (cross-plugin union). */
export function isNestedScopeType(nodeType: string): boolean {
  return NESTED_SCOPE_TYPES.has(nodeType);
}

/** Receivers that name the current instance, across the supported languages. */
const OWN_INSTANCE_RECEIVERS = new Set(["this", "self", "cls", "Self", "$this", "static", "Me", "MyClass", "me", "myclass"]);

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
 * `skip` names further subtrees the caller reads on their own; the walk leaves them out.
 *
 * Hook tables are read per language, never as a union over plugins: grammars share node names
 * (`assignment_expression` is JS and Java) and a union made a file's calls depend on what its worker had loaded.
 * The hooks, in the order the walk uses them (`CallExtractionHooks` states each field):
 *  1. `callNodeTypes` are calls; `nestedScopeTypes` start a new scope and stop the recursion. A childless node of a
 *     type no step reads (`READ_TYPES_BY_LANGUAGE`: scopes, call types, binding sites) is not entered when the plugin
 *     has no `readNames` hook and no `skip`, and either no `collectExtraCalls`/`destructuredFromCall`/`heldFunction`
 *     hook or states every node type they act on as `perNodeTypes` — a new hook that must see every node goes into
 *     that condition. `anonymousScopeTypes` are function expressions walked on the parent's behalf unless a
 *     declarator names them; `localDeclarationTypes` (Java `local_variable_declaration`, C#
 *     `local_declaration_statement`) say a declarator names a value, so `Runnable r = () -> club.save();` leaves
 *     `club.save` on the enclosing method's row.
 *  2. `resolveCallName` names the callee (plugins compose `genericResolveCallName`); whatever it returns, a chain
 *     written across lines is named as on one line (`compactCallName`), so the call and its `localTypes[].from`
 *     spelling link like the one-line twin.
 *  3. `collectExtraCalls` adds call shapes (JSX component refs, Python decorators).
 *  4. `heldFunction` is a function expression extracted as a function of its own though no declarator names it (a
 *     callback handed on to run later): the walk stops there and records the enclosing function handing it on
 *     (`passed: "argument"`; module code hands it on from `<setup>`), so reach keeps the writer's calls one `passes`
 *     hop further while an emit, a prop call or a member call lands on the callback alone. Complexity skips it
 *     (`<…@line>`); ordinary inline arrows stay the writer's.
 *  5. `callbackArgNodeTypes` + `bindingSites`/`bindingPatterns`: an identifier passed as an argument is a call
 *     (`items.map(formatUser)` → `formatUser`) unless the function binds the name itself (parameter, declarator,
 *     assignment target, loop/catch/`with` variable). The tables are grammar data (node type → field holding the
 *     pattern; pattern type → fields to descend, `"*"` = all); bindings are collected in the same walk and the
 *     references filtered once it ends. A declarator whose value is a function (`const onClick = () => …`) stays a
 *     reference (without the filter about a quarter of all "calls" were variables, which the linker then bound by
 *     name or through a file-wide factory alias: `foo(client)` → `IxClient`). `passedArguments` names the other handed-on shapes per grammar (`this.onResize`, Python
 *     `target=worker`, Kotlin `::save`, C# method groups), `ownMember` exempts the instance's own member from the
 *     bound-receiver skip, `destructuredFromCall` names the locals a declarator takes from a call
 *     (`const { save } = useClubActions()`), which `classifyCalls` routes into the factory's module (array
 *     elements bind by position and fall back to the factory). A reference carries `CallInfo.passed` (`argument`,
 *     or `attribute`/`return`/`property` from `collectExtraCalls`), which the linker turns into
 *     `relation: "passes"`; a name the body also invokes stays one call (a map's value excepted); `property` names
 *     are also read at a module's top level (`extractTopLevelCalls`), and a value held under several keys is one
 *     claim per key.
 *  6. `boundAt` answers `boundLocally` for one call node where the function-wide set is too coarse (a dotted name:
 *     its head); the answer is part of the dedup key, so two sites of one name stay two calls.
 *  7. `statedMember`/`importedMapMember`: a member call whose leaf is a noise name (`map`, `send`, `filter`) is kept
 *     when the file states the receiver is a project value (a top-level binding in scope at the call; a parameter,
 *     local, loop or catch variable of that name is another value — `receiverReboundAt`; a local object literal
 *     holding the called key owns the call; `CallInfo.receiverRebound` stops a rebound head taking a same-file
 *     namesake's member), or, marked `CallInfo.mapMember`, when it reads a key off a name imported from a project
 *     file — the linker joins a `mapMember` call only through the exporting file's dispatch map.
 *  8. `NOISE_CALLS` drops method names no plugin should list itself (`.then`, `.map`, `console.log`).
 */
export function extractCalls(bodyNode: Node | null, language: Language, skip?: (node: Node) => boolean): CallInfo[] {
  if (!bodyNode) return [];

  const hooks = callHooksByLanguage.get(language);
  if (!hooks) return [];
  const callTypes = hooks.callNodeTypes;
  const receiverTypeOf = hooks.receiverTypeOf;
  const keyOf = hooks.keyOf;
  const argsOf = hooks.argsOf;
  const argCountOf = hooks.argCountOf;
  const argOriginsOf = hooks.argOriginsOf;
  const argKindsOf = hooks.argKindsOf;
  const withSubjectsOf = hooks.withSubjectsOf;
  const indexOriginOf = hooks.indexOriginOf;
  const nested = NESTED_SCOPE_BY_LANGUAGE.get(language) ?? NO_TYPES;
  const anonymous = ANONYMOUS_SCOPE_BY_LANGUAGE.get(language) ?? NO_TYPES;
  const named = NAMED_BINDING_BY_LANGUAGE.get(language) ?? DEFAULT_NAMED_BINDING;
  const locals = LOCAL_DECLARATION_BY_LANGUAGE.get(language) ?? NO_TYPES;
  const callbackArgTypes = CALLBACK_ARG_BY_LANGUAGE.get(language) ?? NO_TYPES;
  const bindings = BINDINGS_BY_LANGUAGE.get(language) ?? NO_BINDINGS;

  const resolve = (n: Node) => resolveCallName(n, language);

  // A childless node whose type no step of the walk reads does nothing: no scope boundary, no binding site,
  // no call, and (where the plugin states no per-node hook) nothing extra. Such a child (an anonymous
  // token, an identifier, a literal) is not entered. About 60 % of a C# body's nodes.
  const inertLeaves = !skip && !hooks.readNames && (hooks.perNodeTypes !== undefined || (!hooks.collectExtraCalls && !hooks.destructuredFromCall && !hooks.heldFunction));
  const readTypes = READ_TYPES_BY_LANGUAGE.get(language) ?? NO_TYPES;

  // Candidates in walk order. A callback-argument reference is only kept if
  // the scope does not bind that name itself, which is known once the walk
  // has seen the whole body — so the decision waits, and the order stays the
  // walk's.
  const candidates: Array<{
    name: string; line: number; column: number; isReference: boolean;
    passed?: CallInfo["passed"];
    ownMember?: boolean;
    returnedAs?: string;
    libraryOption?: string;
    read?: boolean;
    receiver?: { type: string; qualifier?: string } | null;
    key?: string | null;
    args?: string[] | null;
    argCount?: number | null;
    argOrigins?: CallArgOrigin[] | null;
    argKinds?: string[] | null;
    withSubjects?: string[] | null;
    indexOrigin?: CallArgOrigin["origin"] | null;
    stated?: boolean;
    mapMember?: boolean;
    /** The plugin's per-site answer (`CallExtractionHooks.boundAt`); absent = the function-wide set decides. */
    bound?: boolean;
    /** The plugin's answer to `CallExtractionHooks.receiverReboundAt`. */
    rebound?: boolean;
  }> = [];
  const boundHere = new Set<string>();
  const localHere = new Set<string>();
  // Names destructured from a call's result: what a factory hands back, answered by its module.
  const fromFactory = new Set<string>();

  const push = (
    name: string,
    node: Node,
    isReference: boolean,
    receiver?: { type: string; qualifier?: string } | null,
    key?: string | null,
    args?: string[] | null,
    argCount?: number | null,
    argOrigins?: CallArgOrigin[] | null,
    argKinds?: string[] | null,
    passed?: CallInfo["passed"],
  ) => {
    candidates.push({ name, line: node.startPosition.row + 1, column: node.startPosition.column, isReference, passed, receiver, key, args, argCount, argOrigins, argKinds });
    if (!isReference && hooks.boundAt) candidates[candidates.length - 1]!.bound = hooks.boundAt(node, name);
    if (!isReference && hooks.receiverReboundAt && name.includes(".") && hooks.receiverReboundAt(node, name)) candidates[candidates.length - 1]!.rebound = true;
  };
  const addResult = (name: string, node: Node, passed?: "attribute" | "return" | "property", returnedAs?: string, extra?: { libraryOption?: string }) => {
    if (!name) return;
    if (passed) push(name, node, true, null, null, null, null, null, null, passed);
    else push(name, node, false);
    if (returnedAs) candidates[candidates.length - 1]!.returnedAs = returnedAs;
    if (extra?.libraryOption) candidates[candidates.length - 1]!.libraryOption = extra.libraryOption;
  };

  function walk(node: Node, isRoot: boolean) {
    const type = node.type;
    // A subtree the caller reads as a function of its own (a test runner's nested `it`).
    if (!isRoot && skip?.(node)) return;

    // Don't descend into nested function/class definitions (except the root
    // body itself) — those are symbols of their own. Anonymous function
    // expressions are the exception: `onClick={() => addToCart(id)}` has no
    // symbol, so its calls attribute here.
    if (!isRoot && nested.has(type) && !isAnonymousFnExpression(node, anonymous, named, locals)) return;
    // A callback the plugin extracts as a function of its own: handed on from here, its calls its own.
    const held = !isRoot && nested.has(type) ? hooks?.heldFunction?.(node) : null;
    if (held) {
      push(held, node, true, null, null, null, null, null, null, "argument");
      return;
    }

    // Parameters, declarators, assignment targets, loop variables — every
    // scope this walk attributes to the function (incl. inline arrows).
    collectBoundNames(node, boundHere, nested, bindings, type);
    // A body's own bindings (not a function's parameters): what a bare call of that name calls.
    if (!nested.has(type) && !anonymous.has(type)) collectBoundNames(node, localHere, nested, bindings, type, true);

    // Standard call expressions
    if (callTypes.has(type)) {
      const name = resolve(node);
      if (name) {
        push(name, node, false, receiverTypeOf?.(node), keyOf?.(node, name), argsOf?.(node), argCountOf?.(node), argOriginsOf?.(node), argKindsOf?.(node));
        if (withSubjectsOf) candidates[candidates.length - 1]!.withSubjects = withSubjectsOf(node);
        if (indexOriginOf) candidates[candidates.length - 1]!.indexOrigin = indexOriginOf(node, name);
        if (hooks?.statedMember?.(node, name)) candidates[candidates.length - 1]!.stated = true;
        else if (isNoise(name) && hooks?.importedMapMember?.(node, name)) {
          candidates[candidates.length - 1]!.stated = true;
          candidates[candidates.length - 1]!.mapMember = true;
        }
      }

      // Detect callback arguments: fn(callback) — identifiers passed as args
      if (callbackArgTypes.has(type)) {
        const args = node.childForFieldName("arguments");
        if (args) {
          for (const arg of args.children) {
            if (arg.type === "identifier" && /^[a-zA-Z_]/.test(arg.text)) {
              push(arg.text, arg, true, null, null, null, null, null, null, "argument");
            }
          }
        }
      }
      for (const p of hooks?.passedArguments?.(node) ?? []) {
        push(p.name, p.node, true, null, null, null, null, null, null, "argument");
        if (p.ownMember) candidates[candidates.length - 1]!.ownMember = true;
      }
    }

    // Names read without parentheses where the language runs a routine named so (Pascal `N := ACar.Shine`).
    const readNames = hooks?.readNames?.(node);
    if (readNames) for (const r of readNames) {
      if (r.passed) {
        push(r.name, r.node, true, null, null, null, null, null, null, "argument");
        continue;
      }
      push(r.name, r.node, false);
      candidates[candidates.length - 1]!.read = true;
    }

    // Language extras: JSX component references, Python decorators, etc.
    hooks?.collectExtraCalls?.(node, addResult, resolve);
    const destructured = hooks?.destructuredFromCall?.(node);
    if (destructured) for (const name of destructured) fromFactory.add(name);

    if (inertLeaves) {
      for (const child of node.children) {
        if (child.childCount === 0 && !readTypes.has(child.type)) continue;
        walk(child, false);
      }
    } else {
      for (const child of node.children) {
        walk(child, false);
      }
    }
  }

  // A body's parameters live on its function node, outside the walk.
  if (!bindings.sites.has(bodyNode.type) && bodyNode.parent) collectBoundNames(bodyNode.parent, boundHere, nested, bindings);
  // A nested function's free names include its enclosing functions' parameters: values handed in
  // (`seconds`, a decorator's `func`), never a function of the project of that name.
  // Its locals too: a name an enclosing function binds in its body is that value where a closure calls it
  // (`def run(): return kickoff()` inside the function holding `kickoff = compute()`), never a module function's.
  const ancestorLocals = new Set<string>();
  for (let p = bodyNode.parent?.parent ?? null; p; p = p.parent) {
    if (!nested.has(p.type)) continue;
    collectBoundNames(p, boundHere, nested, bindings);
    if (isFunctionLike(p.type, bindings)) collectLocalsOf(p, ancestorLocals, nested, anonymous, bindings, hooks.callNodeTypes);
  }
  for (const name of hooks.bodyBoundNames?.(bodyNode) ?? []) localHere.add(name);
  walk(bodyNode, true);

  const results: CallInfo[] = [];
  const seen = new Set<string>();
  const held: HeldCall[] = [];
  for (const c of candidates) {
    // A name handed on that the scope binds (a parameter, a local, `props` in `props.onSave`)
    // is a value, never the project function of that name.
    const head = c.name.split(".")[0]!;
    if (c.isReference && !c.ownMember && boundHere.has(head) && !(c.passed && fromFactory.has(head))) continue;
    // A keyed dispatch is one call per key: `dispatch('a/x')` and `dispatch('b/y')` reach different handlers.
    // So is a call reported with its arguments: `Fill(qryA)` and `Fill(qryB)` pass different datasets.
    // So is a call with another argument count: `save(o)` and `save(o, true)` may be two overloads
    // (not where the language has none: there the first call's count stands for the name).
    // So are calls of one count whose arguments differ in kind: `write("plate")` and
    // `write(ByteArray(2))` may be two overloads of one arity.
    // So is a call handing on values whose origin is known (a parameter, a URL value, a prop): each
    // site is its own claim about what feeds the callee (`load(params.id)` and `load(params.id, page)`).
    // So is a call on a receiver whose type the site states apart from the rest (a block's own
    // `let v = new Truck()` shadowing a parameter `v: Car`): `v.drive()` there is another method.
    const typed = (c.receiver?.type ? `\0<${c.receiver.type}>` : "") + (c.withSubjects ? `\0with(${c.withSubjects.join(",")})` : "");
    // A name handed on is its own claim beside a call of it (`save()` and `register(save)`).
    // A dispatch map's value is one claim per key it is held under (`{ save: saveClub, store: saveClub }`).
    const seenKeyBase = c.passed ? `${c.name}\0passed${c.passed === "property" ? `\0${c.returnedAs}` : ""}` : c.read ? `${c.name}\0read` : c.key ? `${c.name}\0${c.key}` : c.args ? `${c.name}\0(${c.args.join(",")})${typed}`
      : c.argOrigins?.length || c.indexOrigin ? `${c.name}\0@${c.line}:${c.column}`
      : c.argCount != null && !hooks.noOverloads ? `${c.name}\0#${c.argCount}${c.argKinds ? `(${c.argKinds.join(",")})` : ""}${typed}` : c.name + typed;
    // A site its own block binds the name of is another claim than one the module's name reaches.
    const seenKey = c.bound ? `${seenKeyBase}\0bound` : c.rebound ? `${seenKeyBase}\0rebound` : seenKeyBase;
    // One site is one call, however many ways the walk met it (a decorator is also its call node) — a value held
    // under several keys is one claim per key (a library option callback under each method running it).
    const site = `${c.name}\0@${c.line}:${c.column}${c.passed === "property" ? `\0${c.returnedAs}` : ""}`;
    if (seen.has(seenKey) || seen.has(site)) continue;
    seen.add(site);
    const call: CallInfo = { name: c.name, kind: "internal", target: null, line: c.line, column: c.column };
    if (c.passed) call.passed = c.passed;
    if (c.read) call.read = true;
    if (c.returnedAs) call.returnedAs = c.returnedAs;
    if (c.libraryOption) call.libraryOption = c.libraryOption;
    if (c.mapMember) call.mapMember = true;
    if (c.rebound) call.receiverRebound = true;
    if (!c.isReference && ((c.bound ?? localHere.has(c.name)) || (ancestorLocals.size > 0 && ancestorLocals.has(c.name)))) call.boundLocally = true;
    if (c.args) call.args = c.args;
    if (c.argCount != null) call.argCount = c.argCount;
    if (c.argOrigins?.length) call.argOrigins = c.argOrigins;
    if (c.argKinds) call.argKinds = c.argKinds;
    if (c.withSubjects) call.withSubjects = c.withSubjects;
    if (c.indexOrigin) call.indexOrigin = c.indexOrigin;
    if (c.key) {
      call.key = c.key;
      seen.add(seenKey);
      results.push(call);
      continue;
    }
    if (c.receiver && (c.receiver.type || c.receiver.qualifier)) {
      // The expression names its receiver's type (or the key it was looked
      // up by) — a member call on a container lookup is never Array#find.
      if (c.receiver.type) call.receiverType = c.receiver.type;
      if (c.receiver.qualifier) call.receiverQualifier = c.receiver.qualifier;
    } else if (isNoise(c.name) && !c.withSubjects && !c.stated) {
      // A read is no call worth holding back for a typed receiver.
      if (c.read) continue;
      seen.add(c.name);
      if (!c.isReference) held.push({ index: results.length, call });
      continue;
    }
    seen.add(seenKey);
    results.push(call);
  }
  if (held.length > 0) HELD_NOISE_CALLS.set(results, held);
  // A name the body also invokes is a call; handing it on (or reading it) as well adds nothing — except as a
  // dispatch map's value, which is what a call through the map reaches.
  const invoked = new Set(results.filter((r) => !r.passed && !r.read).map((r) => r.name));
  const redundant = (r: CallInfo) => ((!!r.passed && r.passed !== "property") || r.read === true) && invoked.has(r.name);
  if (!results.some(redundant)) return results;
  const kept = results.filter((r) => !redundant(r));
  // Held noise calls are re-inserted at their recorded positions; keep those valid.
  if (held.length > 0) {
    HELD_NOISE_CALLS.delete(results);
    for (const h of held) h.index -= results.slice(0, h.index).filter(redundant).length;
    HELD_NOISE_CALLS.set(kept, held);
  }
  return kept;
}

/** A call dropped as noise by its leaf name, and where it would have stood. */
interface HeldCall {
  /** Position in the result array it was dropped from (before later insertions). */
  index: number;
  call: CallInfo;
}

/**
 * Calls held back as noise ONLY because of their leaf name
 * (`repo.find`, `notifier.send`, `$this->parser->parse`, a bare `send(x)`), keyed by the result
 * array they were dropped from. Whether `find` is Array#find or a repository
 * method depends on the receiver's declared type — and a bare `send` may be
 * the enclosing class's own method —, which the extractor that
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

/** The calls held back from `calls`, not yet restored (to adjust them in place; restoring stays `restoreHeldCalls`'s). */
export function heldCallsOf(calls: CallInfo[]): readonly CallInfo[] {
  return HELD_NOISE_CALLS.get(calls)?.map((h) => h.call) ?? [];
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
  const keyOf = hooks.keyOf;
  const nested = NESTED_SCOPE_BY_LANGUAGE.get(language) ?? NO_TYPES;
  const anonymous = ANONYMOUS_SCOPE_BY_LANGUAGE.get(language) ?? NO_TYPES;
  const named = NAMED_BINDING_BY_LANGUAGE.get(language) ?? DEFAULT_NAMED_BINDING;
  const locals = LOCAL_DECLARATION_BY_LANGUAGE.get(language) ?? NO_TYPES;

  const results: CallInfo[] = [];
  const seen = new Set<string>();

  function walk(node: Node, inCallback = false) {
    // Stop at function/class boundaries — those are handled by extractCalls —
    // unless the function is a callback the module runs (`onMounted(() => …)`);
    // inside one, an inline callback runs on its behalf, as in a function body.
    if (hooks!.isFunctionDefinition?.(node)) return;
    const held = nested.has(node.type) ? hooks!.heldFunction?.(node) : null;
    if (held) {
      // Handed on from module code, as `extractCalls` hands it on from a function: whatever reaches the
      // module's calls reaches the callback's one `passes` hop further.
      if (!seen.has(`${held}\0passed`)) {
        seen.add(`${held}\0passed`);
        results.push({ name: held, kind: "internal", target: null, line: node.startPosition.row + 1, column: node.startPosition.column, passed: "argument" });
      }
      return;
    }
    if (nested.has(node.type)) {
      if (inCallback && isAnonymousFnExpression(node, anonymous, named, locals)) { /* read on */ }
      else if (hooks!.runsAtTopLevel?.(node)) inCallback = true;
      else return;
    }
    // Also stop at named function declarations and class declarations
    if (
      node.type === "function_declaration" ||
      node.type === "class_declaration" ||
      node.type === "method_definition"
    ) return;

    if (callTypes.has(node.type)) {
      const name = resolveCallName(node, language);
      const key = name ? keyOf?.(node, name) : null;
      // A call handing on values is its own claim beside the same call handing on others (`useFilter(a, onA)`, `useFilter(a, onB)`).
      const handedKey = (n: Node, nm: string): string => {
        const handed = hooks!.argsOf?.(n);
        return handed ? `${nm}\0(${handed.join(",")})` : nm;
      };
      if (name && key && !seen.has(`${name}\0${key}`)) {
        seen.add(`${name}\0${key}`);
        results.push({ name, kind: "internal", target: null, line: node.startPosition.row + 1, column: node.startPosition.column, key });
      } else if (name && !key && !seen.has(handedKey(node, name))) {
        seen.add(handedKey(node, name));
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
        // What a module-level call hands on (`useTableSort(sortBy, resetPage)`), as `extractCalls` reports it.
        const handed = hooks!.argsOf?.(node);
        if (handed) call.args = handed;
        // Where its arguments come from (`useClub(() => props.clubId)` in a Vue `<script setup>`), as `extractCalls` reports it.
        const origins = hooks!.argOriginsOf?.(node);
        if (origins) call.argOrigins = origins;
        if (receiver && (receiver.type || receiver.qualifier)) {
          if (receiver.type) call.receiverType = receiver.type;
          if (receiver.qualifier) call.receiverQualifier = receiver.qualifier;
          results.push(call);
        } else if (!isNoise(name) || hooks?.statedMember?.(node, name)) {
          results.push(call);
        } else if (hooks?.importedMapMember?.(node, name)) {
          results.push({ ...call, mapMember: true });
        } else if (name.includes(".")) {
          holdNoiseCall(results, call);
        }
      }
    }

    // A dispatch map the module declares (`const ACTIONS = { save: saveClub }`): its values are
    // the module's, handed on under their keys. Other extras belong to the declarations they sit in.
    hooks!.collectExtraCalls?.(node, (name, at, passed, returnedAs, extra) => {
      if (passed !== "property" || !name || seen.has(`${name}\0passed\0${returnedAs}`)) return;
      seen.add(`${name}\0passed\0${returnedAs}`);
      results.push({ name, kind: "internal", target: null, line: at.startPosition.row + 1, column: at.startPosition.column, passed, ...(returnedAs ? { returnedAs } : {}), ...(extra?.libraryOption ? { libraryOption: extra.libraryOption } : {}) });
    }, (n) => resolveCallName(n, language));

    for (const child of node.children) {
      walk(child, inCallback);
    }
  }

  walk(tree.rootNode);
  return results;
}

/** The first value import whose module path ends in each last segment (what `imports.find` by that segment answers). */
function importsByLastSegmentOf(imports: readonly ImportInfo[]): Map<string, ImportInfo> {
  const bySegment = new Map<string, ImportInfo>();
  for (const imp of imports) {
    if (imp.isType) continue;
    const segment = imp.source.slice(imp.source.lastIndexOf(".") + 1);
    if (!bySegment.has(segment)) bySegment.set(segment, imp);
  }
  return bySegment;
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
 * Mutates and returns the calls array with updated `kind` and `target`. Runs after extraction, in this order:
 *  - the plugin's auto-imported globals (Vue compiler macros) → `cross-file`;
 *  - an import specifier match, or a qualified name whose root matches an import/default/namespace → `cross-file`;
 *  - a variable alias (`s = useStore()` then `s.x.y`, a plugin's `ast.variableAliases`) → `cross-file`;
 *  - the plugin's `qualifiedRootCandidates` transforms (Java `userService`→`UserService`, Python snake→Pascal,
 *    Pascal `F`-strip) → `cross-file`, INFERRED;
 *  - a root naming one of the file's own definitions (`localSymbols`: functions, the dotted-name roots of
 *    `requests.get`, classes) stays `internal`, before any name heuristic — `api-call`/`database` calls are skipped
 *    by the symbol linker and the LSP enhancer, so a wrong label there is a link that can never form;
 *  - `isApiCall`/`isDatabaseCall` → `api-call`/`database`. A `this.`/`self.` receiver is never `database` by its
 *    method name alone (`byMethodName = false`; a known DB client root still is), a bare call (`sum(xs)`) never is,
 *    `execute` is not an HTTP method name, and a dotted root in a plugin's list (`http.client`) matches as a
 *    module-path prefix, not by its first segment.
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
  /**
   * Names the calling function binds itself — its parameters: `club.transfer()`
   * in `function second(club)` is a call on what the caller hands in, never on
   * a file-level `const club = useClub()` binding of another function.
   */
  ownBindings?: ReadonlySet<string>,
  /** The declared type of each receiver the caller can see (parameters, locals, fields), as written. */
  receiverTypes?: ReadonlyMap<string, string>,
  /**
   * The call each local of the caller is initialized from, when no type is
   * stated (`request` ← `pool.request`): a value a database client hands out
   * is a database handle, whatever its own name says.
   */
  receiverOrigins?: ReadonlyMap<string, string>,
  /** The file's own top-level functions: a bare call of one is to it, never to an import of its name (step 1). */
  ownFunctions?: ReadonlySet<string>,
): CallInfo[] {
  const { importMap, defaultImports } = buildImportMaps(imports);
  const hooks = callHooksByLanguage.get(language);
  // Module paths a file imports whole by their dotted name (`import league._make`), longest first.
  const dottedSpecs = [...importMap.keys()].filter((s) => s.includes(".")).sort((a, b) => b.length - a.length);

  let importsByLastSegment: Map<string, ImportInfo> | undefined;
  // The names an import inside a function binds (the caller's `imports` hold only the ones that reach it).
  const scopedNames = imports.some((i) => i.scope) ? new Set(imports.filter((i) => i.scope && !i.isType).flatMap((i) => i.specifiers)) : undefined;
  outer:
  for (const call of calls) {
    // 0. Auto-imported globals (e.g. Vue <script setup> compiler macros)
    // A name the file imports itself (`import { emit } from "./bus"`) is that import, never the global.
    const auto = importMap.has(call.name) ? null : hooks?.classifyAutoImported?.(call.name);
    if (auto) {
      call.kind = "cross-file";
      call.target = auto.target;
      call.confidence = "EXTRACTED";
      continue;
    }

    // A name the calling function binds itself — a parameter, destructured or
    // not (`function k({ boost })`) — is what the body calls, never the import it shadows.
    // It may still be an API or database call by its name (steps 3-4).
    // A local destructured from a factory's result (`const { frac } = useFraction()`) is the factory's (step 2b).
    // Unless the file defines the name itself: the call is then the local value's, and the alias would only hand it to that function.
    if (call.boundLocally && variableAliases?.has(call.name) && !(ownFunctions?.has(call.name) && !call.name.includes("."))) delete call.boundLocally;
    const dotAt = call.name.indexOf(".");
    const root = dotAt < 0 ? call.name : call.name.slice(0, dotAt);
    const ownParam = call.boundLocally === true || ownBindings?.has(root) === true;

    // 1. Check cross-file: exact match on import specifier — unless the file declares the name itself:
    // a later `def save` rebinds an imported `save` (Python), a file's own top-level `fun save` wins over
    // `import utils.save` (Kotlin); where the two clash (TS, PHP) the code does not compile.
    // An import inside a function (`ImportInfo.scope`) is no module-level rebinding: it is what that function's body calls.
    const ownDefinition = !call.name.includes(".") && ownFunctions?.has(call.name) === true && !scopedNames?.has(call.name);
    const directMatch = ownParam || ownDefinition ? undefined : importMap.get(call.name);
    if (directMatch) {
      call.kind = "cross-file";
      call.target = directMatch;
      call.confidence = "EXTRACTED";
      continue;
    }

    // 2. Check cross-file: qualified call like `importedModule.method`
    const defaultSource = ownParam ? undefined : defaultImports.get(root);
    if (defaultSource) {
      call.kind = "cross-file";
      call.target = defaultSource;
      call.confidence = "EXTRACTED";
      continue;
    }

    // Also check named imports used as root of qualified call
    const namedSource = ownParam ? undefined : importMap.get(root);
    if (namedSource && call.name.includes(".")) {
      call.kind = "cross-file";
      call.target = namedSource;
      call.confidence = "EXTRACTED";
      continue;
    }

    // A module path imported whole and called through it (`import league._make` … `league._make.s()`).
    const dotted = dottedSpecs.length > 0 ? dottedSpecs.find((s) => call.name.startsWith(`${s}.`)) : undefined;
    if (dotted) {
      call.kind = "cross-file";
      call.target = importMap.get(dotted)!;
      call.confidence = "EXTRACTED";
      continue;
    }

    // 2b. Variable alias resolution: const userStore = useUserStore() → userStore.x
    // resolves to useUserStore's source. A BARE name consults the alias map too —
    // that's a destructured factory member (`const { refreshCart } = useShopCart()`;
    // the later `refreshCart()` call must classify into the composable's module,
    // or every hook/composable-based UI trace dead-ends one hop from the screen).
    if (variableAliases) {
      // A bare name this file defines as a function is that function — the
      // binding that made it is an identity wrapper (`const f = useCallback(() => …)`).
      const ownFunction = !call.name.includes(".") && localSymbols?.has(call.name);
      const shadowed = ownBindings?.has(call.name.includes(".") ? root : call.name);
      // A member path bound as a whole (a typed prop read off the props object, `props.actions`) before its root.
      const parts = call.name.split(".");
      const alias = ownFunction || shadowed ? undefined : (parts.length > 2 || (parts.length === 2 && root === "this") ? variableAliases.get(`${parts[0]}.${parts[1]}`) : undefined) ?? variableAliases.get(call.name.includes(".") ? root : call.name);
      // A binding from a factory the file does not import (no source): only the factory is
      // remembered, for a project pass that knows where the framework imports it from.
      // A renamed destructured member (`{ remove: removeCar }`) is called by its local name.
      if (alias && typeof alias !== "string" && alias.member && !call.name.includes(".")) call.member = alias.member;
      else if (alias && typeof alias !== "string" && alias.member && parts.length === 2 && !/^\[\d+\]$/.test(alias.member)) call.headMember = alias.member;
      if (alias && typeof alias !== "string" && alias.source === "") {
        if (alias.factory) call.via = alias.factory;
      } else if (alias) {
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
      const moduleMatch = (importsByLastSegment ??= importsByLastSegmentOf(imports)).get(root);
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

    // A name read inside an expression is never a database or API call by its name: the
    // linker keeps it only where it resolves to the project's own routine.
    if (call.read) continue;

    // 2e. A local made by a database client (`const request = pool.request()`):
    // `request.input(…)` binds a query parameter, not an HTTP request.
    const origin = call.name.includes(".") ? receiverOrigins?.get(root) : undefined;
    if (origin && isDatabaseHandleOrigin(origin, language)) {
      call.kind = "database";
      call.confidence = "EXTRACTED";
      continue;
    }

    // 3. Check API call patterns
    if (isApiCall(call.name, language) || (hooks?.isApiCallShape?.(call.name, imports) && !isDatabaseCall(call.name, language, false))) {
      call.kind = "api-call";
      call.confidence = "EXTRACTED";
      continue;
    }

    // 4. Check database patterns. A method on the receiver's own instance
    // (`this.exec(…)`, `self.repo.update(…)`) is not database evidence by its
    // name alone — that is the class's own method or field, which the linker
    // can follow. A known DB client root still is.
    const ownInstance = call.name.includes(".") && OWN_INSTANCE_RECEIVERS.has(root);
    const declared = receiverTypes?.get(root);
    if (declared && dbRootRefused(root, declared, language)) continue;
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
 * A call expression as the chain a local initialized from it carries
 * (`localTypes[].from`): the call's name exactly as `extractCalls` spells it,
 * closed by `()` — `val dao = UserDAOFactory.getDAO()` → `UserDAOFactory.getDAO()`.
 * Null for a node this language's call walk would not record as a call.
 */
export function callChainText(node: Node | null | undefined, language: Language): string | null {
  if (!node) return null;
  const hooks = callHooksByLanguage.get(language);
  if (!hooks?.callNodeTypes.has(node.type)) return null;
  const name = resolveCallName(node, language);
  return name ? `${name}()` : null;
}

/**
 * Resolve the full call name from a call expression node, using the
 * language plugin's resolver when it has one.
 */
function resolveCallName(node: Node, language: Language): string | null {
  const hook = callHooksByLanguage.get(language)?.resolveCallName;
  return compactCallName(hook ? hook(node) : genericResolveCallName(node));
}

/**
 * A member chain written across lines (`club\n    .save()`, Go's `club.\n    Save()`, a Python `\` continuation) is
 * named as on one line (`club.save`): whitespace holding a line break beside a member operator (`.`, `?.`, `::`,
 * `->`) goes. Whitespace on one line, and a break anywhere else, stay as written.
 */
const BROKEN_CHAIN = /[ \t]*(?:\\[ \t]*)?\r?\n\s*(?=\?\.|\.|::|->)|(?<=\.|::|->)[ \t]*(?:\\[ \t]*)?\r?\n\s*/g;
export function compactCallName(name: string | null): string | null {
  return name !== null && name.includes("\n") ? name.replace(BROKEN_CHAIN, "") : name;
}

/** Check if a call name is noise (chaining, logging, etc.) */
function isNoise(name: string): boolean {
  const lastDot = name.lastIndexOf(".");
  const shortName = lastDot >= 0 ? name.slice(lastDot + 1) : name;
  return NOISE_CALLS.has(shortName);
}
