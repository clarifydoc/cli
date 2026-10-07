import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, findEndLine, splitTopLevel, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { extractGroovyRoutes } from "./routes.js";
import { extractGroovyDataSources } from "./data-sources.js";

/**
 * Groovy regex spec (Grails, Spock, Gradle-free Groovy, Jenkins pipelines).
 * The grammar on npm (tree-sitter-groovy 0.1.2) left 56% of Spock's source in
 * ERROR nodes, so Groovy takes the regex path.
 *
 * A Groovy declaration is told from a call by what precedes the name: `def`,
 * a modifier, or a type (`String`, `java.util.List<X>`, a primitive). A call
 * — `transaction(true) { … }`, `println foo(x)` — has none of those.
 */

const MODIFIER = String.raw`(?:public|private|protected|static|final|abstract|synchronized|native|default)`;
/** Leading annotations of a declaration line: `@Transactional`, `@GetMapping("/x")`. */
const ANNOTATIONS = String.raw`(?:@[\w.]+(?:\([^)]*\))?\s+)*`;
/**
 * A declared type: Capitalized (optionally package-qualified, generic, array)
 * or a primitive. A lowercase word is never a type here — `println foo(x)`.
 */
const TYPE = String.raw`(?:(?:[a-z_]\w*\.)*[A-Z]\w*(?:\s*<[^()=]*?>)?|void|boolean|byte|char|short|int|long|float|double)(?:\[\])*`;

const DEF_METHOD = new RegExp(String.raw`^\s*${ANNOTATIONS}(?:${MODIFIER}\s+)*def\s+(?:<[^>]+>\s+)?([A-Za-z_]\w*)\s*\(`);
const TYPED_METHOD = new RegExp(String.raw`^\s*${ANNOTATIONS}(?:${MODIFIER}\s+)*(?:<[^>]+>\s+)?${TYPE}\s+([A-Za-z_]\w*)\s*\(`);
/** Spock feature method: `def "adds two numbers"() {`. */
const SPOCK_FEATURE = new RegExp(String.raw`^\s*${ANNOTATIONS}(?:${MODIFIER}\s+)*def\s+["']([^"']+)["']\s*\(`);
/** A closure-valued field: Grails 1.x/2.x controller actions (`def list = { … }`). */
const CLOSURE_MEMBER = new RegExp(String.raw`^\s*${ANNOTATIONS}(?:${MODIFIER}\s+)*def\s+([a-z_]\w*)\s*=\s*\{`);

/** Return type written before the name (`def` declares none). */
function parseGroovyReturnType(line: string): string | null {
  const m = line.match(new RegExp(String.raw`^\s*${ANNOTATIONS}(?:${MODIFIER}\s+)*(?:<[^>]+>\s+)?(${TYPE})\s+[A-Za-z_]\w*\s*\(`));
  return m ? m[1]!.replace(/\s+/g, "") : null;
}

/** `@PathVariable Long id`, `String name = "x"`, `def x`, `final Map params`, `String... args`, `x`. */
function parseGroovyParam(raw: string): ParamInfo | null {
  let text = raw.trim().replace(/^(?:@[\w.]+(?:\([^)]*\))?\s+)*/, "");
  if (!text) return null;
  let defaultValue: string | null = null;
  const eq = text.search(/=(?!=)/);
  if (eq >= 0) {
    defaultValue = text.slice(eq + 1).trim() || null;
    text = text.slice(0, eq).trim();
  }
  const m = text.match(/^(?:final\s+)?(?:(.+?)\s+)?(?:\.\.\.\s*)?([A-Za-z_]\w*)$/);
  if (!m) return null;
  const type = m[1] && m[1] !== "def" ? m[1].replace(/\.\.\.$/, "[]").replace(/\s+/g, "") : null;
  return { name: m[2]!, type, defaultValue };
}

/** Field declarations at class-body depth: `String title`, `static hasMany = [...]`, `def bookService`. */
const FIELD = new RegExp(
  String.raw`^\s*((?:@[\w.]+(?:\([^)]*\))?\s+)*)((?:(?:public|private|protected|static|final|transient|volatile)\s+)*)(def|${TYPE})\s+([a-zA-Z_]\w*)\s*(?:=\s*(.*?))?\s*;?\s*$`,
);

