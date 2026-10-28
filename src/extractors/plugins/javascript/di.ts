import type { Node } from "web-tree-sitter";
import { stripQuotes } from "../../shared/node-helpers.js";
import { isBuiltinType } from "../../shared/builtin-types.js";

/**
 * Dependency-injection facts for TS/JS — the shared vocabulary of the
 * injection-point extraction (functions-classes.ts), the receiver-type hook
 * (call-hooks.ts) and the variable-alias pass. Everything here reads ONE node
 * and reports what the source states: a token as written, a type named in a
 * type argument, a cast, or a constructed class. Nothing is looked up.
 */

/** A type plus the DI token/key a lookup or decorator named (see `ParamInfo.qualifier`). */
export interface InjectedType {
  /** The declared/derived type text, "" when only a token is known. */
  type: string;
  qualifier?: string;
}

/**
 * An identifier that names a class (`UserService`, `Injector`) rather than a
 * token constant (`USER_REPO`, `ANALYTICS`) or a value (`userToken`): leading
 * capital and at least one lowercase letter. A class token IS the type the
 * container hands out; any other token only selects a registration.
 */
export function isClassLikeName(name: string): boolean {
  return /^[A-Z][\w$]*$/.test(name) && /[a-z]/.test(name);
}

/** What a DI token argument is: a class (the requested type itself) or an opaque token. */
export type TokenRef = { kind: "class"; name: string } | { kind: "token"; text: string };

/**
 * A token argument as written: `UserService` (class), `USER_REPO` /
 * `TYPES.UserRepo` (token text as written), `'PAYMENT'` (string, unquoted),
 * `forwardRef(() => X)` (the class X — a deferred class reference). Null for
 * anything computed: a call, a template string, an expression.
 */
export function tokenRef(node: Node | null): TokenRef | null {
  if (!node) return null;
  switch (node.type) {
    case "identifier": {
      const text = node.text;
      return isClassLikeName(text) ? { kind: "class", name: text } : { kind: "token", text };
    }
    case "member_expression": {
      const text = node.text;
      return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(text) ? { kind: "token", text } : null;
    }
    case "string": {
      const text = stripQuotes(node.text);
      return text && !/\s/.test(text) ? { kind: "token", text } : null;
    }
    case "call_expression":
      return forwardRefTarget(node);
    default:
      return null;
  }
}

/** The token's text for a registration or a qualifier (`forwardRef(() => X)` → X). */
export function tokenTextOf(ref: TokenRef): string {
  return ref.kind === "class" ? ref.name : ref.text;
}

/** `forwardRef(() => X)` (NestJS / Angular) → class X. */
function forwardRefTarget(call: Node): TokenRef | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "identifier" || fn.text !== "forwardRef") return null;
  const arrow = call.childForFieldName("arguments")?.namedChild(0);
  if (arrow?.type !== "arrow_function") return null;
  const body = arrow.childForFieldName("body");
  return body && (body.type === "identifier" || body.type === "member_expression") ? tokenRef(body) : null;
}

/** Last segment of a dotted name (`ns.UserRepo` → UserRepo). */
export function lastSegment(text: string): string {
  return text.slice(text.lastIndexOf(".") + 1);
}

/**
 * The class a `new X(…)` expression constructs — bare simple name, type
 * arguments dropped (`new ns.Repo<User>()` → Repo). Parentheses, `await` and
 * a cast on top of the construction (`new X() as I`) are looked through: the
 * object is still an X. Null for anything that is not a construction.
 */
export function constructedClass(node: Node | null): string | null {
  const expr = unwrapExpression(node, true);
  if (expr?.type !== "new_expression") return null;
  const ctor = expr.childForFieldName("constructor");
  if (ctor?.type === "identifier") return ctor.text;
  if (ctor?.type === "member_expression") {
    const prop = ctor.childForFieldName("property");
    return prop ? prop.text : null;
  }
  return null;
}

