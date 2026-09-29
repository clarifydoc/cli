import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";
import { extractVaporRoutes } from "./routes.js";
import { extractSwiftDataSources } from "./data-sources.js";
import { extractSwiftRequestAccess } from "./request-schema.js";

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
    { pattern: /(?:^|\s)protocol\s+([A-Z]\w*)/, getExtends: () => null },
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
      pattern: /^\s*((?:@\w+(?:\([^)]*\))?\s+)*)(?:(private|public|internal|fileprivate|open)(?:\(set\))?\s+)?(?:(static|class)\s+)?(let|var)\s+([a-zA-Z_]\w*)\s*:\s*([^={]+?)\s*(=|\{|$)/,
      build: (m) => {
        const type = m[6]!.trim();
        const decorators = [...m[1]!.matchAll(/@(\w+(?:\([^)]*\))?)/g)].map((d) => d[1]!.replace(/\s+/g, " "));
        const prop: PropertyInfo = {
          name: m[5]!,
          type,
          visibility: m[2] === "private" || m[2] === "fileprivate" ? "private" : m[2] === "internal" ? "protected" : "public",
          isStatic: m[3] === "static" || m[3] === "class",
          isReadonly: m[4] === "let",
        };
        if (decorators.length > 0) prop.decorators = decorators;
        const optional = type.endsWith("?") || type.endsWith("!") || /^Optional</.test(type);
        if (m[7] !== "=" && !optional && !prop.isStatic) prop.isRequired = true;
        return prop;
      },
    },
  ],

  /** `@Field(key: "title")` / `@ID(key: .id)` / `@main` on the line above a declaration. */
  attributeLine: { pattern: /^\s*@(\w+(?:\([^)]*\))?)\s*$/ },

  /**
   * Wrap the generic extractor to record the whole conformance list. Only a
   * class can name a superclass, and only in first position; for every other
   * declaration each entry is a protocol, which maps onto `implements`.
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

  extractRoutes: (lines) => extractVaporRoutes(lines),
  extractDataSources: (lines) => extractSwiftDataSources(lines),
  extractRequestAccess: extractSwiftRequestAccess,
};
