import { responsesOf } from "./responses.js";
import { derivedLocalsOf } from "./arg-origins.js";
import { extractZodSchemas } from "./zod-schemas.js";
import type { Node, Tree } from "web-tree-sitter";
import { renderUrlExpr } from "./url-expr.js";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import type { CallInfo, RouteParamInfo } from "../../../types/analysis.js";
import { getVisibility, extractJsDecorators, stripQuotes } from "../../shared/node-helpers.js";
import { escapeRegex } from "../shared/path-utils.js";
import { REQUEST_PARAM_NAMES, scanRequestAccess } from "./request-access.js";
import { callChainText, extractCalls } from "../../shared/call-graph.js";
import { testCaseFunctions } from "./test-cases.js";
import { heldFunctionNodes } from "./held-functions.js";
import { foldValue, type ValueExpr } from "../../shared/value-resolver.js";
import { astToValueExpr } from "./value-capture.js";
import {
  collectInjectionTokenTypes,
  initializerType,
  injectionOf,
  namesReceiverType,
  restatesType,
  type InjectedType,
} from "./di.js";
import { jsDocImplements, jsDocIsInterface, jsDocParamTypes, jsDocReturnType, jsDocTypeTag, precedingJsDoc } from "./jsdoc.js";
import { FUNCTION_EXPRESSIONS, handlerOf, wrappedCalleeName, wrappedFunction } from "./wrapped-functions.js";
import { loadedDefaultSource, loadedMemberCall } from "./loaded-members.js";
import { ELEMENT_CALLBACKS, KEEPS_ELEMENTS, collectionElement } from "./element-types.js";

/** A local variable whose type the body states (see `FunctionInfo.localTypes`). */
type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/** Per-file facts the body scan reads (set by the extractor when a file starts). */
interface ScanContext {
  /** Whether the file has JSDoc type tags worth looking for (a cheap substring gate). */
  jsdoc: boolean;
  /** Same-file `InjectionToken<T>` constants (see `collectInjectionTokenTypes`). */
  tokenTypes: ReadonlyMap<string, string>;
  /** Props `connect(…, mapDispatchToProps)` binds to action creators (see `dispatchPropsOf`). */
  dispatchProps: ReadonlyMap<string, string>;
  /** Names `connect(…, x)` is handed as its dispatch mapper (see `dispatchMappersOf`). */
  dispatchMappers: ReadonlySet<string>;
  /** Top-level `const x = 'literal'` of the file (see `moduleStringConstants`). */
  moduleStrings: ReadonlyMap<string, string>;
  /** Classes function bodies declare, by name: whether the class is reported (its name is the file's only one). */
  localClasses: ReadonlyMap<string, boolean>;
}

/**
 * The classes function bodies declare, by name, each with whether it is reported as a class of its own: only where
 * its name is the file's one class of it (two classes of a name share their members' symbol names).
 */
function localClassesOf(root: Node): Map<string, boolean> {
  const count = new Map<string, number>();
  const local = new Set<string>();
  for (const n of root.descendantsOfType(["class_declaration", "abstract_class_declaration"])) {
    const name = n?.childForFieldName("name")?.text;
    if (!n || !name) continue;
    // Only the function-local declarations count: a top-level namesake is another scope's class, which the
    // linker keeps apart by the line span each one holds.
    if (n.parent?.type !== "statement_block") continue;
    count.set(name, (count.get(name) ?? 0) + 1);
    local.add(name);
  }
  return new Map([...local].map((name) => [name, count.get(name) === 1]));
}

/**
 * The file's top-level string constants (`const endpoint = 'users'`), which a
 * class field set from one (`this.resourceName = endpoint`) holds.
 */
function moduleStringConstants(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const stmt of root.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
    if (decl?.type !== "lexical_declaration" || !decl.text.startsWith("const")) continue;
    for (const d of decl.namedChildren) {
      const name = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
      const value = d.childForFieldName("value");
      if (name?.type === "identifier" && value?.type === "string" && value.text.length <= 202) out.set(name.text, stripQuotes(value.text));
    }
  }
  return out;
}

/**
 * The body's calls, finished: `calls` with the dynamic-import and handed-over
 * function pseudo-calls appended IN PLACE — the array `extractCalls` returned carries the calls it
 * held back as noise (restored later by the per-file pipeline), keyed by its
 * identity — plus the local variables whose type the body states.
 */
function finishBody(
  calls: CallInfo[],
  body: Node | null,
  paramNames: ReadonlySet<string>,
  ctx: ScanContext,
  params: readonly ParamInfo[] = [],
): { calls: CallInfo[]; localTypes?: LocalType[]; returnedSpreads?: string[]; returnedMembers?: NonNullable<FunctionInfo["returnedMembers"]>; returnedFrom?: string[] } {
  const scan = scanBody(body, paramNames, ctx, params);
  const returnedMembers = returnedMembersOf(body);
  // A concise arrow returns its body.
  const returnedFrom = body && body.type !== "statement_block" ? resultChains(body, []) : scan.returnedFrom;
  calls.push(...scan.extraCalls);
  return {
    calls,
    ...(scan.localTypes.length > 0 ? { localTypes: scan.localTypes } : {}),
    ...(scan.returnedSpreads.length > 0 ? { returnedSpreads: scan.returnedSpreads } : {}),
    ...(returnedMembers ? { returnedMembers } : {}),
    ...(returnedFrom?.length ? { returnedFrom } : {}),
  };
}

/**
 * The returned locals of a composable whose value derives from a parameter (`FunctionInfo.derivedLocals`):
 * only refs and computeds (`kind: "value"` members) of a function with parameters.
 */
function composableLocals(fn: Node, members: FunctionInfo["returnedMembers"]): FunctionInfo["derivedLocals"] {
  const locals = members?.filter((m) => m.kind === "value" && m.local).map((m) => m.local!) ?? [];
  if (locals.length === 0 || !/\b(?:computed|ref|shallowRef)\s*\(/.test(fn.childForFieldName("body")?.text ?? "")) return undefined;
  return derivedLocalsOf(fn, locals);
}

/** A call chain off a name: `useClubApi()`, `api.clubs.list()`, `usePublicClubApi(slug).clubs`. */
const RESULT_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\([^()]*\))*$/;

/** Wrappers that leave the value as it is: parentheses, `as T`, `satisfies T`, `x!`. */
const VALUE_WRAPPERS: ReadonlySet<string> = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression"]);

/** The value under its wrappers: `{ … } as const` is the object. */
function unwrapValue(value: Node | null | undefined): Node | null {
  while (value && VALUE_WRAPPERS.has(value.type)) value = value.namedChild(0);
  return value ?? null;
}

/**
 * A returned value spelled as the linker reads an initializer (`localTypes[].from`): a call (`useClubApi()`), a
 * construction (`new ClubApi()`), a member read off a call (`usePublicClubApi(slug).clubs`) or, where `names`,
 * a local's name. Null for anything else.
 */
function resultChainText(value: Node | null, names: boolean): string | null {
  while (value && VALUE_WRAPPERS.has(value.type)) value = value.namedChild(0);
  if (!value) return null;
  if (value.type === "call_expression") {
    const chain = callChainText(value, "typescript");
    // A chain off an expression (`(await fetch(…)).json()`) names no receiver the linker can type.
    return chain && RESULT_CHAIN.test(chain) ? chain : null;
  }
  if (value.type === "new_expression") {
    const ctor = value.childForFieldName("constructor");
    return ctor && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(ctor.text) ? `new ${ctor.text}()` : null;
  }
  if (value.type === "member_expression") {
    const object = value.childForFieldName("object");
    const property = value.childForFieldName("property");
    const call = object?.type === "call_expression" ? callChainText(object, "typescript") : null;
    return call && RESULT_CHAIN.test(call) && property?.type === "property_identifier" && !value.children.some((c) => c.type === "?.") ? `${call}.${property.text}` : null;
  }
  return names && value.type === "identifier" && value.text !== "undefined" ? value.text : null;
}

/** `into` with the chain each arm of a returned value is (`FunctionInfo.returnedFrom`); null when one is none. */
function resultChains(value: Node | null, into: string[]): string[] | null {
  while (value && VALUE_WRAPPERS.has(value.type)) value = value.namedChild(0);
  if (value?.type === "ternary_expression") {
    return resultChains(value.childForFieldName("consequence"), into) && resultChains(value.childForFieldName("alternative"), into);
  }
  const chain = resultChainText(value, true);
  if (!chain) return null;
  if (!into.includes(chain)) into.push(chain);
  return into;
}

/** Whether the function enclosing `decl` returns the object literal bound to `name` as a member of what it hands back. */
function handedBack(decl: Node, name: string): boolean {
  let fn: Node | null = decl.parent;
  while (fn && !FUNCTION_EXPRESSIONS.has(fn.type) && fn.type !== "function_declaration" && fn.type !== "generator_function_declaration" && fn.type !== "method_definition") fn = fn.parent;
  return !!returnedMembersOf(fn?.childForFieldName("body") ?? null)?.some((m) => m.local === name && m.kind === "object");
}

/**
 * What the object a function returns holds, by key (`FunctionInfo.returnedMembers`): read from the body's own
 * statements — the declarations that say what each returned local is, and the one `return { … }` of an object literal.
 */
function returnedMembersOf(body: Node | null): NonNullable<FunctionInfo["returnedMembers"]> | undefined {
  if (!body) return undefined;
  const unwrap = (n: Node | null | undefined): Node | null => {
    while (n && (n.type === "parenthesized_expression" || n.type === "as_expression" || n.type === "satisfies_expression")) n = n.namedChild(0);
    return n ?? null;
  };
  const kinds = new Map<string, "function" | "object" | "value" | "open">();
  let obj: Node | null = null;
  if (body.type === "statement_block") {
    for (const stmt of body.namedChildren) {
      if (stmt.type === "function_declaration" || stmt.type === "generator_function_declaration") {
        const n = stmt.childForFieldName("name")?.text;
        if (n) kinds.set(n, "function");
      } else if (stmt.type === "lexical_declaration" || stmt.type === "variable_declaration") {
        for (const d of stmt.namedChildren) {
          const n = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
          const v = unwrap(d.childForFieldName("value"));
          if (n?.type !== "identifier") continue;
          kinds.set(
            n.text,
            v && (FUNCTION_EXPRESSIONS.has(v.type) || wrappedFunction(v)) ? "function"
              : v?.type === "object" ? (v.namedChildren.some((e) => e.type === "spread_element") ? "open" : "object")
              : "value",
          );
        }
      } else if (stmt.type === "return_statement") {
        const r = unwrap(stmt.namedChild(0));
        // `return vm.proxy.$store`: a value another object holds, which states no member of the project's.
        if (r?.type === "member_expression") return [];
        if (r?.type !== "object") return undefined;
        obj = r;
      }
    }
  } else obj = unwrap(body)?.type === "object" ? unwrap(body) : null;
  if (!obj) return undefined;
  // `{ ...useMenu(), setClub }`: a spread hands back members the literal does not list, so it states no closed set.
  if ((obj as Node).namedChildren.some((e) => e.type === "spread_element")) return undefined;
  const out: NonNullable<FunctionInfo["returnedMembers"]> = [];
  for (const e of obj.namedChildren) {
    if (e.type === "shorthand_property_identifier") out.push({ key: e.text, local: e.text, kind: kinds.get(e.text) ?? "outer" });
    else if (e.type === "method_definition") {
      const key = objectKeyName(e.childForFieldName("name"));
      if (key) out.push({ key, kind: "inline" });
    } else if (e.type === "pair") {
      const key = objectKeyName(e.childForFieldName("key"));
      const v = unwrap(e.childForFieldName("value"));
      if (!key || !v) continue;
      if (v.type === "identifier") out.push({ key, local: v.text, kind: kinds.get(v.text) ?? "outer" });
      // `signIn: auth.signIn`: another object's member, handed on.
      else if (v.type === "member_expression") out.push({ key, kind: "open" });
      else if (FUNCTION_EXPRESSIONS.has(v.type)) out.push({ key, kind: "inline" });
      else {
        // `clubs: useClubApi()`: the call the member is, for the linker to type it by.
        const from = resultChainText(v, false);
        out.push(from ? { key, kind: "value", from } : { key, kind: "value" });
      }
    }
  }
  return out;
}


/** The locals a returned object spreads: `{ ...crud, benchAll }` → `crud`. */
function spreadLocals(value: Node | null | undefined, into: string[]): void {
  while (value && (value.type === "parenthesized_expression" || value.type === "as_expression" || value.type === "satisfies_expression")) value = value.namedChildren[0];
  if (value?.type !== "object") return;
  for (const p of value.namedChildren) {
    const arg = p.type === "spread_element" ? p.namedChildren[0] : undefined;
    if (arg?.type === "identifier" && !into.includes(arg.text)) into.push(arg.text);
  }
}

/** Nested declarations a body walk never enters: they are symbols of their own. */
const SEPARATE_SCOPES: ReadonlySet<string> = new Set([
  "function_declaration", "generator_function_declaration", "class_declaration", "class",
]);

/**
 * Option keys whose value is a function the library runs for the caller
 * (TanStack Query's `queryFn` / `mutationFn`, any `…Fn` option).
 */
