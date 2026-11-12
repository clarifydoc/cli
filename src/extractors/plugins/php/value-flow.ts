import type { Node } from "web-tree-sitter";
import type { ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { liveValueFlow } from "../shared/value-flow-live.js";
import { phpCallHooks } from "./call-hooks.js";

/**
 * PHP value-flow facts (see `ValueFlowFact`): a function value kept in a local, a property or a list element,
 * handed to a call, returned, and run through `$f()` / `($this->h)()` / `call_user_func($f)` / `array_map($f, …)`.
 *
 * Values read: `'save'`, `'Club::save'`, `[$this, 'save']`, `[Club::class, 'save']`, `save(...)`,
 * `$this->save(...)`, `Club::save(...)` and `Closure::fromCallable(…)` of those. A closure or arrow function held
 * in a value (`$cb = fn() => $this->save()`, `$this->onDone = function () { Club::close(); }`, a list element, an
 * argument, a return) stands for the project functions its body calls, at most four, spelled as a seed is
 * (`save`, `this.save`, `Club.save`); one that runs a held value (`fn() => $onDone()`) copies that value's cell.
 * It is no function of its own: its calls already belong to the function that writes it. A call on one of its
 * parameters, a builtin and a receiver that cannot be spelled state nothing; a closure handed to a builtin that
 * runs it (`array_map`) is a block, not a value. A call never made through a held value (`$this->$method()`) is
 * not read.
 */

/** Builtins that run a callback: the written index of the callback argument. */
const CALLBACK_FUNCTIONS: Readonly<Record<string, number>> = {
  call_user_func: 0, call_user_func_array: 0, array_map: 0, array_filter: 1, array_walk: 1, array_reduce: 1,
  usort: 1, uasort: 1, uksort: 1, register_shutdown_function: 0, iterator_apply: 1, array_walk_recursive: 1,
};

const CLOSURES = new Set(["anonymous_function", "anonymous_function_creation_expression", "arrow_function"]);
const DECLARATIONS = new Set(["function_definition", "method_declaration", "class_declaration", "interface_declaration", "trait_declaration", "enum_declaration", "anonymous_class"]);
const CALL_NODES = new Set(["function_call_expression", "member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression", "object_creation_expression"]);

/** Builtin functions a closure body may call; a name here is no project function. */
const BUILTIN_PREFIX = /^(?:array_|mb_|preg_|json_)/;
const BUILTIN_NAMES = new Set(("is_null is_array is_string is_int is_numeric is_callable is_object is_bool str_contains str_starts_with str_ends_with str_replace str_pad str_repeat str_split intval floatval strval boolval count sizeof strlen strtolower strtoupper substr strpos sprintf printf print_r var_dump var_export implode explode join trim ltrim rtrim " +
  "in_array isset empty unset compact extract min max abs round floor ceil sort rsort usort uasort uksort ksort krsort asort arsort range time microtime date sleep usleep define defined constant " +
  "class_exists method_exists function_exists property_exists get_class get_object_vars call_user_func call_user_func_array error_log trigger_error assert serialize unserialize htmlspecialchars " +
  "number_format uniqid password_hash password_verify md5 sha1 hash base64_encode base64_decode urlencode rawurlencode http_build_query header exit die fopen fclose fwrite fread").split(" "));
const isBuiltinFunction = (name: string): boolean => {
  const n = name.toLowerCase();
  return BUILTIN_PREFIX.test(n) || BUILTIN_NAMES.has(n);
};

interface Values { cells: ValueCell[]; seeds: string[]; results: Array<{ call: string; line: number }> }

const plainString = (n: Node): string | null => {
  if (n.type === "string") return n.text.slice(1, -1);
  if (n.type === "encapsed_string" && n.namedChildren.every((c) => c.type === "string_content" || c.type === "string")) return n.text.slice(1, -1);
  return null;
};
const lineOf = (n: Node): number => n.startPosition.row + 1;
const lastSegment = (name: string): string => name.replace(/^.*\\/, "");

/** `'save'` → `save`, `'Club::save'` → `Club.save`; null for anything that is not a callable's spelling. */
function callableString(text: string): string | null {
  const m = /^\\?([A-Za-z_][\w\\]*)(?:::([A-Za-z_]\w*))?$/.exec(text);
  if (!m) return null;
  return m[2] ? `${lastSegment(m[1]!)}.${m[2]}` : lastSegment(m[1]!);
}

/** `[$this, 'save']`, `[Club::class, 'save']`, `['Club', 'save']`: the callable the pair names. */
function callableArray(n: Node): string | null {
  if (n.type !== "array_creation_expression") return null;
  const items = n.namedChildren.filter((c) => c.type === "array_element_initializer");
  if (items.length !== 2 || items.some((i) => i.namedChildren.length !== 1)) return null;
  const head = items[0]!.namedChildren[0]!;
  const method = plainString(items[1]!.namedChildren[0]!);
  if (!method || !/^[A-Za-z_]\w*$/.test(method)) return null;
  if (head.type === "variable_name") return `${head.text.replace(/^\$/, "")}.${method}`;
  if (head.type === "class_constant_access_expression" && head.namedChildren.length === 2 && head.namedChildren[1]!.text === "class") {
    const scope = head.namedChildren[0]!.text;
    return /^(self|static)$/i.test(scope) ? `this.${method}` : `${lastSegment(scope)}.${method}`;
  }
  if (head.type === "object_creation_expression") {
    const cls = head.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
    return cls ? `${lastSegment(cls.text)}.${method}` : null;
  }
  const headText = plainString(head);
  return headText && /^[A-Z]\w*(\\\w+)*$/.test(headText) ? `${lastSegment(headText)}.${method}` : null;
}

/** `save(...)`, `$this->save(...)`, `Club::save(...)`: the first-class callable syntax. */
function firstClassCallable(n: Node): string | null {
  if (!CALL_NODES.has(n.type) || n.type === "object_creation_expression") return null;
  const args = n.childForFieldName("arguments") ?? n.namedChildren.find((c) => c.type === "arguments");
  if (!args || args.namedChildren.length !== 1 || args.namedChildren[0]!.type !== "variadic_placeholder") return null;
  return phpCallHooks.resolveCallName?.(n) ?? null;
}

const isFromCallable = (n: Node): boolean =>
  n.type === "scoped_call_expression" && /^\\?Closure$/.test(n.childForFieldName("scope")?.text ?? "") && n.childForFieldName("name")?.text === "fromCallable";

const argsOf = (call: Node): Node[] => {
  const args = call.childForFieldName("arguments") ?? call.namedChildren.find((c) => c.type === "arguments");
  return (args?.namedChildren ?? []).filter((a) => a.type === "argument");
};
/** The expression an argument passes (a named argument `cb: $f` passes `$f`). */
const argValue = (arg: Node): Node | null => arg.namedChildren[arg.namedChildren.length - 1] ?? null;

/** The extractor for one function body. */
class Reader {
  facts: ValueFlowFact[] = [];
  private temp = 0;
  private shadow: Set<string>[] = [];

  constructor(private readonly params: readonly string[]) {}

  private shadowed(name: string): boolean {
    return this.shadow.some((s) => s.has(name));
  }

  /** The cell a variable, property or list element names. */
  cellOf(n: Node, elementKey?: string): ValueCell | null {
    let base: ValueCell | null = null;
    if (n.type === "parenthesized_expression") return n.namedChildren[0] ? this.cellOf(n.namedChildren[0], elementKey) : null;
    if (n.type === "variable_name") {
      const name = n.text.replace(/^\$/, "");
      if (!/^\w+$/.test(name) || this.shadowed(name)) return null;
      if (name === "this" && elementKey === undefined) return null;
      base = { name };
    } else if (n.type === "member_access_expression" || n.type === "nullsafe_member_access_expression") {
      const obj = n.childForFieldName("object") ?? n.namedChildren[0];
      const prop = n.childForFieldName("name") ?? n.namedChildren[1];
      if (!obj || !prop || obj.type !== "variable_name" || prop.type !== "name") return null;
      const owner = obj.text.replace(/^\$/, "");
      if (this.shadowed(owner)) return null;
      base = { name: owner, member: prop.text };
    } else if (n.type === "subscript_expression") {
      const target = n.namedChildren[0];
      if (!target || elementKey !== undefined) return null;
      const index = n.namedChildren[1];
      const literal = index ? (plainString(index) ?? (index.type === "integer" ? index.text : null)) : null;
      return this.cellOf(target, literal !== null && /^\w+$/.test(literal) ? literal : "");
    } else return null;
    if (elementKey === undefined) return base;
    const key = elementKey === "" ? "[]" : elementKey;
    return base.member === undefined ? { name: base.name, member: key } : { name: base.name, member: `${base.member}${key === "[]" ? "[]" : `[${key}]`}` };
  }

  /** The cells a store to `n` fills: a literal key also fills the whole-list cell a dynamic read meets. */
  private targetsOf(n: Node): ValueCell[] {
    if (n.type === "subscript_expression") {
      const keyed = this.cellOf(n);
      const any = this.cellOf(n.namedChildren[0]!, "");
      return [keyed, any].filter((c, i, all): c is ValueCell => c !== null && all.findIndex((o) => o && o.name === c.name && o.member === c.member) === i);
    }
    const c = this.cellOf(n);
    return c ? [c] : [];
  }

  /** What an expression holds, flattened across `?:` and `??`. */
  valuesOf(n: Node, into: Values = { cells: [], seeds: [], results: [] }): Values {
    switch (n.type) {
      case "parenthesized_expression":
        if (n.namedChildren[0]) this.valuesOf(n.namedChildren[0], into);
        return into;
      case "conditional_expression": {
        const parts = n.namedChildren;
        // `c ? a : b` has the branches last; the short `c ?: b` has the condition (it may be the result) and one.
        for (const p of parts.length === 2 ? parts : parts.slice(1)) this.valuesOf(p, into);
        return into;
      }
      case "binary_expression": {
        const op = n.children.find((c) => !c.isNamed)?.text;
        if (op === "??") for (const p of n.namedChildren) this.valuesOf(p, into);
        return into;
      }
      case "anonymous_function":
      case "anonymous_function_creation_expression":
      case "arrow_function":
        this.closureValues(n, into);
        return into;
      case "string":
      case "encapsed_string": {
        const text = plainString(n);
        const callable = text !== null ? callableString(text) : null;
        if (callable) into.seeds.push(callable);
        return into;
      }
      case "array_creation_expression": {
        const pair = callableArray(n);
        if (pair) into.seeds.push(pair);
        return into;
      }
      case "variable_name":
      case "member_access_expression":
      case "nullsafe_member_access_expression":
      case "subscript_expression": {
        const cell = this.cellOf(n);
        if (cell) into.cells.push(cell);
        return into;
      }
    }
    if (CALL_NODES.has(n.type)) {
      const fcc = firstClassCallable(n);
      if (fcc) { into.seeds.push(fcc); return into; }
      if (isFromCallable(n)) {
        const arg = argsOf(n)[0];
        const value = arg ? argValue(arg) : null;
        if (value) this.valuesOf(value, into);
        return into;
      }
      if (n.type === "object_creation_expression") return into;
      const name = phpCallHooks.resolveCallName?.(n);
      if (name) into.results.push({ call: name, line: lineOf(n) });
    }
    return into;
  }

  /** The project functions a closure's body calls (or the held values it runs), when there are at most four. */
  private closureValues(closure: Node, into: Values): void {
    const body = closure.childForFieldName("body");
    if (!body) return;
    const paramsOf = (c: Node): string[] => {
      const out: string[] = [];
      for (const p of c.childForFieldName("parameters")?.namedChildren ?? []) {
        const v = p.childForFieldName("name") ?? p.namedChildren.find((x) => x.type === "variable_name");
        if (v) out.push(v.text.replace(/^\$/, ""));
      }
      return out;
    };
    const params = new Set(paramsOf(closure));
    const names = new Set<string>();
    const cells = new Map<string, ValueCell>();
    const visit = (c: Node, scope: ReadonlySet<string>): void => {
      if (DECLARATIONS.has(c.type)) return;
      let here = scope;
      // A nested closure's parameters hide names only inside it.
      if (CLOSURES.has(c.type) && c !== closure) here = new Set([...scope, ...paramsOf(c)]);
      if (CALL_NODES.has(c.type) && !firstClassCallable(c)) {
        const held = this.closureHeld(c, here);
        if (held) cells.set(`${held.name}.${held.member ?? ""}`, held);
        else {
          const fn = this.closureCallee(c);
          if (fn) names.add(fn);
        }
      }
      for (const k of c.namedChildren) visit(k, here);
    };
    visit(body, params);
    if (names.size + cells.size > 4) return;
    for (const fn of names) into.seeds.push(fn);
    for (const cell of cells.values()) into.cells.push(cell);
  }

  /** `$onDone()` / `($this->onDone)()` inside a closure: the cell of the value it runs (not a closure parameter's). */
  private closureHeld(call: Node, params: ReadonlySet<string>): ValueCell | null {
    if (call.type !== "function_call_expression") return null;
    const fn = call.childForFieldName("function") ?? call.namedChildren[0];
    if (!fn) return null;
    const held = fn.type === "parenthesized_expression" ? fn.namedChildren[0] : fn;
    if (!held || !["variable_name", "member_access_expression"].includes(held.type)) return null;
    const head = held.type === "variable_name" ? held : held.childForFieldName("object") ?? held.namedChildren[0];
    if (!head || head.type !== "variable_name" || params.has(head.text.replace(/^\$/, ""))) return null;
    return this.cellOf(held);
  }

  /** The spelling of a project function a call inside a closure runs, or null. */
  private closureCallee(call: Node): string | null {
    if (call.type === "function_call_expression") {
      const fn = call.childForFieldName("function") ?? call.namedChildren[0];
      if (!fn || (fn.type !== "name" && fn.type !== "qualified_name")) return null;
      const name = lastSegment(fn.text);
      return isBuiltinFunction(name) ? null : name;
    }
    if (call.type === "member_call_expression") {
      const obj = call.childForFieldName("object");
      const name = call.childForFieldName("name");
      return obj?.type === "variable_name" && obj.text === "$this" && name?.type === "name" ? `this.${name.text}` : null;
    }
    if (call.type === "scoped_call_expression") {
      const scope = call.childForFieldName("scope");
      const name = call.childForFieldName("name");
      if (!scope || name?.type !== "name" || (scope.type !== "name" && scope.type !== "qualified_name" && scope.type !== "relative_scope")) return null;
      const text = scope.text;
      if (/^parent$/i.test(text)) return null;
      if (/^(self|static)$/i.test(text)) return `this.${name.text}`;
      return /^\\?Closure$/.test(text) ? null : `${lastSegment(text)}.${name.text}`;
    }
    return null;
  }

  private tempCell(line: number): ValueCell {
    return { name: `%v${line}.${this.temp++}` };
  }

  /** A cell standing for the values of `n`: its own cell when a variable, else a fresh one the seeds and results fill. */
  private cellFor(n: Node): ValueCell | null {
    const v = this.valuesOf(n);
    if (v.seeds.length === 0 && v.results.length === 0) return v.cells.length === 1 ? v.cells[0]! : null;
    const to = this.tempCell(lineOf(n));
    this.fill(to, v, lineOf(n));
    return to;
  }

  private fill(to: ValueCell, v: Values, line: number): void {
    for (const from of v.cells) {
      this.facts.push({ kind: "copy", from, to, line });
      // A list copied carries its elements.
      this.facts.push({ kind: "copy", from: elementOf(from), to: elementOf(to), line });
    }
    for (const fn of v.seeds) this.facts.push({ kind: "seed", to, fn, line });
    for (const r of v.results) this.facts.push({ kind: "result", call: r.call, line: r.line, to });
  }

  /** `target = value`, with an array literal read element by element. */
  assign(target: ValueCell[], value: Node, line: number, depth = 0): void {
    if (target.length === 0) return;
    if (value.type === "array_creation_expression" && !callableArray(value)) {
      if (depth > 2) return;
      for (const item of value.namedChildren) {
        if (item.type !== "array_element_initializer") continue;
        const parts = item.namedChildren;
        const keyed = parts.length === 2;
        const element = parts[parts.length - 1];
        if (!element) continue;
        const keyNode = keyed ? parts[0]! : null;
        const literal = keyNode ? (plainString(keyNode) ?? (keyNode.type === "integer" ? keyNode.text : null)) : null;
        const to: ValueCell[] = [];
        for (const t of target) {
          to.push(elementOf(t));
          if (literal !== null && /^\w+$/.test(literal)) to.push(elementOf(t, literal));
        }
        this.assign(to, element, lineOf(element), depth + 1);
      }
      return;
    }
    const v = this.valuesOf(value);
    for (const t of target) this.fill(t, v, line);
  }

  private invokeLabel(n: Node): string {
    return n.text.replace(/^\(|\)$/g, "").replace(/\$/g, "").replace(/\??->/g, ".").replace(/\[(['"])?(\w*)\1\]/g, (_, __, k: string) => `[${k}]`);
  }

  private invoke(cellNode: Node, call: string, line: number): void {
    const cell = this.cellFor(cellNode);
    if (cell) this.facts.push({ kind: "invoke", cell, call, line });
  }

  private callFacts(n: Node): void {
    const line = lineOf(n);
    if (n.type === "function_call_expression") {
      const fn = n.childForFieldName("function") ?? n.namedChildren[0];
      if (fn && fn.type !== "name" && fn.type !== "qualified_name" && !firstClassCallable(n)) {
        // `$f(…)`, `($this->h)(…)`, `$m['a'](…)`: a held value runs.
        const held = fn.type === "parenthesized_expression" ? fn.namedChildren[0] : fn;
        if (held && ["variable_name", "member_access_expression", "subscript_expression"].includes(held.type)) {
          this.invoke(held, this.invokeLabel(held), line);
          this.argFacts(n, this.invokeLabel(held), line);
        }
        return;
      }
    }
    const name = phpCallHooks.resolveCallName?.(n);
    if (!name || firstClassCallable(n)) return;
    const bare = name.replace(/^\\/, "");
    const callbackAt = Object.hasOwn(CALLBACK_FUNCTIONS, bare) ? CALLBACK_FUNCTIONS[bare]! : -1;
    if (callbackAt >= 0) {
      const arg = argsOf(n)[callbackAt];
      const value = arg ? argValue(arg) : null;
      // A closure handed to a builtin that runs it is a block: its calls are already the enclosing function's.
      if (value && !CLOSURES.has(value.type)) this.invoke(value, name, line);
      return;
    }
    this.argFacts(n, name, line);
  }

  private argFacts(n: Node, call: string, line: number): void {
    argsOf(n).forEach((arg, index) => {
      const value = argValue(arg);
      if (!value || arg.text.startsWith("...")) return;
      const from = this.cellFor(value);
      if (from) this.facts.push({ kind: "arg", call, line, index, from });
    });
  }

  walk(n: Node): void {
    if (DECLARATIONS.has(n.type)) return;
    let pushed = false;
    if (CLOSURES.has(n.type)) {
      // A closure's own parameters hide same-named variables of the function around it.
      const names = new Set<string>();
      for (const p of n.childForFieldName("parameters")?.namedChildren ?? []) {
        const v = p.childForFieldName("name") ?? p.namedChildren.find((c) => c.type === "variable_name");
        if (v) names.add(v.text.replace(/^\$/, ""));
      }
      this.shadow.push(names);
      pushed = true;
    }
    // A closure's own statements (its returns, its locals) are not the function around it's.
    const inClosure = this.shadow.length > 0;
    if (n.type === "assignment_expression" && !inClosure) {
      const left = n.childForFieldName("left") ?? n.namedChildren[0];
      const right = n.childForFieldName("right") ?? n.namedChildren[1];
      if (left && right && right.type !== "assignment_expression") this.assign(this.targetsOf(left), right, lineOf(n));
    } else if (n.type === "foreach_statement") {
      const [source, binding] = n.namedChildren;
      const valueVar = binding?.type === "pair" ? binding.namedChildren[1] : binding;
      if (source && valueVar && valueVar.type === "variable_name") {
        const src = this.cellOf(source, "");
        const to = this.cellOf(valueVar);
        if (src && to) this.facts.push({ kind: "copy", from: src, to, line: lineOf(n) });
      }
    } else if (n.type === "return_statement" && !inClosure) {
      const value = n.namedChildren[0];
      if (value) {
        const v = this.valuesOf(value);
        // `return f()` hands on what `f` returns only through its own result cell: not read.
        if (v.cells.length > 0 || v.seeds.length > 0) {
          const from = v.seeds.length === 0 && v.cells.length === 1 ? v.cells[0]! : this.tempCell(lineOf(n));
          if (v.seeds.length > 0 || v.cells.length > 1) this.fill(from, { cells: v.cells, seeds: v.seeds, results: [] }, lineOf(n));
          this.facts.push({ kind: "return", from, line: lineOf(n) });
        }
      }
    }
    if (CALL_NODES.has(n.type)) this.callFacts(n);
    for (const c of n.namedChildren) this.walk(c);
    if (pushed) this.shadow.pop();
  }
}

/** The element cell of `cell`: a list's `[]` (a `this.x`'s is `x[]`), or the one a literal key names. */
function elementOf(cell: ValueCell, key?: string): ValueCell {
  const suffix = key === undefined ? "[]" : `[${key}]`;
  if (cell.member === undefined) return { name: cell.name, member: key === undefined ? "[]" : key };
  return { name: cell.name, member: `${cell.member}${suffix}` };
}

/** The value-flow facts of one function or method body, or undefined when it states none. */
export function extractPhpValueFlow(body: Node | null, params: readonly string[]): ValueFlowFact[] | undefined {
  if (!body) return undefined;
  const reader = new Reader(params);
  reader.walk(body);
  const facts = liveValueFlow(reader.facts, params, { bindBases: true });
  return facts.length > 0 ? facts : undefined;
}
