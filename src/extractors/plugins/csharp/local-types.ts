import type { Node } from "web-tree-sitter";
import type { FunctionInfo } from "../../../types/analysis.js";
import { CSHARP_BUILTINS } from "./builtins.js";

/**
 * What a C# expression or declaration says about the TYPE of a value — the
 * facts the symbol linker needs to send `x.Method()` to the class `x` really
 * is: a local's declared or constructed type, a service-locator lookup
 * (`sp.GetRequiredService<IPricing>()`, Autofac `c.Resolve<T>()`), a cast, and
 * the DI key an injection point or lookup names. Only what the source states;
 * an initializer whose type would need inference (`var x = Make()`) gives
 * nothing.
 */

export interface StaticType {
  /** The type as written (`IRepo<User>`, `Shop.Domain.IAudit`) — core normalizes it. */
  type: string;
  /** The DI key the lookup named (`GetRequiredKeyedService<T>("k")` → `k`). */
  qualifier?: string;
}

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/** Generic container lookups whose type argument is the type they return. */
const LOOKUPS: ReadonlySet<string> = new Set([
  "GetRequiredService", "GetService", // Microsoft.Extensions.DependencyInjection
  "Resolve", "ResolveOptional", // Autofac (Unity/DryIoc spell `Resolve<T>` the same)
  "GetInstance", // Simple Injector
]);

/** The keyed/named lookups: the first argument is the key. */
const KEYED_LOOKUPS: ReadonlySet<string> = new Set([
  "GetRequiredKeyedService", "GetKeyedService", // .NET 8 keyed services
  "ResolveNamed", "ResolveKeyed", "ResolveOptionalNamed", "ResolveOptionalKeyed", // Autofac
]);

/** Declared-type node kinds that can name a project class (not `int`, arrays, tuples, `ref T`). */
const NAMED_TYPE_NODES: ReadonlySet<string> = new Set([
  "identifier", "generic_name", "qualified_name", "nullable_type", "alias_qualified_name",
]);

/**
 * Function-expression scopes: an anonymous one (passed as an argument) runs on
 * behalf of the enclosing member — the call walk descends into it (see
 * call-hooks.ts) — so its typed parameters and locals belong to that member
 * too. One bound to a name is a scope of its own.
 */
const FUNCTION_EXPRESSIONS: ReadonlySet<string> = new Set(["lambda_expression", "anonymous_method_expression"]);

/** The method name and type arguments of a callee's name node (`AddScoped<IFoo, Foo>` / `Add`). */
export function methodNameOf(nameNode: Node | null): { method: string; typeArgs: Node[] } | null {
  if (!nameNode) return null;
  if (nameNode.type === "identifier") return { method: nameNode.text, typeArgs: [] };
  if (nameNode.type !== "generic_name") return null;
  let method = "";
  let typeArgs: Node[] = [];
  for (const child of nameNode.namedChildren) {
    if (child.type === "identifier") method = child.text;
    else if (child.type === "type_argument_list") typeArgs = child.namedChildren;
  }
  return method ? { method, typeArgs } : null;
}

/** Strip what does not change a value's type: `(x)`, the null-forgiving `x!`. */
export function unwrapExpression(node: Node): Node {
  let cur = node;
  for (;;) {
    if (cur.type === "parenthesized_expression") {
      const inner = cur.namedChild(0);
      if (!inner) return cur;
      cur = inner;
    } else if (cur.type === "postfix_unary_expression" && cur.child(cur.childCount - 1)?.type === "!") {
      const inner = cur.namedChild(0);
      if (!inner) return cur;
      cur = inner;
    } else {
      return cur;
    }
  }
}

