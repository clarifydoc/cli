/**
 * Dart's value-flow facts (`FunctionInfo.valueFlow`, `FileAnalysis.moduleValueFlow`): how a function value travels
 * through locals, fields, parameters, returns, lists and maps, read off tree-sitter-dart's tree. Only facts are
 * stated here; core's solver (core/value-flow.ts) resolves them.
 *
 * A Dart expression is a primary followed by its selectors as SIBLING nodes (`hs`, `.forEach`, `(…)`), so every
 * reader below works on a run of sibling nodes (`Seq`). What a run holds is stated the way the solver reads it:
 * a function named as written (`seed`), another place (`copy`), a call's result (`result`). A call is named as the
 * reader named it for the call list (`CallRefs`, by its argument list's node id), so a fact meets the `CallInfo`.
 */
import type { TSNode } from "../../../parsers/parser-manager.js";
import type { ValueCell, ValueFlowFact } from "../../../types/analysis.js";

/** The call a node's argument list belongs to, as the call list names it. */
export type CallRefs = Map<number, { name: string; line: number }>;
type Seq = TSNode[];

/** What a class declares that a bare name in its methods can be: fields (and constructor `this.x` parameters) and methods. */
export interface ClassScope {
  name: string;
  fields: Map<string, Kind>;
  methods: Set<string>;
  /** `T` of `extends State<T>` / `ConsumerState<T>`: what `widget` is. */
  stateOf: string | null;
  /** Facts of field initializers (`late final cb = () => save();`), stated by every constructor of the class. */
  initFacts: ValueFlowFact[];
}

/** What a name may hold: a function value (`fn`), a collection, something that is no callable (`other`), unknown (`may`), or a call's result (`call`). */
type Kind = "fn" | "coll" | "other" | "may" | "call" | "named";

const PRIMITIVES = /^(?:int|double|num|String|bool|BigInt|DateTime|Duration|Uri|Object|void|BuildContext|Widget|Key|Color|Text|Icon|Future|Stream|Iterable|List|Map|Set|Type|RegExp|Offset|Size|Rect|Locale|TextStyle|EdgeInsets|Navigator|Exception|Error)\b/;
const FUNCTION_TYPE = /\bFunction\b|(?:Callback|Handler|Listener|Builder|Action|Fn|Func|Predicate|Comparator|Setter|Getter|Validator)(?:<.*)?\??$|^Value(?:Changed|Setter|Getter)\b/;

const namedChildren = (node: TSNode): TSNode[] => {
  const out: TSNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) out.push(node.namedChild(i)!);
  return out;
};

const isSelector = (node: TSNode): boolean =>
  node.type === "selector" || node.type === "unconditional_assignable_selector" || node.type === "conditional_assignable_selector";

/** Sibling nodes cut into runs: a primary and the selectors after it. */
function runsOf(children: readonly TSNode[]): Seq[] {
  const runs: Seq[] = [];
  for (const c of children) {
    if (isSelector(c) && runs.length > 0) runs[runs.length - 1]!.push(c);
    else runs.push([c]);
  }
  return runs;
}

/** `!` after a value (a null assertion). */
const isBang = (n: TSNode): boolean => n.type === "selector" && n.namedChildCount === 0 && n.text === "!";

/** The member a selector reads (`.save`, `?.save`), or null. */
function memberOf(sel: TSNode): string | null {
  const part = sel.type === "selector" ? sel.namedChild(0) : sel;
  if (!part || (part.type !== "unconditional_assignable_selector" && part.type !== "conditional_assignable_selector")) return null;
  const id = part.namedChild(0);
  return id?.type === "identifier" && part.namedChildCount === 1 ? id.text : null;
}

/** The `[index]` a selector reads, or null. */
function indexOf(sel: TSNode): TSNode | null {
  const part = sel.type === "selector" ? sel.namedChild(0) : sel;
  const idx = part?.namedChild(0);
  return idx?.type === "index_selector" ? idx : null;
}

/** The argument list a selector carries (`(…)`), or null. */
function argumentsOf(sel: TSNode): TSNode | null {
  const part = sel.type === "selector" ? sel.namedChild(0) : sel;
  if (part?.type !== "argument_part") return null;
  return namedChildren(part).find((c) => c.type === "arguments") ?? null;
}

