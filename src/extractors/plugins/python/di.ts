import type { Node, Tree } from "web-tree-sitter";
import type { DiBinding, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { callChainText } from "../../shared/call-graph.js";
import { splitTopLevel } from "./request-schema.js";

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

/**
 * The element a collection annotation states: `list[Club]`, `List[Club]`, `Sequence[Club]`, `Iterable[Club]`,
 * `set[Club]`, `tuple[Club, ...]` → `Club`; `dict[str, Club]`, `Mapping[str, Club]` → `Club` with `map: true`.
 * `Optional[…]` / `… | None` and a quoted forward reference are looked through. Null for any other type, and for an
 * element that is no class (`list[str]`, `list[int]`).
 */
export function collectionElement(type: string | null | undefined): { element: string; map: boolean } | null {
  let t = collapse(type ?? "").replace(/\b(?:typing|collections(?:\.abc)?)\./g, "");
  t = t.split("|").map((p) => p.trim()).filter((p) => p && p !== "None").join("|");
  const opt = /^Optional\[(.+)\]$/.exec(t);
  if (opt) t = opt[1]!;
  if (!t || t.includes("|")) return null;
  const m = /^(list|List|Sequence|MutableSequence|Iterable|Iterator|Collection|Set|set|FrozenSet|frozenset|AbstractSet|MutableSet|Deque|deque|Tuple|tuple|Generator|dict|Dict|Mapping|MutableMapping|DefaultDict|defaultdict|OrderedDict)\[(.+)\]$/.exec(t);
  if (!m) return null;
  const args = splitTopLevel(m[2]!).map((a) => a.trim().replace(/^(['"])(.*)\1$/, "$2"));
  const kind = m[1]!;
  const isMap = /^(?:dict|Dict|Mapping|MutableMapping|DefaultDict|defaultdict|OrderedDict)$/.test(kind);
  let element: string | undefined;
  if (isMap) element = args.length === 2 ? args[1] : undefined;
  else if (/^(?:Tuple|tuple)$/.test(kind)) element = args.length === 2 && args[1] === "..." ? args[0] : args.length === 1 ? args[0] : undefined;
  else if (kind === "Generator") element = args[0];
  else element = args.length === 1 ? args[0] : undefined;
  if (!element || !isClassName(element) || /^(?:Any|None|Self|Optional|Union|Callable|Dict|List|Set|Tuple|Type)$/.test(lastSegment(element))) return null;
  return { element, map: isMap };
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

/**
 * Module-level `T = TypeVar("T", bound=Club)` (a quoted `bound="Club"` too): name → the bound's text, so a
 * parameter annotated `x: T` is typed as the bound a member read on it can name. A constrained
 * `TypeVar("T", A, B)` names no one type and is left out.
 */
export function typeVarBounds(root: Node, sourceText: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!sourceText.includes("TypeVar")) return out;
  for (const stmt of root.namedChildren) {
    const a = stmt.type === "expression_statement" ? stmt.namedChild(0) : null;
    if (a?.type !== "assignment") continue;
    const name = a.childForFieldName("left");
    const call = a.childForFieldName("right");
    if (name?.type !== "identifier" || call?.type !== "call") continue;
    const callee = call.childForFieldName("function")?.text ?? "";
    if (callee !== "TypeVar" && !callee.endsWith(".TypeVar")) continue;
    for (const arg of call.childForFieldName("arguments")?.namedChildren ?? []) {
      if (arg.type !== "keyword_argument" || arg.childForFieldName("name")?.text !== "bound") continue;
      const value = arg.childForFieldName("value");
      const text = value?.type === "string" ? value.text.replace(/^[rRbBuUfF]*["']+|["']+$/g, "") : value?.text;
      if (text && /^[A-Za-z_][\w.]*$/.test(text.trim())) out.set(name.text, text.trim());
    }
  }
  return out;
}

/** PEP 695 `def f[T: Club]` / `class Box[T: Club]`: the bounds a definition and its enclosing classes declare, innermost winning. */
export function typeParameterBounds(def: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (let n: Node | null = def; n; n = n.parent) {
    if (n.type !== "function_definition" && n.type !== "class_definition") continue;
    const list = n.childForFieldName("type_parameters");
    if (!list) continue;
    for (const t of list.namedChildren) {
      const constrained = t.namedChild(0);
      if (constrained?.type !== "constrained_type") continue;
      const name = constrained.namedChild(0)?.text;
      const bound = constrained.namedChild(1);
      if (!name || !bound || out.has(name)) continue;
      const text = bound.text.trim();
      if (bound.namedChild(0)?.type === "identifier" || bound.namedChild(0)?.type === "attribute") out.set(name, text);
    }
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
  /** The condition of an `if` / `elif` / `while`, where an assignment expression (`(q := p)`) may bind a name. */
  condition?(cond: Node): void;
  /** A name bound by something other than an assignment (loop target, `as` alias). */
  rebind?(name: string): void;
  /** A `for` statement; true when it bound its targets itself (typed by what it loops over). */
  loop?(stmt: Node): boolean;
  /** A `with` item (`Club() as c`); true when it bound its alias itself. */
  withItem?(item: Node): boolean;
  /** An `except` clause (`except LeagueError as e`). */
  except?(clause: Node): void;
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
    if (v.condition && (t === "if_statement" || t === "elif_clause" || t === "while_statement")) {
      const cond = child.childForFieldName("condition");
      if (cond) v.condition(cond);
    }
    if (v.rebind) {
      // `for x in …` / `with … as x` bind names to values no annotation types.
      if (t === "for_statement" && !v.loop?.(child)) boundNames(child.childForFieldName("left"), v.rebind);
      else if (t === "with_statement") withAliases(child, v.rebind, v.withItem);
      else if (t === "except_clause" || t === "except_group_clause") v.except?.(child);
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
function withAliases(withStmt: Node, out: (name: string) => void, typed?: (item: Node) => boolean): void {
  for (const clause of withStmt.namedChildren) {
    if (clause.type !== "with_clause") continue;
    for (const item of clause.namedChildren) {
      const value = item.type === "with_item" ? item.childForFieldName("value") : null;
      if (value?.type === "as_pattern" && !typed?.(item)) boundNames(value.childForFieldName("alias"), out);
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
/** The parameters whose declared type is a collection of a class, by name. */
export function collectionParams(params: readonly ParamInfo[]): Map<string, { element: string; map: boolean }> {
  const out = new Map<string, { element: string; map: boolean }>();
  for (const p of params) {
    const c = collectionElement(p.type);
    if (c) out.set(p.name, c);
  }
  return out;
}

/** `dict[K, type[Base]]` (any spacing, `Dict`/`Mapping`/`Type`): the registry's stated base class. */
const REGISTRY_TYPE = /^(?:typing\.)?(?:dict|Dict|Mapping|MutableMapping)\[[^,\]]+(?:\[[^\]]*\])?,(?:typing\.)?(?:type|Type)\[([A-Za-z_][\w.]*)\]\]$/;

/** `table.get(k, …)` or `table[k]` where `table` is a registry of classes: the registry's base. */
function registryPick(right: Node, registries: ReadonlyMap<string, string>): string | null {
  if (right.type === "subscript") return registries.get(right.childForFieldName("value")?.text ?? "") ?? null;
  if (right.type !== "call") return null;
  const fn = right.childForFieldName("function");
  if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "get") return null;
  return registries.get(fn.childForFieldName("object")?.text ?? "") ?? null;
}

export function collectLocalTypes(
  body: Node,
  params: readonly ParamInfo[],
  typeComments: boolean,
  /** The parameters' collections, when the caller already read them (`collectionParams`). */
  collections: Map<string, { element: string; map: boolean }> = collectionParams(params),
): LocalType[] {
  const table = new FactTable();
  const paramNames = new Set(params.map((p) => p.name));
  const fromCalls = new Map<string, Map<string, { from: string; awaited: boolean; index?: number; element?: true }>>();
  // Also assigned something other than a call (or `None`): hides its `from` calls.
  const untyped = new Set<string>();
  // `q = p` / `(q := p)`: names assigned from another plain name, which the linker types as that name.
  const aliasFroms = new Map<string, Set<string>>();
  const aliasFrom = (name: string, head: string): void => {
    (aliasFroms.get(name) ?? aliasFroms.set(name, new Set()).get(name)!).add(head);
  };
  // Class-valued registries the body annotates (`table: dict[Kind, type[Base]] = {...}`) and the locals picked
  // out of one (`ctor = table.get(kind)`, `ctor = table[kind]`): calling such a local constructs the stated base.
  const registries = new Map<string, string>();
  const classValued = new Map<string, string>();
  const scope = (name: string): Fact => {
    if (paramNames.has(name)) return paramFact(params.find((p) => p.name === name));
    return table.get(name) ?? UNKNOWN;
  };
  // Collections whose element type the source states (a parameter, an annotated local), by name: `collections`.
  /** A `for` target (a statement's or a comprehension's): typed by what it loops over, else true is not returned. */
  const bindLoop = (clause: Node): boolean => {
    const left = clause.childForFieldName("left");
    const over = left ? loopOver(clause.childForFieldName("right"), collections) : null;
    if (!left) return false;
    const targets = left.type === "identifier" ? [left] : left.type === "pattern_list" || left.type === "tuple_pattern" ? left.namedChildren : [];
    if (!over) {
      // A loop over a field or a call's result (`for c in self.clubs`, `for c in repo.load()`): the element of the
      // type that field or call DECLARES, which the linker reads.
      const source = loopSource(clause.childForFieldName("right"));
      const element = source ? (source.pair ? targets[1] : targets.length === 1 ? targets[0] : undefined) : undefined;
      if (!source || !element || element.type !== "identifier" || (source.pair && targets.length !== 2)) return false;
      for (const t of targets) {
        if (t !== element) boundNames(t, (n) => { table.assign(n, UNKNOWN); untyped.add(n); });
        else {
          table.assign(t.text, UNKNOWN);
          const calls = fromCalls.get(t.text) ?? fromCalls.set(t.text, new Map()).get(t.text)!;
          calls.set(`element ${source.from}`, { from: source.from, awaited: false, element: true });
        }
      }
      return true;
    }
    // `for c in clubs`, `for c in by_id.values()`: the target is the element; `for i, c in enumerate(clubs)` and
    // `for k, c in by_id.items()`: the second target is (the first is a counter or a key).
    const element = over.pair ? targets[1] : targets.length === 1 ? targets[0] : undefined;
    if (!element || element.type !== "identifier" || (over.pair && targets.length !== 2)) return false;
    for (const t of targets) {
      if (t === element) {
        table.assign(t.text, { type: over.element });
        untyped.add(t.text);
      } else boundNames(t, (n) => { table.assign(n, UNKNOWN); untyped.add(n); });
    }
    return true;
  };
  /** The comprehensions of a statement (`[c.rank() for c in clubs]`): their targets are names of their own. */
  const comprehensions = (stmt: Node): void => {
    if (!stmt.text.includes(" for ")) return;
    const stack: Node[] = [stmt];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === "for_in_clause") {
        if (!bindLoop(node)) boundNames(node.childForFieldName("left"), (n) => { table.assign(n, UNKNOWN); untyped.add(n); });
      }
      if (node.type === "lambda" || NESTED_SCOPES.has(node.type)) continue;
      for (const c of node.namedChildren) stack.push(c);
    }
  };
  walkStatements(body, {
    loop: bindLoop,
    condition(cond) {
      const stack: Node[] = [cond];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.type === "named_expression") {
          const target = node.childForFieldName("name");
          const value = node.childForFieldName("value");
          if (target?.type === "identifier") {
            const fact = value ? valueFact(value, scope) : UNKNOWN;
            table.assign(target.text, fact);
            const call = fact === UNKNOWN && value ? initializerCall(value) : null;
            if (fact !== UNKNOWN) {
              // `(q := Club())`: a construction, as an assignment states one.
              if (fact !== NONE) untyped.add(target.text);
            } else if (call) {
              const calls = fromCalls.get(target.text) ?? fromCalls.set(target.text, new Map()).get(target.text)!;
              calls.set(`${call.awaited ? "await " : ""}${call.from}`, call);
            } else if (value?.type === "identifier" && value.text !== target.text) aliasFrom(target.text, value.text);
            else untyped.add(target.text);
          }
        }
        if (node.type === "lambda" || NESTED_SCOPES.has(node.type)) continue;
        for (const c of node.namedChildren) stack.push(c);
      }
    },
    ret(stmt) { comprehensions(stmt); },
    statement(stmt) {
      comprehensions(stmt);
      const a = stmt.namedChild(0);
      if (a?.type !== "assignment") return;
      const left = a.childForFieldName("left");
      if (!left) return;
      if (left.type !== "identifier") {
        if (left.type === "pattern_list" || left.type === "tuple_pattern" || left.type === "list_pattern") {
          // `a, b = load()`: each name is the element of the call's tuple result (the linker reads the declared `-> tuple[X, Y]`).
          const right = a.childForFieldName("right");
          const call = right && left.namedChildren.every((c) => c.type === "identifier") ? initializerCall(right) : null;
          if (call && !call.awaited) {
            left.namedChildren.forEach((n, index) => {
              table.assign(n.text, UNKNOWN);
              const calls = fromCalls.get(n.text) ?? fromCalls.set(n.text, new Map()).get(n.text)!;
              calls.set(`${call.from}#${index}`, { ...call, index });
            });
            return;
          }
          boundNames(left, (n) => { table.assign(n, UNKNOWN); untyped.add(n); });
        }
        return;
      }
      const name = left.text;
      const annotation = a.childForFieldName("type");
      if (annotation) {
        const registry = REGISTRY_TYPE.exec(annotation.text.replace(/\s+/g, ""));
        if (registry) registries.set(name, registry[1]!);
        table.declare(name, { type: collapse(annotation.text) });
        const stated = collectionElement(annotation.text);
        if (stated) collections.set(name, stated);
        return;
      }
      const comment = typeComments ? trailingTypeComment(stmt) : null;
      if (comment) {
        table.declare(name, { type: comment });
        return;
      }
      const right = a.childForFieldName("right");
      // `ctor = table.get(kind, Default)` / `ctor = table[kind]` out of a registry of classes: a class-valued local.
      const picked = right && registries.size > 0 ? registryPick(right, registries) : null;
      if (picked) {
        classValued.set(name, picked);
        table.assign(name, UNKNOWN);
        untyped.add(name);
        return;
      }
      // `obj = ctor(**args)`: an instance of the registry's stated base.
      const built = right && classValued.size > 0 && right.type === "call" ? classValued.get(right.childForFieldName("function")?.text ?? "") : undefined;
      if (built) {
        classValued.delete(name);
        table.declare(name, { type: built });
        return;
      }
      classValued.delete(name);
      const fact = right ? valueFact(right, scope) : UNKNOWN;
      table.assign(name, fact);
      if (fact !== UNKNOWN) {
        // A construction beside a call: the two disagree and neither types it.
        if (fact !== NONE) untyped.add(name);
        return;
      }
      const call = right ? initializerCall(right) : null;
      if (!call) {
        if (right?.type === "identifier" && right.text !== name) aliasFrom(name, right.text);
        else untyped.add(name);
        return;
      }
      const calls = fromCalls.get(name) ?? fromCalls.set(name, new Map()).get(name)!;
      calls.set(`${call.awaited ? "await " : ""}${call.from}`, call);
    },
    // `with Club() as c:` — `c` is what the manager's `__enter__()` returns (often the manager, not always:
    // `with BackupFile(p) as contents` yields `BackupContents`), so the linker reads `__enter__`'s declared return.
    withItem(item) {
      const value = item.childForFieldName("value");
      const expr = value?.namedChild(0);
      const alias = value?.childForFieldName("alias")?.namedChild(0);
      if (!expr || alias?.type !== "identifier") return false;
      const fact = valueFact(expr, scope);
      table.assign(alias.text, UNKNOWN);
      if (typeof fact === "object" && fact.type) {
        const calls = fromCalls.get(alias.text) ?? fromCalls.set(alias.text, new Map()).get(alias.text)!;
        const from = `${fact.type}.__enter__()`;
        calls.set(from, { from, awaited: false });
      } else untyped.add(alias.text);
      return true;
    },
    // `except LeagueError as e:` — the caught class.
    except(clause) {
      const value = clause.childForFieldName("value") ?? clause.namedChild(0);
      if (value?.type !== "as_pattern") return;
      const caught = value.namedChild(0);
      const alias = value.childForFieldName("alias")?.namedChild(0);
      if (alias?.type !== "identifier") return;
      table.assign(alias.text, caught && (caught.type === "identifier" || caught.type === "attribute") && isClassName(caught.text) ? { type: caught.text } : UNKNOWN);
      untyped.add(alias.text);
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
      const heads = aliasFroms.get(name);
      if (heads && !calls && !untyped.has(name) && heads.size === 1) out.push({ name, type: "", aliasOf: [...heads][0]! });
      if (!calls || untyped.has(name) || heads) continue;
      for (const c of calls.values()) {
        out.push({ name, type: "", from: c.from, ...(c.awaited ? { awaited: true as const } : {}), ...(c.index !== undefined ? { fromIndex: c.index } : {}), ...(c.element ? { element: true as const } : {}) });
      }
      continue;
    }
    const local: LocalType = { name, type: fact.type };
    if (fact.qualifier) local.qualifier = fact.qualifier;
    out.push(local);
  }
  return out;
}

/**
 * What a `for` statement's iterable yields: its element, and whether the target is a pair (`enumerate(xs)`,
 * `by_id.items()`: counter or key first). `pair: false` — one target takes the element; `pair: true` — two
 * targets, the second takes it. Null for an iterable the source does not type.
 */
function loopOver(right: Node | null, collections: ReadonlyMap<string, { element: string; map: boolean }>): { element: string; pair: boolean } | null {
  let node = right;
  for (let hop = 0; node && hop < 4; hop++) {
    if (node.type === "identifier") {
      const c = collections.get(node.text);
      return c && !c.map ? { element: c.element, pair: false } : null;
    }
    if (node.type !== "call") return null;
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments")?.namedChildren.filter((c) => c.type !== "comment") ?? [];
    if (fn?.type === "attribute") {
      const object = fn.childForFieldName("object");
      const method = fn.childForFieldName("attribute")?.text;
      const c = object?.type === "identifier" ? collections.get(object.text) : undefined;
      if (!c?.map || args.length > 0) return null;
      return method === "values" ? { element: c.element, pair: false } : method === "items" ? { element: c.element, pair: true } : null;
    }
    if (fn?.type !== "identifier" || args.length !== 1) return null;
    // `enumerate(clubs)` counts them; `reversed(clubs)`, `sorted(clubs)`, `list(clubs)` keep the elements.
    if (fn.text === "enumerate") {
      const inner = loopOver(args[0]!, collections);
      return inner && !inner.pair ? { element: inner.element, pair: true } : null;
    }
    if (!["reversed", "sorted", "list", "set", "tuple", "iter"].includes(fn.text)) return null;
    node = args[0]!;
  }
  return null;
}

/** `self.clubs`, `self.repo.clubs`, `repo.clubs`: an attribute chain off a name, spelled for `localTypes[].from`. */
function attributeChainText(node: Node): string | null {
  const parts: string[] = [];
  let cur: Node | null = node;
  while (cur?.type === "attribute") {
    const name = cur.childForFieldName("attribute");
    if (name?.type !== "identifier") return null;
    parts.unshift(name.text);
    cur = cur.childForFieldName("object");
  }
  if (cur?.type !== "identifier") return null;
  parts.unshift(cur.text);
  return parts.length >= 2 ? parts.join(".") : null;
}

/**
 * What a loop's iterable reads when the source types none: a field (`self.clubs`) or a call
 * (`self.repo.load()`), through the wrappers that keep the elements. `pair`: `enumerate(…)`.
 */
function loopSource(right: Node | null): { from: string; pair: boolean } | null {
  let node = right;
  let pair = false;
  for (let hop = 0; node && hop < 4; hop++) {
    if (node.type === "attribute") {
      const from = attributeChainText(node);
      return from ? { from, pair } : null;
    }
    if (node.type !== "call") return null;
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments")?.namedChildren.filter((c) => c.type !== "comment") ?? [];
    if (fn?.type === "identifier" && args.length === 1 && (fn.text === "enumerate" || ["reversed", "sorted", "list", "set", "tuple", "iter"].includes(fn.text))) {
      if (fn.text === "enumerate") {
        if (pair) return null;
        pair = true;
      }
      node = args[0]!;
      continue;
    }
    const from = callChainText(node, "python");
    return from && !PY_BUILTIN_CALLS.has(from.slice(0, -2)) ? { from, pair } : null;
  }
  return null;
}

/**
 * Typed locals of the module's own statements (`repo = ClubRepo()` above
 * `for club in repo.all():`), for the file's `<setup>`. Function and class
 * bodies are their own scopes and are left out.
 */
export function pythonTopLevelLocalTypes(root: Node, sourceText: string): LocalType[] {
  return collectLocalTypes(root, [], /#\s*type:/.test(sourceText));
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
  // `self.tactics = get_repositories(session).tactics`: no type stated, a chain the project pass types.
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
        const chain = right ? resultChainText(right) ?? (onParam ? right.text : null) ?? freeCallText(right) : null;
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
 * A free function's result as the project pass reads it, `get_repositories(session, league_id=g)` →
 * `get_repositories()`: typed by what that function returns. A class's construction is typed where
 * it is read, and a builtin returns nothing the project declares.
 */
function freeCallText(node: Node): string | null {
  const fn = node.type === "call" ? node.childForFieldName("function") : null;
  return fn?.type === "identifier" && !/^[A-Z]/.test(fn.text) && !PY_BUILTIN_CALLS.has(fn.text) ? `${fn.text}()` : null;
}

/**
 * A member chain rooted in a function's result, as the project pass reads it:
 * `get_repositories(session, group_id=g).tactics` → `get_repositories().tactics`.
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
/** Trees that mention `isinstance` at all: the gate before any call climbs its parents. */
const mentionsIsinstance = new WeakMap<object, boolean>();

/**
 * `if isinstance(x, Club): x.rank()` — the receiver `x` of a call in the branch is a `Club`. Only the
 * condition's `and` conjuncts narrow, and only the branch the condition guards (never an `else`; a tuple of classes narrows to its alternatives); the nearest enclosing narrowing wins. A name the branch rebinds before the call is not narrowed.
 */
function narrowedType(call: Node, name: string): { type: string } | null {
  let seen = mentionsIsinstance.get(call.tree);
  if (seen === undefined) {
    seen = call.tree.rootNode.text.includes("isinstance");
    mentionsIsinstance.set(call.tree, seen);
  }
  if (!seen) return null;
  let child: Node = call;
  for (let cur = call.parent; cur; child = cur, cur = cur.parent) {
    const t = cur.type;
    if (t === "function_definition" || t === "lambda" || t === "class_definition" || t === "module") return null;
    if ((t === "if_statement" || t === "elif_clause") && cur.childForFieldName("consequence")?.id === child.id) {
      const found = isinstanceOf(cur.childForFieldName("condition"), name);
      if (found) return { type: found };
    }
  }
  return null;
}

/** The class `isinstance(name, Class)` narrows `name` to, through `and`; null otherwise. */
function isinstanceOf(cond: Node | null | undefined, name: string): string | null {
  if (!cond) return null;
  if (cond.type === "parenthesized_expression") return isinstanceOf(cond.namedChild(0), name);
  if (cond.type === "boolean_operator") {
    if (cond.childForFieldName("operator")?.text !== "and") return null;
    return isinstanceOf(cond.childForFieldName("left"), name) ?? isinstanceOf(cond.childForFieldName("right"), name);
  }
  if (cond.type !== "call" || cond.childForFieldName("function")?.text !== "isinstance") return null;
  const args = cond.childForFieldName("arguments")?.namedChildren ?? [];
  if (args.length !== 2 || args[0]!.text !== name) return null;
  const cls = args[1]!;
  // `isinstance(x, (Club, Car))`: the alternatives, `A|B` — the linker takes the one that declares the called method.
  if (cls.type === "tuple") {
    const names = cls.namedChildren.map((c) => ((c.type === "identifier" || c.type === "attribute") && isClassName(c.text) ? c.text : null));
    return names.length >= 2 && names.every((n): n is string => !!n) ? names.join("|") : null;
  }
  return (cls.type === "identifier" || cls.type === "attribute") && isClassName(cls.text) ? cls.text : null;
}

export function pythonReceiverTypeOf(node: Node): { type: string; qualifier?: string } | null {
  const fn = node.childForFieldName("function");
  if (fn?.type !== "attribute") return null;
  const recv = fn.childForFieldName("object");
  if (recv?.type === "identifier") return narrowedType(node, recv.text);
  if (!recv || (recv.type !== "call" && recv.type !== "subscript")) return null;
  const fact = lookupFact(recv);
  if (!fact) return null;
  return fact.qualifier ? { type: fact.type, qualifier: fact.qualifier } : { type: fact.type };
}
