import type { ClassInfo, FunctionInfo, ImportInfo, ParamInfo, PropertyInfo } from "../../../types/analysis.js";
import { findEndLine, splitTopLevel, type CallPattern, type RegexLangSpec } from "../shared/regex-base.js";
import { extractVRoutes } from "./routes.js";
import { extractVDataSources } from "./data-sources.js";

/**
 * V regex spec (no grammar on npm that loads in web-tree-sitter 0.27). Braces
 * delimit blocks. Functions are `fn name(…) T {` (`pub` exports them); a
 * method declares its receiver before the name — `fn (mut app App) index()
 * veb.Result {` — and, as in Go, sits outside its struct, in any file of the
 * module: it is attached to the struct here (a stub class when the struct
 * lives in another file), and its receiver is a typed local. `struct`,
 * `union`, `interface` and `enum` are the class concept; attributes on the
 * line above (`@['/users/:id'; get]`, `@[table: 'users']`) are decorators.
 */

/** Words that are never a function name or a callee. */
const KEYWORDS = [
  "as", "asm", "assert", "atomic", "break", "const", "continue", "defer", "dump", "else", "enum", "false", "fn",
  "for", "go", "goto", "if", "import", "in", "interface", "is", "isreftype", "lock", "match", "module", "mut",
  "nil", "none", "or", "pub", "return", "rlock", "select", "shared", "sizeof", "spawn", "sql", "static", "struct",
  "true", "type", "typeof", "union", "unsafe", "volatile", "__global", "__offsetof",
];
/** Casts — `int(x)`, `u8(c)`, `string(bytes)` — convert, they call nothing (`x.int()` still calls). */
const CASTS = ["int", "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "isize", "usize", "byte", "rune", "bool", "string", "voidptr", "byteptr", "charptr"];
const NOT_CALLEE = `(?!(?:${[...KEYWORDS, ...CASTS].join("|")})\\b(?!\\.))`;

/** `fn name(`, `fn (r T) name(`, `fn name[T](`, `fn C.puts(` — group 1 the name. */
const FUNCTION = /^\s*(?:pub\s+)?fn\s+(?:\([^)]*\)\s*)?(?:C\.|JS\.)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?\(/;
/** The receiver of a method declaration: variable, type (`&`, `mut` and generics dropped), method name. */
const RECEIVER = /^\s*(?:pub\s+)?fn\s*\(\s*(?:mut\s+|shared\s+)?([A-Za-z_]\w*)\s+&?\s*(?:mut\s+)?([A-Za-z_][\w.]*)(?:\[[^\]]*\])?\s*\)\s*([A-Za-z_]\w*)/;

const STRUCT = /^\s*(?:pub\s+)?(?:struct|union)\s+([A-Za-z_][\w.]*)/;
const INTERFACE = /^\s*(?:pub\s+)?interface\s+([A-Za-z_]\w*)/;
const ENUM = /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/;

/**
 * A parenthesized call — `app.find_user(id)`, `json.decode(User, s)`, a
 * generic `veb.run[App, Context](mut app, 8080)` — never a keyword (`if (`,
 * `fn (`, `sizeof(`), never a compile-time call (`$veb.html()`, `$tmpl(…)`).
 * Replaces the generic `name(` matcher, which read `fn (x int)` as a call.
 */
const PAREN_CALL: CallPattern = {
  pattern: new RegExp(
    String.raw`(?<![\w$@])(?<!\$[\w.]*)(?<![)\]]\.)` + NOT_CALLEE +
      String.raw`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*(?:\[[^\[\]()]*\])?\(`,
  ),
  buildName: (m) => ({ name: m[1]!, leafName: m[1]!.slice(m[1]!.lastIndexOf(".") + 1) }),
  replacesBaseline: true,
};

/** `mut ctx Context`, `name string`, `args ...string`, `cb fn (int) bool` → param. */
function parseVParam(raw: string): ParamInfo | null {
  const m = /^\s*(?:mut\s+|shared\s+)?([A-Za-z_]\w*)\s+(.+?)\s*$/s.exec(raw);
  if (!m) return null;
  return { name: m[1]!, type: m[2]!.replace(/^\.\.\./, "...").replace(/\s+/g, " "), defaultValue: null };
}

/**
 * Parameters after the NAME (a receiver's list is not one); V shares a type
 * across a group (`a, b int`), so a bare name takes the next declared type.
 */
