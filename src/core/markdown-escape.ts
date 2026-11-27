/**
 * Escaping for text taken from analyzed code that is written into Markdown
 * posted where others render it (a pull-request comment, a chat card).
 * Whoever controls the code controls a file name, route path or label, so
 * none may turn into a mention, link, image, raw HTML or a table cell.
 * Text the writer authors itself (headings, counts) is not passed through.
 */

/** A longer string is cut (with an ellipsis) so one label cannot fill a comment. */
const MAX_LEN = 500;

/** Zero-width joiner: invisible, but breaks `@name` mentions and bare-URL autolinks. */
const ZWJ = "\u200d";

/** One line, capped: a newline would end a table row or open a block. */
function oneLine(s: string): string {
  const flat = String(s).replace(/[\r\n\u2028\u2029]+/g, " ");
  return flat.length > MAX_LEN ? `${flat.slice(0, MAX_LEN)}…` : flat;
}

/**
 * An inline code span that survives any content: a backtick fence longer than
 * the longest backtick run inside, padded with a space when the text starts or
 * ends with a backtick. `cell` (inside a table row) also writes `|` as `\|`,
 * which a table reads before the code span.
 */
export function mdCode(s: string, cell = false): string {
  let t = oneLine(s);
  if (cell) t = t.replace(/\|/g, "\\|");
  let longest = 0;
  for (const run of t.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

/**
 * Plain text: Markdown punctuation backslash-escaped, `<` `>` too (no raw HTML),
 * `|` always (so it is safe in a table cell), `@` and a bare `http:`/`www.`
 * given a zero-width joiner so no mention or autolink fires.
 */
export function mdText(s: string): string {
  return oneLine(s)
    .replace(/[\\`*_[\]<>|#!~]/g, "\\$&")
    .replace(/@/g, `@${ZWJ}`)
    .replace(/\b(https?|ftp)(:)/gi, `$1${ZWJ}$2`)
    .replace(/\bwww\./gi, `www${ZWJ}.`);
}
