import type { ClassInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, findEndLine, splitTopLevel, type RegexLangSpec } from "../shared/regex-base.js";
import { extractCrystalDataSources } from "./data-sources.js";
import { crystalRouteBlocks, extractCrystalRoutes } from "./routes.js";
import { CRYSTAL_CALL_PATTERNS, extractCrystalLocalTypes } from "./calls.js";

/**
 * Crystal regex spec (Kemal, Amber, Lucky, Athena, Marten, Spider-Gazelle).
 * No tree-sitter grammar for Crystal is published to npm, so Crystal takes
 * the regex path. `crystal tool format` fixes indentation at two spaces, so a
 * block ends at the first line indented no deeper than its opener — the same
 * rule the Ruby spec reads `def … end` with.
 *
 * Types are written after the name: `def find(id : Int64) : User?`,
 * `property name : String`, `@repo : Repo`. `def initialize(@repo : Repo)`
 * declares the instance variable it assigns — the class's injection point.
 */

const DEF = /^\s*(?:(?:private|protected)\s+)?(?:abstract\s+)?def\s+(?:self\.)?([a-zA-Z_]\w*[?!=]?)/;
const MACRO = /^\s*(?:private\s+)?macro\s+([a-z_]\w*[?!]?)/;

/** `name : Type = default`, `@repo : Repo`, `*args : String`, `&block : ->`, `from start : Int32`. */
export function parseCrystalParam(raw: string): ParamInfo | null {
  let text = raw.trim();
  if (!text || text.startsWith("&")) return null;
  let defaultValue: string | null = null;
  const eq = text.search(/=(?![=>])/);
  if (eq >= 0) {
    defaultValue = text.slice(eq + 1).trim() || null;
    text = text.slice(0, eq).trim();
  }
  let type: string | null = null;
  const colon = text.search(/\s:\s|\s:$|:\s/);
  if (colon >= 0) {
    type = text.slice(colon).replace(/^\s*:\s*/, "").trim() || null;
    text = text.slice(0, colon).trim();
  }
  // An external name precedes the internal one: `def copy(from source : Path)`.
  const m = /(?:^|\s)[*]{0,2}@{0,2}([a-z_]\w*)$/.exec(text);
  return m ? { name: m[1]!, type, defaultValue } : null;
}

