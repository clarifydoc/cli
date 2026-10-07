/**
 * D source preparation.
 *
 * `.d` is also the dependency file a C/C++ build writes beside each object
 * (`gcc -MD`: `build/main.o: src/main.c include/util.h \`). Those are refused:
 * a make rule's head opens the file, and a D module always has a `;`.
 *
 * What is not code is blanked before the line-based extraction, line
 * structure kept: `/* … *\/` and nesting `/+ … +/` comments, and the INSIDE
 * of the string forms whose text the line scanner would otherwise read as
 * code — WYSIWYG `` `…` `` and `r"…"`, delimited `q"(…)"` / heredoc
 * `q"EOS … EOS"`, token strings `q{…}`, and any `"…"` that spans lines. A
 * one-line `"…"` stays: route paths and URLs are read from those. The SQL in
 * strings is read from the RAW source (`dSqlLines`).
 */

/** A make dependency rule: `target.o [more targets]: prerequisites \`. */
const MAKE_RULE = /^[^\s:#][^:=]*?:(?!:)(?:\s|$)/;

/** Why the file is not D source, or null when it is. */
export function foreignDFile(source: string): string | null {
  const first = source.split(/\r\n|\r|\n/).find((l) => l.trim() !== "" && !/^\s*#/.test(l));
  if (first === undefined) return null;
  if (!source.includes(";") && MAKE_RULE.test(first)) return "make dependency file, not D";
  return null;
}

export function blankDNonCode(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const blank = (s: string): string => s.replace(/[^\r\n]/g, " ");
  /** Copy `text` with every character but line breaks and the kept delimiters blanked. */
  const keepDelims = (open: string, body: string, close: string): string => open + blank(body) + close;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const nl = lineEnd(source, i);
      const end = nl < 0 ? n : nl;
      out += source.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }
    if (c === "/" && next === "+") {
      const end = nestedCommentEnd(source, i);
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }
    if (c === "`") {
      const close = source.indexOf("`", i + 1);
      const end = close < 0 ? n : close;
      out += keepDelims("`", source.slice(i + 1, end), close < 0 ? "" : "`");
      i = end + 1;
      continue;
    }
    if ((c === "r" || c === "x") && next === '"' && !/\w/.test(source[i - 1] ?? "")) {
      const close = source.indexOf('"', i + 2);
      const end = close < 0 ? n : close;
      out += c + keepDelims('"', source.slice(i + 2, end), close < 0 ? "" : '"');
      i = end + 1;
      continue;
    }
    if (c === "q" && (next === '"' || next === "{") && !/\w/.test(source[i - 1] ?? "")) {
      const end = next === "{" ? tokenStringEnd(source, i + 1) : delimitedStringEnd(source, i + 1);
      out += blank(source.slice(i, end));
      i = end;
      continue;
    }
    if (c === '"') {
      const end = stringEnd(source, i);
      const literal = source.slice(i, end);
      const closed = literal.length > 1 && literal.endsWith('"');
      out += /[\r\n]/.test(literal) ? keepDelims('"', literal.slice(1, closed ? -1 : undefined), closed ? '"' : "") : literal;
      i = end;
      continue;
    }
    if (c === "'") {
      const ch = /^'(?:\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|&\w+;|\d{1,3}|.)|[^'\\\n])'/.exec(source.slice(i, i + 12));
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

/** End (exclusive) of the `/+ … +/` comment opening at `start`, honouring nesting. */
function nestedCommentEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length - 1; i++) {
    if (source[i] === "/" && source[i + 1] === "+") {
      depth++;
      i++;
    } else if (source[i] === "+" && source[i + 1] === "/") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}

/** End (exclusive) of the `"…"` string opening at `start` (escapes honoured; it may span lines). */
function stringEnd(source: string, start: number): number {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === '"') return i + 1;
  }
  return source.length;
}

/** End (exclusive) of a `q{ … }` token string whose `{` is at `open`. */
function tokenStringEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i + 1;
  }
  return source.length;
}

/**
 * End (exclusive) of a delimited string whose `"` is at `quote`: `q"(…)"`
 * with a bracket pair, `q"/…/"` with any other character, or a heredoc
 * `q"EOS` … a line starting with `EOS"`.
 */
function delimitedStringEnd(source: string, quote: number): number {
  const id = /^[A-Za-z_]\w*/.exec(source.slice(quote + 1, quote + 40));
  if (id && source[quote + 1 + id[0].length] === "\n") {
    const close = source.indexOf(`\n${id[0]}"`, quote);
    return close < 0 ? source.length : close + id[0].length + 2;
  }
  const open = source[quote + 1] ?? "";
  const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[open] ?? open;
  const at = source.indexOf(close + '"', quote + 2);
  return at < 0 ? source.length : at + 2;
}

/**
 * The raw source in the C-like shape the shared SQL scanner reads: every D
 * string — `"…"`, `` `…` ``, `r"…"`, `q"(…)"`, `q{…}` — written as `"…"`
 * literals, one per line a string spans, comments dropped. D ends its
 * statements with `;` itself, which is what the scanner looks for. One output
 * line per input line.
 */
export function dSqlLines(lines: string[]): string[] {
  const out: string[] = [];
  const lit = (t: string): string => `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  /** The delimiter that closes the string still open at the end of the previous line. */
  let open: string | null = null;
  let inComment = false;
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
      i = close + open.length;
      open = null;
    }
    for (; i < line.length; i++) {
      if (inComment) {
        const close = line.indexOf("*/", i);
        if (close < 0) break;
        inComment = false;
        i = close + 1;
        continue;
      }
      const c = line[i]!;
      if (c === "/" && line[i + 1] === "/") break;
      if (c === "/" && line[i + 1] === "*") {
        inComment = true;
        i++;
        continue;
      }
      let close: string | null = null;
      let from = i + 1;
      if (c === "`") close = "`";
      else if (c === '"') close = '"';
      else if ((c === "r" || c === "q") && line[i + 1] === '"' && !/\w/.test(line[i - 1] ?? "")) {
        if (c === "r") close = '"';
        else {
          const d = line[i + 2] ?? "";
          close = (({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[d] ?? d) + '"';
          from = i + 3;
        }
        if (c === "r") from = i + 2;
      } else if (c === "q" && line[i + 1] === "{" && !/\w/.test(line[i - 1] ?? "")) {
        close = "}";
        from = i + 2;
      }
      if (!close) {
        code += c;
        continue;
      }
      // Escapes only in a plain `"…"`; the rest are WYSIWYG.
      let text = "";
      let j = from;
      for (; j < line.length && !line.startsWith(close, j); j++) {
        if (close === '"' && c === '"' && line[j] === "\\") {
          text += line[j + 1] ?? "";
          j++;
        } else text += line[j];
      }
      code += lit(text);
      if (j >= line.length) {
        open = close;
        break;
      }
      i = j + close.length - 1;
    }
    out.push(code);
  }
  return out;
}

/** Index of the line terminator (`\n` or a lone `\r`) at or after `from`, or -1. */
function lineEnd(source: string, from: number): number {
  EOL.lastIndex = from;
  return EOL.exec(source)?.index ?? -1;
}
const EOL = /[\r\n]/g;
