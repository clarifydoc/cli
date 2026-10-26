import { responsesOf } from "./responses.js";
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
import { jsDocImplements, jsDocIsInterface, jsDocParamTypes, jsDocTypeTag, precedingJsDoc } from "./jsdoc.js";

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
  /** Top-level `const x = 'literal'` of the file (see `moduleStringConstants`). */
  moduleStrings: ReadonlyMap<string, string>;
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
): { calls: CallInfo[]; localTypes?: LocalType[] } {
  const scan = scanBody(body, paramNames, ctx);
  calls.push(...scan.extraCalls);
  return scan.localTypes.length > 0 ? { calls, localTypes: scan.localTypes } : { calls };
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

/** Function expressions — anonymous ones run on the enclosing function's behalf. */
const FUNCTION_EXPRESSIONS: ReadonlySet<string> = new Set(["arrow_function", "function_expression"]);

/**
 * Wrappers that return (a memoized, debounced or ref-forwarding version of)
 * the function they are given: `useCallback(fn, deps)`, `memo(Component)`,
 * `forwardRef(render)`, lodash `debounce(fn, ms)` / `throttle(fn, ms)`.
 */
const IDENTITY_WRAPPERS: ReadonlySet<string> = new Set([
  "useCallback", "useEvent", "useEffectEvent", "useMemoizedFn", "memo", "forwardRef", "debounce", "throttle",
]);

/**
 * Wrappers whose binding runs the function they are given LAST: Redux
 * Toolkit's `createAsyncThunk("posts/fetch", async () => …)` — dispatching
 * the thunk runs its payload creator, so the binding names that body.
 */
const BODY_LAST_WRAPPERS: ReadonlySet<string> = new Set(["createAsyncThunk"]);

/** The function an identity wrapper call is given as its first argument (or a body-last wrapper its last), if any. */
/** Expressions that only parenthesize or type what they hold. */
const TYPE_WRAPPERS = new Set(["parenthesized_expression", "satisfies_expression", "as_expression", "type_assertion", "non_null_expression"]);

function wrappedFunction(value: Node): Node | null {
  // `(async ({ url }) => { … }) satisfies PageLoad`, `(() => …) as Handler`: a typed function.
  let inner: Node | null = value;
  while (inner && TYPE_WRAPPERS.has(inner.type)) inner = inner.namedChildren[0] ?? null;
  if (inner !== value && inner && FUNCTION_EXPRESSIONS.has(inner.type)) return inner;
  if (value.type !== "call_expression") return null;
  const callee = value.childForFieldName("function");
  const name = callee?.type === "identifier" ? callee.text : callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
  if (!name) return null;
  const args = value.childForFieldName("arguments")?.namedChildren ?? [];
  if (BODY_LAST_WRAPPERS.has(name)) {
    const fn = [...args].reverse().find((a) => FUNCTION_EXPRESSIONS.has(a.type));
    return fn ?? null;
  }
  if (!IDENTITY_WRAPPERS.has(name)) return null;
  const first = args[0];
  return first && FUNCTION_EXPRESSIONS.has(first.type) ? first : null;
}

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
): { extraCalls: CallInfo[]; localTypes: LocalType[] } {
  const extraCalls: CallInfo[] = [];
  if (!body) return { extraCalls, localTypes: [] };
  const seenImports = new Set<string>();
  // name → every binding seen (null = a binding whose type is not stated).
  const bindings = new Map<string, Array<{ local: LocalType; annotated: boolean } | null>>();
  const reassigned = new Set<string>();
  const bindUntyped = (name: string): void => {
    const list = bindings.get(name);
    if (list) list.push(null);
    else bindings.set(name, [null]);
  };
  const bindPattern = (pattern: Node | null): void => {
    if (!pattern) return;
    if (pattern.type === "identifier" || pattern.type === "shorthand_property_identifier_pattern") {
      bindUntyped(pattern.text);
      return;
    }
    for (const child of pattern.namedChildren) bindPattern(child);
  };

  // Children are read once per node (each read crosses into WASM) and the
  // parent's type is passed down rather than asked for.
  const walk = (node: Node, isRoot: boolean, inScope: boolean, parentType: string): void => {
    const type = node.type;
    if (!isRoot && SEPARATE_SCOPES.has(type)) return;
    const children = node.children;

    // `useMutation({ mutationFn: service.update })`: the library calls the
    // function it is handed, on this body's behalf — a call of it here.
    if (type === "pair" && children[0] && FUNCTION_OPTION_KEY.test(children[0].text)) {
      const value = children[children.length - 1];
      if (value && (value.type === "identifier" || value.type === "member_expression") && !value.text.includes("(")) {
        extraCalls.push({ name: value.text.replace(/\s+/g, ""), kind: "internal", target: null, line: value.startPosition.row + 1 });
      }
    }

    if (type === "call_expression" && children[0]?.type === "import") {
      const args = children[children.length - 1];
      const arg = args?.type === "arguments" ? args.child(1) : null;
      if (arg && arg.type === "string") {
        const source = stripQuotes(arg.text);
        // Project-local specifiers only (relative or path-alias) — a bare
        // package import isn't a project file. Unresolvable ones simply
        // produce no link downstream.
        const local = /^[./]/.test(source) || /^[@~]/.test(source);
        if (local && !seenImports.has(source)) {
          seenImports.add(source);
          extraCalls.push({
            name: "default",
            kind: "cross-file",
            target: source,
            line: node.startPosition.row + 1,
            confidence: "EXTRACTED",
          });
        }
      }
    }

    let childScope = inScope;
    if (inScope && !isRoot) {
      if (FUNCTION_EXPRESSIONS.has(type)) {
        if (parentType === "variable_declarator") {
          // A named function expression is its own symbol: its locals are not ours.
          childScope = false;
        } else {
          // An inline callback's parameters shadow our locals inside it.
          bindPattern(node.childForFieldName("parameters") ?? node.childForFieldName("parameter"));
        }
      } else if (type === "method_definition") {
        bindPattern(node.childForFieldName("parameters"));
      } else if (type === "variable_declarator") {
        const name = children[0];
        if (name?.type === "identifier") {
          const local = declaredLocal(node, children, name.text, ctx);
          const list = bindings.get(name.text);
          if (list) list.push(local);
          else bindings.set(name.text, [local]);
        } else {
          bindPattern(name ?? null);
        }
      } else if (type === "catch_clause") {
        bindPattern(node.childForFieldName("parameter"));
      } else if (type === "for_in_statement") {
        bindPattern(node.childForFieldName("left"));
      } else if (type === "assignment_expression") {
        const left = children[0];
        if (left?.type === "identifier") reassigned.add(left.text);
      }
    }

    for (const child of children) walk(child, false, childScope, type);
  };
  walk(body, true, true, "");

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
      for (const b of list) if (!seen.has(`${b!.local.from}|${b!.local.awaited}`)) (seen.add(`${b!.local.from}|${b!.local.awaited}`), localTypes.push(b!.local));
      continue;
    }
    if (list.some((b) => b!.local.type !== first.local.type || b!.local.qualifier !== first.local.qualifier)) continue;
    localTypes.push(first.local);
  }
  return { extraCalls, localTypes };
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
    if (c.type === "type_annotation") annotation = c.text.replace(/^:\s*/, "");
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
    const awaited = value.type === "await_expression";
    const call = awaited ? value.namedChild(0) : value;
    const from = call?.type === "call_expression" ? callChainText(call, "typescript") : null;
    if (!from) return null;
    return { local: awaited ? { name, type: "", from, awaited } : { name, type: "", from }, annotated: false };
  }
  return { local: qualifier ? { name, type, qualifier } : { name, type }, annotated: annotation !== null };
}

