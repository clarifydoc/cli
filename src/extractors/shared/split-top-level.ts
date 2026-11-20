export interface SplitTopLevelOptions {
  /** The separator (default `,`); more than one character is matched as a string (`||`). */
  sep?: string;
  /** Bracket pairs as one string of opener+closer pairs, e.g. `()[]{}` (the default) or `()[]{}<>`. */
  brackets?: string;
  /** Characters that open a string literal; its text is kept in the piece and nothing inside it counts (default `"'` and a backtick). `""` skips no strings. */
  quotes?: string;
  /** The quote characters inside which a backslash skips the next character (default none). */
  escapes?: string;
  /** Trim every piece. */
  trim?: boolean;
  /** What happens to the last piece when it is empty: `keep` it (so `""` gives `[""]`), drop it when `blank` (whitespace only; the default) or when `empty` (zero length). */
  tail?: "keep" | "blank" | "empty";
  /** Drop every blank piece, not only the last. */
  dropBlank?: boolean;
  /** A closer with nothing open leaves the depth at zero instead of going negative. */
  clamp?: boolean;
  /** A closer with nothing open ends the list (a call's arguments inside a longer line). */
  stopAtCloser?: boolean;
}

/**
 * Split `text` at `sep` where no bracket is open and no string literal is being read.
 * One implementation for the plugins that each carried their own: which brackets count, whether
 * strings are skipped (and honour a backslash), whether pieces are trimmed and what an empty
 * input or trailing piece gives are options, so each caller states the spelling it always had.
 * An unterminated string runs to the end of the text.
 */
export function splitTopLevel(text: string, o: SplitTopLevelOptions = {}): string[] {
  const sep = o.sep ?? ",";
  const { openers, closers } = bracketSets(o.brackets ?? "()[]{}");
  const quotes = o.quotes ?? "\"'`";
  const escapes = o.escapes ?? "";
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  let stopped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === "\\" && escapes.includes(quote)) i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (quotes.includes(ch)) quote = ch;
    else if (openers.has(ch)) depth++;
    else if (closers.has(ch)) {
      if (depth === 0 && o.stopAtCloser) {
        pieces.push(text.slice(start, i));
        stopped = true;
        break;
      }
      depth = o.clamp ? Math.max(0, depth - 1) : depth - 1;
    } else if (depth === 0 && (sep.length === 1 ? ch === sep : sep !== "" && text.startsWith(sep, i))) {
      pieces.push(text.slice(start, i));
      i += sep.length - 1;
      start = i + 1;
    }
  }
  if (!stopped) pieces.push(text.slice(start));
  const last = pieces.length - 1;
  const tail = o.tail ?? "blank";
  if (!o.dropBlank && !o.trim && tail === "keep") return pieces;
  const kept = pieces.filter((p, k) => {
    if (o.dropBlank && !p.trim()) return false;
    if (k !== last) return true;
    if (tail === "blank") return p.trim() !== "";
    if (tail === "empty") return p !== "";
    return true;
  });
  return o.trim ? kept.map((p) => p.trim()) : kept;
}

/** The opener and closer sets of a `brackets` string, built once per spelling (callers use a handful). */
const BRACKET_SETS = new Map<string, { openers: Set<string>; closers: Set<string> }>();
function bracketSets(pairs: string): { openers: Set<string>; closers: Set<string> } {
  let sets = BRACKET_SETS.get(pairs);
  if (!sets) {
    sets = { openers: new Set<string>(), closers: new Set<string>() };
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      sets.openers.add(pairs[i]!);
      sets.closers.add(pairs[i + 1]!);
    }
    BRACKET_SETS.set(pairs, sets);
  }
  return sets;
}