const FUNCTION_OPTION_KEY = /^["']?\w*Fn["']?$/;

/** A CommonJS export member, `exports.listClubs` / `module.exports.listClubs`: the member's name. */
const CJS_EXPORT_MEMBER = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/;

/**
 * One walk over a function body for what `extractCalls` does not collect:
 *
 * - Dynamic `import("./x.vue")` calls, surfaced as cross-file call edges so
 *   lazy-loaded modules — route targets and components launched via
 *   `useDialog().open({ component: import("./dlg.vue") })` — stay reachable
 *   in the call/trace graph instead of dead-ending at the loader. Launchers
 *   usually wrap the import in a callback (`new Promise((res) => …)`), which
 *   `extractCalls` skips as a nested scope, so this descends through every
 *   function expression but stops at nested function DECLARATIONS and classes
 *   (those are linked as their own units). The target resolves to the
 *   imported module's default export — for a `.vue` that's the component.
 * - A function handed to a library option it runs (`mutationFn:
 *   service.update`): a call of that function from this body, as the arrow
 *   form `mutationFn: (x) => service.update(x)` already is.
 * - The locals the function's own returned object spreads (`return { ...crud }`),
 *   never a callback's.
 * - Locals whose type the body states, so `x.method()` resolves through `x`'s
 *   type: `const x: T = …`, `/** @type {T} *\/ const x = …`, `const x = new
 *   T()`, a container lookup (`inject(T)`, `moduleRef.get(T)`,
 *   `container.get<T>(TOKEN)`, `await app.resolve(T)`), a cast (`… as T`). An
 *   annotation wins over the initializer. Scoped like `extractCalls`: through
 *   anonymous function expressions (their calls are attributed here), never
 *   into a named nested function. A name is reported only when every binding
 *   of it in that scope agrees — a second declaration of another type, an
 *   untyped one (`catch (x)`, `for (const x of …)`, a callback parameter `x`),
 *   a function parameter `x`, or a reassignment of an initializer-typed `x`
 *   leaves it out (unique-or-nothing, like the linker).
 */
function scanBody(
  body: Node | null,
  paramNames: ReadonlySet<string>,
  ctx: ScanContext,
  params: readonly ParamInfo[] = [],
): { extraCalls: CallInfo[]; localTypes: LocalType[]; returnedSpreads: string[]; returnedFrom: string[] | null } {
  const extraCalls: CallInfo[] = [];
  const returnedSpreads: string[] = [];
  // What each of the body's own `return`s hands back (`FunctionInfo.returnedFrom`); null once one is no chain.
  let returnedFrom: string[] | null = [];
  if (!body) return { extraCalls, localTypes: [], returnedSpreads, returnedFrom: null };
  // A concise arrow returns its body: `() => ({ ...crud })`.
  spreadLocals(body, returnedSpreads);
  const seenImports = new Set<string>();
  // name → every binding seen (null = a binding whose type is not stated).
  const bindings = new Map<string, Array<{ local: LocalType; annotated: boolean } | null>>();
  const reassigned = new Set<string>();
  /** Class names this body declares that are not reported: a local typed by one states no class we know. */
  const hiddenTypes = new Set<string>();
  const bindUntyped = (name: string): void => {
    const list = bindings.get(name);
    if (list) list.push(null);
    else bindings.set(name, [null]);
  };
  const bindPattern = (pattern: Node | null, skip?: ReadonlySet<string>): void => {
    if (!pattern) return;
    if (pattern.type === "identifier" || pattern.type === "shorthand_property_identifier_pattern") {
      if (!skip?.has(pattern.text)) bindUntyped(pattern.text);
      return;
    }
    for (const child of pattern.namedChildren) bindPattern(child, skip);
  };

  /**
   * `const { itemActions } = useClubData()`: each member the pattern names, as a local that came from that call
   * (`from` = `useClubData().itemActions`), kept only when the body hands the name on as an argument — what the
   * argument pass needs to find the factory behind a composable's collaborator.
   */
  const bindDestructured = (pattern: Node | null, declarator: readonly Node[]): Set<string> => {
    const bound = new Set<string>();
    if (pattern?.type !== "object_pattern") return bound;
    const eq = declarator.findIndex((c) => c.type === "=");
    let value = eq >= 0 ? declarator[eq + 1] ?? null : null;
    if (value?.type === "await_expression") value = value.namedChild(0);
    const callee = value?.type === "call_expression" ? value.childForFieldName("function") : null;
    if (!value || callee?.type !== "identifier") return bound;
    const call = callChainText(value, "typescript");
    if (!call) return bound;
    for (const p of pattern.namedChildren) {
      const local = p.type === "shorthand_property_identifier_pattern" ? p.text : p.type === "pair_pattern" && p.childForFieldName("value")?.type === "identifier" ? p.childForFieldName("value")!.text : null;
      const member = p.type === "shorthand_property_identifier_pattern" ? p.text : p.childForFieldName("key")?.text;
      if (!local || !member || !/^[\w$]+$/.test(member) || !new RegExp(`[(,]\\s*${local.replace(/\$/g, "\\$")}\\s*[,)]`).test(body.text)) continue;
      const entry = { local: { name: local, type: "", from: `${call}.${member}`, destructured: true as const }, annotated: false };
      const list = bindings.get(local);
      if (list) list.push(entry);
      else bindings.set(local, [entry]);
      bound.add(local);
    }
    return bound;
  };

  // Collections whose element type the source states (a parameter or an annotated local), by name; the
  // variables a `for … of` over one and the callbacks it hands its elements to bind are typed as the element.
  const collections = new Map<string, { element: string; map: boolean }>();
  for (const p of params) {
    const c = collectionElement(p.type);
    if (c) collections.set(p.name, c);
  }
  /** The parameters of a callback a collection hands its elements to, by function node id. */
  const callbackElements = new Map<number, { element?: string; from?: string; both: boolean }>();
  /**
   * The collection `node` reads: a name, or a chain off one that keeps its elements — or, where the source states
   * no type for it, the field or call it reads (`this.clubs`, `repo.all()`), whose DECLARED type the linker reads.
   */
  const collectionOf = (node: Node | null): { element: string; map: boolean } | { from: string } | null => {
    for (let hop = 0; node && hop < 6; hop++) {
      if (node.type === "identifier") return collections.get(node.text) ?? null;
      if (node.type === "parenthesized_expression" || node.type === "non_null_expression") {
        node = node.namedChild(0);
        continue;
      }
      if (node.type === "member_expression") {
        const from = memberChainText(node);
        return from ? { from } : null;
      }
      if (node.type !== "call_expression") return null;
      const fn = node.childForFieldName("function");
      const prop = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : undefined;
      if (!prop || !KEEPS_ELEMENTS.has(prop)) {
        const from = callChainText(node, "typescript");
        return from ? { from } : null;
      }
      node = fn!.childForFieldName("object");
    }
    return null;
  };
  const noteCallback = (call: Node): void => {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "member_expression") return;
    const prop = fn.childForFieldName("property")?.text;
    if (!prop || !ELEMENT_CALLBACKS.has(prop)) return;
    const source = collectionOf(fn.childForFieldName("object"));
    // A `Map`'s `forEach` hands the value first; its other callbacks do not exist.
    if (!source || ("map" in source && source.map && prop !== "forEach")) return;
    // A source read by its declaration has no map flag: a map-typed one yields no element, so nothing is typed.
    if ("from" in source && prop !== "forEach" && prop !== "map" && !ELEMENT_CALLBACKS.has(prop)) return;
    const first = call.childForFieldName("arguments")?.namedChildren[0];
    if (first && FUNCTION_EXPRESSIONS.has(first.type)) callbackElements.set(first.id, { ..."from" in source ? { from: source.from } : { element: source.element }, both: prop === "sort" || prop === "toSorted" });
  };
  /** The element a `for (… of <iterable>)` yields, with where it lands: the whole binding, or the value of an entry. */
  const loopElement = (right: Node | null): { element: string; entry: boolean } | { from: string; awaited: boolean } | null => {
    let node = right;
    while (node?.type === "parenthesized_expression") node = node.namedChild(0);
    const awaited = node?.type === "await_expression";
    if (awaited) node = node!.namedChild(0);
    if (node?.type === "identifier") {
      const c = collections.get(node.text);
      return c ? { element: c.element, entry: c.map } : null;
    }
    if (node?.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const method = fn?.type === "member_expression" ? fn.childForFieldName("property")?.text : undefined;
      const object = fn?.type === "member_expression" ? fn.childForFieldName("object") : null;
      if (object?.type === "identifier" && collections.get(object.text)?.map) {
        const c = collections.get(object.text)!;
        if (method === "values") return { element: c.element, entry: false };
        if (method === "entries") return { element: c.element, entry: true };
        return null;
      }
      const kept = collectionOf(node);
      if (kept && "from" in kept) return { from: kept.from, awaited };
      return kept && !kept.map ? { element: kept.element, entry: false } : null;
    }
    if (node?.type === "member_expression" && !awaited) {
      const from = memberChainText(node);
      return from ? { from, awaited: false } : null;
    }
    return null;
  };
  const bindFrom = (name: string, from: string, awaited = false): void => {
    const entry = { local: { name, type: "", from, element: true as const, ...(awaited ? { awaited: true as const } : {}) }, annotated: false };
    const list = bindings.get(name);
    if (list) list.push(entry);
    else bindings.set(name, [entry]);
  };
  const bindTyped = (name: string, element: string): void => {
    const entry = { local: { name, type: element }, annotated: true };
    const list = bindings.get(name);
    if (list) list.push(entry);
    else bindings.set(name, [entry]);
  };

  // Children are read once per node (each read crosses into WASM) and the
  // parent's type is passed down rather than asked for.
  // `ownBody`: outside every function expression, where a `return` is the function's own.
  const walk = (node: Node, isRoot: boolean, inScope: boolean, parentType: string, ownBody: boolean): void => {
    const type = node.type;
    if (!isRoot && SEPARATE_SCOPES.has(type)) {
      // A class this body declares is its own: an instance's type is that class, never a namesake elsewhere.
      if (type === "class_declaration" && inScope) {
        const declared = node.childForFieldName("name")?.text;
        if (declared && ctx.localClasses.get(declared) === false) hiddenTypes.add(declared);
      }
      return;
    }
    const children = node.children;
    if (ownBody && type === "return_statement") {
      spreadLocals(node.namedChildren[0], returnedSpreads);
      if (returnedFrom) returnedFrom = resultChains(node.namedChildren.find((c) => c.type !== "comment") ?? null, returnedFrom);
    }

    // `useMutation({ mutationFn: service.update })`: the library calls the
    // function it is handed, on this body's behalf — a call of it here.
    if (type === "pair" && children[0] && FUNCTION_OPTION_KEY.test(children[0].text)) {
      const value = children[children.length - 1];
      if (value && (value.type === "identifier" || value.type === "member_expression") && !value.text.includes("(")) {
        extraCalls.push({ name: value.text.replace(/\s+/g, ""), kind: "internal", target: null, line: value.startPosition.row + 1 });
      }
    }

    if (inScope && type === "call_expression") noteCallback(node);

    // A module loaded for its default export: a lazy loader (`() => import("./ClubPage.vue")`, a route's
    // component) or `(await import("./auth")).default`. Other uses (`const { f } = await import()`, `.then`, a
    // member call) are import facts or the member call below.
    if (type === "call_expression" && children[0]?.type === "import") {
      const source = loadedDefaultSource(node);
      if (source && /^[./@~]/.test(source) && !seenImports.has(source)) {
        seenImports.add(source);
        extraCalls.push({ name: "default", kind: "cross-file", target: source, line: node.startPosition.row + 1, confidence: "EXTRACTED" });
      }
    }

    // `(await import("./rules")).promote()` / `require("./rules").promote()`: a call of the module's member, at its
    // path. (The import itself binds nothing here; `const { f } = await import()` is an import fact.)
    if (type === "call_expression") {
      const loaded = loadedMemberCall(node);
      if (loaded && /^[./@~]/.test(loaded.source) && !seenImports.has(`${loaded.source}\0${loaded.name}`)) {
        seenImports.add(`${loaded.source}\0${loaded.name}`);
        extraCalls.push({ name: loaded.name, kind: "cross-file", target: loaded.source, line: node.startPosition.row + 1, column: node.startPosition.column, confidence: "EXTRACTED" });
      }
    }

    let childScope = inScope;
    if (inScope && !isRoot) {
      if (FUNCTION_EXPRESSIONS.has(type)) {
        if (parentType === "variable_declarator") {
          // A named function expression is its own symbol: its locals are not ours.
          childScope = false;
        } else {
          // An inline callback's parameters shadow our locals inside it — typed, when a collection hands it its elements.
          const handed = callbackElements.get(node.id);
          const list = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
          const names = handed && list ? (list.type === "identifier" ? [list] : list.namedChildren.map((p) => p.childForFieldName("pattern") ?? p)) : [];
          names.forEach((p, i) => {
            if (handed && p.type === "identifier" && (i === 0 || (i === 1 && handed.both))) {
              if (handed.from) bindFrom(p.text, handed.from);
              else bindTyped(p.text, handed.element!);
            } else bindPattern(p);
          });
          if (!handed || !list) bindPattern(list);
        }
      } else if (type === "method_definition") {
        bindPattern(node.childForFieldName("parameters"));
      } else if (type === "variable_declarator") {
        const name = children[0];
        if (name?.type === "identifier") {
          const annotation = children.find((c) => c.type === "type_annotation");
          const stated = annotation ? collectionElement(annotation.text.replace(/^:\s*/, "")) : null;
          if (stated) collections.set(name.text, stated);
          // A conditional initializer binds the name once per arm (`slug ? publicApi() : userApi()`).
          const locals = conditionalLocals(children, name.text) ?? [declaredLocal(node, children, name.text, ctx)];
          const list = bindings.get(name.text);
          if (list) list.push(...locals);
          else bindings.set(name.text, locals);
        } else {
          bindPattern(name ?? null, bindDestructured(name ?? null, children));
        }
      } else if (type === "catch_clause") {
        bindPattern(node.childForFieldName("parameter"));
      } else if (type === "for_in_statement") {
        const left = node.childForFieldName("left");
        const over = node.childForFieldName("operator")?.text === "of" ? loopElement(node.childForFieldName("right")) : null;
        if (over && "from" in over) {
          if (left?.type === "identifier") bindFrom(left.text, over.from, over.awaited);
          else bindPattern(left);
        } else if (over && left?.type === "identifier" && !over.entry) bindTyped(left.text, over.element);
        // `for (const [id, club] of clubsById)`: the value is the element, the key states nothing.
        else if (over?.entry && left?.type === "array_pattern") {
          left.namedChildren.forEach((p, i) => {
            if (i === 1 && p.type === "identifier") bindTyped(p.text, over.element);
            else bindPattern(p);
          });
        } else bindPattern(left);
      } else if (type === "assignment_expression") {
        const left = children[0];
        if (left?.type === "identifier") reassigned.add(left.text);
      }
    }

    const childOwn = ownBody && (isRoot || !FUNCTION_EXPRESSIONS.has(type));
    for (const child of children) walk(child, false, childScope, type, childOwn);
  };
  walk(body, true, true, "", true);

  const localTypes: LocalType[] = [];
  for (const [name, list] of bindings) {
    if (paramNames.has(name)) continue;
    const first = list[0];
    if (!first || list.some((b) => !b)) continue;
    if (reassigned.has(name) && !list.every((b) => b!.annotated)) continue;
    // Initialized by calls that state no type: one entry per distinct call, so
    // the linker can require them to agree. A stated type alongside decides nothing.
    if (list.some((b) => b!.local.from)) {
      if (!list.every((b) => b!.local.from)) continue;
      const seen = new Set<string>();
      for (const b of list) {
        const id = `${b!.local.from}|${b!.local.awaited}|${b!.local.element}`;
        if (!seen.has(id)) (seen.add(id), localTypes.push(b!.local));
      }
      continue;
    }
    if (list.some((b) => b!.local.type !== first.local.type || b!.local.qualifier !== first.local.qualifier)) continue;
    if (hiddenTypes.has(first.local.type)) continue;
    localTypes.push(first.local);
  }
  return { extraCalls, localTypes, returnedSpreads, returnedFrom };
}

/**
 * The type one `variable_declarator` states for its name: the TypeScript
 * annotation, else a JSDoc `@type` on the declaration, else what the
 * initializer constructs / looks up / casts to — with the token a lookup
 * named either way (`const m: IMailer = container.get(TYPES.Mailer)`).
 */
function declaredLocal(
  declarator: Node,
  children: readonly Node[],
  name: string,
  ctx: ScanContext,
): { local: LocalType; annotated: boolean } | null {
  // `name [: type] [= value]` — read off the children already in hand.
  let annotation: string | null = null;
  let value: Node | null = null;
  for (let i = 1; i < children.length; i++) {
    const c = children[i]!;
    if (c.type === "type_annotation") annotation = typeParameterBound(declarator, c.text.replace(/^:\s*/, ""));
    else if (c.type === "=") value = children[i + 1] ?? null;
  }
  if (!annotation && ctx.jsdoc && declarator.parent) {
    const doc = precedingJsDoc(declarator.parent);
    annotation = doc ? jsDocTypeTag(doc) : null;
  }
  const init = value ? initializerType(value, ctx.tokenTypes) : null;
  let type = annotation ?? init?.type ?? "";
  const qualifier = init?.qualifier && !(annotation && restatesType(init.qualifier, annotation)) ? init.qualifier : undefined;
  // `const seen = new Set()`, `const out: Order[] = []` say nothing about a
  // receiver's members — not reported (a lookup's token still is).
  if (type && !namesReceiverType(type)) type = "";
  if (!type && !qualifier) {
    // `const api = useUserApi()`, `const u = await repo.find(id)`: the call is
    // kept, and the linker types the local by what that call is declared to return.
    if (annotation || !value) return null;
    return initializerLocal(value, name);
  }
  return { local: qualifier ? { name, type, qualifier } : { name, type }, annotated: annotation !== null };
}

/**
 * `this.clubs`, `this.repo.clubs`, `repo.clubs`: a member read off `this` or a name, spelled as the linker's receiver
 * chains are. Null for anything with a call, an index or an optional step in it.
 */
function memberChainText(node: Node): string | null {
  const parts: string[] = [];
  let cur: Node | null = node;
  while (cur?.type === "member_expression") {
    const property = cur.childForFieldName("property");
    if (property?.type !== "property_identifier" || cur.children.some((c) => c.type === "?.")) return null;
    parts.unshift(property.text);
    cur = cur.childForFieldName("object");
  }
  if (cur?.type !== "this" && cur?.type !== "identifier") return null;
  parts.unshift(cur.text);
  return parts.length >= 2 ? parts.join(".") : null;
}

/**
 * A local initialized by a call that states no type, kept as that call for the
 * linker to type by what it is declared to return: `useUserApi()`, `await
 * repo.find(id)`, or a member read off a call's result
 * (`usePublicApi(slug).explore`).
 */
function initializerLocal(value: Node, name: string): { local: LocalType; annotated: boolean } | null {
  const awaited = value.type === "await_expression";
  const expr = awaited ? value.namedChild(0) : value;
  let from: string | null = null;
  if (expr?.type === "call_expression") from = callChainText(expr, "typescript");
  else if (expr?.type === "member_expression" && !awaited) {
    const object = expr.childForFieldName("object");
    const property = expr.childForFieldName("property");
    const call = object?.type === "call_expression" ? callChainText(object, "typescript") : null;
    if (call && property?.type === "property_identifier") from = `${call}.${property.text}`;
  }
  if (!from) return null;
  return { local: awaited ? { name, type: "", from, awaited } : { name, type: "", from }, annotated: false };
}

/**
 * `const api = slug ? usePublicApi(slug).explore : useUserApi()`: one local per
 * arm, each the call it is initialized from — the linker types the name only
 * when the arms agree. Null for any other initializer (or an annotated one).
 */
function conditionalLocals(children: readonly Node[], name: string): Array<{ local: LocalType; annotated: boolean } | null> | null {
  let value: Node | null = null;
  for (let i = 1; i < children.length; i++) {
    if (children[i]!.type === "type_annotation") return null;
    if (children[i]!.type === "=") value = children[i + 1] ?? null;
  }
  while (value?.type === "parenthesized_expression") value = value.namedChild(0);
  if (value?.type !== "ternary_expression") return null;
  const arms = [value.childForFieldName("consequence"), value.childForFieldName("alternative")];
  return arms.map((arm) => {
    let a = arm;
    while (a?.type === "parenthesized_expression") a = a.namedChild(0);
    return a ? initializerLocal(a, name) : null;
  });
}

/**
 * Module-scope locals (`const api = useUserApi()` at the top of a module or a
 * Vue `<script setup>`), for the file's `<setup>` — what every function in the
 * file sees when its own scope does not bind the name.
 */
export function topLevelLocalTypes(tree: Tree, sourceText: string): LocalType[] {
  const ctx: ScanContext = { jsdoc: JSDOC_TAG_RE.test(sourceText), tokenTypes: collectInjectionTokenTypes(tree.rootNode, sourceText), dispatchProps: new Map(), dispatchMappers: new Set(), moduleStrings: new Map(), localClasses: new Map() };
  const locals = scanBody(tree.rootNode, new Set(), ctx).localTypes;
  return sourceText.includes("new ") ? [...locals, ...objectPathTypes(tree.rootNode)] : locals;
}

/**
 * The instances a module-level object holds, by their path — an API client
 * grouped by area and returned by a factory in the same module:
 *
 *   function createLeagueClient(http) {
 *     return { content: { clubs: new ClubsApi(undefined, base, http) } };
 *   }
 *   const leagueClient = createLeagueClient(axios);   // leagueClient.content.clubs: ClubsApi
 *
 * (also a plain `const leagueClient = { … }`), so a call on
 * `leagueClient.content.clubs` states its receiver's type.
 */
function objectPathTypes(root: Node): LocalType[] {
  const declOf = (st: Node): Node => (st.type === "export_statement" ? st.namedChildren.find((c) => c.type !== "comment") ?? st : st);
  const objectOf = (n: Node | null): Node | null => {
    if (!n) return null;
    if (n.type === "object") return n;
    if (n.type === "parenthesized_expression") return objectOf(n.namedChild(0));
    if (n.type === "statement_block") {
      const ret = n.namedChildren.filter((c) => c.type === "return_statement");
      return ret.length === 1 ? objectOf(ret[0]!.namedChild(0)) : null;
    }
    return null;
  };
  const factories = new Map<string, Node>();
  const values: Array<{ name: string; value: Node }> = [];
  for (const st of root.namedChildren) {
    const decl = declOf(st);
    if (decl.type === "function_declaration") {
      const name = decl.childForFieldName("name")?.text;
      const obj = objectOf(decl.childForFieldName("body"));
      if (name && obj) factories.set(name, obj);
    } else if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
      for (const d of decl.namedChildren) {
        if (d.type !== "variable_declarator") continue;
        const name = d.childForFieldName("name");
        const value = d.childForFieldName("value");
        if (name?.type !== "identifier" || !value) continue;
        if (value.type === "arrow_function" || value.type === "function_expression") {
          const obj = objectOf(value.childForFieldName("body"));
          if (obj) factories.set(name.text, obj);
        } else values.push({ name: name.text, value });
      }
    }
  }
  const out: LocalType[] = [];
  const collect = (prefix: string, obj: Node, depth: number): void => {
    for (const pair of obj.namedChildren) {
      if (pair.type !== "pair") continue;
      const key = pair.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
      const value = pair.childForFieldName("value");
      if (!key || !/^[A-Za-z_$][\w$]*$/.test(key) || !value) continue;
      if (value.type === "new_expression") {
        const type = value.childForFieldName("constructor")?.text;
        if (type && /^[A-Z][\w$]*(?:\.[A-Z][\w$]*)*$/.test(type)) out.push({ name: `${prefix}.${key}`, type });
      } else if (value.type === "object" && depth < 4) collect(`${prefix}.${key}`, value, depth + 1);
    }
  };
  for (const { name, value } of values) {
    const call = value.type === "call_expression" ? value.childForFieldName("function") : null;
    const obj = value.type === "object" ? value : call?.type === "identifier" ? factories.get(call.text) : undefined;
    if (obj) collect(name, obj, 1);
  }
  return out;
}

