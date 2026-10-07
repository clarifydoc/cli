import type { CallInfo, ClassInfo, DataSourceInfo, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, extractClassesWithSpec, findEndLine, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * AutoHotkey regex spec (v1 and v2). A definition and a call look alike —
 * `Save(order) {` defines, `Save(order)` calls — so a candidate is a
 * function only when a `{` (or v2's `=>`) follows its parameter list.
 * Hotkeys (`^j::`) and v1 labels (`Refresh:` … `return`) are the script's
 * entry points: functions of their own, named as written.
 */

/** Words that read like a call but are the language's. */
const KEYWORDS = new Set([
  "if", "else", "while", "loop", "for", "switch", "case", "default", "try", "catch", "finally", "throw", "return", "until",
  "break", "continue", "goto", "gosub", "global", "local", "static", "class", "new", "not", "and", "or", "is", "in",
  "contains", "isset", "super", "this", "true", "false", "settimer",
]);

const FN_CANDIDATE = /^\s*(?:static\s+)?([A-Za-z_]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:\{|=>|$)/;

/** `a`, `b := 1`, `&ref`, `c*`, v1 `b = 1`. */
function parseAhkParam(raw: string): ParamInfo | null {
  let text = raw.trim().replace(/^ByRef\s+/i, "").replace(/^&/, "").replace(/\*$/, "");
  if (!text) return null;
  let defaultValue: string | null = null;
  const eq = text.search(/:?=/);
  if (eq >= 0) { defaultValue = text.slice(eq).replace(/^:?=/, "").trim() || null; text = text.slice(0, eq).trim(); }
  return /^[A-Za-z_]\w*$/.test(text) ? { name: text, type: null, defaultValue } : null;
}

/** Whether the candidate on line `i` opens a body: `{` here or as the next code line, or a v2 `=>`. */
function opensBody(lines: string[], i: number): boolean {
  const line = lines[i]!.replace(/\s;.*$/, "");
  if (/\)\s*(?:\{|=>)/.test(line)) return true;
  for (let j = i + 1; j < lines.length; j++) {
    const next = lines[j]!.trim();
    if (!next || next.startsWith(";")) continue;
    return next.startsWith("{");
  }
  return false;
}

const keep = (lines: string[]) => (fn: FunctionInfo) => !KEYWORDS.has(fn.name.toLowerCase()) && opensBody(lines, fn.line - 1);
const dropKeywordCalls = (calls: CallInfo[]) => calls.filter((c) => !KEYWORDS.has(c.name.toLowerCase()));

/** `Gosub, Refresh`, `SetTimer, Poll, 1000`, `SetTimer(Poll, 1000)` — a label or function by name. */
const LABEL_CALL: CallPattern = {
  pattern: /\b(?:Gosub|Goto|SetTimer)\s*[,(]?\s*%?([A-Za-z_]\w*)/i,
  buildName: (m) => ({ name: m[1]!, leafName: m[1]! }),
};

/**
 * Hotkeys and v1 labels as functions: `^j::Run "notepad"` (one line),
 * `^j:: { … }` (v2 block), `^j::` … `return` (v1), `Refresh:` … `return`.
 */
function entryPoints(lines: string[], taken: ReadonlySet<number>): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (taken.has(i + 1)) continue;
    const line = lines[i]!.replace(/\s;.*$/, "");
    const hotkey = /^\s*((?:[#!^+<>*~$]*[\w]+|[#!^+<>*~$]+\S)(?:\s+&\s+\w+)?(?:\s+up)?)::(.*)$/i.exec(line);
    const label = hotkey ? null : /^\s*([A-Za-z_]\w*):\s*$/.exec(line);
    if (!hotkey && !label) continue;
    if (label && KEYWORDS.has(label[1]!.toLowerCase())) continue;
    const rest = hotkey?.[2]?.trim() ?? "";
    let end: number;
    let inline: { line: number; column: number } | undefined;
    if (rest && rest !== "{") {
      end = i + 1;
      inline = { line: i, column: line.indexOf("::") + 2 };
    } else if (rest === "{" || lines[i + 1]?.trim().startsWith("{")) {
      end = findEndLine(lines, rest === "{" ? i : i + 1, "brace");
    } else {
      end = i + 1;
      while (end < lines.length && !/^\s*return\b/i.test(lines[end]!)) end++;
      end = Math.min(end + 1, lines.length);
    }
    out.push({
      name: hotkey ? `${hotkey[1]}::` : label![1]!,
      params: [], returnType: null, isAsync: false, isExported: true,
      decorators: [hotkey ? "hotkey" : "label"],
      calls: dropKeywordCalls(extractCallsFromBody(lines, i + 1, end, [";"], [LABEL_CALL], inline)),
      line: i + 1, endLine: end,
    });
  }
  return out;
}

function ahkDataSources(lines: string[]): DataSourceInfo[] {
  const out = extractSqlStringDataSources(lines.map((l) => l.replace(/'((?:[^'`]|`.)*)'/g, (all, b: string) => (/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i.test(b) ? `"${b}"` : all))));
  const http = new Set<string>();
  for (const line of lines) {
    const m = /\b(\w+)\s*:?=\s*ComObj(?:ect|Create)\(\s*["']WinHttp\.WinHttpRequest\.5\.1["']/i.exec(line);
    if (m) http.add(m[1]!.toLowerCase());
  }
  for (let i = 0; i < lines.length; i++) {
    const push = (method: string, url: string) => {
      if (/^(?:https?:\/\/|\/)/.test(url)) out.push({ kind: "api-call", name: `${method} ${url}`, target: url, calls: [], line: i + 1 });
    };
    for (const m of lines[i]!.matchAll(/\b(\w+)\.Open\(\s*["'](\w+)["']\s*,\s*["']([^"']+)["']/gi)) if (http.has(m[1]!.toLowerCase())) push(m[2]!.toUpperCase(), m[3]!);
    for (const m of lines[i]!.matchAll(/\b(?:Download\(\s*["']|UrlDownloadToFile\s*,\s*)([^"',]+)/gi)) push("GET", m[1]!.trim());
  }
  return out.sort((a, b) => a.line - b.line);
}

export const autohotkeySpec: RegexLangSpec = {
  language: "autohotkey",
  extensions: [".ahk", ".ah2"],
  lineCommentPrefixes: [";"],
  // The auto-execute section — everything above the first hotkey or return — runs at start.
  topLevelCalls: true,

  functionPatterns: [{ pattern: FN_CANDIDATE }],
  classPatterns: [
    {
      pattern: /^\s*class\s+([A-Za-z_]\w*)/i,
      getExtends: (line) => /\bextends\s+([\w.]+)/i.exec(line)?.[1] ?? null,
    },
  ],
  propertyPatterns: [
    {
      pattern: /^\s*(static\s+)?([A-Za-z_]\w*)\s*:=\s*(.*)$/i,
      build: (m) => ({ name: m[2]!, type: null, visibility: "public", isStatic: !!m[1], isReadonly: false }),
    },
  ],
  parseParam: parseAhkParam,
  callPatterns: [LABEL_CALL],

  importPatterns: [
    {
      // #Include lib\Json.ahk / #Include <Json> / #Include %A_ScriptDir%\lib\db.ahk
      pattern: /^\s*#Include(?:Again)?\s+(?:\*i\s+)?(.+?)\s*$/i,
      getSource: (m) => {
        const raw = m[1]!.replace(/^["']|["']$/g, "");
        if (/^<.+>$/.test(raw)) return raw.slice(1, -1);
        const path = raw.replace(/^%A_(?:ScriptDir|LineFile\\\.\.)%[\\/]?/i, "").replace(/\\/g, "/");
        return /^\.{1,2}\//.test(path) || /^[A-Za-z]:/.test(path) ? path : `./${path}`;
      },
      getSpecifiers: () => [],
    },
  ],

  extractClasses: (lines: string[]): ClassInfo[] => {
    const classes = extractClassesWithSpec(lines, autohotkeySpec);
    for (const cls of classes) {
      cls.methods = cls.methods.filter(keep(lines));
      for (const m of cls.methods) m.calls = dropKeywordCalls(m.calls);
    }
    return classes;
  },
  postProcessFunctions: (lines, fns) => {
    const kept = fns.filter(keep(lines));
    for (const fn of kept) fn.calls = dropKeywordCalls(fn.calls);
    const taken = new Set(kept.map((f) => f.line));
    return [...kept, ...entryPoints(lines, taken)].sort((a, b) => a.line - b.line);
  },
  extractDataSources: (lines) => ahkDataSources(lines),
};

/** The `<setup>` calls go through the same keyword filter (the regex engine builds them). */
export function tidySetup(fns: FunctionInfo[]): void {
  const setup = fns.find((f) => f.name === "<setup>");
  if (setup) setup.calls = dropKeywordCalls(setup.calls);
}

/** The source with its block comments (opened by a slash-star at a line's start) blanked. Null when there are none. */
export function blankAhkComments(source: string): string | null {
  if (!/^\s*\/\*/m.test(source)) return null;
  const lines = source.split("\n");
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inside && /^\s*\/\*/.test(lines[i]!)) inside = true;
    if (inside) {
      const closes = /\*\//.test(lines[i]!);
      lines[i] = "";
      if (closes) inside = false;
    }
  }
  return lines.join("\n");
}
