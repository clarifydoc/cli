import type { ClassInfo, FunctionInfo, ImportInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, extractClassesWithSpec, inlineBodyColumn, splitTopLevel, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { nimBlockEnd } from "./source.js";
import { extractNimRoutes } from "./routes.js";
import { extractNimDataSources } from "./data-sources.js";

/**
 * Nim regex spec (no grammar on npm that loads in web-tree-sitter 0.27).
 * Indentation delimits blocks. Routines are `proc` / `func` / `method` /
 * `iterator` / `converter` / `template` / `macro`, a trailing `*` exports the
 * name; object, enum and concept types (alone or in a `type` section) are the
 * class concept. Calls may omit their parentheses (`echo x`, `resp Http404,
 * body`), and `x.f(y)` is `f(x, y)`. A module's statements run when it is
 * loaded, so top-level calls are the `<setup>` pseudo-function — a Jester
 * `routes:` block among them.
 */

/** Words no routine is named and no call names (Nim keywords). */
const KEYWORDS = [
  "addr", "and", "as", "asm", "bind", "block", "break", "case", "cast", "concept", "const", "continue",
  "converter", "defer", "discard", "distinct", "div", "do", "elif", "else", "end", "enum", "except", "export",
  "finally", "for", "from", "func", "if", "import", "in", "include", "interface", "is", "isnot", "iterator",
  "let", "macro", "method", "mixin", "mod", "nil", "not", "notin", "object", "of", "or", "out", "proc", "ptr",
  "raise", "ref", "return", "shl", "shr", "static", "template", "try", "tuple", "type", "using", "var", "when",
  "while", "xor", "yield",
];

/**
 * Compile-time magics and type conversions: `defined(x)`, `int(x)`,
 * `seq[int](x)` evaluate or convert, they call nothing of the project's.
 */
const NOT_CALLEES = [
  "defined", "declared", "compiles", "typeof", "sizeof", "alignof", "unsafeAddr", "astToStr",
  "int", "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float", "float32",
  "float64", "bool", "char", "string", "cstring", "cint", "cuint", "clong", "culong", "cfloat", "cdouble", "csize_t",
  "byte", "Natural", "Positive", "pointer", "seq", "array", "set", "openArray", "varargs", "range", "typedesc",
];

/** Words after which a name is NOT being called with arguments (operators spelt as words). */
const NOT_ARGUMENT = ["and", "or", "xor", "not", "in", "notin", "is", "isnot", "of", "as", "div", "mod", "shl", "shr", "do"];

const NOT_CALLED = `(?!(?:${[...KEYWORDS, ...NOT_CALLEES].join("|")})\\b)`;

/**
 * A command call — `echo x`, `resp Http404, $(%err)`, `result.add item`,
 * `cond id != -1` — at a statement's start (optionally after `discard`,
 * `return`, `await`, `yield`, `result =` or a `let`/`var` binding): a name
 * followed by a space and the start of an argument, never a keyword, never a
 * word operator (`a and b`). A line that carries on the statement above it
 * (`notAfter`) is not a statement start, and a Jester route head (`get
 * "/x":`, `error Http404:`) is routing syntax, read by `extractNimRoutes`.
 */
const COMMAND_CALL: CallPattern = {
  pattern: new RegExp(
    String.raw`^\s*(?!(?:get|post|put|patch|delete|head|options|any|error)\s+(?:re)?(?:"[^"]*"|[\w.]+)\s*(?:,[^:]*)?:\s*(?:#.*)?$)` +
      String.raw`(?:(?:discard|return|await|yield)\s+|result\s*=\s*|(?:let|var|const)\s+[A-Za-z_]\w*\s*(?::[^=]+)?=\s*)?` +
      NOT_CALLED +
      // An argument opens with a name, a literal, a bracket, or a prefix
      // operator glued to its operand (`%user`, `$id`, `&"…"`, `-1`).
      String.raw`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]+(?!(?:${NOT_ARGUMENT.join("|")})\b)(?=[A-Za-z_\d"'@\[{(]|[$%&-][\w"(\[{])`,
  ),
  notAfter: /(?:[,(\[{+\-*/&|<>.~^%@]|\b(?:and|or|not|xor|in|notin|is|isnot|div|mod|shl|shr|of)|\\)\s*$/,
  buildName: (m) => ({ name: m[1]!, leafName: m[1]!.slice(m[1]!.lastIndexOf(".") + 1) }),
};

/**
 * A parenthesized call — `getRow(db, q)`, `db.getRow(q)` (UFCS), a generic
 * `newSeq[int](n)` — never a keyword (`if (`, `proc (`, `cast[int](`), a
 * magic or a conversion. Replaces the generic `name(` matcher, which read
 * `proc(` and `int(` as calls.
 */
const PAREN_CALL: CallPattern = {
  pattern: new RegExp(
    // `make().bar(` / `xs[0].bar(`: the receiver is a value the name cannot
    // stand for, so `bar` alone would let a same-named routine capture it.
    String.raw`(?<![\w\x60@$])(?<![)\]]\.)` + NOT_CALLED + String.raw`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(?:\[[^\[\]()]*\])?\(`,
  ),
  buildName: (m) => ({ name: m[1]!, leafName: m[1]!.slice(m[1]!.lastIndexOf(".") + 1) }),
  replacesBaseline: true,
};

/** `proc name*[T](…)` — group 1 the name; operators (`` `$` ``) are not named routines. */
const ROUTINE = /^\s*(?:proc|func|method|iterator|converter|template|macro)\s+([A-Za-z_]\w*)\s*\*?\s*(?:\[[^\]]*\]\s*)?(?:\(|:|=|\{\.|$)/;

/**
 * `Name* = ref object of Base`, `Name[T] {.pure.} = enum`, `Name = concept x`
 * — alone (`type Name = object`) or as an entry of a `type` section.
 */
const TYPE_DECL = /^\s*(?:type\s+)?([A-Za-z_]\w*)\s*\*?\s*(?:\[[^\]]*\]\s*)?(?:\{\.[^}]*\.\}\s*)?=\s*(?:ref\s+|ptr\s+)?(object|enum|concept)\b/;

/** `name: Type`, `a, b: Type = x`, `x = 5`, `x: var T`, `cb: proc (a: int): int` → params (types shared back across a group). */
export function parseNimParams(text: string): ParamInfo[] {
  const out: ParamInfo[] = [];
  for (const group of text.split(/;/)) {
    const pending: ParamInfo[] = [];
    for (const raw of splitTopLevel(group)) {
      const part = raw.trim();
      if (!part) continue;
      const m = /^([A-Za-z_]\w*)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/s.exec(part);
      if (!m) continue;
      const param: ParamInfo = { name: m[1]!, type: m[2]?.trim().replace(/\s+/g, " ") ?? null, defaultValue: m[3]?.trim() ?? null };
      pending.push(param);
      if (param.type || param.defaultValue) {
        // `a, b: int` — the names before take this one's type.
        for (const p of pending) if (!p.type && !p.defaultValue) p.type = param.type;
        pending.length = 0;
      }
      out.push(param);
    }
  }
  return out;
}

/** The text inside the `( … )` that follows a routine's name on line `i` (wrapped signatures joined), or null. */
function paramText(lines: string[], i: number, name: string): string | null {
  const head = lines[i]!;
  const at = head.search(new RegExp(String.raw`\b${name}\s*\*?\s*(?:\[[^\]]*\]\s*)?\(`));
  if (at < 0) return null;
  let text = "";
  let depth = 0;
  for (let li = i; li < Math.min(lines.length, i + 12); li++) {
    const line = lines[li]!;
    for (let c = li === i ? head.indexOf("(", at) : 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === "(") {
        if (depth++ === 0) continue;
      } else if (ch === ")" && --depth === 0) return text;
      text += ch;
    }
    text += " ";
  }
  return null;
}

/** The declared result type: `proc f(x: int): string =` → `string`. */
function parseNimReturnType(line: string): string | null {
  const m = ROUTINE.exec(line);
  if (!m) return null;
  let i = line.indexOf(m[1]!) + m[1]!.length;
  let depth = 0;
  for (; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (depth === 0 && (ch === ":" || ch === "=" || line.startsWith("{.", i))) break;
  }
  const ret = /^:\s*([^=]+?)\s*(?:\{\.|=|#|$)/.exec(line.slice(i));
  return ret ? ret[1]!.trim() || null : null;
}

/** 1-based [start, end] of every routine declared in the file (any depth). */
const SPANS = new WeakMap<string[], Array<[number, number]>>();
function routineSpans(lines: string[]): Array<[number, number]> {
  let spans = SPANS.get(lines);
  if (!spans) {
    spans = [];
    for (let i = 0; i < lines.length; i++) {
      if (ROUTINE.test(lines[i]!) && !/^\s*#/.test(lines[i]!)) spans.push([i + 1, nimBlockEnd(lines, i)]);
    }
    SPANS.set(lines, spans);
  }
  return spans;
}

/** Re-read a declaration's calls when its block runs on past where the generic finder stopped. */
function extendToBlockEnd(lines: string[], decl: { name: string; line: number; endLine: number; calls: FunctionInfo["calls"] }): void {
  const end = nimBlockEnd(lines, decl.line - 1);
  if (end === decl.endLine) return;
  decl.endLine = end;
  const head = lines[decl.line - 1]!;
  const inline = inlineBodyColumn(head, head.indexOf(decl.name) + decl.name.length);
  decl.calls = extractCallsFromBody(lines, decl.line, end, nimSpec.lineCommentPrefixes, nimSpec.callPatterns, inline >= 0 ? { line: decl.line - 1, column: inline } : undefined);
}

/**
 * A routine declared INSIDE another (a closure, a local helper) is part of
 * the enclosing routine: its calls are already the enclosing one's, and it is
 * no routine of the module.
 */
function dropNested<T extends { line: number; endLine: number }>(lines: string[], fns: T[]): T[] {
  const spans = routineSpans(lines);
  return fns.filter((fn) => !spans.some(([start, end]) => start < fn.line && end >= fn.endLine));
}

/** Parameters across `;` groups and shared types, and `{.async.}` on a wrapped signature. */
function refineRoutines(lines: string[], fns: FunctionInfo[]): FunctionInfo[] {
  for (const fn of fns) {
    extendToBlockEnd(lines, fn);
    const text = paramText(lines, fn.line - 1, fn.name);
    fn.params = text === null ? [] : parseNimParams(text);
    if (!fn.isAsync) {
      for (let i = fn.line - 1; i < Math.min(fn.endLine, fn.line + 4, lines.length); i++) {
        if (/\{\.[^}]*\basync\b/.test(lines[i]!)) fn.isAsync = true;
        if (/=\s*(?:#.*)?$/.test(lines[i]!)) break;
      }
    }
  }
  return dropNested(lines, fns);
}

/**
 * Object fields — `name: Type`, `a, b*: Type`, `x {.pragma.}: T` — of an
 * object's body, a variant's discriminator (`case kind: K`) and arm fields
 * included. Enum and concept bodies declare no state.
 */
function objectFields(lines: string[], cls: ClassInfo): PropertyInfo[] {
  if (!/=\s*(?:ref\s+|ptr\s+)?object\b/.test(lines[cls.line - 1] ?? "")) return [];
  const props: PropertyInfo[] = [];
  for (let i = cls.line; i < Math.min(cls.endLine, lines.length); i++) {
    const text = lines[i]!.replace(/\s*#.*$/, "").trim().replace(/^case\s+/, "");
    if (/^(?:of|else|elif|when)\b/.test(text)) continue;
    const m = /^((?:[A-Za-z_]\w*(?:\s*\*)?(?:\s*\{\.[^}]*\.\})?\s*,\s*)*[A-Za-z_]\w*(?:\s*\*)?(?:\s*\{\.[^}]*\.\})?)\s*:\s*([^=]+?)\s*(?:=.*)?$/.exec(text);
    if (!m) continue;
    for (const raw of m[1]!.split(",")) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(raw)?.[1];
      if (!name) continue;
      props.push({ name, type: m[2]!.trim(), visibility: /\*/.test(raw) ? "public" : "private", isStatic: false, isReadonly: false });
    }
  }
  return props;
}

/** Module paths of one import list: `os, std/[strutils, json], ./db`. */
function modulePaths(list: string): string[] {
  const out: string[] = [];
  for (const raw of splitTopLevel(list.replace(/#.*$/gm, ""))) {
    const item = raw.trim().replace(/\s+as\s+\w+$/, "").replace(/\s+except\s+.*$/s, "").replace(/\s+/g, "");
    const group = /^(.*?)\[(.*)\]$/s.exec(item);
    if (group) {
      for (const member of group[2]!.split(",")) if (member.trim()) out.push(group[1]! + member.trim());
    } else if (item) out.push(item.replace(/^"|"$/g, ""));
  }
  return out;
}

/**
 * Imports: `import os, std/[strutils, json], ./db` (continued over following
 * lines while one ends in a comma, or as an indented list after a bare
 * `import`), `import x except y`, `import x as y`, `from x import a, b`,
 * `include x`. Each module is its own import; its specifier is the name the
 * module is reachable by (`db.query()`), or the names a `from` import binds.
 */
export function nimImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const from = /^\s*from\s+(\S+)\s+import\s+(.+)$/.exec(line);
    if (from) {
      const names = from[2]!.replace(/#.*$/, "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s) && s !== "nil");
      for (const source of modulePaths(from[1]!)) {
        out.push({ source, specifiers: names, isDefault: false, isNamespace: false, isType: false, line: i + 1 });
      }
      continue;
    }
    const imp = /^(\s*)(import|include)\b(.*)$/.exec(line);
    if (!imp) continue;
    let text = imp[3]!;
    let j = i;
    // `import` alone on its line: an indented list follows. Otherwise the
    // statement continues while a line ends in a comma or an open bracket.
    const indent = imp[1]!.length;
    if (text.trim() === "") {
      while (j + 1 < lines.length && (lines[j + 1]!.trim() === "" || /^\s*/.exec(lines[j + 1]!)![0].length > indent)) text += "\n" + lines[++j];
    } else {
      let depth = 0;
      for (const ch of text) depth += ch === "[" ? 1 : ch === "]" ? -1 : 0;
      while (j + 1 < lines.length && (depth > 0 || /,\s*(?:#.*)?$/.test(lines[j]!))) {
        text += "\n" + lines[++j];
        for (const ch of lines[j]!) depth += ch === "[" ? 1 : ch === "]" ? -1 : 0;
      }
    }
    // `import a, b except x, y` — the names after `except` are not modules.
    text = text.replace(/#.*$/gm, "").replace(/\bexcept\b[\s\S]*$/, "");
    const alias = /^\s*(\S+)\s+as\s+([A-Za-z_]\w*)\s*$/.exec(text);
    for (const source of modulePaths(text)) {
      const leaf = source.slice(source.lastIndexOf("/") + 1);
      out.push({ source, specifiers: [alias ? alias[2]! : leaf], isDefault: false, isNamespace: false, isType: false, line: i + 1 });
    }
    i = j;
  }
  return out;
}

export const nimSpec: RegexLangSpec = {
  language: "nim",
  extensions: [".nim", ".nims"],
  indentBased: true,
  lineCommentPrefixes: ["#"],
  // A module's top-level statements run when it is loaded (`runForever()`,
  // a Jester `routes:` block, `when isMainModule:`).
  topLevelCalls: true,
  functionPatterns: [
    { pattern: ROUTINE, isExported: (line, name) => new RegExp(String.raw`\b${name}\s*\*`).test(line) },
  ],
  classPatterns: [
    {
      pattern: TYPE_DECL,
      getExtends: (line) => /\bobject\s+of\s+([A-Za-z_][\w.]*)/.exec(line)?.[1] ?? null,
    },
  ],
  // Read in `postExtract` (lists span lines; a bracket group names several modules).
  importPatterns: [],
  callPatterns: [COMMAND_CALL, PAREN_CALL],
  parseReturnType: parseNimReturnType,
  // Overriding class extraction also makes core drop class members from the
  // top-level function list (a concept's routine signatures).
  extractClasses: (lines) => {
    const classes = extractClassesWithSpec(lines, nimSpec);
    for (const cls of classes) {
      cls.endLine = nimBlockEnd(lines, cls.line - 1);
      if (/=\s*(?:ref\s+|ptr\s+)?enum\b/.test(lines[cls.line - 1] ?? "")) cls.kind = "enum";
      cls.properties = objectFields(lines, cls);
      cls.methods = refineRoutines(lines, cls.methods);
      cls.isExported = /^\s*(?:type\s+)?[A-Za-z_]\w*\s*\*/.test(lines[cls.line - 1] ?? "");
    }
    return classes;
  },
  postProcessFunctions: (lines, fns) => refineRoutines(lines, fns),
  extractRoutes: (lines) => extractNimRoutes(lines, [COMMAND_CALL, PAREN_CALL]),
  extractDataSources: (lines) => extractNimDataSources(lines),
};
