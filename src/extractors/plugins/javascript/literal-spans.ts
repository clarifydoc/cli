/**
 * Where a JS/TS source writes a quoted string or a regex literal: the
 * plugin's `securityInLiteral`. A security rule's match that starts in one is
 * the code's data — a rule table's `pattern: /dangerouslySetInnerHTML/`, a
 * message saying `"eval() executes arbitrary code"` — never a sink.
 *
 * A template literal is not one: its text is often code itself (a query, a
 * page's script, a test's input), and the rules that read SQL or HTML in it
 * start their match there. Its `${…}` holes are code all the more. Comments
 * are left to the scanner, which skips them by line.
 */
export function jsLiteralAt(source: string): (offset: number) => boolean {
  const inLiteral = new Uint8Array(source.length);
  // Brace depth of each open `${` hole, innermost last; while non-empty the
  // scan is inside a template's hole, and a `}` at that depth resumes the template.
  const holes: number[] = [];
  let depth = 0;
  let i = 0;
  const n = source.length;
  const mark = (from: number, to: number) => {
    for (let k = from; k < to; k++) inLiteral[k] = 1;
  };
  // A template body from `i` (just past its backtick or a hole's `}`) to its end or its next hole.
  const template = (): void => {
    while (i < n) {
      const c = source[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        return;
      }
      if (c === "$" && source[i + 1] === "{") {
        i += 2;
        holes.push(depth);
        depth++;
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i++;
      while (i < n && source[i] !== c && source[i] !== "\n") i += source[i] === "\\" ? 2 : 1;
      i = Math.min(n, i + 1);
      mark(start, i);
      continue;
    }
    if (c === "`") {
      i++;
      template();
      continue;
    }
    if (c === "/" && regexMayStart(source, i)) {
      const end = regexEnd(source, i);
      if (end > i) {
        mark(i, end);
        i = end;
        continue;
      }
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (holes.length > 0 && holes[holes.length - 1] === depth) {
        holes.pop();
        i++;
        template();
        continue;
      }
    }
    i++;
  }
  return (offset) => inLiteral[offset] === 1;
}

/** Whether a `/` at `i` opens a regex literal: a value is expected there (an operator, an opener, a keyword before it). */
function regexMayStart(source: string, i: number): boolean {
  // `</div>`: a JSX closing tag, not a literal.
  if (source[i - 1] === "<") return false;
  for (let k = i - 1; k >= 0; k--) {
    const c = source[k]!;
    if (c === " " || c === "\t" || c === "\r") continue;
    if (c === "\n") return true;
    if ("=(,:[!&|?{};+-*%<>~^".includes(c)) return true;
    return /\b(?:return|case|typeof|in|of|do|else|yield|await|void|delete|throw)$/.test(source.slice(Math.max(0, k - 9), k + 1));
  }
  return true;
}

/** The index just past a regex literal opening at `i`, or `i` when the line holds none (it was division). */
function regexEnd(source: string, i: number): number {
  let inClass = false;
  for (let k = i + 1; k < source.length; k++) {
    const c = source[k]!;
    if (c === "\\") {
      k++;
      continue;
    }
    if (c === "\n") return i;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      let end = k + 1;
      while (end < source.length && /[a-z]/.test(source[end]!)) end++;
      return end;
    }
  }
  return i;
}
