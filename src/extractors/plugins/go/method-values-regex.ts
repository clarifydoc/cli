import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";

/**
 * The regex reading's counterpart of the ANTLR front end's method values (antlr.ts `withPassedValues`): a selector
 * on a value the function declares — its receiver, a parameter, a local — handed to a call as a whole argument
 * (`Wrap(h.Health)`, `s.Use(s.handler.Middleware)`) is a `passed: "argument"` name spelled as a call of it would
 * be (the last two names). A built-in or a formatting/logging package's call only reads its arguments, and a name
 * the function also calls is a call already.
 */
const VALUE_BUILTINS = new Set([
  "len", "cap", "make", "new", "delete", "copy", "clear", "close", "min", "max", "print", "println", "panic",
  "complex", "real", "imag", "string", "bool", "byte", "rune", "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64",
]);
const VALUE_PACKAGES = new Set(["fmt", "log", "slog", "errors", "strconv"]);
const SELECTOR_RE = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?(?:\.([A-Za-z_]\w*))?$/;

/** Top-level arguments of the call whose `(` is at `open` in `text` (strings are blanked by the caller). */
function argsAt(text: string, open: number): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        out.push({ text: text.slice(start, i), at: start });
        return out;
      }
    } else if (ch === "," && depth === 1) {
      out.push({ text: text.slice(start, i), at: start });
      start = i + 1;
    }
  }
  return [];
}

/** The names a function binds: receiver, parameters, `x := …`, `var x`. */
function boundNames(fn: FunctionInfo, signature: string, body: string): Set<string> {
  const bound = new Set<string>(fn.params.map((p) => p.name));
  const receiver = /^\s*func\s*\(\s*(\w+)\s/.exec(signature);
  if (receiver) bound.add(receiver[1]!);
  for (const m of body.matchAll(/(?:^|[;{\s])([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=/g)) for (const n of m[1]!.split(",")) bound.add(n.trim());
  for (const m of body.matchAll(/\bvar\s+([A-Za-z_]\w*)/g)) bound.add(m[1]!);
  bound.delete("_");
  return bound;
}

/** Adds the method values each function hands on as arguments; `codeLines` has strings and comments blanked. */
export function addRegexMethodValues(codeLines: readonly string[], fns: readonly FunctionInfo[]): void {
  for (const fn of fns) {
    if (fn.line < 1 || fn.endLine < fn.line || fn.name === "<setup>") continue;
    const slice = codeLines.slice(fn.line - 1, fn.endLine);
    const body = slice.join("\n");
    if (!body.includes(".")) continue;
    const bound = boundNames(fn, slice[0] ?? "", body);
    if (bound.size === 0) continue;
    const invoked = new Set(fn.calls.map((c) => c.name));
    const lineStarts: number[] = [];
    let offset = 0;
    for (const l of slice) {
      lineStarts.push(offset);
      offset += l.length + 1;
    }
    const added: CallInfo[] = [];
    for (const m of body.matchAll(/(?<![\w.])((?:[A-Za-z_]\w*\.)*[A-Za-z_]\w*)\s*\(/g)) {
      const callee = m[1]!;
      const head = callee.split(".")[0]!;
      if (!callee.includes(".") ? VALUE_BUILTINS.has(callee) : VALUE_PACKAGES.has(head)) continue;
      for (const arg of argsAt(body, m.index! + m[0].length - 1)) {
        const sel = SELECTOR_RE.exec(arg.text.trim());
        if (!sel || !bound.has(sel[1]!)) continue;
        const ids = sel.slice(1).filter((s): s is string => !!s);
        const name = ids.slice(-2).join(".");
        if (invoked.has(name)) continue;
        invoked.add(name);
        const at = arg.at + (arg.text.length - arg.text.trimStart().length);
        let row = 0;
        while (row + 1 < lineStarts.length && lineStarts[row + 1]! <= at) row++;
        added.push({ name, kind: "internal", target: null, line: fn.line + row, column: at - lineStarts[row]!, passed: "argument" });
      }
    }
    if (added.length > 0) fn.calls = [...fn.calls, ...added];
  }
}
