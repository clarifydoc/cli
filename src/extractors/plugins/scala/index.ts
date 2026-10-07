import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec, splitTopLevel } from "../shared/regex-base.js";
import { extractPlayRoutes, isPlayRoutesFile } from "./routes.js";
import { extractScalaRequestAccess } from "./request-schema.js";
import {
  codeOf,
  constructorParamLists,
  continuedBelow,
  extractScalaDiBindings,
  extractScalaLocalTypes,
  namedQualifier,
  scalaDiCallPatterns,
  scalaInitializerType,
} from "./di.js";

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

/**
 * The primary constructor's parameter lists (every one but an `implicit` /
 * `using` list, which carries context). For a `case class` the parameters
 * ARE the field list, and the shape Play JSON / circe serialize; a plain
 * class's parameters are members only when marked `val`/`var`. `Option[T]`
 * and a default value both make a field optional; anything else must be
 * supplied.
 *
 * A plain class's other parameters are still what a method body reads —
 * `class OrderService @Inject()(repo: OrderRepo)` is how a Scala dependency
 * is injected — so when there are any, the primary constructor itself is
 * returned too, as a method named after the class carrying every parameter
 * (keyed by its `@Named`). The field list, and the request schemas built from
 * it, stay as the language defines them.
 */
function primaryConstructor(
  lines: string[],
  startIdx: number,
  name: string,
  isCase: boolean,
): { properties: PropertyInfo[]; ctor: FunctionInfo | null } {
  const properties: PropertyInfo[] = [];
  const params: ParamInfo[] = [];
  let hidden = false;
  for (const list of constructorParamLists(lines, startIdx, name)) {
    for (const piece of splitTopLevel(list)) {
      let param = piece.trim();
      if (!param) continue;
      const decorators: string[] = [];
      let ann: RegExpMatchArray | null;
      while ((ann = param.match(/^@([\w.]+(?:\([^)]*\))?)\s*/))) {
        decorators.push(ann[1]!.replace(/\s+/g, " "));
        param = param.slice(ann[0].length);
      }
      const mods = param.match(/^((?:(?:private|protected)(?:\s*\[[^\]]*\])?\s+|(?:override|implicit|final|lazy)\s+)*)(?:(val|var)\s+)?/);
      const modifiers = mods?.[1] ?? "";
      const binding = mods?.[2];
      param = param.slice(mods?.[0].length ?? 0);
      const m = param.match(/^([a-zA-Z_]\w*)\s*:\s*([^=]+?)\s*(?:=\s*(.+))?$/);
      if (!m) continue;
      const type = m[2]!.trim();
      const qualifier = namedQualifier(decorators);
      const p: ParamInfo = { name: m[1]!, type, defaultValue: m[3]?.trim() ?? null };
      if (qualifier) p.qualifier = qualifier;
      params.push(p);
      if (!isCase && !binding) {
        hidden = true;
        continue;
      }
      const prop: PropertyInfo = {
        name: m[1]!,
        type,
        visibility: /\bprivate\b/.test(modifiers) ? "private" : /\bprotected\b/.test(modifiers) ? "protected" : "public",
        isStatic: false,
        isReadonly: binding !== "var",
      };
      if (decorators.length > 0) prop.decorators = decorators;
      if (qualifier) prop.qualifier = qualifier;
      if (m[3] === undefined && !/^Option\[/.test(type)) prop.isRequired = true;
      properties.push(prop);
    }
  }
  const ctor: FunctionInfo | null = hidden
    ? { name, params, returnType: null, isAsync: false, isExported: true, decorators: [], calls: [], line: startIdx + 1, endLine: startIdx + 1 }
    : null;
  return { properties, ctor };
}

/**
 * Does the declaration at `startIdx` open a `{` body? Read past wrapped
 * parameter lists and heritage clauses; a header ending in `:` (Scala 3) or
 * on a line nothing continues has no braces.
 */
