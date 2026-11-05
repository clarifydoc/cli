import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";
import { GO_TYPE_KEYWORDS, matchingClose, stripGoComment } from "./syntax.js";

/**
 * What a Go function's body can say about the type of a name it does not declare with one: the element a collection
 * hands out (`for _, c := range clubs`, `c := clubs[0]`, `c := <-ch`), the type an assertion names, and the types a
 * same-file declaration gives a field or a package variable. Everything here reads types as WRITTEN, in this file.
 */
export interface GoTypeEnv {
  /** `Type.field` → the field's type as written. */
  fields: ReadonlyMap<string, string>;
  /** Package-level variables of this file → their type as written (stated, or an initializer's). */
  packageVars: ReadonlyMap<string, string>;
  /** Same-file functions → their result types. */
  results: ReadonlyMap<string, readonly string[]>;
}

/** Builtin and predeclared type names: an element of one of them has no member a call can land on. */
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  "string", "bool", "byte", "rune", "error", "any", "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16",
  "uint32", "uint64", "uintptr", "float32", "float64", "complex64", "complex128",
]);

/** A type that names a declared type a member call can land on: `Club`, `*Club`, `model.Club`. */
export function namesGoType(type: string | null | undefined): boolean {
  const t = (type ?? "").trim().replace(/^\*/, "");
  if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(t)) return false;
  const leaf = t.split(".").pop()!;
  return !GO_TYPE_KEYWORDS.has(leaf) && !BUILTIN_TYPES.has(t);
}

export interface GoCollection {
  kind: "slice" | "map" | "chan";
  key: string | null;
  /** The element (a map's value, a channel's payload), as written. */
  value: string;
}

/** `[]Club`, `[]*Club`, `[3]Club`, `map[string]*Club`, `chan Club`, `<-chan Club`, behind one pointer. */
export function goCollection(type: string | null | undefined): GoCollection | null {
  const t = (type ?? "").trim().replace(/^\*/, "");
  const slice = /^\[\s*(?:\d+|\.\.\.)?\s*\]\s*(.+)$/.exec(t);
  if (slice) return element("slice", null, slice[1]!);
  if (t.startsWith("map[")) {
    const close = matchingClose(t, 3);
    if (close < 0) return null;
    return element("map", t.slice(4, close), t.slice(close + 1));
  }
  const chan = /^(?:<-\s*)?chan\s*(?:<-\s*)?(.+)$/.exec(t);
  if (chan) return element("chan", null, chan[1]!);
  return null;
}

function element(kind: GoCollection["kind"], key: string | null, value: string): GoCollection | null {
  const v = value.trim();
  return namesGoType(v) ? { kind, key, value: v } : null;
}

