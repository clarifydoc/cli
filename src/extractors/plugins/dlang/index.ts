import type { ClassInfo, FunctionInfo, ImportInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractClassesWithSpec, findEndLine, splitTopLevel, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { extractDRoutes } from "./routes.js";
import { extractDDataSources } from "./data-sources.js";

/**
 * D regex spec (no grammar on npm that loads in web-tree-sitter 0.27). Braces
 * delimit blocks, C-style. A function is declared by a return type (or a
 * storage class such as `auto`) before its name — `Json getInfo(string name)
 * @safe {`, `auto map(alias fun)(R r)` — with attributes and storage classes
 * in front (`@property`, `override`, `static`, `extern(C)`); a call has none.
 * `class` / `struct` / `interface` / `union` / `enum` / `template` are the
 * class concept. Attributes keep their arguments as decorators (`path("/x")`,
 * `method(HTTPMethod.GET)`): vibe.d routes are declared with them.
 */

/** Words that are never a type, a function name or a callee. */
const KEYWORDS = [
  "abstract", "alias", "align", "asm", "assert", "auto", "body", "break", "case", "cast", "catch", "class", "const",
  "continue", "debug", "default", "delegate", "delete", "deprecated", "do", "else", "enum", "export", "extern",
  "false", "final", "finally", "for", "foreach", "foreach_reverse", "function", "goto", "if", "immutable", "import",
  "in", "inout", "interface", "invariant", "is", "lazy", "macro", "mixin", "module", "new", "nothrow", "null", "out",
  "override", "package", "pragma", "private", "protected", "public", "pure", "ref", "return", "scope", "shared",
  "static", "struct", "super", "switch", "synchronized", "template", "this", "throw", "true", "try", "typeid",
  "typeof", "union", "unittest", "version", "while", "with", "__gshared", "__traits", "__vector", "__parameters",
];
const NOT_KEYWORD = `(?!(?:${KEYWORDS.join("|")})\\b)`;

/** A user-defined attribute, arguments kept: `@safe`, `@path("/x")`, `@errorDisplay!getX`. */
const UDA = String.raw`@[A-Za-z_][\w.]*(?:\s*!\s*(?:\([^()]*\)|[\w.]+))?(?:\s*\((?:[^()]|\([^()]*\))*\))?`;
/** Storage classes and protection that may precede a declaration. */
const STORAGE = String.raw`(?:${UDA}|public|private|protected|package(?:\([\w.]*\))?|export|static|final|override|abstract|synchronized|extern\s*\([^)]*\)|deprecated(?:\s*\([^)]*\))?|nothrow|pure|ref|auto|const|immutable|shared|inout|scope|__gshared)`;
/** A type: qualified name, template instance (`Nullable!int`, `Foo!(A, B)`), arrays, pointers, `const(T)`. */
const TYPE = String.raw`(?:(?:const|immutable|shared|inout)\s*\([^()]*\)|typeof\s*\([^()]*\)|${NOT_KEYWORD}[A-Za-z_][\w.]*(?:\s*!\s*(?:\([^()]*\)|[\w.]+))?)(?:\s*\[[^\]]*\]|\s*\*)*`;

/** `[storage…] Type name[(template params)](` or `storage… name(` — group 1 the name. */
const FUNCTION = new RegExp(
  String.raw`^\s*(?:(?:${STORAGE}\s+)*${TYPE}\s+|(?:${STORAGE}\s+)+)${NOT_KEYWORD}([A-Za-z_]\w*)\s*(?:\([^()]*\)\s*)?\(`,
);
/** A constructor: `this(…)` opening a body (a `this(…);` call or `@disable this();` declares nothing). */
const CONSTRUCTOR = new RegExp(String.raw`^\s*(?:(?:${STORAGE})\s+)*(this)\s*\((?![^;]*;\s*(?://.*)?$)`);

const CLASS = new RegExp(
  String.raw`^\s*(?:(?:${STORAGE})\s+)*(?:class|struct|union|template|mixin\s+template)\s+([A-Za-z_]\w*)`,
);
const INTERFACE = new RegExp(String.raw`^\s*(?:(?:${STORAGE})\s+)*interface\s+([A-Za-z_]\w*)`);
/** `enum Color : ubyte {` — a named enum with a body (`enum x = 5;` is a constant). */
const ENUM = new RegExp(String.raw`^\s*(?:(?:${STORAGE})\s+)*enum\s+([A-Za-z_]\w*)\s*(?::\s*[\w.!]+\s*)?(?:\{|$)`);

/** `class A : B, IC` — the first base is the class it extends unless it names an interface (`I` + capital). */
function heritage(line: string): { base: string | null; interfaces: string[] } {
  const m = /\b(?:class|interface|struct)\s+\w+\s*(?:\([^()]*\)\s*)?:\s*([^{]+)/.exec(line);
  if (!m) return { base: null, interfaces: [] };
  const bases = splitTopLevel(m[1]!.replace(/\bif\s*\(.*$/, "")).map((s) => s.trim().replace(/!.*$/, "").split(".").pop()!).filter(Boolean);
  if (/\binterface\b/.test(line)) return { base: bases[0] ?? null, interfaces: bases.slice(1) };
  if (bases.length > 0 && /^I[A-Z]/.test(bases[0]!)) return { base: null, interfaces: bases };
  return { base: bases[0] ?? null, interfaces: bases.slice(1) };
}

/**
 * A parenthesized call — `getInfo(name)`, `m_registry.search(q)`, a template
 * instance `to!string(x)` / `map!(a => a.id)(xs)` (recorded as `to` / `map`)
 * — never a keyword (`if (`, `cast(`, `typeof(`), never an attribute
 * (`@path(`). Replaces the generic `name(` matcher, which read `to!string(x)`
 * as a call of `string`.
 */
const PAREN_CALL: CallPattern = {
  pattern: new RegExp(
    // `to!string(x)` is a call of `to`, never of `string`; `!isValid(x)` still calls `isValid`.
    String.raw`(?<![\w@$])(?<![\w)\]]!)(?<![)\]]\.)` + NOT_KEYWORD +
      String.raw`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(?:!\s*(?:\([^()]*\)|"[^"]*"|[A-Za-z_][\w.]*))?\s*\(`,
  ),
  buildName: (m) => ({ name: m[1]!, leafName: m[1]!.slice(m[1]!.lastIndexOf(".") + 1) }),
  replacesBaseline: true,
};

/** `string name = "x"`, `ref User u`, `scope HTTPServerRequest req`, `string[] tags...` → param. */
function parseDParam(raw: string): ParamInfo | null {
  let text = raw.trim();
  if (!text || text === "...") return null;
  let defaultValue: string | null = null;
  const eq = text.search(/=(?!=)/);
  if (eq >= 0) {
    defaultValue = text.slice(eq + 1).trim() || null;
    text = text.slice(0, eq).trim();
  }
  text = text.replace(/^(?:(?:@\w+(?:\([^)]*\))?|in|out|ref|lazy|scope|return|const|immutable|shared|inout|auto|final)\s+)+/, "");
  const m = /^(.*?)\s*\b([A-Za-z_]\w*)\s*(?:\.\.\.)?$/.exec(text);
  if (!m) return null;
  return { name: m[2]!, type: m[1]!.trim() || null, defaultValue };
}

/** Runtime parameters: the SECOND paren group of a template function (`map(alias f)(R r)`), else the first. */
function dParams(lines: string[], i: number, name: string): ParamInfo[] {
  const text = lines.slice(i, i + 12).join("\n");
  const at = text.search(new RegExp(String.raw`\b${name}\s*\(`));
  if (at < 0) return [];
  const groups: string[] = [];
  let k = text.indexOf("(", at);
  while (k >= 0 && groups.length < 2) {
    let depth = 0;
    let j = k;
    for (; j < text.length; j++) {
      if (text[j] === "(") depth++;
      else if (text[j] === ")" && --depth === 0) break;
    }
    groups.push(text.slice(k + 1, j));
    const rest = text.slice(j + 1);
    const again = /^\s*\(/.exec(rest);
    k = again ? j + 1 + again[0].length - 1 : -1;
  }
  const runtime = groups.length === 2 ? groups[1]! : groups[0] ?? "";
  return splitTopLevel(runtime).map(parseDParam).filter((p): p is ParamInfo => p !== null);
}

/** The declared return type: whatever precedes the name after attributes and storage classes. */
function parseDReturnType(line: string): string | null {
  const m = FUNCTION.exec(line);
  if (!m) return null;
  let head = line.slice(0, line.indexOf(m[1]!, m.index)).trim();
  head = head.replace(new RegExp(String.raw`^(?:${STORAGE}\s+)*`), "").trim();
  return head && head !== "auto" ? head.replace(/\s+/g, " ") : null;
}

const LEADING_STORAGE = new RegExp(String.raw`^\s*(?:${STORAGE}\s+)*`);

/** Attributes written as `@name(args)` / `@name!x` / `@name`, `@` dropped, arguments kept. */
export function dAttributes(text: string): string[] {
  return [...text.matchAll(new RegExp(UDA, "g"))].map((m) => m[0].slice(1).replace(/\s+/g, " "));
}

/** 1-based [start, end] of every function declared in the file (any depth). */
const SPANS = new WeakMap<string[], Array<[number, number]>>();
function functionSpans(lines: string[]): Array<[number, number]> {
  let spans = SPANS.get(lines);
  if (!spans) {
    spans = [];
    for (let i = 0; i < lines.length; i++) {
      if (FUNCTION.test(lines[i]!) && !/^\s*\/\//.test(lines[i]!)) spans.push([i + 1, findEndLine(lines, i, "brace")]);
    }
    SPANS.set(lines, spans);
  }
  return spans;
}

/** A function declared INSIDE another (a nested helper, a delegate body) belongs to the enclosing one. */
function dropNested<T extends { line: number; endLine: number }>(lines: string[], fns: T[]): T[] {
  const spans = functionSpans(lines);
  return fns.filter((fn) => !spans.some(([start, end]) => start < fn.line && end >= fn.endLine));
}

/**
 * Protection of each declaration line: D members are public unless a
 * `private`/`protected`/`package` attribute says otherwise — on the line, as
 * a `private:` label for what follows in the same scope, or as a `private {`
 * block around it.
 */
export function dProtection(lines: string[]): Map<number, string> {
  const out = new Map<number, string>();
  const scopes: Array<{ label: string; block: string | null }> = [{ label: "public", block: null }];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const scope = scopes[scopes.length - 1]!;
    const own = /^\s*(?:@\S+\s+)*(private|protected|package|public)\b(?!\s*[:{])/.exec(line)?.[1];
    out.set(i + 1, own ?? scope.block ?? scope.label);
    const label = /^\s*(private|protected|package|public)\s*:\s*$/.exec(line);
    if (label) scope.label = label[1]!;
    const block = /^\s*(private|protected|package|public)\s*\{/.exec(line);
    for (const ch of line) {
      if (ch === "{") {
        scopes.push({ label: block ? scope.label : "public", block: block ? block[1]! : scope.block });
      } else if (ch === "}") {
        if (scopes.length > 1) scopes.pop();
      }
    }
  }
  return out;
}

/**
 * Per class: methods found inside a NESTED type or a nested function are not
 * its own; constructors (`this`) take the class's name, as the linker expects
 * of a constructor; and every declaration gets its attributes — the lines of
 * `@attr` above it and those in front of it on its own line.
 */
function refine(lines: string[], fns: FunctionInfo[], classes: ClassInfo[]): void {
  const protection = dProtection(lines);
  const attach = (decl: { line: number; decorators: string[] }): void => {
    const lead = LEADING_STORAGE.exec(lines[decl.line - 1] ?? "")?.[0] ?? "";
    decl.decorators = [...decl.decorators.flatMap((d) => dAttributes(d)), ...dAttributes(lead)];
  };
  for (const fn of fns) {
    attach(fn);
    fn.params = dParams(lines, fn.line - 1, fn.name);
    fn.isExported = protection.get(fn.line) === "public" || protection.get(fn.line) === "package";
  }
  for (const cls of classes) {
    attach(cls);
    const nested = classes.filter((c) => c !== cls && c.line > cls.line && c.endLine <= cls.endLine);
    cls.methods = dropNested(lines, cls.methods).filter((m) => !nested.some((c) => m.line > c.line && m.line <= c.endLine));
    for (const m of cls.methods) {
      attach(m);
      m.params = dParams(lines, m.line - 1, m.name);
      m.isExported = protection.get(m.line) === "public";
      if (m.name === "this") m.name = cls.name;
    }
    if (cls.kind !== "interface" && cls.kind !== "enum") cls.properties = dFields(lines, cls, protection);
    cls.isExported = protection.get(cls.line) !== "private";
  }
}

/** Fields at a class body's own depth: `string name;`, `private Repo m_repo;`, `int a, b = 2;`. */
const FIELD = new RegExp(
  String.raw`^\s*((?:${STORAGE}\s+)*)(${TYPE})\s+([A-Za-z_]\w*(?:\s*=[^,;]+)?(?:\s*,\s*[A-Za-z_]\w*(?:\s*=[^,;]+)?)*)\s*;\s*(?://.*)?$`,
);

/**
 * A type's fields: declarations at its body's own depth — a `private { … }`
 * / `protected:` group counts as that depth, a method body or nested type
 * does not. Every name of `int a, b;` is a field; the group's protection
 * applies unless the line states its own.
 */
function dFields(lines: string[], cls: ClassInfo, protection: Map<number, string>): PropertyInfo[] {
  const props: PropertyInfo[] = [];
  let depth = 0;
  let open = cls.line - 1;
  while (open < cls.endLine - 1 && !lines[open]!.includes("{")) open++;
  /** Per open brace: whether it opened a protection group (`private {`), which keeps the depth. */
  const braces: boolean[] = [];
  for (let i = open + 1; i < Math.min(cls.endLine - 1, lines.length); i++) {
    const line = lines[i]!.replace(/\/\/.*$/, "").replace(/"(?:[^"\\]|\\.)*"/g, '""');
    if (depth === 0) {
      const m = FIELD.exec(line);
      if (m && !/^(?:return|alias|enum|import|goto|throw|delete)$/.test(m[2]!)) {
        const mods = m[1] ?? "";
        for (const part of splitTopLevel(m[3]!)) {
          const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1];
          if (!name) continue;
          const vis = protection.get(i + 1) ?? "public";
          props.push({
            name,
            type: m[2]!.replace(/\s+/g, ""),
            visibility: vis === "private" ? "private" : vis === "protected" ? "protected" : "public",
            isStatic: /\bstatic\b/.test(mods),
            isReadonly: /\b(?:immutable|const)\b/.test(mods),
          });
        }
      }
    }
    let group = depth === 0 && /^\s*(?:private|protected|package|public)\s*\{/.test(line);
    for (const ch of line) {
      if (ch === "{") {
        braces.push(group);
        if (!group) depth++;
        group = false;
      } else if (ch === "}") {
        if (braces.pop() !== true) depth = Math.max(0, depth - 1);
      }
    }
  }
  return props;
}

/**
 * Imports, local ones included: `import std.stdio;`, `import a.b, c.d;`,
 * `import io = std.stdio;`, `import std.algorithm : map, filter;` (the
 * selective list binds the LAST module), `public import`, `static import`,
 * spread over several lines.
 */
export function dImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const head = /(?:^|[{;])\s*(?:(?:public|private|package|static)\s+)*import\s+(?!\()(.*)$/.exec(lines[i]!);
    if (!head) continue;
    let text = head[1]!;
    let j = i;
    while (!text.includes(";") && j + 1 < lines.length && j < i + 20) text += " " + lines[++j];
    text = text.slice(0, text.indexOf(";") >= 0 ? text.indexOf(";") : undefined).replace(/\/\/.*$/gm, "");
    const colon = text.indexOf(":");
    const modules = splitTopLevel(colon >= 0 ? text.slice(0, colon) : text).map((s) => s.trim()).filter(Boolean);
    const selected = colon >= 0
      ? splitTopLevel(text.slice(colon + 1)).map((s) => s.trim().replace(/^\w+\s*=\s*/, "")).filter((s) => /^[A-Za-z_]\w*$/.test(s))
      : [];
    modules.forEach((mod, k) => {
      const alias = /^([A-Za-z_]\w*)\s*=\s*([\w.]+)$/.exec(mod);
      const source = alias ? alias[2]! : mod.replace(/\s+/g, "");
      if (!/^[A-Za-z_][\w.]*$/.test(source)) return;
      const specifiers = k === modules.length - 1 && selected.length > 0 ? selected : [alias ? alias[1]! : source.split(".").pop()!];
      out.push({ source, specifiers, isDefault: false, isNamespace: false, isType: false, line: i + 1 });
    });
    i = j;
  }
  return out;
}

export const dSpec: RegexLangSpec = {
  language: "dlang",
  extensions: [".d", ".di"],
  lineCommentPrefixes: ["//"],
  functionPatterns: [
    { pattern: FUNCTION, isExported: (line) => !/\b(?:private|protected)\b/.test(line) },
    { pattern: CONSTRUCTOR, isExported: (line) => !/\b(?:private|protected)\b/.test(line) },
  ],
  classPatterns: [
    { pattern: CLASS, getExtends: (line) => heritage(line).base, getImplements: (line) => heritage(line).interfaces },
    { pattern: INTERFACE, kind: "interface", getExtends: (line) => heritage(line).base, getImplements: (line) => heritage(line).interfaces },
    { pattern: ENUM, kind: "enum" },
  ],
  // Read in `postExtract`: an import names several modules and may span lines.
  importPatterns: [],
  callPatterns: [PAREN_CALL],
  parseReturnType: parseDReturnType,
  // `@path("/x")` / `@auth @method(HTTPMethod.POST)` on the lines above a declaration.
  attributeLine: { pattern: new RegExp(String.raw`^\s*(${UDA}(?:\s+${UDA})*)\s*$`) },
  // Overriding class extraction also makes core drop class members from the
  // top-level function list.
  extractClasses: (lines) => {
    const classes = extractClassesWithSpec(lines, dSpec);
    refine(lines, [], classes);
    return classes;
  },
  postProcessFunctions: (lines, fns) => {
    // A top-level `this(…)` is a module constructor (`static this()`): no function of its own.
    const kept = dropNested(lines, fns.filter((f) => f.name !== "this"));
    refine(lines, kept, []);
    return kept;
  },
  extractRoutes: (lines, classes) => extractDRoutes(lines, classes, [PAREN_CALL]),
  extractDataSources: (lines) => extractDDataSources(lines),
};
