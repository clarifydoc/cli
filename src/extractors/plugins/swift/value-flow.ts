/**
 * Swift's value-flow facts (`FunctionInfo.valueFlow`, `FileAnalysis.moduleValueFlow`): how a function value travels
 * through locals, properties, parameters, returns, arrays and dictionaries, read off tree-sitter-swift's tree.
 * Only facts are stated here; core's solver (core/value-flow.ts) resolves them. A call is named as the reader named
 * it for the call list (`CallRefs`, by the call expression's node id), so a fact meets the `CallInfo`.
 */
import type { TSNode } from "../../../parsers/parser-manager.js";
import type { ValueCell, ValueFlowFact } from "../../../types/analysis.js";

export type CallRefs = Map<number, { name: string; line: number }>;

/** What a name may hold: a function value (`fn`), a collection, something that is no callable (`other`), or unknown (`may`). */
type Kind = "fn" | "coll" | "other" | "may" | "call" | "named";

/** What a type declares that a bare name in its methods can be. */
export interface TypeScope {
  name: string;
  fields: Map<string, Kind>;
  methods: Set<string>;
  /** Facts of property initializers (`var handlers = ["save": save]`), stated by the type's initializer. */
  initFacts: ValueFlowFact[];
}

export interface FileScope {
  types: Map<number, TypeScope>;
  typeNames: Set<string>;
  moduleNames: Map<string, Kind>;
  src: string;
}

const namedChildren = (node: TSNode): TSNode[] => {
  const out: TSNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
};

const PRIMITIVES = /^(?:Int|Int\d+|UInt\d*|Double|Float|CGFloat|String|Bool|Date|URL|Data|UUID|Character|Void|Any|AnyObject|View|Color|Text|Image|Error|Result|Array|Dictionary|Set|Optional)\b/;

/** The kind a declared type gives: a function type (possibly optional) is `fn`; a collection `coll`. */
function kindOfTypeNode(type: TSNode | undefined, typeNames: ReadonlySet<string>): Kind {
  if (!type) return "may";
  const text = type.text;
  if (/->/.test(text) || type.type === "function_type" || descendants(type, "function_type").length > 0) return "fn";
  if (/^\[/.test(text) || /^(?:Array|Dictionary|Set)</.test(text)) return "coll";
  const base = text.replace(/[?!<].*$/s, "").trim();
  if (/(?:Callback|Handler|Block|Closure|Action)$/.test(base)) return "fn";
  if (PRIMITIVES.test(base) || typeNames.has(base)) return "other";
  // A stated type nothing here says is a function (a callable object, or a typealias from another file).
  return "named";
}

function descendants(node: TSNode, type: string): TSNode[] {
  const out: TSNode[] = [];
  const stack = [node];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === type) out.push(n);
    for (const c of namedChildren(n)) stack.push(c);
  }
  return out;
}

function kindOfInit(node: TSNode | undefined): Kind {
  if (!node) return "may";
  switch (node.type) {
    case "array_literal":
    case "dictionary_literal": return "coll";
    case "lambda_literal": return "fn";
    case "line_string_literal":
    case "integer_literal":
    case "real_literal":
    case "boolean_literal":
    case "nil": return "other";
    case "call_expression": {
      const callee = node.namedChild(0);
      // A construction is no function; a lower-case call may hand one back (the name itself is no function).
      return callee?.type === "simple_identifier" && /^[A-Z]/.test(callee.text) ? "other" : "call";
    }
    default: return "may";
  }
}

/** The name and value of a `property_declaration`, with the kind its type or initializer gives. */
function propertyOf(node: TSNode, typeNames: ReadonlySet<string>): { name: string; kind: Kind; value: TSNode | undefined; computed: boolean } | null {
  let name = "";
  let type: TSNode | undefined;
  let value: TSNode | undefined;
  let computed = false;
  for (const c of namedChildren(node)) {
    if (c.type === "pattern" && !name) {
      const id = c.namedChild(0);
      if (id?.type === "simple_identifier") name = id.text;
    } else if (c.type === "type_annotation") type = c.namedChild(0) ?? undefined;
    else if (c.type === "computed_property" || c.type === "willset_didset_block") computed = true;
    else if (c.type !== "value_binding_pattern" && c.type !== "modifiers" && c.type !== "property_behavior_modifier" && c.type !== "attribute") value = c;
  }
  if (!name) return null;
  const kind = type ? kindOfTypeNode(type, typeNames) : kindOfInit(value);
  return { name, kind: kind === "other" && value && kindOfInit(value) === "may" && !type ? "may" : kind, value, computed };
}