/** Calls that return their argument, typed as it was: Vue's reactivity wrappers. */
const SAME_TYPE_WRAPPERS: ReadonlySet<string> = new Set(["reactive", "shallowReactive", "readonly", "shallowReadonly", "markRaw", "Object.freeze"]);

/** Parentheses, `await`, `x!` (and with `throughCasts`, `x as T` and a same-type wrapper) peeled off an expression. */
function unwrapExpression(node: Node | null, throughCasts: boolean): Node | null {
  let cur = node;
  for (let guard = 0; cur && guard < 6; guard++) {
    const t = cur.type;
    if (t === "parenthesized_expression" || t === "await_expression" || t === "non_null_expression") {
      cur = cur.namedChild(t === "await_expression" ? cur.namedChildCount - 1 : 0);
    } else if (throughCasts && (t === "as_expression" || t === "satisfies_expression")) {
      cur = cur.namedChild(0);
    } else if (throughCasts && t === "call_expression" && SAME_TYPE_WRAPPERS.has(cur.childForFieldName("function")?.text ?? "")) {
      // `reactive(new Session(…))`: Vue hands back the object it was given, made reactive.
      cur = cur.childForFieldName("arguments")?.namedChild(0) ?? null;
    } else {
      break;
    }
  }
  return cur;
}

// ── Container lookups ─────────────────────────────────────────────────────────

/**
 * Methods that ask a container for an instance: NestJS `app.get(X)` /
 * `moduleRef.get(X)` / `await app.resolve(X)`, Angular `injector.get(X)` /
 * `TestBed.inject(X)`, InversifyJS `container.get<T>(id)` / `getNamed` /
 * `getTagged` / `getAsync` / `resolve(X)`, tsyringe `container.resolve(X)`.
 * `getAll`/`resolveAll` return arrays and are deliberately absent.
 */
const LOOKUP_METHODS: ReadonlySet<string> = new Set([
  "get", "getAsync", "resolve", "inject",
  "getNamed", "getNamedAsync", "getTagged", "getTaggedAsync",
]);

/** Free functions that inject by token: Angular/Vue `inject(X)`, inversify-react `useInjection(X)`. */
const FREE_LOOKUPS: ReadonlySet<string> = new Set(["inject", "useInjection"]);

/**
 * Receivers that ARE a container, by the name the code gives them — the only
 * evidence a per-file pass has that `x.get(Foo)` is a lookup and not a Map
 * keyed by a class (a CQRS handler registry) or an HTTP client. The last
 * segment counts (`this.moduleRef`, `ref.injector`, `fixture.debugElement.injector`).
 */
const CONTAINER_RECEIVER_RE = /(?:container|injector|moduleref|kernel)$/i;
/**
 * NestJS application / testing-module handles. They also answer `.get(...)`
 * in other frameworks (Express settings: `app.get('port')`), so a lookup on
 * one of these must name a class or carry a type argument.
 */
const APP_RECEIVERS: ReadonlySet<string> = new Set([
  "app", "application", "nestApp", "module", "testingModule", "moduleFixture", "TestBed",
]);

/** Name of a receiver expression's last segment, or null for `this`/calls/anything else. */
function receiverName(node: Node): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "member_expression") return node.childForFieldName("property")?.text ?? null;
  return null;
}

/**
 * A container lookup call → the type it returns and the token it named.
 * `inject(UserService)` → UserService; `inject<Notifier>(NOTIFIER)` →
 * Notifier + NOTIFIER; `container.get<IUserRepo>(TYPES.UserRepo)` → IUserRepo
 * + TYPES.UserRepo; `container.get(TYPES.Mailer)` → "" + TYPES.Mailer;
 * `container.getNamed<ILogger>(TYPES.Logger, 'file')` → ILogger + `file` (the
 * name selects among the token's registrations — see `inversifyChain` in
 * di-bindings.ts for the matching side). Null when the call is not one.
 */