/** The text of a plain string literal (no interpolation), or null. */
function literalKey(node: TSNode | undefined): string | null {
  if (!node || node.type !== "string_literal") return null;
  const m = /^[rR]?(['"])([^'"$\\]*)\1$/.exec(node.text);
  return m ? m[2]! : null;
}

function kindOfType(typeText: string, classes: ReadonlySet<string>, typedefs: ReadonlySet<string>): Kind {
  const t = typeText.trim();
  if (!t) return "may";
  const base = t.replace(/[<?].*$/s, "");
  if (typedefs.has(base) || FUNCTION_TYPE.test(t)) return "fn";
  if (/^(?:List|Map|Set|Iterable)\b/.test(t)) return "coll";
  if (PRIMITIVES.test(t) || classes.has(base)) return "other";
  // A stated type nothing here says is a function (a callable object like `GetIt`, or a typedef from another file).
  return "named";
}

/** The type text a declaration's children state before the name (modifiers aside), as written. */
function typeTextBefore(children: readonly TSNode[], text: string, at: number): string {
  const typeNodes = children.slice(0, at).filter((c) => !/^(?:final_builtin|const_builtin|late_builtin|inferred_type|static|covariant|required)/.test(c.type) && c.type !== "annotation");
  if (typeNodes.length === 0) return "";
  return text.slice(typeNodes[0]!.startIndex, typeNodes[typeNodes.length - 1]!.endIndex);
}

/** The kind an initializer's value gives a name. */
function kindOfInit(seq: Seq): Kind {
  const head = seq[0];
  if (!head) return "may";
  if (head.type === "list_literal" || head.type === "set_or_map_literal") return "coll";
  if (head.type === "function_expression") return "fn";
  if (head.type === "const_object_expression" || head.type === "new_expression") return "other";
  if (/literal$/.test(head.type) || head.type === "true" || head.type === "false" || head.type === "null_literal") return "other";
  // `Caller()`: a construction (an upper-case name called); `GetIt.instance`: a static member, no function.
  if (head.type === "identifier" && /^[A-Z]/.test(head.text)) {
    if (seq[1] && argumentsOf(seq[1])) return "other";
    if (seq.length === 2 && memberOf(seq[1]!) !== null) return "other";
  }
  // A lower-case call (`makeHandler()`) may hand a function back; the name is no function itself.
  if (seq.length >= 2 && argumentsOf(seq[seq.length - 1]!)) return "call";
  return "may";
}

export interface FileScope {
  /** Declared class names of the file. */
  classes: Map<string, ClassScope>;
  typedefs: Set<string>;
  /** Top-level variables of the file: module cells. */
  moduleNames: Map<string, Kind>;
  src: string;
}

/** The class's own declarations, read once. */
export function classScopeOf(cls: TSNode, file: { classes: ReadonlySet<string>; typedefs: ReadonlySet<string>; src: string }): ClassScope {
  const nameNode = cls.childForFieldName("name") ?? namedChildren(cls).find((c) => c.type === "identifier");
  const scope: ClassScope = { name: nameNode?.text ?? "", fields: new Map(), methods: new Set(), stateOf: null, initFacts: [] };
  const superclass = namedChildren(cls).find((c) => c.type === "superclass");
  if (superclass) {
    const type = namedChildren(superclass).find((c) => c.type === "type_identifier");
    const arg = namedChildren(superclass).find((c) => c.type === "type_arguments")?.namedChild(0);
    if (type && /^(?:Consumer)?State$/.test(type.text) && arg) scope.stateOf = arg.text.replace(/<.*$/s, "");
  }
  const body = namedChildren(cls).find((c) => c.type === "class_body");
  if (!body) return scope;
  for (const member of namedChildren(body)) {
    if (member.type === "method_signature") {
      const sig = namedChildren(member).find((c) => c.type === "function_signature");
      const id = sig?.childForFieldName("name");
      if (id) scope.methods.add(id.text);
      continue;
    }
    if (member.type !== "declaration") continue;
    const kids = namedChildren(member);
    const ctor = kids.find((c) => c.type === "constructor_signature" || c.type === "constant_constructor_signature" || c.type === "factory_constructor_signature");
    if (ctor) {
      for (const p of descendants(ctor, "constructor_param")) {
        const id = namedChildren(p).find((c) => c.type === "identifier");
        if (id && !scope.fields.has(id.text)) scope.fields.set(id.text, "may");
      }
      continue;
    }
    const list = kids.find((c) => c.type === "initialized_identifier_list" || c.type === "static_final_declaration_list");
    if (!list) {
      const fn = kids.find((c) => c.type === "function_signature");
      const id = fn?.childForFieldName("name");
      if (id) scope.methods.add(id.text);
      continue;
    }
    const typeText = typeTextBefore(kids, file.src, kids.indexOf(list));
    for (const item of namedChildren(list)) {
      const id = namedChildren(item).find((c) => c.type === "identifier");
      if (!id) continue;
      const value = namedChildren(item).slice(namedChildren(item).indexOf(id) + 1);
      const kind = typeText ? kindOfType(typeText, file.classes, file.typedefs) : kindOfInit(value);
      scope.fields.set(id.text, kind === "other" && value.length > 0 && kindOfInit(value) !== "other" ? "may" : kind);
    }
  }
  return scope;
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

/** What the facts of one function need to know. */
interface FunctionInput {
  /** The signature node (parameters). */
  sig: TSNode;
  /** The declaration around it (initializer list). */
  decl: TSNode;
  body: TSNode | null;
  cls: ClassScope | null;
  isConstructor: boolean;
  /** Field-initializer facts this function states for its class (the solver is flow-insensitive, so any member will do). */
  initFacts?: ValueFlowFact[];
}

export interface FunctionFacts {
  facts: ValueFlowFact[];
}

/** Whether a lower-case name could be a function a tear-off names. */
const TEAR_OFF = /^[a-z_$][\w$]*$/;
const NOT_VALUES = new Set(["null", "true", "false", "this", "super", "await", "async", "yield", "void", "var", "final", "const"]);

const SCOPES: ReadonlySet<string> = new Set(["block", "for_statement", "function_expression"]);

class FactReader {
  readonly facts: ValueFlowFact[] = [];
  /** Names in scope, innermost last: a local is visible in its own block and the blocks inside it. */
  private readonly scopes: Array<Map<string, Kind>> = [new Map()];
  private closureDepth = 0;
  private temps = 0;

  constructor(private readonly file: FileScope, private readonly cls: ClassScope | null, private readonly calls: CallRefs) {}

  // ── Scope ──────────────────────────────────────────────────────────────────
  declare(name: string, kind: Kind): void {
    this.scopes[this.scopes.length - 1]!.set(name, kind);
  }

  /** The kind of a name that is a local, a parameter, a field or a module variable; null when it is none. */
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
    return k.where === "field" ? { name: "this", member: name } : { name };
  }

  private line(node: TSNode): number {
    return node.startPosition.row + 1;
  }

  private temp(node: TSNode): ValueCell {
    return { name: `$v${node.startIndex}_${this.temps++}` };
  }

  // ── Collections ────────────────────────────────────────────────────────────
  /** The cell of an element of `name`: a literal key's, else the collection's `[]`. */
  private elementCell(name: string, key: string | null): ValueCell | null {
    const k = this.kindOf(name);
    if (!k) return null;
    if (k.where === "field") return { name: "this", member: key === null ? `${name}[]` : `${name}[${key}]` };
    return { name, member: key === null ? "[]" : key };
  }

  private elementKey(index: TSNode): string | null {
    const inner = namedChildren(index);
    return inner.length === 1 ? literalKey(inner[0]) : null;
  }

  // ── Values ─────────────────────────────────────────────────────────────────
  /** A value into `dest`: what the run names, held, passed or returned. */
  valueInto(dest: ValueCell, seq0: Seq, at: TSNode): void {
    const seq = seq0.filter((n) => !isBang(n));
    const head = seq[0];
    if (!head) return;
    if (seq.length === 1) {
      switch (head.type) {
        case "identifier": return this.identInto(dest, head);
        case "function_expression": return this.closureInto(dest, head);
        case "list_literal":
        case "set_or_map_literal": return this.collectionInto(dest, head);
        case "parenthesized_expression": return this.valueInto(dest, runsOf(namedChildren(head)).at(0) ?? [], at);
        case "conditional_expression": {
          const kids = namedChildren(head);
          for (const run of runsOf(kids.slice(1))) this.valueInto(dest, run, at);
          return;
        }
        case "if_null_expression": {
          for (const run of runsOf(namedChildren(head))) this.valueInto(dest, run, at);
          return;
        }
        default: return;
      }
    }
    const rest = seq.slice(1);
    const last = rest[rest.length - 1]!;
    const args = argumentsOf(last);
    if (args) {
      const ref = this.calls.get(args.id);
      // A plain construction (`Padding(…)`) binds no instance the solver follows.
      if (ref && !/^[A-Z][\w$]*$/.test(ref.name)) this.facts.push({ kind: "result", call: ref.name, line: ref.line, to: dest });
      return;
    }
    const members = rest.map(memberOf);
    if (members.every((m) => m !== null) && members.length === 1) return this.pathInto(dest, head, members[0]!);
    // `table['save']` / `list[0]`: an element.
    const index = rest.length === 1 ? indexOf(rest[0]!) : null;
    if (index && head.type === "identifier") {
      const cell = this.elementCell(head.text, this.elementKey(index));
      if (cell) this.facts.push({ kind: "copy", from: cell, to: dest, line: this.line(at) });
    }
  }

  private identInto(dest: ValueCell, id: TSNode): void {
    const name = id.text;
    const cell = this.cellOfName(name);
    if (cell) {
      const kind = this.kindOf(name)!.kind;
      if (kind !== "other") this.facts.push({ kind: "copy", from: cell, to: dest, line: this.line(id) });
      return;
    }
    if (TEAR_OFF.test(name) && !NOT_VALUES.has(name)) this.facts.push({ kind: "seed", to: dest, fn: name, line: this.line(id) });
  }

  private pathInto(dest: ValueCell, head: TSNode, member: string): void {
    const line = this.line(head);
    if (head.type === "this") {
      const field = this.cls?.fields.get(member);
      if (field !== undefined && !this.cls!.methods.has(member)) {
        if (field !== "other") this.facts.push({ kind: "copy", from: { name: "this", member }, to: dest, line });
      } else if (this.cls) this.facts.push({ kind: "seed", to: dest, fn: `this.${member}`, line });
      return;
    }
    if (head.type !== "identifier") return;
    const name = head.text;
    if (name === "widget" && this.cls?.stateOf && !this.local("widget")) {
      // The widget class's field (a bool or a string is no function; a field of a class declared elsewhere may be).
      if (this.file.classes.get(this.cls.stateOf)?.fields.get(member) !== "other") this.facts.push({ kind: "copy", from: { name: "widget", member, field: true }, to: dest, line });
      return;
    }
    const k = this.kindOf(name);
    if (k) {
      if (k.where === "local" && k.kind !== "other") this.facts.push({ kind: "copy", from: { name, member }, to: dest, line });
      return;
    }
    // `Club.save`: a static method through its class.
    if (/^[A-Z]/.test(name)) this.facts.push({ kind: "seed", to: dest, fn: `${name}.${member}`, line });
  }

  /** `() => save(ctx)` holds `save`; `() => onDone()` what `onDone` holds. A body doing more states nothing. */
  private closureInto(dest: ValueCell, fe: TSNode): void {
    const params = new Set<string>();
    for (const p of descendants(namedChildren(fe).find((c) => c.type === "formal_parameter_list") ?? fe, "formal_parameter")) {
      const ids = namedChildren(p).filter((c) => c.type === "identifier");
      if (ids.length) params.add(ids[ids.length - 1]!.text);
    }
    const body = namedChildren(fe).find((c) => c.type === "function_expression_body");
    if (!body) return;
    let kids = namedChildren(body);
    if (kids.length === 1 && kids[0]!.type === "block") {
      const statements = namedChildren(kids[0]!);
      if (statements.length !== 1 || statements[0]!.type !== "expression_statement") return;
      kids = namedChildren(statements[0]!);
    }
    const runs = runsOf(kids);
    if (runs.length !== 1) return;
    const run = runs[0]!.filter((n) => !isBang(n));
    const call = run[run.length - 1];
    if (!call || run.length < 2 || !argumentsOf(call)) return;
    const callee = run.slice(0, -1);
    const head = callee[0]!;
    if (head.type === "identifier" && params.has(head.text)) return;
    if (callee.length === 1) {
      if (head.type === "identifier" && !this.isLocalFunction(head.text)) this.identInto(dest, head);
      return;
    }
    const member = callee.length === 2 ? memberOf(callee[1]!) : null;
    if (member) this.pathInto(dest, head, member);
  }

  private isLocalFunction(_name: string): boolean {
    return false;
  }

  private collectionInto(dest: ValueCell, lit: TSNode): void {
    // The literal binds the name (a collection local or module variable) — a self-copy is the binder.
    if (dest.member === undefined) this.facts.push({ kind: "copy", from: dest, to: dest, line: this.line(lit) });
    const element = (key: string | null): ValueCell => this.collectionElement(dest, key);
    if (lit.type === "list_literal" || !namedChildren(lit).some((c) => c.type === "pair")) {
      for (const run of runsOf(namedChildren(lit).filter((c) => c.type !== "type_arguments"))) this.valueInto(element(null), run, lit);
      return;
    }
    for (const pair of namedChildren(lit).filter((c) => c.type === "pair")) {
      const kids = namedChildren(pair);
      if (kids.length < 2) continue;
      const value = kids.slice(1);
      const key = literalKey(kids[0]);
      this.valueInto(element(null), value, pair);
      if (key !== null) this.valueInto(element(key), value, pair);
    }
  }

  /** The element cell of a collection held by `dest` (a name, or a field's `this.x`). */
  private collectionElement(dest: ValueCell, key: string | null): ValueCell {
    if (dest.name === "this" && dest.member !== undefined) return { name: "this", member: key === null ? `${dest.member}[]` : `${dest.member}[${key}]` };
    return { name: dest.name, member: key === null ? "[]" : key };
  }

  /** A value as a cell: the place it already is, or a temporary the facts fill. */
  private cellOfValue(seq0: Seq, at: TSNode): ValueCell | null {
    const seq = seq0.filter((n) => !isBang(n));
    const head = seq[0];
    if (!head) return null;
    if (seq.length === 1 && head.type === "identifier") {
      const k = this.kindOf(head.text);
      if (k) return k.kind === "other" ? null : this.cellOfName(head.text);
    }
    if (seq.length === 1 && /literal$|^(?:true|false|this|string_literal)$/.test(head.type) && head.type !== "list_literal" && head.type !== "set_or_map_literal") return null;
    const t = this.temp(at);
    const before = this.facts.length;
    this.valueInto(t, seq, at);
    return this.facts.length > before ? t : null;
  }

  // ── Statements ─────────────────────────────────────────────────────────────
  /** The destination an assignment's left side names. */
  private destOf(lhs: TSNode): ValueCell | null {
    const kids = namedChildren(lhs);
    const head = kids[0];
    if (!head) return null;
    const rest = kids.slice(1).filter((k) => !isBang(k));
    if (rest.length === 0) return head.type === "identifier" ? this.cellOfName(head.text) : null;
    if (rest.length !== 1) return null;
    const member = memberOf(rest[0]!);
    if (member !== null) {
      if (head.type === "this") return this.cls?.fields.has(member) ? { name: "this", member } : null;
      if (head.type === "identifier") {
        const k = this.kindOf(head.text);
        return k && k.where === "local" ? { name: head.text, member } : null;
      }
      return null;
    }
    const index = indexOf(rest[0]!);
    if (index && head.type === "identifier") return this.elementCell(head.text, this.elementKey(index));
    return null;
  }

  private declaration(node: TSNode): void {
    const kids = namedChildren(node);
    const at = kids.findIndex((c) => c.type === "identifier");
    if (at < 0) return;
    const name = kids[at]!.text;
    const value = kids.slice(at + 1);
    const typeText = typeTextBefore(kids, this.file.src, at);
    const kind = typeText ? kindOfType(typeText, new Set(this.file.classes.keys()), this.file.typedefs) : value.length ? kindOfInit(value) : "may";
    this.declare(name, kind === "other" && value.length && kindOfInit(value) === "may" && !typeText ? "may" : kind);
    if (value.length === 0 || kind === "other") return;
    const dest = { name };
    for (const run of runsOf(value)) this.valueInto(dest, run, node);
  }

  /** Every node of a body, closures included, a nested function declaration excluded (its own span has its own facts). */
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
      case "local_function_declaration": return;
      case "initialized_variable_definition": this.declaration(node); break;
      case "assignment_expression": {
        const kids = namedChildren(node);
        const lhs = kids[0];
        if (lhs?.type === "assignable_expression") {
          const dest = this.destOf(lhs);
          if (dest) for (const run of runsOf(kids.slice(1))) this.valueInto(dest, run, node);
        }
        break;
      }
      case "return_statement": {
        if (this.closureDepth > 0) break;
        for (const run of runsOf(namedChildren(node))) {
          const cell = this.cellOfValue(run, node);
          if (cell) this.facts.push({ kind: "return", from: cell, line: this.line(node) });
        }
        break;
      }
      case "for_loop_parts": this.forIn(node); break;
      case "function_expression": {
        this.closureDepth++;
        for (const child of namedChildren(node)) this.visit(child);
        this.closureDepth--;
        return;
      }
      default: break;
    }
    // Runs among this node's children: calls, element adds, `forEach`.
    const kids = namedChildren(node);
    if (kids.some(isSelector)) for (const run of runsOf(kids)) this.run(run);
    else if (node.type === "const_object_expression" || node.type === "new_expression") this.constructorArgs(node);
    for (const child of kids) this.visit(child);
  }

  private forIn(parts: TSNode): void {
    if (parts.type !== "for_loop_parts" || namedChildren(parts).some((c) => c.type === "local_variable_declaration")) return;
    const kids = namedChildren(parts);
    const at = kids.findIndex((c) => c.type === "identifier");
    if (at < 0 || !/\bin\b/.test(this.file.src.slice(kids[at]!.endIndex, kids[at + 1]?.startIndex ?? kids[at]!.endIndex))) return;
    this.declare(kids[at]!.text, "may");
    this.iterate(kids.slice(at + 1), { name: kids[at]!.text }, parts);
  }

  /** `item` receives the elements of the iterable `seq`. */
  private iterate(seq: Seq, item: ValueCell, at: TSNode): void {
    const run = runsOf(seq)[0] ?? [];
    const head = run[0];
    if (head?.type === "list_literal" && run.length === 1) {
      for (const r of runsOf(namedChildren(head).filter((c) => c.type !== "type_arguments"))) this.valueInto(item, r, at);
      return;
    }
    if (!head || head.type !== "identifier") return;
    const tail = run.slice(1);
    if (tail.length > 1 || (tail.length === 1 && memberOf(tail[0]!) !== "values")) return;
    const cell = this.elementCell(head.text, null);
    if (cell) this.facts.push({ kind: "copy", from: cell, to: item, line: this.line(at) });
  }

  /** One run: its calls' arguments and results, the invocations among them, `add` and `forEach` on a collection. */
  private run(run: Seq): void {
    const head = run[0]!;
    for (let i = 1; i < run.length; i++) {
      const args = argumentsOf(run[i]!);
      if (!args) continue;
      const callee = run.slice(0, i).filter((n) => !isBang(n));
      this.callArguments(args);
      this.invocation(callee, args);
      this.collectionCall(callee, args);
    }
    void head;
  }

  /** `Btn(onPressed: save)` as `const Btn(…)` / `new Btn(…)`: the arguments of the construction. */
  private constructorArgs(node: TSNode): void {
    const args = namedChildren(node).find((c) => c.type === "arguments");
    if (args) this.callArguments(args);
  }

  private callArguments(args: TSNode): void {
    const ref = this.calls.get(args.id);
    if (!ref) return;
    let index = 0;
    for (const arg of namedChildren(args)) {
      if (arg.type === "argument") {
        const cell = this.argumentCell(namedChildren(arg), arg);
        if (cell) this.facts.push({ kind: "arg", call: ref.name, line: ref.line, index, from: cell });
        index++;
      } else if (arg.type === "named_argument") {
        const kids = namedChildren(arg);
        const label = kids[0]?.type === "label" ? kids[0].text.replace(/:$/, "").trim() : null;
        if (!label) continue;
        const cell = this.argumentCell(kids.slice(1), arg);
        if (cell) this.facts.push({ kind: "arg", call: ref.name, line: ref.line, index: -1, name: label, from: cell });
      }
    }
  }

  private argumentCell(kids: TSNode[], at: TSNode): ValueCell | null {
    const runs = runsOf(kids);
    return runs.length === 1 ? this.cellOfValue(runs[0]!, at) : null;
  }

  /** Whether `x.call()` / `x()` on this name runs a held function. */
  private invocation(callee: Seq, args: TSNode): void {
    const ref = this.calls.get(args.id);
    if (!ref) return;
    const head = callee[0]!;
    const invoke = (cell: ValueCell): void => {
      this.facts.push({ kind: "invoke", cell, call: ref.name, line: ref.line });
    };
    const heldBy = (name: string, forCall: boolean): ValueCell | null => {
      const k = this.kindOf(name);
      if (!k || k.kind === "other") return null;
      // A callable object (`final getIt = createLocator(); getIt<Repo>()`) is no function: a call's result holds one
      // only as a local, never as a module variable or field.
      if (k.kind === "call" && k.where !== "local") return null;
      if (k.kind === "named") return null;
      // `x.call()` is a call on a function only where x says it is one; a class's own `call` method is its own.
      if (forCall && k.kind === "may" && k.where === "field") return null;
      return this.cellOfName(name);
    };
    if (callee.length === 1 && head.type === "identifier") {
      const cell = heldBy(head.text, false);
      if (cell) invoke(cell);
      return;
    }
    if (callee.length === 2 && head.type === "identifier") {
      const member = memberOf(callee[1]!);
      if (member === "call") {
        const cell = heldBy(head.text, true);
        if (cell) invoke(cell);
        return;
      }
      // `widget.onPressed()`: a field the widget class declares in this file (a method of it is an ordinary call).
      if (member && head.text === "widget" && this.cls?.stateOf && !this.local("widget")) {
        const owner = this.file.classes.get(this.cls.stateOf);
        const field = owner?.fields.get(member);
        if (owner && field && field !== "other" && field !== "named" && !owner.methods.has(member)) {
          invoke({ name: "widget", member, field: true });
        }
      }
      if (member) return;
    }
    if (callee.length === 2 && head.type === "this") {
      const member = memberOf(callee[1]!);
      const field = member ? this.cls?.fields.get(member) : undefined;
      if (member && field && field !== "other" && field !== "named" && !this.cls!.methods.has(member)) invoke({ name: "this", member });
      return;
    }
    // `handlers['save']!()`, `hs[0]()`: an element of a collection.
    if (head.type === "identifier" && callee.length === 2) {
      const index = indexOf(callee[1]!);
      const cell = index ? this.elementCell(head.text, this.elementKey(index)) : null;
      if (cell) invoke(cell);
    }
  }

  /** `hs.add(f)` stores into the collection; `hs.forEach((h) => …)` hands each element to the closure's parameter. */
  private collectionCall(callee: Seq, args: TSNode): void {
    const head = callee[0]!;
    if (head.type !== "identifier" || callee.length !== 2) return;
    const member = memberOf(callee[1]!);
    const kind = this.kindOf(head.text)?.kind;
    if (!member || !kind || kind === "other") return;
    const first = namedChildren(args)[0];
    if (member === "add" && first?.type === "argument") {
      const cell = this.elementCell(head.text, null);
      if (cell) for (const run of runsOf(namedChildren(first))) this.valueInto(cell, run, first);
    } else if (member === "forEach" && first?.type === "argument") {
      const fe = namedChildren(first)[0];
      if (fe?.type !== "function_expression") return;
      const params = descendants(namedChildren(fe).find((c) => c.type === "formal_parameter_list") ?? fe, "formal_parameter")
        .map((p) => namedChildren(p).filter((c) => c.type === "identifier").at(-1)?.text)
        .filter((n): n is string => !!n);
      const item = params.at(-1);
      if (!item) return;
      this.declare(item, "may");
      const cell = this.elementCell(head.text, null);
      if (cell) this.facts.push({ kind: "copy", from: cell, to: { name: item }, line: this.line(fe) });
    }
  }
}

