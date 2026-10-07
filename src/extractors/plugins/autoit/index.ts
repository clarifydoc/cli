import type { CallInfo, DataSourceInfo, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * AutoIt regex spec. `Func Name($a, $b = 1)` … `EndFunc` (any letter case),
 * `#include <Array.au3>` / `#include "lib\db.au3"`; the file's own statements
 * run (`<setup>`). Strings are `"…"` or `'…'`, and both may hold SQL.
 */

/** Words that read like a call but are the language's — matched in any letter case. */
const KEYWORDS = new Set([
  "if", "then", "else", "elseif", "endif", "while", "wend", "do", "until", "for", "to", "step", "next", "in", "select",
  "endselect", "switch", "endswitch", "case", "return", "local", "global", "dim", "redim", "const", "static", "byref",
  "not", "and", "or", "exit", "exitloop", "continueloop", "func", "endfunc", "with", "endwith", "true", "false", "default",
  "null",
]);

/** `$a`, `$b = 1`, `ByRef $c`, `Const $d = "x"`. */
function parseAu3Param(raw: string): ParamInfo | null {
  let text = raw.trim().replace(/^(?:ByRef|Const)\s+/gi, "");
  let defaultValue: string | null = null;
  const eq = text.indexOf("=");
  if (eq >= 0) { defaultValue = text.slice(eq + 1).trim() || null; text = text.slice(0, eq).trim(); }
  const m = /^\$(\w+)$/.exec(text);
  return m ? { name: m[1]!, type: null, defaultValue } : null;
}

const dropKeywordCalls = (calls: CallInfo[]) => calls.filter((c) => !KEYWORDS.has(c.name.toLowerCase()));

function au3DataSources(lines: string[]): DataSourceInfo[] {
  const out = extractSqlStringDataSources(lines.map((l) => l.replace(/'((?:[^']|'')*)'/g, (all, b: string) => (/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(b) ? `"${b.replace(/"/g, "'")}"` : all))));
  const http = new Set<string>();
  for (const line of lines) {
    const m = /\$(\w+)\s*=\s*ObjCreate\(\s*["']winhttp\.winhttprequest\.5\.1["']/i.exec(line);
    if (m) http.add(m[1]!.toLowerCase());
  }
  for (let i = 0; i < lines.length; i++) {
    const push = (method: string, url: string) => {
      if (/^(?:https?:\/\/|\/)/.test(url)) out.push({ kind: "api-call", name: `${method} ${url}`, target: url, calls: [], line: i + 1 });
    };
    const line = lines[i]!;
    for (const m of line.matchAll(/\$(\w+)\.Open\(\s*["'](\w+)["']\s*,\s*["']([^"']+)["']/gi)) if (http.has(m[1]!.toLowerCase())) push(m[2]!.toUpperCase(), m[3]!);
    for (const m of line.matchAll(/\b(?:InetGet|InetRead|_INetGetSource|_HTTP_Get)\(\s*["']([^"']+)["']/gi)) push("GET", m[1]!);
    for (const m of line.matchAll(/\b_HTTP_Post\(\s*["']([^"']+)["']/gi)) push("POST", m[1]!);
  }
  return out.sort((a, b) => a.line - b.line);
}

/** The source with `#cs … #ce` / `#comments-start … #comments-end` blocks blanked (lines kept). Null when there is none. */
export function blankAu3Comments(source: string): string | null {
  if (!/^\s*#(?:cs|comments-start)\b/im.test(source)) return null;
  const lines = source.split("\n");
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#(?:cs|comments-start)\b/i.test(lines[i]!)) depth++;
    const inside = depth > 0;
    if (/^\s*#(?:ce|comments-end)\b/i.test(lines[i]!)) depth = Math.max(0, depth - 1);
    if (inside) lines[i] = "";
  }
  return lines.join("\n");
}

export const autoitSpec: RegexLangSpec = {
  language: "autoit",
  extensions: [".au3"],
  lineCommentPrefixes: [";"],
  topLevelCalls: true,
  blockStyle: "keyword-end",
  keywordEnd: { openRe: /^\s*(Func)\b/i, endRe: /^\s*End(Func)\b/i },

  functionPatterns: [{ pattern: /^\s*(?:Volatile\s+)?Func\s+(\w+)\s*\(/i, isExported: (_l, name) => !name.startsWith("__") }],
  classPatterns: [],
  parseParam: parseAu3Param,

  importPatterns: [
    {
      // #include <Array.au3> (a standard UDF) / #include "lib\db.au3"
      pattern: /^\s*#include(?:-once)?\s+([<"'])([^>"']+)[>"']/i,
      getSource: (m) => (m[1] === "<" ? m[2]!.replace(/\.au3$/i, "") : /^\.{1,2}[\\/]/.test(m[2]!) ? m[2]!.replace(/\\/g, "/") : `./${m[2]!.replace(/\\/g, "/")}`),
      getSpecifiers: () => [],
    },
  ],

  postProcessFunctions: (_lines, fns) => {
    for (const fn of fns) fn.calls = dropKeywordCalls(fn.calls);
    return fns;
  },
  extractDataSources: (lines) => au3DataSources(lines),
};

/** The `<setup>` calls go through the same keyword filter (the regex engine builds them). */
export function tidySetup(fns: FunctionInfo[]): void {
  const setup = fns.find((f) => f.name === "<setup>");
  if (setup) setup.calls = dropKeywordCalls(setup.calls);
}
