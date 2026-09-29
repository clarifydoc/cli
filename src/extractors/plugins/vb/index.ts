import type { PropertyInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, type RegexLangSpec } from "../shared/regex-base.js";
import { extractWinFormsScreens } from "./winforms-screens.js";
import { extractVbDataSources } from "./data-sources.js";
import { extractVbRoutes } from "./routes.js";
import { readVbType, splitVbAttributes } from "./request-schema.js";

/** Inline `<Attr>` lists at the start of a declaration line, as a regex source. */
const INLINE_ATTRS = String.raw`((?:<[^<>]*(?:"[^"]*"[^<>]*)*>\s*)*)`;

/** The attributes of an inline `<A> <B("x")>` prefix, split one per entry. */
function inlineAttributes(prefix: string): string[] {
  return [...prefix.matchAll(/<([^<>]*(?:"[^"]*"[^<>]*)*)>/g)].flatMap((m) => splitVbAttributes(m[1]!));
}

/**
 * VB block-end detection uses `Sub`/`End Sub`, `Function`/`End Function`, `Class`/`End Class`, etc.
 * The regex must consume whitespace between modifiers — otherwise `Private Async Sub` won't match.
 */
const VB_OPEN_RE = /^\s*(?:(?:Public|Private|Friend|Protected|Shared|Static|Partial|Async|Overrides|Overridable|Overloads|ReadOnly|WriteOnly|Default|MustOverride|NotOverridable|NotInheritable|MustInherit)\s+)*(Sub|Function|Property|Class|Module|Structure|Interface|Enum|Namespace|If|Select|While|With|For|Try|SyncLock|Using|Do)\b/i;
const VB_END_RE = /^\s*End\s+(Sub|Function|Property|Class|Module|Structure|Interface|Enum|Namespace|If|Select|While|With|For|Try|SyncLock|Using|Do)\b/i;

const vbBase: RegexLangSpec = {
  language: "vb",
  extensions: [".vb", ".bas", ".cls", ".frm"],
  blockStyle: "keyword-end",
  keywordEnd: { openRe: VB_OPEN_RE, endRe: VB_END_RE },
  // VB line comments: ' (tick) or REM keyword
  lineCommentPrefixes: ["'", "REM ", "rem "],

  // VB: `ClassName.method()` — shared static/instance access pattern
  callPatterns: [
    {
      pattern: /\b([A-Z]\w+)\.(\w+)\s*\(/,
      buildName: (m) => ({ name: `${m[1]}.${m[2]}`, leafName: m[2] }),
    },
  ],

  // VB: `name As Type` / `ByVal name As Type` / `Optional name As Type = default`
  // / `<FromBody> request As T`. A leading attribute list is skipped (it is
  // read by the route extractor), and the type keeps its generic arguments.
  parseParam: (p) => {
    const trimmed = p.trim().replace(/^(?:<[^<>]*(?:"[^"]*"[^<>]*)*>\s*)+/, "");
    if (!trimmed) return null;
    const m = trimmed.match(/^(?:(?:ByVal|ByRef|Optional|ParamArray)\s+)*(\w+)(\s+As\s+)?/i);
    if (!m) return null;
    const type = m[2] ? readVbType(trimmed, m[0].length)?.type ?? null : null;
    const def = trimmed.match(/=\s*(.+)$/);
    return { name: m[1]!, type, defaultValue: def ? def[1]!.trim() : null };
  },

  // VB: `Private ReadOnly _svc As ServiceType` (fields) and
  // `<Required> Public Property Name As String` (auto-properties, the shape
  // every DTO has). Attributes sit inline or on the line above (`attributeLine`).
  propertyPatterns: [
    {
      pattern: new RegExp(String.raw`^\s*` + INLINE_ATTRS + String.raw`(Public|Private|Friend|Protected)\s+(?:(?:ReadOnly|Shared|WithEvents)\s+)*(\w+)\s+As\s+(?:New\s+)?`, "i"),
      build: (m, line) => {
        // Skip method / property / event / const declarations (they use the same start)
        if (/\b(Sub|Function|Property|Event|Const)\b/i.test(line)) return null;
        const visibility = m[2]!.toLowerCase();
        const prop: PropertyInfo = {
          name: m[3]!,
          type: readVbType(line, m[0].length)?.type ?? null,
          visibility: (["public", "private", "protected"].includes(visibility)
            ? visibility
            : "private") as "public" | "private" | "protected",
          isStatic: /\bShared\b/i.test(line),
          isReadonly: /\bReadOnly\b/i.test(line),
        };
        const attrs = inlineAttributes(m[1]!);
        if (attrs.length > 0) prop.decorators = attrs;
        return prop;
      },
    },
    {
      pattern: new RegExp(
        String.raw`^\s*` + INLINE_ATTRS +
          String.raw`(?:(Public|Private|Friend|Protected)\s+)?(?:(?:Protected\s+Friend|Shared|ReadOnly|WriteOnly|Overridable|Overrides|MustOverride|NotOverridable|Overloads|Shadows|Default)\s+)*Property\s+(\w+)(?:\(\))?\s+As\s+(?:New\s+)?`,
        "i",
      ),
      build: (m, line) => {
        const visibility = (m[2] ?? "Public").toLowerCase();
        const prop: PropertyInfo = {
          name: m[3]!,
          type: readVbType(line, m[0].length)?.type ?? null,
          visibility: (["public", "private", "protected"].includes(visibility)
            ? visibility
            : "private") as "public" | "private" | "protected",
          isStatic: /\bShared\b/i.test(line),
          isReadonly: /\bReadOnly\b/i.test(line),
        };
        const attrs = inlineAttributes(m[1]!);
        if (attrs.length > 0) prop.decorators = attrs;
        return prop;
      },
    },
  ],

  /** `<Required>` / `<JsonProperty("x")> _` on the line above a declaration. */
  attributeLine: { pattern: /^\s*<(.*)>\s*_?\s*$/ },

  functionPatterns: [
    {
      // Sub Foo() / Function Foo() As Type / Public Sub Foo / Private Function Foo
      // Covers VB.NET and VBA
      // `Function [Get](…)` escapes a keyword name with brackets.
      pattern: /^\s*(?:<[^<>]*(?:"[^"]*"[^<>]*)*>\s*)*(?:Public\s+|Private\s+|Friend\s+|Protected\s+|Shared\s+|Static\s+|Overrides\s+|Overridable\s+|Async\s+)*(?:Sub|Function)\s+\[?([A-Za-z_]\w*)\]?\s*\(/i,
      isExported: (line) => !/\b(Private|Friend)\b/i.test(line),
      isAsync: (line) => /\bAsync\b/i.test(line),
    },
    {
      // Property Get/Set/Let Name()
      pattern: /^\s*(?:Public\s+|Private\s+|Friend\s+|Protected\s+|Shared\s+)*Property\s+(?:Get|Set|Let)\s+([A-Za-z_]\w*)/i,
      isExported: (line) => !/\b(Private|Friend)\b/i.test(line),
    },
  ],

  classPatterns: [
    {
      // Class Foo / Public Class Foo / Module Foo
      // In VB.NET, `Inherits Parent` typically appears on the line after the class declaration.
      // The single-line check here catches single-line cases; multi-line cases are handled below
      // via post-processing after class extraction.
      pattern: /^\s*(?:Public\s+|Private\s+|Friend\s+)*(?:Partial\s+)?(?:Class|Module|Structure)\s+([A-Za-z_]\w*)/i,
      getExtends: (line) => {
        const m = line.match(/\bInherits\s+([A-Za-z_][\w.]*)/i);
        return m?.[1] ?? null;
      },
    },
    {
      pattern: /^\s*(?:Public\s+|Private\s+|Friend\s+)*Interface\s+([A-Za-z_]\w*)/i,
      getExtends: () => null,
    },
  ],

  /**
   * Post-pass to catch `Inherits Foo` / `Implements IFoo` on lines following the class declaration.
   * VB places these keywords on separate lines by convention.
   */
  /**
   * Post-pass: pick up `Inherits Foo` / `Implements IFoo` keywords which
   * in VB idiomatically appear on the line after the class declaration.
   */
  extractClasses: (lines, _fns) => {
    const classes = extractClassesWithSpec(lines, vbBase);
    for (const cls of classes) {
      for (let i = cls.line; i < Math.min(cls.line + 5, lines.length); i++) {
        const line = lines[i];
        if (!cls.extends) {
          const inh = line.match(/^\s*Inherits\s+([A-Za-z_][\w.]*)/i);
          if (inh) cls.extends = inh[1];
        }
        const impl = line.match(/^\s*Implements\s+([A-Za-z_][\w.,\s]*)/i);
        if (impl) {
          for (const name of impl[1].split(",").map((s) => s.trim()).filter(Boolean)) {
            if (!cls.implements.includes(name)) cls.implements.push(name);
          }
        }
      }
    }
    return classes;
  },

  importPatterns: [
    {
      // Imports System.IO  /  Imports Alias = System.IO
      // VB's `Imports` brings a namespace into scope — there's no explicit symbol list.
      // We keep specifiers empty to avoid false matches against file basenames.
      // The component graph resolver still matches the namespace path to directories.
      pattern: /^\s*Imports\s+(?:([A-Za-z_]\w*)\s*=\s*)?([A-Za-z_][\w.]*)/i,
      getSource: (m) => m[2],
      getSpecifiers: (m) => {
        if (m[1]) return [m[1]]; // explicit alias
        return []; // plain namespace import — no specifiers
      },
    },
  ],

  extractRoutes: (lines, classes) => extractVbRoutes(lines, classes, vbBase),

  extractScreens: extractWinFormsScreens,
  extractDataSources: extractVbDataSources,
};

export const vbSpec: RegexLangSpec = vbBase;