/** Positional/named argument expressions of a call or construction. */
export function argumentsOf(call: Node): Array<{ name: string | null; expr: Node }> {
  const list = call.childForFieldName("arguments");
  if (!list) return [];
  const out: Array<{ name: string | null; expr: Node }> = [];
  for (const arg of list.namedChildren) {
    if (arg.type !== "argument") continue;
    let name: string | null = null;
    let expr: Node | null = null;
    for (const part of arg.namedChildren) {
      if (part.type === "name_colon") name = part.namedChild(0)?.text ?? null;
      else expr = part;
    }
    if (expr) out.push({ name, expr });
  }
  return out;
}

/**
 * A DI key as both sides spell it: a string literal's content (`"blob"` →
 * `blob`, `@"blob"` too), `nameof(BlobStorage)` → `BlobStorage` (what it
 * evaluates to), anything else (`Keys.Blob`, a const) as its source text.
 */
export function keyText(expr: Node): string | null {
  const node = unwrapExpression(expr);
  const text = node.text;
  switch (node.type) {
    case "string_literal":
      return text.slice(1, -1);
    case "verbatim_string_literal":
      return text.slice(2, -1);
    case "raw_string_literal":
      return text.replace(/^"{3,}|"{3,}$/g, "").trim();
    case "invocation_expression": {
      const fn = node.childForFieldName("function");
      if (fn?.type === "identifier" && fn.text === "nameof") {
        const arg = argumentsOf(node)[0]?.expr;
        return arg ? (arg.text.split(".").pop() ?? null) : null;
      }
      break;
    }
  }
  const collapsed = text.replace(/\s+/g, "");
  return collapsed.length > 0 ? collapsed : null;
}

/**
 * A container lookup's result type: `sp.GetRequiredService<IFoo>()`,
 * `sp.GetService<IFoo>()`, `sp.GetRequiredKeyedService<IFoo>("k")` (key →
 * qualifier), Autofac `c.Resolve<IFoo>()` / `c.ResolveNamed<IFoo>("n")`.
 * Non-generic `GetService(typeof(T))` returns `object` — its type comes from
 * the cast around it (see `staticTypeOf`).
 */
export function containerLookup(invocation: Node): StaticType | null {
  const fn = invocation.childForFieldName("function");
  if (fn?.type !== "member_access_expression") return null;
  const name = fn.childForFieldName("name");
  if (name?.type !== "generic_name") return null;
  const m = methodNameOf(name);
  if (!m || m.typeArgs.length !== 1) return null;
  const keyed = KEYED_LOOKUPS.has(m.method);
  if (!keyed && !LOOKUPS.has(m.method)) return null;
  const out: StaticType = { type: m.typeArgs[0]!.text };
  const first = argumentsOf(invocation)[0]?.expr;
  if (keyed) {
    const key = first ? keyText(first) : null;
    if (!key) return null;
    out.qualifier = key;
  } else if (m.method === "Resolve" && first && isStringLiteral(first)) {
    // Unity's named resolve: `container.Resolve<IFoo>("name")`.
    out.qualifier = keyText(first) ?? undefined;
  }
  return out;
}

function isStringLiteral(node: Node): boolean {
  const t = unwrapExpression(node).type;
  return t === "string_literal" || t === "verbatim_string_literal" || t === "raw_string_literal";
}

/**
 * The type an expression evaluates to, when the expression states it:
 * a construction (`new Foo(..)`), a cast (`(IFoo)x`), `x as IFoo`, a
 * container lookup. Null for anything that would need inference.
 */
export function staticTypeOf(expr: Node): StaticType | null {
  const node = unwrapExpression(expr);
  switch (node.type) {
    case "object_creation_expression":
    case "cast_expression": {
      const type = node.childForFieldName("type");
      return type ? { type: type.text } : null;
    }
    case "as_expression": {
      const type = node.childForFieldName("right");
      return type ? { type: type.text } : null;
    }
    case "invocation_expression":
      return containerLookup(node);
  }
  return null;
}

