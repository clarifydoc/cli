/**
 * Reading one line (or a window of lines) of a brace language as code: strings and the trailing
 * `//` comment blanked at the same columns, brackets matched, arguments and statements split at depth 0.
 * The line-based readers of several plugins (container registrations, typed locals) share these.
 */
import { blankStringLiterals } from "./regex-base.js";

/** A line with string contents and the trailing `//` comment blanked, same length. */
export function codeOf(line: string): string {
  const code = blankStringLiterals(line);
  const comment = code.indexOf("//");
  return comment < 0 ? code : code.slice(0, comment) + " ".repeat(code.length - comment);
}

/** Index just past the bracket that closes the one at `open`, or -1. */
export function closeOf(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  if (!pairs[code[open]!]) return -1;
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "{" || c === "[") stack.push(pairs[c]!);
    else if (c === ")" || c === "}" || c === "]") {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

/** Up to `span` lines from `i`, raw and code-only, joined so their columns align. */
export function window(lines: string[], i: number, span = 30): { raw: string; code: string } {
  const slice = lines.slice(i, Math.min(lines.length, i + span));
  return { raw: slice.join("\n"), code: slice.map(codeOf).join("\n") };
}

/** Split argument text at depth-0 commas, raw and code copies aligned. */
export function splitArgs(code: string, raw: string): Array<{ code: string; raw: string }> {
  const out: Array<{ code: string; raw: string }> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth = Math.max(0, depth - 1);
    if (i === code.length || (c === "," && depth === 0)) {
      if (code.slice(start, i).trim()) out.push({ code: code.slice(start, i), raw: raw.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
}

/**
 * The statements of one body line, raw and without its trailing comment:
 * split at top-level `;`, a one-line body's own braces dropped —
 * `{ val r = new PgRepo(); r.find(1) }` holds two.
 */
export function statementsOf(line: string): string[] {
  const cut = blankStringLiterals(line).indexOf("//");
  let src = cut < 0 ? line : line.slice(0, cut);
  const open = src.match(/^\s*\{/);
  if (open) {
    src = " ".repeat(open[0].length) + src.slice(open[0].length);
    const close = src.lastIndexOf("}");
    if (close >= 0 && src.slice(close + 1).trim() === "") src = src.slice(0, close);
  }
  const code = blankStringLiterals(src);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    if (i === code.length || (c === ";" && depth === 0)) {
      const part = src.slice(start, i);
      if (part.trim()) out.push(part);
      start = i + 1;
    }
  }
  return out;
}

/**
 * Does the statement ending on line `i` continue on the next code line — a
 * wrapped method chain or operator (`let h = Pipeline()` / `.addHandler(r)`)?
 * Then its first line does not state the value's type.
 */
export function continuedBelow(lines: readonly string[], i: number): boolean {
  for (let j = i + 1; j < lines.length; j++) {
    const t = lines[j]!.trim();
    if (t === "" || t.startsWith("//")) continue;
    return /^(?:\.|\?\?|\?|:|&&|\|\||[+\-*\/%](?!\/)|as\b|match\b)/.test(t);
  }
  return false;
}

/** Each body line's statements, with the line index and whether it is the line's last. */
export function statementsWithLine(bodyLines: string[], words: string[]): Array<[number, string, boolean]> {
  const out: Array<[number, string, boolean]> = [];
  bodyLines.forEach((l, i) => {
    if (!words.some((w) => l.includes(w))) return;
    const parts = statementsOf(l);
    parts.forEach((p, k) => out.push([i, p, k === parts.length - 1]));
  });
  return out;
}