/** A type's own declarations, read once. */
export function typeScopeOf(node: TSNode, typeNames: ReadonlySet<string>): TypeScope {
  const id = namedChildren(node).find((c) => c.type === "type_identifier" || c.type === "user_type");
  const scope: TypeScope = { name: id?.text.replace(/<.*$/s, "") ?? "", fields: new Map(), methods: new Set(), initFacts: [] };
  const body = namedChildren(node).find((c) => c.type === "class_body" || c.type === "enum_class_body" || c.type === "protocol_body");
  if (!body) return scope;
  for (const m of namedChildren(body)) {
    if (m.type === "function_declaration") {
      const n = m.childForFieldName("name");
      if (n) scope.methods.add(n.text);
    } else if (m.type === "property_declaration") {
      const p = propertyOf(m, typeNames);
      if (p && !p.computed) scope.fields.set(p.name, p.kind);
    }
  }
  return scope;
}

export function fileScopeOf(root: TSNode, src: string): FileScope {
  const typeNames = new Set<string>();
  const decls: TSNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "class_declaration" || n.type === "protocol_declaration") {
      decls.push(n);
      const id = namedChildren(n).find((c) => c.type === "type_identifier");
      if (id) typeNames.add(id.text);
    }
    for (const c of namedChildren(n)) stack.push(c);
  }
  const types = new Map<number, TypeScope>();
  for (const d of decls) types.set(d.id, typeScopeOf(d, typeNames));
  const moduleNames = new Map<string, Kind>();
  for (const n of namedChildren(root)) {
    if (n.type !== "property_declaration") continue;
    const p = propertyOf(n, typeNames);
    if (p && !p.computed) moduleNames.set(p.name, p.kind);
  }
  return { types, typeNames, moduleNames, src };
}

const TEAR_OFF = /^[a-z_$][\w$]*$/;
const NOT_VALUES = new Set(["nil", "true", "false", "self", "super", "try", "await"]);

/** The member a `navigation_expression` reads and its target, or null. */
function navigation(node: TSNode): { target: TSNode; member: string } | null {
  if (node.type !== "navigation_expression") return null;
  const target = node.childForFieldName("target");
  const member = node.childForFieldName("suffix")?.childForFieldName("suffix");
  return target && member?.type === "simple_identifier" ? { target, member: member.text } : null;
}

/** `x!` / `x?` / `try x` / `await x`: the value under the marker. */
function unwrap(node: TSNode): TSNode {
  let n = node;
  for (let depth = 0; depth < 8; depth++) {
    if (n.type === "postfix_expression") {
      const t = n.childForFieldName("target");
      if (!t) return n;
      n = t;
    } else if (n.type === "try_expression" || n.type === "await_expression") {
      const t = n.childForFieldName("expr") ?? namedChildren(n).at(-1);
      if (!t) return n;
      n = t;
    } else if (n.type === "tuple_expression" && n.namedChildCount === 1) n = n.namedChild(0)!;
    else return n;
  }
  return n;
}

/** A call's argument list: `(…)` (never a `[…]` subscript) and whether a closure trails. */
function callParts(node: TSNode): { callee: TSNode; args: TSNode | null; subscript: TSNode | null; trailing: boolean } | null {
  if (node.type !== "call_expression") return null;
  const callee = node.namedChild(0);
  const suffix = node.namedChild(1);
  if (!callee || suffix?.type !== "call_suffix") return null;
  let args: TSNode | null = null;
  let trailing = false;
  for (const p of namedChildren(suffix)) {
    if (p.type === "value_arguments") args ??= p;
    else if (p.type === "lambda_literal") trailing = true;
  }
  const isSubscript = args?.child(0)?.type === "[";
  return { callee, args: isSubscript ? null : args, subscript: isSubscript ? args : null, trailing };
}

/** The text of a plain string literal key, or null. */
function literalKey(node: TSNode | undefined): string | null {
  if (!node || node.type !== "line_string_literal") return null;
  const parts = namedChildren(node);
  return parts.length === 1 && parts[0]!.type === "line_str_text" ? parts[0]!.text : parts.length === 0 ? "" : null;
}

export interface FunctionFacts {
  facts: ValueFlowFact[];
}

const SCOPES: ReadonlySet<string> = new Set(["statements", "for_statement", "lambda_literal"]);