/**
 * If a function's return value is an app-relative request URL built from string
 * concatenation / a template literal, derive its parameterized template(s):
 * path literals verbatim, each parameter referenced in the URL as `{paramName}`,
 * a base that is not part of the path — an environment read (`import.meta.env
 * .VITE_X` / `process.env.Y`), a runtime config read (`store.state.config
 * .API_URL`) or a literal origin (`http://localhost`) — dropped, and any other
 * runtime reference (a closure/local variable) as `{}`. Empty for non-URL
 * functions (a result must contain a `/`).
 *
 * Real Vue/React data layers funnel every request through such a helper
 * (`requestUri(endpoint, version)`, `adminUri(subPath)`), so without resolving
 * it the api-call carries no joinable URL. A project-level pass substitutes a
 * call site's literal args into these templates.
 *
 * One template per DISTINCT branch, in source order: the helper's `return`
 * statements, including those nested in `if`/`else` (a mock-vs-real switch on
 * an env flag), and both arms of a returned ternary (`isEmployee ? base +
 * "/api/staff/" + p : base + "/api/" + p`). Branches that only differ in
 * a dropped base collapse to one template, so the common mock switch yields a
 * single template while a genuine role switch yields two. A one-hop local
 * (`const x = <url>; return x`) is followed; deeper flow is not.
 */
/** A method named for the URL it gives (`getCollectionResource`, `apiPath`, `endpointUrl`). */
const RESOURCE_METHOD = /(?:Resource|Url|Uri|Path|Endpoint|Route)$/i;

/** A parameter named for the URL or path a helper is handed. */
const URL_PARAM = /^(?:url|uri|path|pathname|route|endpoint|resource)$/i;

/** The path segment a body only returns: `{ return "albums"; }` → `albums`. */
function returnedSegment(body: Node | null): string | null {
  const stmts = body?.type === "statement_block" ? body.namedChildren.filter((c) => c.type !== "comment") : [];
  const value = stmts.length === 1 && stmts[0]!.type === "return_statement" ? stmts[0]!.namedChild(0) : null;
  const text = value?.type === "string" ? value.text.slice(1, -1) : null;
  return text && /^[a-z][\w-]*(?:\/[\w-]+)*$/.test(text) ? text : null;
}

export function extractUrlTemplates(
  body: Node | null,
  paramNames: ReadonlySet<string>,
  /**
   * Receives the leading expression a template starts with (`this.baseUrl()` in `${this.baseUrl()}/x`), when it is one;
   * the key of the request descriptor whose URL the templates are (`property`); and the table an indexing helper
   * hands back an entry of (`entryOf`).
   */
  out?: UrlTemplateFound,
): string[] {
  if (!body) return [];

  const locals: Locals = { values: new Map(), appends: new Map(), reassigns: new Map(), unset: new Set(), assigned: new Map() };
  let returns: Node[] = [];
  if (body.type === "statement_block") {
    collectReturns(body.namedChildren, locals, returns, 0, null, paramNames);
  } else {
    returns.push(body);
  }
  if (returns.length === 0) return [];
  // `(page) => endPoints[page]`: an entry of a table, chosen by the argument.
  const entry = returns.length === 1 ? tableEntry(returns[0]!, paramNames) : null;
  if (entry) {
    if (out) out.entryOf = entry;
    return [];
  }
  // `(id) => ({ url: `/messages/${id}`, params })`: a request descriptor — its URL is the key a call reads.
  const descriptors = returns.map((r) => descriptorUrl(r));
  if (descriptors.every((d) => d !== null) && new Set(descriptors.map((d) => d!.key)).size === 1) {
    returns = descriptors.map((d) => d!.value);
    if (out) out.property = descriptors[0]!.key;
  }

  const scope = new Map<string, ValueExpr>();
  for (const [name, valueNode] of locals.values) {
    scope.set(name, astToValueExpr(valueNode));
  }
  // Fields (`this.baseUrl`) and module names (`prefix`) stay `${…}` holes: a
  // project pass resolves them where the helper is CALLED — `this` is the
  // caller's instance, so an inherited `getResourceUrl()` builds each
  // subclass's own URL.
  const fold = (expr: ValueExpr, within: ReadonlyMap<string, ValueExpr> = scope) =>
    foldValue(expr, within, {
      params: paramNames,
      envMode: "collapse",
      opaqueCall: "template",
      unknownRef: "template",
      keepHole: resolvableHole,
    }).text;
  const templates: string[] = [];
  // `bareMember`: a variant that is only a field of `this` (`let url = this.apiVersion`
  // with no guard taken) is a URL the field holds, kept beside its siblings.
  const push = (text: string | null, bareMember = false): boolean => {
    if (text == null) return false;
    // `(await apiOrigin()) + path`: a runtime origin before the path the caller hands in — that path
    // is the URL, when the parameter is named for one (a query appended to it changes no path).
    const handed = /^\{\}\{([A-Za-z_$][\w$]*)\}(?:\?.*)?$/.exec(text)?.[1];
    const pathOnly = !!handed && paramNames.has(handed) && URL_PARAM.test(handed);
    const tpl = pathOnly ? `{${handed}}` : stripUrlBase(text);
    // A parameter extended by a path piece (`{apiRoute}series`): the caller's argument completes it.
    const ok = tpl.includes("/") || pathOnly || (bareMember && /^\$\{this\.[\w$]+\}$/.test(tpl)) || /^\{[A-Za-z_$][\w$]*\}[\w.-]+$/.test(tpl) ||
      // A helper handing back another of its class's URL methods (`${this.getResourceUrl({id}, 'download')}`).
      /^\$\{this\.[\w$]+\([^{}]*(?:\{[\w$]+\}[^{}]*)*\)\}$/.test(tpl);
    if (ok && !templates.includes(tpl)) templates.push(tpl);
    return templates.length >= MAX_URL_TEMPLATES;
  };
  for (const raw of returns) {
    // `return url.toString()` / `url.href` with `let url = new URL(this.getResourceUrl(id, 'download'))`:
    // the URL object's path argument (query parameters appended to it change no path).
    const urlArg = urlObjectArgument(raw, locals);
    const ret = urlArg ?? raw;
    // The URL object's path is another URL method of the class (`new URL(this.getResourceUrl(id, 'download'))`):
    // that call, the helper's parameters as placeholders, resolved per class where it is called.
    const delegated = urlArg ? thisMethodCall(urlArg, paramNames) : null;
    if (delegated) {
      if (push(delegated)) return templates;
      continue;
    }
    if (out && !out.base) out.base = leadingBaseText(ret.type === "identifier" ? locals.values.get(ret.text) ?? ret : ret);
    // `let url = this.apiVersion; if (enterprise) url = `/enterprise${url}`; if (scoped) url = `${url}/accounts/${id}`; return url`
    // — one template per combination of the guarded reassignments, fewest first.
    const reassigned = ret.type === "identifier" ? locals.reassigns.get(ret.text) : undefined;
    const start = ret.type === "identifier" ? locals.values.get(ret.text) : undefined;
    if (reassigned && start) {
      const guards = [...new Set(reassigned.map((r) => r.guard).filter((g): g is string => g !== null))].slice(0, 3);
      const subsets: Set<string>[] = [];
      for (let mask = 0; mask < 1 << guards.length; mask++) subsets.push(new Set(guards.filter((_, i) => mask & (1 << i))));
      subsets.sort((a, b) => a.size - b.size);
      for (const on of subsets) {
        let cur = astToValueExpr(start);
        for (const r of reassigned) if (r.guard === null || on.has(r.guard)) cur = replaceRef(astToValueExpr(r.expr), ret.text, cur);
        if (push(fold(cur), true)) return templates;
      }
      continue;
    }
    // `let url = base; if (id) url += `${id}/`; return url` — one template per
    // combination of the guarded appends, fewest first.
    const appended = ret.type === "identifier" ? locals.appends.get(ret.text) : undefined;
    const base = ret.type === "identifier" ? locals.values.get(ret.text) : undefined;
    if (appended && base) {
      for (const variant of appendVariants(appended)) {
        const expr: ValueExpr = { kind: "concat", parts: [astToValueExpr(base), ...variant.map((a) => astToValueExpr(a))] };
        if (push(fold(expr))) return templates;
      }
      continue;
    }
    // `let endpoint; if (home) endpoint = `/badges/${id}/home`; else endpoint = …; return `${endpoint}?kit=1``
    // — one template per value the local is given (each arm of a ternary one).
    const branchLocal = locals.assigned.size > 0 ? [...locals.assigned.keys()].find((n) => new RegExp(`(?<![\\w$.])${escapeRegex(n)}(?![\\w$])`).test(ret.text)) : undefined;
    for (const arm of ternaryArms(ret, 0)) {
      const branch = decoratedPath(arm) ?? arm;
      if (!branchLocal) {
        if (push(fold(astToValueExpr(branch)))) return templates;
        continue;
      }
      for (const value of locals.assigned.get(branchLocal)!.flatMap((v) => ternaryArms(v, 0))) {
        const within = new Map(scope);
        within.set(branchLocal, astToValueExpr(value));
        if (push(fold(astToValueExpr(branch), within))) return templates;
      }
    }
  }
  return templates;
}

/** What {@link extractUrlTemplates} found besides the templates themselves. */
export interface UrlTemplateFound {
  base?: string | null;
  property?: string;
  entryOf?: { table: string; param: string };
}

/** The keys a request descriptor states its URL under. */
const DESCRIPTOR_URL_KEY = /^(?:url|uri|path|endpoint)$/;

/** `({ url: `/messages/${id}`, data })`: the descriptor's URL key and value; null for any other expression. */
function descriptorUrl(expr: Node): { key: string; value: Node } | null {
  let n: Node | null = expr;
  while (n?.type === "parenthesized_expression") n = n.namedChild(0);
  if (n?.type !== "object") return null;
  for (const pair of n.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key")?.text.replace(/^['"]|['"]$/g, "");
    const value = pair.childForFieldName("value");
    if (key && DESCRIPTOR_URL_KEY.test(key) && value && /^(?:string|template_string|binary_expression)$/.test(value.type)) return { key, value };
  }
  return null;
}

/** `endPoints[page]` with `page` a parameter: the table and that parameter; null for any other expression. */
export function tableEntry(expr: Node, params: ReadonlySet<string>): { table: string; param: string } | null {
  let n: Node | null = expr;
  while (n?.type === "parenthesized_expression") n = n.namedChild(0);
  if (n?.type !== "subscript_expression") return null;
  const table = n.childForFieldName("object");
  const index = n.childForFieldName("index");
  return table?.type === "identifier" && index?.type === "identifier" && params.has(index.text) ? { table: table.text, param: index.text } : null;
}

/** The URL fields of a function record, for what {@link extractUrlTemplates} found. */
function urlTemplateRecord(
  templates: string[],
  found: UrlTemplateFound,
): Pick<FunctionInfo, "urlTemplate" | "urlTemplateAlternatives" | "urlTemplateBase" | "requestDescriptor" | "returnsEntryOf"> {
  if (found.entryOf) return { returnsEntryOf: found.entryOf };
  // A descriptor's URL is not the function's value: kept apart, so only a read of its key takes it.
  if (found.property) return templates.length > 0 ? { requestDescriptor: { key: found.property, urlTemplates: templates } } : {};
  return {
    ...urlTemplateFields(templates),
    ...(templates.length > 0 && found.base ? { urlTemplateBase: found.base } : {}),
  };
}

/** `this.getResourceUrl(id, 'download')` as a template: `${this.getResourceUrl({id}, 'download')}`; null for any other expression. */
function thisMethodCall(node: Node, params: ReadonlySet<string>): string | null {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression" || fn.childForFieldName("object")?.type !== "this") return null;
  const args = node.childForFieldName("arguments")?.namedChildren ?? [];
  const texts: string[] = [];
  for (const a of args) {
    if (a.type === "identifier" && params.has(a.text)) texts.push(`{${a.text}}`);
    else if (a.type === "string" || a.type === "number" || a.type === "null" || a.type === "true" || a.type === "false") texts.push(a.text);
    else return null;
  }
  return `\${this.${fn.childForFieldName("property")!.text}(${texts.join(", ")})}`;
}

/** The path argument of the `URL` object a return reads: `url.toString()`, `url.href`, `String(url)` with `url = new URL(path)`. */
function urlObjectArgument(ret: Node, locals: Locals): Node | null {
  let name: Node | null = null;
  if (ret.type === "call_expression") {
    const fn = ret.childForFieldName("function");
    if (fn?.type === "member_expression" && fn.childForFieldName("property")?.text === "toString") name = fn.childForFieldName("object");
    else if (fn?.text === "String") name = ret.childForFieldName("arguments")?.namedChildren[0] ?? null;
  } else if (ret.type === "member_expression" && ret.childForFieldName("property")?.text === "href") name = ret.childForFieldName("object");
  if (name?.type !== "identifier") return null;
  const value = locals.values.get(name.text);
  if (value?.type !== "new_expression" || value.childForFieldName("constructor")?.text !== "URL") return null;
  return value.childForFieldName("arguments")?.namedChildren[0] ?? null;
}

/** Calls that make a request rather than decorate a path. */
const REQUEST_CALLEE = /^(?:fetch|request|get|post|put|patch|delete|head|axios|ajax|send|open)$/i;

/**
 * The path a returned call decorates: `createUrl(`/assets/${id}/thumbnail`, params)`
 * (a project helper adding the base and query string) gives that first
 * argument, when it is a `/`-led literal or template; a request call does not.
 */
function decoratedPath(expr: Node): Node | null {
  if (expr.type !== "call_expression") return null;
  const fn = expr.childForFieldName("function");
  if (fn?.type !== "identifier" || REQUEST_CALLEE.test(fn.text)) return null;
  const first = expr.childForFieldName("arguments")?.namedChildren[0];
  if (first?.type !== "string" && first?.type !== "template_string") return null;
  return /^['"`]\//.test(first.text) ? first : null;
}

/** `x` in `ref(x)` replaced by `by` throughout a value expression. */
function replaceRef(expr: ValueExpr, name: string, by: ValueExpr): ValueExpr {
  if (expr.kind === "ref" && expr.name === name) return by;
  if (expr.kind === "concat" || expr.kind === "template" || expr.kind === "coalesce") return { ...expr, parts: expr.parts.map((p) => replaceRef(p, name, by)) };
  return expr;
}

/**
 * The expression a URL starts with when it is a call or member the folding
 * turns into an anonymous base: `this.baseUrl()` in `` `${this.baseUrl()}/${x}` ``
 * or `this.baseUrl() + "/x"`. Recorded so a caller substituting the template
 * whole (a getter read as `this.url`) can put the base back and resolve it.
 */
function leadingBaseText(node: Node): string | null {
  if (node.type === "template_string") {
    const first = node.namedChildren[0];
    if (first?.type === "template_substitution" && first.startIndex === node.startIndex + 1) {
      const inner = awaitedCall(first.namedChild(0));
      return inner ? inner.text : null;
    }
    return null;
  }
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    const left = node.childForFieldName("left") ?? node;
    return leadingBaseText(left) ?? awaitedCall(left)?.text ?? null;
  }
  return null;
}

/** A call, also parenthesized or awaited (`(await apiOrigin())`); null for anything else. */
function awaitedCall(node: Node | null): Node | null {
  let n = node;
  while (n?.type === "parenthesized_expression" || n?.type === "await_expression") n = n.namedChild(0);
  return n?.type === "call_expression" ? n : null;
}

/**
 * A hole a later pass could fill: one field of `this` (`this.baseUrl`), or a
 * name with at most two members that is no browser global (`config.PREFIX`).
 * A call (`useStore().id`), a deeper chain (`store.state.config.API`) or
 * `window.location.origin` cannot be, and stays a `{}`.
 */
function resolvableHole(text: string): boolean {
  const t = text.replace(/\s+/g, "");
  if (/^this\.[A-Za-z_$][\w$]*$/.test(t)) return true;
  // Module values are keyed at most `name.a.b`; a deeper chain is runtime state (`store.state.config.API`).
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,2}$/.test(t)) return false;
  return !/^(?:this|window|document|location|globalThis|self|navigator|process|import)\b/.test(t);
}

interface Locals {
  values: Map<string, Node>;
  /** `url += …` appends per local, each with the parameter whose truthiness guards it (`?` = some other condition). */
  appends: Map<string, Array<{ guard: string | null; expr: Node }>>;
  /** `url = `/enterprise${url}`` — reassignments that read the local's previous value, in order, each with its guard. */
  reassigns: Map<string, Array<{ guard: string | null; expr: Node }>>;
  /** Locals declared with no value (`let endpoint: string`). */
  unset: Set<string>;
  /** The values such a local is given (`endpoint = `/x/${id}``), one per assignment, whatever guards it. */
  assigned: Map<string, Node[]>;
}

/** The guard of a `switch` arm: `switch@<start>#<arm>`; arms of one switch exclude each other. */
const SWITCH_ARM = /^switch@(\d+)#\d+$/;

/**
 * The appended expressions of every combination of guards, unconditional appends always in, fewest guards first.
 * The arms of one `switch` are one choice: at most one of them is on (`switch (kind) { case A: url += 'a'; … }`
 * gives one variant per arm, never two arms appended together).
 */
function appendVariants(appends: ReadonlyArray<{ guard: string | null; expr: Node }>): Node[][] {
  const all = [...new Set(appends.map((a) => a.guard).filter((g): g is string => g !== null))];
  const guards = all.filter((g) => !SWITCH_ARM.test(g)).slice(0, 3);
  const switches = new Map<string, string[]>();
  for (const g of all) {
    const m = SWITCH_ARM.exec(g);
    if (m) (switches.get(m[1]!) ?? switches.set(m[1]!, []).get(m[1]!)!).push(g);
  }
  let subsets: Set<string>[] = [];
  for (let mask = 0; mask < 1 << guards.length; mask++) {
    subsets.push(new Set(guards.filter((_, i) => mask & (1 << i))));
  }
  for (const arms of [...switches.values()].slice(0, 2)) {
    subsets = subsets.flatMap((on) => [on, ...arms.map((arm) => new Set([...on, arm]))]);
  }
  subsets.sort((a, b) => a.size - b.size);
  return subsets.map((on) => appends.filter((a) => a.guard === null || on.has(a.guard)).map((a) => a.expr));
}

/** The parameter a condition tests: `id`, `id !== null`, `id != undefined`, `!!id`; else `?`. */
function guardParam(cond: Node, params: ReadonlySet<string>): string {
  let c: Node | null = cond;
  while (c?.type === "parenthesized_expression") c = c.namedChild(0);
  if (!c) return "?";
  const text = c.text.replace(/\s+/g, "");
  const m = /^(?:!!)?([A-Za-z_$][\w$]*)(?:!==?(?:null|undefined))?$/.exec(text) ?? /^(?:null|undefined)!==?([A-Za-z_$][\w$]*)$/.exec(text);
  return m && params.has(m[1]!) ? m[1]! : "?";
}

