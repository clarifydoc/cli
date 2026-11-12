/**
 * Callable value-flow facts for Python (read by core's solver, `core/value-flow.ts`): how a function value
 * travels through locals, parameters, `self` fields, containers and returns to the call that runs it.
 *
 * The plugin only states steps, never resolves them: a `seed` names a function as written, `copy` moves what a
 * cell holds, `arg`/`result`/`return` cross a call boundary by written index, and `invoke` marks a call that runs
 * a held value. A list, set, tuple or dict is one cell with its elements (`handlers.append(f)`, `for cb in
 * handlers: cb()`), a dict also keeps a literal key as its own cell (`ACTIONS["save"]`), because `self.x[…]`
 * would need two member levels, which the fact schema does not have.
 */
import type { Node } from "web-tree-sitter";
import type { ParamInfo, ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { PY_BUILTIN_CALLS } from "./di.js";
import { isStandardModule } from "./standard-library.js";
import { pythonManifest } from "./manifest.js";

type Fact = ValueFlowFact;

/** What a function body is read against. */
export interface FlowScope {
  /** Names the scope binds itself: parameters, assignment/loop/`with` targets (module names at module level). */
  locals: ReadonlySet<string>;
  /** The parameters alone (an argument that is a plain local is stated only when something can have put a function there). */
  params: ReadonlySet<string>;
  /** Names the enclosing functions of a nested `def` bind (a closure reads them). */
  enclosing: ReadonlySet<string>;
  /** Names a nested `def` of the body mentions: what a closure reads is a sink of this body's facts. */
  captured: ReadonlySet<string>;
  /** The receiver parameter of a method (`self`, `cls`), or null. */
  selfName: string | null;
  /** `self.<name>` attributes the class assigns that are no method: calling one runs a held value. */
  heldFields: ReadonlySet<string>;
  /** Module-level names whose value the module's own statements state (a bare call of one runs a held value). */
  moduleHeld: ReadonlySet<string>;
  /** Names a `global` statement makes the module's: facts about them belong to the module. */
  globals: ReadonlySet<string>;
  /** The framework hands the parameters in (pytest fixtures): a call of one is the injected callable, never a held value. */
  injected: boolean;
  /** Module-level code: no parameters, no receiver. */
  atModule: boolean;
  /** Names the file's imports bind from the standard library or a known external package (`json`, `dumps`): library calls, never project functions. */
  externalImports?: ReadonlySet<string>;
}

const SCOPE_TYPES = new Set(["function_definition", "class_definition"]);
/** Methods that put their argument into the container they are called on. */
const ADDERS = new Set(["append", "add", "appendleft", "insert", "push", "put"]);
/** Methods whose result is an element of the container they are called on. */
const READERS = new Set(["get", "pop", "popleft", "setdefault"]);

const pos = (n: Node): number => n.startPosition.row + 1;

/** The call's name exactly as `extractCalls` spells it: a bare name or an attribute chain, else null. */
function callNameOf(call: Node): string | null {
  const callee = call.childForFieldName("function") ?? call.child(0);
  if (!callee) return null;
  return callee.type === "identifier" || callee.type === "attribute" ? callee.text : null;
}

function unwrap(node: Node | null | undefined): Node | null {
  let n = node ?? null;
  while (n && (n.type === "parenthesized_expression" || n.type === "await")) n = n.namedChild(0);
  return n;
}

/** Names a binding target (identifier, tuple/list pattern) binds. */
function targetNames(target: Node | null | undefined, into: Set<string>): void {
  if (!target) return;
  switch (target.type) {
    // `_` is the throwaway name, and the conventional gettext alias: never a value anyone follows.
    case "identifier": if (target.text !== "_") into.add(target.text); break;
    case "pattern_list": case "tuple_pattern": case "list_pattern": case "tuple": case "list":
      for (const c of target.namedChildren) targetNames(c, into);
      break;
    case "list_splat_pattern": case "list_splat": targetNames(target.namedChild(0), into); break;
    default: break;
  }
}

/** Walk `node`'s body without entering a nested `def` or class. */
function eachNode(node: Node, visit: (n: Node) => void): void {
  for (const child of node.namedChildren) {
    if (SCOPE_TYPES.has(child.type)) continue;
    visit(child);
    eachNode(child, visit);
  }
}

/** The names a function body binds, and the ones it declares `global` or `nonlocal`. */
export function boundNamesOf(body: Node | null, params: readonly ParamInfo[]): { locals: Set<string>; globals: Set<string>; nonlocals: Set<string> } {
  const locals = new Set<string>();
  const globals = new Set<string>();
  const nonlocals = new Set<string>();
  for (const p of params) locals.add(p.name.replace(/^\*+/, ""));
  if (body) {
    eachNode(body, (n) => {
      switch (n.type) {
        case "assignment": case "augmented_assignment": targetNames(n.childForFieldName("left"), locals); break;
        case "for_statement": case "for_in_clause": targetNames(n.childForFieldName("left"), locals); break;
        case "named_expression": targetNames(n.childForFieldName("name"), locals); break;
        case "as_pattern": targetNames(n.childForFieldName("alias"), locals); break;
        case "global_statement": for (const c of n.namedChildren) globals.add(c.text); break;
        case "nonlocal_statement": for (const c of n.namedChildren) nonlocals.add(c.text); break;
        default: break;
      }
    });
  }
  for (const g of globals) locals.delete(g);
  for (const g of nonlocals) locals.delete(g);
  return { locals, globals, nonlocals };
}

/** What the module's own statements bind: names assigned at module level, never defs, classes or imports. */
export function moduleAssignedNames(root: Node): Set<string> {
  const names = new Set<string>();
  const defined = new Set<string>();
  const visit = (node: Node): void => {
    for (const c of node.namedChildren) {
      if (c.type === "function_definition" || c.type === "class_definition") { const n = c.childForFieldName("name"); if (n) defined.add(n.text); continue; }
      if (c.type === "decorated_definition") { const n = c.namedChildren.find((x) => SCOPE_TYPES.has(x.type))?.childForFieldName("name"); if (n) defined.add(n.text); continue; }
      if (c.type === "import_statement" || c.type === "import_from_statement") {
        for (const spec of c.namedChildren) {
          const bound = spec.type === "aliased_import" ? spec.childForFieldName("alias") : spec.type === "dotted_name" ? spec : null;
          if (bound) defined.add(bound.text.split(".")[0]!);
        }
        continue;
      }
      if (c.type === "assignment" || c.type === "augmented_assignment") targetNames(c.childForFieldName("left"), names);
      else if (c.type === "for_statement") targetNames(c.childForFieldName("left"), names);
      else if (c.type === "expression_statement") {
        const inner = c.namedChild(0);
        if (inner && (inner.type === "assignment" || inner.type === "augmented_assignment")) targetNames(inner.childForFieldName("left"), names);
      }
      if (c.type !== "expression_statement") visit(c);
    }
  };
  visit(root);
  for (const d of defined) names.delete(d);
  return names;
}

const EXTERNAL_TOPS = new Set(pythonManifest.externalModulePrefixes ?? []);

/**
 * Names the file's non-relative imports bind from the standard library or the manifest's external prefixes.
 * A project module that shadows a standard name (a local `json.py`) is treated as external here too: the
 * worst case is a missed seed, never a wrong link.
 */
export function externalImportNames(root: Node): Set<string> {
  const out = new Set<string>();
  const external = (top: string): boolean => isStandardModule(top) || EXTERNAL_TOPS.has(top);
  eachNode(root, (c) => {
    if (c.type === "import_statement") {
      for (const spec of c.namedChildren) {
        const dotted = spec.type === "aliased_import" ? spec.childForFieldName("name") : spec.type === "dotted_name" ? spec : null;
        const bound = spec.type === "aliased_import" ? spec.childForFieldName("alias") : dotted;
        if (dotted && bound && external(dotted.text.split(".")[0]!)) out.add(bound.text.split(".")[0]!);
      }
    } else if (c.type === "import_from_statement") {
      const mod = c.childForFieldName("module_name");
      if (!mod || mod.type !== "dotted_name" || !external(mod.text.split(".")[0]!)) return;
      for (const spec of c.namedChildren) {
        if (spec === mod) continue;
        const bound = spec.type === "aliased_import" ? spec.childForFieldName("alias") : spec.type === "dotted_name" ? spec : null;
        if (bound) out.add(bound.text);
      }
    }
  });
  return out;
}

/** `self.<name>` attributes a class's methods assign (`self.cb = cb`, `self.cb: Callable = cb`). */
export function selfAssignedAttributes(methods: ReadonlyArray<{ body: Node | null; selfName: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const m of methods) {
    if (!m.body || !m.selfName) continue;
    eachNode(m.body, (n) => {
      if (n.type !== "assignment") return;
      let cur: Node | null = n;
      while (cur && cur.type === "assignment") {
        const left = cur.childForFieldName("left");
        if (left?.type === "attribute" && left.childForFieldName("object")?.text === m.selfName) out.add(left.childForFieldName("attribute")!.text);
        cur = cur.childForFieldName("right");
      }
    });
  }
  return out;
}

/** The facts of one body (a function's, or the module's statements) read against `scope`. */
export function pythonValueFlow(body: Node, scope: FlowScope): Fact[] {
  const facts: Fact[] = [];
  const shadowed: Set<string>[] = [];
  let synthetic = 0;

  const isShadowed = (name: string): boolean => shadowed.some((s) => s.has(name));
  const isReceiver = (name: string): boolean => scope.selfName !== null && name === scope.selfName;
  const isLocal = (name: string): boolean => scope.locals.has(name) || scope.enclosing.has(name);
  const fresh = (kind: string, line: number): ValueCell => ({ name: `<${kind}:${line}:${synthetic++}>` });
  const cellName = (name: string): string => (isReceiver(name) ? "self" : name);

  /** The cell an identifier or `obj.attr` names. */
  const cellOf = (node: Node | null): ValueCell | null => {
    const n = unwrap(node);
    if (!n) return null;
    if (n.type === "identifier") {
      const name = n.text;
      if (isShadowed(name) || scope.globals.has(name)) return null;
      return { name: cellName(name) };
    }
    if (n.type === "attribute") {
      const obj = n.childForFieldName("object");
      const attr = n.childForFieldName("attribute");
      if (obj?.type !== "identifier" || !attr || isShadowed(obj.text)) return null;
      return { name: cellName(obj.text), member: attr.text };
    }
    return null;
  };

  const stringKey = (node: Node): string | null => {
    if (node.namedChildren.some((c) => c.type === "interpolation")) return null;
    const m = /^[a-zA-Z]{0,2}(['"])(.*)\1$/s.exec(node.text);
    return m && /^[\w.-]{1,64}$/.test(m[2]!) ? m[2]! : null;
  };

  /** The cell of a subscripted container (`handlers[k]`, `self.handlers["save"]`) and the literal key. */
  const subscriptCell = (node: Node): { cell: ValueCell; key?: string } | null => {
    const container = cellOf(node.childForFieldName("value"));
    if (!container) return null;
    const index = unwrap(node.childForFieldName("subscript") ?? node.namedChild(1));
    const key = index?.type === "string" ? stringKey(index) : null;
    // `d["k"]` has a cell of its own only on a plain name (`self.x` has no second member level).
    return key !== null && container.member === undefined && container.name !== "self" ? { cell: container, key } : { cell: container };
  };

  const seed = (to: ValueCell, fn: string, line: number, lambda?: string): void => {
    facts.push(lambda === undefined ? { kind: "seed", to, fn, line } : { kind: "seed", to, fn, line, lambda });
  };
  const copy = (from: ValueCell, to: ValueCell, line: number, lambda?: string): void => {
    if (from.name === to.name && from.member === to.member) return;
    facts.push(lambda === undefined ? { kind: "copy", from, to, line } : { kind: "copy", from, to, line, lambda });
  };

  /** Whether a bare name may be a function the project declares or imports (not a builtin or a receiver). */
  const maybeFunctionName = (name: string): boolean => !PY_BUILTIN_CALLS.has(name) && !isReceiver(name) && name !== "self" && name !== "cls";

  /** Whether a name is bound by an import of the standard library or an external package (and no local shadows it). */
  const isExternal = (name: string): boolean => scope.externalImports?.has(name) === true && !isLocal(name);

  /**
   * A lambda that lands in `to` stands for the functions its body calls (it has no function of its own): each
   * project function it calls is a seed, a call of a name that holds a value a copy. A call on one of its own
   * parameters, on a local or on something the plugin cannot spell, and a body calling more than sixteen names, state nothing; every fact carries the lambda's id so core counts its project targets (at most four).
   */
  const lambdaInto = (lambda: Node, to: ValueCell, line: number): void => {
    const own = new Set<string>();
    const calls: Node[] = [];
    const scan = (node: Node): void => {
      for (const c of node.namedChildren) {
        if (c.type === "lambda") for (const p of c.childForFieldName("parameters")?.namedChildren ?? []) targetNames(p.type === "default_parameter" || p.type === "typed_default_parameter" ? p.childForFieldName("name") : p, own);
        else if (c.type === "call") calls.push(c);
        // Names the body binds itself (comprehension and loop variables, walrus targets) are no project functions.
        else if (c.type === "for_in_clause") targetNames(c.childForFieldName("left"), own);
        else if (c.type === "named_expression") targetNames(c.childForFieldName("name"), own);
        scan(c);
      }
    };
    for (const p of lambda.childForFieldName("parameters")?.namedChildren ?? []) targetNames(p.type === "default_parameter" || p.type === "typed_default_parameter" ? p.childForFieldName("name") : p, own);
    const body = lambda.childForFieldName("body");
    if (!body) return;
    if (body.type === "call") calls.push(body);
    scan(body);
    const seeds = new Set<string>();
    const copies = new Map<string, ValueCell>();
    for (const call of calls) {
      const callee = unwrap(call.childForFieldName("function"));
      if (!callee) continue;
      if (callee.type === "identifier") {
        const name = callee.text;
        if (own.has(name) || isShadowed(name) || scope.globals.has(name) || isReceiver(name)) continue;
        if (isLocal(name)) { copies.set(name, { name: cellName(name) }); continue; }
        if (!maybeFunctionName(name) || /^[A-Z]/.test(name) || isExternal(name)) continue;
        seeds.add(name);
      } else if (callee.type === "attribute") {
        const obj = callee.childForFieldName("object");
        const attr = callee.childForFieldName("attribute");
        if (obj?.type !== "identifier" || !attr || own.has(obj.text) || isShadowed(obj.text)) continue;
        if (isReceiver(obj.text)) {
          if (scope.heldFields.has(attr.text)) copies.set(`self.${attr.text}`, { name: "self", member: attr.text });
          else seeds.add(`self.${attr.text}`);
        } else if (!isLocal(obj.text) && maybeFunctionName(obj.text) && !isExternal(obj.text)) seeds.add(callee.text);
      }
    }
    // Core counts the project functions the group resolves to and drops it above four; this bound only limits output.
    if (seeds.size + copies.size > 16) return;
    const id = `${lambda.startPosition.row + 1}:${lambda.startPosition.column}`;
    for (const fn of seeds) seed(to, fn, line, id);
    for (const from of copies.values()) copy(from, to, line, id);
  };

  /** Everything `expr` may hold flows into `to`. */
  const valueInto = (expr: Node | null, to: ValueCell, line: number): void => {
    const n = unwrap(expr);
    if (!n) return;
    switch (n.type) {
      case "identifier": {
        const name = n.text;
        if (isShadowed(name) || scope.globals.has(name) || isReceiver(name)) return;
        if (isLocal(name)) { copy({ name: cellName(name) }, to, line); return; }
        if (!maybeFunctionName(name)) return;
        seed(to, name, line);
        copy({ name }, to, line);
        return;
      }
      case "attribute": {
        const obj = n.childForFieldName("object");
        const attr = n.childForFieldName("attribute");
        if (obj?.type !== "identifier" || !attr || isShadowed(obj.text)) return;
        const objName = obj.text;
        if (isReceiver(objName)) {
          seed(to, `self.${attr.text}`, line);
          copy({ name: "self", member: attr.text }, to, line);
        } else if (isLocal(objName)) {
          copy({ name: objName, member: attr.text }, to, line);
        } else if (maybeFunctionName(objName)) {
          seed(to, n.text, line);
          copy({ name: objName, member: attr.text }, to, line);
        }
        return;
      }
      case "subscript": {
        const sub = subscriptCell(n);
        if (sub) copy(sub.key !== undefined ? { name: sub.cell.name, member: sub.key } : sub.cell, to, line);
        return;
      }
      case "lambda": lambdaInto(n, to, line); return;
      case "list": case "tuple": case "set": case "expression_list":
        for (const c of n.namedChildren) valueInto(c.type === "list_splat" ? c.namedChild(0) : c, to, line);
        return;
      case "dictionary": {
        for (const pair of n.namedChildren) {
          if (pair.type !== "pair") continue;
          const value = pair.childForFieldName("value");
          valueInto(value, to, line);
          const key = unwrap(pair.childForFieldName("key"));
          const literal = key?.type === "string" ? stringKey(key) : null;
          if (literal !== null && to.member === undefined && to.name !== "self") valueInto(value, { name: to.name, member: literal }, line);
        }
        return;
      }
      case "conditional_expression": {
        // Named children are [value if true, condition, value if false]: the condition is no value.
        const parts = n.namedChildren.filter((c) => c.type !== "comment");
        valueInto(parts[0] ?? null, to, line);
        valueInto(parts[2] ?? null, to, line);
        return;
      }
      case "boolean_operator":
        valueInto(n.childForFieldName("left"), to, line);
        valueInto(n.childForFieldName("right"), to, line);
        return;
      case "call": {
        const name = callNameOf(n);
        if (name === null) return;
        const head = name.split(".").pop()!;
        // `functools.partial(f, …)`: the function it binds.
        if (head === "partial" && (name === "partial" || /^[A-Za-z_]\w*\.partial$/.test(name))) {
          valueInto(n.childForFieldName("arguments")?.namedChildren[0] ?? null, to, line);
          return;
        }
        // `table.get(k)`, `queue.pop()`: an element of the container.
        const callee = unwrap(n.childForFieldName("function"));
        if (callee?.type === "attribute" && READERS.has(callee.childForFieldName("attribute")!.text)) {
          const container = cellOf(callee.childForFieldName("object"));
          if (container) copy(container, to, line);
        }
        // A builtin, or a construction (`Club()`, `models.Club()`): the instance is no function value.
        if (PY_BUILTIN_CALLS.has(name) || /^[A-Z]/.test(head)) return;
        facts.push({ kind: "result", call: name, line: pos(n), to });
        return;
      }
      default: return;
    }
  };

  /** A cell standing for the value of `expr` at a call boundary or a `return`: the expression's own when it is a plain local. */
  const sourceCell = (expr: Node | null, kind: string, line: number): ValueCell | null => {
    const n = unwrap(expr);
    if (!n) return null;
    if (n.type === "identifier" && isLocal(n.text) && !isShadowed(n.text) && !isReceiver(n.text)) return { name: cellName(n.text) };
    if (n.type === "attribute") {
      // A field a local holds is read as that cell; one of the receiver also names a method, so it goes through a seed.
      const obj = n.childForFieldName("object");
      if (obj?.type === "identifier" && !isReceiver(obj.text) && isLocal(obj.text) && !isShadowed(obj.text)) return { name: obj.text, member: n.childForFieldName("attribute")!.text };
    }
    switch (n.type) {
      case "identifier": case "attribute": case "call": case "subscript": case "conditional_expression": case "boolean_operator": case "lambda":
      case "list": case "tuple": case "set": case "dictionary": case "expression_list": {
        const cell = fresh(kind, line);
        const before = facts.length;
        valueInto(n, cell, line);
        return facts.length > before ? cell : null;
      }
      default: return null;
    }
  };

  const assignTarget = (target: Node | null, value: Node | null, line: number): void => {
    const t = unwrap(target);
    if (!t) return;
    if (t.type === "identifier") {
      if (t.text === "_" || isShadowed(t.text) || scope.globals.has(t.text)) return;
      // A module-level `name = lambda …` is a function of its own (its calls are its own): no value to follow.
      if (scope.atModule && unwrap(value)?.type === "lambda") return;
      valueInto(value, { name: cellName(t.text) }, line);
      return;
    }
    if (t.type === "attribute") {
      const to = cellOf(t);
      if (to) valueInto(value, to, line);
      return;
    }
    if (t.type === "subscript") {
      const sub = subscriptCell(t);
      if (!sub) return;
      valueInto(value, sub.cell, line);
      if (sub.key !== undefined) valueInto(value, { name: sub.cell.name, member: sub.key }, line);
      return;
    }
    if (t.type === "pattern_list" || t.type === "tuple_pattern" || t.type === "list_pattern") {
      const rhs = unwrap(value);
      const parts = t.namedChildren;
      if (rhs && (rhs.type === "tuple" || rhs.type === "list") && rhs.namedChildren.length === parts.length) {
        parts.forEach((p, i) => assignTarget(p, rhs.namedChildren[i]!, line));
      } else {
        for (const p of parts) assignTarget(p.type === "list_splat_pattern" ? p.namedChild(0) : p, value, line);
      }
    }
  };

  const handleAssignment = (n: Node): void => {
    const line = pos(n);
    const targets: Node[] = [];
    let cur: Node | null = n;
    let value: Node | null = null;
    while (cur && cur.type === "assignment") {
      const left = cur.childForFieldName("left");
      if (left) targets.push(left);
      value = cur.childForFieldName("right");
      cur = value;
    }
    if (!value) return;
    for (const t of targets) assignTarget(t, value, line);
  };

  const handleLoop = (n: Node): void => {
    const left = n.childForFieldName("left");
    let right = unwrap(n.childForFieldName("right"));
    if (!left || !right) return;
    // `for k, cb in table.items()` / `table.values()`: the elements of the table.
    let target = left;
    if (right.type === "call") {
      const callee = unwrap(right.childForFieldName("function"));
      const method = callee?.type === "attribute" ? callee.childForFieldName("attribute")!.text : null;
      if (method === "items" || method === "values") {
        if (method === "items" && (left.type === "pattern_list" || left.type === "tuple_pattern") && left.namedChildren.length === 2) target = left.namedChildren[1]!;
        right = callee!.childForFieldName("object")!;
      } else if (method === "copy") right = callee!.childForFieldName("object")!;
    }
    // `enumerate(cbs)`, `list(cbs)`, `reversed(cbs)`, `sorted(cbs)`: the same elements.
    if (right.type === "call") {
      const name = callNameOf(right);
      const first = right.childForFieldName("arguments")?.namedChildren[0];
      if (first && (name === "list" || name === "tuple" || name === "set" || name === "reversed" || name === "sorted")) right = unwrap(first)!;
      else if (first && name === "enumerate" && (left.type === "pattern_list" || left.type === "tuple_pattern") && left.namedChildren.length === 2) { right = unwrap(first)!; target = left.namedChildren[1]!; }
    }
    assignTarget(target, right, pos(n));
  };

  const handleReturn = (n: Node): void => {
    const value = n.namedChild(0);
    if (!value) return;
    const line = pos(n);
    const cell = sourceCell(value, "ret", line);
    if (cell) facts.push({ kind: "return", from: cell, line });
  };

  const handleCall = (n: Node): void => {
    const line = pos(n);
    const callee = unwrap(n.childForFieldName("function"));
    const args = n.childForFieldName("arguments");
    const name = callNameOf(n);

    // `handlers.append(f)`: the container now holds what was added.
    if (callee?.type === "attribute" && args) {
      const method = callee.childForFieldName("attribute")!.text;
      if (ADDERS.has(method) || method === "extend" || method === "update") {
        const container = cellOf(callee.childForFieldName("object"));
        const added = args.namedChildren.filter((a) => a.type !== "keyword_argument" && a.type !== "comment");
        const last = method === "insert" ? added[added.length - 1] : added[0];
        if (container && last) valueInto(last, container, line);
      }
    }

    // What the call runs.
    if (callee && name !== null) {
      if (callee.type === "identifier") {
        const injectedParam = scope.injected && scope.params.has(callee.text);
        const held = !injectedParam && !isShadowed(callee.text) && !scope.globals.has(callee.text) && (isLocal(callee.text) || scope.moduleHeld.has(callee.text));
        if (held) facts.push({ kind: "invoke", cell: { name: cellName(callee.text) }, call: name, line });
      } else if (callee.type === "attribute" && scope.selfName && callee.childForFieldName("object")?.text === scope.selfName) {
        const attr = callee.childForFieldName("attribute")!.text;
        if (scope.heldFields.has(attr)) facts.push({ kind: "invoke", cell: { name: "self", member: attr }, call: name, line });
      }
    } else if (callee?.type === "subscript") {
      const sub = subscriptCell(callee);
      if (sub) facts.push({ kind: "invoke", cell: sub.key !== undefined ? { name: sub.cell.name, member: sub.key } : sub.cell, call: callee.text.replace(/\s+/g, ""), line });
    } else if (callee?.type === "call") {
      // `table.get(k)(x)`: a call on an element of the container.
      const inner = unwrap(callee.childForFieldName("function"));
      if (inner?.type === "attribute" && READERS.has(inner.childForFieldName("attribute")!.text)) {
        const container = cellOf(inner.childForFieldName("object"));
        if (container) facts.push({ kind: "invoke", cell: container, call: callee.text.replace(/\s+/g, ""), line });
      }
    }

    // What each argument holds, by written index (stops at a splat: the indices after it are unknown).
    if (name === null || !args) return;
    // An argument handed to a library call (`json.dumps(x)`, `sleep(x)`) reaches no project parameter.
    let head = callee;
    while (head?.type === "attribute") head = unwrap(head.childForFieldName("object"));
    if (head?.type === "identifier" && isExternal(head.text)) return;
    let index = 0;
    for (const a of args.namedChildren) {
      if (a.type === "comment") continue;
      if (a.type === "list_splat" || a.type === "dictionary_splat") break;
      if (a.type === "keyword_argument") continue;
      const from = sourceCell(a, "arg", line);
      if (from) facts.push({ kind: "arg", call: name, line, index, from });
      index++;
    }
  };

  const step = (c: Node): void => {
    if (SCOPE_TYPES.has(c.type)) return;
    switch (c.type) {
      case "lambda": {
        const names = new Set<string>();
        for (const p of c.childForFieldName("parameters")?.namedChildren ?? []) targetNames(p.type === "default_parameter" || p.type === "typed_default_parameter" ? p.childForFieldName("name") : p, names);
        shadowed.push(names);
        const lambdaBody = c.childForFieldName("body");
        if (lambdaBody) step(lambdaBody);
        shadowed.pop();
        return;
      }
      case "assignment": handleAssignment(c); break;
      // `handlers += [f]`, `registry |= {f}`: the target now also holds what is added.
      case "augmented_assignment": assignTarget(c.childForFieldName("left"), c.childForFieldName("right"), pos(c)); break;
      case "for_statement": case "for_in_clause": handleLoop(c); break;
      case "return_statement": handleReturn(c); break;
      case "call": handleCall(c); break;
      default: break;
    }
    for (const child of c.namedChildren) step(child);
  };

  for (const child of body.namedChildren) step(child);
  return prune(facts, scope);
}

/**
 * Drop the facts no sink needs: a local that never reaches an argument, a return, a call or a field is no
 * function value anyone follows, and an argument is stated only for a name that can hold one.
 */
function prune(facts: Fact[], scope: FlowScope): Fact[] {
  const isTemp = (name: string): boolean => name.startsWith("<");
  // Module names are read by every function of the file: they are sinks of their own.
  const localTarget = (c: ValueCell): boolean => c.member === undefined && (isTemp(c.name) || (!scope.atModule && (scope.locals.has(c.name) || scope.enclosing.has(c.name))));
  const live = new Set<string>(scope.captured);
  const need = (c: ValueCell): void => { live.add(c.name); };
  for (const f of facts) {
    if (f.kind === "arg" || f.kind === "return") need(f.kind === "arg" ? f.from : f.from);
    else if (f.kind === "invoke") need(f.cell);
    else if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && !localTarget(f.to)) need(f.to);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const f of facts) {
      if (f.kind !== "copy" || !live.has(f.to.name) || live.has(f.from.name)) continue;
      live.add(f.from.name);
      changed = true;
    }
  }
  const produced = new Set<string>();
  const kept: Fact[] = [];
  for (const f of facts) {
    if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && localTarget(f.to) && !live.has(f.to.name)) continue;
    kept.push(f);
    if (f.kind === "seed" || f.kind === "copy" || f.kind === "result") produced.add(f.to.name);
  }
  const params = scope.params;
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const f of kept) {
    if (f.kind === "arg" && f.from.member === undefined && !isTemp(f.from.name) && !produced.has(f.from.name) && !params.has(f.from.name) && !scope.enclosing.has(f.from.name)) continue;
    const key = JSON.stringify(f);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/** Facts of the module's own statements, plus assignments a function makes to a name it declares `global`. */
export function pythonModuleValueFlow(root: Node, withGlobals = true, external: ReadonlySet<string> = externalImportNames(root)): Fact[] {
  const assigned = moduleAssignedNames(root);
  const base: FlowScope = { locals: assigned, params: new Set(), enclosing: new Set(), captured: new Set(), selfName: null, heldFields: new Set(), moduleHeld: new Set(), globals: new Set(), injected: false, atModule: true, externalImports: external };
  const facts = pythonValueFlow(root, base);
  // A function's assignment to a module name it declares `global`: a plain function name only.
  const walk = (node: Node): void => {
    for (const c of node.namedChildren) {
      if (c.type === "function_definition") {
        const body = c.childForFieldName("body");
        const { globals, locals } = boundNamesOf(body, paramNamesOf(c));
        if (body && globals.size > 0) {
          eachNode(body, (n) => {
            if (n.type !== "assignment") return;
            const left = n.childForFieldName("left");
            const right = unwrap(n.childForFieldName("right"));
            if (left?.type !== "identifier" || !globals.has(left.text) || right?.type !== "identifier") return;
            if (PY_BUILTIN_CALLS.has(right.text) || locals.has(right.text)) return;
            facts.push({ kind: "seed", to: { name: left.text }, fn: right.text, line: pos(n) });
          });
        }
        if (body) walk(body);
      } else walk(c);
    }
  };
  if (withGlobals) walk(root);
  return facts;
}

let moduleCache: { text: string; facts: Fact[]; held: Set<string>; external: Set<string> } | null = null;

/** The module's facts and the names they bind, for one file (read by its functions and by the file-level hook). */
export function moduleFlowOf(root: Node, sourceText: string): { facts: Fact[]; held: ReadonlySet<string>; external: ReadonlySet<string> } {
  if (moduleCache?.text === sourceText) return moduleCache;
  // A `global` statement is the only way a function assigns a module name: look for them only then.
  const external = externalImportNames(root);
  const facts = pythonModuleValueFlow(root, sourceText.includes("global "), external);
  const held = new Set<string>();
  for (const f of facts) if ((f.kind === "seed" || f.kind === "copy" || f.kind === "result") && f.to.member === undefined && !f.to.name.startsWith("<")) held.add(f.to.name);
  moduleCache = { text: sourceText, facts, held, external };
  return moduleCache;
}

/** A function's facts: its own body read against what it, its class and its module bind. */
export function functionValueFlow(
  fnNode: Node,
  params: readonly ParamInfo[],
  opts: { selfName: string | null; heldFields: ReadonlySet<string>; moduleHeld: ReadonlySet<string>; injected: boolean; externalImports?: ReadonlySet<string> },
): Fact[] | undefined {
  const body = fnNode.childForFieldName("body");
  if (!body) return undefined;
  const own = boundNamesOf(body, params);
  // A nested `def` reads the locals of the functions it is written in.
  const enclosing = new Set<string>();
  for (let p = fnNode.parent; p; p = p.parent) {
    if (p.type === "class_definition") break;
    if (p.type !== "function_definition") continue;
    const outer = boundNamesOf(p.childForFieldName("body"), paramNamesOf(p));
    for (const name of outer.locals) enclosing.add(name);
  }
  for (const n of own.nonlocals) enclosing.add(n);
  const scope: FlowScope = {
    locals: own.locals,
    params: new Set(params.map((p) => p.name.replace(/^\*+/, ""))),
    enclosing,
    captured: capturedNames(body),
    selfName: opts.selfName,
    heldFields: opts.heldFields,
    moduleHeld: opts.moduleHeld,
    globals: own.globals,
    injected: opts.injected,
    atModule: false,
    externalImports: opts.externalImports,
  };
  const facts = pythonValueFlow(body, scope);
  return facts.length > 0 ? facts : undefined;
}

/** Every name the nested functions of `body` mention (a closure may read any local of its parent). */
function capturedNames(body: Node): Set<string> {
  const names = new Set<string>();
  const collect = (node: Node): void => {
    for (const c of node.namedChildren) {
      if (c.type === "identifier") names.add(c.text);
      else collect(c);
    }
  };
  const find = (node: Node): void => {
    for (const c of node.namedChildren) {
      if (c.type === "function_definition" || c.type === "class_definition") collect(c);
      else find(c);
    }
  };
  find(body);
  return names;
}

function paramNamesOf(def: Node): ParamInfo[] {
  const names: ParamInfo[] = [];
  const set = new Set<string>();
  for (const p of def.childForFieldName("parameters")?.namedChildren ?? []) {
    const id = p.type === "identifier" ? p : p.type === "typed_parameter" || p.type === "default_parameter" || p.type === "typed_default_parameter" ? (p.childForFieldName("name") ?? p.namedChild(0)) : p.namedChild(0);
    if (id?.type === "identifier") set.add(id.text);
  }
  for (const name of set) names.push({ name } as ParamInfo);
  return names;
}