/** The names a signature's parameters bind, with what their declared type says. */
function declareParams(reader: FactReader, sig: TSNode, file: FileScope): void {
  const classes = new Set(file.classes.keys());
  for (const p of descendants(sig, "formal_parameter")) {
    const kids = namedChildren(p);
    const ctor = kids.find((c) => c.type === "constructor_param");
    const idNode = ctor ? namedChildren(ctor).filter((c) => c.type === "identifier").at(-1) : kids.filter((c) => c.type === "identifier").at(-1);
    if (!idNode) continue;
    const at = kids.indexOf(idNode);
    const typeText = ctor ? "" : typeTextBefore(kids, file.src, at < 0 ? kids.length : at);
    reader.declare(idNode.text, typeText ? kindOfType(typeText, classes, file.typedefs) : "may");
  }
}

/** The facts of one function (or constructor), or null when it states none. */
export function functionFacts(input: FunctionInput, file: FileScope, calls: CallRefs): FunctionFacts | null {
  const reader = new FactReader(file, input.cls, calls);
  declareParams(reader, input.sig, file);
  if (input.isConstructor && input.cls) {
    // `Btn(this.onPressed)` and `: _cb = cb`: the formal is the field's.
    for (const p of descendants(input.sig, "constructor_param")) {
      const id = namedChildren(p).filter((c) => c.type === "identifier").at(-1);
      if (id && input.cls.fields.has(id.text) && input.cls.fields.get(id.text) !== "other") {
        reader.facts.push({ kind: "copy", from: { name: id.text }, to: { name: "this", member: id.text }, line: id.startPosition.row + 1 });
      }
    }
    for (const entry of descendants(input.decl, "field_initializer")) {
      const kids = namedChildren(entry);
      const field = kids[0];
      if (field?.type !== "identifier") continue;
      for (const run of runsOf(kids.slice(1))) reader.valueInto({ name: "this", member: field.text }, run, entry);
    }
  }
  if (input.initFacts) reader.facts.push(...input.initFacts);
  if (input.body) {
    const kids = namedChildren(input.body);
    if (kids.length === 1 && kids[0]!.type === "block") reader.walk(kids[0]!);
    else {
      // `=> value`: the expression is what the function returns.
      for (const run of runsOf(kids)) {
        const cell = reader["cellOfValue"](run, input.body);
        if (cell) reader.facts.push({ kind: "return", from: cell, line: input.body.startPosition.row + 1 });
      }
      for (const run of runsOf(kids)) reader["run"](run);
      for (const child of kids) reader["visit"](child);
    }
  }
  return reader.facts.length ? { facts: reader.facts } : null;
}

