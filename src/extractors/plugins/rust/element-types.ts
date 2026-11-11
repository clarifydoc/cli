import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";

/**
 * Types a Rust body states without declaring them: the element a `for` loop or an iterator closure hands out
 * (`for c in &clubs`, `clubs.iter().map(|c| …)`), the payload a pattern takes out (`if let Some(c) = maybe`,
 * `match x { Some(c) => … }`), and what a std container chain yields (`clubs[0]`, `map.get(&k).unwrap()`,
 * `shared.lock().unwrap()`). Everything is read from types as WRITTEN in this file (parameters, typed `let`s, struct
 * fields, function results); anything else leaves the binding untyped, and a name bound to two types stays untyped.
 */
export interface RustTypeEnv {
  /** `Type.field` → the field's type as written. */
  fields: ReadonlyMap<string, string>;
  /** Free functions of this file → their return type as written. */
  returns: ReadonlyMap<string, string>;
}

/** Types that are not a project class a member call can land on. */
const NOT_CLASSES: ReadonlySet<string> = new Set([
  "String", "str", "bool", "char", "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64",
  "Value", "Vec", "Option", "Result", "HashMap", "HashSet", "BTreeMap", "BTreeSet", "VecDeque", "Self", "Box", "Arc", "Rc", "Mutex", "RwLock",
  "RefCell", "Cell", "Iter", "Pair", "Unit",
]);