class FactReader {
  readonly facts: ValueFlowFact[] = [];
  /** Names in scope, innermost last: a local is visible in its own block and the blocks inside it. */
  private readonly scopes: Array<Map<string, Kind>> = [new Map()];
  private closureDepth = 0;
  private temps = 0;

  constructor(private readonly file: FileScope, private readonly cls: TypeScope | null, private readonly calls: CallRefs) {}

  declare(name: string, kind: Kind): void {
    this.scopes[this.scopes.length - 1]!.set(name, kind);
  }

  private kindOf(name: string): { kind: Kind; where: "local" | "field" | "module" } | null {
    const local = this.local(name);
    if (local) return { kind: local, where: "local" };
    const field = this.cls?.fields.get(name);
    if (field && !this.cls!.methods.has(name)) return { kind: field, where: "field" };
    const mod = this.file.moduleNames.get(name);
    if (mod) return { kind: mod, where: "module" };
    return null;
  }

  private local(name: string): Kind | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const kind = this.scopes[i]!.get(name);
      if (kind) return kind;
    }
    return undefined;
  }

  private cellOfName(name: string): ValueCell | null {
    const k = this.kindOf(name);
    if (!k) return null;
    return k.where === "field" ? { name: "self", member: name } : { name };
  }

  private line(node: TSNode): number {
    return node.startPosition.row + 1;
  }

  private temp(node: TSNode): ValueCell {
    return { name: `$v${node.startIndex}_${this.temps++}` };
  }

  private elementCell(name: string, key: string | null): ValueCell | null {
    const k = this.kindOf(name);
    if (!k) return null;
    if (k.where === "field") return { name: "self", member: key === null ? `${name}[]` : `${name}[${key}]` };
    return { name, member: key === null ? "[]" : key };
  }

  private collectionElement(dest: ValueCell, key: string | null): ValueCell {
    if (dest.name === "self" && dest.member !== undefined) return { name: "self", member: key === null ? `${dest.member}[]` : `${dest.member}[${key}]` };
    return { name: dest.name, member: key === null ? "[]" : key };
  }

  /** The `a["k"]` a call expression with a subscript list reads: the collection's name and the literal key. */
  private subscriptOf(node: TSNode): { name: string; key: string | null } | null {
    const parts = callParts(node);
    if (!parts?.subscript || parts.callee.type !== "simple_identifier") return null;
    const args = namedChildren(parts.subscript).filter((a) => a.type === "value_argument");
    const key = args.length === 1 ? literalKey(namedChildren(args[0]!).at(-1)) : null;
    return { name: parts.callee.text, key };
  }

  // ── Values ─────────────────────────────────────────────────────────────────
  valueInto(dest: ValueCell, node0: TSNode): void {
    const node = unwrap(node0);
    switch (node.type) {
      case "simple_identifier": return this.identInto(dest, node);
      case "navigation_expression": return this.pathInto(dest, node);
      case "lambda_literal": return this.closureInto(dest, node);
      case "array_literal":
      case "dictionary_literal": return this.collectionInto(dest, node);
      case "ternary_expression": {
        const kids = namedChildren(node);
        for (const k of kids.slice(1)) this.valueInto(dest, k);
        return;
      }
      case "nil_coalescing_expression": {
        for (const k of namedChildren(node)) this.valueInto(dest, k);
        return;
      }
      case "call_expression": {
        const sub = this.subscriptOf(node);
        if (sub) {
          const cell = this.elementCell(sub.name, sub.key);
          if (cell) this.facts.push({ kind: "copy", from: cell, to: dest, line: this.line(node) });
          return;
        }
        const ref = this.calls.get(node.id);
        // A plain construction (`Padding(…)`) binds no instance the solver follows.
        if (ref && !/^[A-Z][\w$]*$/.test(ref.name)) this.facts.push({ kind: "result", call: ref.name, line: ref.line, to: dest });
        return;
      }
      default: return;
    }
  }

  private identInto(dest: ValueCell, id: TSNode): void {
    const name = id.text;
    const k = this.kindOf(name);
    if (k) {
      if (k.kind !== "other") this.facts.push({ kind: "copy", from: this.cellOfName(name)!, to: dest, line: this.line(id) });
      return;
    }
    if (TEAR_OFF.test(name) && !NOT_VALUES.has(name) && !/^\$\d+$/.test(name)) this.facts.push({ kind: "seed", to: dest, fn: name, line: this.line(id) });
  }

  private pathInto(dest: ValueCell, node: TSNode): void {
    const nav = navigation(node);
    if (!nav) return;
    const line = this.line(node);
    const { target, member } = nav;
    if (target.type === "self_expression") {
      const field = this.cls?.fields.get(member);
      if (field !== undefined && !this.cls!.methods.has(member)) {
        if (field !== "other") this.facts.push({ kind: "copy", from: { name: "self", member }, to: dest, line });
      } else if (this.cls) this.facts.push({ kind: "seed", to: dest, fn: `self.${member}`, line });
      return;
    }
    if (target.type !== "simple_identifier") return;
    const name = target.text;
    const k = this.kindOf(name);
    if (k) {
      if (k.where === "local" && k.kind !== "other") this.facts.push({ kind: "copy", from: { name, member }, to: dest, line });
      return;
    }
    // `Club.save`: an unapplied method through its type (`Club.self` is the type itself).
    if (/^[A-Z]/.test(name) && member !== "self" && member !== "Type" && member !== "Protocol") this.facts.push({ kind: "seed", to: dest, fn: `${name}.${member}`, line });
  }

  /** `{ save() }` holds `save`; `{ onDone() }` what `onDone` holds. A body doing more states nothing. */
  private closureInto(dest: ValueCell, lambda: TSNode): void {
    const params = new Set<string>();
    for (const p of descendants(lambda, "lambda_parameter")) {
      const id = namedChildren(p).find((c) => c.type === "simple_identifier");
      if (id) params.add(id.text);
    }
    const statements = namedChildren(lambda).find((c) => c.type === "statements");
    const stmts = statements ? namedChildren(statements) : [];
    if (stmts.length !== 1) return;
    const call = unwrap(stmts[0]!);
    const parts = callParts(call);
    if (!parts?.args && !parts?.trailing) return;
    const callee = unwrap(parts!.callee);
    if (callee.type === "simple_identifier") {
      if (params.has(callee.text) || /^\$\d+$/.test(callee.text)) return;
      this.identInto(dest, callee);
    } else if (callee.type === "navigation_expression") {
      const nav = navigation(callee);
      if (nav && !(nav.target.type === "simple_identifier" && params.has(nav.target.text))) this.pathInto(dest, callee);
    }
  }

  private collectionInto(dest: ValueCell, lit: TSNode): void {
    if (dest.member === undefined) this.facts.push({ kind: "copy", from: dest, to: dest, line: this.line(lit) });
    const kids = namedChildren(lit);
    if (lit.type === "array_literal") {
      for (const k of kids) this.valueInto(this.collectionElement(dest, null), k);
      return;
    }
    // A dictionary literal alternates keys and values.
    for (let i = 0; i + 1 < kids.length; i += 2) {
      const key = literalKey(kids[i]);
      this.valueInto(this.collectionElement(dest, null), kids[i + 1]!);
      if (key !== null) this.valueInto(this.collectionElement(dest, key), kids[i + 1]!);
    }
  }

  private cellOfValue(node0: TSNode): ValueCell | null {
    const node = unwrap(node0);
    if (node.type === "simple_identifier") {
      const k = this.kindOf(node.text);
      if (k) return k.kind === "other" ? null : this.cellOfName(node.text);
    }
    if (/literal$/.test(node.type) && node.type !== "array_literal" && node.type !== "dictionary_literal" && node.type !== "lambda_literal") return null;
    const t = this.temp(node);
    const before = this.facts.length;
    this.valueInto(t, node);
    return this.facts.length > before ? t : null;
  }

  // ── Statements ─────────────────────────────────────────────────────────────
  private destOf(lhs: TSNode): ValueCell | null {
    const target = unwrap(lhs.namedChild(0) ?? lhs);
    if (target.type === "simple_identifier") return this.cellOfName(target.text);
    const nav = navigation(target);
    if (nav) {
      if (nav.target.type === "self_expression") return this.cls?.fields.has(nav.member) ? { name: "self", member: nav.member } : null;
      if (nav.target.type === "simple_identifier") {
        const k = this.kindOf(nav.target.text);
        return k && k.where === "local" ? { name: nav.target.text, member: nav.member } : null;
      }
      return null;
    }
    const sub = this.subscriptOf(target);
    return sub ? this.elementCell(sub.name, sub.key) : null;
  }

  private property(node: TSNode): void {
    const p = propertyOf(node, this.file.typeNames);
    if (!p || p.computed) return;
    this.declare(p.name, p.kind);
    if (p.value && p.kind !== "other") this.valueInto({ name: p.name }, p.value);
  }

  walk(node: TSNode): void {
    for (const child of namedChildren(node)) this.visit(child);
  }

  private visit(node: TSNode): void {
    // A block, a loop and a closure are scopes: what they declare is not visible after them.
    if (!SCOPES.has(node.type)) return this.visitNode(node);
    this.scopes.push(new Map());
    try {
      this.visitNode(node);
    } finally {
      this.scopes.pop();
    }
  }

  private visitNode(node: TSNode): void {
    switch (node.type) {
      case "function_declaration":
      case "init_declaration": return;
      case "property_declaration": this.property(node); break;
      case "assignment": {
        const kids = namedChildren(node);
        const lhs = kids[0];
        if (lhs?.type === "directly_assignable_expression" && kids[1]) {
          const dest = this.destOf(lhs);
          if (dest) this.valueInto(dest, kids[1]);
        }
        break;
      }
      case "control_transfer_statement": {
        if (this.closureDepth > 0 || !/^\s*return\b/.test(this.file.src.slice(node.startIndex, node.startIndex + 8))) break;
        const value = namedChildren(node).at(0);
        if (value) {
          const cell = this.cellOfValue(value);
          if (cell) this.facts.push({ kind: "return", from: cell, line: this.line(node) });
        }
        break;
      }
      case "for_statement": this.forIn(node); break;
      case "lambda_literal": {
        this.closureDepth++;
        for (const c of namedChildren(node)) this.visit(c);
        this.closureDepth--;
        return;
      }
      case "call_expression": this.call(node); break;
      default: break;
    }
    for (const c of namedChildren(node)) this.visit(c);
  }

  private forIn(node: TSNode): void {
    const kids = namedChildren(node);
    const pattern = kids.find((c) => c.type === "pattern");
    const id = pattern?.namedChild(0);
    if (!pattern || id?.type !== "simple_identifier") return;
    const iterable = kids[kids.indexOf(pattern) + 1];
    if (!iterable) return;
    this.declare(id.text, "may");
    this.iterate(iterable, { name: id.text }, node);
  }

  private iterate(node0: TSNode, item: ValueCell, at: TSNode): void {
    const node = unwrap(node0);
    if (node.type === "array_literal") {
      for (const k of namedChildren(node)) this.valueInto(item, k);
      return;
    }
    let name: string | null = null;
    if (node.type === "simple_identifier") name = node.text;
    else {
      const nav = navigation(node);
      if (nav?.member === "values" && nav.target.type === "simple_identifier") name = nav.target.text;
    }
    const cell = name ? this.elementCell(name, null) : null;
    if (cell) this.facts.push({ kind: "copy", from: cell, to: item, line: this.line(at) });
  }

  /** One call: its arguments, what it invokes, `append` / `forEach` on a collection. */
  private call(node: TSNode): void {
    const parts = callParts(node);
    if (!parts) return;
    const ref = this.calls.get(node.id);
    if (ref && parts.args) this.callArguments(parts.args, ref);
    const callee = unwrap(parts.callee);
    if (ref) this.invocation(callee, ref);
    this.collectionCall(callee, parts, node);
  }

  private callArguments(args: TSNode, ref: { name: string; line: number }): void {
    let index = 0;
    for (const arg of namedChildren(args)) {
      if (arg.type !== "value_argument") continue;
      const value = namedChildren(arg).filter((c) => c.type !== "value_argument_label").at(-1);
      const cell = value ? this.cellOfValue(value) : null;
      if (cell) this.facts.push({ kind: "arg", call: ref.name, line: ref.line, index, from: cell });
      index++;
    }
  }

  private invocation(callee: TSNode, ref: { name: string; line: number }): void {
    const invoke = (cell: ValueCell): void => {
      this.facts.push({ kind: "invoke", cell, call: ref.name, line: ref.line });
    };
    if (callee.type === "simple_identifier") {
      const k = this.kindOf(callee.text);
      // A call's result holds a function only as a local: a property or module value from one may be a callable object.
      if (k && k.kind !== "other" && k.kind !== "named" && (k.kind !== "call" || k.where === "local")) invoke(this.cellOfName(callee.text)!);
      return;
    }
    const nav = navigation(callee);
    if (nav) {
      // `self.onSave?()`: a property this type declares (a method of it is an ordinary call).
      if (nav.target.type === "self_expression" && this.cls) {
        const f = this.cls.fields.get(nav.member);
        if (f && f !== "other" && f !== "named" && !this.cls.methods.has(nav.member)) invoke({ name: "self", member: nav.member });
      }
      return;
    }
    // `handlers["save"]?()`, `queue[0]()`: an element of a collection.
    if (callee.type === "call_expression") {
      const sub = this.subscriptOf(callee);
      const cell = sub ? this.elementCell(sub.name, sub.key) : null;
      if (cell) invoke(cell);
    }
  }

  private collectionCall(callee: TSNode, parts: NonNullable<ReturnType<typeof callParts>>, node: TSNode): void {
    const nav = navigation(callee);
    if (!nav || nav.target.type !== "simple_identifier") return;
    const k = this.kindOf(nav.target.text);
    if (!k || k.kind === "other") return;
    if (nav.member === "append" && parts.args) {
      const first = namedChildren(parts.args).find((a) => a.type === "value_argument");
      const value = first ? namedChildren(first).filter((c) => c.type !== "value_argument_label").at(-1) : undefined;
      const cell = this.elementCell(nav.target.text, null);
      if (value && cell) this.valueInto(cell, value);
    } else if (nav.member === "forEach") {
      const lambda = descendants(node, "lambda_literal")[0];
      if (!lambda) return;
      const param = descendants(lambda, "lambda_parameter")[0]?.namedChild(0);
      const item = param?.type === "simple_identifier" ? param.text : "$0";
      this.declare(item, "may");
      const cell = this.elementCell(nav.target.text, null);
      if (cell) this.facts.push({ kind: "copy", from: cell, to: { name: item }, line: this.line(lambda) });
    }
  }
}