/** `T` of a composite literal or `make(T, …)` that builds a collection: `[]Club{…}`, `map[string]*Club{}`, `make(chan *Club, 4)`. */
export function collectionBuilt(rhs: string): string | null {
  const text = rhs.trim().replace(/;\s*$/, "").replace(/^&/, "");
  const made = /^make\s*\(/.exec(text);
  if (made) {
    const close = matchingClose(text, made[0].length - 1);
    if (close !== text.length - 1) return null;
    const first = splitTop(text.slice(made[0].length, close))[0]?.trim() ?? "";
    return goCollection(first) ? first : null;
  }
  const open = literalOpen(text);
  if (open < 0) return null;
  const type = text.slice(0, open).trim();
  return goCollection(type) && matchingClose(text, open) === text.length - 1 ? type : null;
}

/** Index of the `{` that opens the composite literal a collection type starts, or -1. */
function literalOpen(text: string): number {
  if (!/^(?:\[|map\s*\[)/.test(text)) return -1;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "{" && depth === 0) return i;
    else if (c === "(" || c === ")" || c === "=") return -1;
  }
  return -1;
}

function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** The type a `T{…}` / `&T{…}` composite literal of a named type builds, or null. */
export function structLiteralType(expr: string): string | null {
  const text = expr.trim().replace(/;\s*$/, "");
  const m = /^(&?)\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/.exec(text);
  if (!m || !namesGoType(m[2]) || matchingClose(text, m[0].length - 1) !== text.length - 1) return null;
  return m[2]!;
}

/**
 * The type of an expression as far as this file states it. `typeOfName` answers for a bare name (a local, a parameter,
 * the receiver, a package variable). Handles field chains (`l.clubs`, `l.squad.members`), an index (`m[k]`,
 * `l.clubs[0]`), a call of a same-file function, and a collection built in place.
 */
export function goExprType(expr: string, env: GoTypeEnv, typeOfName: (name: string) => string | null): string | null {
  let text = expr.trim().replace(/;\s*$/, "");
  if (!text) return null;
  const built = collectionBuilt(text);
  if (built) return built;
  // An index: the element of what is indexed.
  if (text.endsWith("]")) {
    const open = openingBracket(text);
    if (open <= 0) return null;
    const base = goExprType(text.slice(0, open), env, typeOfName);
    const coll = goCollection(base);
    return coll && coll.kind !== "chan" ? coll.value : null;
  }
  // A call of a same-file function: its (single) result.
  const call = /^([A-Za-z_]\w*)\s*\(/.exec(text);
  if (call) {
    if (matchingClose(text, call[0].length - 1) !== text.length - 1) return null;
    const results = env.results.get(call[1]!);
    return results && results.length === 1 ? results[0]! : null;
  }
  text = text.replace(/^\(\s*(.*?)\s*\)$/, "$1");
  const chain = /^[A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*$/.test(text) ? text.split(".").map((s) => s.trim()) : null;
  if (!chain) return null;
  let type = typeOfName(chain[0]!);
  for (const field of chain.slice(1)) {
    if (!type) return null;
    const owner = type.trim().replace(/^\*/, "").split(".").pop()!;
    type = env.fields.get(`${owner}.${field}`) ?? null;
  }
  return type;
}

/** Index of the `[` matching the last `]` of `text`, or -1. */
function openingBracket(text: string): number {
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i]!;
    if (c === "]") depth++;
    else if (c === "[" && --depth === 0) return i;
  }
  return -1;
}

/**
 * The type a short declaration's right side gives its first variable through an element or an assertion, or null:
 * `m[k]` / `clubs[0]` (the element), `<-ch` (the payload), `x.(*Club)` (the asserted type).
 */
export function goElementInit(rhs: string, env: GoTypeEnv, typeOfName: (name: string) => string | null): string | null {
  const text = rhs.trim().replace(/;\s*$/, "");
  if (text.startsWith("<-")) {
    const coll = goCollection(goExprType(text.slice(2), env, typeOfName));
    return coll?.kind === "chan" ? coll.value : null;
  }
  const assert = /\.\(\s*([^()]+?)\s*\)$/.exec(text);
  if (assert && assert[1] !== "type") {
    const head = text.slice(0, assert.index);
    return head && /^[\w.\[\]()*&"' ]+$/.test(head) && namesGoType(assert[1]) ? assert[1]! : null;
  }
  if (text.endsWith("]") && !/^\[|^map\s*\[/.test(text)) {
    const type = goExprType(text, env, typeOfName);
    return namesGoType(type) ? type : null;
  }
  return null;
}

/**
 * Calls whose receiver no name spells — `clubs[0].Promote()`, `m["a"].Promote()`, `(&Club{}).Promote()`,
 * `Club{}.Promote()` — which neither front end names. When the receiver's type is known from this file they are added
 * as `<head>[].Promote` (`Club.Promote` for a literal) carrying the type as `receiverType`.
 */
export function addExpressionReceiverCalls(
  fn: FunctionInfo,
  lines: readonly string[],
  env: GoTypeEnv,
  typeOfName: (name: string) => string | null,
): void {
  const have = new Set(fn.calls.map((c) => `${c.line}:${c.name}`));
  for (let ln = fn.line; ln <= Math.min(fn.endLine, lines.length); ln++) {
    const code = stripGoComment(lines[ln - 1] ?? "");
    if (!code.includes(").") && !code.includes("].") && !code.includes("}.")) continue;
    const found: Array<{ name: string; type: string; column: number }> = [];
    // `(&Club{}).Promote(` / `(Club{}).Promote(`
    for (const m of code.matchAll(/\(\s*&?\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/g)) {
      const open = code.indexOf("{", m.index!);
      const close = matchingClose(code, open);
      const after = close >= 0 ? /^\s*\)\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(code.slice(close + 1)) : null;
      if (after && namesGoType(m[1]) && structLiteralType(code.slice(m.index! + 1, close + 1))) {
        found.push({ name: `${m[1]}.${after[1]}`, type: m[1]!, column: m.index! });
      }
    }
    // `Club{}.Promote(`
    for (const m of code.matchAll(/(?<![\w.)\]])([A-Z]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchingClose(code, open);
      const after = close >= 0 ? /^\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(code.slice(close + 1)) : null;
      if (after && namesGoType(m[1]) && !/^\s*(?:if|for|switch|func)\b/.test(code.slice(0, m.index!))) {
        found.push({ name: `${m[1]}.${after[1]}`, type: m[1]!, column: m.index! });
      }
    }
    // `head[...].Promote(` / `a.b[0].Promote(`
    for (const m of code.matchAll(/(?<![\w.)\]])([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\[/g)) {
      const open = m.index! + m[0].length - 1;
      const close = matchingClose(code, open);
      const after = close >= 0 ? /^\s*\.\s*([A-Za-z_]\w*)\s*\(/.exec(code.slice(close + 1)) : null;
      if (!after) continue;
      const type = goExprType(code.slice(m.index!, close + 1), env, typeOfName);
      if (namesGoType(type)) found.push({ name: `${m[1]!.replace(/\s+/g, "")}[].${after[1]}`, type: type!, column: m.index! });
    }
    for (const f of found) {
      if (have.has(`${ln}:${f.name}`)) continue;
      have.add(`${ln}:${f.name}`);
      const call: CallInfo = {
        name: f.name,
        kind: "internal",
        target: null,
        line: ln,
        column: f.column,
        receiverType: f.type,
      };
      fn.calls.push(call);
    }
  }
}
