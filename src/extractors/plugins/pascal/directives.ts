import type { Language } from "../../../types/analysis.js";
import type { PreprocessOutcome } from "../../../types/language-plugin.js";

const ROUTINE_DIRECTIVE = "inline|overload|stdcall|cdecl|register|safecall|pascal|static|virtual|override|reintroduce|abstract|final|deprecated|platform|assembler|dynamic|experimental|unsafe";

/**
 * A conditional-compilation group that wraps nothing but routine directives
 * after a header — `function Size(…): Integer; {$IFDEF SUPPORTS_INLINE}inline;{$ENDIF}` —
 * which the grammar cannot place between a header and its body: the rest of
 * the unit becomes one parse error and its routines are lost.
 */
const DIRECTIVE_GROUP = new RegExp(
  `\\{\\$IF(?:N?DEF|OPT)?\\b[^}]*\\}(\\s*(?:(?:${ROUTINE_DIRECTIVE})\\s*;\\s*)+)\\{\\$(?:ENDIF|IFEND)\\b[^}]*\\}`,
  "gi",
);

/**
 * A one-line `{$IFDEF X} A {$ELSE} B {$ENDIF}` inside a declaration or an
 * expression (`CPUX = {$IFDEF CPUX64}CPUX64{$ELSE}CPUX32{$ENDIF};`): both
 * branches side by side are no Pascal at all, so the first one is kept.
 */
const ONE_LINE_ELSE = /\{\$IF(?:N?DEF|OPT)?\b[^}\n]*\}([^{\n]*)(\{\$ELSE\}[^{\n]*\{\$(?:ENDIF|IFEND)\b[^}\n]*\})/gi;

/**
 * A group holding nothing but string literals — a unit that refuses to
 * compile for a platform it does not support (`{$IFNDEF MSWINDOWS}
 * 'This unit needs Windows.' {$ENDIF}`): the strings are no declaration or
 * statement, so the whole group is blanked.
 */
const STRINGS_ONLY_GROUP = /\{\$IF(?:N?DEF|OPT)?\b[^}]*\}(?:\s*'(?:[^'\n]|'')*')+\s*\{\$(?:ENDIF|IFEND)\b[^}]*\}/gi;

/**
 * A group right after a routine's header wrapping its declaration sections —
 * `function F(s: string): string;` ⏎ `{$IFDEF MSWINDOWS} var i: Integer; {$ENDIF}`
 * ⏎ `begin` — which the grammar cannot place there either: the two directives
 * are blanked and the declarations kept.
 */
const DECLARATIONS_GROUP = new RegExp(
  `((?:class\\s+)?(?:function|procedure|constructor|destructor)\\s+[\\w.]+\\s*(?:\\([^)]*\\))?\\s*(?::\\s*[\\w.<>, ]+)?\\s*;(?:\\s*(?:${ROUTINE_DIRECTIVE})\\s*;)*\\s*)` +
    `(\\{\\$IF(?:N?DEF|OPT)?\\b[^}]*\\})(\\s*(?:var|const|type|label)\\b(?:(?!\\{\\$|\\bbegin\\b)[\\s\\S])*?)(\\{\\$(?:ENDIF|IFEND)\\b[^}]*\\})`,
  "gi",
);

/**
 * Blank such a group's two directives, keeping the directives they guard
 * (`inline;` is a valid routine directive whether the symbol is defined or
 * not), a one-line group's `{$ELSE}` branch and a strings-only group. Every
 * other character, line and column stays where it was. Null when the file has none.
 */
export function pascalDirectivePreprocess(rawSource: string, relativePath: string): PreprocessOutcome | null {
  if (!/\.(?:pas|pp|dpr|dpk|lpr|inc)$/i.test(relativePath) || !rawSource.includes("{$")) return null;
  DIRECTIVE_GROUP.lastIndex = 0;
  ONE_LINE_ELSE.lastIndex = 0;
  STRINGS_ONLY_GROUP.lastIndex = 0;
  DECLARATIONS_GROUP.lastIndex = 0;
  if (!DIRECTIVE_GROUP.test(rawSource) && !ONE_LINE_ELSE.test(rawSource) && !STRINGS_ONLY_GROUP.test(rawSource) && !DECLARATIONS_GROUP.test(rawSource)) return null;
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const sourceText = rawSource
    .replace(STRINGS_ONLY_GROUP, blank)
    .replace(DECLARATIONS_GROUP, (_m, header: string, open: string, decls: string, close: string) => header + blank(open) + decls + blank(close))
    .replace(DIRECTIVE_GROUP, (m, kept: string) => {
      const open = m.indexOf("}") + 1;
      return blank(m.slice(0, open)) + kept + blank(m.slice(open + kept.length));
    })
    .replace(ONE_LINE_ELSE, (m, kept: string, rest: string) => blank(m.slice(0, m.length - kept.length - rest.length)) + kept + blank(rest));
  return { sourceText, language: "pascal" as Language };
}
