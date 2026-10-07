/**
 * V source preparation.
 *
 * `.v` is also Verilog (`module counter(input clk, …);` … `endmodule`) and
 * Coq (`Theorem x : …. Proof. … Qed.`) — both common enough that a repository
 * of either would otherwise be read as V. They are refused by content.
 *
 * What is not code is blanked before the line-based extraction, line
 * structure kept: `/* … *\/` comments (they nest) and the text of every
 * string that spans lines (help text, an SQL statement). One-line strings
 * stay — route paths and URLs are read from them. The SQL in strings is read
 * from the RAW source (`vSqlLines`).
 */

const VERILOG = /^\s*endmodule\b|^\s*(?:always|initial)\s*(?:@|begin\b)|^\s*(?:wire|reg|input|output|inout)\b[^\n=]*;|^\s*module\s+\w+\s*(?:#\s*)?\(/m;
const COQ = /^\s*(?:Proof\.|Qed\.|Defined\.|Require\s+(?:Import|Export)\b|From\s+\S+\s+Require\b|(?:Theorem|Lemma|Inductive|Fixpoint|Definition)\s+\w+[^\n]*(?::=|:)\s*$)/m;
/** What every V file has: a declaration V's grammar opens a line with. */
const V_DECLARATION = /^\s*(?:module\s+[\w.]+\s*$|import\s+[\w.]+|(?:pub\s+)?(?:fn|struct|interface|enum|const|type|union)\b)/m;

/** Why the file is not V source, or null when it is. A `.vsh` script is V by its extension alone. */
export function foreignVFile(source: string, path: string): string | null {
  if (/\.vsh$/i.test(path)) return null;
  if (COQ.test(source)) return "Coq proof script, not V";
  if (VERILOG.test(source)) return "Verilog module, not V";
  if (!V_DECLARATION.test(source)) return "no V declaration";
  return null;
}

export function blankVNonCode(source: string): string {
  if (!source.includes("/*") && !/['"][^'"\n]*\n/.test(source)) return source;
  const blank = (s: string): string => s.replace(/[^\r\n]/g, " ");
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      const nl = lineEnd(source, i);
      const end = nl < 0 ? n : nl;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      let depth = 0;
      let j = i;
      for (; j < n - 1; j++) {
        if (source[j] === "/" && source[j + 1] === "*") { depth++; j++; }
        else if (source[j] === "*" && source[j + 1] === "/") { depth--; j++; if (depth === 0) break; }
      }
      const end = Math.min(n, j + 1);
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }
    if (c === "`") {
      // A rune literal: `` `a` ``, `` `\n` ``, `` `'` ``.
      const rune = /^`(?:\\.|[^`\\\n])+`/.exec(source.slice(i, i + 12));
      if (rune) {
        out += rune[0];
        i += rune[0].length;
        continue;
      }
    }
    if (c === "'" || c === '"') {
      const end = stringEnd(source, i, /[rR]/.test(source[i - 1] ?? "") && !/\w/.test(source[i - 2] ?? ""));
      const literal = source.slice(i, end);
      const closed = literal.length > 1 && literal.endsWith(c);
      out += /[\r\n]/.test(literal) ? c + blank(literal.slice(1, closed ? -1 : undefined)) + (closed ? c : "") : literal;
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** End (exclusive) of the string opening at `start`; it may span lines. `${…}` holds code, a raw string has no escapes. */
function stringEnd(source: string, start: number, raw: boolean): number {
  const q = source[start]!;
  let depth = 0;
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i]!;
    if (!raw && c === "\\") { i++; continue; }
    if (!raw && c === "$" && source[i + 1] === "{") { depth++; i++; continue; }
    if (depth > 0) {
      if (c === "{") depth++;
      else if (c === "}") depth--;
      continue;
    }
    if (c === q) return i + 1;
  }
  return source.length;
}

/**
 * The raw source in the C-like shape the shared SQL scanner reads: every V
 * string — `'…'`, `"…"`, `r'…'`, each line of one that spans lines —
 * written as a `"…"` literal (an `${x}` interpolation becomes `(?)`, which no
 * table name can be: `from ${sql_table('Issue')}` names no table), comments
 * dropped, and a `;` closing each line that ends a statement (V has no
 * terminator; a line ending in `(`, `,`, `+` or `[` carries on). One output
 * line per input line.
 */
export function vSqlLines(lines: string[]): string[] {
  const out: string[] = [];
  const lit = (t: string): string => `"${t.replace(/\$\{[^}]*\}/g, " (?) ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  let open: string | null = null;
  for (const line of lines) {
    let code = "";
    let i = 0;
    if (open) {
      const close = line.indexOf(open);
      if (close < 0) {
        out.push(lit(line));
        continue;
      }
      code += lit(line.slice(0, close));
      i = close + 1;
      open = null;
    }
    for (; i < line.length; i++) {
      const c = line[i]!;
      if (c === "/" && line[i + 1] === "/") break;
      if (c === "`") {
        const rune = /^`(?:\\.|[^`\\])+`/.exec(line.slice(i, i + 8));
        if (rune) { i += rune[0].length - 1; continue; }
      }
      if (c !== "'" && c !== '"') {
        code += c;
        continue;
      }
      let text = "";
      let j = i + 1;
      for (; j < line.length && line[j] !== c; j++) {
        if (line[j] === "\\") { text += line[j + 1] ?? ""; j++; }
        else text += line[j];
      }
      code += lit(text);
      if (j >= line.length) {
        open = c;
        break;
      }
      i = j;
    }
    out.push(open || /[,(+\[{]\s*$/.test(code) ? code : code + ";");
  }
  return out;
}

/** Index of the line terminator (`\n` or a lone `\r`) at or after `from`, or -1. */
function lineEnd(source: string, from: number): number {
  EOL.lastIndex = from;
  return EOL.exec(source)?.index ?? -1;
}
const EOL = /[\r\n]/g;
