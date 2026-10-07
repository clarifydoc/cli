/**
 * Fortran source normalization: one STATEMENT per line, so the line-based
 * extraction never sees a comment or half a statement.
 *
 *  - Fixed form (`.f`, `.for`, `.f77`, `.ftn`, `.fpp` — unless the text is
 *    plainly free form): `C`/`c`/`*`/`!`/`D` in column 1 is a comment, columns
 *    1–5 hold a label, a character in column 6 continues the previous line,
 *    columns 73+ are the sequence area; a leading tab starts the statement
 *    field (a digit after it continues).
 *  - Free form: `!` starts a comment (outside strings), a trailing `&`
 *    continues the statement on the next line (which may lead with `&`).
 *
 * A continued statement is joined onto its FIRST line and its continuation
 * lines are left empty, so every line keeps its number. Preprocessor lines
 * (`#ifdef`, `#include`) are blanked. String literals are kept.
 */

const FIXED_EXTENSIONS = /\.(?:f|for|f77|ftn|fpp)$/i;

/** Fixed form: by extension, unless a statement starts in column 1 with a letter fixed form reads as code nowhere. */
export function isFixedForm(path: string, lines: readonly string[]): boolean {
  if (!FIXED_EXTENSIONS.test(path)) return false;
  return !lines.some((l) => /^[A-BE-Za-be-z]/.test(l));
}

export function normalizeFortran(lines: readonly string[], fixed: boolean): string[] {
  const out = lines.map(() => "");
  /** Index of the line the statement being continued started on, or -1. */
  let current = -1;
  let carry = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (/^\s*#/.test(raw)) {
      out[i] = "";
      continue;
    }
    if (fixed) {
      if (raw.trim() === "" || /^[cC*!dD]/.test(raw)) continue;
      let text: string;
      let continuation: boolean;
      if (raw.startsWith("\t")) {
        continuation = /^\t[1-9]/.test(raw);
        text = continuation ? raw.slice(2) : raw.slice(1);
      } else {
        const tab = /^(\d{1,5})\t/.exec(raw);
        if (tab) {
          continuation = false;
          text = raw.slice(tab[0].length);
        } else {
          const col6 = raw[5] ?? " ";
          continuation = col6 !== " " && col6 !== "0" && raw.length > 5;
          text = raw.slice(6, 72);
        }
      }
      text = stripComment(text);
      if (text.trim() === "" && !continuation) continue;
      if (continuation && current >= 0) out[current] += " " + text.trim();
      else {
        out[i] = "      " + text.trimEnd();
        current = i;
      }
      continue;
    }
    // Free form.
    let text = stripComment(raw);
    if (text.trim() === "") continue;
    const continues = /&\s*$/.test(text);
    text = text.replace(/&\s*$/, "");
    if (carry && current >= 0) out[current] += " " + text.trim().replace(/^&\s*/, "");
    else {
      out[i] = text.trimEnd();
      current = i;
    }
    carry = continues;
  }
  return out;
}

/** The line without its `!` comment (a `!` inside a string is text). */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "!") return line.slice(0, i);
  }
  return line;
}
