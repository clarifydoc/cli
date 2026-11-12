import type { ClassInfo, FunctionInfo, ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { liveValueFlow } from "../shared/value-flow-live.js";
import { splitTopLevel } from "../shared/regex-base.js";

/**
 * Ruby value-flow facts (see `ValueFlowFact`) read from a method's code lines (strings kept, comments and
 * heredocs blanked): `method(:save)` is the value a function has here; it moves through locals, instance
 * variables, hash and array literals, constants, arguments (`run(f)`, `run(&method(:save))`), returns (`return f`,
 * the last expression) and block variables (`handlers.each { |h| … }`), and runs through `f.call(…)` / `f.(…)` /
 * `block.call(…)`.
 *
 * A bare identifier is a call, never a value: only a name the method binds (a parameter or an assignment) is a
 * cell. A brace lambda or proc held in a value (`cb = -> { save }`, `@on_done = lambda { refresh_table }`,
 * `{ a: -> { Club.close } }`, `return proc { kick_off }`) stands for the project functions its body calls, at most
 * four, spelled as `method(:x)` is (`self.save`, `Club.close`); one that runs a held value (`-> { on_done.call }`)
 * copies that value's cell. It is no function of its own — its calls already belong to the method that writes it
 * — and a call on its parameters, a stdlib or kernel method, or a receiver that is a variable states nothing. A
 * `do … end` closure and a block handed to a method are no value here. `.call` on a receiver whose type is stated (`@runner = Runner.new`) is a method call the type decides,
 * never an invoke; `x[…]` runs a value only when `x` was assigned a function in the same method.
 */

const KEYWORDS = new Set(["if", "unless", "while", "until", "case", "when", "return", "yield", "puts", "print", "raise", "rescue", "ensure", "else", "elsif", "then", "do", "end", "def", "class", "module", "begin", "and", "or", "not", "in", "for", "break", "next", "self", "nil", "true", "false", "require", "require_relative", "include", "extend", "attr_reader", "attr_writer", "attr_accessor", "private", "public", "protected", "super", "lambda", "proc", "method"]);

/** Kernel methods and standard classes a closure body may call: no project function. */
const KERNEL_CALLS = new Set(["puts", "print", "p", "pp", "raise", "fail", "sleep", "rand", "srand", "sprintf", "printf", "loop", "block_given?", "binding", "catch", "throw", "Integer", "Float", "String", "Array", "Hash", "Rational", "gets", "exit", "abort", "at_exit", "lambda", "proc", "caller", "warn", "require_relative", "yield", "freeze", "dup", "clone", "tap", "then", "itself"]);
const STDLIB_CONSTS = new Set(["Time", "File", "Dir", "JSON", "Math", "Kernel", "Rails", "Array", "Hash", "String", "Integer", "Float", "Struct", "Set", "Date", "DateTime", "Process", "Thread", "Mutex", "ENV", "ARGV", "IO", "Object", "Comparable", "Enumerable", "Regexp", "Random", "SecureRandom", "YAML", "Logger", "Digest", "Base64", "URI", "Net", "ObjectSpace", "Signal", "Marshal", "Rational", "Complex", "Symbol", "Proc", "Method", "Class", "Module", "Fiber", "Queue", "STDOUT", "STDERR", "STDIN", "Benchmark", "Open3", "FileUtils", "Pathname", "ERB", "CGI", "Timeout", "Forwardable"]);
const CLOSURE_HEAD = /^(?:->\s*(?:\(([^)]*)\)|([A-Za-z_][\w\s,*&=]*?))?\s*\{|(?:lambda|proc|Proc\.new)\s*\{)/;

/** Names in a parameter list text (`a, b = 1, *rest, &blk, k:`). */
const paramNames = (text: string): string[] => text.split(",").map((x) => /^\s*[*&]*([a-z_]\w*)/.exec(x)?.[1]).filter((x): x is string => !!x);
/** A line with its string literals emptied, so what is inside one is no call. */
const blankStrings = (text: string): string => text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');

interface Values { cells: ValueCell[]; seeds: string[]; results: Array<{ call: string; line: number }> }

const IDENT = "[a-z_]\\w*";
const stripSigil = (name: string): string => name.replace(/^[&*]+/, "");

/** Statements of the lines `from..to` (0-based, exclusive end): a bracket left open, a trailing comma or a `\` continues one. */
function statementsOf(code: readonly string[], from: number, to: number): Array<{ text: string; line: number; offsets: number[] }> {
  const out: Array<{ text: string; line: number; offsets: number[] }> = [];
  let cur: { text: string; line: number; offsets: number[] } | null = null;
  let depth = 0;
  for (let i = from; i < to && i < code.length; i++) {
    // Comments are already blanked in the code lines; a `#` left is inside a string (`"#{id}"`).
    const raw = code[i] ?? "";
    if (!cur && raw.trim() === "") continue;
    if (!cur) cur = { text: "", line: i + 1, offsets: [] };
    cur.offsets.push(cur.text.length);
    cur.text += (cur.text ? " " : "") + raw.trim();
    let quote: string | null = null;
    for (const ch of raw) {
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if ("([{".includes(ch)) depth++;
      else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    }
    if (depth > 0 || /[,\\]$|\|\|$|&&$/.test(raw.trim())) continue;
    out.push(cur);
    cur = null;
  }
  if (cur) out.push(cur);
  return out;
}

/** The text from `start` (just after an opening bracket) to its matching close, or null. */
function balanced(text: string, start: number, open: string, close: string): { inner: string; end: number } | null {
  let depth = 1;
  let quote: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === open) depth++;
    else if (ch === close && --depth === 0) return { inner: text.slice(start, i), end: i };
  }
  return null;
}

