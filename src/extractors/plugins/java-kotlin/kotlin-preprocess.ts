/**
 * Work around a tree-sitter-kotlin (0.3.8) misparse before the file is
 * parsed (`meta.preprocess`).
 *
 * An ANNOTATED TOP-LEVEL declaration is often read as an annotated
 * EXPRESSION: `@Module\n@InstallIn(X::class)\nabstract class CacheModule { … }`
 * becomes `prefix_expression(annotation, prefix_expression(annotation,
 * infix_expression(abstract class CacheModule{lambda})))`, and the class — its
 * methods, its `@Binds`, a controller's routes — disappears from every
 * extractor. Variants: the annotations end up in a stray `prefix_expression`
 * before an otherwise intact declaration (losing a controller's
 * `@RequestMapping`), an annotation's argument list becomes a parenthesized
 * expression, a body-less `class X` swallows the rest of the file. Which
 * shape trips it depends on the annotations' arguments, the body, and what
 * precedes and follows (a `data class U(val m: String?)` before is enough),
 * so it cannot be predicted from the declaration alone; top-level functions
 * and properties are hit the same way.
 *
 * Two edits make the grammar read every combination right (measured over a
 * few thousand generated layouts — annotation counts and arguments, class /
 * object / interface / fun / val, bodies, preceding and following
 * declarations): the annotations are put on the declaration keyword's line,
 * and the declaration is TERMINATED with a `;` (legal Kotlin — `semis` may
 * follow any top-level declaration), placed at the start of the next
 * top-level declaration. Neither changes a row of anything at or after the
 * declaration keyword: the run's line breaks move in front of its first
 * annotation, and a `;` is inserted at the start of an existing line. Only
 * the annotations' own rows change (they now sit on the keyword's line, so a
 * declaration's reported line is its keyword's) and byte offsets after an
 * edit shift — every extractor reads text through the same patched source.
 *
 * The scan is lexical — comments (nested), strings, raw strings, string
 * templates and char literals are skipped — and conservative: anything it
 * cannot follow (an unterminated literal or comment) leaves the source as it was.
 */

/** Modifiers that may sit between the annotations and the declaration keyword. */
const MODIFIERS: ReadonlySet<string> = new Set([
  "public", "private", "internal", "protected", "abstract", "open", "final", "sealed", "data", "enum",
  "annotation", "inner", "value", "inline", "expect", "actual", "external", "const", "lateinit", "suspend",
  "operator", "infix", "tailrec", "noinline", "crossinline",
]);
const DECLARATION_KEYWORDS: ReadonlySet<string> = new Set(["class", "interface", "object", "fun", "val", "var", "typealias"]);

/** Last code characters that continue an expression or header onto the next line. */
const CONTINUES = new Set(["=", ".", ",", "(", "[", "{", "+", "-", "*", "/", "%", "&", "|", ":", "!"]);

/** Does a line ending in `last` (preceded by `beforeLast`) go on to the next line? (`->` does; a nullable `T?` does not.) */
function continues(last: string, beforeLast: string): boolean {
  return CONTINUES.has(last) || (last === ">" && beforeLast === "-");
}

interface Edit {
  /** Offset in the original source. */
  at: number;
  /** Characters of the original replaced. */
  del: number;
  text: string;
}

/**
 * The patched source, or null when nothing needed patching.
 */