/**
 * Module-scope locals (`const api = useUserApi()` at the top of a module or a
 * Vue `<script setup>`), for the file's `<setup>` — what every function in the
 * file sees when its own scope does not bind the name.
 */
export function topLevelLocalTypes(tree: Tree, sourceText: string): LocalType[] {
  const ctx: ScanContext = { jsdoc: JSDOC_TAG_RE.test(sourceText), tokenTypes: collectInjectionTokenTypes(tree.rootNode, sourceText), dispatchProps: new Map(), moduleStrings: new Map() };
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
  /** Receives the leading expression a template starts with (`this.baseUrl()` in `${this.baseUrl()}/x`), when it is one. */
  out?: { base?: string | null },
): string[] {
  if (!body) return [];

  const locals: Locals = { values: new Map(), appends: new Map(), reassigns: new Map(), unset: new Set(), assigned: new Map() };
  const returns: Node[] = [];
  if (body.type === "statement_block") {
    collectReturns(body.namedChildren, locals, returns, 0, null, paramNames);
  } else {
    returns.push(body);
  }
  if (returns.length === 0) return [];

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
    const tpl = stripUrlBase(text);
    const ok = tpl.includes("/") || (bareMember && /^\$\{this\.[\w$]+\}$/.test(tpl));
    if (ok && !templates.includes(tpl)) templates.push(tpl);
    return templates.length >= MAX_URL_TEMPLATES;
  };
  for (const ret of returns) {
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
      const inner = first.namedChild(0);
      return inner?.type === "call_expression" ? inner.text : null;
    }
    return null;
  }
  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    return leadingBaseText(node.childForFieldName("left") ?? node) ?? (node.childForFieldName("left")?.type === "call_expression" ? node.childForFieldName("left")!.text : null);
  }
  return null;
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

