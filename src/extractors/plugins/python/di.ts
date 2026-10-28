import type { Node, Tree } from "web-tree-sitter";
import type { DiBinding, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { callChainText } from "../../shared/call-graph.js";

/**
 * Dependency injection as Python code spells it — the facts the symbol linker
 * needs to send `self.repo.find()` to the class a container actually builds:
 *
 *  - instance attributes an `__init__` (or any method) assigns from a typed
 *    parameter or a construction, typed locals, and the docstring / type
 *    comment types of untyped parameters;
 *  - injection tokens on parameters (FastAPI `Depends(get_repo)`,
 *    dependency-injector `Provide[Container.repo]`);
 *  - container registrations (dependency-injector providers, `injector`
 *    bindings and `@provider` methods, FastAPI dependency functions and
 *    `dependency_overrides`);
 *  - container lookups typing a local or a chained call
 *    (`injector.get(UserRepo)`, `container.repo()`).
 *
 * Facts only — `core/symbol-linker.ts` decides which implementation a call
 * reaches, and refuses when the registrations disagree.
 *
 * Token convention, used on both sides: a FastAPI dependency is named by its
 * function (`get_repo`, the last segment of `deps.get_repo`); a
 * dependency-injector provider by `<Container>.<provider>` (and by its bare
 * provider name for the string-id form `Provide["repo"]`).
 */

export type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/** What a value is, as far as the source states it. `type` is "" when only a token is known. */
interface ValueFact {
  type: string;
  qualifier?: string;
}

/** A value the source says nothing about — it poisons whatever else the name was given. */
const UNKNOWN = "unknown" as const;
/** `None` — absence, compatible with any type. */
const NONE = "none" as const;
type Fact = ValueFact | typeof UNKNOWN | typeof NONE;

// ─── Small helpers ────────────────────────────────────────────────────────────

/** `pkg.mod.Name` → `Name`. */
export function lastSegment(text: string): string {
  return text.slice(text.lastIndexOf(".") + 1);
}

/** A (possibly module-qualified) class name: the last segment is capitalised. */
function isClassName(text: string): boolean {
  return /^(?:[A-Za-z_]\w*\.)*[A-Z]\w*$/.test(text);
}

/** A (possibly module-qualified) function name: the last segment is not capitalised. */
function isFunctionName(text: string): boolean {
  return /^(?:[A-Za-z_]\w*\.)*[a-z_]\w*$/.test(text);
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Split at depth-0 commas (brackets and quotes respected). */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((p) => p.length > 0);
}

/** Positional (non-keyword) argument nodes of a call. */
function positionalArgs(call: Node): Node[] {
  const args = call.childForFieldName("arguments");
  if (!args || args.type !== "argument_list") return [];
  return args.namedChildren.filter((a) => a.type !== "keyword_argument" && a.type !== "comment");
}

function keywordArg(call: Node, name: string): Node | null {
  const args = call.childForFieldName("arguments");
  for (const a of args?.namedChildren ?? []) {
    if (a.type === "keyword_argument" && a.childForFieldName("name")?.text === name) return a.childForFieldName("value");
  }
  return null;
}

function stringValue(node: Node): string | null {
  if (node.type !== "string") return null;
  const m = /^[A-Za-z]*(['"]{1,3})([\s\S]*)\1$/.exec(node.text);
  return m ? m[2]! : null;
}

// ─── Injection tokens on parameters ───────────────────────────────────────────

/**
 * The token a parameter default / annotation metadata injects by:
 * `Depends(get_repo)` / `Security(deps.current_user)` → the dependency
 * function's name; `Provide[Container.repo]` → `Container.repo`;
 * `Provide["repo"]` → `repo`. `Depends()` (the annotation's class is the
 * dependency) and a class passed as the dependency name no token.
 */
export function injectionToken(text: string): string | null {
  const t = collapse(text);
  const dep = /^(?:[\w.]+\.)?(?:Depends|Security)\s*\(\s*(?:dependency\s*=\s*)?([A-Za-z_][\w.]*)\s*[,)]/.exec(t);
  if (dep) return isFunctionName(dep[1]!) ? lastSegment(dep[1]!) : null;
  // `Closing[Provide[...]]` closes a resource after the call; the marker inside is the token.
  const provide = /^(?:(?:[\w.]+\.)?Closing\s*\[\s*)?(?:[\w.]+\.)?Provide\s*\[\s*(?:(['"])([^'"]+)\1|([A-Za-z_][\w.]*))\s*\]/.exec(t);
  if (provide) return provide[2] ?? providerToken(provide[3]!);
  return null;
}

/**
 * `Container.repo` / `app.containers.Container.repo` → `Container.repo`: the
 * provider named from its container class. Null for a marker that names no
 * container class.
 */
function providerToken(path: string): string | null {
  const segs = path.split(".");
  const at = segs.findIndex((s) => /^[A-Z]/.test(s));
  if (at < 0 || at === segs.length - 1) return null;
  return segs.slice(at).join(".");
}

/** `Annotated[T, meta...]` (bare or `typing.`-qualified) → its members, or null. */
function annotatedMembers(typeText: string): string[] | null {
  const m = /^(?:typing(?:_extensions)?\.)?Annotated\s*\[([\s\S]*)\]$/.exec(typeText.trim());
  return m ? splitTopLevel(m[1]!) : null;
}

/** The injection token carried in an `Annotated[...]` annotation's metadata. */
export function annotationToken(typeText: string): string | null {
  const members = annotatedMembers(typeText);
  if (!members) return null;
  for (const meta of members.slice(1)) {
    const token = injectionToken(meta);
    if (token) return token;
  }
  return null;
}

/**
 * Module-level type aliases whose value is an `Annotated[...]`
 * (`RepoDep = Annotated[UserRepo, Depends(get_repo)]`, `RepoDep: TypeAlias =
 * …`, `type RepoDep = …`): name → the aliased type text, so a parameter
 * annotated `repo: RepoDep` gets the type (and token) it stands for.
 */
export function annotatedAliases(root: Node, sourceText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!sourceText.includes("Annotated")) return out;
  for (const stmt of root.namedChildren) {
    let name: Node | null = null;
    let value: Node | null = null;
    if (stmt.type === "expression_statement") {
      const a = stmt.namedChild(0);
      if (a?.type !== "assignment") continue;
      name = a.childForFieldName("left");
      value = a.childForFieldName("right");
    } else if (stmt.type === "type_alias_statement") {
      name = stmt.childForFieldName("left");
      value = stmt.childForFieldName("right");
    }
    if (!name || !value) continue;
    const n = name.type === "type" ? name.namedChild(0) : name;
    if (n?.type !== "identifier") continue;
    const text = collapse(value.text);
    if (annotatedMembers(text)) out.set(n.text, text);
  }
  return out;
}

// ─── What a value is ─────────────────────────────────────────────────────────

/** Receivers whose `.get(T)` / `.resolve(T)` is a container lookup. */
const LOCATOR_RE = /(?:injector|container|locator)$/i;
/** Receivers whose `.provider()` call is a dependency-injector provider. */
const CONTAINER_RE = /container$/i;
/** dependency-injector container methods that are not providers. */
const CONTAINER_METHODS: ReadonlySet<string> = new Set([
  "get", "resolve", "wire", "unwire", "override", "override_providers", "reset_override",
  "reset_last_overriding", "reset_singletons", "init_resources", "shutdown_resources",
  "check_dependencies", "from_schema", "from_yaml_schema", "from_json_schema", "traverse",
  "load_config", "apply_container_providers_overridings", "is_auto_wiring_enabled",
]);

/** `Cls(...)` / `models.Cls(...)` → the class text, as written. */
export function constructedType(call: Node): string | null {
  if (call.type !== "call") return null;
  const fn = call.childForFieldName("function");
  if (!fn || (fn.type !== "identifier" && fn.type !== "attribute")) return null;
  const text = fn.text;
  return isClassName(text) ? text : null;
}

/**
 * The container class a receiver variable holds — a `name: Container`
 * parameter of the enclosing function, else a module-level `name =
 * Container(...)`. Only asked for receivers that already look like a
 * container, so the walks stay off the hot path.
 */
export function containerClassOf(name: string, from: Node): string | null {
  for (let n: Node | null = from.parent; n; n = n.parent) {
    if (n.type !== "function_definition") continue;
    for (const p of n.childForFieldName("parameters")?.namedChildren ?? []) {
      if (p.type !== "typed_parameter" && p.type !== "typed_default_parameter") continue;
      const id = p.type === "typed_parameter" ? p.namedChild(0) : p.childForFieldName("name");
      if (id?.text !== name) continue;
      const t = collapse(p.childForFieldName("type")?.text ?? "").replace(/^(['"])(.*)\1$/, "$2");
      return isClassName(t) ? lastSegment(t) : null;
    }
    break;
  }
  const root = from.tree.rootNode;
  for (const stmt of root.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const a = stmt.namedChild(0);
    if (a?.type !== "assignment" || a.childForFieldName("left")?.text !== name) continue;
    const right = a.childForFieldName("right");
    const cls = right ? constructedType(right) : null;
    if (cls) return lastSegment(cls);
  }
  return null;
}

/**
 * A container lookup's result: `injector.get(UserRepo)`, `container.get(T)`,
 * `ServiceLocator.resolve(T)`, `container[T]` → the requested type;
 * `container.repo()` / `Container.repo()` (a dependency-injector provider
 * call) → the provider's token.
 */
export function lookupFact(node: Node): ValueFact | null {
  if (node.type === "subscript") {
    const value = node.childForFieldName("value");
    if (!value || !CONTAINER_RE.test(lastSegment(value.text))) return null;
    const keys = node.namedChildren.filter((c) => c.id !== value.id && c.type !== "comment");
    if (keys.length === 1 && isClassName(keys[0]!.text)) return { type: keys[0]!.text };
    return null;
  }
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "attribute") return null;
  const recv = fn.childForFieldName("object");
  const method = fn.childForFieldName("attribute")?.text;
  if (!recv || !method || (recv.type !== "identifier" && recv.type !== "attribute")) return null;
  const recvName = lastSegment(recv.text);
  if ((method === "get" || method === "resolve") && LOCATOR_RE.test(recvName)) {
    const first = positionalArgs(node)[0];
    if (first && (first.type === "identifier" || first.type === "attribute") && isClassName(first.text)) {
      return { type: first.text };
    }
    return null;
  }
  if (CONTAINER_RE.test(recvName) && /^[a-z_]\w*$/.test(method) && !CONTAINER_METHODS.has(method)) {
    const cls = /^[A-Z]/.test(recvName) ? recvName : recv.type === "identifier" ? containerClassOf(recv.text, node) : null;
    if (cls) return { type: "", qualifier: `${cls}.${method}` };
  }
  return null;
}

/** `typing.cast(T, x)` / `cast("T", x)` → T. */
function castType(call: Node): string | null {
  const fn = call.childForFieldName("function");
  if (!fn || lastSegment(fn.text) !== "cast") return null;
  const first = positionalArgs(call)[0];
  if (!first) return null;
  return first.type === "string" ? stringValue(first) : collapse(first.text);
}

/** What `node` evaluates to, as stated by the source. `scope` types a bare name. */
function valueFact(node: Node, scope: (name: string) => Fact): Fact {
  switch (node.type) {
    case "none":
      return NONE;
    case "identifier":
      return scope(node.text);
    case "parenthesized_expression": {
      const inner = node.namedChild(0);
      return inner ? valueFact(inner, scope) : UNKNOWN;
    }
    case "call": {
      const cls = constructedType(node);
      if (cls) return { type: collapse(cls) };
      const cast = castType(node);
      if (cast) return { type: cast };
      return lookupFact(node) ?? UNKNOWN;
    }
    case "subscript":
      return lookupFact(node) ?? UNKNOWN;
    default:
      return UNKNOWN;
  }
}

function sameFact(a: ValueFact, b: ValueFact): boolean {
  return a.type === b.type && (a.qualifier ?? "") === (b.qualifier ?? "");
}

/**
 * Facts per name, merged the way Python's typing reads them: an annotation
 * declares the type for every assignment (two different annotations are a
 * conflict); without one, every assignment must state the same type — one
 * the source says nothing about (`x = build()`) leaves the name untyped.
 */
class FactTable {
  private readonly declared = new Map<string, ValueFact | null>();
  private readonly assigned = new Map<string, ValueFact | null>();
  private readonly order = new Set<string>();

  declare(name: string, fact: ValueFact): void {
    this.order.add(name);
    const prev = this.declared.get(name);
    if (prev === undefined) this.declared.set(name, fact);
    else if (prev && !sameFact(prev, fact)) this.declared.set(name, null);
  }

  assign(name: string, fact: Fact): void {
    this.order.add(name);
    if (fact === NONE) return;
    const prev = this.assigned.get(name);
    if (fact === UNKNOWN) this.assigned.set(name, null);
    else if (prev === undefined) this.assigned.set(name, fact);
    else if (prev && !sameFact(prev, fact)) this.assigned.set(name, null);
  }

  /** The name's type as far as the statements so far state it. */
  get(name: string): ValueFact | null {
    const d = this.declared.get(name);
    if (d !== undefined) return d;
    return this.assigned.get(name) ?? null;
  }

  /** Names in the order the statements first bind them. */
  names(): string[] {
    return [...this.order];
  }
}

// ─── Walking a body's statements ─────────────────────────────────────────────

/** Statements that open a scope of their own — their bodies are other symbols. */
const NESTED_SCOPES: ReadonlySet<string> = new Set(["function_definition", "class_definition", "decorated_definition"]);

/** Compound-statement parts holding further statements. */
const STATEMENT_HOLDERS: ReadonlySet<string> = new Set([
  "block", "if_statement", "elif_clause", "else_clause", "for_statement", "while_statement",
  "try_statement", "except_clause", "except_group_clause", "finally_clause", "with_statement",
  "match_statement", "case_clause",
]);

interface StatementVisitor {
  /** An `expression_statement` (assignments, yields, calls). */
  statement?(stmt: Node): void;
  /** A `return_statement`. */
  ret?(stmt: Node): void;
  /** A name bound by something other than an assignment (loop target, `as` alias). */
  rebind?(name: string): void;
}

/**
 * Visit the simple statements of a body, through `if`/`for`/`try`/`with`/
 * `match` nesting but not into nested functions or classes. Statement level
 * only: expressions are never walked, which keeps this far cheaper than a
 * full-tree walk.
 */
function walkStatements(node: Node, v: StatementVisitor): void {
  for (const child of node.namedChildren) {
    const t = child.type;
    if (t === "expression_statement") {
      v.statement?.(child);
      continue;
    }
    if (t === "return_statement") {
      v.ret?.(child);
      continue;
    }
    if (NESTED_SCOPES.has(t)) continue;
    if (v.rebind) {
      // `for x in …` / `with … as x` bind names to values no annotation types.
      if (t === "for_statement") boundNames(child.childForFieldName("left"), v.rebind);
      else if (t === "with_statement") withAliases(child, v.rebind);
    }
    if (STATEMENT_HOLDERS.has(t)) walkStatements(child, v);
  }
}

function boundNames(node: Node | null, out: (name: string) => void): void {
  if (!node) return;
  if (node.type === "identifier") {
    out(node.text);
    return;
  }
  for (const c of node.namedChildren) boundNames(c, out);
}

/** The `as` targets of a `with` statement's items. */
function withAliases(withStmt: Node, out: (name: string) => void): void {
  for (const clause of withStmt.namedChildren) {
    if (clause.type !== "with_clause") continue;
    for (const item of clause.namedChildren) {
      const value = item.type === "with_item" ? item.childForFieldName("value") : null;
      if (value?.type === "as_pattern") boundNames(value.childForFieldName("alias"), out);
    }
  }
}

/** The `# type: T` comment trailing statement `stmt` on its own line, if any. */
function trailingTypeComment(stmt: Node): string | null {
  const next = stmt.nextSibling;
  if (next?.type !== "comment" || next.startPosition.row !== stmt.endPosition.row) return null;
  const m = /^#\s*type:\s*(.+?)\s*(?:#.*)?$/.exec(next.text);
  if (!m || /^ignore\b/.test(m[1]!)) return null;
  return m[1]!;
}

// ─── Locals ──────────────────────────────────────────────────────────────────

/** A parameter as a value: its declared type and/or injection token. */
function paramFact(p: ParamInfo | undefined): Fact {
  if (!p) return UNKNOWN;
  if (!p.type && !p.qualifier) return UNKNOWN;
  const fact: ValueFact = { type: p.type ?? "" };
  if (p.qualifier) fact.qualifier = p.qualifier;
  return fact;
}

/**
 * Locals whose type the body states: `x = UserRepo(...)`, `x: UserRepo = …`,
 * `x = …  # type: UserRepo`, `x = injector.get(UserRepo)`, `x =
 * container.repo()` (the provider's token), `x = cast(UserRepo, y)`. A name
 * reassigned from anything the source does not type, or rebound by a loop or
 * `with … as`, is left out; parameters are never re-typed here.
 *
 * A name assigned only from calls that state no type (`p =
 * Patcher.from_file(path)`, `repo = await make_repo()`) carries those calls
 * as `from` — one entry per distinct initializer — and the linker types it
 * through the callee's declared return type.
 */
export function collectLocalTypes(body: Node, params: readonly ParamInfo[], typeComments: boolean): LocalType[] {
  const table = new FactTable();
  const paramNames = new Set(params.map((p) => p.name));
  const fromCalls = new Map<string, Map<string, { from: string; awaited: boolean }>>();
  // Also assigned something other than a call (or `None`): hides its `from` calls.
  const untyped = new Set<string>();
  const scope = (name: string): Fact => {
    if (paramNames.has(name)) return paramFact(params.find((p) => p.name === name));
    return table.get(name) ?? UNKNOWN;
  };
  walkStatements(body, {
    statement(stmt) {
      const a = stmt.namedChild(0);
      if (a?.type !== "assignment") return;
      const left = a.childForFieldName("left");
      if (!left) return;
      if (left.type !== "identifier") {
        if (left.type === "pattern_list" || left.type === "tuple_pattern" || left.type === "list_pattern") {
          boundNames(left, (n) => { table.assign(n, UNKNOWN); untyped.add(n); });
        }
        return;
      }
      const name = left.text;
      const annotation = a.childForFieldName("type");
      if (annotation) {
        table.declare(name, { type: collapse(annotation.text) });
        return;
      }
      const comment = typeComments ? trailingTypeComment(stmt) : null;
      if (comment) {
        table.declare(name, { type: comment });
        return;
      }
      const right = a.childForFieldName("right");
      const fact = right ? valueFact(right, scope) : UNKNOWN;
      table.assign(name, fact);
      if (fact !== UNKNOWN) {
        // A construction beside a call: the two disagree and neither types it.
        if (fact !== NONE) untyped.add(name);
        return;
      }
      const call = right ? initializerCall(right) : null;
      if (!call) { untyped.add(name); return; }
      const calls = fromCalls.get(name) ?? fromCalls.set(name, new Map()).get(name)!;
      calls.set(`${call.awaited ? "await " : ""}${call.from}`, call);
    },
    rebind(name) {
      table.assign(name, UNKNOWN);
      untyped.add(name);
    },
  });
  const out: LocalType[] = [];
  for (const name of table.names()) {
    if (paramNames.has(name)) continue;
    const fact = table.get(name);
    if (!fact) {
      // A stated type wins (handled above); only calls, or calls and `None`, remain.
      const calls = fromCalls.get(name);
      if (!calls || untyped.has(name)) continue;
      for (const c of calls.values()) out.push(c.awaited ? { name, type: "", from: c.from, awaited: true } : { name, type: "", from: c.from });
      continue;
    }
    const local: LocalType = { name, type: fact.type };
    if (fact.qualifier) local.qualifier = fact.qualifier;
    out.push(local);
  }
  return out;
}

/** Builtins whose result the project never declares — no point carrying them as initializers. */
export const PY_BUILTIN_CALLS: ReadonlySet<string> = new Set([
  "len", "str", "int", "float", "bool", "bytes", "list", "dict", "set", "tuple", "frozenset",
  "sorted", "reversed", "range", "enumerate", "zip", "map", "filter", "open", "repr", "type",
  "getattr", "isinstance", "sum", "min", "max", "abs", "round", "any", "all", "iter", "next",
  "vars", "dir", "id", "hash", "format", "super", "print", "input", "object",
]);

/** An initializer that is a call (optionally awaited), spelled for `localTypes[].from`. */
function initializerCall(right: Node): { from: string; awaited: boolean } | null {
  let node: Node | null = right;
  let awaited = false;
  if (node.type === "await") {
    awaited = true;
    node = node.namedChild(0);
  }
  if (node?.type !== "call") return null;
  const from = callChainText(node, "python");
  if (!from || PY_BUILTIN_CALLS.has(from.slice(0, -2))) return null;
  return { from, awaited };
}

// ─── Instance attributes ─────────────────────────────────────────────────────

/** One method of a class, as the attribute pass needs it. */
export interface MethodSource {
  node: Node;
  fn: FunctionInfo;
  /** The instance parameter's name (`self`), or null for a static/class method. */
  selfName: string | null;
}

/**
 * Instance attributes the methods assign — `self.repo = repo` (the
 * parameter's type and token), `self.repo = SqlUserRepo()`, `self.repo:
 * UserRepo = …`, `self.repo = repo  # type: UserRepo`, `self.repo =
 * injector.get(UserRepo)`. Every method is read, so an attribute some other
 * method reassigns from an untyped value is left untyped. Names in `skip`
 * (class-level annotations, which declare the type) are not emitted.
 */
export function collectInstanceAttributes(
  methods: readonly MethodSource[],
  skip: ReadonlySet<string>,
  typeComments: boolean,
): PropertyInfo[] {
  const table = new FactTable();
  // `self.recipes = get_repositories(session).recipes`: no type stated, a chain the project pass types.
  const chains = new Map<string, string | null>();
  for (const { node, fn, selfName } of methods) {
    if (!selfName) continue;
    const body = node.childForFieldName("body");
    if (!body) continue;
    const params = new Map(fn.params.map((p) => [p.name, p]));
    const locals = new Map((fn.localTypes ?? []).map((l) => [l.name, l]));
    const scope = (name: string): Fact => {
      if (params.has(name)) return paramFact(params.get(name));
      const l = locals.get(name);
      if (!l) return UNKNOWN;
      return l.qualifier ? { type: l.type, qualifier: l.qualifier } : { type: l.type };
    };
    walkStatements(body, {
      statement(stmt) {
        const a = stmt.namedChild(0);
        if (a?.type !== "assignment") return;
        const left = a.childForFieldName("left");
        if (left?.type !== "attribute" || left.childForFieldName("object")?.text !== selfName) return;
        const name = left.childForFieldName("attribute")?.text;
        if (!name) return;
        const annotation = a.childForFieldName("type");
        if (annotation) {
          table.declare(name, { type: collapse(annotation.text) });
          return;
        }
        const comment = typeComments ? trailingTypeComment(stmt) : null;
        if (comment) {
          table.declare(name, { type: comment });
          return;
        }
        const right = a.childForFieldName("right");
        table.assign(name, right ? valueFact(right, scope) : UNKNOWN);
        // `self.items = repos.shopping_items` in `__init__`, `repos: AllRepositories`: a chain on a typed
        // constructor parameter, which the project pass types from that parameter.
        const onParam = right?.type === "attribute" && fn.name === "__init__" && /^\w+(?:\.\w+)+$/.test(right.text) && !!params.get(right.text.split(".")[0]!)?.type;
        const chain = right ? resultChainText(right) ?? (onParam ? right.text : null) : null;
        chains.set(name, chains.has(name) && chains.get(name) !== chain ? null : chain);
      },
    });
  }
  const out: PropertyInfo[] = [];
  for (const name of table.names()) {
    if (skip.has(name)) continue;
    const fact = table.get(name);
    const chain = chains.get(name);
    if (!fact && !chain) continue;
    const prop: PropertyInfo = {
      name,
      type: fact?.type || null,
      visibility: name.startsWith("_") ? "private" : "public",
      isStatic: false,
      isReadonly: false,
    };
    if (fact?.qualifier) prop.qualifier = fact.qualifier;
    if (!prop.type && chain) prop.from = chain;
    out.push(prop);
  }
  return out;
}

/**
 * The parameters a constructor assigns unchanged to instance attributes
 * (`self.model = model` → model ← model); an attribute assigned twice, or
 * from anything else as well, is left out.
 */
export function constructorParamAttributes({ node, fn, selfName }: MethodSource): Map<string, string> {
  const out = new Map<string, string>();
  const body = node.childForFieldName("body");
  if (!body || !selfName) return out;
  const params = new Set(fn.params.map((p) => p.name));
  const mixed = new Set<string>();
  walkStatements(body, {
    statement(stmt) {
      const a = stmt.namedChild(0);
      if (a?.type !== "assignment") return;
      const left = a.childForFieldName("left");
      if (left?.type !== "attribute" || left.childForFieldName("object")?.text !== selfName) return;
      const name = left.childForFieldName("attribute")?.text;
      if (!name) return;
      const right = a.childForFieldName("right");
      const param = right?.type === "identifier" && params.has(right.text) ? right.text : null;
      if (!param || (out.has(name) && out.get(name) !== param)) mixed.add(name);
      else out.set(name, param);
    },
  });
  for (const name of mixed) out.delete(name);
  return out;
}

/**
 * A member chain rooted in a function's result, as the project pass reads it:
 * `get_repositories(session, group_id=g).recipes` → `get_repositories().recipes`.
 * Null for anything else (a chain on a name, a method call's result).
 */
export function resultChainText(node: Node): string | null {
  const names: string[] = [];
  let cur: Node | null = node;
  while (cur?.type === "attribute") {
    const attr = cur.childForFieldName("attribute")?.text;
    if (!attr) return null;
    names.unshift(attr);
    cur = cur.childForFieldName("object");
  }
  const fn = cur?.type === "call" ? cur.childForFieldName("function") : null;
  return names.length > 0 && fn?.type === "identifier" ? `${fn.text}().${names.join(".")}` : null;
}

// ─── Parameter types from docstrings and type comments ───────────────────────

/** Docstring type text → annotation-like text: `:class:\`~a.Repo\`` → `a.Repo`, `X or None` → `X | None`. */
function docType(raw: string): string | null {
  let t = raw
    .replace(/:(?:py:)?(?:class|obj|data):/g, "")
    .replace(/`/g, "")
    .replace(/(^|[\s[,(|])~/g, "$1")
    .replace(/,?\s*optional\b.*$/i, "")
    .replace(/,?\s*default\b.*$/i, "")
    .trim();
  t = t.replace(/\s+or\s+/g, " | ");
  return t && /^[\w.[\], |"']+$/.test(t) ? t : null;
}

/**
 * Parameter types a docstring states — Sphinx (`:type repo: UserRepo`,
 * `:param UserRepo repo:`), Google (`Args:` → `repo (UserRepo): …`) and
 * NumPy (`Parameters` / `----------` → `repo : UserRepo`).
 */
export function docstringParamTypes(doc: string): Map<string, string> {
  const out = new Map<string, string>();
  const set = (name: string, raw: string): void => {
    const n = name.replace(/^\*+/, "");
    const t = docType(raw);
    if (t && !out.has(n)) out.set(n, t);
  };
  const lines = doc.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const sphinxType = /^\s*:type\s+(\*{0,2}\w+)\s*:\s*(.+?)\s*$/.exec(line);
    if (sphinxType) {
      set(sphinxType[1]!, sphinxType[2]!);
      continue;
    }
    const sphinxParam = /^\s*:param\s+(.+?)\s+(\*{0,2}\w+)\s*:/.exec(line);
    if (sphinxParam) {
      set(sphinxParam[2]!, sphinxParam[1]!);
      continue;
    }
    const google = /^(\s*)(?:Args|Arguments|Parameters|Params|Keyword Args|Keyword Arguments|Other Parameters):\s*$/.exec(line);
    if (google) {
      const indent = google[1]!.length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (!l.trim()) continue;
        if (l.length - l.trimStart().length <= indent) break;
        const m = /^\s*(\*{0,2}\w+)\s*\(([^)]+)\)\s*:/.exec(l);
        if (m) set(m[1]!, m[2]!);
      }
      continue;
    }
    const numpy = /^(\s*)(?:Parameters|Other Parameters|Keyword Arguments)\s*$/.exec(line);
    if (numpy && /^\s*-{3,}\s*$/.test(lines[i + 1] ?? "")) {
      const indent = numpy[1]!.length;
      for (let j = i + 2; j < lines.length; j++) {
        const l = lines[j]!;
        if (!l.trim()) continue;
        const lineIndent = l.length - l.trimStart().length;
        if (lineIndent < indent) break;
        // The next section header (`Returns` + dashes) ends the list.
        if (/^\s*-{3,}\s*$/.test(lines[j + 1] ?? "")) break;
        if (lineIndent !== indent) continue;
        const m = /^\s*(\*{0,2}\w+(?:\s*,\s*\*{0,2}\w+)*)\s*:\s*(.+?)\s*$/.exec(l);
        if (m) for (const n of m[1]!.split(",")) set(n.trim(), m[2]!);
      }
    }
  }
  return out;
}

/**
 * Fill the missing parameter types of a `def` from its PEP 484 function type
 * comment (`# type: (UserRepo, int) -> None`) or its docstring. An
 * annotation always wins; nothing is overwritten.
 */
export function fillParamTypesFromComments(fnNode: Node, body: Node | null, params: ParamInfo[]): void {
  if (!params.some((p) => p.type === null)) return;
  for (const c of fnNode.children) {
    if (c.type !== "comment") continue;
    const m = /^#\s*type:\s*\((.*)\)\s*->/.exec(c.text);
    if (!m) continue;
    const types = splitTopLevel(m[1]!).filter((t) => !t.startsWith("*"));
    if (types.length === 1 && types[0] === "...") break;
    // PEP 484: the comment lists every parameter but `self`/`cls` and splats,
    // exactly the ones `pythonParams` keeps.
    if (types.length === params.length) {
      params.forEach((p, i) => {
        if (p.type === null) p.type = types[i]!;
      });
    }
    break;
  }
  const first = body?.namedChild(0);
  if (first?.type !== "expression_statement") return;
  const str = first.namedChild(0);
  if (str?.type !== "string") return;
  const doc = stringValue(str);
  if (!doc || !/:type\b|:param\b|Args:|Arguments:|Parameters|Params:/.test(doc)) return;
  const types = docstringParamTypes(doc);
  for (const p of params) if (p.type === null && types.has(p.name)) p.type = types.get(p.name)!;
}

// ─── Container registrations ─────────────────────────────────────────────────

/** dependency-injector providers that build one class. */
const BUILDING_PROVIDERS: ReadonlySet<string> = new Set([
  "Factory", "Singleton", "ThreadSafeSingleton", "ThreadLocalSingleton", "ContextLocalSingleton",
  "DelegatedFactory", "DelegatedSingleton", "DelegatedThreadSafeSingleton", "DelegatedThreadLocalSingleton",
]);

/** `injector` provider wrappers around what a binding produces. */
const INJECTOR_PROVIDERS: ReadonlySet<string> = new Set(["ClassProvider", "InstanceProvider", "CallableProvider"]);

/** Gates: substrings a file must contain for each registration form. */
const PROVIDER_FN_GATE = /\b(?:return|yield)\s+(?:(?:[\w.]+\.)?[A-Z]\w*\s*\(|[a-z_]\w*\s*$)/m;

/**
 * The one class a function returns: every `return`/`yield` in the body
 * (nested scopes aside) hands back the same plain construction — directly or
 * through a local assigned exactly that. Anything else (another value on some
 * path, a bare `return`) is no statement of what the function builds.
 */
export function returnedClass(fnNode: Node, params: readonly ParamInfo[] = []): string | null {
  const body = fnNode.childForFieldName("body");
  if (!body) return null;
  let locals: Map<string, LocalType> | null = null;
  const localsOf = (): Map<string, LocalType> => {
    locals ??= new Map(collectLocalTypes(body, params, false).map((l) => [l.name, l]));
    return locals;
  };
  const classes = new Set<string>();
  let bad = false;
  const consider = (value: Node | null): void => {
    if (!value) {
      bad = true;
      return;
    }
    const direct = constructedType(value);
    if (direct) {
      classes.add(lastSegment(direct));
      return;
    }
    if (value.type === "identifier") {
      const l = localsOf().get(value.text);
      // Only a local the body CONSTRUCTED: an annotation states a type, not
      // the class a container hands out.
      if (l && l.type && !l.qualifier && localWasConstructed(body, value.text)) {
        classes.add(lastSegment(l.type));
        return;
      }
    }
    bad = true;
  };
  walkStatements(body, {
    ret(stmt) {
      consider(stmt.namedChild(0));
    },
    statement(stmt) {
      const e = stmt.namedChild(0);
      if (e?.type === "yield") consider(e.namedChild(0));
    },
  });
  if (bad || classes.size !== 1) return null;
  return [...classes][0]!;
}

/** Every assignment to `name` in `body` is a plain construction. */
function localWasConstructed(body: Node, name: string): boolean {
  let ok = false;
  let bad = false;
  walkStatements(body, {
    statement(stmt) {
      const a = stmt.namedChild(0);
      if (a?.type !== "assignment" || a.childForFieldName("left")?.text !== name) return;
      const right = a.childForFieldName("right");
      if (right && constructedType(right)) ok = true;
      else bad = true;
    },
  });
  return ok && !bad;
}

/** What an `injector` binding target produces: a class, a construction, or a provider of one. */
function injectorTarget(node: Node | null): string | null {
  if (!node) return null;
  if ((node.type === "identifier" || node.type === "attribute") && isClassName(node.text)) return lastSegment(node.text);
  if (node.type === "lambda") return lambdaClass(node);
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn && INJECTOR_PROVIDERS.has(lastSegment(fn.text))) return injectorTarget(positionalArgs(node)[0] ?? null);
  const cls = constructedType(node);
  return cls ? lastSegment(cls) : null;
}

/** `lambda: FakeRepo()` → FakeRepo. */
function lambdaClass(node: Node): string | null {
  const body = node.childForFieldName("body");
  const cls = body ? constructedType(body) : null;
  return cls ? lastSegment(cls) : null;
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * Container registrations in a Python file → `FileAnalysis.diBindings`:
 *
 *  - FastAPI dependency functions — a module-level `def get_repo(): return
 *    SqlUserRepo(...)` answers to the token `get_repo` (keyed only:
 *    `Depends(get_repo)` names it);
 *  - `app.dependency_overrides[get_repo] = lambda: FakeRepo()` (a test
 *    file's override never reaches production code — core drops it);
 *  - dependency-injector `DeclarativeContainer` providers — `repo =
 *    providers.Factory(SqlUserRepo, …)` answers to `Container.repo` and to
 *    `repo` (`Provide["repo"]`);
 *  - `injector` — `binder.bind(UserRepo, to=SqlUserRepo)` and a `Module`'s
 *    `@provider def repo(self) -> UserRepo: return SqlUserRepo()`.
 */
export function extractPythonDiBindings(tree: Tree, sourceText: string): DiBinding[] {
  const out: DiBinding[] = [];
  const root = tree.rootNode;
  const wantProviders = PROVIDER_FN_GATE.test(sourceText);
  const wantContainers = sourceText.includes("Container");
  const wantModules = /@(?:[\w.]+\.)?provider\b/.test(sourceText);
  const wantBind = /binder\s*\.\s*bind\s*\(/i.test(sourceText);
  const wantOverrides = sourceText.includes("dependency_overrides");
  if (!wantProviders && !wantContainers && !wantModules && !wantBind && !wantOverrides) return out;

  for (const stmt of root.namedChildren) {
    const def = stmt.type === "decorated_definition" ? stmt.childForFieldName("definition") : stmt;
    if (!def) continue;
    if (def.type === "function_definition" && wantProviders) {
      const name = def.childForFieldName("name")?.text;
      const impl = name ? returnedClass(def) : null;
      if (name && impl) out.push({ service: name, implementation: impl, line: lineOf(def), via: "provider", keyedOnly: true });
    } else if (def.type === "class_definition") {
      const bases = (def.childForFieldName("superclasses")?.namedChildren ?? [])
        .filter((b) => b.type !== "keyword_argument" && b.type !== "comment")
        .map((b) => lastSegment(b.text));
      const name = def.childForFieldName("name")?.text;
      const body = def.childForFieldName("body");
      if (!name || !body) continue;
      if (wantContainers && bases.some((b) => /^(?:Declarative|Dynamic)Container$/.test(b))) {
        containerBindings(name, body, out);
      }
      if (wantModules && bases.includes("Module")) moduleProviderBindings(body, out);
    }
  }

  if (wantBind || wantOverrides) {
    const walk = (node: Node): void => {
      if (wantBind && node.type === "call") bindBinding(node, out);
      else if (wantOverrides && node.type === "assignment") overrideBinding(node, out);
      for (const c of node.namedChildren) walk(c);
    };
    walk(root);
  }
  return out.sort((a, b) => a.line - b.line);
}

/** `repo = providers.Factory(SqlUserRepo, …)` in a `DeclarativeContainer` body. */
function containerBindings(container: string, body: Node, out: DiBinding[]): void {
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const a = stmt.namedChild(0);
    if (a?.type !== "assignment") continue;
    const left = a.childForFieldName("left");
    const right = a.childForFieldName("right");
    if (left?.type !== "identifier" || right?.type !== "call") continue;
    const fn = right.childForFieldName("function");
    const kind = fn ? lastSegment(fn.text) : "";
    if (!BUILDING_PROVIDERS.has(kind)) continue;
    const first = positionalArgs(right)[0];
    if (!first) continue;
    let impl: string | null = null;
    if ((first.type === "identifier" || first.type === "attribute") && isClassName(first.text)) impl = lastSegment(first.text);
    else if (first.type === "string") {
      // `providers.Factory("app.repos.SqlUserRepo")` — an import path.
      const path = stringValue(first);
      if (path && isClassName(path)) impl = lastSegment(path);
    }
    if (!impl) continue;
    const via = `providers.${kind}`;
    const line = lineOf(a);
    out.push({ service: `${container}.${left.text}`, implementation: impl, line, via, keyedOnly: true });
    // The string-id form `Provide["repo"]` names the provider alone.
    out.push({ service: left.text, implementation: impl, line, via, keyedOnly: true });
  }
}

/** `@provider def repo(self) -> UserRepo: return SqlUserRepo()` in an `injector.Module`. */
function moduleProviderBindings(body: Node, out: DiBinding[]): void {
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "decorated_definition") continue;
    const decorators = stmt.namedChildren.filter((c) => c.type === "decorator").map((d) => d.text.replace(/^@\s*/, ""));
    if (!decorators.some((d) => /^(?:[\w.]+\.)?provider$/.test(d))) continue;
    const def = stmt.childForFieldName("definition");
    if (def?.type !== "function_definition") continue;
    const ret = collapse(def.childForFieldName("return_type")?.text ?? "").replace(/^(['"])(.*)\1$/, "$2");
    if (!isClassName(ret)) continue;
    const impl = returnedClass(def);
    const service = lastSegment(ret);
    if (!impl || impl === service) continue;
    out.push({ service, implementation: impl, line: lineOf(def), via: "@provider" });
  }
}

/** `binder.bind(UserRepo, to=SqlUserRepo)` (also `ClassProvider(…)`, `SqlUserRepo()`, a lambda). */
function bindBinding(call: Node, out: DiBinding[]): void {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "bind") return;
  const recv = fn.childForFieldName("object");
  if (!recv || !/binder$/i.test(lastSegment(recv.text))) return;
  const [iface, second] = positionalArgs(call);
  if (!iface || (iface.type !== "identifier" && iface.type !== "attribute") || !isClassName(iface.text)) return;
  const service = lastSegment(iface.text);
  const impl = injectorTarget(keywordArg(call, "to") ?? second ?? null);
  if (!impl || impl === service) return;
  out.push({ service, implementation: impl, line: lineOf(call), via: "bind" });
}

/** `app.dependency_overrides[get_repo] = lambda: FakeRepo()` (or a class, or another provider). */
function overrideBinding(assignment: Node, out: DiBinding[]): void {
  const left = assignment.childForFieldName("left");
  if (left?.type !== "subscript") return;
  const target = left.childForFieldName("value");
  if (target?.type !== "attribute" || target.childForFieldName("attribute")?.text !== "dependency_overrides") return;
  const keys = left.namedChildren.filter((c) => c.id !== target.id && c.type !== "comment");
  const key = keys.length === 1 ? keys[0]! : null;
  if (!key || (key.type !== "identifier" && key.type !== "attribute") || !isFunctionName(key.text)) return;
  const right = assignment.childForFieldName("right");
  if (!right) return;
  let impl: string | null = null;
  if (right.type === "lambda") impl = lambdaClass(right);
  else if (right.type === "identifier" || right.type === "attribute") {
    // A class is called by FastAPI → an instance of it; another dependency
    // function is followed through its own provider binding (an alias).
    impl = lastSegment(right.text);
  }
  if (!impl) return;
  out.push({ service: lastSegment(key.text), implementation: impl, line: lineOf(assignment), via: "dependency_overrides", keyedOnly: true });
}

// ─── Chained lookups ─────────────────────────────────────────────────────────

/**
 * `injector.get(UserRepo).find()`, `container.repo().find()`,
 * `ServiceLocator.resolve(UserRepo).find()` — the receiver is a container
 * lookup, so the call carries the type (or token) it returns. Called for
 * every call node: bails on the receiver's node type first.
 */
export function pythonReceiverTypeOf(node: Node): { type: string; qualifier?: string } | null {
  const fn = node.childForFieldName("function");
  if (fn?.type !== "attribute") return null;
  const recv = fn.childForFieldName("object");
  if (!recv || (recv.type !== "call" && recv.type !== "subscript")) return null;
  const fact = lookupFact(recv);
  if (!fact) return null;
  return fact.qualifier ? { type: fact.type, qualifier: fact.qualifier } : { type: fact.type };
}
