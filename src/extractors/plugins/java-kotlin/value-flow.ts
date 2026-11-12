/**
 * Java / Kotlin value-flow facts (`ValueFlowFact`, solved in core/value-flow.ts): how a function value — a method
 * reference (`this::save`, `Club::save`, `club::save`, `Club::new`, Kotlin `::save`) — travels through locals,
 * parameters, fields, returns and collections to the call that runs it (`task.run()`, Kotlin `cb()` / `f.invoke()`).
 *
 * Precision rules, because an `invoke` fact keeps its call out of the name tiers: a call is an invoke only when its
 * receiver is a name the facts know holds a function — a parameter, local or field DECLARED with a function type
 * (a JDK functional interface such as `Runnable`, `Supplier`, `Function`, or a Kotlin `() -> Unit`), or one the body
 * initializes from a method reference, a held function, a collection element of such, or a call of a method of the
 * same class declared to return a function. An ordinary class with its own `run()` states none of that.
 *
 * A lambda has no function of its own here (its calls belong to the enclosing function), but a lambda that lands in
 * a cell (a local, a field, a collection, an argument, a return, a field initializer) stands for the project
 * functions its body calls: it seeds the cell with each (`save`, `this.save`, `club.save`, `Club.save`) and copies
 * a held function its body runs (`() -> onDone.run()`). Past four distinct names, a call on one of the lambda's own
 * parameters (Kotlin's implicit `it` too), a chain or a call no project function could be, it states nothing.
 * The lambda's body is also walked for the facts it states about the enclosing function's names (its parameters
 * shadow them).
 */
import type { Node } from "web-tree-sitter";
import type { CallInfo, ParamInfo, ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { javaMethodRefName, kotlinReferenceName } from "./call-hooks.js";
import { javaManifest } from "./manifest.js";

type Lang = "java" | "kotlin";

/** Interface methods that run a held function (Java names; a Kotlin function value also has `invoke`). */
const INVOKE_METHODS = new Set(["run", "apply", "accept", "get", "call", "test", "compare", "handle"]);
/** Methods that put a value into a collection (the value is the last argument; `put` keys it by the first). */
const ADD_METHODS = new Set(["add", "addLast", "addFirst", "offer", "push", "put", "putIfAbsent", "set"]);
/** Methods whose result is an element of the collection they are called on. */
const ELEMENT_METHODS = new Set(["get", "getOrDefault", "first", "last", "getFirst", "getLast", "firstOrNull", "lastOrNull", "getValue", "peek", "poll", "pop", "remove"]);
/** Functional interfaces of the JDK (and the common Kotlin aliases) whose single method runs a function. */
const FN_INTERFACES = new Set([
  "Runnable", "Callable", "Supplier", "Consumer", "BiConsumer", "Function", "BiFunction", "UnaryOperator", "BinaryOperator",
  "Predicate", "BiPredicate", "Comparator", "IntFunction", "IntSupplier", "IntConsumer", "IntPredicate", "IntUnaryOperator",
  "IntBinaryOperator", "ToIntFunction", "ToLongFunction", "ToDoubleFunction", "LongSupplier", "LongFunction", "LongConsumer",
  "DoubleSupplier", "DoubleFunction", "DoubleConsumer", "BooleanSupplier", "ObjIntConsumer",
]);
const COLLECTIONS = new Set([
  "List", "MutableList", "ArrayList", "LinkedList", "Set", "MutableSet", "HashSet", "LinkedHashSet", "TreeSet", "Collection", "MutableCollection",
  "Iterable", "MutableIterable", "Deque", "ArrayDeque", "Queue", "Stack", "Vector", "CopyOnWriteArrayList", "Array", "Sequence",
  "Map", "MutableMap", "HashMap", "LinkedHashMap", "TreeMap", "ConcurrentHashMap", "SortedMap",
]);
const LIST_LITERALS = new Set(["listOf", "mutableListOf", "arrayListOf", "setOf", "mutableSetOf", "hashSetOf", "linkedSetOf", "arrayOf", "sequenceOf", "arrayDequeOf"]);
const MAP_LITERALS = new Set(["mapOf", "mutableMapOf", "hashMapOf", "linkedMapOf", "sortedMapOf"]);

/** Methods the JDK and Kotlin's standard library own on nearly every value: a lambda calling one states no project function. */
const LIBRARY_CALLS = new Set([
  "toString", "equals", "hashCode", "println", "print", "printf", "format", "size", "isEmpty", "isNotEmpty", "length", "add", "addAll",
  "get", "put", "remove", "contains", "forEach", "map", "filter", "stream", "collect", "join", "of", "asList", "listOf", "mapOf", "setOf",
  "mutableListOf", "mutableMapOf", "error", "require", "check", "requireNotNull", "checkNotNull", "TODO", "lazy", "let", "also", "apply",
  "with", "use", "getOrDefault", "computeIfAbsent", "info", "debug", "warn", "trace", "sleep", "orElse", "orElseGet", "ifPresent", "isPresent",
]);
/** Kotlin's standard functions, called bare. */
const KOTLIN_STD = new Set([
  "println", "print", "listOf", "mapOf", "setOf", "mutableListOf", "mutableMapOf", "mutableSetOf", "arrayOf", "error", "require", "check",
  "requireNotNull", "checkNotNull", "TODO", "lazy", "run", "with", "apply", "let", "also", "use", "repeat", "synchronized", "to",
]);
/** Lowercase or library receivers whose calls are the platform's (`log.info`, `System.out`). */
const LIBRARY_HEADS = new Set(["log", "logger", "LOG", "LOGGER", "System", "Math", "Objects", "Collections", "Arrays", "Optional", "Stream", "Thread", "String", "Integer", "Long", "Double", "Boolean", "Files", "Paths", "Instant", "Duration", "LocalDate", "LocalDateTime", "UUID", "List", "Map", "Set"]);

const norm = (text: string): string => text.replace(/\s+/g, "");

/** Whether `text` (a Java or Kotlin type as written) is a function: a JDK functional interface or a Kotlin function type. */
export function isFunctionType(text: string | null | undefined): boolean {
  if (!text) return false;
  let t = text.trim().replace(/\s+/g, " ").replace(/^(?:@\w+\s+)+/, "").replace(/^final\s+/, "").replace(/\?$/, "");
  if (t.startsWith("suspend ")) t = t.slice(8).trim();
  while (t.startsWith("(") && t.endsWith(")") && wrapsWhole(t)) t = t.slice(1, -1).trim().replace(/\?$/, "");
  if (hasTopLevelArrow(t)) return true;
  const simple = t.replace(/<[\s\S]*$/, "").split(".").pop()!;
  return FN_INTERFACES.has(simple);
}

/** The parentheses at both ends of `t` are one pair. */
function wrapsWhole(t: string): boolean {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")" && --depth === 0 && i < t.length - 1) return false;
  }
  return true;
}