function opensBrace(lines: string[], startIdx: number): boolean {
  let depth = 0;
  for (let i = startIdx; i < Math.min(lines.length, startIdx + 15); i++) {
    const code = codeOf(lines[i]!);
    for (const c of code) {
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if (c === "{" && depth === 0) return true;
    }
    if (depth > 0) continue;
    const trimmed = code.trim();
    if (trimmed.endsWith(":")) return false;
    const next = (lines[i + 1] ?? "").trim();
    if (!/^(?:extends|with|\(|\{|derives)\b|^[({]/.test(next)) return false;
  }
  return false;
}

/** Inline annotations and member modifiers before `val` / `var`. */
const MEMBER_PREFIX = String.raw`^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*)((?:(?:private|protected)(?:\s*\[[^\]]*\])?\s+|(?:override|final|lazy|implicit)\s+)*)`;

/** Members typed by their initializer rather than an annotation (see the second property pattern). */
const INFERRED_MEMBERS = new WeakSet<PropertyInfo>();

function memberOf(m: RegExpMatchArray, type: string | null): PropertyInfo {
  const mods = m[2]!;
  const decorators = [...m[1]!.matchAll(/@([\w.]+(?:\([^)]*\))?)/g)].map((d) => d[1]!.replace(/\s+/g, " "));
  const prop: PropertyInfo = {
    name: m[4]!,
    type,
    visibility: /\bprivate\b/.test(mods) ? "private" : /\bprotected\b/.test(mods) ? "protected" : "public",
    isStatic: false,
    isReadonly: m[3] === "val",
  };
  if (decorators.length > 0) prop.decorators = decorators;
  return prop;
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
      // A trait is what a dependency is declared as and a class mixes in —
      // the linker's interface (nominal: a class names it to implement it).
      pattern: /(?:^|\s)(?:sealed\s+)?trait\s+([A-Z]\w*)/,
      getExtends: (line) => parseHeritage(line).base,
      kind: "interface",
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
      // Inline annotations stay with the member: `@Inject var repo: Repo = _`,
      // `@Inject @Named("x") var gw: PayGw = _`.
      pattern: new RegExp(MEMBER_PREFIX + String.raw`(val|var)\s+([a-zA-Z_]\w*)\s*:\s*([^=]+?)\s*(?:=|$)`),
      build: (m) => memberOf(m, m[5]!.trim()),
    },
    {
      // Unannotated, but typed by what the initializer constructs or looks up:
      // `private val repo = new PgRepo(db)`, `lazy val repo = wire[PgRepo]`,
      // `val repo = injector.instanceOf[Repo]`.
      pattern: new RegExp(MEMBER_PREFIX + String.raw`(val|var)\s+([a-zA-Z_]\w*)\s*=\s*(.+?)\s*$`),
      build: (m) => {
        const init = scalaInitializerType(m[5]!);
        if (!init) return null;
        const prop = memberOf(m, init.type);
        if (init.qualifier) prop.qualifier = init.qualifier;
        INFERRED_MEMBERS.add(prop);
        return prop;
      },
    },
  ],

  parseParam: parseScalaParam,
  parseReturnType: parseScalaReturnType,

  /** `@JsonProperty("x")` / `@Singleton` on the line above a declaration. */
  attributeLine: { pattern: /^\s*@([\w.]+(?:\([^)]*\))?)\s*$/ },

  extractRequestAccess: extractScalaRequestAccess,

  /**
   * Play's `conf/routes` is the only route declaration Scala code has; a
   * controller method carries no annotation. Any other file yields nothing.
   */
  extractRoutes: (lines, _classes, filePath) => (filePath && isPlayRoutesFile(filePath) ? extractPlayRoutes(lines) : []),

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
      const header = lines[cls.line - 1] ?? "";
      const { base, mixins } = parseHeritage(declarationHeader(lines, cls.line - 1));
      if (base) cls.extends = base;
      for (const mixin of mixins) {
        if (!cls.implements.includes(mixin)) cls.implements.push(mixin);
      }
      // Without braces (Scala 3 indentation syntax) the body slice cannot
      // tell a method's `val x = new Foo` from a field's: only annotated
      // members are kept there, as before.
      if (!opensBrace(lines, cls.line - 1)) cls.properties = cls.properties.filter((p) => !INFERRED_MEMBERS.has(p));
      // …and one whose initializer wraps onto a chain below states no type.
      cls.properties = cls.properties.filter((p) => {
        if (!INFERRED_MEMBERS.has(p)) return true;
        const re = new RegExp(String.raw`\b(?:val|var)\s+${p.name}\s*=`);
        for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
          if (re.test(lines[i]!)) return !continuedBelow(lines, i);
        }
        return true;
      });
      for (const p of cls.properties) {
        const q = p.qualifier ?? namedQualifier(p.decorators);
        if (q) p.qualifier = q;
      }
      if (/\bclass\b/.test(header)) {
        const primary = primaryConstructor(lines, cls.line - 1, cls.name, /\bcase\s+class\b/.test(header));
        if (primary.properties.length > 0) cls.properties = [...primary.properties, ...cls.properties];
        if (primary.ctor) cls.methods.unshift(primary.ctor);
      }
    }
    return classes;
  },

  callPatterns: scalaDiCallPatterns,
  extractLocalTypes: extractScalaLocalTypes,
  extractDiBindings: (lines) => extractScalaDiBindings(lines),

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