function vParams(lines: string[], i: number, name: string): ParamInfo[] {
  const line = lines[i]!;
  const at = line.search(new RegExp(String.raw`\b${name}\s*(?:\[[^\]]*\]\s*)?\(`));
  if (at < 0) return [];
  let depth = 0;
  let text = "";
  for (let c = line.indexOf("(", at); c < line.length; c++) {
    const ch = line[c]!;
    if (ch === "(") { if (depth++ === 0) continue; }
    else if (ch === ")" && --depth === 0) break;
    text += ch;
  }
  const params: ParamInfo[] = [];
  const pending: ParamInfo[] = [];
  for (const part of splitTopLevel(text)) {
    const p = parseVParam(part);
    if (p) {
      for (const q of pending) q.type = p.type;
      pending.length = 0;
      params.push(p);
    } else if (/^\s*(?:mut\s+)?[A-Za-z_]\w*\s*$/.test(part)) {
      const q: ParamInfo = { name: part.trim().replace(/^mut\s+/, ""), type: null, defaultValue: null };
      pending.push(q);
      params.push(q);
    }
  }
  return params;
}

/** The result type after the parameter list: `veb.Result`, `!User`, `?[]Post`, `(int, string)`. */
function parseVReturnType(line: string): string | null {
  const m = FUNCTION.exec(line);
  if (!m) return null;
  let i = line.indexOf("(", line.indexOf(m[1]!, m.index) + m[1]!.length);
  let depth = 0;
  for (; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")" && --depth === 0) break;
  }
  const ret = line.slice(i + 1).replace(/\{.*$/, "").replace(/\/\/.*$/, "").trim();
  return ret || null;
}

/**
 * Struct fields under the access labels (`pub mut:`, `mut:`, `pub:`): `name
 * string`, `id int @[primary; sql: serial]` (the field's attributes are its
 * decorators), `created time.Time = time.now()`, an embedded `Base`.
 */
function structFields(lines: string[], cls: ClassInfo): PropertyInfo[] {
  const props: PropertyInfo[] = [];
  let pub = false;
  let mutable = false;
  let depth = 0;
  for (let i = cls.line; i < Math.min(cls.endLine - 1, lines.length); i++) {
    const line = lines[i]!.replace(/\/\/.*$/, "");
    if (depth === 0) {
      const label = /^\s*(pub\s+mut|pub|mut|__global)\s*:\s*$/.exec(line);
      if (label) {
        pub = label[1]!.startsWith("pub") || label[1] === "__global";
        mutable = /mut|__global/.test(label[1]!);
      } else {
        const field = /^\s*([a-z_]\w*)\s+([^\s=@]+(?:\s*\[[^\]]*\])?)\s*(?:=[^@]*)?(?:@\[([^\]]*)\])?\s*$/.exec(line);
        const embedded = /^\s*([A-Z][\w.]*)\s*$/.exec(line);
        if (field) {
          const prop: PropertyInfo = { name: field[1]!, type: field[2]!, visibility: pub ? "public" : "private", isStatic: false, isReadonly: !mutable };
          if (field[3]) prop.decorators = field[3].split(";").map((s) => s.trim()).filter(Boolean);
          props.push(prop);
        } else if (embedded) {
          props.push({ name: embedded[1]!.split(".").pop()!, type: embedded[1]!, visibility: "public", isStatic: false, isReadonly: false });
        }
      }
    }
    for (const ch of line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "")) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return props;
}

/** An interface's method specs: `speak() string`, `mut:` sections included. */
function interfaceMethods(lines: string[], cls: ClassInfo): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  for (let i = cls.line; i < Math.min(cls.endLine - 1, lines.length); i++) {
    const m = /^\s*([a-z_]\w*)\s*\(/.exec(lines[i]!);
    if (!m) continue;
    out.push({
      name: m[1]!, params: vParams(lines, i, m[1]!), returnType: lines[i]!.replace(/^[^)]*\)/, "").replace(/\/\/.*$/, "").trim() || null,
      isAsync: false, isExported: true, decorators: [], calls: [], line: i + 1, endLine: i + 1,
    });
  }
  return out;
}

/**
 * Types as the linker needs them: structs, unions, interfaces and enums of
 * the file, with every method declared in it attached to its receiver's type
 * — a stub class for a type declared in another file of the module (core
 * reads a directory's stubs as one type). The receiver is the method's typed
 * local, so `app.find_user()` reaches `App.find_user`.
 */