/** The first (primary) URL template of a function body; see {@link extractUrlTemplates}. */
export function extractUrlTemplate(
  body: Node | null,
  paramNames: ReadonlySet<string>,
): string | undefined {
  return extractUrlTemplates(body, paramNames)[0];
}

const MAX_URL_TEMPLATES = 6;
const MAX_RETURN_DEPTH = 4;

/**
 * Every `return <expr>` reachable in a statement list through `if`/`else`
 * nesting, in source order, plus the variable bindings seen on the way. Loops,
 * `try` and `switch` are not entered: a URL assembled inside one is not a
 * branch of the helper but a computation this pass does not model.
 */
function collectReturns(
  stmts: readonly Node[],
  locals: Locals,
  out: Node[],
  depth: number,
  guard: string | null,
  params: ReadonlySet<string>,
): void {
  if (depth > MAX_RETURN_DEPTH) return;
  for (const stmt of stmts) {
    if (stmt.type === "lexical_declaration" || stmt.type === "variable_declaration") {
      for (const decl of stmt.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const nm = decl.childForFieldName("name");
        const val = decl.childForFieldName("value");
        if (nm?.type === "identifier" && val && !locals.values.has(nm.text)) locals.values.set(nm.text, val);
        else if (nm?.type === "identifier" && !val) locals.unset.add(nm.text);
      }
    } else if (stmt.type === "expression_statement") {
      // `url += `${id}/`` — appended under whatever guards this statement.
      const e = stmt.namedChild(0);
      if (e?.type === "assignment_expression") {
        const left = e.childForFieldName("left");
        const right = e.childForFieldName("right");
        // A reassignment that reads the local's own value builds on it (`url = `${url}/accounts/${id}``).
        if (left?.type === "identifier" && right && locals.values.has(left.text) && new RegExp(`\\b${left.text}\\b`).test(right.text)) {
          const list = locals.reassigns.get(left.text) ?? [];
          list.push({ guard, expr: right });
          locals.reassigns.set(left.text, list);
        } else if (left?.type === "identifier" && right && locals.unset.has(left.text)) {
          const list = locals.assigned.get(left.text) ?? [];
          if (list.length < MAX_URL_TEMPLATES) list.push(right);
          locals.assigned.set(left.text, list);
        }
      }
      if (e?.type === "augmented_assignment_expression" && e.childForFieldName("operator")?.text === "+=") {
        const left = e.childForFieldName("left");
        const right = e.childForFieldName("right");
        // A parameter extended in place (`apiRoute += 'series'`) starts from the value the caller passes.
        if (left?.type === "identifier" && right && params.has(left.text) && !locals.values.has(left.text)) locals.values.set(left.text, left);
        if (left?.type === "identifier" && right && locals.values.has(left.text)) {
          const list = locals.appends.get(left.text) ?? [];
          list.push({ guard, expr: right });
          locals.appends.set(left.text, list);
        }
      }
    } else if (stmt.type === "return_statement") {
      const expr = stmt.namedChild(0);
      if (expr) out.push(expr);
    } else if (stmt.type === "if_statement") {
      const cond = stmt.childForFieldName("condition");
      // A condition on no parameter is still ONE condition: two such `if`s guard
      // independent changes (`if (opts.enterprise) …; if (opts.accountScoped) …`).
      const byParam = cond ? guardParam(cond, params) : "?";
      const inner = byParam === "?" && cond ? `?${cond.text.replace(/\s+/g, "")}` : byParam;
      const cons = stmt.childForFieldName("consequence");
      if (cons) collectReturns(branchStatements(cons), locals, out, depth + 1, inner, params);
      const alt = stmt.childForFieldName("alternative")?.namedChild(0); // else_clause → body
      if (alt) collectReturns(branchStatements(alt), locals, out, depth + 1, "?", params);
    } else if (stmt.type === "switch_statement") {
      // Each arm one exclusive guard: `case A: url += 'a'; break;`.
      const arms = stmt.childForFieldName("body")?.namedChildren.filter((c) => c.type === "switch_case" || c.type === "switch_default") ?? [];
      arms.forEach((arm, i) => {
        const body = arm.childrenForFieldName("body").filter((c): c is Node => !!c);
        collectReturns(body, locals, out, depth + 1, `switch@${stmt.startIndex}#${i}`, params);
      });
    }
  }
}

/** A branch body's statements: a `{…}` block's children, or the one bare statement (`else if`, `else return x`). */
function branchStatements(node: Node): readonly Node[] {
  return node.type === "statement_block" ? node.namedChildren : [node];
}

/** The arms of a (possibly nested / parenthesized) ternary, or the expression itself. */
function ternaryArms(expr: Node, depth: number): Node[] {
  if (depth > MAX_RETURN_DEPTH) return [expr];
  if (expr.type === "parenthesized_expression") {
    const inner = expr.namedChild(0);
    return inner ? ternaryArms(inner, depth + 1) : [expr];
  }
  if (expr.type === "ternary_expression") {
    const cons = expr.childForFieldName("consequence");
    const alt = expr.childForFieldName("alternative");
    return [...(cons ? ternaryArms(cons, depth + 1) : []), ...(alt ? ternaryArms(alt, depth + 1) : [])];
  }
  return [expr];
}

/**
 * Make a folded URL app-relative: drop a literal origin (`http://localhost`)
 * and a leading runtime hole standing in for a configured base
 * (`store.state.config.API_URL + "/api/" + p` folds to `{}/api/{p}`). A base
 * concatenated in front of a `/`-led path is a base by construction; keeping
 * it as a `{}` segment would put a wildcard where the route join expects `/api`.
 */
function stripUrlBase(text: string): string {
  return text.replace(/^https?:\/\/[^/]+/i, "").replace(/^\{\}(?=\/)/, "");
}

/** `urlTemplate` (primary) + `urlTemplateAlternatives` (the other branches), or nothing. */
function urlTemplateFields(templates: string[]): Pick<FunctionInfo, "urlTemplate" | "urlTemplateAlternatives"> {
  if (templates.length === 0) return {};
  return {
    urlTemplate: templates[0],
    ...(templates.length > 1 ? { urlTemplateAlternatives: templates.slice(1) } : {}),
  };
}

/**
 * Bare name of a type reference: drops type arguments and trailing whitespace
 * so `Repo<User>` matches the declaration named `Repo`. Keeps dotted names
 * (`React.Component`) intact — that is how the source names the base.
 */
function bareTypeName(text: string): string {
  const cut = text.indexOf("<");
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * Decorators that are CHILDREN of a node (class fields, parameters — unlike
 * methods, whose decorators are class-body siblings): full text with
 * arguments, `@` dropped, whitespace collapsed (`IsString()`, `Expose({ name: 'x' })`).
 */
function childDecorators(node: Node): string[] {
  const out: string[] = [];
  for (const child of node.children) {
    if (child.type === "decorator") out.push(child.text.replace(/^@/, "").replace(/\s+/g, " ").trim());
  }
  return out;
}

/** A `?` token among a node's children — TS optional field, parameter or property signature. */
function hasOptionalMarker(node: Node): boolean {
  return node.children.some((c) => c.type === "?");
}

/**
 * A written type that is a type parameter in scope with a bound (`function f<T extends Club>(x: T)`, a
 * class's `<T extends Club>`) is the bound: that is what a member read on the value can name. The
 * innermost declaration wins (a method's `T` shadows its class's); a bound that names another
 * parameter or has no bound at all stays as written.
 */
function typeParameterBound(from: Node, written: string | null): string | null {
  if (!written || !/^[A-Za-z_$][\w$]*$/.test(written)) return written;
  for (let n: Node | null = from; n; n = n.parent) {
    const list = n.childForFieldName("type_parameters") ?? n.namedChildren.find((c) => c.type === "type_parameters") ?? null;
    if (!list || (n.type !== "function_declaration" && n.type !== "method_definition" && n.type !== "arrow_function"
      && n.type !== "function_expression" && n.type !== "generator_function_declaration" && n.type !== "generator_function"
      && n.type !== "class_declaration" && n.type !== "abstract_class_declaration" && n.type !== "class"
      && n.type !== "method_signature" && n.type !== "abstract_method_signature")) continue;
    for (const tp of list.namedChildren) {
      if (tp.type !== "type_parameter" || tp.childForFieldName("name")?.text !== written) continue;
      const bound = tp.namedChildren.find((c) => c.type === "constraint")?.namedChild(0)?.text;
      return bound && !bound.includes("|") && !bound.includes("&") ? bound : written;
    }
  }
  return written;
}

/**
 * What a handler-shaped function reads off its request object: only when the
 * first parameter is named like one (`req`, `request`, `ctx`) — that is how
 * Express/Koa/Fastify handlers declared away from the route line (`router.get
 * ('/', getUsers)`) get their bindings, through the project-level join.
 * Absent (not empty) when the function reads nothing.
 */
function requestAccessOf(params: readonly ParamInfo[], body: Node | null): RouteParamInfo[] | undefined {
  const first = params[0]?.name;
  if (!first || !body || !REQUEST_PARAM_NAMES.has(first)) return undefined;
  const access = scanRequestAccess(body.text, first);
  return access.length > 0 ? access : undefined;
}

/** How deep a namespace object nests before its members stop being named (`api.users.admin.get`). */
const MAX_NAMESPACE_DEPTH = 3;

/**
 * Keys only a Vue component's options object carries. Its `methods` are
 * flattened onto `this` (called as `this.save()`, bound as `@click="save"`), so
 * naming them `methods.save` would invent symbols nothing calls — Options API
 * components are their own extraction problem and are left alone here.
 */
const VUE_OPTION_KEYS = new Set([
  "data", "methods", "computed", "watch", "props", "components", "template",
  "render", "setup", "mixins", "emits", "created", "mounted", "beforeMount",
]);

/** Option groups whose members are component methods (`this.x` / `@click="x"`). */
const VUE_FUNCTION_GROUPS = new Set(["methods", "computed", "watch"]);
/** Options that are functions in their own right. */
const VUE_HOOKS = new Set([
  "data", "setup", "render", "beforeCreate", "created", "beforeMount", "mounted", "beforeUpdate", "updated",
  "beforeDestroy", "destroyed", "beforeUnmount", "unmounted", "activated", "deactivated", "errorCaptured",
]);

/**
 * The options object of a Vue component declaration: the object itself, or the
 * first argument of `defineComponent({ … })` / `Vue.extend({ … })`. Null for
 * anything else (a namespace object, a value).
 */
function vueComponentOptions(value: Node): Node | null {
  let obj: Node | null = value;
  if (value.type === "call_expression") {
    const callee = value.childForFieldName("function")?.text ?? "";
    if (!/^(defineComponent|Vue\.extend|defineNuxtComponent)$/.test(callee)) return null;
    obj = value.childForFieldName("arguments")?.namedChildren.find((a) => a.type === "object") ?? null;
  }
  return obj && obj.type === "object" && isVueComponentOptions(obj) ? obj : null;
}

function isVueComponentOptions(obj: Node): boolean {
  return obj.namedChildren.some((m) => {
    const key = m.type === "pair" ? m.childForFieldName("key") : m.type === "method_definition" ? m.childForFieldName("name") : null;
    const name = objectKeyName(key);
    return name !== null && VUE_OPTION_KEYS.has(name);
  });
}

/** An object key usable as a symbol name: an identifier, or a string that reads as one. Computed keys name nothing. */
function objectKeyName(key: Node | null): string | null {
  if (!key) return null;
  if (key.type === "property_identifier" || key.type === "identifier") return key.text;
  if (key.type === "string") {
    const text = key.text.slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(text) ? text : null;
  }
  return null;
}

/**
 * A Pinia store definition bound at module level:
 *
 *   export const useClubStore = defineStore('club', { state, getters, actions })   // option store
 *   export const useClubStore = defineStore({ id: 'club', state, actions })        // the same, id inside
 *   export const useClubStore = defineStore('club', () => { …; return { load } })  // setup store
 *
 * Calling the binding returns the store instance, whose members the caller
 * reaches as `store.load()`. The instance is reported as a class of its own
 * (`ClubStore`, see `storeClassName`) and the binding as a function declared
 * to return it, so the linker types `const store = useClubStore()` like any
 * factory's product and resolves `store.load()` on that class.
 */
interface PiniaStore {
  binding: string;
  className: string;
  /** The option store's options object. */
  options: Node | null;
  /** The setup store's setup function. */
  setup: Node | null;
}

function piniaStoreOf(decl: Node): PiniaStore | null {
  const name = decl.childForFieldName("name");
  const value = decl.childForFieldName("value");
  if (name?.type !== "identifier" || value?.type !== "call_expression") return null;
  if (value.childForFieldName("function")?.text !== "defineStore") return null;
  const args = value.childForFieldName("arguments")?.namedChildren ?? [];
  const options = args.find((a) => a.type === "object") ?? null;
  const setup = args.find((a) => FUNCTION_EXPRESSIONS.has(a.type)) ?? null;
  if (!options && !setup) return null;
  return { binding: name.text, className: storeClassName(name.text), options, setup };
}

/** `useClubStore` → `ClubStore`; a binding not named `use…` is capitalized, kept apart from the binding itself. */
function storeClassName(binding: string): string {
  const m = /^use([A-Z][\w$]*)$/.exec(binding);
  if (m) return m[1]!;
  const cap = binding[0]!.toUpperCase() + binding.slice(1);
  return cap === binding ? `${binding}Instance` : cap;
}

/** The object a Pinia `state` option returns: `state: () => ({ … })`, `state() { return { … } }`, `state: { … }`. */
function piniaStateObject(member: Node): Node | null {
  let fn: Node | null = member;
  if (member.type === "pair") fn = member.childForFieldName("value");
  if (!fn) return null;
  if (fn.type === "object") return fn;
  let body = fn.childForFieldName("body");
  while (body?.type === "parenthesized_expression") body = body.namedChild(0);
  if (body?.type === "object") return body;
  if (body?.type !== "statement_block") return null;
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "return_statement") continue;
    let ret = stmt.namedChild(0);
    while (ret?.type === "parenthesized_expression") ret = ret.namedChild(0);
    return ret?.type === "object" ? ret : null;
  }
  return null;
}

/** Any JSDoc tag this extractor reads — the per-file gate before looking at comments at all. */
const JSDOC_TAG_RE = /@(?:param|arg|argument|returns?|type|implements|interface)\b/;

/** A constructor function read as a class (see `JavaScriptExtractor.prototypeClasses`). */
interface PrototypeClass {
  cls: ClassInfo;
  /** Lines of the functions assigned to the prototype: the `Owner.member` functions they were read as. */
  prototypeLines: ReadonlySet<number>;
  /** Spans of the methods the constructor assigns to `this`, whose calls were the constructor's. */
  ownSpans: ReadonlyArray<readonly [number, number]>;
}

/** The file's functions without the prototype members its prototype classes now hold. */
function withoutPrototypeMembers(functions: FunctionInfo[], classes: readonly PrototypeClass[]): FunctionInfo[] {
  const byOwner = new Map(classes.map((p) => [p.cls.name, p]));
  return functions.flatMap((fn) => {
    const dot = fn.name.indexOf(".");
    const owner = dot > 0 ? byOwner.get(fn.name.slice(0, dot)) : undefined;
    if (owner?.prototypeLines.has(fn.line)) return [];
    const ctor = byOwner.get(fn.name);
    if (ctor && ctor.cls.line === fn.line && ctor.ownSpans.length > 0) {
      const inMember = (line: number) => ctor.ownSpans.some(([from, to]) => line >= from && line <= to);
      return [{ ...fn, calls: fn.calls.filter((c) => !inMember(c.line)) }];
    }
    return [fn];
  });
}