/** `def find(id : Int64) : User?` / `def name : String` → the type after the signature. */
function parseCrystalReturnType(line: string): string | null {
  const code = line.replace(/\s+#.*$/, "");
  const afterParams = /\)\s*:\s*([^=]+?)\s*$/.exec(code) ?? /def\s+(?:self\.)?[\w?!=]+\s*:\s*([^=(]+?)\s*$/.exec(code);
  return afterParams ? afterParams[1]!.replace(/\s+forall\s+.*$/, "") : null;
}

/** `property name : String = ""`, `getter? admin : Bool`, `class_getter config : Config`. */
const ACCESSOR = /^\s*(?:(?:private|protected)\s+)?(?:class_)?(property|getter|setter)[?!]?\s+([a-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=.*)?$/;
/** An instance-variable declaration in the class body: `@name : String`. */
const IVAR = /^\s*@([a-z_]\w*)\s*:\s*([^=]+?)\s*(?:=.*)?$/;

function prop(name: string, type: string | null, readonly: boolean, decorators?: string[]): PropertyInfo {
  const p: PropertyInfo = { name, type: type?.trim() || null, visibility: "public", isStatic: false, isReadonly: readonly };
  if (decorators && decorators.length > 0) p.decorators = decorators;
  return p;
}

/**
 * The class body lines at its own depth — what is declared ON the class, not
 * inside one of its methods or nested types. Crystal's formatter indents a
 * body two spaces past its opener.
 */
function ownBodyLines(lines: string[], cls: ClassInfo): Array<[number, string]> {
  const indent = (lines[cls.line - 1]!.match(/^\s*/)?.[0].length ?? 0) + 2;
  const out: Array<[number, string]> = [];
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const line = lines[i]!;
    if (line.trim() && (line.match(/^\s*/)?.[0].length ?? 0) === indent) out.push([i, line]);
  }
  return out;
}

/** `include Comparable(Order)` / `extend Mod` / `include Granite::Validators` at class depth. */
function mixins(body: Array<[number, string]>): string[] {
  const out: string[] = [];
  for (const [, line] of body) {
    const m = /^\s*(?:include|extend)\s+([A-Z][\w:]*)/.exec(line);
    if (m && !out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/**
 * `record Point, x : Int32, y : Int32 = 0` — a macro that declares a struct
 * with those getters (and an optional `do … end` body).
 */
function records(lines: string[]): ClassInfo[] {
  const out: ClassInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*record\s+([A-Z]\w*)\s*(?:,\s*(.*?))?\s*(do)?\s*$/.exec(lines[i]!);
    if (!m) continue;
    const end = m[3] ? findEndLine(lines, i, "indent") : i + 1;
    const properties = splitTopLevel(m[2] ?? "")
      .map((f) => parseCrystalParam(f))
      .filter((p): p is ParamInfo => p !== null)
      .map((p) => prop(p.name, p.type, true));
    out.push({ name: m[1]!, extends: null, implements: [], decorators: [], methods: [], properties, isExported: true, line: i + 1, endLine: Math.max(end, i + 1) });
  }
  return out;
}

export const crystalSpec: RegexLangSpec = {
  language: "crystal",
  extensions: [".cr"],
  indentBased: true,
  lineCommentPrefixes: ["#"],
  // A Kemal app is a script: its routes are registered when it loads.
  topLevelCalls: true,
  deferredBlocks: crystalRouteBlocks,

  functionPatterns: [
    { pattern: DEF, isExported: (line) => !/^\s*(?:private|protected)\b/.test(line) },
    { pattern: MACRO, isExported: (line) => !/^\s*private\b/.test(line) },
  ],

  callPatterns: CRYSTAL_CALL_PATTERNS,

  classPatterns: [
    {
      pattern: /^\s*(?:private\s+)?(?:abstract\s+)?(?:class|struct)\s+((?:[A-Z]\w*::)*[A-Z]\w*)/,
      getExtends: (line) => /<\s*((?:[A-Z]\w*::)*[A-Z]\w*)/.exec(line)?.[1] ?? null,
    },
    { pattern: /^\s*(?:private\s+)?module\s+((?:[A-Z]\w*::)*[A-Z]\w*)/, getExtends: () => null },
    { pattern: /^\s*(?:private\s+)?enum\s+((?:[A-Z]\w*::)*[A-Z]\w*)/, kind: "enum", getExtends: () => null },
  ],

  propertyPatterns: [],
  parseParam: parseCrystalParam,
  parseReturnType: parseCrystalReturnType,
  /** `@[ARTA::Get("/users/{id}")]`, `@[JSON::Field(key: "id")]` on the line above. */
  attributeLine: { pattern: /^\s*@\[([\w:]+(?:\(.*\))?)\]\s*$/ },
  extractLocalTypes: (bodyLines) => extractCrystalLocalTypes(bodyLines),

  importPatterns: [
    {
      // require "kemal" / require "./models/*" / require "../src/app"
      pattern: /^\s*require\s+"([^"]+)"/,
      getSource: (m) => m[1],
      getSpecifiers: () => [],
    },
  ],

  extractClasses: (lines: string[]): ClassInfo[] => {
    const classes = [...extractClassesWithSpec(lines, crystalSpec), ...records(lines)];
    for (const cls of classes) {
      const body = ownBodyLines(lines, cls);
      cls.implements = [...new Set([...cls.implements, ...mixins(body)])];
      // A nested type's methods are its own, not the enclosing module's.
      const nested = classes.filter((c) => c !== cls && c.line > cls.line && c.endLine <= cls.endLine);
      cls.methods = cls.methods.filter((m) => !nested.some((c) => m.line > c.line && m.line <= c.endLine));
      const seen = new Set(cls.properties.map((p) => p.name));
      const add = (p: PropertyInfo) => {
        if (!seen.has(p.name)) { seen.add(p.name); cls.properties.push(p); }
      };
      for (const [i, line] of body) {
        const decorators: string[] = [];
        for (let j = i - 1; j >= 0 && /^\s*@\[/.test(lines[j]!); j--) decorators.unshift(lines[j]!.trim().replace(/^@\[|\]$/g, ""));
        const accessor = ACCESSOR.exec(line);
        if (accessor) { add(prop(accessor[2]!, accessor[3] ?? null, accessor[1] === "getter", decorators)); continue; }
        const ivar = IVAR.exec(line);
        if (ivar) add(prop(ivar[1]!, ivar[2]!, false, decorators));
      }
      // `def initialize(@repo : Repo)` assigns — and so declares — `@repo`.
      for (const ctor of cls.methods.filter((m) => m.name === "initialize")) {
        const decl = lines.slice(ctor.line - 1, ctor.endLine).join(" ");
        for (const p of ctor.params) {
          if (new RegExp(String.raw`@${p.name}\b`).test(decl.slice(0, decl.indexOf(")") + 1))) add(prop(p.name, p.type, false));
        }
      }
    }
    return classes;
  },

  extractRoutes: (lines, classes, filePath) => extractCrystalRoutes(lines, classes, filePath ?? ""),
  extractDataSources: extractCrystalDataSources,
};
