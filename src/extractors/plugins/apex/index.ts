import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { findEndLine, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { splitTopLevelCommas } from "../shared/text-scan.js";
import { extractApexRoutes } from "./routes.js";

/**
 * Apex regex spec (no Apex grammar on npm loads in web-tree-sitter 0.27). Java-like and case-insensitive: braces
 * delimit blocks, a method is `[annotations] [modifiers] Type name(…) {`, a constructor has modifiers and no type.
 * A class, interface or enum is the class concept; inner classes are classes of their own, and each method belongs to
 * the innermost class around it. Annotations — on the line above or ahead of the declaration on its own line — are
 * decorators WITH their arguments (`AuraEnabled(cacheable=true)`, `RestResource(urlMapping='/clubs/*')`).
 * `trigger ClubTrigger on Club__c (before insert)` is a function carrying a `Trigger(Club__c; before insert)` decorator.
 * The text this reads is `source.ts`'s structure text: comments blanked, inline SOQL blanked, braces in strings swapped.
 */

const MODIFIERS = String.raw`(?:(?:global|public|private|protected|static|virtual|abstract|override|final|testmethod|webservice|transient|with\s+sharing|without\s+sharing|inherited\s+sharing)\s+)`;
const ANNOTATIONS = String.raw`(?:@\w+(?:\([^)]*\))?\s+)*`;
const KEYWORD_TYPE = String.raw`(?!(?:return|new|else|throw|insert|update|upsert|delete|undelete|merge|if|for|while|catch|switch|do|try|when|case|and|or|not|instanceof|trigger|class|interface|enum)\b)`;
const TYPE = String.raw`[\w.]+(?:\s*<[^()=;{}]*>)?(?:\s*\[\s*\])*`;

/** With a modifier the type is optional (a constructor); without one a type is required — `foo(x);` is a call. */
const METHOD_WITH_MODIFIER = new RegExp(String.raw`^\s*${ANNOTATIONS}${MODIFIERS}+(?:${KEYWORD_TYPE}${TYPE}\s+)?([A-Za-z_]\w*)\s*\(`, "i");
const METHOD_TYPED = new RegExp(String.raw`^\s*${ANNOTATIONS}${KEYWORD_TYPE}${TYPE}\s+([A-Za-z_]\w*)\s*\(`, "i");
const TRIGGER_HEAD = /^\s*trigger\s+([A-Za-z_]\w*)\s+on\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/i;
const TRIGGER_FN = /^\s*trigger\s+([A-Za-z_]\w*)\s+on\s+\w+\s*\(/i;

const CLASS_HEAD = new RegExp(
  String.raw`^\s*(${ANNOTATIONS})((?:(?:global|public|private|protected|virtual|abstract|static|final|with\s+sharing|without\s+sharing|inherited\s+sharing)\s+)*)(class|interface|enum)\s+([A-Za-z_]\w*)\b(.*)$`,
  "i",
);

/** The annotations leading a declaration line, as written minus the `@`. */
function inlineAnnotations(line: string): string[] {
  const head = /^\s*((?:@\w+(?:\([^)]*\))?\s+)+)/.exec(line)?.[1];
  return head ? [...head.matchAll(/@(\w+(?:\([^)]*\))?)/g)].map((m) => m[1]!) : [];
}

/** Annotation-only lines stacked right above line `i` (nearest last). */
function annotationsAbove(lines: readonly string[], i: number): string[] {
  const out: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j]!.trim();
    if (t === "") break;
    const m = /^(?:@\w+(?:\([^)]*\))?\s*)+$/.exec(t);
    if (!m) break;
    out.unshift(...[...t.matchAll(/@(\w+(?:\([^)]*\))?)/g)].map((x) => x[1]!));
  }
  return out;
}

const baseName = (t: string): string => t.replace(/<[\s\S]*$/, "").trim();

function parseApexParam(raw: string): ParamInfo | null {
  const m = /^\s*(?:final\s+)?([\s\S]+?)\s+([A-Za-z_]\w*)\s*$/.exec(raw);
  if (!m) return null;
  return { name: m[2]!, type: m[1]!.replace(/\s+/g, " "), defaultValue: null };
}

function parseReturnType(line: string, nameColumn?: number): string | null {
  if (TRIGGER_FN.test(line)) return null;
  const at = nameColumn ?? line.search(/\w+\s*\(/);
  const before = line.slice(0, at).replace(/@\w+(?:\([^)]*\))?\s*/g, "").replace(new RegExp(String.raw`${MODIFIERS}`, "gi"), "").trim();
  return before || null;
}

const FIELD = new RegExp(
  String.raw`^\s*${ANNOTATIONS}(${MODIFIERS}*)${KEYWORD_TYPE}(${TYPE})\s+([A-Za-z_]\w*)\s*(?:=|;|\{|$)`,
  "i",
);