function hasTopLevelArrow(t: string): boolean {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === "-" && t[i + 1] === ">") { if (depth === 0) return true; i++; continue; }
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
  }
  return false;
}

/** Top-level comma-separated type arguments of `Name<A, B>`. */
function typeArguments(text: string): string[] {
  const open = text.indexOf("<");
  const close = text.lastIndexOf(">");
  if (open < 0 || close < open) return [];
  const out: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const ch = text[i]!;
    if (ch === "-" && text[i + 1] === ">") { i++; continue; }
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth--;
    else if (ch === "," && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
  }
  out.push(text.slice(start, close).trim());
  return out;
}

/** Whether `text` is a collection (or array) whose elements are functions. */
export function isFunctionCollectionType(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.trim().replace(/\?$/, "");
  if (t.endsWith("[]")) return isFunctionType(t.slice(0, -2));
  const base = t.replace(/<[\s\S]*$/, "").split(".").pop()!;
  if (!COLLECTIONS.has(base)) return false;
  const args = typeArguments(t);
  if (args.length === 0) return false;
  return isFunctionType(/Map$/.test(base) ? args[args.length - 1] : args[0]);
}

/**
 * An initializer that builds an object (`new Task()`, an anonymous class, Kotlin `Task()` / `object : Runnable`): a
 * local or field it initializes is that object, whatever interface it is declared as, and the ordinary linker types it.
 */
function buildsObject(init: Node | null | undefined): boolean {
  if (!init) return false;
  if (init.type === "object_creation_expression" || init.type === "object_literal") return true;
  if (init.type === "call_expression") {
    const callee = init.children[0];
    return callee?.type === "simple_identifier" && /^[A-Z]/.test(callee.text);
  }
  return false;
}

/** What a class body states about its function-valued members. */
export interface ClassFlow {
  /** Every field of the class (a bare name that is none of a function's locals is a field when listed). */
  fields: Set<string>;
  /** Fields holding a function. */
  fn: Set<string>;
  /** Fields holding a collection of functions. */
  elem: Set<string>;
  /** Methods declared to return a function. */
  returnsFn: Set<string>;
  /** Facts the field initializers state; the class attaches them to one of its methods. */
  initFacts: ValueFlowFact[];
  /** What the file around the class says about which names are a library's (see `isLibraryCall`). */
  library: LibraryContext | null;
}

function emptyClassFlow(library: LibraryContext | null = null): ClassFlow {
  return { fields: new Set(), fn: new Set(), elem: new Set(), returnsFn: new Set(), initFacts: [], library };
}

/** One `import` of the file. */
interface FileImport {
  /** Dotted path as written (`io.javalin.apibuilder.ApiBuilder`, `spark.Spark`; for a wildcard, without the `.*`). */
  path: string;
  /** `import static` (Java). */
  static: boolean;
  /** A wildcard import: every member of `path`. */
  star: boolean;
  /** The name it brings into scope: the last segment, or the `as` alias; null for a wildcard. */
  name: string | null;
}

/** What one source file says about where its names come from: its package, its imports and the methods it declares. */
export interface LibraryContext {
  pkg: string | null;
  imports: FileImport[];
  /** Every method / function the file declares, in any class (a call to one of these is the project's own). */
  declared: Set<string>;
}

/** The package a file belongs to as a project: its first two segments (`com.example`), one fewer for a two-segment package so `shop.billing` and `shop.catalog` are one project. */
const rootPackage = (pkg: string): string => {
  const parts = pkg.split(".");
  return parts.slice(0, Math.max(1, Math.min(2, parts.length - 1))).join(".");
};