/** The parameters a function declares, with what their declared type says (`_ cb: @escaping () -> Void`). */
function declareParams(reader: FactReader, fn: TSNode, file: FileScope): void {
  for (const p of namedChildren(fn).filter((c) => c.type === "parameter")) {
    const ids = namedChildren(p).filter((c) => c.type === "simple_identifier");
    const name = ids.at(-1);
    if (!name) continue;
    const type = namedChildren(p).filter((c) => c.type !== "simple_identifier" && c.type !== "parameter_modifiers" && c.type !== "attribute").at(-1);
    reader.declare(name.text, kindOfTypeNode(type, file.typeNames));
  }
}

export interface FunctionInput {
  /** The `func` / `init` / property node. */
  node: TSNode;
  cls: TypeScope | null;
  isInit: boolean;
  /** Property-initializer facts this function states for its type (the solver is flow-insensitive, so any member will do). */
  initFacts?: ValueFlowFact[];
}

export function functionFacts(input: FunctionInput, file: FileScope, calls: CallRefs): FunctionFacts | null {
  const reader = new FactReader(file, input.cls, calls);
  declareParams(reader, input.node, file);
  const body = namedChildren(input.node).find((c) => c.type === "function_body" || c.type === "computed_property" || c.type === "willset_didset_block");
  if (body) reader.walk(body);
  if (input.initFacts) reader.facts.push(...input.initFacts);
  return reader.facts.length ? { facts: reader.facts } : null;
}

