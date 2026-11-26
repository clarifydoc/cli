/**
 * Copies and seeds run through locals, parameters and `this.x` fields (a field initializer
 * `onSave = this.save.bind(this)` rides the constructor), `a.b` members, list/map elements (`push`/`set`/literals,
 * `for…of`/`forEach` parameters, `m[k]()`: every key is also an element, `this.items[k]` is member `items[]`,
 * `this.a.b` is member `a.b`), factory results/returns (`<return@N>`/`<arg@N>` one-use cells),
 * `.bind`/`.call`/`.apply`, and module `let`s written from a function (`ValueCell.module`). A name is a seed only
 * when the file can bind it to a function (imports, function and class declarations); data-typed parameters and
 * locals nothing binds are left out; a call on a dispatch map the existing pass owns gets no invoke; a local made by
 * a call that wraps a function (`useCallback(() => …)`) is a function binding, not a value. The parameter of a JS
 * function expression assigned to `this.x` — and of a callback nested in it — states no handed argument and no seed.
 *
 * An object literal handed as an argument, or typed by `useState<T>`/`ref<T>`/`reactive<T>`/`createContext<T>`, sits
 * on a one-use `<arg@L#n>` cell; core joins its function members to the members of the formal's declared class or
 * interface (`memberCell`, located from the formal's own file so a namesake interface stays apart):
 * `toast.action?.onClick()` and `const { onClick } = substitution` reach the handlers written in literals of that
 * type.
 *
 * `reactive(…)`, `shallowReactive`, `readonly`, `markRaw`, `createContext(…)` and `Object.freeze(…)` over an object
 * or array literal hold that literal's members (`VALUE_WRAPPERS`); `useContext(Ctx)`/`inject(Ctx)` read what the
 * named context was built with (`CONTEXT_READS`), so `state.onSave()` and
 * `const { onPurge } = useContext(CmdContext)` reach the literal's function;
 * `const ctx = useContext(Ctx); ctx.onPurge()` is an `invoke` of the context's own member (`contextLocals`,
 * `held: "module"`; the alias holds in the block that declares it, and a parameter, local, loop or catch binding of
 * the name between the call and that block ends it).
 *
 * A call `x.m()` on a module-level object — the file's own or one a project module (`./`, `../`, `@/`) it imports
 * under a lower-case name — states an `invoke` marked `held: "module"` even when the function stores nothing into it;
 * core keeps the ordinary resolution unless that same object's member is written in the caller's file or the file its
 * import names (a namesake object of another file never counts; core's `valueFlowInvokeSites`).
 *
 * `[...base, run]` copies the spread array's elements (the Vue text reader follows `...base` of a declared literal
 * array, two levels); an object member written as an object also writes the element cell, so `kit[kind].run()` reads
 * every member of a nested literal (a `memberCalls` entry with a `column`, which adds the `kit[].run` call row only
 * once the invoke is stated); a computed key one level below a member (`kits.club[k].run()`) reads the element of
 * that member (`placeOf`). An arrow written in place in an array a project component's tag takes under a non-`on`
 * prop (`<ActionBar actions={[{ run: () => award() }]} />`) is a held function `<ActionBar:actions[].run@5>` unless
 * it returns markup (`jsxArrayHolder`), which the child's loop over its prop runs. A key held by a function written
 * in place counts as the map's own key even when its name is a noise leaf (`actions.send()` for
 * `{ send: () => post() }`, `dispatchMapMember(…, withInline)`), so the call is kept and links to that function; a
 * markup handler's calls join the same way through `markupCalls`.
 *
 * A TanStack Query step keeps the id it is keyed by: the plugin marks the helper step a query options object
 * contributes (`ValueStep` `helper` with `query: true`); core keeps the route-parameter origin through it only when
 * the options' fetch hands the parameter on (`argOrigins`), so a query keyed by `id` whose `queryFn` lists everything
 * gives no origin.
 */

import type { Node, Tree } from "web-tree-sitter";
import type { CallInfo, ParamInfo, ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { javascriptCallHooks } from "./call-hooks.js";
import { dispatchMapCallee, dispatchMapMember } from "./dispatch-maps.js";
import { boundAtSite, parameterNames as boundParameterNames, reboundBefore } from "./block-scope.js";
import { heldFunction } from "./held-functions.js";

/**
 * Callable value flow facts (`FunctionInfo.valueFlow`, `FileAnalysis.moduleValueFlow`): where a function value
 * travels — through locals, parameters, `this` fields, lists and maps, and returns — stated as neutral steps the
 * core solver joins into the call that finally runs it. Nothing is resolved here: names stay as written.
 *
 * Conventions (the cell names core joins on):
 *   - `this.x` is `{ name: "this", member: "x" }`; `this.a.b` is member `a.b`; a list's element is `[]`
 *     (`items` → `{ name: "items", member: "[]" }`, `this.items` → member `items[]`); a literal key of a
 *     local object is that key, and every key is also an element, so `m[k]()` reads them all;
 *   - a function written in place that has a held pseudo-name (`<toast.action@17>`) is a seed by that name;
 *   - an object or array literal (or `new Map()`) bound to a name also states a copy from `<literal>`, which
 *     only marks the name as bound for core — the cell it copies from is no name core knows;
 *   - a function value returned or handed on by name rides a one-use cell (`<return@4>`, `<arg@9:0>`).
 */

const FUNCTION_VALUES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "generator_function"]);
const DECLARATIONS: ReadonlySet<string> = new Set(["function_declaration", "generator_function_declaration", "class_declaration", "class", "method_definition"]);
const WRAPPERS: ReadonlySet<string> = new Set(["parenthesized_expression", "as_expression", "satisfies_expression", "non_null_expression", "type_assertion"]);
const NOT_VALUES: ReadonlySet<string> = new Set(["undefined", "NaN", "Infinity", "arguments"]);
const LIST_WRITERS: ReadonlySet<string> = new Set(["push", "unshift", "add", "append", "enqueue"]);
const ELEMENT_CALLBACKS: ReadonlySet<string> = new Set(["forEach", "map", "filter", "some", "every", "find", "findLast", "flatMap"]);
const CONTAINER_CTORS: ReadonlySet<string> = new Set(["Map", "Set", "WeakMap", "WeakSet", "Array"]);
const LITERAL: ValueCell = { name: "<literal>" };
/**
 * Calls whose result stands for the value they are handed first: a reactive proxy, a frozen view, a context built
 * from its default value. `const state = reactive<Actions>({ onSave: archive })` holds `onSave` like a plain literal.
 */
