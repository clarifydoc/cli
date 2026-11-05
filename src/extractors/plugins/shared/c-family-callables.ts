import type { FunctionInfo } from "../../../types/analysis.js";

/** A callable a function binds by name: where its scope ends, as `[line, column]` (0-based), or its whole body. */
interface Binding {
  name: string;
  from: [number, number];
  to: [number, number];
}

/** `(*kick)(int)`: a function pointer, whether a parameter or a local. */
const POINTER = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/g;
/** `auto kick = [](int x) { … }`: a lambda held by a local. */
const LAMBDA = /\bauto\s*[&*]*\s*([A-Za-z_]\w*)\s*=\s*\[/g;
/** `std::function<int(int)> kick`: a value that is called. */
const FUNCTION_VALUE = /\b(?:std\s*::\s*)?function\s*<[^;{}]*>\s*[&*]*\s*([A-Za-z_]\w*)\b(?!\s*::)/g;

/**
 * The regex reading of what the ANTLR front end marks `CallInfo.boundLocally`: a bare call of a name the function
 * binds itself — a function-pointer parameter or local, a lambda or `std::function` local — is a call of that value,
 * never of the file's function of that name. The line scan records one call per name, so a name is marked only when
 * EVERY call of it in the function sits inside a binding's scope (a parameter's: the whole body; a local's: to the
 * end of its block); a name called both there and outside stays as the scan read it.
 *
 * `code` is the file's lines with comments and strings blanked; `fns` carry `line`/`endLine` (1-based) and `calls`.
 */
export function markLocalCallables(code: readonly string[], fns: readonly FunctionInfo[]): void {
  for (const fn of fns) {
    if (fn.calls.length === 0) continue;
    const bindings = bindingsOf(code, fn);
    if (bindings.length === 0) continue;
    for (const name of new Set(bindings.map((b) => b.name))) {
      const call = fn.calls.find((c) => c.name === name && !c.receiverType && !c.boundLocally && !c.passed);
      if (!call) continue;
      const mine = bindings.filter((b) => b.name === name);
      const sites = callSites(code, fn, name);
      if (sites.length > 0 && sites.every(([l, c]) => mine.some((b) => !before(l, c, b.from) && before(l, c, b.to)))) call.boundLocally = true;
    }
  }
}

const before = (l: number, c: number, at: [number, number]): boolean => l < at[0] || (l === at[0] && c < at[1]);

/** Every bare call of `name` in the function's body (never `x.name(`, `x->name(`, `ns::name(`), as `[line, column]`. */
function callSites(code: readonly string[], fn: FunctionInfo, name: string): Array<[number, number]> {
  const re = new RegExp(String.raw`(?<![\w.>:$~])${name}\s*\(`, "g");
  const out: Array<[number, number]> = [];
  for (let i = fn.line - 1; i < Math.min(fn.endLine, code.length); i++) {
    for (const m of code[i]!.matchAll(re)) {
      out.push([i, m.index]);
    }
  }
  return out;
}

function bindingsOf(code: readonly string[], fn: FunctionInfo): Binding[] {
  const first = fn.line - 1;
  const last = Math.min(fn.endLine, code.length) - 1;
  const bindings: Binding[] = [];
  // Brace depth is tracked only to tell the signature (before the first `{`) from the body.
  let opened = false;
  for (let i = first; i <= last; i++) {
    const text = code[i]!;
    const found: Array<[string, number]> = [];
    for (const re of [POINTER, LAMBDA, FUNCTION_VALUE]) {
      re.lastIndex = 0;
      for (const m of text.matchAll(re)) found.push([m[1]!, m.index + m[0].length - m[1]!.length]);
    }
    found.sort((a, b) => a[1] - b[1]);
    let at = 0;
    for (const [name, col] of found) {
      for (; at < col; at++) if (text[at] === "{") opened = true;
      const from: [number, number] = opened ? [i, col] : [first, 0];
      // A parameter lasts to the function's end; a local to the `}` closing the block it is declared in.
      bindings.push({ name, from, to: opened ? blockEnd(code, i, col, last) : [last, Number.MAX_SAFE_INTEGER] });
    }
    for (; at < text.length; at++) if (text[at] === "{") opened = true;
  }
  return bindings;
}

/** The position of the `}` closing the block that holds `[line, col]`, or the function's end. */
function blockEnd(code: readonly string[], line: number, col: number, last: number): [number, number] {
  let level = 0;
  for (let i = line; i <= last; i++) {
    const text = code[i]!;
    for (let c = i === line ? col : 0; c < text.length; c++) {
      if (text[c] === "{") level++;
      else if (text[c] === "}") {
        if (level === 0) return [i, c];
        level--;
      }
    }
  }
  return [last, Number.MAX_SAFE_INTEGER];
}
