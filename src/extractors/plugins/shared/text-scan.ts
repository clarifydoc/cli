/** Scanning plain source text: line numbers of offsets, matching parentheses, splits at depth 0. A leaf module. */

/** Index of the `)` that closes the `(` at `open`, or -1. Strings are not read: hand in text with literals blanked. */
export function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** The 1-based line of an offset, counted from the start: for a few lookups in one text (many: `lineStarts` + `lineOfOffset`). */
export const lineAt = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** The text cut at commas outside `()`, `[]` and `{}`; parts are not trimmed, and an empty text gives one empty part. */
export function splitTopLevelCommas(text: string): string[] {
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

/** The balanced argument text of the call whose `(` is at `open`, and the index after its `)`. */
export function balancedArgs(text: string, open: number): { args: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { args: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

export function lineOfOffset(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Top-level arguments of the call whose `(` is at `open` in `text` (strings blanked by the caller where they matter). */
export function callArgsAt(text: string, open: number): Array<{ text: string; at: number }> {
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

/** The parentheses at both ends of `t` are one pair. */
export function wrapsWhole(t: string): boolean {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "(") depth++;
    else if (t[i] === ")" && --depth === 0 && i < t.length - 1) return false;
  }
  return true;
}

/** `offset → 1-based line` for one text, by binary search over its line starts (many lookups in one text; the starts are read on the first). */
export function lineIndex(text: string): (offset: number) => number {
  // Built on the first lookup: an extractor that finds nothing in a file never scans it for line starts.
  let starts: number[] | undefined;
  return (offset) => lineOfOffset((starts ??= lineStarts(text)), offset);
}

/**
 * A per-plugin cache of "the file's lines joined and comment-blanked, with an offset → line lookup", keyed by the
 * lines array a plugin is handed: `const prepared = preparedLines(blankComments)`.
 */
export function preparedLines(blank: (text: string) => string): (lines: string[]) => { text: string; lineAt: (offset: number) => number } {
  const cache = new WeakMap<string[], { text: string; lineAt: (offset: number) => number }>();
  return (lines) => {
    let p = cache.get(lines);
    if (!p) {
      const text = blank(lines.join("\n"));
      p = { text, lineAt: lineIndex(text) };
      cache.set(lines, p);
    }
    return p;
  };
}

/** Index of the line terminator (`\n` or a lone `\r`) at or after `from`, or -1. */
export function lineEnd(source: string, from: number): number {
  EOL.lastIndex = from;
  return EOL.exec(source)?.index ?? -1;
}
const EOL = /[\r\n]/g;

/** `/* … *\/` and `//` comments blanked to spaces, newlines kept, so offsets and line numbers still hold. Strings are not read. */
export function blankCComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

export interface BlankCommentsOptions {
  /** The characters that open a string literal (a backslash escapes inside it). Default: `"`, `'` and a backtick. */
  quotes?: string;
  /** What happens to a string's contents: `keep` them (default) or `blank` them to spaces, quotes and newlines kept. */
  strings?: "keep" | "blank";
  /** A string must close on the line it opens; a quote with no partner there is an ordinary character. */
  stringsEndAtLine?: boolean;
  /** Line-comment openers. Default: `["//"]`. */
  lineComments?: readonly string[];
  /** A `/*` never closed is text, not a comment running to the end. */
  unclosedBlockIsText?: boolean;
}

/**
 * `/* … *\/` and line comments blanked to spaces, newlines kept, so offsets and line numbers still hold; string
 * literals are skipped (a `//` in a URL is no comment) and, with `strings: "blank"`, emptied too. The spellings of
 * the languages that call it are options.
 */
export function blankStringAwareComments(text: string, options: BlankCommentsOptions = {}): string {
  const quotes = options.quotes ?? "\"'`";
  const blankStrings = options.strings === "blank";
  const lineOpeners = options.lineComments ?? ["//"];
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const parts: string[] = [];
  let plainFrom = 0;
  const flush = (to: number) => {
    if (to > plainFrom) parts.push(text.slice(plainFrom, to));
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quotes.includes(ch)) {
      let j = i + 1;
      let closed = false;
      for (; j < text.length; j++) {
        const c = text[j]!;
        if (c === "\\") {
          if (options.stringsEndAtLine && (j + 1 >= text.length || text[j + 1] === "\n")) break;
          j++;
        } else if (c === ch) {
          closed = true;
          break;
        } else if (options.stringsEndAtLine && c === "\n") break;
      }
      if (options.stringsEndAtLine && !closed) continue;
      flush(i);
      const end = Math.min(j, text.length - 1);
      if (blankStrings) parts.push(ch + blank(text.slice(i + 1, j)) + (closed ? ch : ""));
      else parts.push(text.slice(i, end + 1));
      plainFrom = end + 1;
      i = end;
    } else if (ch === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0 && options.unclosedBlockIsText) continue;
      const stop = close < 0 ? text.length : close + 2;
      flush(i);
      parts.push(blank(text.slice(i, stop)));
      plainFrom = stop;
      i = stop - 1;
    } else if (lineOpeners.some((o) => text.startsWith(o, i))) {
      flush(i);
      const eol = text.indexOf("\n", i);
      const stop = eol < 0 ? text.length : eol;
      parts.push(" ".repeat(stop - i));
      plainFrom = stop;
      i = stop - 1;
    }
  }
  flush(text.length);
  return parts.join("");
}

export interface MatchingBracketOptions {
  /** The characters that open a string literal to skip (a backslash escapes inside it). Default: none — hand in blanked text. */
  quotes?: string;
  /** Count only this pair (`"()"`), so other brackets nest freely; default is any of `([{` against any of `)]}` in one depth. */
  pair?: string;
}

/** Index of the bracket closing the one at `open`, or -1; strings are skipped when `quotes` names them. */
export function matchingBracket(text: string, open: number, options: MatchingBracketOptions = {}): number {
  const { quotes, pair } = options;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quotes && quotes.includes(ch)) {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === "\\") i++;
    } else if (pair ? ch === pair[0] : ch === "(" || ch === "[" || ch === "{") depth++;
    else if (pair ? ch === pair[1] : ch === ")" || ch === "]" || ch === "}") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}