/** `& 'a mut Vec<Club>` → `Vec<Club>`. */
function bare(type: string): string {
  return type.trim().replace(/^(?:&\s*(?:'\w+\s+)?(?:mut\s+)?|\*(?:const|mut)\s+|mut\s+|dyn\s+)+/, "").trim();
}

/** `std::sync::Arc<Mutex<Club>>` → name `Arc`, args [`Mutex<Club>`]; `[Club]` / `[Club; 3]` → `Slice`. */
function generic(type: string): { name: string; args: string[] } | null {
  const t = bare(type);
  if (t.startsWith("[")) {
    const inner = t.slice(1, t.lastIndexOf("]"));
    const semi = topLevel(inner, ";");
    return { name: "Slice", args: [(semi >= 0 ? inner.slice(0, semi) : inner).trim()] };
  }
  const m = /^((?:[A-Za-z_]\w*::)*([A-Za-z_]\w*))\s*<(.*)>$/s.exec(t);
  if (!m) return null;
  return { name: m[2]!, args: splitTop(m[3]!) };
}

function topLevel(text: string, char: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth--;
    else if (c === char && depth === 0) return i;
  }
  return -1;
}

function splitTop(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (let at = topLevel(rest, ","); at >= 0; at = topLevel(rest, ",")) {
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

const SMART = new Set(["Arc", "Rc", "Box", "Cow"]);

/** A smart pointer's target (`Arc<X>` → `X`), repeatedly. */
function deref(type: string): string {
  let t = bare(type);
  for (let i = 0; i < 4; i++) {
    const g = generic(t);
    if (!g || !SMART.has(g.name) || g.args.length === 0) break;
    t = bare(g.args[0]!);
  }
  return t;
}

/** The class a type names for a member call: `Club`, `Arc<Club>`, `model::Club`; null for a std type or a primitive. */
export function classOfType(type: string | null | undefined): string | null {
  if (!type) return null;
  const t = deref(type);
  const g = generic(t);
  const head = g ? t.slice(0, t.indexOf("<")).trim() : t;
  if (!/^(?:[A-Za-z_]\w*::)*[A-Z]\w*$/.test(head)) return null;
  return NOT_CLASSES.has(head.split("::").pop()!) ? null : t;
}

/** What iterating a value hands out: one item, or a (key-or-index, item) pair. */
export type Yield = { kind: "one"; item: string } | { kind: "pair"; item: string };

const ITERATORS = new Set(["iter", "iter_mut", "into_iter", "drain", "values", "values_mut", "into_values"]);
const KEEPING = new Set(["filter", "skip", "take", "rev", "cloned", "copied", "peekable", "skip_while", "take_while", "chain", "step_by", "inspect", "by_ref", "into_iter", "iter", "iter_mut"]);
const ITEM_OUT = new Set(["next", "last", "nth", "find", "max", "min", "max_by_key", "min_by_key", "max_by", "min_by", "next_back", "peek"]);

/** The yield of iterating `type` directly (`for x in type`), or null. */
export function yieldOf(type: string): Yield | null {
  const t = deref(type);
  const g = generic(t);
  if (!g) return null;
  switch (g.name) {
    case "Vec": case "VecDeque": case "HashSet": case "BTreeSet": case "BinaryHeap": case "Slice": case "LinkedList":
      return g.args[0] ? { kind: "one", item: g.args[0] } : null;
    case "HashMap": case "BTreeMap": case "IndexMap":
      return g.args[1] ? { kind: "pair", item: g.args[1] } : null;
    case "Iter":
      return g.args[0] ? { kind: "one", item: g.args[0] } : null;
    case "Pair":
      return g.args[0] ? { kind: "pair", item: g.args[0] } : null;
    default:
      return null;
  }
}

/** The type after calling `method` on a value of `type`, or null when this reading does not know it. */
export function stepType(type: string, method: string): string | null {
  const t = deref(type);
  const g = generic(t);
  if (!g) return null;
  const y = yieldOf(t);
  if (ITERATORS.has(method) && y) return y.kind === "one" ? `Iter<${y.item}>` : g.name === "Iter" || g.name === "Pair" ? t : `Pair<${y.item}>`;
  if (g.name === "Iter" || g.name === "Pair") {
    if (KEEPING.has(method)) return t;
    if (method === "enumerate" && g.name === "Iter") return `Pair<${g.args[0]}>`;
    if (ITEM_OUT.has(method) && g.name === "Iter") return `Option<${g.args[0]}>`;
    return null;
  }
  switch (g.name) {
    case "Vec": case "VecDeque": case "Slice": case "BinaryHeap":
      if (/^(?:get|get_mut|first|last|first_mut|last_mut|pop|pop_front|pop_back|front|back|front_mut|back_mut|peek)$/.test(method)) return `Option<${g.args[0]}>`;
      break;
    case "HashMap": case "BTreeMap": case "IndexMap":
      if (/^(?:get|get_mut|remove)$/.test(method)) return `Option<${g.args[1]}>`;
      break;
    case "Option":
      if (/^(?:unwrap|expect|unwrap_or_default|unwrap_unchecked)$/.test(method)) return g.args[0] ?? null;
      if (/^(?:as_ref|as_mut|as_deref|as_deref_mut|cloned|copied|take|clone)$/.test(method)) return t;
      break;
    case "Result":
      if (/^(?:unwrap|expect|unwrap_or_default)$/.test(method)) return g.args[0] ?? null;
      break;
    case "Mutex": case "RwLock":
      if (/^(?:lock|read|write|try_lock|try_read|try_write)$/.test(method)) return `Result<${g.args[0]}>`;
      if (method === "get_mut") return `Result<${g.args[0]}>`;
      break;
    case "RefCell":
      if (/^(?:borrow|borrow_mut)$/.test(method)) return g.args[0] ?? null;
      break;
    default:
      break;
  }
  return /^(?:clone|as_ref|as_mut|borrow|to_owned)$/.test(method) ? t : null;
}

/** Index of the matching close for the bracket at `open` (`(`, `[`, `{`), or -1. */
function matching(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The type of an expression written as a field path and std steps: `clubs`, `self.clubs`, `self.shared.lock().unwrap()`,
 * `clubs[0]`, `map.get(&k).unwrap()`, `make()`, `maybe?`. Null when any step is not read.
 */
export function exprType(expr: string, env: RustTypeEnv, selfType: string | null, typeOfName: (name: string) => string | null): string | null {
  let text = expr.trim().replace(/^(?:&\s*(?:mut\s+)?|\*)+/, "").trim();
  const head = /^(self|[A-Za-z_]\w*)\b/.exec(text);
  if (!head) return null;
  let at = head[0].length;
  let type: string | null;
  if (head[1] === "self") type = selfType;
  else if (text[at] === "(") {
    const close = matching(text, at);
    if (close < 0) return null;
    const ret = env.returns.get(head[1]!);
    type = ret ?? null;
    at = close + 1;
  } else type = typeOfName(head[1]!);
  while (at < text.length && type) {
    const rest = text.slice(at);
    const field = /^\s*\.\s*([A-Za-z_]\w*)\b(?!\s*\()/.exec(rest);
    if (field) {
      const owner = deref(type).replace(/<.*$/s, "").split("::").pop()!;
      type = env.fields.get(`${owner}.${field[1]}`) ?? null;
      at += field[0].length;
      continue;
    }
    const method = /^\s*\.\s*([A-Za-z_]\w*)\s*(?:::<[^>]*>)?\s*\(/.exec(rest);
    if (method) {
      const open = at + method[0].length - 1;
      const close = matching(text, open);
      if (close < 0) return null;
      type = stepType(type, method[1]!);
      at = close + 1;
      continue;
    }
    if (/^\s*\?/.test(rest)) {
      const g = generic(deref(type));
      type = g && (g.name === "Option" || g.name === "Result") ? g.args[0] ?? null : null;
      at += rest.indexOf("?") + 1;
      continue;
    }
    if (rest.startsWith("[")) {
      const close = matching(text, at);
      if (close < 0) return null;
      const y = yieldOf(type);
      type = y ? y.item : null;
      at = close + 1;
      continue;
    }
    if (/^\s*\.\s*await\b/.test(rest)) {
      at += rest.search(/await/) + 5;
      continue;
    }
    return null;
  }
  return at >= text.length ? type : null;
}

/** Split `body` into statements at `;`, `{` and `}` outside parentheses and brackets, each with its brace depth. */
function segments(text: string): Array<{ text: string; depth: number }> {
  const out: Array<{ text: string; depth: number }> = [];
  let depth = 0;
  let paren = 0;
  let start = 0;
  let segDepth = 0;
  const flush = (end: number): void => {
    const t = text.slice(start, end).trim();
    if (t) out.push({ text: t, depth: segDepth });
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[") paren++;
    else if (c === ")" || c === "]") paren--;
    else if (paren <= 0 && (c === ";" || c === "{" || c === "}")) {
      flush(i);
      if (c === "{") depth++;
      else if (c === "}") depth--;
      start = i + 1;
      segDepth = depth;
    }
  }
  flush(text.length);
  return out;
}

const CLOSURE_METHODS = new Set([
  "map", "for_each", "filter", "filter_map", "flat_map", "find", "find_map", "position", "any", "all", "take_while", "skip_while",
  "inspect", "max_by_key", "min_by_key", "partition", "try_for_each", "map_while", "retain",
]);

/** `|c|`, `|&c|`, `|(i, c)|`, `|mut c|` → the bound identifiers in order. */
function closureNames(params: string): string[] {
  return [...params.matchAll(/(?<![\w:])([a-z_]\w*)\b(?!\s*[:(])/g)].map((m) => m[1]!).filter((n) => n !== "mut" && n !== "ref" && n !== "_");
}

/**
 * Types for the bindings a loop, closure, pattern or std chain gives names in `fn`'s body, as `localTypes` entries
 * (`{ name, type }`), plus `receiverType` on calls whose chain ends on a known class.
 */
export function addRustElementTypes(fn: FunctionInfo, bodyLines: readonly string[], env: RustTypeEnv, selfType: string | null): void {
  const clean = bodyLines.map((l) => blankStringLiterals(l.replace(/\/\/.*$/, "")));
  const code = clean.join("\n");
  if (!/\bfor\b|\|[^|]*\||\blet\b|\bmatch\b|\[|\.unwrap|\.lock/.test(code)) return;
  const bound = new Map<string, Set<string | null>>();
  // Names a `for` binds over a field or a call's result the file does not type, and how often each name is bound.
  const elementFroms = new Map<string, Set<string>>();
  const bindCount = new Map<string, number>();
  const elementCount = new Map<string, number>();
  const bind = (name: string, type: string | null): void => {
    if (name === "_" || name === "self") return;
    bindCount.set(name, (bindCount.get(name) ?? 0) + 1);
    let set = bound.get(name);
    if (!set) bound.set(name, (set = new Set()));
    set.add(type === null ? null : bare(type));
  };
  for (const p of fn.params) if (p.type) bind(p.name, p.type);
  const typeOfName = (name: string): string | null => {
    const set = bound.get(name);
    if (!set) return null;
    return set.size === 1 ? [...set][0] ?? null : null;
  };
  const type = (expr: string): string | null => exprType(expr, env, selfType, typeOfName);
  const patternNames = (pattern: string): string[] => [...pattern.matchAll(/(?<![\w:])([a-z_]\w*)\b(?!\s*[:(])/g)].map((m) => m[1]!).filter((n) => n !== "mut" && n !== "ref" && n !== "_");
  const matches: Array<{ depth: number; type: string | null }> = [];

  for (const seg of segments(code)) {
    const s = seg.text;
    while (matches.length > 0 && matches[matches.length - 1]!.depth > seg.depth) matches.pop();
    // let [mut] name[: T] = rhs
    const let_ = /^let\s+(?:mut\s+)?([a-z_]\w*)\s*(?::\s*([^=]+?))?\s*=\s*([\s\S]*)$/.exec(s);
    if (let_ && !/^let\s+(?:Some|Ok|Err)\b/.test(s)) {
      const stated = let_[2] ? bare(let_[2]) : null;
      bind(let_[1]!, stated ?? type(let_[3]!));
    } else {
      const lp = /^(?:let|if\s+let|while\s+let)\s+(.+?)\s*(?::[^=]+)?=\s*([\s\S]*)$/.exec(s);
      if (lp) {
        // `if let Some(c) = maybe`, `while let Ok(c) = r`, `let (a, b) = …`
        const some = /^(?:Some|Ok)\(\s*(?:ref\s+|mut\s+)?&?([a-z_]\w*)\s*\)$/.exec(lp[1]!.trim());
        const payload = some ? type(lp[2]!.replace(/\s*$/, "")) : null;
        const g = payload ? generic(deref(payload)) : null;
        const item = g && (g.name === "Option" || g.name === "Result") ? g.args[0] ?? null : null;
        for (const n of patternNames(lp[1]!)) bind(n, some && n === some[1] ? item : null);
      }
      const forIn = /^for\s+(.+?)\s+in\s+([\s\S]+)$/.exec(s);
      if (forIn) {
        const t = type(forIn[2]!);
        const y = t ? yieldOf(t) : null;
        const pat = forIn[1]!.trim();
        const pair = /^\(\s*[^,()]+,\s*&?\s*(?:ref\s+|mut\s+)?([a-z_]\w*)\s*\)$/.exec(pat);
        const one = /^&?\s*(?:ref\s+|mut\s+)?([a-z_]\w*)$/.exec(pat);
        for (const n of patternNames(pat)) {
          bind(n, y && ((y.kind === "pair" && pair && n === pair[1]) || (y.kind === "one" && one && n === one[1])) ? y.item : null);
        }
        // Over a field or a call the file does not type (`for p in league.players()`): the element of the type that
        // declaration states, which the linker reads.
        const from = !t && one ? loopSourceText(forIn[2]!) : null;
        if (from) {
          const name = one![1]!;
          (elementFroms.get(name) ?? elementFroms.set(name, new Set()).get(name)!).add(from);
          elementCount.set(name, (elementCount.get(name) ?? 0) + 1);
        }
      }
      const matchHead = /^match\s+([\s\S]+)$/.exec(s);
      if (matchHead) matches.push({ depth: seg.depth + 1, type: type(matchHead[1]!) });
    }
    // Match arms: `Some(c) => …`, `Ok(c) => …`.
    if (s.includes("=>")) {
      const top = matches[matches.length - 1];
      for (const arm of s.matchAll(/(?:^|,|\})\s*(?:Some|Ok)\(\s*(?:ref\s+|mut\s+)?&?([a-z_]\w*)\s*\)\s*=>/g)) {
        const g = top?.type ? generic(deref(top.type)) : null;
        const item = g && (g.name === "Option" || g.name === "Result") && top?.depth === seg.depth ? g.args[0] ?? null : null;
        bind(arm[1]!, item);
      }
    }
    // Closure parameters of an iterator chain: `clubs.iter().map(|c| …)`.
    const handled = new Set<number>();
    for (const m of s.matchAll(/\.\s*([a-z_]\w*)\s*\(\s*(?:move\s*)?\|([^|]*)\|/g)) {
      handled.add(m.index! + m[0].indexOf("|"));
      if (!CLOSURE_METHODS.has(m[1]!)) {
        for (const n of closureNames(m[2]!)) bind(n, null);
        continue;
      }
      const chain = receiverChainBefore(s, m.index!);
      const t = chain ? type(chain) : null;
      const y = t ? yieldOf(t) : null;
      const names = closureNames(m[2]!);
      for (const n of names) bind(n, y && y.kind === "one" && names.length === 1 ? y.item : y && y.kind === "pair" && names.length === 2 && n === names[1] ? y.item : null);
    }
    // Any other closure keeps its parameters untyped (and shadows).
    for (const m of s.matchAll(/(?<![|\w])\|([^|()]*)\|\s*(?:\{|[a-zA-Z_(&*!])/g)) {
      if (handled.has(m.index! + m[0].indexOf("|"))) continue;
      for (const n of closureNames(m[1]!)) bind(n, null);
    }
  }

  // Calls whose receiver chain ends on a known class: `map.get(&k).unwrap().promote()`, `shared.lock().unwrap().promote()`.
  for (const call of fn.calls as CallInfo[]) {
    if (call.receiverType) continue;
    const parts = call.name.split(".");
    if (parts.length < 3 || !parts.slice(1, -1).every((p) => /^[a-z_]\w*\(\)$/.test(p))) continue;
    let t = typeOfName(parts[0]!) ?? (selfType ? env.fields.get(`${selfType}.${parts[0]}`) ?? null : null);
    for (const step of parts.slice(1, -1)) {
      if (!t) break;
      t = stepType(t, step.replace(/\(\)$/, ""));
    }
    const cls = classOfType(t);
    if (cls) call.receiverType = cls;
  }
  // `clubs[0].promote()` — an indexed receiver names no call; added when the element is known.
  addIndexedCalls(fn, clean, type);

  // A name the plugin's `let` pass left to the linker as a call's result (`from`) takes the type read here.
  let out = fn.localTypes ?? [];
  const typedNow = new Map<string, string>();
  for (const [name, set] of bound) {
    const t = set.size === 1 ? [...set][0] : null;
    const cls = classOfType(t);
    if (cls && !fn.params.some((p) => p.name === name)) typedNow.set(name, cls);
  }
  out = out.filter((l) => !(l.from && !l.type && typedNow.has(l.name)));
  const have = new Set(out.map((l) => l.name));
  for (const [name, cls] of typedNow) if (!have.has(name)) out.push({ name, type: cls });
  // Every binding of the name was such a loop, and nothing else says its type.
  for (const [name, froms] of elementFroms) {
    if (have.has(name) || typedNow.has(name) || fn.params.some((p) => p.name === name) || bindCount.get(name) !== elementCount.get(name)) continue;
    for (const from of froms) out.push({ name, type: "", from, element: true });
  }
  if (out.length > 0) fn.localTypes = out;
}

/**
 * What a `for` loops over when it is a field or a call's result, spelled as a receiver chain for `localTypes[].from`:
 * `&self.players`, `league.players()`, `self.roster.iter()`, `league.club(id).players()`. Null for a name the body
 * binds (it has its own type), a literal, a range, an index or any other expression.
 */
function loopSourceText(expr: string): string | null {
  const text = expr.trim().replace(/\s*\{[\s\S]*$/, "").replace(/^(?:&\s*(?:mut\s+)?)+/, "").replace(/\.(?:iter|iter_mut|into_iter)\(\)$/, "").trim();
  const head = /^[A-Za-z_]\w*/.exec(text);
  if (!head || /^(?:vec|Vec|String|Some|None)$/.test(head[0])) return null;
  let out = head[0];
  let rest = text.slice(head[0].length);
  let steps = 0;
  while (rest !== "") {
    const step = /^\.([A-Za-z_]\w*)/.exec(rest);
    if (!step) return null;
    out += `.${step[1]}`;
    rest = rest.slice(step[0].length);
    steps++;
    if (rest.startsWith("(")) {
      let depth = 0;
      let close = -1;
      for (let i = 0; i < rest.length && close < 0; i++) {
        if (rest[i] === "(") depth++;
        else if (rest[i] === ")" && --depth === 0) close = i;
      }
      if (close < 0) return null;
      out += "()";
      rest = rest.slice(close + 1);
    }
  }
  return steps > 0 ? out : null;
}

/** The expression text before `.method(` at `index`: the receiver chain that ends there, starting at its head. */
function receiverChainBefore(s: string, index: number): string | null {
  let start = index;
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = s[i]!;
    if (c === ")" || c === "]") depth++;
    else if (c === "(" || c === "[") {
      if (depth === 0) { start = i + 1; break; }
      depth--;
    } else if (depth === 0 && /[=,;{}]|=>/.test(c)) { start = i + 1; break; }
    else if (depth === 0 && /\s/.test(c) && /^\s*(?:let|in|return|else|if|match|while)\b/.test(s.slice(i))) { start = i + 1; break; }
    if (i === 0) start = 0;
  }
  const text = s.slice(start, index).trim().replace(/^(?:let\s+[\s\S]*?=|for\s+[\s\S]*?\bin\b|return\b|if\b|while\b|match\b)\s*/, "").trim();
  return text || null;
}

function addIndexedCalls(fn: FunctionInfo, lines: readonly string[], type: (expr: string) => string | null): void {
  const have = new Set(fn.calls.map((c) => `${c.line}:${c.name}`));
  for (let ln = fn.line; ln < fn.line + lines.length; ln++) {
    const code = lines[ln - fn.line];
    if (!code || !code.includes("].")) continue;
    for (const m of code.matchAll(/(?<![\w.)\]])((?:self\s*\.\s*)?[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\[/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matching(code, open);
      const after = close >= 0 ? /^\s*\.\s*([a-z_]\w*)\s*\(/.exec(code.slice(close + 1)) : null;
      if (!after) continue;
      const cls = classOfType(type(code.slice(m.index!, close + 1)));
      if (!cls) continue;
      const name = `${m[1]!.replace(/\s+/g, "").replace(/^self\./, "")}[].${after[1]}`;
      if (have.has(`${ln}:${name}`)) continue;
      have.add(`${ln}:${name}`);
      fn.calls.push({ name, kind: "internal", target: null, line: ln, column: m.index!, receiverType: cls });
    }
  }
}