function buildField(m: RegExpMatchArray): PropertyInfo | null {
  const mods = m[2]!;
  const rawType = m[3]!;
  const name = m[4]!;
  // `def x = { … }` is a closure member — a function, not state.
  if (/^\{/.test(m[5] ?? "")) return null;
  const prop: PropertyInfo = {
    name,
    type: rawType === "def" ? null : rawType.replace(/\s+/g, ""),
    visibility: /\bprivate\b/.test(mods) ? "private" : /\bprotected\b/.test(mods) ? "protected" : "public",
    isStatic: /\bstatic\b/.test(mods),
    isReadonly: /\bfinal\b/.test(mods),
  };
  const decorators = [...m[1]!.matchAll(/@([\w.]+(?:\([^)]*\))?)/g)].map((d) => d[1]!.replace(/\s+/g, " "));
  if (decorators.length > 0) prop.decorators = decorators;
  return prop;
}

/** `extends Base` (last segment) / `implements A, B<T>` from a declaration header. */
function heritage(header: string): { base: string | null; interfaces: string[] } {
  const base = header.match(/\bextends\s+([\w.]+)/)?.[1]?.split(".").pop() ?? null;
  const impl = header.match(/\bimplements\s+(.+?)\s*(?:\{|$)/)?.[1];
  const interfaces = impl ? splitTopLevel(impl).map((s) => s.trim().replace(/<.*$/, "").split(".").pop()!).filter(Boolean) : [];
  return { base, interfaces };
}

/**
 * Words that open a statement which is not a command call — see
 * GROOVY_COMMAND_CALL.
 */
const STATEMENT_KEYWORDS = [
  "def", "var", "return", "throw", "new", "assert", "import", "package", "if", "else", "for", "while", "do",
  "switch", "case", "default", "break", "continue", "try", "catch", "finally", "in", "instanceof", "as",
  "class", "interface", "trait", "enum", "record", "extends", "implements", "static", "final", "public",
  "private", "protected", "abstract", "synchronized", "transient", "volatile", "native", "goto", "const",
  "this", "super", "null", "true", "false", "void", "boolean", "byte", "char", "short", "int", "long", "float",
  "double", "it", "yield",
];

/**
 * A command expression — a call written without parentheses, which is how
 * Grails and Jenkins code is written: `render view: "list"`, `redirect
 * action: "show"`, `respond book`, `log.info "x"`, `sh "make"`, and the
 * closure-taking DSL calls `pipeline { … }` / `list.each { … }`. The name is
 * lowercase (a Capitalized one declares a typed variable: `String name`),
 * no keyword, and an argument follows — a bare name on its own line is a
 * value (a closure's implicit return), not a call. It may be the value a
 * local is declared with (`def data = load 'x.json'`), and a statement also
 * starts after `{`, `;` and a closure's `->` (`{ b -> importBook b }`).
 */
const GROOVY_COMMAND_CALL: CallPattern = {
  pattern: new RegExp(
    String.raw`(?:^|[{;]|->)\s*(?:(?:def|final|var|${TYPE})\s+[a-zA-Z_]\w*\s*=\s*)?` +
      String.raw`(?!(?:${STATEMENT_KEYWORDS.join("|")})\b(?!\.))([a-z_]\w*(?:\.[a-zA-Z_]\w*)*)` +
      String.raw`[ \t]+(?!(?:in|as|instanceof)\b)(?=[\w"'\[$\{])`,
  ),
  notAfter: /(?:[,(\[+\-*/=?]|&&|\|\|)\s*$/,
  buildName: (m) => {
    const name = m[1]!;
    return { name, leafName: name.slice(name.lastIndexOf(".") + 1) };
  },
};

/** GORM lookups that return ONE instance of the class they are called on. */
const SINGLE_INSTANCE_LOOKUP = /^(?:get|read|load|lock|first|last|findBy\w+|findOrCreateBy\w+|findOrSaveBy\w+|findWhere)$/;

/**
 * Locals whose class the body states: `def book = new Book(params)`,
 * `Book book = …`, `def book = Book.get(id)` / `Book.findByTitle(t)`. What
 * lets the linker type `book.save()` — a GORM method no class declares — and
 * veto a same-named method elsewhere.
 */
function extractGroovyLocalTypes(bodyLines: string[]): NonNullable<FunctionInfo["localTypes"]> {
  const out: NonNullable<FunctionInfo["localTypes"]> = [];
  const seen = new Set<string>();
  const add = (name: string, type: string) => {
    if (!seen.has(name)) { seen.add(name); out.push({ name, type }); }
  };
  for (const line of bodyLines) {
    const inferred = line.match(/^\s*(?:def|final|var)\s+([a-z_]\w*)\s*=\s*(?:new\s+([A-Z]\w*)\s*[(<]|([A-Z]\w*)\.(\w+)\s*\()/);
    if (inferred) {
      const type = inferred[2] ?? (SINGLE_INSTANCE_LOOKUP.test(inferred[4] ?? "") ? inferred[3] : undefined);
      if (type) add(inferred[1]!, type);
      continue;
    }
    const declared = line.match(new RegExp(String.raw`^\s*(?:final\s+)?(${TYPE})\s+([a-z_]\w*)\s*=`));
    if (declared) add(declared[2]!, declared[1]!.replace(/\s+/g, "").replace(/<.*$/, ""));
  }
  return out;
}

/** 1-based [start, end] of every method / closure-member declaration in the file. */
const SPANS = new WeakMap<string[], Array<[number, number]>>();
function memberSpans(lines: string[]): Array<[number, number]> {
  let spans = SPANS.get(lines);
  if (!spans) {
    spans = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*\/\//.test(line)) continue;
      if (SPOCK_FEATURE.test(line) || DEF_METHOD.test(line) || TYPED_METHOD.test(line) || CLOSURE_MEMBER.test(line)) {
        spans.push([i + 1, findEndLine(lines, i, "brace")]);
      }
    }
    SPANS.set(lines, spans);
  }
  return spans;
}

/**
 * Closure members declared INSIDE another member (a local `def fmt = { … }`
 * in a method) are locals, not functions of the file. The generic extractors
 * match them at any depth; keep only those no other declaration encloses.
 */
function dropNestedClosures(lines: string[], fns: FunctionInfo[]): FunctionInfo[] {
  const spans = memberSpans(lines);
  return fns.filter((fn) => {
    if (!CLOSURE_MEMBER.test(lines[fn.line - 1] ?? "")) return true;
    return !spans.some(([start, end]) => start < fn.line && end >= fn.endLine);
  });
}

export const groovySpec: RegexLangSpec = {
  language: "groovy",
  extensions: [".groovy", ".gvy", ".gy", ".gsh"],
  indentBased: false,
  lineCommentPrefixes: ["//"],
  // A script (no class) runs its statements; a Jenkinsfile is one.
  topLevelCalls: true,

  functionPatterns: [
    { pattern: SPOCK_FEATURE, isExported: () => true },
    { pattern: DEF_METHOD, isExported: (line) => !/\bprivate\b/.test(line) },
    { pattern: TYPED_METHOD, isExported: (line) => !/\bprivate\b/.test(line) },
    { pattern: CLOSURE_MEMBER, isExported: (line) => !/\bprivate\b/.test(line) },
  ],

  classPatterns: [
    {
      pattern: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|abstract|final|static|sealed|non-sealed)\s+)*(?:class|enum|record)\s+([A-Z]\w*)/,
      getExtends: (line) => heritage(line).base,
      getImplements: (line) => heritage(line).interfaces,
    },
    {
      // A trait carries behaviour, but it is what a class implements: the
      // linker's interface.
      pattern: /^\s*(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|private|protected|abstract|static)\s+)*(?:interface|trait|@interface)\s+([A-Z]\w*)/,
      kind: "interface",
      getExtends: (line) => heritage(line).base,
      getImplements: (line) => heritage(line).interfaces,
    },
  ],

  propertyPatterns: [{ pattern: FIELD, build: buildField }],
  parseParam: parseGroovyParam,
  parseReturnType: parseGroovyReturnType,
  /** `@Transactional` / `@GetMapping("/x")` on the line above a declaration. */
  attributeLine: { pattern: /^\s*@([\w.]+(?:\([^)]*\))?)\s*$/ },
  callPatterns: [GROOVY_COMMAND_CALL],
  extractLocalTypes: (bodyLines) => extractGroovyLocalTypes(bodyLines),

  importPatterns: [
    {
      // import a.b.C / import a.b.C as D / import static a.b.C.m / import a.b.*
      pattern: /^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?(?:\s+as\s+(\w+))?\s*;?\s*$/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        if (m[2]) return [m[2]];
        if (/\.\*\s*;?\s*$/.test(m[0])) return [];
        return [m[1].split(".").pop()!];
      },
    },
  ],

  extractClasses: (lines: string[], _fns: FunctionInfo[]): ClassInfo[] => {
    const classes = extractClassesWithSpec(lines, groovySpec);
    for (const cls of classes) {
      // `class Book implements Serializable,` / `  Comparable<Book> {` — read the whole header.
      let header = lines[cls.line - 1] ?? "";
      for (let i = cls.line; i < Math.min(cls.endLine, lines.length) && !header.includes("{"); i++) header += " " + lines[i];
      const { base, interfaces } = heritage(header);
      cls.extends = base;
      cls.implements = interfaces;
      cls.methods = dropNestedClosures(lines, cls.methods);
    }
    return classes;
  },
  postProcessFunctions: (lines, fns) => dropNestedClosures(lines, fns),

  extractRoutes: (lines, classes, filePath) => extractGroovyRoutes(lines, classes, filePath ?? ""),
  extractDataSources: extractGroovyDataSources,
};
