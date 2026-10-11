import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, type RegexLangSpec } from "../shared/regex-base.js";
import { ANY_NAME, QUALIFIED, RAKU_CALLS, SCOPE } from "./calls.js";
import { extractRakuRoutes } from "./routes.js";
import { extractRakuDataSources } from "./data-sources.js";

/**
 * Raku regex spec (Cro, Humming-Bird, DBIish). Raku has no tree-sitter
 * grammar on npm, so it takes the regex path. Names may contain hyphens and
 * apostrophes (`get-user`, `isn't`), and a call's parenthesis touches its name
 * (`f(x)`; `f (x)` passes a list) — so Raku states every call form itself.
 */

/** `Str $name`, `Int :$limit = 10`, `$id`, `*@rest`, `Repo $repo where *.ok`, `::?CLASS:D: `. */
function parseRakuParam(raw: string): ParamInfo | null {
  let text = raw.trim();
  const arrow = text.indexOf("-->"); // `--> Str`: the return type, not part of the parameter
  if (arrow >= 0) text = text.slice(0, arrow).trimEnd();
  text = text.replace(/\s+where\s+.*$/, "").replace(/\s+is\s+\w+.*$/, "");
  if (!text || /:\s*$/.test(text)) return null;
  let defaultValue: string | null = null;
  const eq = text.search(/=(?!=)/);
  if (eq >= 0) { defaultValue = text.slice(eq + 1).trim() || null; text = text.slice(0, eq).trim(); }
  const m = new RegExp(String.raw`^(?:(${QUALIFIED}(?::[DU_])?)\s+)?[*:|\\]*[$@%&]!?\.?(${ANY_NAME})[?!]?$`).exec(text);
  return m ? { name: m[2]!, type: m[1] ?? null, defaultValue } : null;
}

function parseRakuReturnType(line: string): string | null {
  return /-->\s*([\w:]+)/.exec(line)?.[1] ?? /\breturns\s+([\w:]+)/.exec(line)?.[1] ?? null;
}

/** `has Str $.name is rw`, `has @.items`, `has Repo $!repo is required`. */
const HAS = new RegExp(String.raw`^\s*has\s+(?:(${QUALIFIED})\s+)?([$@%&])([.!])(${ANY_NAME})`);

function buildHas(m: RegExpMatchArray, line: string): PropertyInfo {
  return {
    name: m[4]!,
    type: m[1] ?? (m[2] === "@" ? "Array" : m[2] === "%" ? "Hash" : null),
    visibility: m[3] === "!" ? "private" : "public",
    isStatic: false,
    isReadonly: !/\bis\s+rw\b/.test(line),
  };
}

const HERITAGE = (line: string) => ({
  base: new RegExp(String.raw`\bis\s+(${QUALIFIED})`).exec(line)?.[1] ?? null,
  roles: [...line.matchAll(new RegExp(String.raw`\bdoes\s+(${QUALIFIED})`, "g"))].map((x) => x[1]!),
});

export const rakuSpec: RegexLangSpec = {
  language: "raku",
  extensions: [".raku", ".rakumod", ".rakutest", ".p6", ".pm6", ".pl6", ".t6"],
  lineCommentPrefixes: ["#"],
  topLevelCalls: true,

  functionPatterns: [
    { pattern: new RegExp(String.raw`^\s*${SCOPE}(?:sub|method|submethod)\s+[!^]?(${ANY_NAME})`), isExported: (line) => !/\bmy\s+sub\b|method\s+!/.test(line) },
    // A `multi` / `proto` with the declarator left out: `multi greet(Str $who) { … }`.
    { pattern: new RegExp(String.raw`^\s*(?:multi|proto)\s+(?!sub\b|method\b|submethod\b)(${ANY_NAME})\s*\(`) },
  ],
  callPatterns: RAKU_CALLS,

  classPatterns: [
    {
      pattern: new RegExp(String.raw`^\s*(?:(?:my|our|unit)\s+)?(?:class|grammar)\s+(${QUALIFIED})`),
      getExtends: (line) => HERITAGE(line).base,
      getImplements: (line) => HERITAGE(line).roles,
    },
    { pattern: new RegExp(String.raw`^\s*(?:(?:my|our|unit)\s+)?role\s+(${QUALIFIED})`), kind: "interface", getExtends: () => null },
    { pattern: new RegExp(String.raw`^\s*(?:(?:my|our|unit)\s+)?(?:module|package)\s+(${QUALIFIED})`), getExtends: () => null },
    { pattern: new RegExp(String.raw`^\s*(?:(?:my|our)\s+)?enum\s+(${QUALIFIED})`), kind: "enum", getExtends: () => null },
  ],

  propertyPatterns: [{ pattern: HAS, build: buildHas }],
  parseParam: parseRakuParam,
  parseReturnType: parseRakuReturnType,

  importPatterns: [
    {
      // use Cro::HTTP::Router; / need DBIish; / require JSON::Fast; — never
      // `use v6` or a lowercase pragma (`use lib 'lib'`, `use nqp`).
      pattern: new RegExp(String.raw`^\s*(?:use|need|require)\s+(?=[A-Z])(${QUALIFIED})`),
      getSource: (m) => m[1]!,
      getSpecifiers: () => [],
    },
  ],

  extractClasses: (lines: string[], fns: FunctionInfo[]): ClassInfo[] => {
    const classes = extractClassesWithSpec(lines, rakuSpec);
    // `unit class Foo;` declares the rest of the file as the class: every
    // routine of the file is its method, every `has` its attribute. A
    // `unit module`'s subs stay subs — a module is a namespace, not a class.
    for (const cls of classes) {
      if (!/^\s*unit\s+(?:class|role|grammar)\b/.test(lines[cls.line - 1] ?? "")) continue;
      cls.endLine = lines.length;
      cls.methods = fns.filter((f) => f.line > cls.line);
      cls.properties = [];
      for (const line of lines.slice(cls.line)) {
        const m = HAS.exec(line);
        if (m) cls.properties.push(buildHas(m, line));
      }
    }
    return classes;
  },

  extractRoutes: (lines) => extractRakuRoutes(lines),
  extractDataSources: (lines) => extractRakuDataSources(lines),
};

