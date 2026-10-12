import type { LanguageRegexControlFlowSpec } from "../../../types/language-plugin.js";

/**
 * Elixir's blocks are `do … end` (a trailing `do`: `def x do`, `if c do`,
 * `case v do`) and `fn … end`. The keyword form `if c, do: x` opens nothing.
 * `else`/`rescue`/`catch`/`after` continue their block at its level, and the
 * arms of `case`/`cond`/`with`/`receive` (`pattern ->`) are switch arms at the
 * block's body level. `fn` closures are where the graph stops, as it stops at
 * the parsed languages' callbacks; Elixir has no `return`.
 */

const END_TOKEN = /(?<![.:@\w])end\b(?![?!:])/g;
const ARM_BLOCK = /^(?:case|cond|with|receive)\b/;

function elixirBlockDelta(code: string): { open: string[]; close: number; leadingClose: number; middle?: boolean } {
  const open: string[] = [];
  for (const _ of code.matchAll(/\bfn\b/g)) open.push("fn");
  // `with`/`for` open at their head even when their clauses run on to a later `… do`
  // line; that line (a `<-` clause) then opens nothing more.
  const head = /^(?:with|for)\b/.test(code) && !/\bdo:/.test(code);
  if (head) open.push(/^with/.test(code) ? "case" : "do");
  else if (/\bdo\s*$/.test(code) && !/<-/.test(code)) open.push(ARM_BLOCK.test(code) || /=\s*(?:case|cond|with)\b/.test(code) ? "case" : "do");
  const ends = (code.match(END_TOKEN) ?? []).length;
  const lead = /^(?:end\b[\s,)\]}|>.]*)+/.exec(code)?.[0] ?? "";
  return { open, close: ends, leadingClose: (lead.match(END_TOKEN) ?? []).length, middle: /^(?:else|rescue|catch|after)\b/.test(code) };
}

/** `if cond, do: expr` (with or without `else:`). */
function elixirInlineGuard(code: string): { head: string; tail: string } | null {
  const m = /^(?:if|unless)\s+(.+?),\s*do:\s*(.+?)(?:,\s*else:.*)?$/.exec(code);
  return m ? { head: m[1]!, tail: m[2]! } : null;
}

export const ELIXIR_REGEX_CONTROL_FLOW: LanguageRegexControlFlowSpec = {
  lineComments: ["#"],
  blockComment: ["", ""],
  quotes: ['"""', "'''", '"', "'"],
  multilineStrings: true,
  blockOpen: /(?!)/,
  blockClose: /(?<![.:@\w])end\b(?![?!:])/,
  blockDelta: elixirBlockDelta,
  // `else` inside `with … do … else … end` heads its pattern arms.
  armBlocks: new Set(["case"]),
  inlineGuard: elixirInlineGuard,
  nestedFunction: /\bfn\b/,
  statements: [
    { match: /^(?:if|unless)\s+(.+?),\s*do:/, type: "if_statement" },
    { match: /^(?:raise|reraise|throw|exit)\b(.*)$/, type: "throw_statement" },
    { match: /^(?:if|unless)\s+(.+?)\s+do\s*$/, type: "if_statement" },
    { match: /^(?:[\w@{}%,\s[\]]+=\s*)?(?:case\s+(.+?)|cond)\s+do\s*$/, type: "switch_statement" },
    { match: /^with\b\s*(.*?)(?:\s+do)?\s*$/, type: "switch_statement" },
    { match: /^for\b\s*(.*?)(?:\s+do)?\s*$/, type: "for_statement" },
    { match: /^try\s+do\s*$/, type: "try_statement" },
  ],
  else: /^else\s*$/,
  catch: /^(?:rescue|catch)\b/,
  finally: /^after\b/,
  // An arm: `pattern ->` (its body below) or `pattern -> expr`, never a one-line `fn x -> … end`.
  case: /^(?!.*\bfn\b)(?!else\b)(.+?)\s*->(?:\s*(.*))?$|^else\s*$/,
};