/** Fields at the class's own brace depth. */
function fieldsOf(lines: readonly string[], cls: ClassInfo, inMethod: (line: number) => boolean): PropertyInfo[] {
  const props: PropertyInfo[] = [];
  let depth = 0;
  for (let i = cls.line - 1; i < Math.min(cls.endLine, lines.length); i++) {
    const line = lines[i]!;
    if (depth === 1 && i > cls.line - 1 && !inMethod(i + 1)) {
      const m = FIELD.exec(line);
      if (m && !/\(/.test(line.slice(0, line.indexOf(m[3]!) + m[3]!.length + 1))) {
        const mods = m[1]!.toLowerCase();
        props.push({
          name: m[3]!, type: m[2]!.replace(/\s+/g, " "),
          visibility: /\bprivate\b/.test(mods) ? "private" : /\bprotected\b/.test(mods) ? "protected" : "public",
          isStatic: /\bstatic\b/.test(mods), isReadonly: /\bfinal\b/.test(mods),
        });
      }
    }
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
  }
  return props;
}

function apexClasses(lines: string[], fns: FunctionInfo[]): ClassInfo[] {
  const classes: ClassInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CLASS_HEAD.exec(lines[i]!);
    if (!m) continue;
    const head = lines.slice(i, i + 4).join(" ");
    if (!head.includes("{")) continue;
    const rest = (m[5] ?? "") + (m[5]!.includes("{") ? "" : " " + lines.slice(i + 1, i + 4).join(" "));
    const header = rest.slice(0, rest.indexOf("{") < 0 ? undefined : rest.indexOf("{"));
    const ext = /\bextends\s+([\w.]+)/i.exec(header)?.[1] ?? null;
    const impl = /\bimplements\s+([^{]+)/i.exec(header)?.[1];
    const kind = m[3]!.toLowerCase();
    const cls: ClassInfo = {
      name: m[4]!,
      extends: ext,
      implements: impl ? splitTopLevelCommas(impl).map((s) => baseName(s)).filter(Boolean) : [],
      decorators: [...annotationsAbove(lines, i), ...inlineAnnotations(lines[i]!)],
      methods: [],
      properties: [],
      isExported: !/\bprivate\b/i.test(m[2]!),
      line: i + 1,
      endLine: findEndLine(lines, i, "brace"),
    };
    if (kind === "interface") cls.kind = "interface";
    else if (kind === "enum") cls.kind = "enum";
    classes.push(cls);
  }
  // Each method belongs to the innermost class around it; same-line annotations join the stacked ones.
  for (const fn of fns) {
    const owner = classes
      .filter((c) => c.line <= fn.line && fn.line <= c.endLine && !(c.line === fn.line && c.endLine === fn.endLine))
      .sort((a, b) => (a.endLine - a.line) - (b.endLine - b.line))[0];
    const inline = inlineAnnotations(lines[fn.line - 1] ?? "");
    for (const d of inline) if (!fn.decorators.includes(d)) fn.decorators.push(d);
    if (owner) owner.methods.push(fn);
  }
  for (const cls of classes) if (cls.kind !== "enum" && cls.kind !== "interface") cls.properties = fieldsOf(lines, cls, (line) => fns.some((f) => f.line <= line && line <= f.endLine));
  return classes;
}

/** `Type name` declarations in a method body: locals, for-each variables, caught exceptions. */
const LOCAL = new RegExp(String.raw`^\s*(?:final\s+)?${KEYWORD_TYPE}(${TYPE})\s+([A-Za-z_]\w*)\s*(?:=|;|,)`, "i");
const FOR_EACH = new RegExp(String.raw`\bfor\s*\(\s*(?:final\s+)?(${TYPE})\s+([A-Za-z_]\w*)\s*:`, "i");

const STATIC_CALL: CallPattern = {
  // `ClubService.promote(club)`: a capitalized receiver is a class, so a static call on it.
  pattern: /(?<![\w.])([A-Z]\w*)\.([A-Za-z_]\w*)\s*\(/,
  buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]!, receiverType: m[1]! }),
};
const NEW_CALL: CallPattern = {
  // `new ClubService().promote(club)`: the method of the class just constructed.
  pattern: /\bnew\s+([A-Za-z_]\w*)\s*(?:<[^()]*>)?\s*\((?:[^()]|\([^()]*\))*\)\s*\.\s*([A-Za-z_]\w*)\s*\(/i,
  buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2]!, receiverType: m[1]! }),
};

export const apexSpec: RegexLangSpec = {
  language: "apex",
  extensions: [".trigger"],
  lineCommentPrefixes: ["//"],
  functionPatterns: [
    { pattern: TRIGGER_HEAD, isExported: () => true },
    { pattern: METHOD_WITH_MODIFIER, isExported: (line) => !/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:static|final|virtual|override)\s+)*(?:private\b)/i.test(line) },
    { pattern: METHOD_TYPED, isExported: () => false },
  ],
  // Built by `apexClasses` (inner classes, same-line annotations).
  classPatterns: [],
  importPatterns: [],
  extractImports: () => [],
  callPatterns: [STATIC_CALL, NEW_CALL],
  parseParam: parseApexParam,
  parseReturnType,
  attributeLine: { pattern: /^\s*@((?:\w+)(?:\([^)]*\))?)\s*$/ },
  extractParams: (lines, i) => (TRIGGER_FN.test(lines[i] ?? "") ? [] : undefined),
  extractClasses: apexClasses,
  extractRoutes: (_lines, classes) => extractApexRoutes(classes),
  extractLocalTypes: (bodyLines) => {
    const out: NonNullable<FunctionInfo["localTypes"]> = [];
    for (const line of bodyLines) {
      const m = LOCAL.exec(line) ?? FOR_EACH.exec(line);
      if (m && !out.some((l) => l.name === m[2]!)) out.push({ name: m[2]!, type: m[1]!.replace(/\s+/g, " ") });
    }
    return out;
  },
  postProcessFunctions: (lines, fns) => {
    for (const fn of fns) {
      const t = TRIGGER_HEAD.exec(lines[fn.line - 1] ?? "");
      if (t && t[1] === fn.name) fn.decorators = [`Trigger(${t[2]}; ${t[3]!.replace(/\s+/g, " ").trim()})`, ...fn.decorators];
    }
    return fns;
  },
};