class Reader {
  facts: ValueFlowFact[] = [];
  /** Names the method binds: parameters, then assignments read so far. */
  readonly locals = new Set<string>();
  /** Locals assigned a function value directly (`f = method(:save)`). */
  private readonly seeded = new Set<string>();
  private readonly paramNames = new Map<string, string>();
  private temp = 0;
  /** Receiver names whose type the method or class states: `.call` on them is an ordinary method call. */
  private readonly typed = new Set<string>();

  selfName = "self";

  constructor(fn: FunctionInfo | null, cls: ClassInfo | null, private readonly module: boolean) {
    for (const p of fn?.params ?? []) {
      this.paramNames.set(stripSigil(p.name), p.name);
      if (!p.name.startsWith("*")) this.locals.add(stripSigil(p.name));
      if (p.type) this.typed.add(stripSigil(p.name));
    }
    for (const l of fn?.localTypes ?? []) if (l.type && !l.field) this.typed.add(l.name);
    for (const l of fn?.localTypes ?? []) if (l.type && l.field) this.typed.add(`@${l.name}`);
    for (const p of cls?.properties ?? []) if (p.type) this.typed.add(`@${p.name}`);
  }

  private cellOfName(name: string): ValueCell | null {
    if (name.startsWith("@@")) return null;
    if (name.startsWith("@")) return this.module ? null : { name: "self", member: name.slice(1) };
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) return { name };
    if (!this.locals.has(name)) return null;
    return { name: this.paramNames.get(name) ?? name };
  }

  /** The cell a variable, ivar, constant or an element of one names (`h[:k]`, `@h[i]`). */
  cellOf(text: string): ValueCell | null {
    const t = text.trim();
    const el = /^(@?@?[A-Za-z_]\w*)\s*\[([^\[\]]*)\]$/.exec(t);
    if (el) return this.element(el[1]!, el[2]!);
    const self = /^self\.([a-z_]\w*)$/.exec(t);
    if (self) return this.module ? null : { name: "self", member: self[1]! };
    if (/^@{0,2}[A-Za-z_]\w*$/.test(t)) return this.cellOfName(t);
    return null;
  }

  private element(base: string, index: string): ValueCell | null {
    const b = this.cellOfName(base);
    if (!b) return null;
    const key = this.keyOf(index);
    return elementOf(b, key);
  }

  private keyOf(index: string): string | undefined {
    const m = /^\s*(?::([A-Za-z_]\w*)|'([^']*)'|"([^"]*)")\s*$/.exec(index);
    const k = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    return k !== undefined && /^\w+$/.test(k) ? k : undefined;
  }

  /** `x.call` label: the name a call extractor gives (`@runner.run` is `runner.run`). */
  private label(text: string): string {
    return text.replace(/@/g, "").replace(/\s+/g, "");
  }

  /** What an expression holds. */
  valuesOf(expr: string, line: number, into: Values = { cells: [], seeds: [], results: [] }): Values {
    let e = expr.trim();
    const closure = this.closureOf(e);
    if (closure) { this.closureValues(closure, into); return into; }
    // A trailing `if`/`unless` modifier, never one inside a string literal.
    if (!/["']/.test(e)) e = e.replace(/\s+(?:if|unless)\s+.*$/, "");
    if (e === "") return into;
    // `flag ? a : b` holds either branch.
    const tern = /^[^?]+?\s\?\s+(.+?)\s+:\s+(.+)$/.exec(e);
    if (tern && !/["']/.test(e.split("?")[0]!)) {
      this.valuesOf(tern[1]!, line, into);
      this.valuesOf(tern[2]!, line, into);
      return into;
    }
    const alternatives = splitTop(e, "||");
    if (alternatives.length > 1) {
      for (const part of alternatives) this.valuesOf(part, line, into);
      return into;
    }
    if (e.startsWith("(") && e.endsWith(")")) return this.valuesOf(e.slice(1, -1), line, into);
    const m = /^(?:(self|[A-Z][\w:]*|@?[a-z_]\w*)\.)?method\(\s*:([A-Za-z_]\w*[?!]?)\s*\)$/.exec(e);
    if (m) {
      const recv = m[1];
      into.seeds.push(!recv || recv === "self" ? `${this.selfName ? `${this.selfName}.` : ""}${m[2]}` : `${recv.replace(/^@/, "")}.${m[2]}`);
      return into;
    }
    const cell = this.cellOf(e);
    if (cell) { into.cells.push(cell); return into; }
    // `Foo.make(1)`, `obj.make`, `make(1)`: what the call returns.
    const call = /^((?:@?[A-Za-z_]\w*(?:::\w+)*\.)?[a-z_]\w*[?!]?)\s*(\(.*\))?$/.exec(e);
    // The parenthesis must close at the very end: `f(a) + g(b)` is no call result.
    const closed = !call?.[2] || balanced(e, e.indexOf("(") + 1, "(", ")")?.end === e.length - 1;
    if (call && closed && !KEYWORDS.has(call[1]!) && !(this.locals.has(call[1]!) && !call[1]!.includes("."))) {
      into.results.push({ call: this.label(call[1]!), line });
    }
    return into;
  }

  /** `-> { … }`, `->(a) { … }`, `lambda { |a| … }`, `proc { … }`, `Proc.new { … }` written whole: its parameters and body. */
  private closureOf(e: string): { params: Set<string>; body: string } | null {
    const m = CLOSURE_HEAD.exec(e);
    if (!m) return null;
    const open = m[0].length - 1;
    const close = balanced(e, open + 1, "{", "}");
    if (!close || close.end !== e.length - 1) return null;
    let body = close.inner;
    const params = new Set(paramNames(m[1] ?? m[2] ?? ""));
    const block = /^\s*\|([^|]*)\|/.exec(body);
    if (block) { for (const n of paramNames(block[1]!)) params.add(n); body = body.slice(block[0].length); }
    return { params, body };
  }

  /** What a closure held in a value runs: the project functions its body calls, or the values it runs, at most four. */
  private closureValues(closure: { params: Set<string>; body: string }, into: Values): void {
    const body = blankStrings(closure.body);
    const hidden = new Set(closure.params);
    for (const m of body.matchAll(/(?:\{|\bdo)\s*\|([^|]*)\|/g)) for (const n of paramNames(m[1]!)) hidden.add(n);
    for (const m of body.matchAll(/(?<![\w@$.:])([a-z_]\w*)\s*(?:\|\||&&)?=(?![=~>])/g)) hidden.add(m[1]!);
    const seeds = new Set<string>();
    const cells = new Map<string, ValueCell>();
    for (const m of body.matchAll(/(?<![\w@$.:])(@?[a-z_]\w*)\.(?:call\b|\()/g)) {
      const head = m[1]!;
      if (hidden.has(head) || this.typed.has(head)) continue;
      const cell = this.cellOf(head);
      if (cell) cells.set(`${cell.name}.${cell.member ?? ""}`, cell);
    }
    const heldHeads = new Set([...cells.values()].map((c) => (c.member ?? c.name)));
    for (const m of body.matchAll(/(?<![\w@$.:])(@{0,2}[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*[?!]?)((?:\.[a-z_]\w*[?!]?)*)/g)) {
      const head = m[1]!;
      const tail = m[2]!;
      const after = body.slice((m.index ?? 0) + m[0].length);
      if (head.startsWith("@") || /^:(?!:)/.test(after) || /^\s*(?:\|\||&&)?=(?![=~>])/.test(after)) continue;
      if (/^[a-z_]/.test(head)) {
        if (tail !== "" || KEYWORDS.has(head) || KERNEL_CALLS.has(head) || hidden.has(head) || this.locals.has(head) || heldHeads.has(head)) continue;
        seeds.add(`self.${head}`);
      } else if (head === "self") {
        const one = /^\.([a-z_]\w*[?!]?)$/.exec(tail);
        if (one && one[1] !== "call") seeds.add(`self.${one[1]}`);
      } else if (/^[A-Z]/.test(head)) {
        const one = /^\.([a-z_]\w*[?!]?)$/.exec(tail);
        if (one && one[1] !== "new" && !STDLIB_CONSTS.has(head.split("::")[0]!)) seeds.add(`${head}.${one[1]}`);
      }
    }
    if (seeds.size + cells.size > 4) return;
    for (const fn of seeds) into.seeds.push(fn);
    for (const cell of cells.values()) into.cells.push(cell);
  }

  private tempCell(line: number): ValueCell {
    return { name: `%v${line}.${this.temp++}` };
  }

  private fill(to: ValueCell, v: Values, line: number): void {
    for (const from of v.cells) {
      this.facts.push({ kind: "copy", from, to, line });
      this.facts.push({ kind: "copy", from: elementOf(from), to: elementOf(to), line });
    }
    for (const fn of v.seeds) this.facts.push({ kind: "seed", to, fn, line });
    for (const r of v.results) this.facts.push({ kind: "result", call: r.call, line: r.line, to });
  }

  private cellFor(expr: string, line: number): ValueCell | null {
    const v = this.valuesOf(expr, line);
    if (v.seeds.length === 0 && v.results.length === 0) return v.cells.length === 1 ? v.cells[0]! : null;
    const to = this.tempCell(line);
    this.fill(to, v, line);
    return to;
  }

  /** Targets of a store to `lhs`: a literal key also fills the whole-collection cell a dynamic read meets. */
  targetsOf(lhs: string): ValueCell[] {
    const t = lhs.trim();
    const el = /^(@?@?[A-Za-z_]\w*)\s*\[([^\[\]]*)\]$/.exec(t);
    if (el) {
      const base = this.cellOfName(el[1]!);
      if (!base) return [];
      const key = this.keyOf(el[2]!);
      return key === undefined ? [elementOf(base)] : [elementOf(base, key), elementOf(base)];
    }
    const c = this.cellOf(t);
    return c ? [c] : [];
  }

  /** `target = value`, a hash or array literal read element by element. */
  assign(targets: ValueCell[], value: string, line: number, depth = 0): void {
    if (targets.length === 0) return;
    const v = value.trim();
    const literal = v.startsWith("{") && v.endsWith("}") ? "hash" : v.startsWith("[") && v.endsWith("]") ? "array" : null;
    if (literal) {
      if (depth > 2) return;
      for (const item of splitTopLevel(v.slice(1, -1))) {
        const text = item.trim();
        let key: string | undefined;
        let element = text;
        if (literal === "hash") {
          const kv = /^(?:([A-Za-z_]\w*):(?!:)|:([A-Za-z_]\w*)\s*=>|'([^']*)'\s*=>|"([^"]*)"\s*=>)\s*([\s\S]*)$/.exec(text);
          if (!kv) { if (/^\*\*/.test(text)) continue; element = text; }
          else { key = kv[1] ?? kv[2] ?? kv[3] ?? kv[4]; element = kv[5]!; }
        }
        const to: ValueCell[] = [];
        for (const t of targets) {
          to.push(elementOf(t));
          if (key !== undefined && /^\w+$/.test(key)) to.push(elementOf(t, key));
        }
        this.assign(to, element, line, depth + 1);
      }
      return;
    }
    const values = this.valuesOf(v, line);
    for (const t of targets) this.fill(t, values, line);
  }

  private bindLocal(name: string): void {
    if (/^[a-z_]\w*$/.test(name)) this.locals.add(name);
  }

  /** The call label a call extractor gives `recv.name`. */
  private invoke(recvText: string, line: number, call: string, argsText: string | null): void {
    const t = recvText.trim();
    const cell = this.cellOf(t);
    if (!cell) return;
    // An element read (`handlers[:save].call`) states which handler runs; a plain value needs a binding of its own.
    const head = /^(@?[A-Za-z_]\w*)/.exec(t)?.[1] ?? "";
    if (/^[A-Z]/.test(head) && !/^[A-Z_][A-Z0-9_]*$/.test(head)) return;
    if (this.typed.has(head) || this.typed.has(t)) return;
    this.facts.push({ kind: "invoke", cell, call, line });
    if (argsText !== null) this.argFacts(argsText, call, line);
  }

  private argFacts(argsText: string, call: string, line: number): void {
    splitTopLevel(argsText).forEach((raw, index) => {
      const text = raw.trim();
      // A block argument (`&m`) binds the callee's `&blk` formal, which a written index cannot name: not stated.
      if (text === "" || text.startsWith("*") || text.startsWith("&") || /^[a-z_]\w*:\s/.test(text) || /=>/.test(text)) return;
      const from = this.cellFor(text, line);
      if (from) this.facts.push({ kind: "arg", call, line, index, from });
    });
  }

  /** One statement's facts. */
  statement(s: { text: string; line: number; offsets: number[] }): void {
    const text = s.text.trim();
    const line = s.line;
    // Block variables: `handlers.each { |h| … }` / `… do |h|`.
    const each = /^(@?[a-z_]\w*)(?:\.values)?\.(each|map|each_value|flat_map|select|reject|each_with_index|each_with_object)\b[^|]*\|\s*([^|]*)\|/.exec(text);
    if (each) {
      const params = each[3]!.split(",").map((p) => p.trim().replace(/^[*(]+|[)]+$/g, "")).filter(Boolean);
      const pick = each[2] === "each_with_index" || each[2] === "each_with_object" ? params[0] : (params.length > 1 && each[2] === "each" ? params[params.length - 1] : params[0]);
      const src = this.cellOf(each[1]!);
      if (src && pick && /^[a-z_]\w*$/.test(pick)) {
        this.bindLocal(pick);
        this.facts.push({ kind: "copy", from: elementOf(src), to: { name: this.paramNames.get(pick) ?? pick }, line });
      }
    }
    // `return x` and `x = …`.
    const ret = /^return\s+(.*)$/.exec(text);
    if (ret) { this.returnFact(ret[1]!, line); }
    const asg = findAssignment(text);
    if (asg) {
      const targets = this.targetsOf(asg.lhs);
      if (/^[a-z_]\w*$/.test(asg.lhs.trim())) this.bindLocal(asg.lhs.trim());
      const v = asg.rhs.trim();
      this.assign(targets.length > 0 ? targets : /^[a-z_]\w*$/.test(asg.lhs.trim()) ? [{ name: this.paramNames.get(asg.lhs.trim()) ?? asg.lhs.trim() }] : [], v, line);
      if (/^[a-z_]\w*$/.test(asg.lhs.trim()) && (/^(?:(?:self|[A-Z][\w:]*|@?[a-z_]\w*)\.)?method\(/.test(v) || this.closureOf(v))) this.seeded.add(asg.lhs.trim());
    }
    this.callFacts(text, line, s);
  }

  private returnFact(expr: string, line: number): void {
    const v = this.valuesOf(expr, line);
    if (v.cells.length === 0 && v.seeds.length === 0) return;
    const from = v.seeds.length === 0 && v.cells.length === 1 ? v.cells[0]! : this.tempCell(line);
    if (v.seeds.length > 0 || v.cells.length > 1) this.fill(from, { cells: v.cells, seeds: v.seeds, results: [] }, line);
    this.facts.push({ kind: "return", from, line });
  }

  /** The value of a method's last expression, when it is one of ours. */
  implicitReturn(text: string, line: number): void {
    if (/^(?:return|if|unless|while|until|case|begin|end|else|elsif|when|puts|raise)\b/.test(text)) return;
    if (/^(?:(?:self|[A-Z][\w:]*|@?[a-z_]\w*)\.)?method\(\s*:\w+[?!]?\s*\)$/.test(text) || (/^@?[a-z_]\w*$/.test(text) && (text.startsWith("@") || this.locals.has(text))) || /^@?[a-z_]\w*\[[^\[\]]*\]$/.test(text) || this.closureOf(text)) this.returnFact(text, line);
  }

  private callFacts(text: string, line: number, s: { text: string; line: number; offsets: number[] }): void {
    // The line a call token is on, for a statement spanning lines.
    const lineAt = (index: number): number => {
      let l = s.line;
      for (let i = 0; i < s.offsets.length; i++) if (s.offsets[i]! <= index) l = s.line + i;
      return l;
    };
    void line;
    // `x.call(…)` / `x.(…)`: a held value runs.
    for (const m of text.matchAll(/(@?[A-Za-z_]\w*(?:\s*\[[^\[\]]*\])?)\.(call\b|\()/g)) {
      const at = lineAt(m.index ?? 0);
      const recv = m[1]!;
      const isCall = m[2] === "call";
      const rest = text.slice((m.index ?? 0) + m[0].length - (isCall ? 0 : 1));
      const open = rest.startsWith("(") ? balanced(rest, 1, "(", ")") : null;
      this.invoke(recv, at, this.label(`${recv}.call`), open ? open.inner : null);
    }
    // `x[…]` runs a value this method put in `x`.
    for (const m of text.matchAll(/(?<![\w.@:])([a-z_]\w*)\[([^\[\]]*)\]/g)) {
      if (!this.seeded.has(m[1]!) || /^\s*[:'"]/.test(m[2]!)) continue;
      this.invoke(m[1]!, lineAt(m.index ?? 0), `${m[1]}[]`, m[2]!);
    }
    // Arguments of a call: `run(g)`, `@runner.run(f, 3)`, `Club.make(&method(:x))`.
    for (const m of text.matchAll(/(?<![\w@:$])((?:@?[A-Za-z_]\w*(?:::\w+)*\.)?[a-z_]\w*[?!]?)\(/g)) {
      const name = m[1]!;
      if (KEYWORDS.has(name) || /\.(?:call|method)$/.test(name)) continue;
      const open = balanced(text, (m.index ?? 0) + m[0].length, "(", ")");
      if (!open) continue;
      this.argFacts(open.inner, this.label(name), lineAt(m.index ?? 0));
    }
    // A command call: `run f, 4` / `@runner.run f`.
    const cmd = /^((?:@?[A-Za-z_]\w*(?:::\w+)*\.)?[a-z_]\w*[?!]?)\s+((?:[@&:\w][^=]*))$/.exec(text.replace(/^[a-z_]\w*\s*=\s*/, ""));
    if (cmd && !KEYWORDS.has(cmd[1]!) && !this.locals.has(cmd[1]!) && !/^(?:do|if|unless|and|or|then|\{)\b/.test(cmd[2]!) && !/[(){}]/.test(cmd[1]!) && !/^\w+:\s/.test(cmd[2]!)) {
      this.argFacts(cmd[2]!.replace(/\s+(?:do|if|unless)\b.*$/, ""), this.label(cmd[1]!), line);
    }
  }
}

/** Split on a separator outside brackets and quotes. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && text.startsWith(sep, i)) { out.push(cur); cur = ""; i += sep.length - 1; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** `lhs = rhs` / `lhs ||= rhs` at the statement's top level (not `==`, `=~`, `=>`, a keyword argument). */
function findAssignment(text: string): { lhs: string; rhs: string } | null {
  const m = /^(@{0,2}[A-Za-z_]\w*(?:\s*\[[^\[\]]*\])?|self\.[a-z_]\w*)\s*(?:\|\|)?=(?![=~>])\s*([\s\S]+)$/.exec(text);
  return m ? { lhs: m[1]!, rhs: m[2]! } : null;
}

/** The element cell of `cell`: a collection's `[]`, or the one a literal key names (a field's elements are `x[]` / `x[k]`). */
function elementOf(cell: ValueCell, key?: string): ValueCell {
  if (cell.member === undefined) return { name: cell.name, member: key === undefined ? "[]" : key };
  return { name: cell.name, member: `${cell.member}${key === undefined ? "[]" : `[${key}]`}` };
}

/** The value-flow facts of one method (or top-level function), or undefined when it states none. */
export function extractRubyValueFlow(code: readonly string[], fn: FunctionInfo, cls: ClassInfo | null): ValueFlowFact[] | undefined {
  if (fn.endLine <= fn.line) return undefined;
  const reader = new Reader(fn, cls, false);
  const statements = statementsOf(code, fn.line, fn.endLine - 1);
  if (statements.length === 0) return undefined;
  for (const s of statements) reader.statement(s);
  const last = statements[statements.length - 1]!;
  reader.implicitReturn(last.text.trim(), last.line);
  const facts = liveValueFlow(reader.facts, fn.params.filter((p) => !p.type).map((p) => p.name), { bindBases: true, localName: (n) => /^[a-z_]/.test(n), external: (n) => /^[A-Z]/.test(n) });
  return facts.length > 0 ? facts : undefined;
}

/**
 * The module-level constants that hold function values — `HANDLERS = { save: method(:save) }`, `ON_SAVE = method(:save)`
 * — read from the lines outside every method: they are the file's `moduleValueFlow`, which any method of the file
 * (or of a file requiring it) reads by the constant's name.
 */
export function extractRubyModuleValueFlow(code: readonly string[], methods: ReadonlyArray<{ line: number; endLine: number }>): ValueFlowFact[] {
  const inside = new Set<number>();
  for (const m of methods) for (let i = m.line - 1; i < m.endLine && i < code.length; i++) inside.add(i);
  const outside = code.map((l, i) => (inside.has(i) ? "" : l));
  if (!outside.some((l) => /^\s*[A-Z_][A-Z0-9_]*\s*(?:\[[^\]]*\]\s*)?(?:\|\|)?=(?![=~>])/.test(l))) return [];
  const reader = new Reader(null, null, true);
  // The class a statement is written in: `method(:save)` there names its own class method.
  const classAt: Array<string | undefined> = [];
  const stack: Array<{ indent: number; name: string }> = [];
  for (let i = 0; i < outside.length; i++) {
    const line = outside[i] ?? "";
    const open = /^(\s*)(?:class|module)\s+(?:<<\s*\w+|((?:::)?[A-Z]\w*(?:::[A-Z]\w*)*))/.exec(line);
    if (open) stack.push({ indent: open[1]!.length, name: open[2]?.replace(/^.*::/, "") ?? "self" });
    else {
      const end = /^(\s*)end\b/.exec(line);
      if (end && stack.length > 0 && stack[stack.length - 1]!.indent === end[1]!.length) stack.pop();
    }
    classAt[i] = stack.length > 0 ? stack[stack.length - 1]!.name : undefined;
  }
  for (const s of statementsOf(outside, 0, outside.length)) {
    const asg = findAssignment(s.text.trim());
    if (!asg || !/^[A-Z_][A-Z0-9_]*(?:\s*\[|$)/.test(asg.lhs.trim())) continue;
    reader.selfName = classAt[s.line - 1] ?? "";
    reader.assign(reader.targetsOf(asg.lhs), asg.rhs, s.line);
  }
  // A constant's elements are read by its name: bind it as the file's own, then keep what fills a constant.
  const filled = reader.facts.filter((f) => (f.kind === "seed" || f.kind === "copy") && /^[A-Z_]/.test(f.to.name) && !f.to.name.startsWith("%"));
  const binders = new Set<string>();
  const out: ValueFlowFact[] = [];
  for (const f of filled) {
    if (f.kind !== "seed" && f.kind !== "copy") continue;
    if (!binders.has(f.to.name)) { binders.add(f.to.name); out.push({ kind: "copy", from: { name: f.to.name }, to: { name: f.to.name }, line: f.line }); }
    out.push(f);
  }
  return out;
}