export function containerLookup(call: Node): InjectedType | null {
  if (call.type !== "call_expression") return null;
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  let method: string;
  let strongReceiver = true;
  if (fn.type === "identifier") {
    method = fn.text;
    if (!FREE_LOOKUPS.has(method)) return null;
  } else if (fn.type === "member_expression") {
    method = fn.childForFieldName("property")?.text ?? "";
    if (!LOOKUP_METHODS.has(method)) return null;
    const obj = fn.childForFieldName("object");
    const recv = obj ? receiverName(obj) : null;
    if (!recv) return null;
    if (!CONTAINER_RECEIVER_RE.test(recv)) {
      if (!APP_RECEIVERS.has(recv)) return null;
      strongReceiver = false;
    }
  } else {
    return null;
  }

  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  const tok = tokenRef(args[0] ?? null);
  if (!tok) return null;
  const named = method.startsWith("getNamed");
  const tagged = method.startsWith("getTagged");
  // Extra arguments a lookup takes: Angular `inject(X, { optional: true })` /
  // `injector.get(X, null)`, NestJS `get(X, { strict: false })`. Anything
  // else (`app.get('/path', handler)`) is not a lookup.
  if (!named && !tagged && fn.type === "member_expression" && args.length > 1) {
    const extra = args[1]!.type;
    if (args.length > 2 || (extra !== "object" && extra !== "null" && extra !== "undefined" && extra !== "member_expression")) {
      return null;
    }
  }

  const typeArg = firstTypeArgument(call);
  // `app.get('port')` (Express settings) vs `app.get<Cfg>(CONFIG)`: on an app
  // handle only a class token or an explicit type says "container".
  if (!strongReceiver && tok.kind !== "class" && !typeArg) return null;

  let qualifier: string | undefined;
  if (named) {
    const name = literalText(args[1] ?? null);
    qualifier = name ?? (tok.kind === "token" ? tok.text : undefined);
  } else if (tagged) {
    const key = literalText(args[1] ?? null);
    const value = args[2] ? literalText(args[2]) ?? args[2].text : null;
    qualifier = key !== null && value !== null ? `${key}=${value}` : undefined;
  } else if (!typeArg || !restatesType(tokenTextOf(tok), typeArg)) {
    // A class token with no type argument IS the type; any other token —
    // or a class token cast to another type — selects a registration.
    if (tok.kind === "token" || typeArg) qualifier = tokenTextOf(tok);
  }
  const type = typeArg ?? (tok.kind === "class" ? tok.name : "");
  if (!type && !qualifier) return null;
  return qualifier ? { type, qualifier } : { type };
}

/** A string literal unquoted, or a plain identifier/number/boolean as written. */
function literalText(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "string") return stripQuotes(node.text);
  if (node.type === "identifier" || node.type === "number" || node.type === "true" || node.type === "false") {
    return node.text;
  }
  return null;
}

/** The first type argument of a call (`get<IUserRepo>(…)` → `IUserRepo`), when it is a type reference. */
function firstTypeArgument(call: Node): string | null {
  const typeArgs = call.childForFieldName("type_arguments");
  const first = typeArgs?.namedChild(0);
  return first ? referenceTypeText(first) : null;
}

/** Type node kinds that name a type a member call can land on (no unions, arrays, literals, objects). */
const REFERENCE_TYPE_NODES: ReadonlySet<string> = new Set(["type_identifier", "generic_type", "nested_type_identifier"]);

/** A type node's text when it names a non-builtin type (`UserRepo`, `Repo<User>`, `ns.Repo`), else null. */
function referenceTypeText(node: Node): string | null {
  if (!REFERENCE_TYPE_NODES.has(node.type)) return null;
  const text = node.text;
  return isBuiltinType(lastSegment(bareTypeName(text)), "typescript") ? null : text;
}

/**
 * Whether a type text can name what a member call lands on: one type
 * reference (`UserRepo`, `Repo<User>`, `ns.Repo`, `UserRepo | undefined`), not
 * an array, function, object-literal or builtin type (`string[]`, `Set`,
 * `Promise<T>`, `unknown`). Locals typed otherwise are not worth reporting —
 * the same rule the Java plugin applies to its locals.
 */
