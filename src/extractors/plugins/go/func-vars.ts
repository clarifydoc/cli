import type { ParamInfo } from "../../../types/analysis.js";
import { extractParamsFromDeclaration, inlineBodyColumn, type ParamParser } from "../shared/regex-base.js";
import { goResultTextAt, goSignatureAt } from "./syntax.js";

/**
 * Package-level function variables, read off the lines for the regex reading (the ANTLR reading takes them from the
 * parse, antlr.ts). `var saveClub = func(name string) { … }`, an entry `saveClub = func(…) { … }` of a top-level
 * `var ( … )` block, and an initializer that hands a function literal on (`var handler = http.HandlerFunc(func(w, r)
 * { … })`) declare a function named for the var: the literal's body runs whenever the var is called or served. Not
 * one whose literal is invoked on the spot (`var cfg = func() Config { … }()`, run once at package init), one
 * binding several names (`var a, b = …`), nor the blank `_`.
 */

/** A spec's head: the name, then an optional type, then the `=` (never `==`). */
const SPEC_HEAD = /^(\s*(?:var\s+)?)([A-Za-z_]\w*)\b([^=]*?)=(?!=)/;

/** A function literal's `func (`: not a method expression, a field, a word's tail, or a slice/map element type. */
const FUNC_LITERAL = /(?<![\w.\]*])func\s*\(/g;

const cache = new WeakMap<readonly string[], ReadonlyMap<number, string>>();

/**
 * The package-level function variables of a file whose comments and literals are blanked (`code`, one entry per
 * source line): 0-based line of the var's name → the name.
 */
export function goFuncVars(code: readonly string[]): ReadonlyMap<number, string> {
  let found = cache.get(code);
  if (found) return found;
  const out = new Map<number, string>();
  const text = code.join("\n");
  const starts: number[] = [];
  for (let i = 0, at = 0; i < code.length; i++) {
    starts.push(at);
    at += code[i]!.length + 1;
  }
  let depth = 0;
  let inBlock = false;
  for (let i = 0; i < code.length; i++) {
    const line = code[i]!;
    if (depth === 0 && /^var\s*\(/.test(line)) inBlock = true;
    else if ((depth === 0 && /^var\s/.test(line)) || (inBlock && depth === 1 && /^\s+[A-Za-z_]/.test(line))) {
      const name = funcVarAt(text, starts[i]!, line);
      if (name) out.set(i, name);
    }
    for (const c of line) {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
    }
    if (depth <= 0) {
      depth = Math.max(depth, 0);
      inBlock = false;
    }
  }
  found = out;
  cache.set(code, found);
  return found;
}

/** The name of the function variable a spec starting at `start` declares, or null. */
function funcVarAt(text: string, start: number, line: string): string | null {
  const head = SPEC_HEAD.exec(line);
  if (!head || head[2] === "_" || head[2] === "var" || /^\s*,/.test(head[3]!)) return null;
  const from = start + head[0].length;
  const end = initializerEnd(text, from);
  FUNC_LITERAL.lastIndex = from;
  for (let m = FUNC_LITERAL.exec(text); m && m.index < end; m = FUNC_LITERAL.exec(text)) {
    const sig = goSignatureAt(text, m.index + m[0].length - 1);
    if (!sig || sig.bodyEnd > end) continue;
    // `func() Config { … }()` runs at package init: its calls are the package's own.
    if (/^\s*\(/.test(text.slice(sig.bodyEnd + 1, sig.bodyEnd + 40))) {
      FUNC_LITERAL.lastIndex = sig.bodyEnd + 1;
      continue;
    }
    return head[2]!;
  }
  return null;
}

/** Where the initializer starting at `from` ends: the line break or `;` at its own depth, or the block's `)`. */
function initializerEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth < 0) return i;
    } else if ((c === "\n" || c === ";") && depth === 0) return i;
  }
  return text.length;
}

/**
 * Where a function variable's own body starts on its declaration line (`RegexLangSpec.inlineBodyColumn`): after the
 * `{` of the literal written on it — so the initializer around it (`http.HandlerFunc(`) is no call of the function
 * — or -1 when the literal's body opens on a later line. Any other declaration: the shared rule.
 */
export function goInlineBodyColumn(line: string, from: number): number {
  if (!/^\s*(?:var\s+)?[A-Za-z_]\w*$/.test(line.slice(0, from))) return inlineBodyColumn(line, from);
  const literal = literalAt(line, from);
  if (!literal) return -1;
  // The body's `{`: past the parameter list and any result type's own braces (`interface{}`).
  const head = goResultTextAt(line, literal.paren);
  return head && head.bodyOpen >= 0 ? head.bodyOpen + 1 : -1;
}

/** The first function literal after the `=` past `from`: where its `func` and its parameter list's `(` are. */
function literalAt(line: string, from: number): { func: number; paren: number } | null {
  const eq = /=(?!=)/.exec(line.slice(from));
  if (!eq) return null;
  FUNC_LITERAL.lastIndex = from + eq.index + 1;
  const m = FUNC_LITERAL.exec(line);
  return m ? { func: m.index, paren: m.index + m[0].length - 1 } : null;
}

/**
 * A function variable's parameters: those of the literal on its declaration line (`func(w http.ResponseWriter, r
 * *http.Request)`), never a `func(string)` the var's type spells before the `=`. None when the literal starts below.
 */
export function goFuncVarParams(lines: string[], i: number, name: string, parseParam: ParamParser): ParamInfo[] {
  const line = lines[i] ?? "";
  const at = line.indexOf(name);
  if (at < 0) return [];
  const literal = literalAt(line, at + name.length);
  if (!literal) return [];
  return extractParamsFromDeclaration([line.slice(literal.func), ...lines.slice(i + 1)], 0, "func", parseParam);
}