/** `Shop.Domain.IRepo<User>?` → `IRepo`; null when no class name is left. */
export function bareTypeName(text: string): string | null {
  let t = text.replace(/\s+/g, "").replace(/^global::/, "");
  const lt = t.indexOf("<");
  if (lt >= 0) t = t.slice(0, lt);
  t = t.replace(/\?$/, "");
  const colons = t.lastIndexOf("::");
  if (colons >= 0) t = t.slice(colons + 2);
  t = t.slice(t.lastIndexOf(".") + 1);
  return /^[A-Za-z_]\w*$/.test(t) ? t : null;
}

/** A type that can be a project class: not a keyword type, not a known BCL type. */
function isProjectTypeCandidate(text: string): boolean {
  const bare = bareTypeName(text);
  return bare !== null && !CSHARP_BUILTINS.has(bare);
}

/**
 * `meta.calls.receiverTypeOf`: the receiver of `x.M()` is typed by the
 * expression itself — a container lookup chained into the call
 * (`sp.GetRequiredService<IPricing>().Quote(o)`, `c.ResolveNamed<IStore>("n").Find()`),
 * a construction (`new Foo().Run()`) or a cast (`((IFoo)x).Run()`). Called for
 * every call node, so it bails out on the callee's and receiver's node types
 * before reading any text.
 */
export function csharpReceiverTypeOf(node: Node): StaticType | null {
  if (node.type !== "invocation_expression") return null;
  const callee = node.childForFieldName("function");
  if (!callee) return null;
  let receiver: Node | null;
  if (callee.type === "member_access_expression") receiver = callee.childForFieldName("expression");
  else if (callee.type === "conditional_access_expression") receiver = callee.childForFieldName("condition");
  else return null;
  if (!receiver) return null;
  const t = receiver.type;
  if (
    t !== "invocation_expression" && t !== "parenthesized_expression" && t !== "postfix_unary_expression" &&
    t !== "object_creation_expression"
  ) return null;
  const found = staticTypeOf(receiver);
  return found && isProjectTypeCandidate(found.type) ? found : null;
}

/**
 * Attributes that name the DI key an injection point is resolved by:
 * `[FromKeyedServices("k")]` (.NET 8 parameters), Autofac `[KeyFilter("k")]`
 * (constructor parameters), Unity `[Dependency("name")]`, Blazor
 * `[Inject(Key = "k")]` (properties). Attribute name → the argument holding
 * the key (`null` = first positional).
 */
export const PARAM_KEY_ATTRIBUTES: ReadonlyMap<string, string | null> = new Map([
  ["FromKeyedServices", null], ["KeyFilter", null], ["Dependency", null],
]);
export const PROPERTY_KEY_ATTRIBUTES: ReadonlyMap<string, string | null> = new Map([
  ["Inject", "Key"], ["Dependency", null],
]);

/** The DI key the attributes on a parameter/property name, if any. */
export function injectionKey(owner: Node, attributes: ReadonlyMap<string, string | null>): string | undefined {
  for (const list of owner.children) {
    if (list.type !== "attribute_list") continue;
    for (const attr of list.namedChildren) {
      if (attr.type !== "attribute") continue;
      const rawName = attr.childForFieldName("name")?.text ?? "";
      const name = rawName.split(".").pop()!.replace(/Attribute$/, "");
      if (!attributes.has(name)) continue;
      const wanted = attributes.get(name)!;
      const argList = attr.namedChildren.find((c) => c.type === "attribute_argument_list");
      for (const arg of argList?.namedChildren ?? []) {
        if (arg.type !== "attribute_argument") continue;
        // `Key = "k"` (a `name` field, or name_equals) / `key: "k"` / positional.
        const nameField = arg.childForFieldName("name");
        let argName: string | null = nameField?.text ?? null;
        let value: Node | null = null;
        for (const part of arg.namedChildren) {
          if (part.type === "name_equals" || part.type === "name_colon") argName = part.namedChild(0)?.text ?? argName;
          else if (part.id !== nameField?.id) value = part;
        }
        if (!value) continue;
        if (wanted === null ? argName === null : argName === wanted) {
          const key = keyText(value);
          if (key) return key;
        }
      }
    }
  }
  return undefined;
}