export function terminateAnnotatedDeclarations(src: string): string | null {
  // Cheap gate: a column-0 (top-level) annotation.
  if (!/^@(?!file:)/m.test(src)) return null;

  const edits: Edit[] = [];
  const n = src.length;
  let depth = 0;
  let i = 0;
  /** An annotated declaration is open: terminate it before the next top-level declaration. */
  let pending = false;
  /** The last two code characters seen at depth 0 (line-continuation checks). */
  let last = "";
  let beforeLast = "";
  while (i < n) {
    const skipped = skipNonCode(src, i);
    if (skipped < 0) return null;
    if (skipped > i) {
      // A literal is code; a comment is not.
      if (depth === 0 && src[i] !== "/") { beforeLast = last; last = "\""; }
      i = skipped;
      continue;
    }
    const c = src[i]!;
    if (depth === 0 && (c === "@" || (c === "\n" && pending)) && !src.startsWith("@file:", i)) {
      const at = c === "@" ? i : skipTrivia(src, i + 1);
      if (at < 0) return null;
      const decl = c === "\n" && continues(last, beforeLast) ? null : declarationAt(src, at);
      if (decl) {
        if (decl.annotated) edits.push(joinRun(src, at, decl.keyword, pending));
        else if (pending) edits.push({ at, del: 0, text: ";" });
        pending = decl.annotated;
        last = beforeLast = "";
        i = decl.keyword;
        continue;
      }
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === ";" && depth === 0) pending = false; // already terminated
    if (depth === 0 && c !== " " && c !== "\t" && c !== "\r" && c !== "\n") { beforeLast = last; last = c; }
    i++;
  }
  if (edits.length === 0) return null;
  let out = "";
  let from = 0;
  for (const e of edits) {
    out += src.slice(from, e.at) + e.text;
    from = e.at + e.del;
  }
  out += src.slice(from);
  return out === src ? null : out;
}

/**
 * A top-level declaration starting at `at`: optional annotations, modifiers,
 * then a declaration keyword. `keyword` is the keyword's offset; `annotated`
 * tells whether annotations precede it. Null when `at` starts something else.
 */
function declarationAt(src: string, at: number): { keyword: number; annotated: boolean } | null {
  let j = at;
  let annotated = false;
  for (;;) {
    j = skipTrivia(src, j);
    if (j < 0 || j >= src.length) return null;
    if (src[j] !== "@") break;
    const end = annotationEnd(src, j);
    if (end < 0) return null;
    annotated = true;
    j = end;
  }
  for (;;) {
    j = skipTrivia(src, j);
    if (j < 0) return null;
    const word = wordAt(src, j);
    if (!word) return null;
    if (DECLARATION_KEYWORDS.has(word)) return { keyword: j, annotated };
    if (word === "fun" || MODIFIERS.has(word)) { j += word.length; continue; }
    return null;
  }
}

/**
 * Put the annotation run `[start, keyword)` on the keyword's line: its line
 * breaks move in front of it, its comments become spaces, and whitespace
 * collapses to single spaces — with `terminate`, a `;` closes the previous
 * declaration right before the run. A run with a line break inside a string
 * literal keeps its layout (only the `;` is added).
 */
function joinRun(src: string, start: number, keyword: number, terminate: boolean): Edit {
  const keepLayout: Edit = { at: start, del: 0, text: terminate ? ";" : "" };
  let breaks = 0;
  let joined = "";
  let gap = false;
  let i = start;
  while (i < keyword) {
    const skipped = skipNonCode(src, i);
    if (skipped < 0) return keepLayout;
    if (skipped > i) {
      const text = src.slice(i, skipped);
      if (src[i] === "/") {
        // A comment: dropped, its line breaks kept.
        breaks += countBreaks(text);
        gap = joined.length > 0;
      } else {
        if (text.includes("\n")) return keepLayout;
        if (gap) joined += " ";
        gap = false;
        joined += text;
      }
      i = skipped;
      continue;
    }
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      if (c === "\n") breaks++;
      gap = joined.length > 0;
      i++;
      continue;
    }
    if (gap) joined += " ";
    gap = false;
    joined += c;
    i++;
  }
  return { at: start, del: keyword - start, text: "\n".repeat(breaks) + (terminate ? ";" : "") + joined + " " };
}

function countBreaks(s: string): number {
  let k = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === "\n") k++;
  return k;
}