/** Read a file's package, imports and declared method names (`root`: the tree's root node). */
export function libraryContextOf(root: Node): LibraryContext {
  const ctx: LibraryContext = { pkg: null, imports: [], declared: new Set() };
  const visit = (n: Node): void => {
    for (const c of n.children) {
      if (c.type === "package_declaration" || c.type === "package_header") {
        ctx.pkg = /package\s+([\w.]+)/.exec(c.text)?.[1] ?? null;
      } else if (c.type === "import_declaration" || c.type === "import_header") {
        const m = /^import\s+(static\s+)?([\w.]+?)(\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*$/.exec(c.text.trim());
        if (m) ctx.imports.push({ path: m[2]!, static: !!m[1], star: !!m[3], name: m[3] ? null : m[4] ?? m[2]!.split(".").pop()! });
      } else if (c.type === "import_list" || c.type === "source_file" || c.type === "program") visit(c);
    }
  };
  visit(root);
  for (const m of root.descendantsOfType(["method_declaration", "function_declaration"])) {
    const name = m.type === "method_declaration" ? m.childForFieldName("name")?.text : m.children.find((c) => c.type === "simple_identifier")?.text;
    if (name) ctx.declared.add(name);
  }
  return ctx;
}

/** A path that is the platform's or a library's: a known external prefix, or outside the file's own root package. */
function externalPath(lib: LibraryContext, path: string): boolean {
  if (javaManifest.externalModulePrefixes?.some((p) => path.startsWith(p))) return true;
  if (lib.pkg === null) return false;
  const root = rootPackage(lib.pkg);
  return path !== root && !path.startsWith(`${root}.`);
}

/**
 * Whether a call is made into a library rather than the project: `get("/x") { … }` of a statically imported route DSL
 * (`import static spark.Spark.*`, Ktor's `routing { get(…) }`), or `app.get(…)` on a receiver typed by an imported
 * library class (`Javalin app`). A library call states no `arg` fact: core binds an argument only to the formals of a
 * project callee, so there is nothing to link.
 *
 * - `receiverType` null (a bare call, or a receiver of unknown type): never library when the file declares a method of
 *   that name; Java: a single or wildcard `import static` of a path outside the file's root package (its first two
 *   `package` segments, one fewer for a two-segment package) or under the manifest's `externalModulePrefixes`; Kotlin: a wildcard import, or an import of
 *   that very name, from such a path. A call on an untyped receiver (a lambda parameter) is the caller's to leave alone.
 * - `receiverType` given: library when it names a class the file imports from such a path.
 *
 * `name` is the callee's last segment.
 */
export function isLibraryCall(lib: LibraryContext | null | undefined, lang: Lang, name: string, receiverType?: string | null): boolean {
  if (!lib) return false;
  if (receiverType) {
    const base = receiverType.replace(/<[\s\S]*$/, "").replace(/\?$/, "").trim().split(".").pop()!;
    return lib.imports.some((i) => !i.star && !i.static && i.name === base && externalPath(lib, i.path));
  }
  if (lib.declared.has(name)) return false;
  return lib.imports.some((i) => {
    if (lang === "java" && !i.static) return false;
    if (lang === "kotlin" && i.static) return false;
    if (!i.star && i.name !== name) return false;
    return externalPath(lib, i.path);
  });
}

/** A Kotlin declaration's type node (after the `:` of its `variable_declaration` / parameter). */
function kotlinDeclaredType(holder: Node): Node | null {
  return holder.children.find((c) => c.type === "function_type" || c.type === "user_type" || c.type === "nullable_type" || c.type === "parenthesized_type") ?? null;
}

/** The members of a class body, with the bodies of enum constants' declarations and companions flattened in. */
function* members(body: Node): Generator<Node> {
  for (const m of body.children) {
    if (m.type === "enum_body_declarations") yield* members(m);
    else if (m.type === "companion_object" || m.type === "object_declaration") {
      const inner = m.children.find((c) => c.type === "class_body");
      if (inner) yield* members(inner);
    } else yield m;
  }
}

/** Read a class body once: which members hold functions, and what its field initializers do with them. */
export function classFlowOf(body: Node, lang: Lang, headerFields: ReadonlyArray<{ name: string; type: string | null }> = [], library: LibraryContext | null = null): ClassFlow {
  const ctx = emptyClassFlow(library);
  const decls: Array<{ name: string; type: string | null; init: Node | null }> = [];
  for (const h of headerFields) {
    ctx.fields.add(h.name);
    if (isFunctionType(h.type)) ctx.fn.add(h.name);
    else if (isFunctionCollectionType(h.type)) ctx.elem.add(h.name);
  }
  for (const m of members(body)) {
    if (m.type === "method_declaration") {
      const name = m.childForFieldName("name")?.text;
      if (name && isFunctionType(m.childForFieldName("type")?.text)) ctx.returnsFn.add(name);
    } else if (m.type === "function_declaration") {
      const name = m.children.find((c) => c.type === "simple_identifier")?.text;
      const colon = m.children.findIndex((c) => c.type === ":");
      const ret = colon >= 0 && m.children.findIndex((c) => c.type === "function_value_parameters") < colon ? m.children[colon + 1] : undefined;
      if (name && ret && isFunctionType(ret.text)) ctx.returnsFn.add(name);
    } else if (m.type === "field_declaration" && lang === "java") {
      const type = m.childForFieldName("type")?.text ?? null;
      for (const d of m.children) {
        if (d.type !== "variable_declarator") continue;
        const name = d.childForFieldName("name")?.text;
        if (name) decls.push({ name, type, init: d.childForFieldName("value") });
      }
    } else if (m.type === "property_declaration" && lang === "kotlin") {
      const holder = m.children.find((c) => c.type === "variable_declaration");
      const name = holder?.children.find((c) => c.type === "simple_identifier")?.text;
      if (!holder || !name) continue;
      const eq = m.children.findIndex((c) => c.type === "=");
      const init = eq >= 0 ? m.children[eq + 1] ?? null : null;
      decls.push({ name, type: kotlinDeclaredType(holder)?.text ?? null, init });
    }
  }
  const flow = new Flow(lang, ctx, null, false);
  for (const d of decls) {
    ctx.fields.add(d.name);
    if (isFunctionType(d.type) && !buildsObject(d.init)) ctx.fn.add(d.name);
    else if (isFunctionCollectionType(d.type)) ctx.elem.add(d.name);
  }
  // Initializers: a method reference or collection of them makes an untyped field a function / collection of them.
  for (const d of decls) {
    if (!d.init) continue;
    const dest: ValueCell = { name: "this", member: d.name };
    const kind = flow.initialize(dest, d.name, true, d.init, ctx.fn.has(d.name), ctx.elem.has(d.name), d.type === null);
    if (kind === "fn") ctx.fn.add(d.name);
    else if (kind === "elem") ctx.elem.add(d.name);
  }
  ctx.initFacts = flow.facts;
  return ctx;
}

type Kind = "fn" | "elem" | null;
interface Ref { cell: ValueCell; fn: boolean; elem: boolean; field?: string; name: string }

/** The facts of one function body, or of a class's field initializers (`calls` null: only seeds and copies). */
class Flow {
  readonly facts: ValueFlowFact[] = [];
  private readonly fnNames = new Set<string>();
  private readonly elemNames = new Set<string>();
  private readonly bound = new Set<string>();
  private readonly shadow: Map<string, boolean>[] = [];
  /** `forEach` lambdas whose single parameter holds the collection's functions (lambda node id → name). */
  private readonly forEachParams = new Map<number, string>();
  private lambdaDepth = 0;
  private readonly seen = new Set<string>();

  constructor(
    private readonly lang: Lang,
    private readonly ctx: ClassFlow | null,
    private readonly calls: readonly CallInfo[] | null,
    private readonly returnsFn: boolean,
    /** The file's imports and declared methods (a free function has no `ctx` to carry them). */
    readonly library: LibraryContext | null = ctx?.library ?? null,
  ) {}

  /** Declared types of the member's parameters, for a call on one (`Javalin app` → `app.get(…)`). */
  private readonly paramTypes = new Map<string, string>();

  private push(f: ValueFlowFact): void {
    const key = JSON.stringify(f);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.facts.push(f);
  }

  bind(name: string, fn: boolean, elem: boolean): void {
    this.bound.add(name);
    if (fn) this.fnNames.add(name);
    if (elem) this.elemNames.add(name);
  }

  // ── names ────────────────────────────────────────────────────────────────
  private nameRef(name: string): Ref | null {
    for (let i = this.shadow.length - 1; i >= 0; i--) {
      const held = this.shadow[i]!.get(name);
      if (held !== undefined) return { cell: { name }, fn: held, elem: false, name };
    }
    if (this.bound.has(name)) {
      return { cell: { name }, fn: this.fnNames.has(name), elem: this.elemNames.has(name), name };
    }
    if (this.ctx?.fields.has(name)) {
      return { cell: { name: "this", member: name }, fn: this.ctx.fn.has(name), elem: this.ctx.elem.has(name), field: name, name };
    }
    return null;
  }

  /** `x`, `this.x` (Java `field_access`, Kotlin navigation on `this`), parenthesized. */
  private refOf(node: Node | null | undefined): Ref | null {
    if (!node) return null;
    switch (node.type) {
      case "identifier":
      case "simple_identifier":
        return this.nameRef(node.text);
      case "parenthesized_expression":
        return this.refOf(node.namedChildren[0]);
      case "field_access": {
        const obj = node.childForFieldName("object");
        const field = node.childForFieldName("field")?.text;
        return obj?.type === "this" && field && this.ctx?.fields.has(field) ? this.fieldRef(field) : null;
      }
      case "navigation_expression": {
        const [head, suffix] = node.namedChildren;
        const field = suffix?.type === "navigation_suffix" && !suffix.text.startsWith("::") ? suffix.namedChildren[0]?.text : undefined;
        return head?.type === "this_expression" && node.namedChildren.length === 2 && field && this.ctx?.fields.has(field) ? this.fieldRef(field) : null;
      }
      default:
        return null;
    }
  }

  private fieldRef(field: string): Ref {
    return { cell: { name: "this", member: field }, fn: !!this.ctx?.fn.has(field), elem: !!this.ctx?.elem.has(field), field, name: field };
  }

  /** The cell of a collection's elements (`key`: a literal map key). */
  private elementCell(ref: Ref, key?: string): ValueCell {
    if (ref.field !== undefined) return { name: "this", member: `${ref.field}[${key ?? ""}]` };
    return { name: ref.name, member: key ?? "[]" };
  }

  private pseudo(node: Node): ValueCell {
    return { name: `$v${node.startPosition.row + 1}_${node.startPosition.column}` };
  }

  // ── expressions ──────────────────────────────────────────────────────────
  private methodRefName(node: Node): string | null {
    if (this.lang === "java") return node.type === "method_reference" ? javaMethodRefName(node) : null;
    if ((node.type !== "callable_reference" && node.type !== "navigation_expression") || !node.text.includes("::")) return null;
    const named = kotlinReferenceName(node);
    if (named) return named.name;
    // A bound reference (`club::save`): the local's own member.
    const bound = /^([a-z_]\w*(?:\.[A-Za-z_]\w*)*)::([A-Za-z_]\w*)$/.exec(norm(node.text));
    return bound ? `${bound[1]}.${bound[2]}` : null;
  }

  private static literalKey(node: Node | null | undefined): string | null {
    if (!node || node.type !== "string_literal") return null;
    const text = node.text;
    return text.length >= 2 && !/[\\$]/.test(text) ? text.slice(1, -1) : null;
  }

  /** The collection and key an element read names: `hs.get(i)`, `hs[0]`, `table["k"]`, `hs.first()`, `hs.values()`. */
  private elementRead(node: Node | null | undefined): ValueCell | null {
    if (!node) return null;
    let base: Ref | null = null;
    let key: string | null = null;
    if (node.type === "array_access") {
      base = this.refOf(node.childForFieldName("array"));
      key = Flow.literalKey(node.childForFieldName("index"));
    } else if (node.type === "indexing_expression") {
      base = this.refOf(node.namedChildren[0]);
      key = Flow.literalKey(node.namedChildren.find((c) => c.type === "indexing_suffix")?.namedChildren[0]);
    } else if (node.type === "method_invocation") {
      const name = node.childForFieldName("name")?.text;
      if (name && (ELEMENT_METHODS.has(name))) {
        base = this.refOf(node.childForFieldName("object"));
        const first = node.childForFieldName("arguments")?.namedChildren[0];
        key = name === "get" || name === "getOrDefault" ? Flow.literalKey(first) : null;
      }
    } else if (node.type === "call_expression" && this.lang === "kotlin") {
      const callee = node.children[0];
      if (callee?.type === "navigation_expression") {
        const name = callee.namedChildren[1]?.namedChildren[0]?.text;
        if (name && ELEMENT_METHODS.has(name)) {
          base = this.refOf(callee.namedChildren[0]);
          const first = node.children.find((c) => c.type === "call_suffix")?.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren[0]?.namedChildren[0];
          key = name === "get" || name === "getValue" || name === "getOrDefault" ? Flow.literalKey(first) : null;
        }
      }
    }
    return base?.elem ? this.elementCell(base, key ?? undefined) : null;
  }

  /** The call a same-class method declaration says returns a function (`factory()`, `this.factory()`). */
  private returnsFnCall(node: Node): boolean {
    if (!this.ctx) return false;
    if (node.type === "method_invocation") {
      const obj = node.childForFieldName("object");
      const name = node.childForFieldName("name")?.text;
      return !!name && (!obj || obj.type === "this") && this.ctx.returnsFn.has(name);
    }
    if (node.type === "call_expression" && this.lang === "kotlin") {
      const callee = node.children[0];
      if (callee?.type === "simple_identifier") return this.ctx.returnsFn.has(callee.text);
      if (callee?.type === "navigation_expression" && callee.namedChildren[0]?.type === "this_expression") {
        return this.ctx.returnsFn.has(callee.namedChildren[1]?.namedChildren[0]?.text ?? "");
      }
    }
    return false;
  }

  /** Whether an expression evaluates to a function the facts can follow. */
  private isFnExpr(node: Node | null | undefined): boolean {
    if (!node) return false;
    if (node.type === "parenthesized_expression") return this.isFnExpr(node.namedChildren[0]);
    if (Flow.isLambda(node)) return this.lambdaTargets(node) !== null;
    if (this.methodRefName(node)) return true;
    const ref = this.refOf(node);
    if (ref) return ref.fn;
    return this.elementRead(node) !== null || this.returnsFnCall(node);
  }

  /** The existing call this node is (the call list's own name and line; a broken chain reports the name's line). */
  private matchCall(node: Node): { call: string; line: number } | null {
    if (!this.calls) return null;
    const written = this.calleeText(node);
    if (!written) return null;
    if (!this.callIndex) {
      this.callIndex = new Set(this.calls.map((c) => `${c.name}@${c.line}`));
    }
    const rows = [node.startPosition.row + 1];
    const nameRow = node.childForFieldName("name")?.startPosition.row;
    if (nameRow !== undefined && nameRow + 1 !== rows[0]) rows.push(nameRow + 1);
    for (const v of [written, written.replace(/\?\./g, "."), written.replace(/!!/g, "")]) {
      for (const line of rows) if (this.callIndex.has(`${v}@${line}`)) return { call: v, line };
    }
    return null;
  }
  private callIndex: Set<string> | null = null;

  /** The call list has a row of this call's name, on whatever line (rows of one name in a method are kept once). */
  private callNamed(node: Node): boolean {
    const written = this.calleeText(node);
    if (!written || !this.calls) return false;
    this.callNames ??= new Set(this.calls.map((c) => c.name));
    return this.callNames.has(written);
  }
  private callNames: Set<string> | null = null;

  /** The call's name as the call list spells it. */
  private calleeText(node: Node): string | null {
    if (node.type === "method_invocation") {
      const name = node.childForFieldName("name")?.text;
      const obj = node.childForFieldName("object");
      return name ? (obj ? `${norm(obj.text)}.${name}` : name) : null;
    }
    if (node.type === "object_creation_expression") {
      const type = node.childForFieldName("type")?.text.replace(/<[\s\S]*$/, "").replace(/\s+/g, "");
      return type ?? null;
    }
    if (node.type === "call_expression") {
      const callee = node.children[0];
      return callee ? norm(callee.text) : null;
    }
    return null;
  }

  /** A cell holding the expression's function, stating what the expression needs (a method reference seeds a temporary). */
  private valueCell(node: Node | null | undefined): ValueCell | null {
    if (!node) return null;
    if (node.type === "parenthesized_expression") return this.valueCell(node.namedChildren[0]);
    const line = node.startPosition.row + 1;
    if (Flow.isLambda(node)) {
      const to = this.pseudo(node);
      return this.lambdaInto(to, node) ? to : null;
    }
    const named = this.methodRefName(node);
    if (named) {
      const to = this.pseudo(node);
      this.push({ kind: "seed", to, fn: named, line });
      return to;
    }
    const ref = this.refOf(node);
    if (ref) return ref.fn ? ref.cell : null;
    const element = this.elementRead(node);
    if (element) {
      const to = this.pseudo(node);
      this.push({ kind: "copy", from: element, to, line });
      return to;
    }
    return null;
  }

  /** `dest` takes the expression's function (a method reference seeds it directly). Returns whether a fact was stated. */
  private flowInto(dest: ValueCell, node: Node | null | undefined, destFn: boolean): boolean {
    if (!node) return false;
    if (node.type === "parenthesized_expression") return this.flowInto(dest, node.namedChildren[0], destFn);
    const line = node.startPosition.row + 1;
    if (Flow.isLambda(node)) return this.lambdaInto(dest, node);
    const named = this.methodRefName(node);
    if (named) { this.push({ kind: "seed", to: dest, fn: named, line }); return true; }
    const ref = this.refOf(node);
    if (ref) {
      if (!ref.fn) return false;
      this.push({ kind: "copy", from: ref.cell, to: dest, line });
      return true;
    }
    const element = this.elementRead(node);
    if (element) { this.push({ kind: "copy", from: element, to: dest, line }); return true; }
    if ((node.type === "method_invocation" || node.type === "call_expression") && (destFn || this.returnsFnCall(node))) {
      const hit = this.matchCall(node);
      if (hit) { this.push({ kind: "result", call: hit.call, line: hit.line, to: dest }); return true; }
    }
    return false;
  }

  /** Elements of a collection literal flow into `dest`'s element cells. Returns whether any element was a function. */
  private literalInto(dest: Ref, node: Node | null | undefined): boolean {
    if (!node) return false;
    let any = false;
    const element = (value: Node | undefined, key: string | null): void => {
      if (!value) return;
      if (this.flowInto(this.elementCell(dest), value, false)) {
        any = true;
        if (key !== null) this.flowInto(this.elementCell(dest, key), value, false);
      }
    };
    if (node.type === "array_initializer") {
      for (const e of node.namedChildren) element(e, null);
    } else if (node.type === "array_creation_expression") {
      for (const c of node.namedChildren) if (c.type === "array_initializer") any = this.literalInto(dest, c) || any;
    } else if (node.type === "method_invocation" && this.lang === "java") {
      const obj = node.childForFieldName("object")?.text;
      const name = node.childForFieldName("name")?.text;
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      if (obj === "Map" && (name === "of" || name === "ofEntries")) {
        for (let i = 1; i < args.length; i += 2) element(args[i], Flow.literalKey(args[i - 1]));
      } else if ((obj === "List" || obj === "Set" || obj === "Stream") && name === "of") {
        for (const a of args) element(a, null);
      } else if (obj === "Arrays" && name === "asList") {
        for (const a of args) element(a, null);
      }
    } else if (node.type === "call_expression" && this.lang === "kotlin") {
      const callee = node.children[0];
      const name = callee?.type === "simple_identifier" ? callee.text : undefined;
      const args = node.children.find((c) => c.type === "call_suffix")?.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
      if (name && LIST_LITERALS.has(name)) {
        for (const a of args) element(a.namedChildren[0], null);
      } else if (name && MAP_LITERALS.has(name)) {
        for (const a of args) {
          const pair = a.namedChildren[0];
          if (pair?.type === "infix_expression" && pair.namedChildren[1]?.text === "to") element(pair.namedChildren[2], Flow.literalKey(pair.namedChildren[0]));
        }
      }
    }
    return any;
  }

  /** The element type a Kotlin collection builder states (`mutableListOf<() -> Unit>()`). */
  private static kotlinBuilderElementIsFunction(node: Node | null | undefined): boolean {
    if (!node || node.type !== "call_expression") return false;
    const name = node.children[0]?.type === "simple_identifier" ? node.children[0].text : "";
    const args = node.children.find((c) => c.type === "call_suffix")?.namedChildren.find((c) => c.type === "type_arguments");
    if (!args || !(LIST_LITERALS.has(name) || MAP_LITERALS.has(name) || COLLECTIONS.has(name))) return false;
    const last = args.namedChildren[args.namedChildren.length - 1];
    return !!last && isFunctionType(last.text);
  }

  /**
   * A declaration or field's initializer: `dest` is a function (a method reference, a held function, an element, a
   * call), or a collection of them (a literal of references). Returns what it turned out to hold.
   */
  initialize(dest: ValueCell, name: string, field: boolean, init: Node, declaredFn: boolean, declaredElem: boolean, untyped: boolean): Kind {
    if (!declaredFn) {
      const ref: Ref = { cell: dest, fn: false, elem: true, name, ...(field ? { field: name } : {}) };
      if (this.literalInto(ref, init)) return "elem";
      if (declaredElem || (untyped && Flow.kotlinBuilderElementIsFunction(init))) return "elem";
    }
    if (declaredFn || (untyped && this.isFnExpr(init))) {
      this.flowInto(dest, init, declaredFn);
      return "fn";
    }
    return null;
  }

  // ── walking ──────────────────────────────────────────────────────────────
  /** A function body: its parameters, then every statement. */
  run(params: readonly ParamInfo[], body: Node): void {
    for (const p of params) {
      if (p.isReceiver) continue;
      this.bind(p.name, isFunctionType(p.type), isFunctionCollectionType(p.type));
      if (p.type) this.paramTypes.set(p.name, p.type);
    }
    // Kotlin `fun mk(): () -> Unit = ::load`: the body is the returned expression.
    if (this.lang === "kotlin" && body.type === "function_body" && body.children[0]?.type === "=") {
      this.returned(body.children[1]);
      this.visit(body);
      return;
    }
    this.visit(body);
  }

  private visit(node: Node): void {
    switch (node.type) {
      case "local_variable_declaration":
        this.javaDeclaration(node);
        break;
      case "property_declaration":
        this.kotlinDeclaration(node);
        break;
      case "enhanced_for_statement":
        this.javaFor(node);
        break;
      case "for_statement":
        if (this.lang === "kotlin") this.kotlinFor(node);
        break;
      case "assignment_expression":
        this.javaAssignment(node);
        break;
      case "assignment":
        this.kotlinAssignment(node);
        break;
      case "return_statement":
        if (this.lambdaDepth === 0) this.returned(node.namedChildren[0]);
        break;
      case "jump_expression":
        if (this.lambdaDepth === 0 && node.children[0]?.type === "return" && !node.text.startsWith("return@")) this.returned(node.namedChildren[0]);
        break;
      case "method_invocation":
      case "call_expression":
      case "object_creation_expression":
        this.callSite(node);
        break;
      case "lambda_expression":
      case "lambda_literal": {
        this.visitLambda(node);
        return;
      }
      case "class_declaration":
      case "interface_declaration":
      case "object_literal":
      case "function_declaration":
      case "anonymous_function":
        return;
      default:
        break;
    }
    if (node.type === "object_creation_expression" && node.children.some((c) => c.type === "class_body")) {
      // An anonymous class: its arguments are this function's, its body is another scope.
      for (const c of node.children) if (c.type !== "class_body") this.visit(c);
      return;
    }
    for (const c of node.children) this.visit(c);
  }

  private lambdaParams(node: Node): string[] {
    if (node.type === "lambda_literal") {
      return node.children.find((c) => c.type === "lambda_parameters")?.children.filter((c) => c.type === "variable_declaration").map((c) => c.namedChildren[0]?.text ?? "").filter(Boolean) ?? [];
    }
    const p = node.childForFieldName("parameters");
    if (!p) return [];
    if (p.type === "identifier") return [p.text];
    const out: string[] = [];
    for (const c of p.namedChildren) {
      if (c.type === "identifier") out.push(c.text);
      else if (c.type === "formal_parameter") { const n = c.childForFieldName("name")?.text; if (n) out.push(n); }
    }
    return out;
  }

  // ── lambdas as values ────────────────────────────────────────────────────
  private static isLambda(node: Node): boolean {
    return node.type === "lambda_expression" || node.type === "lambda_literal" || node.type === "anonymous_function";
  }

  /** A lambda's own parameter names (Kotlin's implicit `it` when it declares none). */
  private lambdaParamNames(node: Node): Set<string> {
    const out = new Set(this.lambdaParams(node));
    if (node.type === "anonymous_function") {
      for (const p of node.children.find((c) => c.type === "function_value_parameters")?.namedChildren ?? []) {
        const n = p.children.find((c) => c.type === "simple_identifier")?.text;
        if (n) out.add(n);
      }
    } else if (node.type === "lambda_literal" && !node.children.some((c) => c.type === "lambda_parameters")) out.add("it");
    return out;
  }

  /** What a lambda stands for: the functions its body calls (at most four) and the held functions it runs. */
  private lambdaTargets(node: Node): { seeds: string[]; copies: ValueCell[] } | null {
    const seeds = new Set<string>();
    const copies = new Map<string, ValueCell>();
    let over = false;
    const walk = (n: Node, hidden: ReadonlySet<string>): void => {
      if (over) return;
      if (n.type === "class_body" || n.type === "function_declaration" || n.type === "class_declaration" || n.type === "object_literal") return;
      let scope = hidden;
      if (n.id !== node.id && Flow.isLambda(n)) scope = new Set([...hidden, ...this.lambdaParamNames(n)]);
      if (n.type === "method_invocation" || n.type === "call_expression") {
        this.lambdaCall(n, scope, seeds, copies);
        if (seeds.size + copies.size > 4) over = true;
      }
      for (const c of n.children) walk(c, scope);
    };
    const params = this.lambdaParamNames(node);
    for (const c of node.children) walk(c, params);
    if (over || seeds.size + copies.size === 0) return null;
    return { seeds: [...seeds], copies: [...copies.values()] };
  }

  /** One call of a lambda's body: a seed name, or a copy when it runs a held function. */
  private lambdaCall(n: Node, hidden: ReadonlySet<string>, seeds: Set<string>, copies: Map<string, ValueCell>): void {
    let name: string | undefined;
    let head: Node | null | undefined; // the receiver, when written
    let bare = false;
    if (n.type === "method_invocation") {
      name = n.childForFieldName("name")?.text;
      head = n.childForFieldName("object");
      bare = !head;
    } else {
      const callee = n.children[0];
      if (callee?.type === "simple_identifier") { name = callee.text; bare = true; }
      else if (callee?.type === "navigation_expression" && callee.namedChildren.length === 2) {
        head = callee.namedChildren[0];
        const suffix = callee.namedChildren[1];
        if (suffix?.type !== "navigation_suffix" || suffix.text.startsWith("::")) return;
        name = suffix.namedChildren[0]?.text;
      } else return;
    }
    if (!name) return;
    const simple = (x: Node | null | undefined): string | null => (x?.type === "identifier" || x?.type === "simple_identifier" ? x.text : null);
    const headText = simple(head);
    if (headText !== null && hidden.has(headText)) return;
    // A call of a held function: `onDone.run()`, Kotlin `onDone()` / `onDone.invoke()`.
    const runs = bare ? (this.lang === "kotlin" ? n.children[0] : null) : head && (INVOKE_METHODS.has(name) || (this.lang === "kotlin" && name === "invoke")) ? head : null;
    if (runs) {
      const written = simple(runs);
      if (written === null || !hidden.has(written)) {
        const ref = this.refOf(runs);
        if (ref?.fn) { copies.set(JSON.stringify(ref.cell), ref.cell); return; }
      }
    }
    // The call must be a row of the call list (a lambda bound to a local is read on its method's behalf); a row cannot
    // tell a library's call from a project's, so the platform's own names and classes are left out by name.
    // (A repeated call of one name in a method is one row, so a second `get(…)` on another line is vouched for by the name.)
    if (this.calls && !this.matchCall(n) && !this.callNamed(n)) return;
    // A bare or `this.` call is the class's own member (Kotlin's standard functions aside); the platform's names are those on a receiver.
    if (bare) {
      if (hidden.has(name) || (this.lang === "kotlin" && (/^[A-Z]/.test(name) || KOTLIN_STD.has(name)))) return;
      seeds.add(name);
    } else if (head?.type === "this" || head?.type === "this_expression") seeds.add(`this.${name}`);
    else if (headText !== null && !LIBRARY_HEADS.has(headText) && !LIBRARY_CALLS.has(name)) seeds.add(`${headText}.${name}`);
  }

  /** `dest` holds the lambda: a seed per function its body calls, a copy per held function it runs. */
  private lambdaInto(dest: ValueCell, node: Node): boolean {
    const targets = this.lambdaTargets(node);
    if (!targets) return false;
    const line = node.startPosition.row + 1;
    for (const fn of targets.seeds) this.push({ kind: "seed", to: dest, fn, line });
    for (const from of targets.copies) this.push({ kind: "copy", from, to: dest, line });
    return true;
  }

  private visitLambda(node: Node): void {
    // A parameter holds a function only where a `forEach` over a collection of functions binds it; else it is unknown.
    const names = new Map(this.lambdaParams(node).map((n) => [n, this.forEachParams.get(node.id) === n] as const));
    this.shadow.push(names);
    this.lambdaDepth++;
    const body = node.type === "lambda_literal" ? node.children.filter((c) => c.type === "statements") : [node.childForFieldName("body")].filter((c): c is Node => !!c);
    for (const b of body) this.visit(b);
    this.lambdaDepth--;
    this.shadow.pop();
  }

  // ── statements ───────────────────────────────────────────────────────────
  private javaDeclaration(node: Node): void {
    const type = node.childForFieldName("type")?.text ?? null;
    const typed = type !== null && type !== "var";
    for (const d of node.children) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name")?.text;
      if (!name) continue;
      this.declare(name, typed ? type : null, d.childForFieldName("value"));
    }
  }

  private kotlinDeclaration(node: Node): void {
    const holder = node.children.find((c) => c.type === "variable_declaration");
    const name = holder?.children.find((c) => c.type === "simple_identifier")?.text;
    if (!holder || !name) return;
    const eq = node.children.findIndex((c) => c.type === "=");
    this.declare(name, kotlinDeclaredType(holder)?.text ?? null, eq >= 0 ? node.children[eq + 1] ?? null : null);
  }

  private declare(name: string, type: string | null, init: Node | null | undefined): void {
    const declaredFn = isFunctionType(type) && !buildsObject(init);
    const declaredElem = isFunctionCollectionType(type);
    // The initializer is read before the name it declares is bound (`var f = f2`).
    let kind: Kind = null;
    if (init) kind = this.initialize({ name }, name, false, init, declaredFn, declaredElem, type === null);
    this.bind(name, declaredFn || kind === "fn", declaredElem || kind === "elem");
  }

  private javaFor(node: Node): void {
    const name = node.childForFieldName("name")?.text;
    const source = this.refOf(node.childForFieldName("value")) ?? this.valuesOf(node.childForFieldName("value"));
    if (!name) return;
    const type = node.childForFieldName("type")?.text ?? null;
    const fn = isFunctionType(type) || !!source?.elem;
    this.bind(name, fn, false);
    if (source?.elem) this.push({ kind: "copy", from: this.elementCell(source), to: { name }, line: node.startPosition.row + 1 });
  }

  private kotlinFor(node: Node): void {
    const variable = node.children.find((c) => c.type === "variable_declaration");
    const name = variable?.children.find((c) => c.type === "simple_identifier")?.text;
    const inAt = node.children.findIndex((c) => c.type === "in");
    const iterated = inAt >= 0 ? node.children[inAt + 1] : undefined;
    if (!name) return;
    const source = this.refOf(iterated) ?? this.valuesOf(iterated);
    this.bind(name, !!source?.elem, false);
    if (source?.elem) this.push({ kind: "copy", from: this.elementCell(source), to: { name }, line: node.startPosition.row + 1 });
  }

  /** `table.values()` / `table.values`: the map's elements. */
  private valuesOf(node: Node | null | undefined): Ref | null {
    if (!node) return null;
    if (node.type === "method_invocation" && node.childForFieldName("name")?.text === "values") return this.refOf(node.childForFieldName("object"));
    if (node.type === "navigation_expression" && node.namedChildren[1]?.namedChildren[0]?.text === "values") return this.refOf(node.namedChildren[0]);
    if (node.type === "call_expression" && node.children[0]?.type === "navigation_expression" && node.children[0].namedChildren[1]?.namedChildren[0]?.text === "values") return this.refOf(node.children[0].namedChildren[0]);
    return null;
  }

  private javaAssignment(node: Node): void {
    if (node.children[1]?.type !== "=") return;
    this.assign(node.childForFieldName("left"), node.childForFieldName("right"));
  }

  private kotlinAssignment(node: Node): void {
    const eq = node.children.findIndex((c) => c.type === "=");
    const left = node.children[0];
    if (eq < 0 || left?.type !== "directly_assignable_expression") return;
    this.assign(left, node.children[eq + 1]);
  }

  private assign(left: Node | null | undefined, right: Node | null | undefined): void {
    if (!left || !right) return;
    // Element write: `hs[0] = ::load`, `table["k"] = ::save`.
    let base: Ref | null = null;
    let key: string | null = null;
    if (left.type === "array_access") {
      base = this.refOf(left.childForFieldName("array"));
      key = Flow.literalKey(left.childForFieldName("index"));
    } else if (left.type === "directly_assignable_expression" && left.children.some((c) => c.type === "indexing_suffix")) {
      base = this.refOf(left.namedChildren[0]);
      key = Flow.literalKey(left.children.find((c) => c.type === "indexing_suffix")?.namedChildren[0]);
    }
    if (base) {
      this.putElement(base, key, right);
      return;
    }
    const ref = left.type === "directly_assignable_expression"
      ? (left.namedChildren.length === 1 ? this.refOf(left.namedChildren[0]) : this.thisMember(left))
      : this.refOf(left);
    if (!ref) return;
    if (this.flowInto(ref.cell, right, ref.fn) && !ref.field) this.fnNames.add(ref.name);
  }

  /** Kotlin `this.cb = …`: a `directly_assignable_expression` of `this` and a navigation suffix. */
  private thisMember(left: Node): Ref | null {
    const [head, suffix] = left.namedChildren;
    const field = suffix?.type === "navigation_suffix" ? suffix.namedChildren[0]?.text : undefined;
    return head?.type === "this_expression" && field && this.ctx?.fields.has(field) ? this.fieldRef(field) : null;
  }

  private putElement(base: Ref, key: string | null, value: Node | undefined): void {
    if (!value || !this.isFnExpr(value)) return;
    if (this.flowInto(this.elementCell(base), value, false)) {
      if (key !== null) this.flowInto(this.elementCell(base, key), value, false);
      if (!base.field) this.elemNames.add(base.name);
    }
  }

  /** `return x` / an expression body: the function returns what `x` holds. */
  private returned(node: Node | null | undefined): void {
    if (!node) return;
    const line = node.startPosition.row + 1;
    let from = this.valueCell(node);
    if (!from && this.returnsFn && (node.type === "method_invocation" || node.type === "call_expression")) {
      const hit = this.matchCall(node);
      if (hit) {
        from = this.pseudo(node);
        this.push({ kind: "result", call: hit.call, line: hit.line, to: from });
      }
    }
    if (from) this.push({ kind: "return", from, line });
  }

  // ── calls ────────────────────────────────────────────────────────────────
  private callSite(node: Node): void {
    const args = this.argumentsOf(node);
    this.collectionWrite(node, args);
    this.forEachLambda(node);
    const hit = this.matchCall(node);
    if (!hit) return;
    const { call, line } = hit;
    this.invokeOf(node, call, line);
    if (args.named) return;
    // A lambda handed to the platform's own `forEach` / `map` / `run { }` is never run by a project function.
    const leaf = call.split(".").pop()!;
    const platform = LIBRARY_CALLS.has(leaf) || KOTLIN_STD.has(leaf);
    // A call into an imported library (a route DSL, a typed client) runs no project function either.
    if (this.libraryCall(call, line)) return;
    args.nodes.forEach((a, index) => {
      if (platform && Flow.isLambda(a)) return;
      const from = this.valueCell(a);
      if (from) this.push({ kind: "arg", call, line, index, from });
    });
  }

  /** `call` (as the call list spells it) goes into a library: see `isLibraryCall`. */
  private libraryCall(call: string, line: number): boolean {
    if (!this.library) return false;
    const parts = call.split(".");
    const name = parts[parts.length - 1]!;
    if (parts.length === 1) return isLibraryCall(this.library, this.lang, name);
    if (parts.length !== 2) return false;
    // A receiver is library only by a type something states: the call row's, a parameter's, or a capitalized head
    // that is the class itself (`Javalin.create(…)`, a static call) — all of which must be imported from a library.
    const row = this.calls?.find((c) => c.name === call && c.line === line);
    const head = parts[0]!.replace(/\?$/, "");
    const type = row?.receiverType ?? this.paramTypes.get(head) ?? (/^[A-Z]/.test(head) ? head : null);
    return type !== null && isLibraryCall(this.library, this.lang, name, type);
  }

  private argumentsOf(node: Node): { nodes: Node[]; named: boolean } {
    if (node.type === "method_invocation" || node.type === "object_creation_expression") {
      return { nodes: node.childForFieldName("arguments")?.namedChildren ?? [], named: false };
    }
    const list = node.children.find((c) => c.type === "call_suffix")?.namedChildren.find((c) => c.type === "value_arguments");
    const nodes: Node[] = [];
    let named = false;
    for (const a of list?.namedChildren ?? []) {
      if (a.children.some((c) => c.type === "=" )) named = true;
      const inner = a.namedChildren[a.namedChildren.length - 1];
      if (inner) nodes.push(inner);
    }
    // A trailing lambda (`wrap { kickOff() }`) is the last argument.
    const trailing = node.children.find((c) => c.type === "call_suffix")?.namedChildren.find((c) => c.type === "annotated_lambda")?.namedChildren.find((c) => c.type === "lambda_literal");
    if (trailing) nodes.push(trailing);
    return { nodes, named };
  }

  /** `hs.add(this::save)`, `table.put("k", ::save)`, Kotlin `hs.add(::save)`. */
  private collectionWrite(node: Node, args: { nodes: Node[] }): void {
    let receiver: Node | null | undefined;
    let method: string | undefined;
    if (node.type === "method_invocation") {
      receiver = node.childForFieldName("object");
      method = node.childForFieldName("name")?.text;
    } else if (node.type === "call_expression") {
      const callee = node.children[0];
      if (callee?.type === "navigation_expression") {
        receiver = callee.namedChildren[0];
        method = callee.namedChildren[1]?.namedChildren[0]?.text;
      }
    }
    if (!receiver || !method || !ADD_METHODS.has(method) || args.nodes.length === 0) return;
    const base = this.refOf(receiver);
    if (!base || base.fn) return;
    const value = args.nodes[args.nodes.length - 1];
    const key = args.nodes.length >= 2 ? Flow.literalKey(args.nodes[0]) : null;
    if (!this.isFnExpr(value)) return;
    this.putElement(base, key, value);
    if (base.field === undefined) this.elemNames.add(base.name);
  }

  /** `hs.forEach(h -> h.run())`, Kotlin `hs.forEach { h -> h() }`: the parameter holds the collection's elements. */
  private forEachLambda(node: Node): void {
    let receiver: Node | null | undefined;
    let lambda: Node | undefined;
    if (node.type === "method_invocation" && node.childForFieldName("name")?.text === "forEach") {
      receiver = node.childForFieldName("object");
      lambda = node.childForFieldName("arguments")?.namedChildren.find((c) => c.type === "lambda_expression");
    } else if (node.type === "call_expression") {
      const callee = node.children[0];
      if (callee?.type === "navigation_expression" && callee.namedChildren[1]?.namedChildren[0]?.text === "forEach") {
        receiver = callee.namedChildren[0];
        const suffix = node.children.find((c) => c.type === "call_suffix");
        lambda = suffix?.namedChildren.find((c) => c.type === "annotated_lambda")?.namedChildren.find((c) => c.type === "lambda_literal")
          ?? suffix?.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren[0]?.namedChildren.find((c) => c.type === "lambda_literal");
      }
    }
    if (!lambda) return;
    const source = this.refOf(receiver) ?? this.valuesOf(receiver);
    const params = this.lambdaParams(lambda);
    if (!source?.elem || params.length !== 1) return;
    const name = params[0]!;
    this.forEachParams.set(lambda.id, name);
    this.push({ kind: "copy", from: this.elementCell(source), to: { name }, line: lambda.startPosition.row + 1 });
  }

  /** The call runs what its receiver holds: a function-typed name, a held function, an element of a collection of them. */
  private invokeOf(node: Node, call: string, line: number): void {
    let receiver: Node | null | undefined;
    if (node.type === "method_invocation") {
      const name = node.childForFieldName("name")?.text;
      if (!name || !INVOKE_METHODS.has(name)) return;
      receiver = node.childForFieldName("object");
    } else if (node.type === "call_expression" && this.lang === "kotlin") {
      const callee = node.children[0];
      if (!callee) return;
      if (callee.type === "simple_identifier" || callee.type === "indexing_expression") receiver = callee;
      else if (callee.type === "navigation_expression") {
        const name = callee.namedChildren[1]?.namedChildren[0]?.text;
        if (!name || !(name === "invoke" || INVOKE_METHODS.has(name))) return;
        receiver = callee.namedChildren[0];
      }
    }
    if (!receiver) return;
    const ref = this.refOf(receiver);
    if (ref) {
      if (ref.fn) this.push({ kind: "invoke", cell: ref.cell, call, line });
      return;
    }
    const element = this.elementRead(receiver);
    if (element) {
      const via = this.pseudo(receiver);
      this.push({ kind: "copy", from: element, to: via, line });
      this.push({ kind: "invoke", cell: via, call, line });
    }
  }
}

/** The value-flow facts of one method or function body (`classFlow`: the class around it, null for a free function). */
export function methodValueFlow(
  lang: Lang,
  params: readonly ParamInfo[],
  body: Node | null,
  calls: readonly CallInfo[],
  classFlow: ClassFlow | null,
  returnType: string | null,
  library: LibraryContext | null = classFlow?.library ?? null,
): ValueFlowFact[] {
  if (!body) return [];
  const flow = new Flow(lang, classFlow, calls, isFunctionType(returnType), library);
  flow.run(params, body);
  return flow.facts;
}

/** Facts for a Kotlin primary constructor: each `val`/`var` function parameter is the field of that name. */
export function constructorFieldFlow(params: ReadonlyArray<{ name: string; type: string | null }>, line: number): ValueFlowFact[] {
  const out: ValueFlowFact[] = [];
  for (const p of params) {
    if (isFunctionType(p.type) || isFunctionCollectionType(p.type)) out.push({ kind: "copy", from: { name: p.name }, to: { name: "this", member: p.name }, line });
  }
  return out;
}