/** The appended expressions of every combination of guards, unconditional appends always in, fewest guards first. */
function appendVariants(appends: ReadonlyArray<{ guard: string | null; expr: Node }>): Node[][] {
  const guards = [...new Set(appends.map((a) => a.guard).filter((g): g is string => g !== null))].slice(0, 3);
  const subsets: Set<string>[] = [];
  for (let mask = 0; mask < 1 << guards.length; mask++) {
    subsets.push(new Set(guards.filter((_, i) => mask & (1 << i))));
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
const JSDOC_TAG_RE = /@(?:param|arg|argument|type|implements|interface)\b/;

export class JavaScriptExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  /**
   * Per-file facts, set when a file starts (`extractFunctions` /
   * `extractClasses` are each called once per file, synchronously — the one
   * instance is shared by the typescript and javascript metas).
   */
  private ctx: ScanContext = { jsdoc: false, tokenTypes: new Map(), dispatchProps: new Map(), moduleStrings: new Map() };
  private ctxTree: Tree | null = null;
  /** Whether the file defines a Pinia store (a substring gate, see `piniaStoreOf`). */
  private pinia = false;
  /** The file registers Alpine.js components (`Alpine.data(…)`): a factory's returned methods are the template's handlers. */
  private alpine = false;

  override extractFunctions(tree: Tree, sourceText: string): FunctionInfo[] {
    this.beginFile(tree, sourceText);
    const functions = super.extractFunctions(tree, sourceText);
    if (sourceText.includes("]:")) this.extractKeyedRegistry(tree.rootNode, functions);
    if (this.ctx.dispatchProps.size > 0) for (const fn of functions) addDispatchPropCalls(fn, this.ctx.dispatchProps);
    return functions;
  }

  /**
   * A registry keyed by a constant, and the creators that name it — Radarr's
   * thunks, and every Redux codebase built the same way:
   *
   *   export const fetchMovies = createThunk(FETCH_MOVIES);
   *   handleThunks({ [FETCH_MOVIES]: createFetchHandler(section, '/movie') });
   *
   * `dispatch(fetchMovies())` runs the handler registered under the constant
   * `fetchMovies` was made with; the two share nothing but that constant. Each
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
    if (this.ctx.dispatchProps.size > 0) for (const c of classes) for (const m of c.methods) addDispatchPropCalls(m, this.ctx.dispatchProps);
    // Named zod schemas, as the request types a route validates with (zod-schemas.ts).
    classes.push(...extractZodSchemas(tree.rootNode, sourceText));
    return classes;
  }

  private beginFile(tree: Tree, sourceText: string): void {
    // Both entry points run for the same file in turn — compute once.
    if (this.ctxTree === tree) return;
    this.ctxTree = tree;
    this.pinia = sourceText.includes("defineStore");
    this.alpine = sourceText.includes("Alpine.data(");
    this.ctx = {
      jsdoc: JSDOC_TAG_RE.test(sourceText),
      tokenTypes: collectInjectionTokenTypes(tree.rootNode, sourceText),
      dispatchProps: sourceText.includes("connect(") ? dispatchPropsOf(tree.rootNode) : new Map(),
      moduleStrings: sourceText.includes("class ") ? moduleStringConstants(tree.rootNode) : new Map(),
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
        }
        this.extractJsFunctions(child, functions, true);
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
            const wrapped = value ? wrappedFunction(value) : null;
            const store = moduleLevel && this.pinia && name ? piniaStoreOf(decl) : null;
            if (store) {
              functions.push(this.piniaStoreFunction(store, decl, isExported));
            } else if (
              name &&
              value &&
              (value.type === "arrow_function" ||
                value.type === "function_expression")
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
            } else if (name && wrapped) {
              // `const save = useCallback(async () => {…}, [deps])`,
              // `const Row = memo((props) => …)` — the wrapper returns the
              // function it is given, so the binding names that function.
              functions.push(this.parseJsArrowOrExpr(name, wrapped, isExported));
            } else if (name && value?.type === "object" && moduleLevel && decl.childForFieldName("name")?.type === "identifier") {
              // `const Profile = { get: (u) => requests.get(…) }` — an API client
              // or service written as a namespace object. Its members are what
              // callers invoke (`agent.Profile.get`), and the api-calls inside
              // them need an enclosing symbol to belong to.
              this.extractObjectMembers(name, value, functions, isExported, 0);
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
    const params = this.extractJsParams(node.childForFieldName("parameters"), this.jsdocOf(node));
    const returnType = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
    const isAsync = node.text.startsWith("async ");
    const decorators = this.extractDecorators(node);

    const body = node.childForFieldName("body");
    const paramNames = new Set(params.map((p) => p.name));
    const templates = extractUrlTemplates(body, paramNames);
    const requestAccess = requestAccessOf(params, body);
    const responses = responsesOf(params, body);
    const { calls, localTypes } = finishBody(extractCalls(body, "typescript"), body, paramNames, this.ctx);
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
      ...urlTemplateFields(templates),
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
    const params = this.extractJsParams(
      funcNode.childForFieldName("parameters") ?? funcNode.childForFieldName("parameter"),
      this.jsdocOf(docAnchor),
    );
    const returnType = funcNode.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
    const isAsync = funcNode.text.startsWith("async ");

    const body = funcNode.childForFieldName("body") ?? funcNode;
    const paramNames = new Set(params.map((p) => p.name));
    const templates = extractUrlTemplates(body, paramNames);
    const requestAccess = requestAccessOf(params, body);
    const responses = responsesOf(params, body);
    const { calls, localTypes } = finishBody(extractCalls(body, "typescript"), body, paramNames, this.ctx);
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
      ...urlTemplateFields(templates),
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
   * and no click trace left the component (photoprism: 0 of 754 handlers).
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

  private extractObjectMembers(
    prefix: string | null,
    obj: Node,
    functions: FunctionInfo[],
    isExported: boolean,
    depth: number,
  ): void {
    for (const member of obj.namedChildren) {
      if (member.type === "pair") {
        const key = objectKeyName(member.childForFieldName("key"));
        const value = member.childForFieldName("value");
        if (!key || !value) continue;
        const name = prefix ? `${prefix}.${key}` : key;
        if (value.type === "arrow_function" || value.type === "function_expression") {
          functions.push(this.parseJsArrowOrExpr(name, value, isExported));
        } else if (value.type === "object" && depth < MAX_NAMESPACE_DEPTH) {
          this.extractObjectMembers(name, value, functions, isExported, depth + 1);
        }
      } else if (member.type === "method_definition") {
        const key = objectKeyName(member.childForFieldName("name"));
        if (!key) continue;
        const fn = this.parseJsFunction(member, isExported);
        fn.name = prefix ? `${prefix}.${key}` : key;
        functions.push(fn);
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
    } else if (this.pinia && (node.type === "lexical_declaration" || node.type === "variable_declaration")) {
      for (const decl of node.namedChildren) {
        const store = decl.type === "variable_declarator" ? piniaStoreOf(decl) : null;
        if (store) classes.push(this.piniaStoreClass(store, decl));
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

  private parseJsClass(node: Node, isExported: boolean): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
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
          const params = this.extractJsParams(paramsNode, this.jsdocOf(member));
          const returnType = member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
          const isAsync = member.text.startsWith("async ");
          const methodBody = member.childForFieldName("body");
          const requestAccess = requestAccessOf(params, methodBody);
          const responses = responsesOf(params, methodBody);
          const paramNames = new Set(params.map((p) => p.name));
          // A URL-builder helper is as often a service-class method
          // (`configService.APIUrl(sub)`) as a free function.
          const stripped: { base?: string | null } = {};
          const templates = extractUrlTemplates(methodBody, paramNames, stripped);
          // `static getCollectionResource() { return "albums"; }`: a resource method naming its path segment.
          const segment = templates.length === 0 && params.length === 0 && RESOURCE_METHOD.test(methodName) ? returnedSegment(methodBody) : null;
          if (segment) templates.push(segment);
          const { calls, localTypes } = finishBody(extractCalls(methodBody, "typescript"), methodBody, paramNames, this.ctx);
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
            ...urlTemplateFields(templates),
            ...(templates.length > 0 && stripped.base ? { urlTemplateBase: stripped.base } : {}),
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
          }
        } else if (member.type === "class_static_block") {
          concreteMembers++;
        }
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
        if (!value || (value.type !== "arrow_function" && value.type !== "function_expression")) continue;
        const field = left.childForFieldName("property")?.text;
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
      ...(isInterface ? { kind: "interface" as const } : {}),
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
    let declared = member.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null;
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
        type: info?.type ?? param.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null,
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
 * action creators, as a variable or inline — `{ lookupMovie, dispatchFetchX: fetchX }`
 * → `lookupMovie → lookupMovie`, `dispatchFetchX → fetchX`. The component calls
 * them as `this.props.lookupMovie()`, a name nothing defines.
 */
function dispatchPropsOf(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  const objects = new Map<string, Node>();
  for (const decl of root.descendantsOfType("variable_declarator")) {
    const name = decl.childForFieldName("name");
    const value = decl.childForFieldName("value");
    if (name?.type === "identifier" && value?.type === "object") objects.set(name.text, value);
  }
  for (const call of root.descendantsOfType("call_expression")) {
    if (call.childForFieldName("function")?.text !== "connect") continue;
    const arg = call.childForFieldName("arguments")?.namedChildren[1];
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

/** `this.props.lookupMovie(…)` also calls the creator `connect` bound to it. */
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
function returnedObject(fn: Node): Node | null {
  if (fn.type !== "arrow_function") return null;
  let body: Node | null = fn.childForFieldName("body");
  while (body?.type === "parenthesized_expression") body = body.namedChild(0);
  return body?.type === "object" ? body : null;
}