export function namesReceiverType(text: string): boolean {
  const members = text.split("|").map((m) => m.trim()).filter((m) => m && m !== "null" && m !== "undefined");
  if (members.length !== 1) return false;
  const bare = bareTypeName(members[0]!);
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(bare) || members[0]!.endsWith("]")) return false;
  return !isBuiltinType(lastSegment(bare), "typescript");
}

/** `Repo<User>` → `Repo` (dotted names kept). */
export function bareTypeName(text: string): string {
  const cut = text.indexOf("<");
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

/**
 * The type a receiver EXPRESSION evaluates to, when the expression states it:
 * a container lookup (`moduleRef.get(ReportService)`), a cast
 * (`(this.gadget as GadgetService)`, `(<GadgetService>x)`) — through
 * parentheses, `await` and `!`. A cast to a builtin or a non-reference type
 * (`as any`, `as User[]`, `as const`) states nothing a member call can use.
 * The lookup's token survives a cast (`(container.get(TYPES.X) as IX)`).
 */
export function expressionType(node: Node | null): InjectedType | null {
  const expr = unwrapExpression(node, false);
  if (!expr) return null;
  if (expr.type === "call_expression") return containerLookup(expr);
  if (expr.type === "as_expression") {
    const typeNode = expr.namedChild(expr.namedChildCount - 1);
    const type = typeNode ? referenceTypeText(typeNode) : null;
    if (!type) return null;
    const inner = expressionType(expr.namedChild(0));
    return inner?.qualifier ? { type, qualifier: inner.qualifier } : { type };
  }
  if (expr.type === "type_assertion") {
    const typeNode = expr.namedChild(0)?.namedChild(0);
    const type = typeNode ? referenceTypeText(typeNode) : null;
    return type ? { type } : null;
  }
  return null;
}

/** Receiver node types `expressionType` can say anything about — the hook's cheap bail-out. */
const TYPED_RECEIVER_NODES: ReadonlySet<string> = new Set([
  "call_expression", "parenthesized_expression", "non_null_expression",
]);

/**
 * `meta.calls.receiverTypeOf`: the receiver of `<expr>.m()` when `<expr>` is
 * a container lookup or a cast chained straight into the call
 * (`this.injector.get(UserService).countUsers()`,
 * `container.get<IUserRepo>(TYPES.UserRepo).fetchUserById(1)`,
 * `(this.gadget as GadgetService).buffGadget()`). Called for every call node,
 * so it bails out on the receiver's node type before reading any text.
 */
export function receiverTypeOfCall(node: Node): InjectedType | null {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "member_expression") return null;
  const obj = fn.childForFieldName("object");
  if (obj?.type === "identifier") return blockLocalType(node, obj.text);
  if (!obj || !TYPED_RECEIVER_NODES.has(obj.type)) return null;
  return expressionType(obj);
}

/** Where a function's own scope ends: a block directly under one of these is the function's body. */
const FUNCTION_BOUNDARIES: ReadonlySet<string> = new Set([
  "function_declaration", "generator_function_declaration", "function_expression", "generator_function",
  "arrow_function", "method_definition", "class_body", "program",
]);

/** Per tree: each nested block's `let`/`const` declarations, by name. */
let blockLocals: { tree: unknown; byBlock: Map<number, Map<string, { line: number; type: InjectedType | null }>> } | null = null;

/**
 * The type a block-scoped `let`/`const` of a nested block states for `name`,
 * when one declared before the call encloses it (`if (x) { let v = new Truck();
 * v.drive() }` inside `g(v: Car)`): that binding shadows the parameter or outer
 * local of the same name there, and only there. The type is the annotation or
 * the constructed class (`new Truck()`), or what a cast or container lookup
 * states. Null when no nested block declares the name, or its declaration
 * states no type.
 */
