/**
 * Strip Python string literals, docstrings, and comments from source code.
 * Preserves code structure and line positions — replaces removed content with spaces
 * (keeping newlines) so that line numbers remain accurate. An f-string's `f`
 * prefix is kept.
 */
export function stripPythonNonCode(content: string): string {
  const len = content.length;
  // Work with a mutable char array for efficient in-place blanking
  const chars = content.split("");
  let i = 0;

  /** Replace range [from, to) with spaces, preserving newlines */
  function blank(from: number, to: number) {
    for (let j = from; j < to; j++) {
      if (chars[j] !== "\n") chars[j] = " ";
    }
  }

  while (i < len) {
    // Triple-quoted strings (must check before single quotes)
    if (
      i < len - 2 &&
      ((chars[i] === '"' && chars[i + 1] === '"' && chars[i + 2] === '"') ||
       (chars[i] === "'" && chars[i + 1] === "'" && chars[i + 2] === "'"))
    ) {
      const q3 = chars[i];
      const start = i;
      i += 3;
      while (i < len - 2) {
        if (chars[i] === q3 && chars[i + 1] === q3 && chars[i + 2] === q3) {
          i += 3;
          break;
        }
        i++;
      }
      blank(start, i);
      continue;
    }

    // String prefixes (f/r/b/u and combinations)
    if (
      i < len - 1 &&
      /^[frbuFRBU]$/.test(chars[i]) &&
      (chars[i + 1] === '"' || chars[i + 1] === "'")
    ) {
      const start = i;
      i++; // skip prefix, fall through to string handling below
      const q = chars[i];
      i++;
      while (i < len && chars[i] !== q && chars[i] !== "\n") {
        if (chars[i] === "\\") i++;
        i++;
      }
      if (i < len && chars[i] === q) i++;
      // An f-string keeps its `f`: that it interpolates is the code's shape
      // (`cursor.execute(f"… {uid}")`), not the string's content.
      blank(chars[start] === "f" || chars[start] === "F" ? start + 1 : start, i);
      continue;
    }

    // Regular single/double quoted strings
    if (chars[i] === '"' || chars[i] === "'") {
      const q = chars[i];
      const start = i;
      i++;
      while (i < len && chars[i] !== q && chars[i] !== "\n") {
        if (chars[i] === "\\") i++;
        i++;
      }
      if (i < len && chars[i] === q) i++;
      blank(start, i);
      continue;
    }

    // Comments (# to end of line)
    if (chars[i] === "#") {
      const start = i;
      while (i < len && chars[i] !== "\n") i++;
      blank(start, i);
      continue;
    }

    // Normal code — skip
    i++;
  }

  return chars.join("");
}
