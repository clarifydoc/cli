/**
 * Nim source preparation. The spec reads lines, so what is not code is
 * blanked before extraction, line structure kept:
 *
 *  - `#[ … ]#` / `##[ … ]##` block comments (they nest);
 *  - the text of every `"""…"""` string that spans lines. An SQL statement
 *    there would otherwise read as code (`select name from person` → a
 *    command call of `select`), and a closing `"""` in column 0 would end the
 *    enclosing proc of an indentation-delimited language. Such a string
 *    becomes `""` on its first line; its SQL is read from the RAW source
 *    (`nimSqlLines`).
 *
 * Character literals (`'"'`) and one-line strings are stepped over so a quote
 * or `#` inside them opens nothing.
 */
export function blankNimNonCode(source: string): string {
  if (!source.includes("#[") && !source.includes('"""')) return source;
  const blank = (s: string): string => s.replace(/[^\r\n]/g, " ");
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    if (c === "#") {
      const block = source.startsWith("#[", i) ? 2 : source.startsWith("##[", i) ? 3 : 0;
      if (block) {
        const end = blockCommentEnd(source, i);
        out += blank(source.slice(i, end));
        i = end;
        continue;
      }
      // A line comment: kept as written (the spec's comment prefixes see it).
      const nl = lineEnd(source, i);
      const end = nl < 0 ? source.length : nl;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (source.startsWith('"""', i)) {
      const close = tripleClose(source, i + 3);
      const end = close < 0 ? source.length : close + 3;
      const literal = source.slice(i, end);
      // One-line triple strings stay: the line scanner reads them as strings.
      out += /[\r\n]/.test(literal) ? '""' + blank(literal.slice(2)) : literal;
      i = end;
      continue;
    }
    if (c === '"') {
      const end = stringEnd(source, i);
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      const ch = /^'(?:\\(?:x[0-9A-Fa-f]{2}|\d+|.)|[^'\\\n])'/.exec(source.slice(i, i + 8));
      if (ch) {
        out += ch[0];
        i += ch[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** End (exclusive) of the block comment opening at `start`, honouring nesting. */
function blockCommentEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "#" && source[i + 1] === "[") {
      depth++;
      i++;
    } else if (source[i] === "]" && source[i + 1] === "#") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/**
 * Index of the `"""` closing a long string whose body starts at `from`. The
 * closing quotes may be preceded by more quotes that belong to the text
 * (`""""` ends the string with a quote), so the LAST three of a run close it.
 */
function tripleClose(source: string, from: number): number {
  let k = source.indexOf('"""', from);
  if (k < 0) return -1;
  while (source[k + 3] === '"') k++;
  return k;
}

/** End (exclusive) of the one-line string opening at `start` (`\` escapes; a raw `r"…"` doubles its quotes). */
function stringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    const c = source[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === '"') return i + 1;
    if (c === "\n") return i;
  }
  return source.length;
}

/**
 * The raw source in the C-like shape the shared SQL scanner reads: every Nim
 * string — `"…"`, `sql"…"`, `r"…"`, and each line of a `"""…"""` block —
 * written as one `"…"` literal, comments dropped, and a `;` closing each line
 * that ends a statement (Nim has no terminator; a line ending in `&`, `,` or
 * an open bracket carries on). One output line per input line.
 */
export function nimSqlLines(lines: string[]): string[] {
  const out: string[] = [];
  let inTriple = false;
  const lit = (t: string): string => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  for (const line of lines) {
    let code = "";
    let i = 0;
    if (inTriple) {
      const close = line.indexOf('"""');
      if (close < 0) {
        out.push(lit(line));
        continue;
      }
      code += lit(line.slice(0, close));
      i = close + 3;
      while (line[i] === '"') i++;
      inTriple = false;
    }
    for (; i < line.length; i++) {
      const c = line[i]!;
      if (c === "#") break;
      if (line.startsWith('"""', i)) {
        const close = line.indexOf('"""', i + 3);
        if (close < 0) {
          code += lit(line.slice(i + 3));
          inTriple = true;
          break;
        }
        code += lit(line.slice(i + 3, close));
        i = close + 2;
        continue;
      }
      if (c === '"') {
        let text = "";
        let j = i + 1;
        for (; j < line.length && line[j] !== '"'; j++) {
          if (line[j] === "\\") {
            text += line[j + 1] ?? "";
            j++;
          } else text += line[j];
        }
        code += lit(text);
        i = j;
        continue;
      }
      if (c === "'") {
        const ch = /^'(?:\\.|[^'\\])'/.exec(line.slice(i, i + 4));
        if (ch) {
          i += ch[0].length - 1;
          continue;
        }
      }
      code += c;
    }
    out.push(inTriple || /(?:[,(\[{&=+]|\band|\bor)\s*$/.test(code) ? code : code + ";");
  }
  return out;
}

/**
 * 1-based last line of the indented block opened on line `i` (0-based): the
 * line before the next code line indented no deeper, or the file's last code
 * line. Two things the generic indent finder gets wrong for Nim:
 *
 *  - it gives up 20 lines into a block nothing dedents after, which cut a
 *    module's last routine — and a Jester `routes:` block, usually the
 *    module's tail — short;
 *  - a signature wrapped over several lines often closes its parameter list
 *    in column 0 (`) {.async.} =`), which it read as the end of the routine.
 *    The block starts after the declaration head has closed its brackets.
 */
export function nimBlockEnd(lines: string[], i: number): number {
  const indent = /^\s*/.exec(lines[i]!)![0].length;
  for (let j = headEnd(lines, i) + 1; j < lines.length; j++) {
    const text = lines[j]!.trim();
    if (text === "" || text.startsWith("#")) continue;
    if (/^\s*/.exec(lines[j]!)![0].length <= indent) return j;
  }
  let end = lines.length;
  while (end > i + 1 && lines[end - 1]!.trim() === "") end--;
  return end;
}

/** 0-based line on which the declaration head opened on line `i` closes its brackets. */
function headEnd(lines: string[], i: number): number {
  let depth = 0;
  for (let j = i; j < Math.min(lines.length, i + 40); j++) {
    const code = lines[j]!.replace(/"(?:[^"\\\n]|\\.)*"|'(?:\\.|[^'\\])'|#.*$/g, "");
    for (const ch of code) depth += ch === "(" || ch === "[" || ch === "{" ? 1 : ch === ")" || ch === "]" || ch === "}" ? -1 : 0;
    if (depth <= 0) return j;
  }
  return i;
}

/** Index of the line terminator (`\n` or a lone `\r`) at or after `from`, or -1. */
function lineEnd(source: string, from: number): number {
  EOL.lastIndex = from;
  return EOL.exec(source)?.index ?? -1;
}
const EOL = /[\r\n]/g;
