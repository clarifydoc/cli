import type { BlockDelta, InlineGuard, LanguageRegexControlFlowSpec } from "../../../types/language-plugin.js";

/**
 * Visual Basic (VB.NET, VB6, VBScript) closes every block with its own words:
 * `If … Then` / `End If`, `For` / `Next`, `Do` / `Loop`, `While` / `End While`
 * (`Wend`), `Select Case` / `End Select`, `Try` / `End Try`, `With`, `Using`,
 * `SyncLock`. An `If` opens a block only when nothing follows its `Then`; with a
 * statement after it (`If x Then Exit Sub`) it is a one-line guard. Keywords are
 * case-insensitive, so every pattern here is too.
 */

const OPENER = /^(?:For|While|Do|Select\s+Case|Try|With|Using|SyncLock)\b/i;
/** A multi-line lambda: `Sub(x)` / `Function(x)` ending its line, closed by `End Sub` / `End Function`. */
const LAMBDA = /\b(?:Sub|Function)\s*\([^)]*\)\s*$/i;
const MEMBER = /^(?:(?:Public|Private|Protected|Friend|Shared|Overrides|Overridable|Overloads|NotOverridable|Async|Iterator|Static|Partial|Shadows|ReadOnly|WriteOnly|Default)\s+)*(?:Sub|Function|Property|Operator|Get|Set|AddHandler|RemoveHandler|RaiseEvent)\b/i;

/** What a line opens; `End …`, `Next`, `Loop`, `Wend` close (`blockClose`). */
const vbBlockDelta: BlockDelta = (code) => {
  const open: string[] = [];
  if (/^If\b.*\bThen\s*$/i.test(code)) open.push("if");
  const opener = OPENER.exec(code)?.[0];
  if (opener) open.push(/^select/i.test(opener) ? "case" : opener.toLowerCase());
  else if (MEMBER.test(code) && !/^(?:Declare|MustOverride)\b/i.test(code)) open.push("member");
  if (LAMBDA.test(code) && !MEMBER.test(code)) open.push("lambda");
  return { open, middle: /^(?:Else\b|ElseIf\b|Catch\b|Finally\b)/i.test(code) };
};

/** `If cond Then stmt` (with an optional `Else other`). */
const ONE_LINE_IF = /^If\s+(.+?)\s+Then\s+(\S.*)$/i;

const vbInlineGuard: InlineGuard = (code) => {
  const m = ONE_LINE_IF.exec(code);
  return m ? { head: m[1]!, tail: m[2]!.replace(/\s+Else\b.*$/i, "") } : null;
};

export const VB_REGEX_CONTROL_FLOW: LanguageRegexControlFlowSpec = {
  lineComments: ["'"],
  blockComment: ["", ""],
  quotes: ['"'],
  blockOpen: /(?!)/,
  blockClose: /^\s*(?:End\s+(?:If|Select|Try|While|With|Using|SyncLock|Sub|Function|Property|Operator|Get|Set|AddHandler|RemoveHandler|RaiseEvent)|Next|Loop|Wend)\b.*$/i,
  blockDelta: vbBlockDelta,
  inlineGuard: vbInlineGuard,
  nestedFunction: LAMBDA,
  statements: [
    { match: ONE_LINE_IF, type: "if_statement" },
    { match: /^Return\b(.*)$/i, type: "return_statement" },
    { match: /^Exit\s+(?:Sub|Function|Property)\b/i, type: "return_statement" },
    { match: /^Exit\s+(?:For|Do|While|Select|Try)\b/i, type: "break_statement" },
    { match: /^Continue\s+(?:For|Do|While)\b/i, type: "continue_statement" },
    { match: /^(?:Throw\b|Err\.Raise\b)(.*)$/i, type: "throw_statement" },
    { match: /^GoTo\b/i, type: "break_statement" },
    { match: /^If\s+(.+?)\s+Then\s*$/i, type: "if_statement" },
    { match: /^(?:While|Do\s+While|Do\s+Until)\s+(.+)$/i, type: "while_statement" },
    { match: /^Do\s*$/i, type: "do_statement" },
    { match: /^For\s+(?:Each\s+)?(.+)$/i, type: "for_statement" },
    { match: /^Select\s+Case\s+(.+)$/i, type: "switch_statement" },
    { match: /^Try\s*$/i, type: "try_statement" },
  ],
  elseIf: /^ElseIf\s+(.+?)\s+Then\s*$/i,
  else: /^Else\s*$/i,
  catch: /^Catch\b/i,
  finally: /^Finally\b/i,
  case: /^Case\s+(?:Else\s*$|(.+?)\s*$)/i,
};