/** End offset of one annotation at `@` (`@A`, `@a.b.C(…)`, `@field:Named("x")`, `@[A B]`); -1 on unbalanced input. */
function annotationEnd(src: string, at: number): number {
  let j = at + 1;
  if (src[j] === "[") {
    const close = matchClose(src, j, "[", "]");
    return close < 0 ? -1 : close + 1;
  }
  let name = qualifiedNameAt(src, j);
  if (!name) return j;
  j += name.length;
  // Use-site target: `@field:Named`.
  if (src[j] === ":" && src[j + 1] !== ":" && /^[a-z]+$/.test(name)) {
    j++;
    name = qualifiedNameAt(src, j);
    if (!name) return j;
    j += name.length;
  }
  if (src[j] === "<") {
    const close = matchClose(src, j, "<", ">");
    if (close < 0) return -1;
    j = close + 1;
  }
  if (src[j] === "(") {
    const close = matchClose(src, j, "(", ")");
    if (close < 0) return -1;
    j = close + 1;
  }
  return j;
}

function qualifiedNameAt(src: string, j: number): string | null {
  const m = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/.exec(src.slice(j, j + 256));
  return m ? m[0] : null;
}

function wordAt(src: string, j: number): string | null {
  if (j < 0) return null;
  const m = /^[A-Za-z_]\w*/.exec(src.slice(j, j + 64));
  return m ? m[0] : null;
}

function matchClose(src: string, open: number, o: string, c: string): number {
  let depth = 0;
  let i = open;
  const n = src.length;
  while (i < n) {
    const skipped = skipNonCode(src, i);
    if (skipped < 0) return -1;
    if (skipped > i) { i = skipped; continue; }
    const ch = src[i]!;
    if (ch === o) depth++;
    else if (ch === c) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Skip whitespace (newlines included) and comments from `i`; -1 on an unterminated comment. */
function skipTrivia(src: string, i: number): number {
  const n = src.length;
  while (i >= 0 && i < n) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") { i++; continue; }
    if (ch === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) { i = skipNonCode(src, i); continue; }
    break;
  }
  return i;
}

/**
 * If `i` starts a comment or a literal, the index just past it; else `i`.
 * -1 when it never ends (the scan then leaves the file alone).
 */
function skipNonCode(src: string, i: number): number {
  const ch = src[i];
  const n = src.length;
  if (ch === "/" && src[i + 1] === "/") {
    const eol = src.indexOf("\n", i);
    return eol < 0 ? n : eol;
  }
  if (ch === "/" && src[i + 1] === "*") {
    // Kotlin block comments nest.
    let depth = 0;
    let j = i;
    while (j < n) {
      if (src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; continue; }
      if (src[j] === "*" && src[j + 1] === "/") {
        depth--;
        j += 2;
        if (depth === 0) return j;
        continue;
      }
      j++;
    }
    return -1;
  }
  if (ch === "\"") {
    const raw = src[i + 1] === "\"" && src[i + 2] === "\"";
    let j = i + (raw ? 3 : 1);
    while (j < n) {
      const c = src[j]!;
      if (!raw && c === "\\") { j += 2; continue; }
      if (c === "$" && src[j + 1] === "{") {
        const close = matchClose(src, j + 1, "{", "}");
        if (close < 0) return -1;
        j = close + 1;
        continue;
      }
      if (raw && c === "\"" && src[j + 1] === "\"" && src[j + 2] === "\"") {
        j += 3;
        while (src[j] === "\"") j++;
        return j;
      }
      if (!raw && c === "\"") return j + 1;
      if (!raw && c === "\n") return j;
      j++;
    }
    return -1;
  }
  if (ch === "'") {
    let j = i + 1;
    if (src[j] === "\\") j += 2;
    else j += 1;
    while (j < n && src[j] !== "'" && src[j] !== "\n") j++;
    return src[j] === "'" ? j + 1 : j;
  }
  if (ch === "`") {
    const close = src.indexOf("`", i + 1);
    return close < 0 ? -1 : close + 1;
  }
  return i;
}
