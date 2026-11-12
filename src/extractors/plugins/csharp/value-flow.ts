import type { Node } from "web-tree-sitter";
import type { ParamInfo, ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { csharpCallHooks } from "./call-hooks.js";
import { argumentsOf, unwrapExpression } from "./local-types.js";

/**
 * Value-flow facts of a C# member (`FunctionInfo.valueFlow`): how a function value — a method group, a delegate
 * held in a local, a parameter, a field or a property, an event's subscribers, an element of a list or a
 * dictionary — travels to the call that runs it (`x()`, `x.Invoke()`, `x?.Invoke()`, `Saved?.Invoke(this, e)`).
 * Only what the source states: core joins the steps and resolves every name (see `core/value-flow.ts`).
 *
 * Lambdas hold no function of their own here (their calls are already their enclosing member's), so a cell that
 * holds only lambdas holds nothing.
 */

/** What the enclosing class declares, as far as one file can say. */
export interface ClassValueContext {
  /** Field, property and event names → their declared type as written. */
  members: ReadonlyMap<string, string | null>;
  /** Names of the class's own methods (a bare name among them is a method group). */
  methods: ReadonlySet<string>;
  /** Delegate types the file declares (`delegate void Notify(string who);`). */
  delegates: ReadonlySet<string>;
  /** Cache of the member-level gate (see `mayStateFlow`). */
  signal?: RegExp | null;
}

/** BCL delegate types; a class named so is not one (no suffix guessing: `OrderEventHandler` is usually a class). */
const DELEGATE_TYPES: ReadonlySet<string> = new Set([
  "Action", "Func", "Predicate", "EventHandler", "Comparison", "Converter", "Delegate", "MulticastDelegate", "AsyncCallback",
  "ThreadStart", "ParameterizedThreadStart", "TimerCallback", "WaitCallback", "SendOrPostCallback",
  "PropertyChangedEventHandler", "NotifyCollectionChangedEventHandler", "CancelEventHandler", "ElapsedEventHandler",
  "UnhandledExceptionEventHandler", "AssemblyLoadEventHandler", "ConsoleCancelEventHandler", "FileSystemEventHandler",
  "RenamedEventHandler", "ErrorEventHandler", "DataReceivedEventHandler", "RoutedEventHandler",
]);
const SEQUENCES: ReadonlySet<string> = new Set([
  "List", "IList", "IEnumerable", "ICollection", "IReadOnlyList", "IReadOnlyCollection", "HashSet", "ISet", "Queue", "Stack",
  "ConcurrentBag", "ConcurrentQueue", "ConcurrentStack", "Collection", "ObservableCollection", "LinkedList", "ImmutableList",
  "ImmutableArray", "SortedSet", "BlockingCollection",
]);
const MAPS: ReadonlySet<string> = new Set([
  "Dictionary", "IDictionary", "IReadOnlyDictionary", "ConcurrentDictionary", "SortedDictionary", "ImmutableDictionary", "SortedList",
]);
const STORE_METHODS: ReadonlySet<string> = new Set(["Add", "Push", "Enqueue", "TryAdd", "Insert", "AddLast", "AddFirst", "Append"]);
const ELEMENT_VIEWS: ReadonlySet<string> = new Set(["Values", "Keys"]);

/** A name's shape: a delegate itself, a collection whose elements are delegates, an unknown (`var`), or neither. */
type Shape = "delegate" | "collection" | "unknown" | null;

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function shapeOfType(type: string | null | undefined, delegates: ReadonlySet<string>): Shape {
  if (!type) return null;
  let t = type.replace(/\s+/g, "").replace(/\?$/, "");
  if (t === "var") return "unknown";
  if (t.endsWith("[]")) return shapeOfType(t.slice(0, -2), delegates) ? "collection" : null;
  t = t.replace(/^global::/, "");
  const lt = t.indexOf("<");
  const head = (lt >= 0 ? t.slice(0, lt) : t).split(".").pop()!;
  if (DELEGATE_TYPES.has(head) || delegates.has(head)) return "delegate";
  if (lt < 0 || !t.endsWith(">")) return null;
  const args = splitTop(t.slice(lt + 1, -1));
  if (SEQUENCES.has(head) && args.length === 1) return shapeOfType(args[0], delegates) ? "collection" : null;
  if (MAPS.has(head) && args.length === 2) return shapeOfType(args[1], delegates) ? "collection" : null;
  return null;
}

/** `Task<Func<int>>` → `Func<int>` (an async factory's result). */
function unwrapTask(type: string | null): string | null {
  const m = type ? /^(?:System\.Threading\.Tasks\.)?(?:Task|ValueTask)<(.*)>$/.exec(type.replace(/\s+/g, "")) : null;
  return m ? m[1]! : type;
}

/** Delegate types a file declares. */
export function fileDelegateNames(root: Node): Set<string> {
  const out = new Set<string>();
  for (const d of root.descendantsOfType("delegate_declaration")) {
    const name = d.childForFieldName("name")?.text;
    if (name) out.add(name);
  }
  return out;
}


const LAMBDAS: ReadonlySet<string> = new Set(["lambda_expression", "anonymous_method_expression"]);

const DELEGATE_WORDS_RE = /\b(?:Action|Func|Predicate|EventHandler|Comparison|Converter|Delegate|Invoke|AsyncCallback|ThreadStart|TimerCallback|WaitCallback)\b|\+=/;
const NO_NAMES: ReadonlySet<string> = new Set();
const escapeRe =(s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a member's text can state a function value flow at all: a delegate type or `Invoke`, an event
 * subscription, a delegate the class or file declares, a method of the class named without a call (a method
 * group), a parameter called like a function, or a `var` that is later called. The cheap gate before any
 * tree walk — most members mention none.
 */
function mayStateFlow(text: string, params: readonly ParamInfo[], ctx: ClassValueContext | null): boolean {
  if (DELEGATE_WORDS_RE.test(text)) return true;
  if (text.length < 40000 && /\bvar\s+(\w+)\s*=[^;]*;[\s\S]*?\b\1\s*\(/.test(text)) return true;
  // A delegate parameter is a value to hand on, whatever the body says of it.
  if (params.some((p) => shapeOfType(p.type, ctx?.delegates ?? NO_NAMES))) return true;
  const called = params.map((p) => p.name).filter(Boolean).map(escapeRe);
  if (called.length > 0 && new RegExp(`\\b(?:${called.join("|")})\\s*\\(`).test(text)) return true;
  if (!ctx) return false;
  if (ctx.signal === undefined) {
    const parts: string[] = [];
    for (const d of ctx.delegates) parts.push(`\\b${escapeRe(d)}\\b`);
    for (const [name, type] of ctx.members) if (shapeOfType(type, ctx.delegates)) parts.push(`\\b${escapeRe(name)}\\b`);
    // A method of the class named without a call or type arguments: a method group.
    if (ctx.methods.size > 0) parts.push(`\\b(?:${[...ctx.methods].map(escapeRe).join("|")})\\b(?!\\s*[(<])`);
    ctx.signal = parts.length > 0 ? new RegExp(parts.join("|")) : null;
  }
  return ctx.signal !== null && ctx.signal.test(text);
}

interface LocalInfo { shape: Shape; type: string | null }

/**
 * The facts of one member. `fn` is the declaration, `body` its block or expression body, `params` its parameters.
 */
export function csharpValueFlow(
  body: Node | null,
  params: readonly ParamInfo[],
  returnType: string | null,
  ctx: ClassValueContext | null,
): ValueFlowFact[] {
  if (!body || !mayStateFlow(body.text, params, ctx)) return [];
  const delegates = ctx?.delegates ?? new Set<string>();
  const members = ctx?.members ?? new Map<string, string | null>();
  const methods = ctx?.methods ?? new Set<string>();
  const facts: ValueFlowFact[] = [];
  const seen = new Set<string>();
  const emit = (f: ValueFlowFact): void => {
    const key = JSON.stringify(f);
    if (!seen.has(key)) { seen.add(key); facts.push(f); }
  };

  // ── Names the member binds ────────────────────────────────────────────────
  const locals = new Map<string, LocalInfo>();
  const localFunctions = new Set<string>();
  for (const p of params) locals.set(p.name, { shape: shapeOfType(p.type, delegates), type: p.type });
  const declare = (name: string, type: string | null, init: Node | null): void => {
    let shape = shapeOfType(type, delegates);
    if (shape === "unknown" && init) {
      const made = unwrapExpression(init);
      if (made.type === "object_creation_expression") {
        const t = made.childForFieldName("type")?.text ?? null;
        const s = shapeOfType(t, delegates);
        if (s) { shape = s; type = t; }
      }
    }
    locals.set(name, { shape, type });
  };
  const scan = (node: Node): void => {
    switch (node.type) {
      case "local_function_statement": {
        const n = node.childForFieldName("name")?.text;
        if (n) localFunctions.add(n);
        return; // its own scope
      }
      case "variable_declarator": {
        const name = node.childForFieldName("name")?.text;
        const decl = node.parent?.type === "variable_declaration" ? node.parent : null;
        const type = decl?.childForFieldName("type")?.text ?? null;
        const init = node.namedChildren.find((c) => c.id !== node.childForFieldName("name")?.id) ?? null;
        if (name) declare(name, type, init);
        break;
      }
      case "foreach_statement": {
        const left = node.childForFieldName("left");
        if (left?.type === "identifier") locals.set(left.text, { shape: shapeOfType(node.childForFieldName("type")?.text ?? null, delegates) ?? "unknown", type: null });
        break;
      }
      case "declaration_expression": {
        const name = node.childForFieldName("name")?.text;
        if (name) locals.set(name, { shape: shapeOfType(node.childForFieldName("type")?.text ?? null, delegates), type: node.childForFieldName("type")?.text ?? null });
        break;
      }
      case "declaration_pattern": {
        const name = node.childForFieldName("name")?.text;
        if (name) locals.set(name, { shape: null, type: null });
        break;
      }
      case "parameter": {
        // A lambda's parameter hides a member of the same name for the whole body (coarse, never wrong the other way).
        const name = node.childForFieldName("name")?.text;
        if (name && !locals.has(name)) locals.set(name, { shape: shapeOfType(node.childForFieldName("type")?.text ?? null, delegates), type: null });
        break;
      }
    }
    for (const c of node.namedChildren) scan(c);
  };
  scan(body);
  if (LAMBDAS.has(body.type)) return [];

  // `x => …` binds an untyped identifier parameter.
  const bindLambdaParams = (node: Node): void => {
    if (LAMBDAS.has(node.type)) {
      const p = node.childForFieldName("parameters") ?? node.namedChildren.find((c) => c.type === "identifier");
      if (p?.type === "identifier" && !locals.has(p.text)) locals.set(p.text, { shape: null, type: null });
    }
    for (const c of node.namedChildren) bindLambdaParams(c);
  };
  bindLambdaParams(body);

  // ── Which unknown (`var`) names are read as values: only those are worth facts ──
  const valueUses = new Set<string>();
  const noteUse = (n: Node | null | undefined): void => {
    const e = n ? unwrapExpression(n) : null;
    if (e?.type === "identifier") valueUses.add(e.text);
  };
  const collectUses = (node: Node): void => {
    switch (node.type) {
      case "invocation_expression": {
        const f = node.childForFieldName("function");
        if (f?.type === "identifier") valueUses.add(f.text);
        else if (f?.type === "member_access_expression" && f.childForFieldName("name")?.text === "Invoke") noteUse(f.childForFieldName("expression"));
        else if (f?.type === "conditional_access_expression") noteUse(f.childForFieldName("condition"));
        for (const a of argumentsOf(node)) noteUse(a.expr);
        break;
      }
      case "object_creation_expression":
      case "implicit_object_creation_expression":
        for (const a of argumentsOf(node)) noteUse(a.expr);
        break;
      case "return_statement": noteUse(node.namedChildren[0]); break;
      case "assignment_expression": noteUse(node.childForFieldName("right")); break;
      case "variable_declarator": {
        const nm = node.childForFieldName("name");
        noteUse(node.namedChildren.find((c) => c.id !== nm?.id));
        break;
      }
    }
    for (const c of node.namedChildren) collectUses(c);
  };
  collectUses(body);

  // ── Cells ──────────────────────────────────────────────────────────────────
  /** The member `name` (of this class) if the class declares it as a field, property or event. */
  const isMember = (name: string): boolean => members.has(name);
  const shapeOfName = (name: string): Shape => {
    const l = locals.get(name);
    if (l) return l.shape === "unknown" ? (valueUses.has(name) ? "unknown" : null) : l.shape;
    if (members.has(name)) return shapeOfType(members.get(name), delegates);
    return null;
  };
  const isLocal = (name: string): boolean => locals.has(name) && !localFunctions.has(name);

  interface Holder { cell: ValueCell; shape: Shape; /** the collection is a member: its elements share its cell */ collapsed: boolean; local: boolean }
  /** The cell an expression names, with what it is declared to hold. */
  const holderOf = (expr: Node): Holder | null => {
    const e = unwrapExpression(expr);
    if (e.type === "identifier") {
      if (isLocal(e.text)) return { cell: { name: e.text }, shape: shapeOfName(e.text), collapsed: false, local: true };
      if (isMember(e.text)) return { cell: { name: "this", member: e.text }, shape: shapeOfName(e.text), collapsed: true, local: false };
      return null;
    }
    if (e.type === "member_access_expression") {
      const target = e.childForFieldName("expression");
      const name = e.childForFieldName("name")?.text;
      if (!target || !name) return null;
      if (target.type === "this") return { cell: { name: "this", member: name }, shape: members.has(name) ? shapeOfName(name) : "unknown", collapsed: true, local: false };
      if (target.type === "identifier" && isLocal(target.text)) {
        if (ELEMENT_VIEWS.has(name)) { const inner = holderOf(target); return inner?.shape === "collection" ? inner : null; }
        return { cell: { name: target.text, member: name }, shape: "unknown", collapsed: false, local: false };
      }
      if (ELEMENT_VIEWS.has(name) && target.type === "member_access_expression") {
        const inner = holderOf(target);
        return inner?.shape === "collection" ? inner : null;
      }
    }
    return null;
  };

  const literalKey = (arg: Node): string | null => {
    const a = unwrapExpression(arg);
    return a.type === "string_literal" ? a.text.slice(1, -1) : null;
  };

  /** The cell an element access / collection holds elements in; `keys` = every cell a store must reach, `read` the one a read uses. */
  const elementCells = (access: Node): { writes: ValueCell[]; read: ValueCell } | null => {
    const target = access.childForFieldName("expression");
    if (!target) return null;
    const h = holderOf(target);
    if (!h || h.shape !== "collection") return null;
    if (h.collapsed || h.cell.member !== undefined) return { writes: [h.cell], read: h.cell };
    const arg = access.childForFieldName("subscript")?.namedChildren.find((c) => c.type === "argument")?.namedChildren[0] ?? null;
    const key = arg ? literalKey(arg) : null;
    const all: ValueCell = { name: h.cell.name, member: "[]" };
    return key ? { writes: [{ name: h.cell.name, member: key }, all], read: { name: h.cell.name, member: key } } : { writes: [all], read: all };
  };
  const wholeCollection = (h: Holder): ValueCell => (h.collapsed || h.cell.member !== undefined ? h.cell : { name: h.cell.name, member: "[]" });

  // ── Sources: what an expression hands over ─────────────────────────────────
  type Source = { kind: "seed"; fn: string; line: number } | { kind: "copy"; from: ValueCell } | { kind: "result"; call: string; line: number };
  /**
   * `broad`: the destination is known to hold a delegate, so any PascalCase name that is not a local or a field
   * is taken as a method group; otherwise only a method the class declares, `this.X` and `new Delegate(…)`.
   */
  const sourcesOf = (expr: Node, broad: boolean, depth = 0): Source[] => {
    if (depth > 4) return [];
    const e = unwrapExpression(expr);
    const line = e.startPosition.row + 1;
    switch (e.type) {
      case "identifier": {
        const name = e.text;
        if (isLocal(name)) return shapeOfName(name) ? [{ kind: "copy", from: { name } }] : [];
        if (isMember(name)) {
          const s = shapeOfName(name);
          return s === "delegate" || s === "unknown" ? [{ kind: "copy", from: { name: "this", member: name } }] : [];
        }
        if (methods.has(name)) return [{ kind: "seed", fn: name, line }];
        if (broad && /^[A-Z]\w*$/.test(name) && !localFunctions.has(name)) return [{ kind: "seed", fn: name, line }];
        return [];
      }
      case "member_access_expression": {
        const target = e.childForFieldName("expression");
        const name = e.childForFieldName("name")?.text;
        if (!target || !name) return [];
        if (target.type === "this") {
          if (methods.has(name)) return [{ kind: "seed", fn: `this.${name}`, line }];
          if (isMember(name)) {
            const s = shapeOfName(name);
            return s === "delegate" || s === "unknown" ? [{ kind: "copy", from: { name: "this", member: name } }] : [];
          }
          return broad && /^[A-Z]\w*$/.test(name) ? [{ kind: "seed", fn: `this.${name}`, line }] : [];
        }
        if (!broad || !/^[A-Z]\w*$/.test(name)) return [];
        // `club.Count` (an instance's method) or `Util.Save` (a static one): core resolves it on the receiver's type.
        if (target.type === "identifier" && /^[\w]+$/.test(target.text)) {
          const out: Source[] = [{ kind: "seed", fn: `${target.text}.${name}`, line }];
          if (isLocal(target.text)) out.push({ kind: "copy", from: { name: target.text, member: name } });
          return out;
        }
        return [];
      }
      case "object_creation_expression": {
        const type = e.childForFieldName("type")?.text ?? null;
        if (shapeOfType(type, delegates) !== "delegate") return [];
        const arg = argumentsOf(e)[0];
        return arg && argumentsOf(e).length === 1 ? sourcesOf(arg.expr, true, depth + 1) : [];
      }
      case "conditional_expression": {
        const out: Source[] = [];
        for (const f of ["consequence", "alternative"]) { const c = e.childForFieldName(f); if (c) out.push(...sourcesOf(c, broad, depth + 1)); }
        return out;
      }
      case "binary_expression": {
        if (e.childForFieldName("operator")?.text !== "??" && !e.children.some((c) => c.type === "??")) return [];
        const out: Source[] = [];
        for (const f of ["left", "right"]) { const c = e.childForFieldName(f); if (c) out.push(...sourcesOf(c, broad, depth + 1)); }
        return out;
      }
      case "cast_expression": {
        const v = e.childForFieldName("value");
        return v ? sourcesOf(v, broad, depth + 1) : [];
      }
      case "as_expression": {
        const v = e.childForFieldName("left");
        return v ? sourcesOf(v, broad, depth + 1) : [];
      }
      case "await_expression": {
        const inner = e.namedChildren[0];
        return inner ? sourcesOf(inner, broad, depth + 1) : [];
      }
      case "invocation_expression": {
        // A call's result: what a factory returns, known to core through the callee's `return` facts.
        const f = e.childForFieldName("function");
        if (f?.type === "member_access_expression" && f.childForFieldName("name")?.text === "Invoke") return [];
        const name = csharpCallHooks.resolveCallName?.(e);
        return name && name !== "nameof" ? [{ kind: "result", call: name, line }] : [];
      }
    }
    return [];
  };

  const bindAt = (to: ValueCell, sources: readonly Source[], line: number): void => {
    for (const s of sources) {
      if (s.kind === "seed") emit({ kind: "seed", to, fn: s.fn, line: s.line });
      else if (s.kind === "copy") emit({ kind: "copy", from: s.from, to, line });
      else emit({ kind: "result", call: s.call, line: s.line, to });
    }
  };
  const tempCounter = new Map<string, number>();
  /** A cell holding `sources`: the one cell of a lone copy, else a temporary. */
  const cellFor = (sources: readonly Source[], tag: string, line: number): ValueCell | null => {
    if (sources.length === 0) return null;
    if (sources.length === 1 && sources[0]!.kind === "copy") return sources[0]!.from;
    const n = (tempCounter.get(tag) ?? 0) + 1;
    tempCounter.set(tag, n);
    const to: ValueCell = { name: `$${tag}${n}` };
    bindAt(to, sources, line);
    return to;
  };

  // ── Statements ──────────────────────────────────────────────────────────────
  const delegateReturn = shapeOfType(unwrapTask(returnType), delegates);
  const handledCalls = new Set<number>();

  const assign = (leftNode: Node, right: Node, line: number): void => {
    const left = unwrapExpression(leftNode);
    if (left.type === "element_access_expression") {
      const cells = elementCells(left);
      if (!cells) return;
      const sources = sourcesOf(right, true);
      for (const to of cells.writes) bindAt(to, sources, line);
      return;
    }
    const h = holderOf(left);
    if (!h) return;
    // A destination whose type is stated holds delegates; an unknown one (`other.Saved`, a `var`) only what is surely a method group.
    const known = h.shape === "delegate" || h.shape === "collection";
    if (h.shape === "collection") {
      // `handlers = new() { … }` / `new List<Action> { … }`: the initializer's elements.
      bindAt(wholeCollection(h), collectionElements(right), line);
      return;
    }
    const sources = sourcesOf(right, known);
    if (sources.length === 0) return;
    // A member of an untyped receiver only takes method groups (`club.Handler = Save`), never plain value copies of unknown shape.
    bindAt(h.cell, sources, line);
  };

  /** The delegate elements a collection initializer (`new List<Action> { Save, Load }`, `{ ["a"] = Save }`) lists. */
  const collectionElements = (expr: Node): Source[] => {
    const e = unwrapExpression(expr);
    if (e.type !== "object_creation_expression" && e.type !== "implicit_object_creation_expression") return [];
    const init = e.childForFieldName("initializer") ?? e.namedChildren.find((c) => c.type === "initializer_expression") ?? null;
    if (!init) return [];
    const out: Source[] = [];
    for (const item of init.namedChildren) {
      if (item.type === "assignment_expression") { const r = item.childForFieldName("right"); if (r) out.push(...sourcesOf(r, true)); }
      else if (item.type === "initializer_expression") { const last = item.namedChildren[item.namedChildren.length - 1]; if (last) out.push(...sourcesOf(last, true)); }
      else out.push(...sourcesOf(item, true));
    }
    return out;
  };

  const declareInit = (declarator: Node): void => {
    const nameNode = declarator.childForFieldName("name");
    const init = declarator.namedChildren.find((c) => c.id !== nameNode?.id && c.type !== "bracketed_argument_list") ?? null;
    if (!nameNode || !init) return;
    const name = nameNode.text;
    const info = locals.get(name);
    if (!info) return;
    const line = init.startPosition.row + 1;
    if (info.shape === "collection") {
      bindAt({ name, member: "[]" }, collectionElements(init), line);
      // A collection handed over whole (`var copy = handlers`) shares its elements.
      const from = holderOf(init);
      if (from?.shape === "collection") emit({ kind: "copy", from: wholeCollection(from), to: { name, member: "[]" }, line });
      return;
    }
    if (info.shape === null) return;
    if (info.shape === "unknown" && !valueUses.has(name)) return;
    const sources = sourcesOf(init, info.shape === "delegate");
    // An `unknown` local takes only what is surely a function value: a copy, a method group of the class, a result.
    bindAt({ name }, sources, line);
  };

  const visitCall = (call: Node): void => {
    const line = call.startPosition.row + 1;
    const fnNode = call.type === "invocation_expression" ? call.childForFieldName("function") : null;
    const callName = csharpCallHooks.resolveCallName?.(call) ?? null;

    if (fnNode) {
      // ── invoke ──
      const f = unwrapExpression(fnNode);
      let invoked: ValueCell | null = null;
      if (f.type === "identifier") {
        const h = holderOf(f);
        if (h && h.shape !== "collection") invoked = h.cell;
      } else if (f.type === "member_access_expression") {
        const nm = f.childForFieldName("name")?.text;
        const target = f.childForFieldName("expression");
        if (target?.type === "this" && nm && isMember(nm) && shapeOfName(nm) !== "collection") invoked = { name: "this", member: nm };
        else if (nm === "Invoke" && target) {
          const h = holderOf(target);
          if (h && h.shape === "delegate") invoked = h.cell;
        }
      } else if (f.type === "conditional_access_expression") {
        const cond = f.childForFieldName("condition");
        const last = f.namedChildren[f.namedChildren.length - 1];
        if (cond && last?.type === "member_binding_expression" && last.childForFieldName("name")?.text === "Invoke") {
          const h = holderOf(cond);
          if (h && h.shape === "delegate") invoked = h.cell;
        }
      } else if (f.type === "element_access_expression") {
        const cells = elementCells(f);
        if (cells) invoked = cells.read;
      }
      // An element's call (`handlers[key]()`) is no call row of the extractor: it is named `handlers[]`.
      const invokeName = f.type === "element_access_expression" ? `${f.childForFieldName("expression")?.text ?? ""}[]` : callName;
      if (invoked && invokeName) emit({ kind: "invoke", cell: invoked, call: invokeName, line });

      // ── a store into a collection: `handlers.Add(Save)`, `handlers.Add("a", Save)`, `queue.Enqueue(f)` ──
      if (f.type === "member_access_expression") {
        const nm = f.childForFieldName("name")?.text ?? "";
        const target = f.childForFieldName("expression");
        const args = argumentsOf(call);
        const h = target ? holderOf(target) : null;
        if (h?.shape === "collection" && STORE_METHODS.has(nm) && args.length > 0) {
          const value = args[args.length - 1]!.expr;
          const sources = sourcesOf(value, true);
          const key = args.length === 2 ? literalKey(args[0]!.expr) : null;
          const all = wholeCollection(h);
          bindAt(all, sources, line);
          if (key && !h.collapsed && h.cell.member === undefined) bindAt({ name: h.cell.name, member: key }, sources, line);
          handledCalls.add(call.id);
        } else if (h?.shape === "collection" && nm === "TryGetValue" && args.length === 2) {
          // `handlers.TryGetValue(key, out var h)`: h holds what the dictionary holds under that key.
          const out = unwrapExpression(args[1]!.expr);
          const outName = out.type === "declaration_expression" ? out.childForFieldName("name")?.text : out.type === "identifier" ? out.text : undefined;
          if (outName && isLocal(outName)) {
            const key = !h.collapsed && h.cell.member === undefined ? literalKey(args[0]!.expr) : null;
            const from = key ? { name: h.cell.name, member: key } : wholeCollection(h);
            emit({ kind: "copy", from, to: { name: outName }, line });
          }
          handledCalls.add(call.id);
        }
      }
    }

    // ── arguments: `Run(Save, handler)` ──
    if (handledCalls.has(call.id) || !callName || callName === "nameof") return;
    const args = argumentsOf(call);
    args.forEach((a, index) => {
      if (a.name !== null) return;
      const sources = sourcesOf(a.expr, false);
      const from = cellFor(sources, `a${line}_${call.startPosition.column}_${index}_`, line);
      if (from) emit({ kind: "arg", call: callName, line, index, from });
    });
  };

  const walk = (node: Node): void => {
    switch (node.type) {
      case "local_function_statement": return;
      case "variable_declarator": declareInit(node); break;
      case "assignment_expression": {
        const op = node.children.find((c) => !c.isNamed && /^[+\-*/]?=$/.test(c.type))?.type ?? node.childForFieldName("operator")?.text;
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        // `+=` subscribes (an event); `-=` and the arithmetic forms say nothing.
        if (left && right && (op === "=" || op === "+=")) assign(left, right, node.startPosition.row + 1);
        break;
      }
      case "invocation_expression":
      case "object_creation_expression":
      case "implicit_object_creation_expression":
        visitCall(node);
        break;
      case "foreach_statement": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (left?.type === "identifier" && right) {
          const h = holderOf(right);
          if (h?.shape === "collection") emit({ kind: "copy", from: wholeCollection(h), to: { name: left.text }, line: node.startPosition.row + 1 });
        }
        break;
      }
      case "return_statement": {
        const value = node.namedChildren[0];
        if (value && delegateReturn) {
          const from = cellFor(sourcesOf(value, true), `r${node.startPosition.row + 1}_`, node.startPosition.row + 1);
          if (from) emit({ kind: "return", from, line: node.startPosition.row + 1 });
        }
        break;
      }
    }
    for (const c of node.namedChildren) walk(c);
  };

  if (body.type === "arrow_expression_clause") {
    const value = body.namedChildren[0];
    if (value && delegateReturn) {
      const line = value.startPosition.row + 1;
      const from = cellFor(sourcesOf(value, true), `r${line}_`, line);
      if (from) emit({ kind: "return", from, line });
    }
    walk(body);
  } else {
    walk(body);
  }
  return facts;
}

/**
 * The delegate-valued initializers of a class's fields (`private Action _onClose = Close;`, a handler table
 * `{ ["a"] = Save }`): they run in a constructor, so they are stated as that constructor's facts.
 */
export function csharpFieldInitFacts(classBody: Node, ctx: ClassValueContext): ValueFlowFact[] {
  const facts: ValueFlowFact[] = [];
  const hold = (name: string, type: string | null, init: Node | null): void => {
    const shape = shapeOfType(type, ctx.delegates);
    if (!name || !init || (shape !== "delegate" && shape !== "collection")) return;
    const to: ValueCell = { name: "this", member: name };
    const direct = (x: Node, depth = 0): void => {
      const v = unwrapExpression(x);
      const line = v.startPosition.row + 1;
      if (depth > 3) return;
      const own = v.type === "member_access_expression" && v.childForFieldName("expression")?.type === "this" ? v.childForFieldName("name")?.text : undefined;
      if (v.type === "identifier" && ctx.methods.has(v.text)) facts.push({ kind: "seed", to, fn: v.text, line });
      else if (own && ctx.methods.has(own)) facts.push({ kind: "seed", to, fn: `this.${own}`, line });
      else if (v.type === "object_creation_expression" && shapeOfType(v.childForFieldName("type")?.text, ctx.delegates) === "delegate") {
        const a = argumentsOf(v);
        if (a.length === 1) direct(a[0]!.expr, depth + 1);
      } else if (v.type === "conditional_expression") {
        for (const f of ["consequence", "alternative"]) { const c = v.childForFieldName(f); if (c) direct(c, depth + 1); }
      }
    };
    if (shape === "delegate") { direct(init); return; }
    const made = unwrapExpression(init);
    if (made.type !== "object_creation_expression" && made.type !== "implicit_object_creation_expression") return;
    const list = made.childForFieldName("initializer") ?? made.namedChildren.find((c) => c.type === "initializer_expression") ?? null;
    for (const item of list?.namedChildren ?? []) {
      if (item.type === "assignment_expression") { const r = item.childForFieldName("right"); if (r) direct(r); }
      else if (item.type === "initializer_expression") { const last = item.namedChildren[item.namedChildren.length - 1]; if (last) direct(last); }
      else direct(item);
    }
  };
  for (const member of classBody.namedChildren) {
    if (member.type === "field_declaration") {
      const decl = member.namedChildren.find((c) => c.type === "variable_declaration");
      const type = decl?.childForFieldName("type")?.text ?? null;
      for (const d of decl?.namedChildren ?? []) {
        if (d.type !== "variable_declarator") continue;
        const nm = d.childForFieldName("name");
        hold(nm?.text ?? "", type, d.namedChildren.find((c) => c.id !== nm?.id && c.type !== "bracketed_argument_list") ?? null);
      }
    } else if (member.type === "property_declaration") {
      hold(member.childForFieldName("name")?.text ?? "", member.childForFieldName("type")?.text ?? null, member.childForFieldName("value") ?? null);
    }
  }
  return facts;
}

/** What a class declares, for `csharpValueFlow`. */
export function classValueContext(classBody: Node, delegates: ReadonlySet<string>): ClassValueContext {
  const members = new Map<string, string | null>();
  const methods = new Set<string>();
  for (const m of classBody.namedChildren) {
    switch (m.type) {
      case "method_declaration": {
        const n = m.childForFieldName("name")?.text;
        if (n) methods.add(n);
        break;
      }
      case "property_declaration":
      case "event_declaration": {
        const n = m.childForFieldName("name")?.text;
        if (n) members.set(n, m.childForFieldName("type")?.text ?? null);
        break;
      }
      case "field_declaration":
      case "event_field_declaration": {
        const decl = m.namedChildren.find((c) => c.type === "variable_declaration");
        const type = decl?.childForFieldName("type")?.text ?? null;
        for (const d of decl?.namedChildren ?? []) {
          const n = d.type === "variable_declarator" ? d.childForFieldName("name")?.text : undefined;
          if (n) members.set(n, type);
        }
        break;
      }
    }
  }
  return { members, methods, delegates };
}