/** Facts of a class field's initializer (`late final cb = () => save();`), stated by the class's constructors. */
export function fieldInitFacts(cls: ClassScope, classNode: TSNode, file: FileScope, calls: CallRefs): ValueFlowFact[] {
  const out: ValueFlowFact[] = [];
  const body = namedChildren(classNode).find((c) => c.type === "class_body");
  if (!body) return out;
  for (const member of namedChildren(body)) {
    if (member.type !== "declaration") continue;
    const kids = namedChildren(member);
    const list = kids.find((c) => c.type === "initialized_identifier_list" || c.type === "static_final_declaration_list");
    if (!list) continue;
    for (const item of namedChildren(list)) {
      const parts = namedChildren(item);
      const id = parts.find((c) => c.type === "identifier");
      const value = id ? parts.slice(parts.indexOf(id) + 1) : [];
      if (!id || value.length === 0 || cls.fields.get(id.text) === "other") continue;
      const reader = new FactReader(file, cls, calls);
      for (const run of runsOf(value)) reader.valueInto({ name: "this", member: id.text }, run, item);
      out.push(...reader.facts);
    }
  }
  return out;
}

/** Facts of the file's top-level variables. */
export function moduleFacts(root: TSNode, file: FileScope, calls: CallRefs): ValueFlowFact[] {
  const reader = new FactReader(file, null, calls);
  const stack = namedChildren(root).reverse();
  while (stack.length) {
    const n = stack.pop()!;
    if (n.type === "static_final_declaration" || n.type === "initialized_identifier") {
      const parts = namedChildren(n);
      const id = parts.find((c) => c.type === "identifier");
      const value = id ? parts.slice(parts.indexOf(id) + 1) : [];
      if (id && value.length && file.moduleNames.get(id.text) !== "other") for (const run of runsOf(value)) reader.valueInto({ name: id.text }, run, n);
    } else if (n.type === "initialized_variable_definition") {
      const parts = namedChildren(n);
      const id = parts.find((c) => c.type === "identifier");
      const value = id ? parts.slice(parts.indexOf(id) + 1) : [];
      if (id && value.length && file.moduleNames.get(id.text) !== "other") for (const run of runsOf(value)) reader.valueInto({ name: id.text }, run, n);
    } else if (n.type === "static_final_declaration_list" || n.type === "initialized_identifier_list" || n.type === "local_variable_declaration") {
      for (const c of namedChildren(n).reverse()) stack.push(c);
    }
  }
  return reader.facts;
}

