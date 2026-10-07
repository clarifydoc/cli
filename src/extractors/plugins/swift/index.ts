import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";
import { extractVaporRoutes } from "./routes.js";
import { extractSwiftDataSources } from "./data-sources.js";
import { extractSwiftRequestAccess } from "./request-schema.js";
import {
  continuedBelow,
  applyInjectionKeys,
  extractSwiftDiBindings,
  extractSwiftLocalTypes,
  initializerQualifier,
  initializerType,
  swiftDiCallPatterns,
} from "./di.js";

/**
 * The conformance list of a declaration: `class Foo: Bar, Codable, Sendable`.
 * Swift gives a superclass and a protocol the same syntax, so only position
 * distinguishes them — and only for a `class`, where a superclass must come
 * first. Everything else conforms to protocols only.
 */
function parseConformance(header: string): string[] {
  // Stop at the generic `where` clause and at the body, so constraints and
  // statements can't be read as conformances.
  const decl = header.split(/\bwhere\b|\{/)[0] ?? "";
  const colon = decl.indexOf(":");
  if (colon === -1) return [];
  return decl
    .slice(colon + 1)
    .split(",")
    .map((t) => t.trim().replace(/<.*/, ""))
    .filter((t) => /^[A-Z]\w*$/.test(t));
}

/** Inline property wrappers / attributes: `@Injected(\.repo) `, `@Published `. */
const WRAPPERS = String.raw`((?:@\w+(?:\([^)]*\))?\s+)*)`;

/** Member modifiers in any order: access (with `(set)`), `static`, `lazy`, `weak`, … */
const MODIFIERS = String.raw`((?:(?:private|public|internal|fileprivate|open|package)(?:\(set\))?\s+|(?:static|class|lazy|weak|unowned(?:\((?:safe|unsafe)\))?|final|override|nonisolated|dynamic)\s+)*)`;

/** Members typed by their initializer (see the second property pattern). */
const INFERRED_MEMBERS = new WeakSet<PropertyInfo>();

/**
 * Drop an initializer-typed member whose initializer wraps onto a chain
 * below (`let client = Builder()` / `.build()`): its first line does not
 * state the value's type.
 */
function dropWrappedInitializers(lines: string[], cls: ClassInfo): void {
  cls.properties = cls.properties.filter((p) => {
    if (!INFERRED_MEMBERS.has(p)) return true;
    const re = new RegExp(String.raw`\b(?:let|var)\s+${p.name}\s*=`);
    for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
      if (re.test(lines[i]!)) return !continuedBelow(lines, i);
    }
    return true;
  });
}

/** Standard-library and Foundation value types — never a dependency, often a `Codable` field. */
const SWIFT_VALUE_TYPES: ReadonlySet<string> = new Set([
  "String", "Character", "Substring", "Int", "Int8", "Int16", "Int32", "Int64", "UInt", "UInt8", "UInt16", "UInt32",
  "UInt64", "Double", "Float", "Decimal", "Bool", "Date", "UUID", "URL", "Data", "Array", "Set", "Dictionary",
]);

/** The common part of a member match: name, wrappers, modifiers (`m[1]`, `m[2]`, `m[3]`, `m[4]`). */
function memberOf(m: RegExpMatchArray): PropertyInfo {
  const mods = m[2]!;
  const access = mods.match(/\b(private|public|internal|fileprivate|open|package)\b/)?.[1];
  const decorators = [...m[1]!.matchAll(/@(\w+(?:\([^)]*\))?)/g)].map((d) => d[1]!.replace(/\s+/g, " "));
  const prop: PropertyInfo = {
    name: m[4]!,
    type: null,
    visibility: access === "private" || access === "fileprivate" ? "private" : access === "internal" ? "protected" : "public",
    isStatic: /\b(?:static|class)\b/.test(mods),
    isReadonly: m[3] === "let",
  };
  if (decorators.length > 0) prop.decorators = decorators;
  return prop;
}

