import type { Node, Tree } from "web-tree-sitter";
import type { CallInfo, ParamInfo, ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { javascriptCallHooks } from "./call-hooks.js";
import { dispatchMapCallee, dispatchMapMember } from "./dispatch-maps.js";
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

function knownNamesOf(tree: Tree): Set<string> {
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
  /** A node of the tree walked (dispatch maps are read per tree). */
  root!: Node;
  /** `a.b(…)` calls on a local object: invoked only when the function stores into that member itself. */
  private readonly memberCalls: Array<{ cell: ValueCell; name: string; line: number }> = [];
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
        if (name?.type === "identifier" && value && !isFunctionLike(value)) this.assignTo({ name: name.text }, value, node.startPosition.row + 1);
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
      return base && base.name === "this" && base.member !== undefined && base.member.split(".").length < MAX_DEPTH ? subOf(base, prop.text) : null;
    }
    if (n.type === "subscript_expression") {
      const key = indexKey(n.childForFieldName("index"));
      const base = this.placeOf(n.childForFieldName("object"));
      if (!base) return null;
      if (base.name === "this" || base.member !== undefined) {
        // `this.items[k]`: the element of a field (no per-key cells below `this`).
        return base.name === "this" && base.member !== undefined ? elementOf(base) : null;
      }
      return key ? { name: base.name, member: key } : elementOf(base);
    }
    return null;
  }

  private inScope(name: string): boolean {
    return this.names.has(name) || (this.moduleView?.names.has(name) ?? false);
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
        return target ? this.refsOf(target, depth + 1) : [];
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
      this.facts.push({ kind: "copy", from: LITERAL, to, line });
      for (const m of v.namedChildren) {
        if (m.type === "shorthand_property_identifier") {
          this.emitRefs(subOf(to, m.text), this.refsOf(m), line);
          this.emitRefs(elementOf(to), this.refsOf(m), line);
        } else if (m.type === "pair") {
          const key = keyOf(m.childForFieldName("key"));
          const held = m.childForFieldName("value");
          const inner = unwrap(held);
          if (key && inner?.type === "object") this.assignTo(subOf(to, key), inner, m.startPosition.row + 1, depth + 1);
          const refs = this.refsOf(held);
          if (key) this.emitRefs(subOf(to, key), refs, m.startPosition.row + 1);
          this.emitRefs(elementOf(to), refs, m.startPosition.row + 1);
        }
      }
      return;
    }
    if (v.type === "array") {
      this.facts.push({ kind: "copy", from: LITERAL, to, line });
      for (const el of v.namedChildren) if (el.type !== "spread_element" && el.type !== "comment") this.emitRefs(elementOf(to), this.refsOf(el), el.startPosition.row + 1);
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
      const name = this.callName(call);
      if (name) this.facts.push({ kind: "result", call: name, line: call.startPosition.row + 1, to });
      return;
    }
    this.emitRefs(to, this.refsOf(v), line);
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
      this.facts.push({ kind: "copy", from: elementOf(list), to: { name: left.text }, line: node.startPosition.row + 1 });
    }
  }

  private callName(call: Node): string | null {
    const name = javascriptCallHooks.resolveCallName?.(call) ?? null;
    // A call spelled as a chain or an expression (`rows.map(…).sort`) names no callee the linker could join.
    return name && name.length <= 100 && /^(?:new )?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\[\](?:\.[A-Za-z_$][\w$]*)*)?$/.test(name) ? name : null;
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
        const cell = this.cellFor(this.refsOf(a), "arg", line);
        if (cell) this.facts.push({ kind: "arg", call: name, line, index: at, from: cell });
      }
    }

    // The invoke: a call that runs a held value.
    if (node.type !== "call_expression" || !callee) return;
    if (callee.type === "identifier") {
      if (this.names.has(callee.text) || this.moduleView?.written.has(callee.text)) this.facts.push({ kind: "invoke", cell: { name: callee.text }, call: callee.text, line });
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
    const callName = this.callName(node);
    const place = this.placeOf(callee);
    if (callName && place) this.memberCalls.push({ cell: place, name: callName, line });
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
    const readable = (c: ValueCell): boolean =>
      c.name === "this" || c.name.startsWith("<") || this.formals.has(c.name) || dest.has(c.name) || this.known.has(c.name) || (this.moduleView?.names.has(c.name) ?? false);
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
): { facts: ValueFlowFact[]; extraCalls: CallInfo[] } | null {
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
  return { facts: dedupe(flow.facts), extraCalls: flow.extraCalls };
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