/** The file-level names: classes, typedefs and top-level variables with what their declarations say. */
export function fileScopeOf(root: TSNode, src: string): FileScope {
  const classes = new Map<string, ClassScope>();
  const typedefs = new Set<string>();
  const moduleNames = new Map<string, Kind>();
  const classNames = new Set<string>();
  const nodes = namedChildren(root);
  for (const n of nodes) {
    if (n.type === "type_alias") {
      const id = namedChildren(n).find((c) => c.type === "type_identifier");
      if (id) typedefs.add(id.text);
    }
    if (n.type === "class_definition" || n.type === "mixin_declaration") {
      const id = n.childForFieldName("name") ?? namedChildren(n).find((c) => c.type === "identifier");
      if (id) classNames.add(id.text);
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.type === "static_final_declaration_list" || n.type === "initialized_identifier_list") {
      // `final VoidCallback hook = save;` — the type nodes sit before the list among the program's children.
      let j = i - 1;
      while (j >= 0 && ["final_builtin", "const_builtin", "late_builtin", "inferred_type", "type_identifier", "function_type", "nullable_type", "type_arguments"].includes(nodes[j]!.type)) j--;
      const typeNodes = nodes.slice(j + 1, i).filter((t) => !/builtin$|inferred_type/.test(t.type));
      const typeText = typeNodes.length ? src.slice(typeNodes[0]!.startIndex, typeNodes[typeNodes.length - 1]!.endIndex) : "";
      for (const item of namedChildren(n)) {
        const parts = namedChildren(item);
        const id = parts.find((c) => c.type === "identifier");
        if (!id) continue;
        const value = parts.slice(parts.indexOf(id) + 1);
        moduleNames.set(id.text, typeText ? kindOfType(typeText, classNames, typedefs) : value.length ? kindOfInit(value) : "may");
      }
    }
  }
  for (const n of nodes) {
    if (n.type !== "class_definition" && n.type !== "mixin_declaration") continue;
    const scope = classScopeOf(n, { classes: classNames, typedefs, src });
    if (scope.name) classes.set(scope.name, scope);
  }
  return { classes, typedefs, moduleNames, src };
}