/** Declarations whose conformance list can only be protocols, never a base class. */
const PROTOCOL_ONLY_RE = /\b(?:struct|enum|protocol|extension)\b/;

/**
 * `req: Request`, `_ id: UUID`, `for name: String = "x"`, `inout buf: [UInt8]`
 * — the parameter's internal name and its type. Without this the default
 * parser drops the type, and a handler's `Request` cannot be told from a
 * value the route binds.
 */
function parseSwiftParam(paramText: string): ParamInfo | null {
  const text = paramText.trim();
  if (!text) return null;
  const m = text.match(/^(?:(?:[a-zA-Z_]\w*|_)\s+)?([a-zA-Z_]\w*)\s*:\s*(?:(?:inout|borrowing|consuming)\s+)?([^=]+?)\s*(?:=\s*(.+))?$/);
  if (!m) return /^[a-zA-Z_]\w*$/.test(text) ? { name: text, type: null, defaultValue: null } : null;
  return { name: m[1]!, type: m[2]!.trim(), defaultValue: m[3]?.trim() ?? null };
}

export const swiftSpec: RegexLangSpec = {
  language: "swift",
  extensions: [".swift"],
  indentBased: false,
  lineCommentPrefixes: ["//"],
  parseParam: parseSwiftParam,

  functionPatterns: [
    {
      pattern: /(?:public|private|internal|fileprivate|open)?\s*(?:static\s+)?(?:class\s+)?func\s+([a-zA-Z_]\w*)\s*[<(]/,
      isExported: (line) => !line.trimStart().startsWith("private") && !line.trimStart().startsWith("fileprivate"),
      isAsync: (line) => line.includes("async "),
    },
    {
      // Initialisers. `init` is the member every caller of a type reaches
      // first, so leaving it out hides the type's own construction from the
      // call graph.
      pattern: /^\s*(?:(?:public|private|internal|fileprivate|open|required|convenience)\s+)*(init)\s*[?!]?\s*\(/,
      isExported: (line) => !line.trimStart().startsWith("private") && !line.trimStart().startsWith("fileprivate"),
      isAsync: (line) => line.includes("async "),
    },
  ],

  classPatterns: [
    {
      pattern: /(?:^|\s)(?:public\s+)?(?:final\s+)?class\s+([A-Z]\w*)/,
      getExtends: (line) => parseConformance(line)[0] ?? null,
    },
    // An actor is a reference type like a class; the schema has no separate
    // kind for it, and treating it as one keeps it in the class graph.
    { pattern: /(?:^|\s)(?:public\s+)?actor\s+([A-Z]\w*)/, getExtends: () => null },
    // A protocol is what a dependency is declared as and an implementation
    // conforms to — the linker's interface.
    { pattern: /(?:^|\s)protocol\s+([A-Z]\w*)/, getExtends: () => null, kind: "interface" },
    { pattern: /(?:^|\s)struct\s+([A-Z]\w*)/, getExtends: () => null },
    { pattern: /(?:^|\s)enum\s+([A-Z]\w*)/, getExtends: () => null },
    // `extension Foo: Codable` adds members and conformances to a type
    // declared elsewhere — in Swift that is where much of a type's behaviour
    // lives, so the members belong on the graph.
    { pattern: /^\s*(?:public\s+)?extension\s+([A-Z]\w*)/, getExtends: () => null },
  ],

  /**
   * Stored and computed properties. A type annotation is required for the same
   * reason as in Scala: the class-body slice includes method bodies, where an
   * unannotated `let x = f()` is a local, not a field.
   *
   * Property wrappers may sit inline (`@Field(key: "title") var title: String`)
   * or on their own line above (see `attributeLine`); both become decorators
   * with the leading `@` dropped. A non-optional type with no default value is
   * one every initialiser — and every decoded request — must supply.
   */
  propertyPatterns: [
    {
      pattern: new RegExp(String.raw`^\s*${WRAPPERS}${MODIFIERS}(let|var)\s+([a-zA-Z_]\w*)\s*:\s*([^={]+?)\s*(=|\{|$)`),
      build: (m, line) => {
        const type = m[5]!.trim();
        const prop = memberOf(m);
        prop.type = type;
        const optional = type.endsWith("?") || type.endsWith("!") || /^Optional</.test(type);
        if (m[6] !== "=" && !optional && !prop.isStatic) prop.isRequired = true;
        if (m[6] === "=") {
          const q = initializerQualifier(line.slice(m[0].length));
          if (q) prop.qualifier = q;
        }
        return prop;
      },
    },
    {
      // Unannotated members whose type the source still states: a
      // construction or container lookup (`private let repo = PgRepo()`,
      // `lazy var repo = container.resolve(UserRepo.self)!`), or a bare
      // `@Injected(\.userRepo) var repo` whose wrapper names the key. Only
      // declarations at the body's own depth are read, so a method local
      // never becomes a field; value types (`let id = UUID()`) are left out
      // so a `Codable` body's shape is unchanged.
      pattern: new RegExp(String.raw`^\s*${WRAPPERS}${MODIFIERS}(let|var)\s+([a-zA-Z_]\w*)\s*(?:=\s*(.+?))?\s*$`),
      build: (m) => {
        const prop = memberOf(m);
        if (m[5] === undefined) return prop; // wrapper-typed; kept only when it names a key
        const init = initializerType(m[5]);
        if (!init || SWIFT_VALUE_TYPES.has(init.type.replace(/<.*$/, ""))) return null;
        prop.type = init.type || null;
        if (init.qualifier) prop.qualifier = init.qualifier;
        INFERRED_MEMBERS.add(prop);
        return prop;
      },
    },
  ],

  /** `@Field(key: "title")` / `@ID(key: .id)` / `@main` on the line above a declaration. */
  attributeLine: { pattern: /^\s*@(\w+(?:\([^)]*\))?)\s*$/ },

  /**
   * Wrap the generic extractor to record the whole conformance list. Only a
   * class can name a superclass, and only in first position; for every other
   * declaration each entry is a protocol, which maps onto `implements`. (A
   * class's first entry may be a protocol too — the linker treats `extends`
   * as a possible interface.)
   *
   * A protocol's requirements have no body: `func save(_ u: User) throws` ends
   * on its own line. The generic end-of-block scan reads a trailing `throws`
   * or `?` as a continuation and would hand each requirement the following
   * ones as calls.
   */
  extractClasses: (lines: string[], _fns: FunctionInfo[]): ClassInfo[] => {
    const classes = extractClassesWithSpec(lines, swiftSpec);
    for (const cls of classes) {
      const header = lines[cls.line - 1] ?? "";
      const conformances = parseConformance(header);
      const protocolsOnly = PROTOCOL_ONLY_RE.test(header);
      const protocols = protocolsOnly ? conformances : conformances.slice(1);
      if (protocolsOnly) cls.extends = null;
      for (const name of protocols) {
        if (!cls.implements.includes(name)) cls.implements.push(name);
      }
      if (cls.kind === "interface") {
        for (const m of cls.methods) {
          if ((lines[m.line - 1] ?? "").includes("{")) continue;
          m.endLine = m.line;
          m.calls = [];
          delete m.localTypes;
          delete m.requestAccess;
        }
      }
      cls.properties = applyInjectionKeys(cls.properties);
      dropWrappedInitializers(lines, cls);
    }
    return classes;
  },

  importPatterns: [
    {
      pattern: /^\s*import\s+(\w+)/,
      getSource: (m) => m[1],
      getSpecifiers: () => [],
    },
  ],

  callPatterns: swiftDiCallPatterns,
  extractLocalTypes: extractSwiftLocalTypes,
  extractDiBindings: (lines) => extractSwiftDiBindings(lines),

  extractRoutes: (lines) => extractVaporRoutes(lines),
  extractDataSources: (lines) => extractSwiftDataSources(lines),
  extractRequestAccess: extractSwiftRequestAccess,
};