function vClasses(lines: string[], fns: FunctionInfo[]): ClassInfo[] {
  const classes: ClassInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    const s = STRUCT.exec(line) ?? INTERFACE.exec(line) ?? ENUM.exec(line);
    if (!s || !line.includes("{")) continue;
    const endLine = findEndLine(lines, i, "brace");
    const kind = INTERFACE.test(line) ? "interface" : ENUM.test(line) ? "enum" : undefined;
    const cls: ClassInfo = {
      name: s[1]!.split(".").pop()!, extends: null, implements: [], decorators: attributesAbove(lines, i),
      methods: [], properties: [], isExported: /^\s*pub\b/.test(line), line: i + 1, endLine,
    };
    if (kind) cls.kind = kind;
    if (kind === "interface") cls.methods = interfaceMethods(lines, cls);
    else if (!kind) cls.properties = structFields(lines, cls);
    classes.push(cls);
    i = endLine - 1;
  }
  const byName = new Map(classes.map((c) => [c.name, c]));
  const stubs = new Map<string, ClassInfo>();
  for (const fn of fns) {
    const recv = RECEIVER.exec(lines[fn.line - 1] ?? "");
    if (!recv || recv[3] !== fn.name) continue;
    const type = recv[2]!.split(".").pop()!;
    if (recv[1] !== "_") fn.localTypes = [{ name: recv[1]!, type }, ...(fn.localTypes ?? [])];
    let owner = byName.get(type) ?? stubs.get(type);
    if (!owner) {
      owner = { name: type, extends: null, implements: [], decorators: [], methods: [], properties: [], isExported: /^[A-Z]/.test(type), line: fn.line, endLine: fn.endLine };
      stubs.set(type, owner);
    }
    owner.methods.push(fn);
    if (stubs.get(type) === owner) owner.endLine = Math.max(owner.endLine, fn.endLine);
  }
  return [...classes, ...stubs.values()].sort((a, b) => a.line - b.line);
}

const ATTRIBUTE = /^\s*@?\[([^\]]*)\]\s*$/;

/** Stacked attribute lines above line `i` — `@['/x'; post]`, the older `['/x']` — nearest last. */
function attributesAbove(lines: string[], i: number): string[] {
  const out: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const m = ATTRIBUTE.exec(lines[j]!);
    if (!m) break;
    out.unshift(m[1]!.trim());
  }
  return out;
}

/**
 * Imports: `import os`, `import net.http`, `import db.sqlite as sqlite`,
 * `import x.y { a, b }` (the names it brings in unqualified are its
 * specifiers; otherwise the alias or the module's last segment, the name its
 * members are called through).
 */
export function vImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  lines.forEach((line, i) => {
    const m = /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?(?:\s*\{([^}]*)\})?/.exec(line);
    if (!m) return;
    const selected = (m[3] ?? "").split(",").map((s) => s.trim()).filter((s) => /^[A-Za-z_]\w*$/.test(s));
    const specifiers = selected.length > 0 ? selected : [m[2] ?? m[1]!.split(".").pop()!];
    out.push({ source: m[1]!, specifiers, isDefault: false, isNamespace: false, isType: false, line: i + 1 });
  });
  return out;
}

export const vSpec: RegexLangSpec = {
  language: "vlang",
  extensions: [".v", ".vsh"],
  lineCommentPrefixes: ["//"],
  // A `.vsh` script runs its statements.
  topLevelCalls: /\.vsh$/i,
  functionPatterns: [{ pattern: FUNCTION, isExported: (line) => /^\s*pub\b/.test(line) }],
  // Built by `vClasses` (methods are declared outside their struct).
  classPatterns: [],
  importPatterns: [
    {
      pattern: /^\s*import\s+([\w.]+)(?:\s+as\s+(\w+))?(?:\s*\{([^}]*)\})?/,
      getSource: (m) => m[1]!,
      getSpecifiers: (m) => vImports([m[0]])[0]?.specifiers ?? [],
    },
  ],
  callPatterns: [PAREN_CALL],
  parseReturnType: parseVReturnType,
  attributeLine: { pattern: ATTRIBUTE },
  // Overriding class extraction also makes core drop the attached methods
  // from the top-level function list.
  extractClasses: (lines, fns) => {
    for (const fn of fns) fn.params = vParams(lines, fn.line - 1, fn.name);
    return vClasses(lines, fns);
  },
  extractRoutes: (lines, classes) => extractVRoutes(lines, classes),
  extractDataSources: (lines) => extractVDataSources(lines),
};