export class JavaScriptExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  /**
   * Per-file facts, set when a file starts (`extractFunctions` /
   * `extractClasses` are each called once per file, synchronously — the one
   * instance is shared by the typescript and javascript metas).
   */
  private ctx: ScanContext = { jsdoc: false, tokenTypes: new Map(), dispatchProps: new Map(), dispatchMappers: new Set(), moduleStrings: new Map(), localClasses: new Map() };
  private ctxTree: Tree | null = null;
  /** Whether the file defines a Pinia store (a substring gate, see `piniaStoreOf`). */
  private pinia = false;
  /** The file registers Alpine.js components (`Alpine.data(…)`): a factory's returned methods are the template's handlers. */
  private alpine = false;
  /** The file assigns to a prototype (a substring gate, see `prototypeClasses`). */
  private prototypes = false;

  override extractFunctions(tree: Tree, sourceText: string): FunctionInfo[] {
    this.beginFile(tree, sourceText);
    let functions = super.extractFunctions(tree, sourceText);
    // A constructor function's prototype methods are its class's (see `prototypeClasses`).
    const protoClasses = this.prototypeClasses(tree);
    if (protoClasses.length > 0) functions = withoutPrototypeMembers(functions, protoClasses);
    if (sourceText.includes("]:")) this.extractKeyedRegistry(tree.rootNode, functions);
    if (this.ctx.dispatchProps.size > 0) for (const fn of functions) addDispatchPropCalls(fn, this.ctx.dispatchProps);
    // `describe`/`it`/`beforeEach` callbacks: each test a function of its own, named by its title path.
    functions.push(...testCaseFunctions(tree.rootNode, sourceText, (name, fn) => this.parseJsArrowOrExpr(name, fn, false)));
    // Callbacks handed on to run later (`toast.action = () => …`): each a function of its own (`heldFunction`).
    for (const held of heldFunctionNodes(tree)) {
      const fn = this.parseJsArrowOrExpr(held.name, held.node, false);
      // It closes over the functions it is written in: their typed parameters and locals type its receivers.
      const captured = this.capturedTypes(held.node, new Set([...fn.params.map((p) => p.name), ...(fn.localTypes ?? []).map((l) => l.name)]));
      if (captured.length > 0) fn.localTypes = [...(fn.localTypes ?? []), ...captured];
      functions.push(fn);
    }
    return functions;
  }

  /**
   * The typed bindings a function written in place sees from the functions around it, innermost first:
   * each enclosing function's typed parameters and the locals its body types (`warn(club: Club) { …
   * subscribe(() => club.save()) }`). A name the function binds itself, or a nearer scope binds, is left out.
   */
  private capturedTypes(node: Node, own: Set<string>): LocalType[] {
    const out: LocalType[] = [];
    for (let p = node.parent; p && p.type !== "class_body" && p.type !== "program"; p = p.parent) {
      if (!/^(?:method_definition|function_declaration|generator_function_declaration|arrow_function|function_expression|generator_function)$/.test(p.type)) continue;
      const params = this.extractJsParams(p.childForFieldName("parameters") ?? p.childForFieldName("parameter"));
      const body = p.childForFieldName("body");
      const locals = body?.type === "statement_block" ? scanBody(body, new Set(params.map((x) => x.name)), this.ctx, params).localTypes : [];
      for (const param of params) {
        if (own.has(param.name)) continue;
        own.add(param.name);
        if (param.type && /^[A-Za-z_$]/.test(param.name)) out.push({ name: param.name, type: param.type });
      }
      for (const local of locals) {
        if (own.has(local.name)) continue;
        own.add(local.name);
        out.push(local);
      }
    }
    return out;
  }

  /**
   * A registry keyed by a constant, and the creators that name it — a real
   * app's thunks, and every Redux codebase built the same way:
   *
   *   export const fetchTrophies = createThunk(FETCH_TROPHIES);
   *   handleThunks({ [FETCH_TROPHIES]: createFetchHandler(section, '/trophy') });
   *
   * `dispatch(fetchTrophies())` runs the handler registered under the constant
   * `fetchTrophies` was made with; the two share nothing but that constant. Each
   * `[KEY]: value` entry of an object handed to a call becomes a function named
   * `[KEY]` (its value's calls; an inline handler's body), and a variable made
   * by a call whose first argument is a constant registered in the same file
   * becomes a function calling `[KEY]` — so the ordinary linker follows the
   * creator to the handler and on to the request it makes.
   */
  private extractKeyedRegistry(root: Node, functions: FunctionInfo[]): void {
    const keys = new Set<string>();
    for (const pair of root.descendantsOfType("pair")) {
      const key = pair.childForFieldName("key");
      const ident = key?.type === "computed_property_name" ? key.namedChildren[0] : null;
      const value = pair.childForFieldName("value");
      if (ident?.type !== "identifier" || !value) continue;
      // The object is a registration's argument: `handleThunks({ … })`.
      if (pair.parent?.type !== "object" || pair.parent.parent?.type !== "arguments") continue;
      const name = `[${ident.text}]`;
      if (value.type === "arrow_function" || value.type === "function_expression") {
        const fn = this.parseJsArrowOrExpr(name, value, false);
        fn.line = pair.startPosition.row + 1;
        functions.push(fn);
      } else if (value.type === "call_expression" || value.type === "identifier") {
        functions.push({
          name,
          params: [],
          returnType: null,
          isAsync: false,
          isExported: false,
          decorators: [],
          calls: value.type === "identifier"
            ? [{ name: value.text, kind: "internal", target: null, line: value.startPosition.row + 1, column: value.startPosition.column }]
            : extractCalls(value, "typescript"),
          line: pair.startPosition.row + 1,
          endLine: pair.endPosition.row + 1,
        });
      } else continue;
      keys.add(ident.text);
    }
    if (keys.size === 0) return;
    const named = new Set(functions.map((f) => f.name));
    for (const decl of root.descendantsOfType("variable_declarator")) {
      const name = decl.childForFieldName("name");
      const value = decl.childForFieldName("value");
      if (name?.type !== "identifier" || value?.type !== "call_expression" || named.has(name.text)) continue;
      const first = value.childForFieldName("arguments")?.namedChildren[0];
      if (first?.type !== "identifier" || !keys.has(first.text)) continue;
      const exported = decl.parent?.parent?.type === "export_statement";
      functions.push({
        name: name.text,
        params: [],
        returnType: null,
        isAsync: false,
        isExported: exported,
        decorators: [],
        calls: [{ name: `[${first.text}]`, kind: "internal", target: null, line: first.startPosition.row + 1, column: first.startPosition.column }],
        line: decl.startPosition.row + 1,
        endLine: decl.endPosition.row + 1,
      });
    }
  }

  override extractClasses(tree: Tree, sourceText: string): ClassInfo[] {
    this.beginFile(tree, sourceText);
    const classes = super.extractClasses(tree, sourceText);
    // A class a function body declares (`function a() { class Club {} … new Club() }`) is its own class, found by
    // line span, so a construction there never reaches a top-level namesake. Only where its name is the file's one
    // (two classes of a name share their members' symbol names): the construction is then bound locally and links nowhere.
    if (this.ctx.localClasses.size > 0) {
      for (const node of tree.rootNode.descendantsOfType(["class_declaration", "abstract_class_declaration"])) {
        const name = node?.childForFieldName("name")?.text;
        if (node && node.parent?.type === "statement_block" && name && this.ctx.localClasses.get(name)) classes.push(this.parseJsClass(node, false));
      }
    }
    if (this.ctx.dispatchProps.size > 0) for (const c of classes) for (const m of c.methods) addDispatchPropCalls(m, this.ctx.dispatchProps);
    // Named zod schemas, as the request types a route validates with (zod-schemas.ts).
    classes.push(...extractZodSchemas(tree.rootNode, sourceText));
    const declared = new Set(classes.map((c) => c.name));
    for (const p of this.prototypeClasses(tree)) if (!declared.has(p.cls.name)) classes.push(p.cls);
    return classes;
  }

  /** The prototype classes of the file `prototypeClasses` read last, by tree. */
  private protoMemo: { tree: Tree; classes: PrototypeClass[] } | null = null;

  /**
   * ES5 classes: a constructor function the file declares (`function Club(name)
   * { … }`, `var Club = function () { … }`) with methods assigned to its
   * prototype (`Club.prototype.sign = function …`, `Club.prototype = { sign:
   * function … }`) or to `this` in its body (`this.rename = function …`). Each
   * is a class named for the constructor, spanning the constructor, whose
   * methods are those members: `new Club().sign()` and a `this.wash()` in a
   * prototype method are calls of that class's members. The prototype
   * assignments were read as functions `Club.sign`, and the `this.` ones not
   * at all (their calls were the constructor's).
   */
  private prototypeClasses(tree: Tree): PrototypeClass[] {
    if (this.protoMemo?.tree === tree) return this.protoMemo.classes;
    const classes: PrototypeClass[] = [];
    this.protoMemo = { tree, classes };
    if (!this.prototypes) return classes;
    const root = tree.rootNode;
    const isFn = (n: Node | null): n is Node => n?.type === "function_expression" || n?.type === "arrow_function";
    // Constructors: function declarations and `var X = function` in the file.
    const ctors = new Map<string, Node>();
    for (const d of root.descendantsOfType(["function_declaration", "variable_declarator"])) {
      if (!d) continue;
      const name = d.childForFieldName("name");
      const fn = d.type === "function_declaration" ? d : d.childForFieldName("value");
      if (name?.type !== "identifier" || !/^[A-Z]/.test(name.text) || (fn?.type !== "function_declaration" && fn?.type !== "function_expression")) continue;
      if (!ctors.has(name.text)) ctors.set(name.text, fn);
    }
    if (ctors.size === 0) return classes;
    const members = new Map<string, Array<{ name: string; node: Node; fromPrototype: boolean }>>();
    const add = (owner: string, name: string, node: Node, fromPrototype: boolean) => {
      const list = members.get(owner) ?? members.set(owner, []).get(owner)!;
      if (!list.some((m) => m.name === name)) list.push({ name, node, fromPrototype });
    };
    for (const assign of root.descendantsOfType("assignment_expression")) {
      if (assign?.parent?.type !== "expression_statement") continue;
      const left = assign.childForFieldName("left");
      const right = assign.childForFieldName("right");
      if (left?.type !== "member_expression" || !right) continue;
      const path = left.text.replace(/\s+/g, "");
      const single = /^([A-Za-z_$][\w$]*)\.prototype\.([A-Za-z_$][\w$]*)$/.exec(path);
      if (single && ctors.has(single[1]!) && isFn(right)) add(single[1]!, single[2]!, right, true);
      const whole = /^([A-Za-z_$][\w$]*)\.prototype$/.exec(path);
      if (whole && ctors.has(whole[1]!) && right.type === "object") {
        for (const member of right.namedChildren) {
          if (member?.type === "pair") {
            const key = member.childForFieldName("key");
            const value = member.childForFieldName("value");
            if (key && (key.type === "property_identifier" || key.type === "identifier") && isFn(value)) add(whole[1]!, key.text, value, true);
          } else if (member?.type === "method_definition") {
            const key = member.childForFieldName("name");
            if (key) add(whole[1]!, key.text, member, true);
          }
        }
      }
    }
    // Inheritance: `Child.prototype = Object.create(Base.prototype)`, `= new Base()`, `util.inherits(Child, Base)`,
    // `Object.setPrototypeOf(Child.prototype, Base.prototype)` — the constructor's class extends the base.
    const bases = new Map<string, string>();
    const baseOf = (n: Node | null | undefined): string | null => {
      const text = n?.text.replace(/\s+/g, "") ?? "";
      return /^[A-Za-z_$][\w$.]*$/.test(text.replace(/\.prototype$/, "")) ? text.replace(/\.prototype$/, "") : null;
    };
    for (const stmt of root.descendantsOfType("expression_statement")) {
      const expr = stmt?.namedChild(0);
      if (expr?.type === "assignment_expression") {
        const owner = /^([A-Za-z_$][\w$]*)\.prototype$/.exec(expr.childForFieldName("left")?.text.replace(/\s+/g, "") ?? "")?.[1];
        const right = expr.childForFieldName("right");
        if (!owner || !ctors.has(owner) || !right) continue;
        const arg = right.type === "call_expression" && right.childForFieldName("function")?.text === "Object.create" ? right.childForFieldName("arguments")?.namedChildren[0]
          : right.type === "new_expression" ? right.childForFieldName("constructor") : null;
        const base = baseOf(arg);
        if (base && base !== owner && !bases.has(owner)) bases.set(owner, base);
      } else if (expr?.type === "call_expression") {
        const callee = expr.childForFieldName("function")?.text;
        const args = expr.childForFieldName("arguments")?.namedChildren ?? [];
        if ((callee === "util.inherits" || callee === "inherits" || callee === "Object.setPrototypeOf") && args.length >= 2) {
          const owner = args[0]!.text.replace(/\.prototype$/, "");
          const base = baseOf(args[1]);
          if (ctors.has(owner) && base && base !== owner && !bases.has(owner)) bases.set(owner, base);
        }
      }
    }
    for (const owner of bases.keys()) if (!members.has(owner)) members.set(owner, []);
    for (const [owner, ctor] of ctors) {
      const body = ctor.childForFieldName("body");
      for (const stmt of body?.namedChildren ?? []) {
        const assign = stmt?.type === "expression_statement" ? stmt.namedChild(0) : null;
        const left = assign?.type === "assignment_expression" ? assign.childForFieldName("left") : null;
        const right = assign?.childForFieldName("right") ?? null;
        const m = left?.type === "member_expression" ? /^this\.([A-Za-z_$][\w$]*)$/.exec(left.text.replace(/\s+/g, "")) : null;
        if (m && isFn(right)) add(owner, m[1]!, right, false);
      }
    }
    for (const [owner, list] of members) {
      const ctor = ctors.get(owner)!;
      const exported = ctor.parent?.type === "export_statement" || ctor.parent?.parent?.parent?.type === "export_statement";
      list.sort((a, b) => a.node.startIndex - b.node.startIndex);
      const methods = list.map((m) => this.parseJsArrowOrExpr(m.name, m.node, true));
      classes.push({
        cls: {
          name: owner,
          extends: bases.get(owner) ?? null,
          implements: [],
          decorators: [],
          methods,
          properties: [],
          isExported: exported,
          line: ctor.startPosition.row + 1,
          endLine: ctor.endPosition.row + 1,
        },
        prototypeLines: new Set(list.filter((m) => m.fromPrototype).map((m) => m.node.startPosition.row + 1)),
        ownSpans: list.filter((m) => !m.fromPrototype).map((m) => [m.node.startPosition.row + 1, m.node.endPosition.row + 1] as const),
      });
    }
    return classes;
  }

  private beginFile(tree: Tree, sourceText: string): void {
    // Both entry points run for the same file in turn — compute once.
    if (this.ctxTree === tree) return;
    this.ctxTree = tree;
    this.pinia = sourceText.includes("defineStore");
    this.alpine = sourceText.includes("Alpine.data(");
    this.prototypes = sourceText.includes(".prototype") || sourceText.includes("inherits(");
    this.ctx = {
      jsdoc: JSDOC_TAG_RE.test(sourceText),
      tokenTypes: collectInjectionTokenTypes(tree.rootNode, sourceText),
      dispatchProps: sourceText.includes("connect(") ? dispatchPropsOf(tree.rootNode) : new Map(),
      dispatchMappers: sourceText.includes("connect(") ? dispatchMappersOf(tree.rootNode) : new Set(),
      moduleStrings: sourceText.includes("class ") ? moduleStringConstants(tree.rootNode) : new Map(),
      localClasses: sourceText.includes("class ") ? localClassesOf(tree.rootNode) : new Map(),
    };
  }

  /** The JSDoc block documenting `node`, when the file has any JSDoc type tags. */
  private jsdocOf(node: Node | null): string | null {
    return this.ctx.jsdoc && node ? precedingJsDoc(node) : null;
  }

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.extractJsFunctions(node, functions, false);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractJsClasses(node, classes);
  }

  private extractJsFunctions(
    node: Node,
    functions: FunctionInfo[],
    isExported: boolean,
  ): void {
    // Declarations directly in the module (or in a top-level `export`) — the
    // only place an object literal of functions is a namespace rather than a
    // value some function builds and passes around.
    const moduleLevel =
      node.type === "program" || (node.type === "export_statement" && node.parent?.type === "program");

    for (const child of node.children) {

      if (child.type === "export_statement") {
        // `export default { Articles, setToken: (t) => … }`: the importer calls
        // `agent.setToken(…)`, so each inline member is named by its key alone.
        const value = child.childForFieldName("value");
        const options = moduleLevel && value ? vueComponentOptions(value) : null;
        if (options) this.extractVueOptionsMembers(options, functions);
        else if (moduleLevel && value?.type === "object") this.extractObjectMembers(null, value, functions, true, 0);
        // An Alpine-style component: `export default (id) => ({ open() {…}, close() {…} })` — the
        // template calls each member by its key.
        else if (moduleLevel && value) {
          const built = returnedObject(value);
          if (built) this.extractObjectMembers(null, built, functions, true, 0);
          // `export default memo(function FancyBadge() {…})`, `export default observer(function Garage() {…})`:
          // the module's default is the named function the wrapper is handed.
          const wrapped = value.type === "call_expression" ? wrappedFunction(value) : null;
          const name = wrapped?.type === "function_expression" ? wrapped.childForFieldName("name")?.text : undefined;
          if (wrapped && name) functions.push(this.parseJsArrowOrExpr(name, wrapped, true));
          // No name to give: `export default withAuth(async (req, res) => …)`, `export default async (req, res) => …` —
          // the module's default function, as an importer (and a `pages/api` route) calls it.
          else if (!wrapped) {
            const anonymous = FUNCTION_EXPRESSIONS.has(value.type) && !value.childForFieldName("name") ? value
              : value.type === "call_expression" ? handlerOf(value, true) : null;
            if (anonymous && !functions.some((f) => f.name === "default")) functions.push(this.parseJsArrowOrExpr("default", anonymous, true));
          }
          if (value.type === "call_expression" || value.type === "new_expression") this.extractStoreCallActions(value, functions);
        }
        this.extractJsFunctions(child, functions, true);
        continue;
      }

      // `namespace Pitch { export function mow() {…} }`: its members are `Pitch.mow`, as a caller writes them.
      const namespace = child.type === "expression_statement" && child.namedChild(0)?.type === "internal_module" ? child.namedChild(0)! : child.type === "internal_module" ? child : null;
      if (namespace) {
        this.extractNamespaceFunctions(namespace, "", functions);
        continue;
      }

      // `Alpine.data("comboBox", (id) => ({ open() {…} }))`: the same component, registered by name.
      if (moduleLevel && child.type === "expression_statement") {
        const call = child.namedChild(0);
        const fn = call?.type === "call_expression" ? call.childForFieldName("function") : null;
        if (fn?.type === "member_expression" && fn.text === "Alpine.data") {
          const factory = call!.childForFieldName("arguments")?.namedChildren[1];
          const built = factory ? returnedObject(factory) : null;
          if (built) this.extractObjectMembers(null, built, functions, false, 0);
        }
      }

      // CommonJS `module.exports = { … }` — the same namespace object.
      if (moduleLevel && child.type === "expression_statement") {
        const assign = child.namedChild(0);
        const right = assign?.type === "assignment_expression" ? assign.childForFieldName("right") : null;
        const isModuleExports = right !== null && assign!.childForFieldName("left")?.text === "module.exports";
        const options = isModuleExports ? vueComponentOptions(right!) : null;
        if (options) this.extractVueOptionsMembers(options, functions);
        else if (isModuleExports && right!.type === "object") this.extractObjectMembers(null, right!, functions, true, 0);
      }

      // A script that wraps itself in an IIFE (`(function () { … })();`) declares at the top of that body;
      // a function assigned to a namespace or a prototype there (`YAHOO.app.DatePicker = function (…)`,
      // `DatePicker.prototype._onShow = function (…)`) is a function of its own.
      const scriptLevel = moduleLevel || IIFE_BODIES.has(node.id);
      if (scriptLevel && child.type === "expression_statement") {
        const expr = child.namedChild(0);
        const iife = expr?.type === "call_expression" ? expr.childForFieldName("function") : null;
        const fn = iife?.type === "parenthesized_expression" ? iife.namedChild(0) : iife;
        if (moduleLevel && (fn?.type === "function_expression" || fn?.type === "arrow_function")) {
          const body = fn.childForFieldName("body");
          if (body?.type === "statement_block") {
            IIFE_BODIES.add(body.id);
            this.extractJsFunctions(body, functions, false);
            IIFE_BODIES.delete(body.id);
          }
        }
        if (expr?.type === "assignment_expression") {
          const left = expr.childForFieldName("left");
          const right = expr.childForFieldName("right");
          const path = left?.type === "member_expression" ? left.text.replace(/\s+/g, "") : "";
          const isFunction = !!right && (right.type === "function_expression" || right.type === "arrow_function");
          // CommonJS exports: `exports.listClubs = async (req, res) => {…}` and
          // `module.exports.createClub = function () {…}` are the module's `listClubs` /
          // `createClub`, which a requirer calls as `ctl.listClubs(…)`; `module.exports =
          // function kickoff() {…}` is the module itself, named by its own name.
          const member = moduleLevel && isFunction
            ? CJS_EXPORT_MEMBER.exec(path)?.[1] ?? (path === "module.exports" ? right!.childForFieldName("name")?.text : undefined)
            : undefined;
          if (member) {
            functions.push(this.parseJsArrowOrExpr(member, right!, true));
            const body = right!.childForFieldName("body");
            if (body?.type === "statement_block") this.extractJsFunctions(body, functions, false);
          } else if (path && right && isFunction &&
            !/^(?:module\.)?exports\b|^this\./.test(path) && /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(path)) {
            const parts = path.split(".");
            const proto = parts.lastIndexOf("prototype");
            const name = proto > 0 ? `${parts[proto - 1]}.${parts.slice(proto + 1).join(".")}` : parts[parts.length - 1]!;
            if (name && !name.endsWith(".")) {
              functions.push(this.parseJsArrowOrExpr(name, right, false));
              const body = right.childForFieldName("body");
              if (body?.type === "statement_block") this.extractJsFunctions(body, functions, false);
            }
          }
        }
      }

      if (
        child.type === "function_declaration" ||
        child.type === "generator_function_declaration"
      ) {
        functions.push(this.parseJsFunction(child, isExported));
        // Descend into the body: NAMED functions nested inside a function are
        // real symbols — a React component's `const onSubmitHandler = async
        // (e) => {…}` is where the click handling (and its api-calls) actually
        // lives. Skipping them dropped the handler AND its body's calls from
        // the graph, so every React click-trace dead-ended at the component.
        const body = child.childForFieldName("body");
        if (body) this.extractJsFunctions(body, functions, false);
      } else if (
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        for (const decl of child.children) {
          if (decl.type === "variable_declarator") {
            const name = decl.childForFieldName("name")?.text;
            const value = decl.childForFieldName("value");
            if (moduleLevel && (value?.type === "call_expression" || value?.type === "new_expression")) {
              const before = functions.length;
              this.extractStoreCallActions(value, functions);
              // `export const useClubsStore = createStore({ actions: () => ({ get() {…} }) })`: the binding is what a
              // screen calls for the store, whose members are those actions (`store.get()`).
              const actions = functions.slice(before).map((f) => f.name);
              if (actions.length > 0 && name && /^[A-Za-z_$][\w$]*$/.test(name) && decl.parent) {
                functions.push({
                  name,
                  params: [],
                  returnType: null,
                  isAsync: false,
                  isExported,
                  decorators: [],
                  calls: [],
                  line: decl.startPosition.row + 1,
                  endLine: decl.endPosition.row + 1,
                  returnedMembers: actions.map((a) => ({ key: a.slice("actions.".length), local: a, kind: "function" as const })),
                });
              }
            }
            // `const actions = { async refresh() {…}, rename: async () => {…} }` inside a factory: the object is
            // what the factory hands back, its members functions of their own (`actions.refresh`).
            if (!moduleLevel && name && /^[A-Za-z_$][\w$]*$/.test(name) && value?.type === "object" && handedBack(decl, name)) this.extractObjectMembers(name, value, functions, false, 1, true);
            const wrapped = value ? wrappedFunction(value) ?? (moduleLevel ? handlerOf(value, isExported) : null) : null;
            const store = moduleLevel && this.pinia && name ? piniaStoreOf(decl) : null;
            if (store) {
              functions.push(this.piniaStoreFunction(store, decl, isExported));
            } else if (
              name &&
              value &&
              (value.type === "arrow_function" ||
                value.type === "function_expression" ||
                value.type === "generator_function")
            ) {
              functions.push(this.parseJsArrowOrExpr(name, value, isExported));
              // An Alpine component factory, `let show = function () { return { init() {…}, save() {…} } }`
              // registered through `Alpine.data(name, …)`: the template's `@click="save"` calls its members.
              const built = moduleLevel && this.alpine ? factoryObject(value) : null;
              if (built) this.extractObjectMembers(name, built, functions, false, 0);
              // An exported factory returning an object of functions — a generated API client's
              // `XApiAxiosParamCreator = function (configuration) { return { createX: async (…) => {…} } }`:
              // each member is a function of its own (`XApiAxiosParamCreator.createX`), so a request
              // it builds belongs to that operation, not to the factory.
              const members = !built && moduleLevel && isExported ? functionObjectReturned(value) : null;
              if (members) this.extractObjectMembers(name, members, functions, false, 0);
              // react-redux's function-form `mapDispatchToProps = dispatch => ({ onSave: … })`: each
              // member is the prop a component calls (`this.props.onSave(club)`), a function of its own.
              const mapped = !built && !members && moduleLevel && this.ctx.dispatchMappers.has(name) ? factoryObject(value) : null;
              if (mapped) this.extractObjectMembers(name, mapped, functions, false, 0);
            } else if (name && wrapped) {
              // `const save = useCallback(async () => {…}, [deps])`,
              // `const Row = memo((props) => …)` — the wrapper returns the
              // function it is given, so the binding names that function.
              functions.push(this.parseJsArrowOrExpr(name, wrapped, isExported));
            } else if (name && value && /^[A-Za-z_$][\w$]*$/.test(name) && wrappedCalleeName(value)) {
              // `const onSearch = useDebounceFn(applySearch, 300)`: the binding runs the function it names.
              functions.push({
                name,
                params: [],
                returnType: null,
                isAsync: false,
                isExported,
                decorators: [],
                calls: [{ name: wrappedCalleeName(value)!, kind: "internal", target: null, line: value.startPosition.row + 1 }],
                line: decl.startPosition.row + 1,
                endLine: decl.endPosition.row + 1,
              });
            } else if (name && unwrapValue(value)?.type === "object" && moduleLevel && decl.childForFieldName("name")?.type === "identifier") {
              // `const Profile = { get: (u) => requests.get(…) }` — an API client
              // or service written as a namespace object. Its members are what
              // callers invoke (`agent.Profile.get`), and the api-calls inside
              // them need an enclosing symbol to belong to. `{ … } as const`
              // (a typed path table) is the same object.
              this.extractObjectMembers(name, unwrapValue(value)!, functions, isExported, 0);
            } else if (name === "actions" && value?.type === "call_expression" && moduleLevel && decl.childForFieldName("name")?.type === "identifier") {
              // `const actions = defineActions({ async load({ commit }) {…} })` — a module's `actions`
              // object handed through a helper: the object passed to the call holds the actions,
              // named as `const actions = {…}` names them.
              for (const arg of value.childForFieldName("arguments")?.namedChildren ?? []) {
                if (arg.type === "object") this.extractObjectMembers(name, arg, functions, isExported, 0);
              }
            }
            // Named bindings can hide anywhere below (an arrow's body, a
            // useEffect callback, a call argument) — keep walking the value.
            if (value) this.extractJsFunctions(value, functions, false);
          }
        }
      } else if (
        child.type === "class_declaration" ||
        child.type === "abstract_class_declaration" ||
        child.type === "class_body"
      ) {
        // Class members are the class extractor's territory.
        continue;
      } else {
        // Generic descent: statements, blocks, JSX, call arguments — anonymous
        // functions are never extracted, but named bindings inside them are.
        this.extractJsFunctions(child, functions, false);
      }
    }
  }

  private parseJsFunction(node: Node, isExported: boolean): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const doc = this.jsdocOf(node);
    const params = this.extractJsParams(node.childForFieldName("parameters"), doc);
    const returnType = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? (doc ? jsDocReturnType(doc) : null);
    const isAsync = node.text.startsWith("async ");
    const decorators = this.extractDecorators(node);

    const body = node.childForFieldName("body");
    const paramNames = new Set(params.map((p) => p.name));
    const stripped: UrlTemplateFound = {};
    const templates = extractUrlTemplates(body, paramNames, stripped);
    const requestAccess = requestAccessOf(params, body);
    const responses = responsesOf(params, body);
    const { calls, localTypes, returnedSpreads, returnedMembers, returnedFrom } = finishBody(extractCalls(body, "typescript"), body, paramNames, this.ctx, params);
    const derivedLocals = composableLocals(node, returnedMembers);
    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      calls,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(localTypes ? { localTypes } : {}),
      ...(returnedSpreads ? { returnedSpreads } : {}),
      ...(returnedMembers ? { returnedMembers } : {}),
      ...(derivedLocals ? { derivedLocals } : {}),
      ...(returnedFrom && !returnType ? { returnedFrom } : {}),
      ...urlTemplateRecord(templates, stripped),
      ...(requestAccess ? { requestAccess } : {}),
      ...(responses ? { responses } : {}),
    };
  }

  private parseJsArrowOrExpr(
    name: string,
    node: Node,
    isExported: boolean,
  ): FunctionInfo {
    // Handle type assertions wrapping the arrow function: `const f = ((): T => {}) as const`
    let funcNode = node;
    if (
      funcNode.type === "as_expression" ||
      funcNode.type === "satisfies_expression" ||
      funcNode.type === "type_assertion"
    ) {
      const inner = funcNode.child(0);
      if (inner && (inner.type === "arrow_function" || inner.type === "function_expression")) {
        funcNode = inner;
      }
    }

    // Extract decorators from the parent declaration if present
    const declarator = funcNode.parent;
    const declaration = declarator?.parent;
    const decorators =
      declaration ? this.extractDecorators(declaration) : [];
    // JSDoc sits before the statement declaring the binding (`/** … */ const
    // f = (a) => …`) or before an object member (`/** … */ get: (id) => …`).
    const docAnchor = declarator?.type === "variable_declarator" ? declaration ?? null : declarator?.type === "pair" ? declarator : null;

    // `(u) => …` puts its list in `parameters`; a bare `u => …` puts the one
    // identifier in `parameter`, which used to leave the arrow with no params.
    const doc = this.jsdocOf(docAnchor);
    const params = this.extractJsParams(
      funcNode.childForFieldName("parameters") ?? funcNode.childForFieldName("parameter"),
      doc,
    );
    const returnType = funcNode.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? (doc ? jsDocReturnType(doc) : null);
    const isAsync = funcNode.text.startsWith("async ");

    const body = funcNode.childForFieldName("body") ?? funcNode;
    const paramNames = new Set(params.map((p) => p.name));
    const stripped: UrlTemplateFound = {};
    const templates = extractUrlTemplates(body, paramNames, stripped);
    const requestAccess = requestAccessOf(params, body);
    const responses = responsesOf(params, body);
    const { calls, localTypes, returnedSpreads, returnedMembers, returnedFrom } = finishBody(extractCalls(body, "typescript"), body, paramNames, this.ctx, params);
    const derivedLocals = composableLocals(funcNode, returnedMembers);
    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      calls,
      line: funcNode.startPosition.row + 1,
      endLine: funcNode.endPosition.row + 1,
      ...(localTypes ? { localTypes } : {}),
      ...(returnedSpreads ? { returnedSpreads } : {}),
      ...(returnedMembers ? { returnedMembers } : {}),
      ...(derivedLocals ? { derivedLocals } : {}),
      ...(returnedFrom && !returnType ? { returnedFrom } : {}),
      ...urlTemplateRecord(templates, stripped),
      ...(requestAccess ? { requestAccess } : {}),
      ...(responses ? { responses } : {}),
    };
  }

  /**
   * The function members of a namespace object literal, named
   * `prefix.key` (`Profile.get`) — the same shape the symbol index uses for a
   * class method, so a call `agent.Profile.get` reaches it through the linker's
   * suffix match. A nested object extends the prefix (`api.users.get`). With no
   * prefix (a default-exported object) the key alone is the name. Shorthand
   * entries and spreads reference something defined elsewhere and add nothing.
   */
  /**
   * A Vue Options API component (`export default { methods: { save() {} } }`,
   * `defineComponent({ … })`): its `methods`, `computed` and `watch` members
   * are flattened onto `this` — called as `this.save()`, bound as
   * `@click="save"` — so each is a function named by its key alone, and the
   * lifecycle hooks (`created`, `mounted`, …) plus `data` and `setup` are
   * functions of their own name. A `setup()` body is descended for the named
   * inner functions it returns to the template. Before this an Options API
   * component declared NO functions at all, so none of its handlers resolved
   * and no click trace left the component (a real Vue app: 0 of 754 handlers).
   */
  private extractVueOptionsMembers(options: Node, functions: FunctionInfo[]): void {
    for (const member of options.namedChildren) {
      if (member.type === "pair") {
        const key = objectKeyName(member.childForFieldName("key"));
        const value = member.childForFieldName("value");
        if (!key || !value) continue;
        if (VUE_FUNCTION_GROUPS.has(key) && value.type === "object") {
          this.extractObjectMembers(null, value, functions, false, MAX_NAMESPACE_DEPTH);
        } else if (VUE_HOOKS.has(key) && (value.type === "arrow_function" || value.type === "function_expression")) {
          functions.push(this.parseJsArrowOrExpr(key, value, false));
        }
      } else if (member.type === "method_definition") {
        const key = objectKeyName(member.childForFieldName("name"));
        if (!key || !VUE_HOOKS.has(key)) continue;
        const fn = this.parseJsFunction(member, false);
        fn.name = key;
        functions.push(fn);
        if (key === "setup") {
          const body = member.childForFieldName("body");
          if (body) this.extractJsFunctions(body, functions, false);
        }
      }
    }
  }

  /**
   * The binding of a Pinia store (`useClubStore`), declared to return the
   * store's class. A setup store's binding runs its setup function — its body
   * is this function's; an option store's runs nothing of the caller's.
   */
  private piniaStoreFunction(store: PiniaStore, decl: Node, isExported: boolean): FunctionInfo {
    if (store.setup) {
      const fn = this.parseJsArrowOrExpr(store.binding, store.setup, isExported);
      fn.returnType = store.className;
      return fn;
    }
    return {
      name: store.binding,
      params: [],
      returnType: store.className,
      isAsync: false,
      isExported,
      decorators: [],
      calls: [],
      line: decl.startPosition.row + 1,
      endLine: decl.endPosition.row + 1,
    };
  }

  /**
   * The instance a Pinia store binding returns, as a class: an option store's
   * `actions` and `getters` are its methods (called as `store.load()`,
   * `this._drop(id)` inside), and the string-shaped values its `state` starts
   * with are its `fieldValues` — what fills `${this.url}` in an action's
   * request. A setup store's members are the functions its setup returns
   * (`return { load }`): each a method that calls the inner function it names.
   * Never exported: no module exports the instance's type by that name.
   */
  private piniaStoreClass(store: PiniaStore, decl: Node): ClassInfo {
    const methods: FunctionInfo[] = [];
    const fieldValues = new Map<string, string | null>();
    if (store.options) {
      for (const member of store.options.namedChildren) {
        const key = objectKeyName(member.type === "pair" ? member.childForFieldName("key") : member.type === "method_definition" ? member.childForFieldName("name") : null);
        if (key === "actions" || key === "getters") {
          const value = member.childForFieldName("value");
          if (value?.type === "object") this.extractObjectMembers(null, value, methods, false, MAX_NAMESPACE_DEPTH);
        } else if (key === "state") {
          for (const entry of piniaStateObject(member)?.namedChildren ?? []) {
            const field = entry.type === "pair" ? objectKeyName(entry.childForFieldName("key")) : null;
            const value = field ? renderUrlExpr(entry.childForFieldName("value")) : null;
            if (field && value !== null && value.length <= 300) fieldValues.set(field, value);
          }
        }
      }
    } else if (store.setup) {
      const body = store.setup.childForFieldName("body");
      const declared = new Set<string>();
      let returned: Node | null = null;
      for (const stmt of body?.type === "statement_block" ? body.namedChildren : []) {
        if (stmt.type === "function_declaration") {
          const n = stmt.childForFieldName("name")?.text;
          if (n) declared.add(n);
        } else if (stmt.type === "lexical_declaration" || stmt.type === "variable_declaration") {
          for (const d of stmt.namedChildren) {
            const v = d.type === "variable_declarator" ? d.childForFieldName("value") : null;
            const n = d.childForFieldName("name");
            if (n?.type === "identifier" && v && (FUNCTION_EXPRESSIONS.has(v.type) || wrappedFunction(v))) declared.add(n.text);
          }
        } else if (stmt.type === "return_statement") {
          returned = stmt.namedChild(0);
          while (returned?.type === "parenthesized_expression") returned = returned.namedChild(0);
        }
      }
      for (const entry of returned?.type === "object" ? returned.namedChildren : []) {
        // `return { load }` / `return { fetchAll: load }`
        const key = entry.type === "shorthand_property_identifier" ? entry.text : entry.type === "pair" ? objectKeyName(entry.childForFieldName("key")) : null;
        const ref = entry.type === "pair" ? entry.childForFieldName("value") : entry;
        if (!key || !ref || (ref.type !== "identifier" && ref.type !== "shorthand_property_identifier") || !declared.has(ref.text)) continue;
        const line = entry.startPosition.row + 1;
        methods.push({
          name: key,
          params: [],
          returnType: null,
          isAsync: false,
          isExported: false,
          decorators: [],
          calls: [{ name: ref.text, kind: "internal", target: null, line, column: ref.startPosition.column }],
          line,
          endLine: line,
        });
      }
    }
    return {
      name: store.className,
      extends: null,
      implements: [],
      decorators: [],
      methods,
      properties: [],
      isExported: false,
      line: decl.startPosition.row + 1,
      endLine: decl.endPosition.row + 1,
      ...knownFieldValues(fieldValues),
    };
  }

  /**
   * A store built by a call (`createStore({ actions: types => ({ async sync() {…} }) })`,
   * `new Vuex.Store({ actions: { reset() {…} } })`): each action written as a method is a
   * function `actions.<key>`, the name a module's own `actions` object gives it. A method's
   * body is a scope of its own, so its calls belonged to no function at all; an action
   * written as `k: function () {…}` or an arrow is read the same way.
   */
  private extractStoreCallActions(call: Node, functions: FunctionInfo[]): void {
    // A Pinia store's actions are the methods of the class its binding returns (`piniaStoreFunction`).
    if (/(?:^|\.)defineStore$/.test((call.childForFieldName("function") ?? call.childForFieldName("constructor"))?.text ?? "")) return;
    for (const arg of call.childForFieldName("arguments")?.namedChildren ?? []) {
      if (arg.type !== "object") continue;
      for (const pair of arg.namedChildren) {
        if (pair.type !== "pair" || objectKeyName(pair.childForFieldName("key")) !== "actions") continue;
        const value = pair.childForFieldName("value");
        const actions = value?.type === "object" ? value : value ? returnedObject(value) : null;
        for (const member of actions?.namedChildren ?? []) {
          const key = member.type === "method_definition" ? objectKeyName(member.childForFieldName("name")) : member.type === "pair" ? objectKeyName(member.childForFieldName("key")) : null;
          if (!key) continue;
          // `k: async function k() {…}` / `k: async ({ commit }) => {…}`: a function written as the entry's value.
          const written = member.type === "pair" ? member.childForFieldName("value") : null;
          if (member.type === "pair" && !(written && (written.type === "function_expression" || written.type === "arrow_function"))) continue;
          const fn = written ? this.parseJsArrowOrExpr(`actions.${key}`, written, false) : this.parseJsFunction(member, false);
          fn.name = `actions.${key}`;
          functions.push(fn);
        }
      }
    }
  }

  private extractObjectMembers(
    prefix: string | null,
    obj: Node,
    functions: FunctionInfo[],
    isExported: boolean,
    depth: number,
    /** The object is a local the function hands back: in its non-arrow methods `this` is the object itself. */
    thisIsObject = false,
  ): void {
    const siblings = thisIsObject && prefix ? new Set(obj.namedChildren.map((m) => objectKeyName(m.childForFieldName(m.type === "pair" ? "key" : "name"))).filter((k): k is string => !!k)) : null;
    // `async setType(p) { await this.updateOne(p); }`: the sibling method, named as the object's members are.
    const ownThis = (fn: FunctionInfo): FunctionInfo => {
      if (!siblings) return fn;
      for (const c of fn.calls) {
        const m = /^this\.([A-Za-z_$][\w$]*)$/.exec(c.name);
        if (m && siblings.has(m[1]!)) c.name = `${prefix}.${m[1]}`;
      }
      return fn;
    };
    for (const member of obj.namedChildren) {
      if (member.type === "pair") {
        const key = objectKeyName(member.childForFieldName("key"));
        const value = unwrapValue(member.childForFieldName("value"));
        if (!key || !value) continue;
        const name = prefix ? `${prefix}.${key}` : key;
        if (value.type === "arrow_function" || value.type === "function_expression") {
          const fn = this.parseJsArrowOrExpr(name, value, isExported);
          functions.push(value.type === "function_expression" ? ownThis(fn) : fn);
        } else if (value.type === "object" && depth < MAX_NAMESPACE_DEPTH) {
          this.extractObjectMembers(name, value, functions, isExported, depth + 1);
        } else if (key === "actions" && depth < MAX_NAMESPACE_DEPTH) {
          // `actions: Object.assign({}, baseActions, { save() {…} })`: the literals it merges are the actions written here.
          for (const arg of objectAssignArgs(value)) if (arg.type === "object") this.extractObjectMembers(name, arg, functions, isExported, depth + 1);
        }
      } else if (member.type === "method_definition") {
        const key = objectKeyName(member.childForFieldName("name"));
        if (!key) continue;
        const fn = this.parseJsFunction(member, isExported);
        fn.name = prefix ? `${prefix}.${key}` : key;
        functions.push(ownThis(fn));
      }
    }
  }

  /**
   * Parameters with their declared type — the TypeScript annotation, else the
   * JSDoc `@param {T} name` of `jsdoc` (the function's doc block) — and the DI
   * token an injection decorator puts on them (`@Inject(USER_REPO)`,
   * `@inject(TYPES.UserRepo) @named('file')`, see `injectionOf`).
   */
  private extractJsParams(paramsNode: Node | null, jsdoc: string | null = null): ParamInfo[] {
    if (!paramsNode) return [];
    const docTypes = jsdoc ? jsDocParamTypes(jsdoc) : null;
    if (paramsNode.type === "identifier") {
      return [{ name: paramsNode.text, type: docTypes?.get(paramsNode.text) ?? null, defaultValue: null }];
    }
    const params: ParamInfo[] = [];

    for (const child of paramsNode.children) {
      if (
        child.type === "required_parameter" ||
        child.type === "optional_parameter" ||
        child.type === "identifier" ||
        child.type === "rest_pattern" ||
        child.type === "assignment_pattern"
      ) {
        // Plain JS `repo = defaultRepo` is an `assignment_pattern` (left/right).
        const isAssignment = child.type === "assignment_pattern";
        const name =
          (isAssignment ? child.childForFieldName("left")?.text : null) ??
          child.childForFieldName("pattern")?.text ??
          child.childForFieldName("name")?.text ??
          child.text;
        const typeNode = child.childForFieldName("type");
        const defaultNode = child.childForFieldName(isAssignment ? "right" : "value");
        let type = typeNode?.text?.replace(/^:\s*/, "") ?? docTypes?.get(name) ?? null;
        if (typeNode) type = typeParameterBound(child, type);
        // Decorators lead the parameter — one child read rules them out.
        const di = (child.type === "required_parameter" || child.type === "optional_parameter") &&
          child.child(0)?.type === "decorator"
          ? injectionOf(child, type, this.ctx.tokenTypes)
          : {};
        if (!type && di.type) type = di.type;

        params.push({
          name,
          type,
          defaultValue: defaultNode?.text ?? null,
          ...(di.qualifier ? { qualifier: di.qualifier } : {}),
          ...(child.type === "rest_pattern" || name.startsWith("...") ? { variadic: true } : {}),
          ...(child.type === "optional_parameter" && !defaultNode ? { optional: true } : {}),
        });
      }
    }
    return params;
  }

  private extractJsClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {
      if (child.type === "export_statement") {
        for (const inner of child.children) {
          this.collectJsClassLike(inner, classes, true);
        }
        continue;
      }
      this.collectJsClassLike(child, classes, false);
    }
  }

  /** The functions a TypeScript namespace declares, named by their path through it (`Pitch.Turf.mow`). */
  private extractNamespaceFunctions(ns: Node, prefix: string, functions: FunctionInfo[]): void {
    const name = ns.childForFieldName("name")?.text;
    const body = ns.childForFieldName("body");
    if (!name || !body) return;
    const path = prefix ? `${prefix}.${name}` : name;
    for (const member of body.namedChildren) {
      const exported = member.type === "export_statement";
      const decl = exported ? member.childForFieldName("declaration") ?? member.namedChildren.find((c) => c.type !== "decorator") ?? null : member;
      if (!decl) continue;
      const inner = decl.type === "expression_statement" && decl.namedChild(0)?.type === "internal_module" ? decl.namedChild(0)! : decl;
      if (inner.type === "internal_module") {
        this.extractNamespaceFunctions(inner, path, functions);
      } else if (decl.type === "function_declaration" || decl.type === "generator_function_declaration") {
        const fn = this.parseJsFunction(decl, exported);
        fn.name = `${path}.${fn.name}`;
        functions.push(fn);
      } else if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
        for (const d of decl.namedChildren) {
          const n = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
          const value = d.childForFieldName("value");
          if (n?.type === "identifier" && value && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "generator_function")) {
            functions.push(this.parseJsArrowOrExpr(`${path}.${n.text}`, value, exported));
          }
        }
      }
    }
  }

  /**
   * A class, an abstract class or a TypeScript interface. Abstract classes and
   * interfaces are first-class here because the symbol linker's interface
   * fan-out (`buildInterfaceImplMap`) resolves a call on an interface-typed
   * receiver to every implementation — machinery that stays dead for TS/JS
   * unless interfaces reach `analysis.classes` with `kind: "interface"`.
   */
  private collectJsClassLike(node: Node, classes: ClassInfo[], isExported: boolean): void {
    // `namespace Billing { export class Invoice {} }` (a statement on its own
    // or exported) holds classes like a module does.
    const ns = node.type === "expression_statement" && node.namedChild(0)?.type === "internal_module" ? node.namedChild(0)! : node;
    if (ns.type === "internal_module" || ns.type === "module") {
      const body = ns.childForFieldName("body");
      if (body) this.extractJsClasses(body, classes);
      return;
    }
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
      classes.push(this.parseJsClass(node, isExported));
    } else if (node.type === "interface_declaration") {
      classes.push(this.parseTsInterface(node, isExported));
    } else if (node.type === "enum_declaration") {
      classes.push(parseTsEnum(node, isExported));
    } else if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
      for (const decl of node.namedChildren) {
        if (decl.type !== "variable_declarator") continue;
        const store = this.pinia ? piniaStoreOf(decl) : null;
        if (store) {
          classes.push(this.piniaStoreClass(store, decl));
          continue;
        }
        // `const Coupe = class extends models.Car { drive() {…} }`: a class, named by its binding.
        const name = decl.childForFieldName("name");
        let value = decl.childForFieldName("value");
        while (value?.type === "parenthesized_expression") value = value.namedChildren[0] ?? null;
        if (name?.type === "identifier" && value?.type === "class") classes.push(this.parseJsClass(value, isExported, name.text));
      }
    }
  }

  /**
   * A TypeScript interface as a ClassInfo: method signatures become methods
   * with no body (so `calls` is empty), property signatures become properties.
   */
  private parseTsInterface(node: Node, isExported: boolean): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const extendsList: string[] = [];
    // `interface A extends B, C` is an `extends_type_clause` CHILD holding one
    // `type` field entry per base — unlike a class, which can only have one.
    for (const child of node.children) {
      if (child.type !== "extends_type_clause") continue;
      for (const t of child.namedChildren) {
        const bare = bareTypeName(t.text);
        if (bare) extendsList.push(bare);
      }
    }

    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    const body = node.childForFieldName("body");
    if (body) {
      for (const member of body.namedChildren) {
        if (member.type === "method_signature") {
          methods.push({
            name: member.childForFieldName("name")?.text ?? "anonymous",
            params: this.extractJsParams(member.childForFieldName("parameters")),
            returnType: member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null,
            isAsync: false,
            isExported: false,
            decorators: [],
            calls: [],
            line: member.startPosition.row + 1,
            endLine: member.endPosition.row + 1,
          });
        } else if (member.type === "property_signature") {
          properties.push({
            name: member.childForFieldName("name")?.text ?? "unknown",
            type: member.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null,
            visibility: null,
            isStatic: false,
            isReadonly: member.text.includes("readonly "),
            isRequired: !hasOptionalMarker(member),
          });
        }
      }
    }

    return {
      name,
      // An interface has no runtime base; the first `extends` keeps the shape
      // other consumers expect, and the rest ride along in `implements` so the
      // impl map can match on either (it inspects both).
      extends: extendsList[0] ?? null,
      implements: extendsList.slice(1),
      decorators: [],
      methods,
      properties,
      isExported,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind: "interface",
    };
  }

  private parseJsClass(node: Node, isExported: boolean, boundName?: string): ClassInfo {
    const name = boundName ?? node.childForFieldName("name")?.text ?? "anonymous";
    let extendsName: string | null = null;
    const implementsList: string[] = [];

    // Heritage is a `class_heritage` CHILD, not a field — reading it as a field
    // (`childForFieldName("heritage")`) silently returned null for every class
    // in every TS and JS file, so inheritance was never recorded for the most
    // common language in the corpus. TS spells the inside as
    // `extends_clause` / `implements_clause`; plain JS has a bare expression.
    for (const child of node.children) {
      if (child.type !== "class_heritage") continue;
      for (const clause of child.namedChildren) {
        if (clause.type === "extends_clause") {
          // `value` excludes `type_arguments`, so `extends Base<T>` -> `Base`.
          extendsName = bareTypeName(clause.childForFieldName("value")?.text ?? "") || null;
        } else if (clause.type === "implements_clause") {
          for (const impl of clause.namedChildren) {
            const bare = bareTypeName(impl.text);
            if (bare) implementsList.push(bare);
          }
        } else {
          // JavaScript: `class_heritage` holds the extends expression directly.
          extendsName ??= bareTypeName(clause.text) || null;
        }
      }
    }

    // Plain JS declares what TS writes as heritage in the class's JSDoc.
    const classDoc = this.jsdocOf(node);
    if (classDoc) {
      for (const iface of jsDocImplements(classDoc)) if (!implementsList.includes(iface)) implementsList.push(iface);
    }

    const decorators = this.extractDecorators(node);
    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    // String-shaped field values (`baseUrl = environment.apiUrl`, `this.resourceName = 'tags'`);
    // null marks a field given two different values.
    const fieldValues = new Map<string, string | null>();
    const setValue = (field: string, raw: string | null) => {
      // A same-file string constant is its value (`this.resourceName = endpoint`).
      const value = raw === null || this.ctx.moduleStrings.size === 0 ? raw : raw.replace(/\$\{([\w$]+)\}/g, (hole, n: string) => this.ctx.moduleStrings.get(n) ?? hole);
      if (value === null || value.length > 300) return;
      fieldValues.set(field, fieldValues.has(field) && fieldValues.get(field) !== value ? null : value);
    };
    let concreteMembers = 0;
    let abstractMembers = 0;
    let ctor: { params: ParamInfo[]; body: Node } | null = null;
    const instanceBodies: Node[] = [];

    if (body) {
      for (const member of body.children) {
        if (member.type === "method_definition") {
          concreteMembers++;
          const methodName =
            member.childForFieldName("name")?.text ?? "anonymous";
          const paramsNode = member.childForFieldName("parameters");
          const memberDoc = this.jsdocOf(member);
          const params = this.extractJsParams(paramsNode, memberDoc);
          const returnType = member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? (memberDoc ? jsDocReturnType(memberDoc) : null);
          const isAsync = member.text.startsWith("async ");
          const methodBody = member.childForFieldName("body");
          const requestAccess = requestAccessOf(params, methodBody);
          const responses = responsesOf(params, methodBody);
          const paramNames = new Set(params.map((p) => p.name));
          // A URL-builder helper is as often a service-class method
          // (`configService.APIUrl(sub)`) as a free function.
          const stripped: UrlTemplateFound = {};
          const templates = extractUrlTemplates(methodBody, paramNames, stripped);
          // `static getCollectionResource() { return "albums"; }`: a resource method naming its path segment.
          const segment = templates.length === 0 && params.length === 0 && RESOURCE_METHOD.test(methodName) ? returnedSegment(methodBody) : null;
          if (segment) templates.push(segment);
          const { calls, localTypes, returnedSpreads, returnedFrom } = finishBody(extractCalls(methodBody, "typescript"), methodBody, paramNames, this.ctx, params);
          methods.push({
            name: methodName,
            params,
            returnType,
            isAsync,
            isExported: false,
            decorators: this.extractDecorators(member),
            calls,
            line: member.startPosition.row + 1,
            endLine: member.endPosition.row + 1,
            ...(localTypes ? { localTypes } : {}),
            ...(returnedSpreads ? { returnedSpreads } : {}),
            ...(returnedFrom && !returnType ? { returnedFrom } : {}),
            ...urlTemplateRecord(templates, stripped),
            ...(requestAccess ? { requestAccess } : {}),
            ...(responses ? { responses } : {}),
          });
          // `constructor(public readonly id: number)` declares a property.
          if (methodName === "constructor") {
            properties.push(...this.parameterProperties(paramsNode, params));
            if (methodBody) ctor = { params, body: methodBody };
          } else if (methodBody && !member.children.some((c) => c.type === "static")) {
            instanceBodies.push(methodBody);
          }
        } else if (member.type === "abstract_method_signature") {
          // `abstract fetchValue(key: string): string;` — a member every
          // subclass implements. Kept (without calls) so a call through an
          // abstract-class-typed dependency has a declaration to land on.
          abstractMembers++;
          methods.push({
            name: member.childForFieldName("name")?.text ?? "anonymous",
            params: this.extractJsParams(member.childForFieldName("parameters")),
            returnType: member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null,
            isAsync: false,
            isExported: false,
            decorators: [],
            calls: [],
            line: member.startPosition.row + 1,
            endLine: member.endPosition.row + 1,
            abstract: true,
          });
        } else if (member.type === "public_field_definition" || member.type === "field_definition") {
          if (member.children.some((c) => c.type === "abstract")) abstractMembers++;
          else concreteMembers++;
          const field = this.parseField(member);
          properties.push(field);
          setValue(field.name, renderUrlExpr(member.childForFieldName("value")));
          // `onSave = (e) => { … }` — a React class component's handler, bound as
          // `onPress={this.onSave}`: a method in all but syntax.
          const fieldValue = member.childForFieldName("value");
          if (fieldValue && (fieldValue.type === "arrow_function" || fieldValue.type === "function_expression")) {
            const fn = this.parseJsArrowOrExpr(field.name, fieldValue, false);
            fn.line = member.startPosition.row + 1;
            methods.push(fn);
          } else if (fieldValue?.type === "call_expression" && handedOnOnly(node, field.name)) {
            // `changeCountry = trackField('country')`: a handler a factory builds, bound as `onChange={this.changeCountry}`.
            methods.push(factoryHandler(field.name, fieldValue, null, member.startPosition.row + 1));
          }
        } else if (member.type === "class_static_block") {
          concreteMembers++;
        }
      }
    }
    // `get form() { return this.formRef; }`: read as `this.form`, a property of the type the getter states
    // (`get form(): ClubForm`) or the typed field it returns.
    if (body) {
      for (const member of body.children) {
        if (member.type !== "method_definition" || !member.children.some((c) => c.type === "get")) continue;
        const name = member.childForFieldName("name")?.text;
        if (!name || properties.some((p) => p.name === name)) continue;
        let type = member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
        if (!type) {
          const stmts = member.childForFieldName("body")?.namedChildren.filter((c) => c?.type !== "comment") ?? [];
          const ret = stmts.length === 1 && stmts[0]?.type === "return_statement" ? stmts[0].namedChild(0) : null;
          const target = ret?.type === "as_expression" || ret?.type === "non_null_expression" ? ret.namedChild(0) : ret;
          const field = target?.type === "member_expression" && target.childForFieldName("object")?.type === "this" ? target.childForFieldName("property")?.text : null;
          type = field ? properties.find((p) => p.name === field)?.type ?? null : null;
        }
        if (type) properties.push({ name, type, visibility: this.getVisibility(member), isStatic: false, isReadonly: true });
      }
    }
    if (ctor) this.constructorAssignments(ctor.body, ctor.params, properties, setValue);
    // `this.onSave = (e) => { … }` in the constructor: a React class component's handler bound
    // as `onSubmit={this.onSave}`, a method in all but syntax — its calls are its own, not the constructor's.
    if (ctor) {
      const own = new Set(methods.map((m) => m.name));
      const spans: Array<[number, number]> = [];
      for (const stmt of ctor.body.namedChildren) {
        const assign = stmt.type === "expression_statement" ? stmt.namedChild(0) : null;
        if (assign?.type !== "assignment_expression") continue;
        const left = assign.childForFieldName("left");
        const value = assign.childForFieldName("right");
        if (left?.type !== "member_expression" || left.childForFieldName("object")?.type !== "this") continue;
        const field = left.childForFieldName("property")?.text;
        // `this.changeTitle = updateFieldEvent('title')`: a handler a factory builds, handed on and never called on.
        if (field && !own.has(field) && value?.type === "call_expression" && handedOnOnly(node, field)) {
          own.add(field);
          methods.push(factoryHandler(field, value, ctor.body, stmt.startPosition.row + 1));
          continue;
        }
        if (!value || (value.type !== "arrow_function" && value.type !== "function_expression")) continue;
        if (!field || own.has(field)) continue;
        own.add(field);
        const fn = this.parseJsArrowOrExpr(field, value, false);
        fn.line = stmt.startPosition.row + 1;
        methods.push(fn);
        spans.push([value.startPosition.row + 1, value.endPosition.row + 1]);
      }
      const ctorFn = spans.length ? methods.find((m) => m.name === "constructor") : undefined;
      if (ctorFn) ctorFn.calls = ctorFn.calls.filter((c) => !spans.some(([from, to]) => c.line >= from && c.line <= to));
    }
    methodAssignedTypes(instanceBodies, ctor?.body ?? null, properties, this.ctx.tokenTypes);
    let superArgs: string[] | undefined;
    for (const stmt of ctor?.body.namedChildren ?? []) {
      const call = stmt.type === "expression_statement" ? stmt.namedChild(0) : null;
      if (call?.type !== "call_expression" || call.childForFieldName("function")?.type !== "super") continue;
      superArgs = (call.childForFieldName("arguments")?.namedChildren ?? []).filter((a) => a.type !== "comment").map((a) => renderUrlExpr(a) ?? `\${${a.text}}`);
      break;
    }

    // An abstract class with nothing BUT abstract members is an interface in
    // all but name (the Angular/NestJS DI-token idiom `abstract class Logger
    // { abstract write(m): void }`): no behaviour of its own, implemented by
    // whatever extends it — exactly what `kind: "interface"` tells the linker
    // (single-implementation redirect, fan-out). One concrete member, field
    // or constructor makes it a class: core treats an interface as code-free
    // (persistence boundary, request schemas, risk), which would misreport
    // that member. JSDoc `@interface` is plain JS's way of saying the same.
    const isInterface =
      (classDoc !== null && jsDocIsInterface(classDoc)) ||
      (node.type === "abstract_class_declaration" && abstractMembers > 0 && concreteMembers === 0);

    return {
      name,
      extends: extendsName,
      implements: implementsList,
      decorators,
      methods,
      properties,
      isExported,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(isInterface ? { kind: "interface" as const } : node.type === "abstract_class_declaration" ? { abstract: true as const } : {}),
      ...knownFieldValues(fieldValues),
      ...(superArgs && superArgs.length > 0 ? { superArgs } : {}),
    };
  }

  /**
   * A class field: TS `public_field_definition` (`name`) or JS
   * `field_definition` (`property`). Its type is the annotation, else a JSDoc
   * `@type`, else what an injection decorator or the initializer states —
   * `inject(UserService)`, `inject<Notifier>(NOTIFIER)`, `new GadgetService()`,
   * `x as T`; the DI token comes from `@Inject(TOKEN)`/`@inject(id)`/
   * `@named(n)` or from the lookup the initializer makes.
   */
  private parseField(member: Node): PropertyInfo {
    const isJsField = member.type === "field_definition";
    const nameNode = member.childForFieldName(isJsField ? "property" : "name");
    const propName = nameNode?.text ?? "unknown";
    let declared = typeParameterBound(member, member.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null);
    if (!declared) {
      const doc = this.jsdocOf(member);
      declared = doc ? jsDocTypeTag(doc) : null;
    }
    const decorators = childDecorators(member);
    const di = decorators.length > 0 ? injectionOf(member, declared, this.ctx.tokenTypes) : {};
    const value = member.childForFieldName("value");
    const init = value ? initializerType(value, this.ctx.tokenTypes) : null;
    const type = declared ?? di.type ?? (init?.type || null);
    const qualifier = di.qualifier ?? (init?.qualifier && !(type && restatesType(init.qualifier, type)) ? init.qualifier : undefined);
    return {
      name: propName,
      type,
      visibility: nameNode?.type === "private_property_identifier" ? "private" : this.getVisibility(member),
      isStatic: isJsField ? member.children.some((c) => c.type === "static") : member.text.includes("static "),
      isReadonly: member.text.includes("readonly "),
      // Field decorators are children of the field (unlike a method's,
      // which sit beside it in the class body) — class-validator and
      // class-transformer markers live here.
      decorators,
      // `name?: string` or `age = 0` is not something a caller must send.
      isRequired: !hasOptionalMarker(member) && !value,
      ...(qualifier ? { qualifier } : {}),
    };
  }

  /**
   * Fields a constructor assigns at its top level: `this.repo = repo` (the
   * parameter's type and DI token — JSDoc `@param` in plain JS), `this.x =
   * new T()`, `this.x = inject(T)`, `/** @type {T} *\/ this.x = …`. A field
   * the class already declares gets the missing type/token filled in (a TS
   * `private audit: IAuditLog` assigned from an `@Inject(AUDIT_LOG)`
   * parameter now carries AUDIT_LOG); an undeclared one (plain JS) is added
   * when its type or token is known. Two top-level assignments of one field
   * that disagree state nothing.
   */
  private constructorAssignments(
    body: Node,
    params: readonly ParamInfo[],
    properties: PropertyInfo[],
    setValue: (field: string, value: string | null) => void,
  ): void {
    const assigned = new Map<string, InjectedType | null>();
    for (const stmt of body.namedChildren) {
      if (stmt.type !== "expression_statement") continue;
      const assign = stmt.namedChild(0);
      if (assign?.type !== "assignment_expression") continue;
      const left = assign.childForFieldName("left");
      if (left?.type !== "member_expression" || left.childForFieldName("object")?.type !== "this") continue;
      const field = left.childForFieldName("property")?.text;
      const right = assign.childForFieldName("right");
      if (!field || !right) continue;
      setValue(field, renderUrlExpr(right));

      const doc = this.jsdocOf(stmt);
      const docType = doc ? jsDocTypeTag(doc) : null;
      let found: InjectedType | null = null;
      if (right.type === "identifier") {
        const param = params.find((p) => p.name === right.text);
        if (param && (param.type || param.qualifier)) {
          found = { type: param.type ?? "", ...(param.qualifier ? { qualifier: param.qualifier } : {}) };
        }
      } else {
        found = initializerType(right, this.ctx.tokenTypes);
      }
      if (docType) found = { ...found, type: docType };

      if (!assigned.has(field)) {
        assigned.set(field, found);
      } else {
        const prev = assigned.get(field);
        if (!prev || !found || prev.type !== found.type || prev.qualifier !== found.qualifier) assigned.set(field, null);
      }
    }

    for (const [field, found] of assigned) {
      if (!found || (!found.type && !found.qualifier)) continue;
      const existing = properties.find((p) => p.name === field);
      if (existing) {
        if (!existing.type && found.type) existing.type = found.type;
        if (!existing.qualifier && found.qualifier) existing.qualifier = found.qualifier;
        continue;
      }
      properties.push({
        name: field,
        type: found.type || null,
        visibility: field.startsWith("#") ? "private" : null,
        isStatic: false,
        isReadonly: false,
        ...(found.qualifier ? { qualifier: found.qualifier } : {}),
      });
    }
  }

  /**
   * TypeScript parameter properties: a constructor parameter carrying an
   * accessibility modifier or `readonly` declares a same-named property —
   * with the parameter's type and DI token (`@Inject(USER_REPO) private
   * readonly users: IUserRepository` is a `users` field injected by USER_REPO).
   */
  private parameterProperties(paramsNode: Node | null, params: readonly ParamInfo[]): PropertyInfo[] {
    if (!paramsNode) return [];
    const out: PropertyInfo[] = [];
    for (const param of paramsNode.namedChildren) {
      if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
      const modifier = param.children.find((c) => c.type === "accessibility_modifier")?.text ?? null;
      const isReadonly = param.children.some((c) => c.type === "readonly");
      if (!modifier && !isReadonly) continue;
      const name = param.childForFieldName("pattern")?.text;
      if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      const info = params.find((p) => p.name === name);
      out.push({
        name,
        type: info?.type ?? typeParameterBound(param, param.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null),
        visibility: (modifier as "public" | "private" | "protected" | null) ?? "public",
        isStatic: false,
        isReadonly,
        decorators: childDecorators(param),
        isRequired: !hasOptionalMarker(param) && !param.childForFieldName("value"),
        ...(info?.qualifier ? { qualifier: info.qualifier } : {}),
      });
    }
    return out;
  }

  private extractDecorators(node: Node): string[] {
    return extractJsDecorators(node);
  }

  private getVisibility(
    node: Node,
  ): "public" | "private" | "protected" | null {
    return getVisibility(node);
  }
}