const VALUE_WRAPPERS: ReadonlySet<string> = new Set(["reactive", "shallowReactive", "readonly", "shallowReadonly", "markRaw", "createContext", "proxy", "freeze"]);
/** Calls that read the value a context holds back (`useContext(CmdContext)`): the result is what the context was built with. */
const CONTEXT_READS: ReadonlySet<string> = new Set(["useContext", "inject"]);
/** Calls whose one type argument types the value they are handed first (`useState<Substitution>({ … })`). */
const TYPED_VALUE_CALLS: ReadonlySet<string> = new Set(["useState", "useRef", "ref", "shallowRef", "reactive", "signal", "createSignal", "createContext", "atom", "writable"]);
const MAX_DEPTH = 3;

interface Ref { cell?: ValueCell; fn?: string }

function unwrap(node: Node | null | undefined): Node | null {
  while (node && (WRAPPERS.has(node.type) || node.type === "await_expression")) node = node.namedChild(0);
  return node ?? null;
}

/** An object key as text: `save`, `"save"`; null for a computed key. */
function keyOf(key: Node | null): string | null {
  if (!key) return null;
  if (key.type === "property_identifier") return key.text;
  if (key.type === "string") {
    const t = key.text.slice(1, -1);
    return /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
  }
  return null;
}

/** An index as a key: `["save"]` → `save`, anything else → null (any element). */
function indexKey(index: Node | null): string | null {
  return index?.type === "string" ? keyOf(index) : null;
}

const elementOf = (cell: ValueCell): ValueCell => ({ name: cell.name, member: cell.member === undefined ? "[]" : `${cell.member}[]` });
const subOf = (cell: ValueCell, key: string): ValueCell => ({ name: cell.name, member: cell.member === undefined ? key : `${cell.member}.${key}` });

/** The names a function node binds as parameters (identifiers only). */
function parameterNames(fn: Node): string[] {
  const list = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  if (!list) return [];
  if (list.type === "identifier") return [list.text];
  const out: string[] = [];
  for (const p of list.namedChildren) {
    const pattern = p.type === "identifier" ? p : p.childForFieldName("pattern");
    if (pattern?.type === "identifier") out.push(pattern.text);
  }
  return out;
}

/** A function written in place, or a call that wraps one (`useCallback(() => …)`, `debounce(function () …)`): a function binding, never a plain local. */
function isFunctionLike(value: Node | null | undefined): boolean {
  const v = unwrap(value);
  if (!v) return false;
  if (FUNCTION_VALUES.has(v.type)) return true;
  if (v.type !== "call_expression") return false;
  return (v.childForFieldName("arguments")?.namedChildren ?? []).some((a) => FUNCTION_VALUES.has(unwrap(a)?.type ?? ""));
}

/** The call node `node` is, with its optional-chain and `await` wrappers removed. */
function callOf(node: Node | null): Node | null {
  const n = unwrap(node);
  return n?.type === "call_expression" ? n : null;
}

/** `x.bind(…)`: the function it binds, else null. */
function bound(call: Node): Node | null {
  const callee = call.childForFieldName("function");
  return callee?.type === "member_expression" && callee.childForFieldName("property")?.text === "bind" ? callee.childForFieldName("object") : null;
}

interface ModuleFlow {
  facts: ValueFlowFact[];
  names: ReadonlySet<string>;
  written: ReadonlySet<string>;
  /** Names the file can bind to a function: its imports, function and class declarations, function-valued bindings. */
  known: ReadonlySet<string>;
}

/** Parameter types that hold data, never a function: such a parameter's value is not followed. */
const DATA_TYPE = /^(?:string|number|boolean|bigint|symbol|null|undefined|never|void|Date|Error|RegExp|Buffer|Uint8Array|Request|Response)\b|\[\]$|^(?:Array|Record|Promise|Set|Map)</;

