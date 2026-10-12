import type { LanguageRegexControlFlowSpec } from "../../../types/language-plugin.js";

/**
 * Lua's blocks: `function … end`, `if … then … end`, `while … do … end`,
 * `for … do … end`, a bare `do … end`, and `repeat … until cond`. A line opens
 * one block per `function` and per `do`, one for an `if` that starts it, one for
 * `repeat`; `elseif`/`else` continue their `if` at its level. Anonymous
 * functions (`pcall(function() … end)`) are closures the graph stops at.
 */

const END_TOKEN = /(?<![.:\w])end\b/g;

function luaBlockDelta(code: string): { open: string[]; close: number; leadingClose: number; middle?: boolean } {
  const open: string[] = [];
  for (const _ of code.matchAll(/\bfunction\b/g)) open.push("function");
  if (/^if\b/.test(code)) open.push("if");
  for (const _ of code.matchAll(/\bdo\b/g)) open.push("do");
  if (/^repeat\b/.test(code)) open.push("repeat");
  const ends = (code.match(END_TOKEN) ?? []).length;
  const until = /^until\b/.test(code) ? 1 : 0;
  const lead = /^(?:end\b[\s,);]*)+/.exec(code)?.[0] ?? "";
  const leadingClose = (lead.match(END_TOKEN) ?? []).length + until;
  return { open, close: ends + until, leadingClose, middle: /^(?:else|elseif)\b/.test(code) };
}

/** `if cond then stmt end` on one line. */
function luaInlineGuard(code: string): { head: string; tail: string } | null {
  const m = /^if\s+(.+?)\s+then\s+(.+?)\s+end\s*;?$/.exec(code);
  return m ? { head: m[1]!, tail: m[2]!.replace(/\s+else\b.*$/, "") } : null;
}

export const LUA_REGEX_CONTROL_FLOW: LanguageRegexControlFlowSpec = {
  lineComments: ["--"],
  blockComment: ["--[[", "]]"],
  quotes: ['"', "'"],
  blockOpen: /(?!)/,
  blockClose: /(?<![.:\w])end\b|\buntil\b.*$/,
  blockDelta: luaBlockDelta,
  inlineGuard: luaInlineGuard,
  nestedFunction: /\bfunction\b/,
  statements: [
    { match: /^if\s+(.+?)\s+then\s+.+\s+end\s*;?$/, type: "if_statement" },
    { match: /^return\b(.*)$/, type: "return_statement" },
    { match: /^error\s*\((.*)$/, type: "throw_statement" },
    { match: /^(?:break|goto)\b/, type: "break_statement" },
    { match: /^if\s+(.+?)\s+then\s*$/, type: "if_statement" },
    // A condition that runs over several lines, `then` / `do` on the last of them.
    { match: /^if\b\s*(.+?)\s*$/, type: "if_statement" },
    { match: /^while\b\s*(.+?)(?:\s+do)?\s*$/, type: "while_statement" },
    { match: /^for\b\s*(.+?)(?:\s+do)?\s*$/, type: "for_statement" },
    { match: /^repeat\s*$/, type: "do_statement" },
  ],
  elseIf: /^elseif\s+(.+?)\s+then\s*$/,
  else: /^else\s*$/,
};
