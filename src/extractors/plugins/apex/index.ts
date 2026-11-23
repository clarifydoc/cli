import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { findEndLine, type RegexLangSpec } from "../shared/regex-base.js";
import { splitTopLevelCommas } from "../shared/text-scan.js";
import { ANNOTATION, ANNOTATIONS, CLASS_MODIFIERS, innermost, KEYWORD_TYPE, NEW_CALL, STATIC_CALL, TRIGGER_FN, TRIGGER_HEAD } from "./patterns.js";
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
const TYPE = String.raw`[\w.]+(?:\s*<[^()=;{}]*>)?(?:\s*\[\s*\])*`;

/** With a modifier the type is optional (a constructor); without one a type is required — `foo(x);` is a call. */
const METHOD_WITH_MODIFIER = new RegExp(String.raw`^\s*${ANNOTATIONS}${MODIFIERS}+(?:${KEYWORD_TYPE}${TYPE}\s+)?([A-Za-z_]\w*)\s*\(`, "i");
const METHOD_TYPED = new RegExp(String.raw`^\s*${ANNOTATIONS}${KEYWORD_TYPE}${TYPE}\s+([A-Za-z_]\w*)\s*\(`, "i");

const CLASS_HEAD = new RegExp(
  String.raw`^\s*(${ANNOTATIONS})(${CLASS_MODIFIERS})(class|interface|enum)\s+([A-Za-z_]\w*)\b(.*)$`,
  "i",
);

/** The annotations leading a declaration line, as written minus the `@`. */
function inlineAnnotations(line: string): string[] {
  const head = new RegExp(String.raw`^\s*((?:${ANNOTATION}\s+)+)`).exec(line)?.[1];
  return head ? [...head.matchAll(ANNOTATION_NAME)].map((m) => m[1]!) : [];
}

const ANNOTATION_ONLY = new RegExp(String.raw`^(?:${ANNOTATION}\s*)+$`);
const ANNOTATION_NAME = new RegExp(`@(${ANNOTATION.slice(1)})`, "g");
const ANNOTATION_TEXT = new RegExp(`${ANNOTATION}\\s*`, "g");
const MODIFIER_WORDS = new RegExp(MODIFIERS, "gi");

/** Annotation-only lines stacked right above line `i` (nearest last). */
function annotationsAbove(lines: readonly string[], i: number): string[] {
  const out: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j]!.trim();
    if (t === "") break;
    const m = ANNOTATION_ONLY.exec(t);
    if (!m) break;
    out.unshift(...[...t.matchAll(ANNOTATION_NAME)].map((x) => x[1]!));
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
  const before = line.slice(0, at).replace(ANNOTATION_TEXT, "").replace(MODIFIER_WORDS, "").trim();
  return before || null;
}

const FIELD = new RegExp(
  String.raw`^\s*${ANNOTATIONS}(${MODIFIERS}*)${KEYWORD_TYPE}(${TYPE})\s+([A-Za-z_]\w*)\s*(?:=|;|\{|$)`,
  "i",
);

/** Fields at the class's own brace depth. */
function fieldsOf(lines: readonly string[], cls: ClassInfo, methodLines: ReadonlySet<number>): PropertyInfo[] {
  const props: PropertyInfo[] = [];
  let depth = 0;
  for (let i = cls.line - 1; i < Math.min(cls.endLine, lines.length); i++) {
    const line = lines[i]!;
    if (depth === 1 && i > cls.line - 1 && !methodLines.has(i + 1)) {
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
    const headerEnd = rest.search(/[{;]/);
    const header = headerEnd < 0 ? rest : rest.slice(0, headerEnd);
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
    const owner = innermost(classes.filter((c) => !(c.line === fn.line && c.endLine === fn.endLine)), fn.line);
    const inline = inlineAnnotations(lines[fn.line - 1] ?? "");
    for (const d of inline) if (!fn.decorators.includes(d)) fn.decorators.push(d);
    if (owner) owner.methods.push(fn);
  }
  const methodLines = new Set<number>();
  for (const f of fns) for (let l = f.line; l <= f.endLine; l++) methodLines.add(l);
  for (const cls of classes) if (cls.kind !== "enum" && cls.kind !== "interface") cls.properties = fieldsOf(lines, cls, methodLines);
  return classes;
}

/** `Type name` declarations in a method body: locals, for-each variables, caught exceptions. */
const LOCAL = new RegExp(String.raw`^\s*(?:final\s+)?${KEYWORD_TYPE}(${TYPE})\s+([A-Za-z_]\w*)\s*(?:=|;|,)`, "i");
const FOR_EACH = new RegExp(String.raw`\bfor\s*\(\s*(?:final\s+)?(${TYPE})\s+([A-Za-z_]\w*)\s*:`, "i");

const PRIVATE_METHOD = new RegExp(String.raw`^\s*${ANNOTATIONS}(?:(?:static|final|virtual|override)\s+)*(?:private\b)`, "i");

export const apexSpec: RegexLangSpec = {
  language: "apex",
  extensions: [".trigger"],
  lineCommentPrefixes: ["//"],
  functionPatterns: [
    { pattern: TRIGGER_HEAD, isExported: () => true },
    { pattern: METHOD_WITH_MODIFIER, isExported: (line) => !PRIVATE_METHOD.test(line) },
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