let knownTree: Tree | null = null;
let knownMemo: Set<string> = new Set();
/** The names a file can bind to a function, read once per tree: the module flow and every class field's flow share it. */
function knownNamesOf(tree: Tree): Set<string> {
  if (tree === knownTree) return knownMemo;
  const out = new Set<string>();
  for (const st of tree.rootNode.namedChildren) {
    if (st.type !== "import_statement") continue;
    const clause = st.namedChildren.find((c) => c.type === "import_clause");
    if (clause) for (const id of clause.descendantsOfType("identifier")) if (id) out.add(id.text);
  }
  for (const n of tree.rootNode.descendantsOfType(["function_declaration", "generator_function_declaration", "class_declaration", "variable_declarator"])) {
    if (!n) continue;
    const name = n.childForFieldName("name");
    if (name?.type !== "identifier" && name?.type !== "type_identifier") continue;
    if (n.type !== "variable_declarator") out.add(name.text);
    else {
      const value = unwrap(n.childForFieldName("value"));
      if (value && (isFunctionLike(value) || (value.type === "call_expression" && value.childForFieldName("function")?.text === "require"))) out.add(name.text);
    }
  }
  knownTree = tree;
  knownMemo = out;
  return out;
}
let importsTree: Tree | null = null;
let importsMemo: Set<string> = new Set();
/** Lower-case names a file imports from its own project (`./store`, `../state`, `@/state`): the objects other modules hand it. */
function projectImportsOf(tree: Tree): Set<string> {
  if (tree === importsTree) return importsMemo;
  const out = new Set<string>();
  for (const st of tree.rootNode.namedChildren) {
    if (st.type !== "import_statement") continue;
    const source = st.childForFieldName("source")?.text.replace(/^['"]|['"]$/g, "") ?? "";
    if (!/^(?:\.{1,2}\/|[@~]\/)/.test(source)) continue;
    const clause = st.namedChildren.find((c) => c.type === "import_clause");
    if (!clause) continue;
    for (const id of clause.descendantsOfType("identifier")) if (id && /^[a-z_$]/.test(id.text)) out.add(id.text);
  }
  importsTree = tree;
  importsMemo = out;
  return out;
}
let memoTree: Tree | null = null;
let memo: ModuleFlow | null = null;

/** Module-scope names (declared at the top level with no function value), and what the file's own code writes to them. */
export function moduleFlowOf(tree: Tree): ModuleFlow {
  if (tree === memoTree && memo) return memo;
  const names = new Set<string>();
  for (const st of tree.rootNode.namedChildren) {
    const decl = st.type === "export_statement" ? st.namedChildren.find((c) => c.type === "lexical_declaration" || c.type === "variable_declaration") ?? st : st;
    if (decl.type !== "lexical_declaration" && decl.type !== "variable_declaration") continue;
    for (const d of decl.namedChildren) {
      const name = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
      const value = unwrap(d.childForFieldName("value"));
      if (name?.type === "identifier" && !isFunctionLike(value)) names.add(name.text);
    }
  }
  const known = knownNamesOf(tree);
  const flow = new Flow(names, null, true, undefined, known);
  flow.root = tree.rootNode;
  const written = new Set<string>();
  flow.declare(tree.rootNode);
  flow.visit(tree.rootNode, true);
  for (const f of flow.facts) if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && f.to.member === undefined) written.add(f.to.name);
  // A function that assigns a module-level name it does not declare (stated in that function, as a module cell).
  if (names.size > 0) {
    for (const a of tree.rootNode.descendantsOfType("assignment_expression")) {
      const left = a?.childForFieldName("left");
      if (a && left?.type === "identifier" && names.has(left.text) && !shadowed(a, left.text)) written.add(left.text);
    }
  }
  flow.finish();
  memoTree = tree;
  memo = { facts: dedupe(flow.facts), names, written, known };
  return memo;
}

/** Whether a function around `node` declares `name` (a parameter or a local), so an assignment is not the module's. */
function shadowed(node: Node, name: string): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (!FUNCTION_VALUES.has(p.type) && p.type !== "function_declaration" && p.type !== "generator_function_declaration" && p.type !== "method_definition") continue;
    if (parameterNames(p).includes(name)) return true;
    for (const d of p.descendantsOfType("variable_declarator")) if (d?.childForFieldName("name")?.text === name) return true;
  }
  return false;
}

