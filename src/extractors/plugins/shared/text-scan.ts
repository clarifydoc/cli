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
