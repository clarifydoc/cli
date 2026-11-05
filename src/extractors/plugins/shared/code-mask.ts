/**
 * Which characters of a C-family source are code: not a comment, a string or character literal, nor a preprocessor
 * directive (a `#` line with its `\` continuations). The readers rewrite text before lexing — line splices, `asm`
 * statements, … — and a rewrite must never reach into one of those. A line comment ends at the first newline no
 * backslash precedes, as the preprocessor splices them first.
 */
export function codeMask(text: string): Uint8Array {
  const n = text.length;
  const mask = new Uint8Array(n);
  const lineCommentEnd = (from: number): number => {
    let i = from;
    while (i < n && !(text[i] === "\n" && text[i - 1] !== "\\")) i++;
    return i;
  };
  const blockCommentEnd = (from: number): number => {
    const end = text.indexOf("*/", from + 2);
    return end < 0 ? n : end + 2;
  };
  let i = 0;
  let lineStart = true;
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      mask[i] = 1;
      lineStart = true;
      i++;
    } else if (c === " " || c === "\t" || c === "\f") {
      mask[i] = 1;
      i++;
    } else if (lineStart && c === "#") {
      // A directive runs to the first newline no backslash precedes; a comment inside it may span lines.
      while (i < n && text[i] !== "\n") {
        if (text[i] === "\\" && text[i + 1] === "\n") i += 2;
        else if (text[i] === "/" && text[i + 1] === "*") i = blockCommentEnd(i);
        else if (text[i] === "/" && text[i + 1] === "/") i = lineCommentEnd(i);
        else i++;
      }
    } else {
      lineStart = false;
      if (c === "/" && text[i + 1] === "*") i = blockCommentEnd(i);
      else if (c === "/" && text[i + 1] === "/") i = lineCommentEnd(i);
      else if (c === '"' || c === "'") {
        i++;
        while (i < n && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
        if (text[i] === c) i++;
      } else if (c === "\\" && text[i + 1] === "\n") {
        // A splice stays code and the next line is the same logical line.
        mask[i] = 1;
        mask[i + 1] = 1;
        i += 2;
      } else {
        mask[i] = 1;
        i++;
      }
    }
  }
  return mask;
}
