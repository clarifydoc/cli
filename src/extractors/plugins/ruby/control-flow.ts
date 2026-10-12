import type { LanguageRegexControlFlowSpec } from "../../../types/language-plugin.js";

/**
 * Ruby's blocks are delimited by keywords, and the same keyword opens a block
 * or does not depending on where it sits: `if x` at the start of a statement
 * opens one, `return y if x` (a modifier) does not, `z = if x` does again. So
 * the scan asks this hook, line by line, what each line opens and closes.
 *
 *   if / unless / while / until / for / case / begin / def / class / module
 *     at the start of a statement, or right after `=`, `(`, `,`, `||`, `&&`,
 *     `return` (an expression)                                  → opens
 *   a trailing `do` / `do |x|` (a block; `while x do` opens once) → opens
 *   `{` … `}` across lines (a brace block or a hash)              → opens / closes
 *   `end` (not `x.end`, `:end`, `end?`)                           → closes
 *   else / elsif / rescue / ensure                                → the block's own level
 *   when / in / else inside a `case`                              → arms
 *
 * Blocks (`items.each do |x|`, `loop do`, `->(x) {`) are closures: the graph
 * stops at them, as the parsed languages' graphs stop at a callback.
 */

const OPENS_AT_START = /^(?:if|unless|while|until|for|case|begin|def|class|module)\b/;
const LOOP_AT_START = /^(?:while|until|for)\b/;
/**
 * An expression form: `x = if …`, `foo(case y …`, `return begin …` — never `return if x`
 * (a modifier) or a hash key (`validates :name, if: :draft?`). At most one space before
 * the keyword: strings are blanked to spaces, so `x = 'a' if y` reads `x =     if y`.
 */
const OPENS_AFTER = /(?:(?:[=(]|\|\||&&)[ \t]?(?:if|unless|case|begin|while|until)|\breturn\s+(?:case|begin))\b(?![:?!])/g;
const TRAILING_DO = /\bdo\s*(?:\|[^|]*\|)?\s*$/;
const END_TOKEN = /(?<![.:@$\w])end\b(?![?!:])/g;
const LEADING_CLOSERS = /^(?:(?:(?<![.:@$\w])end\b(?![?!:])|\})\s*)+/;
const MIDDLE = /^(?:else|elsif|rescue|ensure)\b/;
/** `def name(args) = expr` (Ruby 3 endless method) opens nothing. */
const ENDLESS_DEF = /^def\s+[\w.?!]+(?:\([^)]*\))?\s*=(?!=)/;

function rubyBlockDelta(code: string): { open: string[]; close: number; leadingClose: number; middle?: boolean } {
  const open: string[] = [];
  const start = OPENS_AT_START.exec(code)?.[0];
  if (start && !ENDLESS_DEF.test(code)) open.push(start === "case" ? "case" : start);
  for (const m of code.matchAll(OPENS_AFTER)) open.push(/case\s*$/.test(m[0]) ? "case" : "expr");
  if (TRAILING_DO.test(code) && !LOOP_AT_START.test(code)) open.push("do");
  for (const _ of code.matchAll(/\{/g)) open.push("brace");
  const ends = (code.match(END_TOKEN) ?? []).length;
  const braces = (code.match(/\}/g) ?? []).length;
  const lead = LEADING_CLOSERS.exec(code)?.[0] ?? "";
  const leadingClose = (lead.match(END_TOKEN) ?? []).length + (lead.match(/\}/g) ?? []).length;
  // A closer on a line that also opens (`end.each do |x|`, `}.map {`) closes first.
  return { open, close: ends + braces, leadingClose, middle: MIDDLE.test(code) };
}

/** `stmt if cond` / `stmt unless cond` and the one-line `if cond then stmt end`. */
function rubyInlineGuard(code: string): { head: string; tail: string } | null {
  const oneLine = /^(?:if|unless)\s+(.+?)\s+then\s+(.+?)(?:\s*;)?\s*(?:end)?\s*$/.exec(code);
  if (oneLine) return { head: oneLine[1]!, tail: oneLine[2]! };
  const modifier = MODIFIER_IF.exec(code);
  return modifier ? { head: modifier[2]!, tail: modifier[1]! } : null;
}

/** A statement guarded by a trailing `if`/`unless` — never an `x = if …` expression opener. */
const MODIFIER_IF = /^(?!(?:if|unless|while|until|elsif)\b)(.*?\S)\s+(?:if|unless)\s+(?!.*\bthen\b)(.+?)\s*$/;

export const RUBY_REGEX_CONTROL_FLOW: LanguageRegexControlFlowSpec = {
  lineComments: ["#"],
  blockComment: ["=begin", "=end"],
  quotes: ['"', "'", "`"],
  regexLiterals: true,
  blockOpen: /(?!)/,
  blockClose: /(?<![.:@$\w])end\b(?![?!:])|\}/,
  blockDelta: rubyBlockDelta,
  armBlocks: new Set(["case"]),
  inlineGuard: rubyInlineGuard,
  nestedFunction: /\bdo\s*(?:\|[^|]*\|)?\s*$|\{\s*(?:\|[^|]*\|)?\s*$|\blambda\b|->\s*(?:\([^)]*\))?\s*(?:do|\{)/,
  statements: [
    // A modifier first: `return x if y` is a branch guarding a return.
    { match: /^(?!(?:if|unless|while|until|elsif)\b)(?:.*?\S)\s+(?:if|unless)\s+(?!.*\bthen\b)(.+?)\s*$/, type: "if_statement" },
    { match: /^(?:if|unless)\s+(.+?)\s+then\s+.+$/, type: "if_statement" },
    { match: /^return\b(.*)$/, type: "return_statement" },
    { match: /^(?:raise|fail)\b(.*)$/, type: "throw_statement" },
    { match: /^break\b/, type: "break_statement" },
    { match: /^(?:next|redo|retry)\b/, type: "continue_statement" },
    { match: /^(?:if|unless)\s+(.+?)(?:\s+then)?\s*$/, type: "if_statement" },
    { match: /^[\w@$.[\]:]+\s*(?:\|\|=|&&=|=)\s*(?:if|unless)\s+(.+?)(?:\s+then)?\s*$/, type: "if_statement" },
    { match: /^(?:while|until)\s+(.+?)(?:\s+do)?\s*$/, type: "while_statement" },
    { match: /^for\s+(.+?)(?:\s+do)?\s*$/, type: "for_statement" },
    { match: /^case\b\s*(.*?)\s*$/, type: "switch_statement" },
    { match: /^[\w@$.[\]:]+\s*(?:\|\|=|=)\s*case\b\s*(.*?)\s*$/, type: "switch_statement" },
    { match: /^begin\s*$/, type: "try_statement" },
  ],
  elseIf: /^elsif\s+(.+?)(?:\s+then)?\s*$/,
  else: /^else\s*$/,
  catch: /^rescue\b/,
  finally: /^ensure\b/,
  // A label that is only a string is blanked away (`when 'me'` reads `when`): an empty capture, named from the raw line.
  case: /^(?:(?:when|in)\b\s*(.*?)(?:\s+then\b\s*(.*?))?|else)\s*$/,
};