function blockLocalType(call: Node, name: string): InjectedType | null {
  const line = call.startPosition.row + 1;
  for (let p = call.parent; p; p = p.parent) {
    if (FUNCTION_BOUNDARIES.has(p.type)) return null;
    if (p.type !== "statement_block" || !p.parent || FUNCTION_BOUNDARIES.has(p.parent.type)) continue;
    const hit = declarationsOf(p).get(name);
    if (hit && hit.line <= line) return hit.type;
  }
  return null;
}

function declarationsOf(block: Node): Map<string, { line: number; type: InjectedType | null }> {
  if (blockLocals?.tree !== block.tree) blockLocals = { tree: block.tree, byBlock: new Map() };
  const cached = blockLocals.byBlock.get(block.id);
  if (cached) return cached;
  const out = new Map<string, { line: number; type: InjectedType | null }>();
  for (const stmt of block.namedChildren) {
    if (stmt?.type !== "lexical_declaration") continue;
    for (const decl of stmt.namedChildren) {
      if (decl?.type !== "variable_declarator") continue;
      const id = decl.childForFieldName("name");
      if (id?.type !== "identifier" || out.has(id.text)) continue;
      const annotation = decl.childForFieldName("type")?.namedChild(0);
      const value = decl.childForFieldName("value");
      let type: InjectedType | null = annotation ? (referenceTypeText(annotation) ? { type: referenceTypeText(annotation)! } : null) : null;
      if (!type && value?.type === "new_expression") {
        const ctor = value.childForFieldName("constructor");
        const written = ctor?.type === "identifier" ? ctor.text : ctor?.type === "member_expression" ? ctor.childForFieldName("property")?.text : null;
        if (written && /^[A-Z]/.test(written)) type = { type: written };
      }
      if (!type && value) type = expressionType(value);
      out.set(id.text, { line: decl.startPosition.row + 1, type });
    }
  }
  blockLocals.byBlock.set(block.id, out);
  return out;
}

// ── Injection decorators ─────────────────────────────────────────────────────

/** `@Inject(TOKEN)` (NestJS/Angular), `@inject(TYPES.X)` (InversifyJS/tsyringe), `@lazyInject(id)`. */
const INJECT_DECORATORS: ReadonlySet<string> = new Set(["Inject", "inject", "lazyInject"]);
/** InversifyJS `@named('n')` / `@Named` — selects a `whenTargetNamed('n')` registration. */
const NAMED_DECORATORS: ReadonlySet<string> = new Set(["named", "Named"]);

/** Decorator → `[name, args]` for `@name(args…)`, null for a bare `@name`. */
function decoratorCall(decorator: Node): { name: string; args: Node[] } | null {
  const call = decorator.namedChild(0);
  if (call?.type !== "call_expression") return null;
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  const name = fn.type === "identifier" ? fn.text : fn.type === "member_expression" ? fn.childForFieldName("property")?.text ?? "" : "";
  return { name, args: call.childForFieldName("arguments")?.namedChildren ?? [] };
}

/**
 * What a parameter's or field's injection decorators say: the token
 * (`@Inject(USER_REPO)`, `@inject(TYPES.UserRepo)`, `@Inject('PAYMENT')`,
 * `@Inject(forwardRef(() => X))`) or, when present, the InversifyJS name
 * (`@named('file')` / `@tagged('k', v)` → `k=v`) — the name is what picks
 * among one token's registrations.
 *
 * A class token equal to the declared type is not reported as a qualifier: it
 * restates the type, and a qualifier makes the linker look for a registration
 * carrying that NAME (`@Inject(ClockService) clock: ClockService` would then
 * miss `{ provide: ClockService, useClass: FakeClock }`). With no declared type
 * the class token becomes the type, and a same-file `InjectionToken<T>`
 * (`tokenTypes`) gives a token's type.
 */