/**
 * Typed locals of a file's top-level statements (`Program.cs`:
 * `var pricing = app.Services.GetRequiredService<IPricing>();`) — the scope of
 * core's `<setup>` pseudo-function. Its call walk stops at every lambda, so
 * lambdas are boundaries here too. Core has no hook that hands `<setup>` its
 * locals yet; this is what one would call.
 */
export function extractCsharpTopLevelLocalTypes(root: Node): LocalType[] | undefined {
  const statements = root.namedChildren.filter((c) => c.type === "global_statement");
  if (statements.length === 0) return undefined;
  const found = statements.flatMap((s) => s.descendantsOfType(SCOPE_NODE_TYPES));
  return localTypesFrom(found, new Set(statements.map((s) => s.id)), false);
}

/** The node kinds a body's typed locals (and the reassignments that qualify them) come from. */
const SCOPE_NODE_TYPES = [
  "variable_declaration", "foreach_statement", "declaration_pattern", "declaration_expression",
  "lambda_expression", "assignment_expression",
];

/**
 * One file's declaration/assignment nodes, queried ONCE and sliced per member
 * body. `descendantsOfType` costs a fixed ~25 µs per call before it walks
 * anything (it maps type names to grammar symbols in JS), which per method
 * body was as much as the call walk itself; one query per file is not.
 */
export class FileScopeNodes {
  private nodes: Node[] | null = null;
  constructor(private readonly root: Node) {}

  /** Nodes of `types` that start inside `scope`, in document order. */
  within(scope: Node, types?: ReadonlySet<string>): Node[] {
    const nodes = (this.nodes ??= this.root.descendantsOfType(SCOPE_NODE_TYPES));
    const start = scope.startIndex;
    const end = scope.endIndex;
    let lo = 0;
    let hi = nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (nodes[mid]!.startIndex < start) lo = mid + 1;
      else hi = mid;
    }
    const out: Node[] = [];
    for (let i = lo; i < nodes.length && nodes[i]!.startIndex < end; i++) {
      const n = nodes[i]!;
      if (n.id !== scope.id && (!types || types.has(n.type))) out.push(n);
    }
    return out;
  }

  /**
   * Typed locals of a member body (`FunctionInfo.localTypes`):
   *   - `var x = <expr>` — the type `<expr>` states (`new Foo()`, a cast, a
   *     container lookup — with its key);
   *   - `T x = new U()` — `U` when `x` is never reassigned in the body (the object
   *     is exactly a `U`), else the declared `T`;
   *   - `T x = …` / `T x;` / `T x = new()` — `T`;
   *   - `foreach (T x in …)`, `o is T x`, `out T x`, and the typed parameters of a
   *     lambda passed as an argument (`(IRepo r) => r.All()`).
   * A name declared with two different types in one body (two sibling blocks)
   * is left out — the call list cannot tell which one a call used.
   */
  localTypesOf(body: Node | null): LocalType[] | undefined {
    return body ? localTypesFrom(this.within(body), new Set([body.id]), true) : undefined;
  }
}

