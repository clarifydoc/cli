import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "./regex-base.js";

type LocalTypes = NonNullable<FunctionInfo["localTypes"]>;

/** Words before a declaration's type that say nothing of which type it is. */
const SPECIFIERS = new Set(["const", "constexpr", "constinit", "static", "volatile", "register", "thread_local", "inline", "mutable", "struct", "class", "enum", "union", "typename", "extern"]);
/** Names that open a statement which declares nothing. */
const NOT_A_TYPE = new Set([
  "return", "delete", "throw", "goto", "case", "default", "else", "new", "using", "typedef", "namespace", "template",
  "public", "private", "protected", "friend", "operator", "break", "continue", "do", "if", "while", "for", "switch",
  "co_return", "co_yield", "co_await", "sizeof", "alignof", "decltype", "static_assert", "this", "asm", "requires",
  "emit", "Q_EMIT",
]);
/** Types whose values have no members to call: never written out. */
const PRIMITIVES = new Set([
  "void", "bool", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "wchar_t", "char8_t",
  "char16_t", "char32_t", "size_t", "ssize_t", "ptrdiff_t", "intptr_t", "uintptr_t", "int8_t", "int16_t", "int32_t",
  "int64_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "_Bool",
]);
/** Factories whose result is a pointer to their type argument: `std::make_unique<Club>(…)` is a `Club` to call. */
const POINTER_FACTORIES = /^(?:std\s*::\s*)?(?:make_unique|make_shared|allocate_shared)\s*</;
/** Casts whose result is their type argument. */
const CASTS = /^(?:std\s*::\s*)?(?:static_cast|dynamic_cast|reinterpret_cast|const_cast|static_pointer_cast|dynamic_pointer_cast|qobject_cast)\s*</;
/** Statements a body opens that hold a declaration in their parentheses: `for (Club* c : clubs)`, `catch (const Foul& f)`. */
const HEADS = /\b(for|if|while|switch|catch)\s*\(/g;

/**
 * Locals whose type a C or C++ body states, for the linker to type a member call on them (`c.seal()`, `p->drill()`):
 *
 *   Crate c;  Crate c(3);  Crate c{3};  Crate c = Crate();     → Crate
 *   Coach* p = new Coach();  const Coach& r = pick();          → Coach (the declared type wins)
 *   std::unique_ptr<Coach> sp;                                → unique_ptr<Coach> (core unwraps the manifest's wrappers)
 *   auto p = new Coach(…);  auto c = Crate{};                 → Coach, Crate
 *   auto o = std::unique_ptr<Coach>(new Coach);              → unique_ptr<Coach>
 *   auto sp = std::make_unique<Coach>(…);                     → Coach
 *   auto* c = dynamic_cast<Coach*>(x);                        → Coach
 *   auto r = repo.find(id);  auto s = Store::open(p);          → `from` the call, typed by its declared return
 *   auto c = Crate(3);                                        → `from`: a construction, or a function's result
 *   for (Coach* c : coaches)  catch (const Foul& f)           → Coach, Foul
 *
 * Types are written as the parameters' are (namespaces, `const`, `*` and `&` dropped, template arguments kept).
 * Primitives are left out. A name declared again with another or an unknown type (`auto x = …` the reading cannot
 * type, a structured binding, a range-for over `auto`), or shadowing a parameter of another type, is left out:
 * which binding a call sees cannot be told.
 */
export function extractCFamilyLocalTypes(bodyLines: readonly string[], params: readonly ParamInfo[]): LocalTypes {
  const seen = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  const fromCalls = new Map<string, Set<string>>();
  const record = (d: Declared): void => {
    if (d.type === null && d.from === undefined) { unknown.add(d.name); return; }
    if (d.from !== undefined) {
      const calls = fromCalls.get(d.name) ?? fromCalls.set(d.name, new Set()).get(d.name)!;
      calls.add(d.from);
      return;
    }
    const types = seen.get(d.name) ?? seen.set(d.name, new Set()).get(d.name)!;
    types.add(d.type!);
  };

  for (const raw of bodyLines) {
    if (!/[A-Za-z_]\w*[\s*&>]+[*&\s]*[A-Za-z_]/.test(raw)) continue;
    const line = blankStringLiterals(raw.replace(/\/\*.*?\*\//g, (c) => " ".repeat(c.length)), ["//"]);
    // A statement's own head: `for (…)`'s declaration is read apart from the statement it controls. In a condition
    // only one with an initializer declares (`if (Club* c = find())`); `if (a < b && c > d)` compares.
    let rest = line;
    HEADS.lastIndex = 0;
    for (let m = HEADS.exec(line); m; m = HEADS.exec(line)) {
      const open = m.index + m[0].length - 1;
      const close = closing(line, open);
      if (close < 0) continue;
      // `for (int i = 0; i < n; i++)`, `if (auto c = pick(); c)`: the declaration is the first clause.
      const inner = line.slice(open + 1, close).split(";")[0]!;
      for (const d of declarations(inner, m[1] !== "catch")) record(d);
      rest = rest.slice(0, open) + " ".repeat(close - open + 1) + rest.slice(close + 1);
    }
    for (const piece of rest.split(";")) for (const d of declarations(piece, false)) record(d);
  }

  const out: LocalTypes = [];
  for (const [name, calls] of fromCalls) {
    if (seen.has(name) || unknown.has(name) || params.some((p) => p.name === name)) continue;
    for (const from of calls) out.push({ name, type: "", from });
  }
  for (const [name, types] of seen) {
    if (unknown.has(name) || types.size !== 1 || fromCalls.has(name)) continue;
    const type = [...types][0]!;
    const param = params.find((p) => p.name === name);
    if (param && param.type !== type) continue;
    if (PRIMITIVES.has(type.split(/[ <]/)[0]!)) continue;
    out.push({ name, type });
  }
  return out;
}

interface Declared {
  name: string;
  /** The type written or constructed; null when the declaration states none the reading can tell. */
  type: string | null;
  /** The call that initializes it, when that is all that says its type. */
  from?: string;
}

/** The declarations one statement makes: `Crate a, *b = make(), c(3)` declares three; `needsInit` in a condition. */
function declarations(statement: string, needsInit: boolean): Declared[] {
  // Braces and labels before the statement: `} else {`, `{ Crate c;`, `case 1:`.
  const text = statement.replace(/^(?:\s*(?:[{}]|else\b|do\b|(?:case\b[^:]*|default|public|private|protected)\s*:(?!:)))*\s*/, "");
  let at = 0;
  const word = (): string | null => {
    const m = /^\s*([A-Za-z_]\w*)/.exec(text.slice(at));
    if (!m) return null;
    at += m[0].length;
    return m[1]!;
  };
  // Specifiers, then the type: a name, `::` paths, template arguments.
  let first: string | null;
  for (;;) {
    const before = at;
    first = word();
    if (first === null) return [];
    if (!SPECIFIERS.has(first)) { at = before; break; }
  }
  const typeStart = at;
  if (/^\s*::/.test(text.slice(at))) at = text.indexOf("::", at) + 2;
  for (;;) {
    const name = word();
    if (name === null || NOT_A_TYPE.has(name)) return [];
    const angle = /^\s*</.exec(text.slice(at));
    if (angle) {
      const close = closingAngle(text, at + angle[0].length - 1);
      if (close < 0) return [];
      at = close + 1;
    }
    const scope = /^\s*::\s*/.exec(text.slice(at));
    if (!scope) break;
    at += scope[0].length;
  }
  // `unsigned long long x`, `long double d`: a primitive spelled in words.
  while (/^\s+(?:int|long|short|char|double|signed|unsigned)\b/.test(text.slice(at))) word();
  const typeText = text.slice(typeStart, at).trim();
  const out: Declared[] = [];
  for (const part of topLevelCommas(text.slice(at))) {
    const d = declarator(part, typeText, needsInit);
    if (!d) return out;
    out.push(...d);
  }
  return out;
}

/** One declarator after the type: `*p = new Club()`, `c(3)`, `&r`, `[a, b] = pair` (a structured binding). */
function declarator(part: string, typeText: string, needsInit: boolean): Declared[] | null {
  const m = /^\s*((?:[*&]|&&|\bconst\b|\bvolatile\b|\s)*)([A-Za-z_]\w*|\[[^\]]*\])\s*(.*)$/s.exec(part);
  if (!m) return null;
  const name = m[2]!;
  const init = m[3]!.trim();
  if (needsInit && !/^(?:=(?!=)|:(?!:)|\{)/.test(init)) return null;
  if (name.startsWith("[")) return [...name.slice(1, -1).matchAll(/[A-Za-z_]\w*/g)].map((n) => ({ name: n[0], type: null }));
  if (NOT_A_TYPE.has(name) || SPECIFIERS.has(name)) return null;
  // What may follow a declared name: nothing, an initializer, an array bound, a range-for's `:`.
  if (init && !/^(?:=(?!=)|\(|\{|\[|:(?!:))/.test(init)) return null;
  // `Crate c(3)` constructs, `Crate f(int)` would declare a function: both name a Crate as far as calls on it go.
  if (typeText === "auto") {
    if (!init.startsWith("=")) return [{ name, type: null }];
    const value = init.slice(1).trim();
    const built = constructedType(value);
    if (built) return [{ name, type: built }];
    const from = initializerCall(value);
    return from ? [{ name, type: null, from }] : [{ name, type: null }];
  }
  const type = cFamilyTypeName(typeText);
  return type ? [{ name, type }] : null;
}

/**
 * A declared type as the parameters spell theirs: `const std::vector<league::Club>&` → `vector<Club>`; a class
 * scope stays, its template arguments dropped (`Paddock<K, C>::Iterator` → `Paddock::Iterator`, a nested class).
 */
export function cFamilyTypeName(raw: string): string | null {
  const text = raw
    .replace(/\b(?:const|volatile|struct|class|enum|union|typename)\b/g, " ")
    .replace(/(?:^|(?<=[<,\s]))::/g, "")
    .replace(/([A-Za-z_]\w*)\s*(?:<[^<>]*>)?\s*::\s*/g, (_m, scope: string) => (/^[A-Z]/.test(scope) ? `${scope}::` : ""))
    .replace(/[*&\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return /^[A-Za-z_]\w*/.test(text) ? text.replace(/\s*([<>,])\s*/g, "$1") : null;
}

/** The type an initializer plainly constructs: `new Club(…)`, `Club()`, `Club{…}`, `std::make_unique<Club>(…)`, a cast. */
function constructedType(value: string): string | null {
  const v = value.replace(/;?\s*$/, "");
  const fresh = /^new\s+((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*(?:\s*<[^;]*?>)?)\s*(?:[({][\s\S]*)?$/.exec(v);
  if (fresh) return cFamilyTypeName(fresh[1]!);
  const factory = POINTER_FACTORIES.exec(v) ?? CASTS.exec(v);
  if (factory) {
    const open = factory[0].length - 1;
    const close = closingAngle(v, open);
    return close > 0 ? cFamilyTypeName(v.slice(open + 1, close)) : null;
  }
  // `Club{…}`, `league::Club{…}`, `Box<int>()`, `std::unique_ptr<Club>(…)`: a type built whole. `Club(…)` may as well
  // call a function (`NewFixtureList(…)`, `Slot::Create(…)`): it is the linker's to tell, as an initializer call.
  const ctor = /^((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)(\s*<[^;()]*>)?\s*([({])/.exec(v);
  if (!ctor || closing(v, ctor[0].length - 1, ctor[3] === "(" ? ")" : "}") !== v.length - 1) return null;
  if (ctor[3] === "{" ? /^[A-Z]/.test(ctor[1]!.split("::").at(-1)!.trim()) || ctor[2] : ctor[2]) return cFamilyTypeName(ctor[1]! + (ctor[2] ?? ""));
  return null;
}

/**
 * An initializer that is a call, for `localTypes[].from`: `repo.find(id)`, `Store::open(p)`, `this->pick()`, spelled
 * with `.` for `->` as the linker reads a receiver chain. Null for anything else (an operator, a literal).
 */
function initializerCall(value: string): string | null {
  const v = value.replace(/;?\s*$/, "").replace(/\s*->\s*/g, ".");
  const m = /^((?:[A-Za-z_]\w*(?:\s*\([^()]*(?:\([^()]*\)[^()]*)*\))?\s*(?:::|\.)\s*)*[A-Za-z_]\w*)\s*\(/.exec(v);
  if (!m || closing(v, m[0].length - 1) !== v.length - 1) return null;
  return v.replace(/\s+/g, " ");
}

/** Index of the bracket closing the one at `open`, or -1. */
function closing(text: string, open: number, close = ")"): number {
  const opener = text[open]!;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === opener) depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return -1;
}

/** Index of the `>` closing the `<` at `open` (`>>` closes two), or -1 when a `;` or an unbalanced `)` comes first. */
function closingAngle(text: string, open: number): number {
  let depth = 0;
  let parens = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(") parens++;
    else if (c === ")" && --parens < 0) return -1;
    else if (c === ";" || c === "{") return -1;
    else if (c === "<" && parens === 0) depth++;
    else if (c === ">" && parens === 0 && --depth === 0) return i;
  }
  return -1;
}

/** `a, *b = f(x, y), c{1, 2}` → its declarators, commas inside brackets kept. */
function topLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}