export function injectionOf(
  node: Node,
  declaredType: string | null,
  tokenTypes: ReadonlyMap<string, string>,
): { type?: string; qualifier?: string } {
  let token: TokenRef | null = null;
  let named: string | null = null;
  for (const child of node.children) {
    if (child.type !== "decorator") continue;
    const dec = decoratorCall(child);
    if (!dec) continue;
    if (INJECT_DECORATORS.has(dec.name)) {
      token = tokenRef(dec.args[0] ?? null) ?? token;
    } else if (NAMED_DECORATORS.has(dec.name)) {
      named = literalText(dec.args[0] ?? null) ?? named;
    } else if (dec.name === "tagged") {
      const key = literalText(dec.args[0] ?? null);
      const value = dec.args[1] ? literalText(dec.args[1]) ?? dec.args[1].text : null;
      if (key !== null && value !== null) named = `${key}=${value}`;
    }
  }
  const out: { type?: string; qualifier?: string } = {};
  if (token && !declaredType) {
    if (token.kind === "class") {
      out.type = token.name;
    } else {
      out.qualifier = token.text;
      const t = tokenTypes.get(token.text);
      if (t) out.type = t;
    }
  } else if (token && declaredType && !restatesType(tokenTextOf(token), declaredType)) {
    out.qualifier = tokenTextOf(token);
  }
  if (named !== null) out.qualifier = named;
  return out;
}

/**
 * A token that restates the declared type (`ClockService` for `ClockService`,
 * `ClockService | undefined`, `ClockService<X>`; tsyringe's
 * `@inject('IAccountRepo') repo: IAccountRepo`) is not a qualifier: the
 * linker matches a qualifier against registration NAMES, so repeating the
 * type there would hide the by-type registration it denotes.
 */
export function restatesType(token: string, declaredType: string): boolean {
  const t = declaredType.trim();
  return t.startsWith(token) && !/[\w$.]/.test(t.charAt(token.length));
}

/**
 * The type (and token) a field or local initializer states: a construction
 * (`new GadgetService()`), a container lookup (`inject(UserService)`,
 * `this.moduleRef.get(ReportService)`, `await app.resolve(X)`), a cast
 * (`x as T`). `inject(ANALYTICS)` with `const ANALYTICS = new
 * InjectionToken<IAnalytics>(…)` in the same file takes the token's type.
 */
export function initializerType(value: Node, tokenTypes: ReadonlyMap<string, string>): InjectedType | null {
  const ctor = constructedClass(value);
  if (ctor) {
    // `new X() as I` keeps the object an X; only report the construction.
    return { type: ctor };
  }
  const found = expressionType(value);
  if (!found) return null;
  if (!found.type && found.qualifier) {
    const t = tokenTypes.get(found.qualifier);
    if (t) return { type: t, qualifier: found.qualifier };
  }
  return found;
}

/**
 * `const X = new InjectionToken<T>(…)` / `const X: InjectionToken<T> = …` at
 * the top of a module → X → T. Angular's typed token: `inject(X)` returns a T.
 * Same file only — a token imported from elsewhere still works as a
 * qualifier, the registration decides.
 */
export function collectInjectionTokenTypes(root: Node, sourceText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!sourceText.includes("InjectionToken")) return out;
  for (const stmt of root.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;
    if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;
    for (const d of decl.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      if (name?.type !== "identifier") continue;
      const annotated = d.childForFieldName("type")?.namedChild(0);
      const value = d.childForFieldName("value");
      let t: string | null = null;
      if (annotated?.type === "generic_type" && annotated.childForFieldName("name")?.text === "InjectionToken") {
        const arg = annotated.childForFieldName("type_arguments")?.namedChild(0);
        t = arg ? referenceTypeText(arg) : null;
      } else if (value?.type === "new_expression" && value.childForFieldName("constructor")?.text === "InjectionToken") {
        const arg = value.childForFieldName("type_arguments")?.namedChild(0);
        t = arg ? referenceTypeText(arg) : null;
      }
      if (t) out.set(name.text, t);
    }
  }
  return out;
}