function dedupe(facts: ValueFlowFact[]): ValueFlowFact[] {
  const seen = new Set<string>();
  return facts.filter((f) => {
    const key = JSON.stringify(f);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

class Flow {
  readonly facts: ValueFlowFact[] = [];
  /** Names the walked scope binds as values: parameters, locals holding no function, callback parameters. */
  readonly names: Set<string>;
  /** Calls the walk found that `extractCalls` does not record (an element or key called: `handlers[i]()`). */
  readonly extraCalls: CallInfo[] = [];
  /** One-use cells of object literals the code types by a type argument (`useState<Substitution>({ … })`): the type each stands for. */
  readonly typedTemps: Array<{ name: string; type: string }> = [];
  /** Names a destructuring reads members of: their declared type may give those members, so the facts reading them stay. */
  private readonly readRoots = new Set<string>();
  /** A node of the tree walked (dispatch maps are read per tree). */
  root!: Node;
  /** `a.b(…)` calls on a local object: invoked only when the function stores into that member itself. */
  private readonly memberCalls: Array<{ cell: ValueCell; name: string; line: number; column?: number }> = [];
  /** Loop variables and element-callback parameters: bound where they are used, by construction. */
  private readonly iterNames = new Set<string>();
  /** Locals bound to a context read (`const ctx = useContext(CmdContext)`): the context's name each stands for. */
  private readonly contextLocals = new Map<string, { context: string; scope: Node }>();
  private fnDepth = 0;
  private plainDepth = 0;
  private tmp = 0;

  /** The function's own formals that can hold a function (data-typed ones are left out). */
  private readonly formals: Set<string>;
  private readonly known: ReadonlySet<string>;

  constructor(
    names: Iterable<string>,
    private readonly skip: ((node: Node) => boolean) | null,
    private readonly atModule: boolean,
    private readonly moduleView?: ModuleFlow,
    known?: ReadonlySet<string>,
    formals: Iterable<string> = [],
  ) {
    this.names = new Set(names);
    this.formals = new Set(formals);
    this.known = known ?? moduleView?.known ?? new Set();
  }

  /** Locals are found first: whether an identifier is a value or a candidate function name depends on them. */
  declare(node: Node): void {
    const stack: Node[] = [node];
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (!this.descends(n, n === node)) continue;
      if (n.type === "variable_declarator") {
        const name = n.childForFieldName("name");
        const value = unwrap(n.childForFieldName("value"));
        if (name?.type === "identifier" && !isFunctionLike(value)) this.names.add(name.text);
      } else if (n.type === "catch_clause") {
        const p = n.childForFieldName("parameter");
        if (p?.type === "identifier") this.names.add(p.text);
      }
      for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i)!);
    }
  }

  /** Whether the walk reads inside `n`: not a function of its own, a class, or a held callback. */
  private descends(n: Node, root: boolean): boolean {
    if (root) return true;
    if (DECLARATIONS.has(n.type)) return false;
    if (FUNCTION_VALUES.has(n.type)) {
      // A module-level walk keeps to the top level: what a callback declares is its own.
      if (this.atModule || n.parent?.type === "variable_declarator") return false;
      if (heldFunction(n)) return false;
    }
    return !this.skip?.(n);
  }

  visit(node: Node, root = false): void {
    if (!this.descends(node, root)) return;
    const plain = node.type === "function_expression" || node.type === "generator_function";
    const fn = FUNCTION_VALUES.has(node.type) && !root;
    if (plain) this.plainDepth++;
    if (fn) this.fnDepth++;
    switch (node.type) {
      case "variable_declarator": {
        const name = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (name?.type === "identifier" && value && !isFunctionLike(value)) {
          const call = callOf(value);
          const context = call ? this.contextArgument(call) : null;
          // The alias holds in the block that declares it (a function body, a callback's, the module's), nowhere else.
          const scope = node.parent?.parent;
          if (context && scope) this.contextLocals.set(name.text, { context: context.text, scope });
          this.assignTo({ name: name.text }, value, node.startPosition.row + 1);
        }
        else if (name?.type === "object_pattern" && value) this.destructure(name, value, node.startPosition.row + 1);
        break;
      }
      case "assignment_expression":
      case "augmented_assignment_expression": this.assignment(node); break;
      case "call_expression":
      case "new_expression": this.call(node); break;
      case "return_statement":
        if (this.fnDepth === 0 && !this.atModule) this.returns(node.namedChild(0), node.startPosition.row + 1);
        break;
      case "for_in_statement": this.forOf(node); break;
    }
    for (const c of node.namedChildren) this.visit(c);
    if (fn) this.fnDepth--;
    if (plain) this.plainDepth--;
  }

  // ── Cells and values ──────────────────────────────────────────────────────

  /** The cell a place expression names: `x`, `this.x`, `a.b`, `a[k]`, `this.a.b`, `this.items[k]`. */
  private placeOf(node: Node | null): ValueCell | null {
    const n = unwrap(node);
    if (!n) return null;
    if (n.type === "identifier") return NOT_VALUES.has(n.text) ? null : { name: n.text };
    if (n.type === "member_expression") {
      const prop = n.childForFieldName("property");
      const object = unwrap(n.childForFieldName("object"));
      if (prop?.type !== "property_identifier" || !object) return null;
      if (object.type === "this") return this.plainDepth > 0 ? null : { name: "this", member: prop.text };
      if (object.type === "identifier") return { name: object.text, member: prop.text };
      const base = this.placeOf(object);
      // `kit[kind].run`: a member of the element a computed key picks.
      if (base && object.type === "subscript_expression" && base.name !== "this" && base.member?.endsWith("[]") && !base.member.slice(0, -2).includes("[")) return subOf(base, prop.text);
      return base && base.name === "this" && base.member !== undefined && base.member.split(".").length < MAX_DEPTH ? subOf(base, prop.text) : null;
    }
    if (n.type === "subscript_expression") {
      const key = indexKey(n.childForFieldName("index"));
      const base = this.placeOf(n.childForFieldName("object"));
      if (!base) return null;
      if (base.name === "this" || base.member !== undefined) {
        // `this.items[k]`: the element of a field (no per-key cells below `this`).
        if (base.name === "this" && base.member !== undefined) return elementOf(base);
        // `kits.club[k]`: an element of a member of a local object (one computed key, below the first level).
        return key === null && base.name !== "this" && base.member !== undefined && !base.member.includes("[") ? elementOf(base) : null;
      }
      return key ? { name: base.name, member: key } : elementOf(base);
    }
    return null;
  }

  /** The place a destructuring reads from (`const { onClick } = substitution`), else null. */
  private destructureSource(value: Node | null | undefined): ValueCell | null {
    const v = unwrap(value);
    if (v?.type === "call_expression") return this.placeOf(this.contextArgument(v));
    return v && (v.type === "identifier" || v.type === "member_expression") ? this.placeOf(v) : null;
  }

  /** `useContext(CmdContext)` → the `CmdContext` identifier, else null. */
  private contextArgument(call: Node): Node | null {
    const callee = unwrap(call.childForFieldName("function"));
    if (callee?.type !== "identifier" || !CONTEXT_READS.has(callee.text)) return null;
    const only = unwrap(call.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment") ?? null);
    return only?.type === "identifier" && (this.inScope(only.text) || this.known.has(only.text)) ? only : null;
  }

  /** The `[key, local]` pairs an object pattern binds by plain name (a nested pattern, a rest and a computed key are left out). */
  private patternBindings(pattern: Node): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const m of pattern.namedChildren) {
      if (m.type === "shorthand_property_identifier_pattern") out.push([m.text, m.text]);
      else if (m.type === "pair_pattern") {
        const key = keyOf(m.childForFieldName("key"));
        const local = m.childForFieldName("value");
        if (key && local?.type === "identifier") out.push([key, local.text]);
      }
    }
    return out;
  }

  /** `const { onClick } = substitution`: each name copies the source's member. */
  private destructure(pattern: Node, value: Node, line: number): void {
    const source = this.destructureSource(value);
    if (!source || (source.name !== "this" && !this.inScope(source.name) && !(unwrap(value)?.type === "call_expression" && this.known.has(source.name)))) return;
    for (const [key, local] of this.patternBindings(pattern)) {
      this.names.add(local);
      this.readRoots.add(source.name);
      this.facts.push({ kind: "copy", from: subOf(source, key), to: { name: local }, line });
    }
  }

  /**
   * An object literal handed as an argument: its function members ride a one-use cell the callee's formal receives
   * (core joins them to the formal's declared type). Nothing is stated for a literal that holds no function or value.
   */
  private literalArg(literal: Node, line: number, typeName?: string): ValueCell | null {
    // A literal of plain data (numbers, strings, flags) has nothing to pass on.
    const carries = literal.namedChildren.some((m) => {
      if (m.type === "shorthand_property_identifier") return true;
      const v = m.type === "pair" ? unwrap(m.childForFieldName("value")) : null;
      return v !== null && (v.type === "identifier" || v.type === "member_expression" || v.type === "object" || FUNCTION_VALUES.has(v.type) || v.type === "call_expression");
    });
    if (!carries) return null;
    const tmp: ValueCell = { name: `<arg@${line}#${this.tmp++}>` };
    const mark = this.facts.length;
    this.assignTo(tmp, literal, line);
    if (this.facts.slice(mark).every((f) => f.kind === "copy" && f.from === LITERAL && f.to.member === undefined)) {
      this.facts.length = mark;
      return null;
    }
    if (typeName) this.typedTemps.push({ name: tmp.name, type: typeName });
    return tmp;
  }

  /** `a.b.c(…)` on a name the function reads: the cell is `a.b` (a path of declared property types) and the member `c`. */
  private nestedPlace(callee: Node): ValueCell | null {
    const parts: string[] = [];
    let cur: Node | null = unwrap(callee.childForFieldName("object"));
    while (cur?.type === "member_expression") {
      const prop = cur.childForFieldName("property");
      if (prop?.type !== "property_identifier") return null;
      parts.unshift(prop.text);
      cur = unwrap(cur.childForFieldName("object"));
    }
    const member = callee.childForFieldName("property");
    if (cur?.type !== "identifier" || member?.type !== "property_identifier" || parts.length === 0 || parts.length >= MAX_DEPTH) return null;
    if (NOT_VALUES.has(cur.text) || !(this.names.has(cur.text) || this.known.has(cur.text) || (this.moduleView?.names.has(cur.text) ?? false))) return null;
    return { name: [cur.text, ...parts].join("."), member: member.text };
  }

  /** The single type argument of a state-hook style call (`useState<Substitution>(…)`), else undefined. */
  private typeArgumentOf(call: Node): string | undefined {
    if (call.type !== "call_expression") return undefined;
    const callee = unwrap(call.childForFieldName("function"));
    const name = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : callee?.text;
    if (!name || !TYPED_VALUE_CALLS.has(name)) return undefined;
    const typeArgs = call.childForFieldName("type_arguments");
    const [only, ...rest] = typeArgs?.namedChildren ?? [];
    return only && rest.length === 0 && (only.type === "type_identifier" || only.type === "nested_type_identifier") ? only.text : undefined;
  }

  private inScope(name: string): boolean {
    return this.names.has(name) || (this.moduleView?.names.has(name) ?? false);
  }

  /** Whether a function nested inside the walked tree (not the walked function itself) takes `n`'s name as a parameter. */
  private boundBelowRoot(n: Node): boolean {
    for (let p: Node | null = n.parent; p && p.id !== this.root.id; p = p.parent) {
      if (p.type === "program") return false;
      if (FUNCTION_VALUES.has(p.type) && boundParameterNames(p).has(n.text)) return true;
    }
    return false;
  }

  /** The functions and cells an expression stands for. */
  refsOf(node: Node | null, depth = 0): Ref[] {
    const n = unwrap(node);
    if (!n || depth > 2) return [];
    switch (n.type) {
      case "shorthand_property_identifier":
      case "identifier": {
        if (NOT_VALUES.has(n.text)) return [];
        if (this.names.has(n.text)) return [{ cell: { name: n.text } }];
        // A parameter of a function expression nested in the walked scope (`this.run = function (score) {…}`) is a value handed in, never the module function of that name.
        if (this.known.has(n.text) && this.root && this.boundBelowRoot(n)) return [];
        return this.known.has(n.text) ? [{ cell: { name: n.text }, fn: n.text }] : [];
      }
      case "member_expression": {
        const cell = this.placeOf(n);
        if (!cell) return [];
        if (cell.name === "this" && cell.member !== undefined && !cell.member.includes(".")) return [{ cell, fn: `this.${cell.member}` }];
        if (this.names.has(cell.name) || cell.name === "this") return [{ cell }];
        return this.known.has(cell.name) ? [{ cell, fn: `${cell.name}.${cell.member}` }] : [];
      }
      case "subscript_expression": {
        const cell = this.placeOf(n);
        return cell ? [{ cell }] : [];
      }
      case "call_expression": {
        const target = bound(n);
        if (target) return this.refsOf(target, depth + 1);
        // `useContext(CmdContext)`: the value the context was built with, held by the name that built it.
        const context = this.contextArgument(n);
        return context ? [{ cell: { name: context.text } }] : [];
      }
      case "ternary_expression":
        return [...this.refsOf(n.childForFieldName("consequence"), depth + 1), ...this.refsOf(n.childForFieldName("alternative"), depth + 1)];
      case "binary_expression": {
        const op = n.childForFieldName("operator")?.text;
        return op === "||" || op === "??" || op === "&&" ? [...this.refsOf(n.childForFieldName("left"), depth + 1), ...this.refsOf(n.childForFieldName("right"), depth + 1)] : [];
      }
      default:
        if (FUNCTION_VALUES.has(n.type)) {
          const held = heldFunction(n);
          return held ? [{ fn: held }] : [];
        }
        return [];
    }
  }

  private emitRefs(to: ValueCell, refs: Ref[], line: number): void {
    for (const r of refs) {
      if (r.fn) this.facts.push({ kind: "seed", to, fn: r.fn, line });
      if (r.cell && !(r.cell.name === to.name && r.cell.member === to.member)) this.facts.push({ kind: "copy", from: r.cell, to, line });
    }
  }

  /** The cell holding `refs` for one use: the cell itself when it is only a cell, else a one-use cell. */
  private cellFor(refs: Ref[], tag: string, line: number): ValueCell | null {
    if (refs.length === 0) return null;
    if (refs.length === 1 && !refs[0]!.fn && refs[0]!.cell) return refs[0]!.cell;
    const tmp: ValueCell = { name: `<${tag}@${line}#${this.tmp++}>` };
    this.emitRefs(tmp, refs, line);
    return tmp;
  }

  // ── Statements ────────────────────────────────────────────────────────────

  /** `to = value`: a call's result, a literal's members, or the functions and cells the value stands for. */
  assignTo(to: ValueCell, value: Node | null, line: number, depth = 0): void {
    const v = unwrap(value);
    if (!v || depth > 2) return;
    if (v.type === "object") {
      // The `<literal>` copy marks a NAME as bound; on a member (`{ kickoff: { minute: 48 } }`) it would only claim
      // that member key holds something, which keeps the name tiers off every `x.kickoff()` in the project.
      if (to.member === undefined) this.facts.push({ kind: "copy", from: LITERAL, to, line });
      for (const m of v.namedChildren) {
        if (m.type === "shorthand_property_identifier") {
          this.emitRefs(subOf(to, m.text), this.refsOf(m), line);
          this.emitRefs(elementOf(to), this.refsOf(m), line);
        } else if (m.type === "pair") {
          const key = keyOf(m.childForFieldName("key"));
          const held = m.childForFieldName("value");
          const inner = unwrap(held);
          if (key && inner?.type === "object") {
            this.assignTo(subOf(to, key), inner, m.startPosition.row + 1, depth + 1);
            // `kit[kind].run()`: an element of the object is any of its members, so a computed key reads them all.
            this.assignTo(elementOf(to), inner, m.startPosition.row + 1, depth + 1);
          }
          const refs = this.refsOf(held);
          if (key) this.emitRefs(subOf(to, key), refs, m.startPosition.row + 1);
          this.emitRefs(elementOf(to), refs, m.startPosition.row + 1);
        }
      }
      return;
    }
    if (v.type === "array") {
      this.facts.push({ kind: "copy", from: LITERAL, to, line });
      for (const el of v.namedChildren) {
        if (el.type === "comment") continue;
        if (el.type === "spread_element") {
          // `[...base, run]`: the list takes on the elements of the one spread into it.
          const from = this.placeOf(el.namedChild(0));
          if (from && (from.member !== undefined || this.inScope(from.name))) this.facts.push({ kind: "copy", from: elementOf(from), to: elementOf(to), line: el.startPosition.row + 1 });
          continue;
        }
        this.emitRefs(elementOf(to), this.refsOf(el), el.startPosition.row + 1);
      }
      return;
    }
    if (v.type === "new_expression") {
      const ctor = v.childForFieldName("constructor");
      if (ctor?.type === "identifier" && CONTAINER_CTORS.has(ctor.text)) {
        this.facts.push({ kind: "copy", from: LITERAL, to, line });
        // `new Set([a, b])`, `new Map([[k, f]])`: the array's elements.
        const first = v.childForFieldName("arguments")?.namedChildren[0];
        if (first?.type === "array") this.assignTo(to, first, line, depth + 1);
      }
      return;
    }
    const call = callOf(v);
    if (call && !bound(call)) {
      const wrapped = this.wrappedValue(call);
      if (wrapped) {
        this.assignTo(to, wrapped, line, depth + 1);
        return;
      }
      const name = this.callName(call);
      if (name) this.facts.push({ kind: "result", call: name, line: call.startPosition.row + 1, to });
      return;
    }
    this.emitRefs(to, this.refsOf(v), line);
  }

  /** The first argument of a `reactive(…)`-style call, when it is an object literal or a name the function holds: the value the result stands for. */
  private wrappedValue(call: Node): Node | null {
    if (call.type !== "call_expression") return null;
    const callee = unwrap(call.childForFieldName("function"));
    const name = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : callee?.text;
    if (!name || !VALUE_WRAPPERS.has(name)) return null;
    const first = unwrap(call.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment") ?? null);
    return first && (first.type === "object" || first.type === "array") ? first : null;
  }

  private assignment(node: Node): void {
    const op = node.childForFieldName("operator")?.text ?? "=";
    if (op !== "=" && op !== "||=" && op !== "??=") return;
    const left = unwrap(node.childForFieldName("left"));
    if (!left) return;
    // A module-level name the function does not declare is the file's own cell (`ValueCell.module`).
    if (left.type === "identifier" && !this.names.has(left.text) && !this.atModule) {
      if (!this.moduleView?.names.has(left.text)) return;
      this.assignTo({ name: left.text, module: true }, node.childForFieldName("right"), node.startPosition.row + 1);
      return;
    }
    const place = this.placeOf(left);
    if (!place) return;
    if (place.member !== undefined && place.name !== "this" && !this.inScope(place.name)) return;
    this.assignTo(place, node.childForFieldName("right"), node.startPosition.row + 1);
  }

  private returns(expr: Node | null, line: number): void {
    const v = unwrap(expr);
    if (!v) return;
    const call = callOf(v);
    if (call && !bound(call)) {
      const name = this.callName(call);
      if (!name) return;
      const tmp: ValueCell = { name: `<return@${line}#${this.tmp++}>` };
      this.facts.push({ kind: "result", call: name, line: call.startPosition.row + 1, to: tmp }, { kind: "return", from: tmp, line });
      return;
    }
    const cell = this.cellFor(this.refsOf(v), "return", line);
    if (cell) this.facts.push({ kind: "return", from: cell, line });
  }

  /** A concise arrow's body is its returned value. */
  conciseReturn(body: Node): void {
    this.returns(body, body.startPosition.row + 1);
  }

  private forOf(node: Node): void {
    if (!node.children.some((c) => c.type === "of")) return;
    const left = node.childForFieldName("left");
    if (left?.type !== "identifier") return;
    const list = this.refsOf(node.childForFieldName("right")).find((r) => r.cell)?.cell;
    if (list) {
      this.names.add(left.text);
      this.iterNames.add(left.text);
      this.facts.push({ kind: "copy", from: elementOf(list), to: { name: left.text }, line: node.startPosition.row + 1 });
    }
  }

  private callName(call: Node): string | null {
    return joinableCallName(javascriptCallHooks.resolveCallName?.(call) ?? null);
  }

  private call(node: Node): void {
    const line = node.startPosition.row + 1;
    const callee = node.type === "new_expression" ? node.childForFieldName("constructor") : unwrap(node.childForFieldName("function"));
    const args = node.childForFieldName("arguments");
    const property = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
    const receiver = callee?.type === "member_expression" ? this.placeOf(callee.childForFieldName("object")) : null;

    // `handlers.push(save)`, `registry.set(key, save)`: the list's or map's element.
    if (receiver && property && (LIST_WRITERS.has(property) || property === "set") && args && (receiver.member !== undefined || this.inScope(receiver.name))) {
      const written = args.namedChildren.filter((a) => a.type !== "comment");
      const values = property === "set" ? written.slice(-1) : written;
      for (const a of values) this.emitRefs(elementOf(receiver), this.refsOf(a), line);
      return;
    }
    // `handlers.forEach((h) => h())`: the callback's parameter holds each element.
    if (receiver && property && ELEMENT_CALLBACKS.has(property) && args && (receiver.member !== undefined || this.inScope(receiver.name))) {
      const cb = unwrap(args.namedChildren.find((a) => a.type !== "comment") ?? null);
      if (cb && FUNCTION_VALUES.has(cb.type)) {
        const [first] = parameterNames(cb);
        if (first) {
          this.names.add(first);
          this.iterNames.add(first);
          this.facts.push({ kind: "copy", from: elementOf(receiver), to: { name: first }, line });
        }
      }
    }

    const name = this.callName(node);
    if (name && args) {
      let index = 0;
      for (const a of args.namedChildren) {
        if (a.type === "comment") continue;
        const at = index++;
        if (a.type === "spread_element") continue;
        const literal = unwrap(a);
        if (literal?.type === "object") {
          const held = this.literalArg(literal, line, at === 0 ? this.typeArgumentOf(node) : undefined);
          if (held) this.facts.push({ kind: "arg", call: name, line, index: at, from: held });
          continue;
        }
        const cell = this.cellFor(this.refsOf(a), "arg", line);
        if (cell) this.facts.push({ kind: "arg", call: name, line, index: at, from: cell });
      }
    }

    // The invoke: a call that runs a held value.
    if (node.type !== "call_expression" || !callee) return;
    if (callee.type === "identifier") {
      // Only where the name is bound at the site: a sibling block's `const save` does not hide the module's `save`.
      const here = this.names.has(callee.text) && (this.formals.has(callee.text) || this.iterNames.has(callee.text) || boundAtSite(node, callee.text));
      if (here || (!this.names.has(callee.text) && this.moduleView?.written.has(callee.text))) this.facts.push({ kind: "invoke", cell: { name: callee.text }, call: callee.text, line });
      return;
    }
    if (callee.type === "subscript_expression") {
      if (dispatchMapCallee(callee) !== null) return;
      const cell = this.placeOf(callee);
      const object = this.placeOf(callee.childForFieldName("object"));
      if (!cell || !object || !(object.name === "this" || this.inScope(object.name))) return;
      const text = callee.childForFieldName("object")!.text;
      const key = indexKey(callee.childForFieldName("index"));
      const callName = key ? `${text}.${key}` : `${text}[]`;
      this.extraCalls.push({ name: callName, kind: "internal", target: null, line, column: node.startPosition.column });
      this.facts.push({ kind: "invoke", cell, call: callName, line });
      return;
    }
    if (callee.type !== "member_expression") return;
    // `cb.call(this, x)`, `cb.apply(this, args)`: the function the receiver holds runs.
    if (property === "call" || property === "apply") {
      const held = receiver;
      if (held && (this.names.has(held.name) || held.name === "this" || held.member !== undefined)) {
        const callName = this.callName(node);
        if (callName) this.facts.push({ kind: "invoke", cell: held, call: callName, line });
      }
      return;
    }
    const place = this.placeOf(callee);
    // `ctx.onPurge()` with `const ctx = useContext(CmdContext)`: the member the context was built with, run only where
    // that context's own member is written (the file's own, or the file its import names).
    const alias = place?.member !== undefined && !place.member.includes(".") ? this.contextLocals.get(place.name) : undefined;
    // Inside the declaring scope, and no parameter, local, loop or catch binding of the name between the call and it.
    const context = alias && isWithin(node, alias.scope) && !reboundBefore(node, place!.name, alias.scope) ? alias.context : undefined;
    if (context && place?.member !== undefined) {
      const callName = joinableCallName(javascriptCallHooks.resolveCallName?.(node) ?? null);
      if (callName) this.facts.push({ kind: "invoke", cell: { name: context, member: place.member }, call: callName, line, held: "module" });
      return;
    }
    // `kit[kind].run()`: the member of whichever element the computed key picks, run only when this function stored it.
    const picked = unwrap(callee.childForFieldName("object"));
    if (place && picked?.type === "subscript_expression" && property) {
      const text = picked.childForFieldName("object")?.text ?? "";
      const name = joinableCallName(`${text}[].${property}`);
      if (name && dispatchMapCallee(picked) === null) {
        this.memberCalls.push({ cell: place, name, line, column: node.startPosition.column });
      }
      return;
    }
    const written = javascriptCallHooks.resolveCallName?.(node) ?? null;
    const callName = joinableCallName(written);
    if (callName && place) {
      this.memberCalls.push({ cell: place, name: callName, line });
      // `state.onSave()` on a module-level object — this file's own or a project module's the function imports — that another
      // statement stored `onSave` into: core finds the writers; with none it keeps the ordinary resolution of the call.
      if (!this.atModule && place.member !== undefined && !place.member.includes(".") && !this.names.has(place.name) && (this.moduleView?.names.has(place.name) || projectImportsOf(this.root.tree).has(place.name))) {
        this.facts.push({ kind: "invoke", cell: place, call: callName, line, held: "module" });
      }
    }
    else if (!place) {
      // `board.action?.onClick()`: a member of a member, read through the declared types (core drops it when none says so).
      // The call keeps its optional-chain spelling, as its call row does.
      const nested = written && /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/.test(written) && written.length <= 100 ? this.nestedPlace(callee) : null;
      if (nested) this.facts.push({ kind: "invoke", cell: nested, call: written!, line });
    }
  }

  /** `a.b(…)` on a local object the function itself stores `b` into: that call runs the stored value. */
  finish(): void {
    this.invokeStoredMembers();
    this.prune();
  }

  /**
   * Keeps what can matter: a fact reading a cell nothing binds (a plain local that holds no function, a data-typed
   * parameter) and a call result or literal nothing reads would only be fed to core to be dropped there.
   */
  private prune(): void {
    const dest = new Set<string>();
    for (const f of this.facts) if (f.kind === "seed" || f.kind === "copy" || f.kind === "result") dest.add(f.to.name);
    const readable = (c: ValueCell): boolean => {
      // A nested cell (`a.b`) is read through its root.
      const name = !c.name.startsWith("<") && c.name.includes(".") ? c.name.slice(0, c.name.indexOf(".")) : c.name;
      return name === "this" || name.startsWith("<") || this.readRoots.has(name) || this.formals.has(name) || dest.has(name) || this.known.has(name) || (this.moduleView?.names.has(name) ?? false);
    };
    let facts = this.facts.filter((f) => {
      switch (f.kind) {
        case "copy": return f.from === LITERAL || readable(f.from);
        case "arg": return readable(f.from);
        case "return": return readable(f.from);
        case "invoke": return readable(f.cell) || (this.moduleView?.written.has(f.cell.name) ?? false);
        default: return true;
      }
    });
    const read = new Set<string>();
    for (const f of facts) {
      if (f.kind === "copy" && f.from !== LITERAL) read.add(f.from.name);
      else if (f.kind === "arg" || f.kind === "return") read.add(f.from.name);
      else if (f.kind === "invoke") read.add(f.cell.name);
      if ((f.kind === "seed" || f.kind === "copy") && f.to.member !== undefined) read.add(f.to.name);
    }
    if (this.atModule) for (const n of this.calledNames()) read.add(n);
    facts = facts.filter((f) => {
      if (f.kind === "result") return f.to.module || read.has(f.to.name);
      if (f.kind === "copy" && f.from === LITERAL) return read.has(f.to.name);
      return true;
    });
    this.facts.length = 0;
    this.facts.push(...facts);
  }

  /** Names the module-level walk's file calls or indexes (a module-level result is only worth stating when something runs it). */
  private calledNames(): Set<string> {
    const out = new Set<string>();
    for (const c of this.root.descendantsOfType(["call_expression", "subscript_expression"])) {
      const f = c?.type === "call_expression" ? c.childForFieldName("function") : c?.childForFieldName("object");
      if (f?.type === "identifier") out.add(f.text);
    }
    return out;
  }

  private invokeStoredMembers(): void {
    if (this.memberCalls.length === 0) return;
    const stored = new Set<string>();
    for (const f of this.facts) if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && f.to.member !== undefined) stored.add(`${f.to.name}\0${f.to.member}`);
    for (const m of this.memberCalls) {
      if (m.cell.name === "this" || m.cell.member === undefined || !stored.has(`${m.cell.name}\0${m.cell.member}`) || dispatchMapMember(m.name, this.root)) continue;
      this.facts.push({ kind: "invoke", cell: m.cell, call: m.name, line: m.line });
      // The call row the invoke joins (the walk records `kit[kind].run` under no name a link can carry).
      if (m.column !== undefined) this.extraCalls.push({ name: m.name, kind: "internal", target: null, line: m.line, column: m.column });
    }
  }
}

