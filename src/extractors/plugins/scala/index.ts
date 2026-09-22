import type { ClassInfo, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";

/**
 * Everything a declaration can inherit from: `extends A with B with C`.
 * Scala composes far more through `with` than through `extends`, so a spec
 * that reads only the `extends` token sees a fraction of the type graph.
 */
function parseHeritage(line: string): { base: string | null; mixins: string[] } {
  const ext = line.match(/\bextends\s+([A-Z]\w*(?:\.[A-Z]\w*)*)/);
  const mixins: string[] = [];
  for (const m of line.matchAll(/\bwith\s+([A-Z]\w*(?:\.[A-Z]\w*)*)/g)) mixins.push(m[1]!);
  return { base: ext?.[1] ?? null, mixins };
}

/**
 * The full text of a declaration header: its first line plus any continuation
 * lines up to the `{` that opens the body, bounded so a bodyless declaration
 * cannot run away.
 */
function declarationHeader(lines: string[], startIdx: number): string {
  const parts: string[] = [];
  for (let i = startIdx; i < Math.min(startIdx + 4, lines.length); i++) {
    const line = lines[i] ?? "";
    parts.push(line);
    if (line.includes("{")) break;
    const next = (lines[i + 1] ?? "").trim();
    if (!/^(?:extends|with)\b/.test(next)) break;
  }
  return parts.join(" ");
}

/** `id: Long`, `repo: OrderRepo = default` — Scala's `name: Type` parameter form. */
function parseScalaParam(paramText: string): ParamInfo | null {
  const text = paramText.trim().replace(/^(?:implicit|using|given)\s+/, "").replace(/^(?:val|var)\s+/, "");
  if (!text) return null;
  const m = text.match(/^([a-zA-Z_]\w*)\s*:\s*([^=]+?)\s*(?:=\s*(.+))?$/);
  if (!m) return /^[a-zA-Z_]\w*$/.test(text) ? { name: text, type: null, defaultValue: null } : null;
  return { name: m[1]!, type: m[2]!.trim(), defaultValue: m[3]?.trim() ?? null };
}

/**
 * The declared result type of a `def`: everything between the `)` (or the
 * name, for a parameterless def) and the `=` that opens the body. Feeds
 * `typeReferences`, which is how a Scala service reaches its model types.
 */
function parseScalaReturnType(line: string): string | null {
  const m = line.match(/\)\s*:\s*([^={]+?)\s*(?:=|\{|$)/) ?? line.match(/\bdef\s+\w+\s*:\s*([^={]+?)\s*(?:=|\{|$)/);
  const type = m?.[1]?.trim();
  return type && type !== "" ? type : null;
}

export const scalaSpec: RegexLangSpec = {
  language: "scala",
  extensions: [".scala"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

  functionPatterns: [
    {
      pattern: /\bdef\s+([a-zA-Z_]\w*)\s*[\[(:=]/,
      isExported: (line) => !line.trimStart().startsWith("private"),
    },
  ],

  classPatterns: [
    {
      pattern: /(?:^|\s)(?:case\s+)?class\s+([A-Z]\w*)/,
      getExtends: (line) => parseHeritage(line).base,
    },
    {
      pattern: /(?:^|\s)(?:sealed\s+)?trait\s+([A-Z]\w*)/,
      getExtends: (line) => parseHeritage(line).base,
    },
    {
      pattern: /(?:^|\s)(?:case\s+)?object\s+([A-Z]\w*)/,
      getExtends: (line) => parseHeritage(line).base,
    },
  ],

  /**
   * `val`/`var` members. The type annotation is REQUIRED: the class-body slice
   * also contains every method body, and a local `val x = compute()` is
   * indistinguishable from a field by shape alone. Annotated bindings are
   * overwhelmingly fields, so demanding one trades a few untyped fields for
   * not reporting locals as class state.
   */
  propertyPatterns: [
    {
      pattern: /^\s*(?:(private|protected)\s+)?(?:final\s+)?(val|var)\s+([a-zA-Z_]\w*)\s*:\s*([^=]+?)\s*(?:=|$)/,
      build: (m) => ({
        name: m[3]!,
        type: m[4]!.trim(),
        visibility: (m[1] as "private" | "protected" | undefined) ?? "public",
        isStatic: false,
        isReadonly: m[2] === "val",
      }),
    },
  ],

  parseParam: parseScalaParam,
  parseReturnType: parseScalaReturnType,

  /**
   * Wrap the generic extractor to read heritage from the whole declaration
   * header rather than its first line, and to attach `with` mixins as
   * `implements`. A long parameter list routinely pushes `extends … with …`
   * onto the next line, where the per-line `getExtends` cannot see it; a Scala
   * trait is closer to an interface than to a base class, so the mixin list
   * maps onto the same field Ruby's `include` uses.
   */
  extractClasses: (lines: string[], _fns: FunctionInfo[]): ClassInfo[] => {
    const classes = extractClassesWithSpec(lines, scalaSpec);
    for (const cls of classes) {
      const { base, mixins } = parseHeritage(declarationHeader(lines, cls.line - 1));
      if (base) cls.extends = base;
      for (const mixin of mixins) {
        if (!cls.implements.includes(mixin)) cls.implements.push(mixin);
      }
    }
    return classes;
  },

  importPatterns: [
    {
      pattern: /^\s*import\s+(.+)/,
      getSource: (m) => m[1].replace(/\.\{.*/, "").replace(/\._$/, ""),
      getSpecifiers: (m) => {
        const braces = m[1].match(/\{([^}]+)\}/);
        if (braces) return braces[1].split(",").map((s) => s.trim().split(" => ").pop()!.trim());
        const parts = m[1].replace(/_$/, "").split(".");
        return [parts[parts.length - 1]].filter((s) => s && s !== "_");
      },
    },
  ],
};
