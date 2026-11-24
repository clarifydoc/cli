/**
 * Strip Python string literals, docstrings, and comments from source code.
 * Preserves code structure and line positions — replaces removed content with spaces
 * (keeping newlines) so that line numbers remain accurate. An f-string's `f`
 * prefix is kept.
 */
export function stripPythonNonCode(content: string): string {
  const len = content.length;
  // Kept stretches are sliced from `content`; only blanked ranges are rewritten, so a file is not split into
  // one string per character and joined again.
  let out = "";
  let kept = 0; // content[kept..] is not yet copied to `out`
  let i = 0;

  /** Replace range [from, to) with spaces, preserving newlines; a range running past the end adds spaces. */
  function blank(from: number, to: number) {
    out += content.slice(kept, from);
    const end = to < len ? to : len;
    const piece = content.slice(from, end);
    out += piece.indexOf("\n") < 0 ? " ".repeat(piece.length) : piece.replace(/[^\n]/g, " ");
    if (to > len) out += " ".repeat(to - (from > len ? from : len));
    kept = end > from ? end : from;
  }

  while (i < len) {
    const c = content.charCodeAt(i);
    // Normal code — skip. Only a quote, a `#` or a string prefix can start something.
    if (c !== 34 && c !== 39 && c !== 35 && !(c === 102 || c === 114 || c === 98 || c === 117 || c === 70 || c === 82 || c === 66 || c === 85)) {
      i++;
      continue;
    }

    // Triple-quoted strings (must check before single quotes)
    if (i < len - 2 && (c === 34 || c === 39) && content.charCodeAt(i + 1) === c && content.charCodeAt(i + 2) === c) {
      const start = i;
      i += 3;
      while (i < len - 2) {
        if (content.charCodeAt(i) === c && content.charCodeAt(i + 1) === c && content.charCodeAt(i + 2) === c) {
          i += 3;
          break;
        }
        i++;
      }
      blank(start, i);
      continue;
    }

    // String prefixes (f/r/b/u and combinations)
    if (c !== 34 && c !== 39 && c !== 35) {
      const next = i < len - 1 ? content.charCodeAt(i + 1) : 0;
      if (next !== 34 && next !== 39) {
        i++;
        continue;
      }
      const start = i;
      i++; // skip prefix, fall through to string handling below
      const q = next;
      i++;
      while (i < len && content.charCodeAt(i) !== q && content.charCodeAt(i) !== 10) {
        if (content.charCodeAt(i) === 92) i++;
        i++;
      }
      if (i < len && content.charCodeAt(i) === q) i++;
      // An f-string keeps its `f`: that it interpolates is the code's shape
      // (`cursor.execute(f"… {uid}")`), not the string's content.
      blank(c === 102 || c === 70 ? start + 1 : start, i);
      continue;
    }

    // Regular single/double quoted strings
    if (c === 34 || c === 39) {
      const start = i;
      i++;
      while (i < len && content.charCodeAt(i) !== c && content.charCodeAt(i) !== 10) {
        if (content.charCodeAt(i) === 92) i++;
        i++;
      }
      if (i < len && content.charCodeAt(i) === c) i++;
      blank(start, i);
      continue;
    }

    // Comments (# to end of line)
    const start = i;
    while (i < len && content.charCodeAt(i) !== 10) i++;
    blank(start, i);
  }

  return out + content.slice(kept);
}