/**
 * The value-flow facts of one function body, with the calls it makes that the call walk does not record.
 * `params` are the function's own formals; `extra` is appended to by the caller's `calls`.
 */
export function valueFlowOf(
  body: Node | null,
  params: readonly ParamInfo[],
  skip?: (node: Node) => boolean,
): { facts: ValueFlowFact[]; extraCalls: CallInfo[]; typedTemps: Array<{ name: string; type: string }> } | null {
  if (!body) return null;
  const view = moduleFlowOf(body.tree);
  const ids = params.filter((p) => /^[A-Za-z_$][\w$]*$/.test(p.name));
  const flow = new Flow(ids.map((p) => p.name), skip ?? null, false, view, undefined, ids.filter((p) => !(p.type && DATA_TYPE.test(p.type.trim()))).map((p) => p.name));
  flow.root = body;
  flow.declare(body);
  if (body.type !== "statement_block") flow.conciseReturn(body);
  flow.visit(body, true);
  flow.finish();
  if (flow.facts.length === 0 && flow.extraCalls.length === 0) return null;
  return { facts: dedupe(flow.facts), extraCalls: flow.extraCalls, typedTemps: flow.typedTemps };
}

/** The facts of a class field's initializer (`onSave = this.save.bind(this)`, `handlers = [save]`), stated on `this.<field>`. */
export function fieldValueFlow(field: string, value: Node | null): ValueFlowFact[] {
  if (!value) return [];
  const flow = new Flow([], null, true, undefined, knownNamesOf(value.tree));
  flow.root = value;
  const v = unwrap(value);
  if (!v || FUNCTION_VALUES.has(v.type)) return [];
  flow.assignTo({ name: "this", member: field }, v, value.startPosition.row + 1);
  flow.finish();
  return dedupe(flow.facts);
}

/** The module-level facts of a file (`FileAnalysis.moduleValueFlow`). */
export function moduleValueFlowOf(tree: Tree, sourceText: string): ValueFlowFact[] {
  if (!/[=(]/.test(sourceText)) return [];
  const { facts } = moduleFlowOf(tree);
  return facts;
}

/** A call spelled as a chain or an expression (`rows.map(…).sort`) names no callee the linker could join. */
function joinableCallName(name: string | null): string | null {
  return name && name.length <= 100 && /^(?:new )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\[\](?:\.[A-Za-z_$][\w$]*)*)?$/.test(name) ? name : null;
}

/** Whether `node` lies inside `scope`. */
function isWithin(node: Node, scope: Node): boolean {
  for (let p: Node | null = node.parent; p; p = p.parent) if (p.id === scope.id) return true;
  return false;
}