function localTypesFrom(found: Node[], scopeIds: ReadonlySet<number>, intoLambdas: boolean): LocalType[] | undefined {
  if (found.length === 0) return undefined;

  const reassigned = new Set<string>();
  const byName = new Map<string, LocalType | null>();
  const add = (name: string | undefined, type: string | undefined, qualifier?: string): void => {
    if (!name || !type) return;
    const entry: LocalType = { name, type };
    if (qualifier) entry.qualifier = qualifier;
    const prev = byName.get(name);
    if (prev === undefined) byName.set(name, entry);
    else if (prev && (prev.type !== type || prev.qualifier !== qualifier)) byName.set(name, null);
  };
  // Declarations whose type depends on whether the name is reassigned.
  const constructed: Array<{ name: string; declared: string; built: string }> = [];

  for (const node of found) {
    if (node.type === "assignment_expression") {
      // Any scope: a closure can reassign the local it captures.
      const left = node.childForFieldName("left");
      if (left?.type === "identifier") reassigned.add(left.text);
      continue;
    }
    if (!inScope(node, scopeIds, intoLambdas)) continue;
    switch (node.type) {
      case "variable_declaration": {
        const typeNode = node.childForFieldName("type");
        if (!typeNode) break;
        const implicit = typeNode.type === "implicit_type";
        if (!implicit && !NAMED_TYPE_NODES.has(typeNode.type)) break;
        for (const decl of node.namedChildren) {
          if (decl.type !== "variable_declarator") continue;
          const nameNode = decl.childForFieldName("name");
          const name = nameNode?.text;
          if (!name) continue;
          const init = decl.namedChildren.find((c) => c.id !== nameNode!.id && c.type !== "bracketed_argument_list");
          const stated = init ? staticTypeOf(init) : null;
          if (implicit) {
            if (stated) add(name, stated.type, stated.qualifier);
          } else if (stated && init && unwrapExpression(init).type === "object_creation_expression") {
            constructed.push({ name, declared: typeNode.text, built: stated.type });
          } else {
            add(name, typeNode.text, stated?.qualifier);
          }
        }
        break;
      }
      case "foreach_statement": {
        const typeNode = node.childForFieldName("type");
        const left = node.childForFieldName("left");
        if (typeNode && NAMED_TYPE_NODES.has(typeNode.type) && left?.type === "identifier") add(left.text, typeNode.text);
        break;
      }
      case "declaration_pattern":
      case "declaration_expression": {
        const typeNode = node.childForFieldName("type");
        const nameNode = node.childForFieldName("name");
        if (typeNode && NAMED_TYPE_NODES.has(typeNode.type) && nameNode?.type === "identifier") add(nameNode.text, typeNode.text);
        break;
      }
      case "lambda_expression": {
        if (!intoLambdas || !isAnonymousFunctionExpression(node)) break;
        const params = node.childForFieldName("parameters");
        if (params?.type !== "parameter_list") break;
        for (const p of params.namedChildren) {
          if (p.type !== "parameter") continue;
          const typeNode = p.childForFieldName("type");
          if (!typeNode || !NAMED_TYPE_NODES.has(typeNode.type)) continue;
          add(p.childForFieldName("name")?.text, typeNode.text, injectionKey(p, PARAM_KEY_ATTRIBUTES));
        }
        break;
      }
    }
  }
  for (const c of constructed) add(c.name, reassigned.has(c.name) ? c.declared : c.built);

  const out: LocalType[] = [];
  for (const entry of byName.values()) if (entry) out.push(entry);
  return out.length > 0 ? out : undefined;
}

/** A function expression that is not bound to a name (passed as an argument, assigned to an event). */
export function isAnonymousFunctionExpression(node: Node): boolean {
  return FUNCTION_EXPRESSIONS.has(node.type) && node.parent?.type !== "variable_declarator";
}

/**
 * Is `node` in the scope's own code — not inside a local function or a
 * named lambda (both scopes of their own, whose calls are not the body's)?
 * An anonymous lambda is part of a member body's scope (call-hooks.ts
 * descends into it the same way).
 */
function inScope(node: Node, scopeIds: ReadonlySet<number>, intoLambdas: boolean): boolean {
  for (let p = node.parent; p && !scopeIds.has(p.id); p = p.parent) {
    if (p.type === "local_function_statement") return false;
    if (FUNCTION_EXPRESSIONS.has(p.type) && (!intoLambdas || !isAnonymousFunctionExpression(p))) return false;
  }
  return true;
}
