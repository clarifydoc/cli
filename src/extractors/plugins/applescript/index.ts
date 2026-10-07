import type { CallInfo, ClassInfo, DataSourceInfo, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, type RegexLangSpec } from "../shared/regex-base.js";

/**
 * AppleScript regex spec (`.applescript` source; a compiled `.scpt` is
 * binary). A handler is `on name(…)` / `to name(…)` … `end name`; a script
 * object `script Name` … `end script` is the class concept, its handlers
 * its methods and its `property x : …` lines its properties. The file's own
 * statements are the implicit `run` handler (`<setup>`).
 */

/** Words that read like a call but are the language's. */
const KEYWORDS = new Set([
  "if", "then", "else", "repeat", "while", "until", "with", "tell", "considering", "ignoring", "try", "on", "error", "return",
  "set", "copy", "get", "my", "of", "in", "to", "not", "and", "or", "is", "contains", "end", "exit", "using", "timeout",
  "transaction", "given", "true", "false", "every", "whose", "where", "item", "items", "count", "class", "as", "a", "an", "the",
  // Element specifiers and coercions — `paragraph (n) of x`, `text 1 thru (n)`,
  // `alias (p)`, `display dialog (msg)` — read like calls, name no handler.
  "display", "dialog", "alert", "paragraph", "paragraphs", "thru", "through", "alias", "file", "folder", "text", "character",
  "characters", "word", "words", "bottom", "top", "front", "back", "beginning", "last", "first", "middle", "some", "date",
  "list", "record", "number", "integer", "real", "string", "posix", "path", "quoted", "form", "offset", "round", "length",
]);

const dropKeywordCalls = (calls: CallInfo[]) => calls.filter((c) => !KEYWORDS.has(c.name.toLowerCase()));

/** `name`, `greeting : "Hi"` (a labeled parameter's default), `given name:n` → n. */
function parseAsParam(raw: string): ParamInfo | null {
  const text = raw.trim();
  const labeled = /^\w+\s*:\s*(\w+)$/.exec(text);
  if (labeled) return { name: labeled[1]!, type: null, defaultValue: null };
  return /^[A-Za-z_]\w*$/.test(text) ? { name: text, type: null, defaultValue: null } : null;
}

/** A handler's parameters: positional `on greet(name, greeting)`, labeled `on greet given name:n, mood:m`. */
function handlerParams(line: string): ParamInfo[] {
  const positional = /^\s*(?:on|to)\s+\w+\s*\(([^)]*)\)/i.exec(line)?.[1];
  const labeled = /\bgiven\s+(.+?)\s*(?:--.*)?$/i.exec(line)?.[1];
  const list = positional ?? labeled ?? "";
  return list.split(",").map(parseAsParam).filter((p): p is ParamInfo => p !== null);
}

/**
 * The text a `do shell script` builds, its concatenated variables as holes:
 * `"curl …/orders/" & orderId & "/close"` → `curl …/orders/{orderId}/close`.
 */
function shellText(line: string): string | null {
  const at = /\bdo shell script\s+/i.exec(line);
  if (!at) return null;
  let text = "";
  for (const m of line.slice(at.index + at[0].length).matchAll(/"((?:[^"\\]|\\.)*)"|&\s*(?:quoted form of\s+)?(\w+)/gi)) {
    text += m[1] ?? `{${m[2]}}`;
  }
  return text || null;
}

/** curl in a `do shell script "…"` string → method + URL. */
function shellHttp(line: string): { method: string; url: string } | null {
  const shell = shellText(line);
  if (!shell || !/\bcurl\b/.test(shell)) return null;
  const url = /(https?:\/\/[^\s"'\\]+)/.exec(shell)?.[1];
  if (!url) return null;
  const explicit = /(?:-X|--request)\s+(\w+)/.exec(shell)?.[1];
  const method = explicit ?? (/(?:^|\s)(?:-d|--data(?:-raw|-binary)?|-F|--form)\b/.test(shell) ? "POST" : "GET");
  return { method: method.toUpperCase(), url };
}

function asDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const http = shellHttp(lines[i]!);
    if (http) out.push({ kind: "api-call", name: `${http.method} ${http.url}`, target: http.url, calls: [], line: i + 1 });
  }
  return out;
}

/** The source with `(* … *)` comments blanked, line structure kept. Null when there are none. */
export function blankAsComments(source: string): string | null {
  if (!source.includes("(*")) return null;
  let out = "";
  let depth = 0;
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (depth === 0 && c === '"' && source[i - 1] !== "\\") inString = !inString;
    if (!inString && c === "(" && source[i + 1] === "*") { depth++; out += "  "; i++; continue; }
    if (depth > 0 && c === "*" && source[i + 1] === ")") { depth--; out += "  "; i++; continue; }
    out += depth > 0 && c !== "\n" ? " " : c;
  }
  return out;
}

export const applescriptSpec: RegexLangSpec = {
  language: "applescript",
  extensions: [".applescript"],
  lineCommentPrefixes: ["--", "#"],
  topLevelCalls: true,
  blockStyle: "keyword-end",
  // A handler ends with `end <its name>`, a script object with `end script`.
  keywordEnd: { openRe: /^\s*(?:(?:on|to)\s+|(?=script\b))(\w+)/i, endRe: /^\s*end\s+(\w+)/i },

  // `on error` inside a `try` is a clause, not a handler.
  functionPatterns: [{ pattern: /^\s*(?:on|to)\s+(?!error\b)(\w+)/i }],
  classPatterns: [{ pattern: /^\s*script\s+(\w+)/i, getExtends: () => null }],
  propertyPatterns: [
    {
      pattern: /^\s*(?:property|prop)\s+(\w+)\s*:/i,
      build: (m) => ({ name: m[1]!, type: null, visibility: "public", isStatic: false, isReadonly: false }),
    },
  ],
  callPatterns: [
    {
      // `my save(order)` / `save(order) of me` — the script's own handler.
      pattern: /\bmy\s+(\w+)\s*\(/i,
      buildName: (m) => ({ name: m[1]!, leafName: m[1]! }),
    },
  ],

  importPatterns: [
    {
      // use script "Helpers" / use framework "Foundation" (a system framework, read as a package).
      pattern: /^\s*use\s+(?:script|framework)\s+"([^"]+)"/i,
      getSource: (m) => m[1]!,
      getSpecifiers: (m) => [m[1]!],
    },
    {
      // set helpers to load script POSIX file "/path/helpers.scpt"
      pattern: /\bload script\s+(?:POSIX\s+)?(?:file|alias)\s+"([^"]+)"/i,
      getSource: (m) => m[1]!,
      getSpecifiers: () => [],
    },
  ],

  extractClasses: (lines: string[], _fns: FunctionInfo[]): ClassInfo[] => {
    const classes = extractClassesWithSpec(lines, applescriptSpec);
    for (const cls of classes) {
      for (const m of cls.methods) {
        m.params = handlerParams(lines[m.line - 1] ?? "");
        m.calls = dropKeywordCalls(m.calls);
      }
    }
    return classes;
  },
  postProcessFunctions: (lines, fns) => {
    for (const fn of fns) {
      fn.params = handlerParams(lines[fn.line - 1] ?? "");
      fn.calls = dropKeywordCalls(fn.calls);
    }
    return fns;
  },
  extractDataSources: (lines) => asDataSources(lines),
};

export function tidySetup(fns: FunctionInfo[]): void {
  const setup = fns.find((f) => f.name === "<setup>");
  if (setup) setup.calls = dropKeywordCalls(setup.calls);
}