/** Facts of a type's stored-property initializers (`var handlers = ["save": save]`). */
export function propertyInitFacts(cls: TypeScope, typeNode: TSNode, file: FileScope, calls: CallRefs): ValueFlowFact[] {
  const out: ValueFlowFact[] = [];
  const body = namedChildren(typeNode).find((c) => c.type === "class_body" || c.type === "enum_class_body");
  if (!body) return out;
  for (const m of namedChildren(body)) {
    if (m.type !== "property_declaration") continue;
    const p = propertyOf(m, file.typeNames);
    if (!p || p.computed || !p.value || p.kind === "other") continue;
    const reader = new FactReader(file, cls, calls);
    reader.valueInto({ name: "self", member: p.name }, p.value);
    out.push(...reader.facts);
  }
  return out;
}

/** Facts of a file's top-level properties and assignments. */
export function moduleFacts(root: TSNode, file: FileScope, calls: CallRefs): ValueFlowFact[] {
  const reader = new FactReader(file, null, calls);
  for (const n of namedChildren(root)) {
    if (n.type === "property_declaration") {
      const p = propertyOf(n, file.typeNames);
      if (p && !p.computed && p.value && p.kind !== "other") reader.valueInto({ name: p.name }, p.value);
    }
  }
  return reader.facts;
}
