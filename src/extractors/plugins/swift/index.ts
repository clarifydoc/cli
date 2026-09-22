import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";
import { extractVaporRoutes } from "./routes.js";
import { extractSwiftDataSources } from "./data-sources.js";

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

export const swiftSpec: RegexLangSpec = {
  language: "swift",
  extensions: [".swift"],
  indentBased: false,
  lineCommentPrefixes: ["//"],

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
   */
  propertyPatterns: [
    {
      pattern: /^\s*(?:(private|public|internal|fileprivate)\s+)?(?:(static)\s+)?(let|var)\s+([a-zA-Z_]\w*)\s*:\s*([^={]+?)\s*(?:=|\{|$)/,
      build: (m) => ({
        name: m[4]!,
        type: m[5]!.trim(),
        visibility: m[1] === "private" || m[1] === "fileprivate" ? "private" : m[1] === "internal" ? "protected" : "public",
        isStatic: m[2] === "static",
        isReadonly: m[3] === "let",
      }),
    },
  ],

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
};