/**
 * A TypeScript `enum`: its members are the properties, and a member a string
 * or number initializes is a `fieldValues` entry (`Asset = 'assets'`) — what a
 * project pass reads to resolve `@Controller(RouteKey.Asset)`.
 */
function parseTsEnum(node: Node, isExported: boolean): ClassInfo {
  const properties: PropertyInfo[] = [];
  const values: Record<string, string> = {};
  for (const m of node.childForFieldName("body")?.namedChildren ?? []) {
    const name = m.type === "enum_assignment" ? (m.childForFieldName("name") ?? m.namedChildren[0])?.text : m.type === "property_identifier" || m.type === "string" ? m.text : null;
    if (!name) continue;
    const key = stripQuotes(name);
    properties.push({ name: key, type: null, visibility: "public", isStatic: true, isReadonly: true });
    const value = m.type === "enum_assignment" ? (m.childForFieldName("value") ?? m.namedChildren[1] ?? null) : null;
    if (value?.type === "string") values[key] = stripQuotes(value.text);
    else if (value?.type === "number") values[key] = value.text;
  }
  return {
    name: node.childForFieldName("name")?.text ?? "anonymous",
    extends: null,
    implements: [],
    decorators: [],
    methods: [],
    properties,
    ...(Object.keys(values).length > 0 ? { fieldValues: values } : {}),
    isExported,
    kind: "enum",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

/** The field values that were stated once, for `ClassInfo.fieldValues`; nothing when there are none. */
/** Nodes whose `this` is not the instance's: a nested function or class. */
const OWN_THIS_SCOPES = new Set(["function_expression", "function_declaration", "generator_function", "generator_function_declaration", "class", "class_declaration"]);

/** The bodies of the module-level IIFEs being read: their statements are the script's own. */
const IIFE_BODIES = new Set<number>();

/**
 * Fields a method other than the constructor creates: `init() { this.repo =
 * new UserRepo(); }`, a lazy `if (!this.db) this.db = new Db()`. A field that
 * neither its declaration nor the constructor typed takes the type every such
 * construction agrees on; two that disagree state nothing, and neither does
 * one the constructor sets from a value of unknown type. A method's reset to
 * `null`, or its assignment from an untyped value, says nothing either way.
 */
function methodAssignedTypes(bodies: readonly Node[], ctorBody: Node | null, properties: PropertyInfo[], tokenTypes: ReadonlyMap<string, string>): void {
  const assigned = new Map<string, InjectedType | null>();
  const visit = (n: Node, inCtor: boolean): void => {
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      const field = left?.type === "member_expression" && left.childForFieldName("object")?.type === "this"
        ? left.childForFieldName("property")?.text
        : undefined;
      const found = field && right ? initializerType(right, tokenTypes) : null;
      if (field && found && (found.type || found.qualifier)) {
        const prev = assigned.get(field);
        if (prev === undefined) assigned.set(field, found);
        else if (prev && (prev.type !== found.type || prev.qualifier !== found.qualifier)) assigned.set(field, null);
      } else if (field && inCtor && right && right.type !== "null" && right.type !== "undefined") {
        assigned.set(field, null);
      }
    }
    for (const c of n.namedChildren) if (!OWN_THIS_SCOPES.has(c.type)) visit(c, inCtor);
  };
  if (ctorBody) visit(ctorBody, true);
  for (const body of bodies) visit(body, false);

  for (const [field, found] of assigned) {
    if (!found) continue;
    const existing = properties.find((p) => p.name === field);
    if (existing) {
      if (!existing.type && !existing.qualifier) {
        if (found.type) existing.type = found.type;
        if (found.qualifier) existing.qualifier = found.qualifier;
      }
      continue;
    }
    properties.push({
      name: field,
      type: found.type || null,
      visibility: field.startsWith("#") ? "private" : null,
      isStatic: false,
      isReadonly: false,
      ...(found.qualifier ? { qualifier: found.qualifier } : {}),
    });
  }
}

function knownFieldValues(values: ReadonlyMap<string, string | null>): { fieldValues?: Record<string, string> } {
  const known = [...values].filter((e): e is [string, string] => e[1] !== null).slice(0, 50);
  return known.length > 0 ? { fieldValues: Object.fromEntries(known) } : {};
}

/**
 * react-redux `connect(mapStateToProps, mapDispatchToProps)`: an object of
 * action creators, as a variable or inline — `{ lookupTrophy, dispatchFetchX: fetchX }`
 * → `lookupTrophy → lookupTrophy`, `dispatchFetchX → fetchX`. The component calls
 * them as `this.props.lookupTrophy()`, a name nothing defines. The function form,
 * `const mapDispatchToProps = dispatch => ({ onSave: club => dispatch(…) })`,
 * binds each member of the object it returns: `onSave → mapDispatchToProps.onSave`,
 * the function its member is extracted as (`dispatchMappersOf`).
 */
function dispatchPropsOf(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  const objects = new Map<string, Node>();
  const mappers = new Map<string, Node>();
  for (const decl of root.descendantsOfType("variable_declarator")) {
    const name = decl.childForFieldName("name");
    const value = decl.childForFieldName("value");
    if (name?.type === "identifier" && value?.type === "object") objects.set(name.text, value);
    if (name?.type === "identifier" && (value?.type === "arrow_function" || value?.type === "function_expression")) mappers.set(name.text, value);
  }
  for (const call of root.descendantsOfType("call_expression")) {
    if (call.childForFieldName("function")?.text !== "connect") continue;
    const arg = call.childForFieldName("arguments")?.namedChildren[1];
    const mapper = arg?.type === "identifier" ? mappers.get(arg.text) : undefined;
    const built = mapper ? factoryObject(mapper) : null;
    for (const member of built?.namedChildren ?? []) {
      const key = objectKeyName(member.type === "method_definition" ? member.childForFieldName("name") : member.childForFieldName("key"));
      const isFn = member.type === "method_definition" || /^(?:arrow_function|function_expression)$/.test(member.childForFieldName("value")?.type ?? "");
      if (key && isFn) out.set(key, `${arg!.text}.${key}`);
    }
    const obj = arg?.type === "object" ? arg : arg?.type === "identifier" ? objects.get(arg.text) : undefined;
    for (const entry of obj?.namedChildren ?? []) {
      if (entry.type === "shorthand_property_identifier") out.set(entry.text, entry.text);
      else if (entry.type === "pair") {
        const key = objectKeyName(entry.childForFieldName("key"));
        const value = entry.childForFieldName("value");
        if (key && value?.type === "identifier") out.set(key, value.text);
      }
    }
  }
  return out;
}

/** The function-form dispatch mappers `connect(…)` is handed: their returned members are functions of their own. */
function dispatchMappersOf(root: Node): Set<string> {
  const out = new Set<string>();
  for (const call of root.descendantsOfType("call_expression")) {
    if (call.childForFieldName("function")?.text !== "connect") continue;
    const arg = call.childForFieldName("arguments")?.namedChildren[1];
    if (arg?.type === "identifier") out.add(arg.text);
  }
  return out;
}

/** `this.props.lookupTrophy(…)` also calls the creator `connect` bound to it. */
function addDispatchPropCalls(fn: FunctionInfo, props: ReadonlyMap<string, string>): void {
  const extra: CallInfo[] = [];
  for (const call of fn.calls) {
    const m = /^(?:this\.)?props\.(\w+)$/.exec(call.name);
    const creator = m ? props.get(m[1]!) : undefined;
    if (creator && !fn.calls.some((c) => c.name === creator) && !extra.some((c) => c.name === creator)) {
      extra.push({ name: creator, kind: "internal", target: null, line: call.line, ...(call.column !== undefined ? { column: call.column } : {}) });
    }
  }
  fn.calls.push(...extra);
}

/** The object a factory returns when every member (two or more) is a function, else null. */
function functionObjectReturned(fn: Node): Node | null {
  const obj = factoryObject(fn);
  if (!obj) return null;
  const members = obj.namedChildren.filter((m) => m.type !== "comment");
  if (members.length < 2) return null;
  const isFn = (m: Node) => m.type === "method_definition" || (m.type === "pair" && /^(?:arrow_function|function_expression)$/.test(m.childForFieldName("value")?.type ?? ""));
  return members.every(isFn) ? obj : null;
}

/** The object literal a function builds and returns: `(id) => ({ … })`, or a body ending `return { … }`. */
function factoryObject(fn: Node): Node | null {
  const expr = returnedObject(fn);
  if (expr) return expr;
  const body = fn.childForFieldName("body");
  if (body?.type !== "statement_block") return null;
  const last = body.namedChildren.filter((n) => n.type !== "comment").pop();
  let ret = last?.type === "return_statement" ? last.namedChild(0) : null;
  while (ret?.type === "parenthesized_expression") ret = ret.namedChild(0);
  return ret?.type === "object" ? ret : null;
}

/** The object literal an arrow function returns as its expression body (`(id) => ({ … })`), or null. */
/** The arguments of an `Object.assign(target, …sources)` call, or none for any other expression. */
export function objectAssignArgs(node: Node | null | undefined): Node[] {
  let n = node ?? null;
  while (n?.type === "parenthesized_expression") n = n.namedChildren[0] ?? null;
  if (n?.type !== "call_expression" || n.childForFieldName("function")?.text !== "Object.assign") return [];
  return n.childForFieldName("arguments")?.namedChildren.filter((a): a is Node => !!a && a.type !== "comment") ?? [];
}

function returnedObject(fn: Node): Node | null {
  if (fn.type !== "arrow_function") return null;
  let body: Node | null = fn.childForFieldName("body");
  while (body?.type === "parenthesized_expression") body = body.namedChild(0);
  return body?.type === "object" ? body : null;
}

/**
 * Whether a class binds `this.<field>` as an event handler in its markup — `onChange={this.changeTitle}` —
 * and never calls it or reads a member of it: what a handler a factory builds looks like from the class's side,
 * and what a field holding an injected service, a signal or a store (`takeUntilDestroyed(this.destroyRef)`) does not.
 */
function handedOnOnly(cls: Node, field: string): boolean {
  const text = cls.text;
  const name = escapeRegex(field);
  if (new RegExp(`\\bthis\\.${name}\\s*(?:[.(\\[]|\\?\\.)`).test(text)) return false;
  return new RegExp(`\\bon[A-Z]\\w*=\\{\\s*this\\.${name}\\s*\\}`).test(text);
}

/**
 * The handler a factory call builds (`updateFieldEvent('title')`), as a method of its own: its calls are the
 * factory's — the body of a factory the constructor declares itself (`const updateFieldEvent = key => ev => …`),
 * which no other symbol holds, else the factory call, which the linker follows to the factory.
 */
function factoryHandler(name: string, call: Node, ctorBody: Node | null, line: number): FunctionInfo {
  const callee = call.childForFieldName("function");
  let body: Node = call;
  if (callee?.type === "identifier" && ctorBody) {
    for (const stmt of ctorBody.namedChildren) {
      if (stmt.type !== "lexical_declaration" && stmt.type !== "variable_declaration") continue;
      for (const d of stmt.namedChildren) {
        const value = d.type === "variable_declarator" && d.childForFieldName("name")?.text === callee.text ? d.childForFieldName("value") : null;
        if (value && (value.type === "arrow_function" || value.type === "function_expression")) body = value.childForFieldName("body") ?? value;
      }
    }
  }
  return {
    name,
    params: [],
    returnType: null,
    isAsync: false,
    isExported: false,
    decorators: [],
    calls: extractCalls(body, "typescript"),
    line,
    endLine: call.endPosition.row + 1,
  };
}
