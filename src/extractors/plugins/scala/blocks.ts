import { braceCodeHooks, type BraceLexicon } from "../shared/brace-code.js";
import { findEndLine } from "../shared/regex-base.js";

/** Scala's literal forms: `"""` strings (no escapes, may span lines), quoted strings, character literals (a `'sym` is code). */
const SCALA_LEXICON: BraceLexicon = {
  lineComments: ["//"],
  blockComment: { open: "/*", close: "*/", nests: true },
  strings: [
    { open: '"""', close: '"""', escapes: false, multiline: true },
    { open: '"', close: '"', escapes: true, multiline: false },
  ],
  charLiterals: true,
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * Where the definition on line `i` ends, over blanked code. A body in braces
 * (`def f(x: Int) = {`, `class Club extends Base {`) ends at its `}`; any
 * other — Scala 3's `class Club:` / `def f =` with an indented body, a
 * one-line `def f = x + 1`, a `case class` with no body — ends at the last
 * line indented deeper than the header, or at its `end` marker.
 */
function scalaBlockEnd(code: string[], i: number): number {
  // The header: until its parameter lists and type arguments close.
  let depth = 0;
  let headEnd = i;
  let braceAt = -1;
  for (let k = i; k < Math.min(code.length, i + 30); k++) {
    const line = code[k]!;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "{" && depth === 0) {
        // A body brace follows only header text: `= {`, `extends A with B {` — not `= xs.map {`.
        const before = line.slice(0, c);
        const eq = before.lastIndexOf("=");
        if (eq < 0 || !before.slice(eq + 1).trim()) braceAt = k;
        break;
      }
    }
    headEnd = k;
    if (braceAt >= 0 || (depth <= 0 && !/(?:[,(\[]|\bextends|\bwith|=>)\s*$/.test(line.trimEnd()))) break;
  }
  if (braceAt >= 0) return findEndLine(code, braceAt, "brace");
  const base = indentOf(code[i]!);
  let end = headEnd + 1;
  for (let k = headEnd + 1; k < code.length; k++) {
    const line = code[k]!;
    if (!line.trim()) continue;
    const indent = indentOf(line);
    if (indent > base) {
      end = k + 1;
      continue;
    }
    if (indent === base && /^end\b/.test(line.trimStart())) end = k + 1;
    break;
  }
  return end;
}

/**
 * Block ends counted the way Scala nests — braces or indentation — over code
 * only, and the call scan's lines with `"""` strings and comments blanked.
 */
export const SCALA_CODE = braceCodeHooks(SCALA_LEXICON, undefined, scalaBlockEnd);
