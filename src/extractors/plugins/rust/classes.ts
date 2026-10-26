import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import { blockEndLine, extractClassesWithSpec, splitTopLevel, type RegexLangSpec } from "../shared/regex-base.js";

/**
 * Rust types as the linker needs them. Methods live in `impl` blocks apart
 * from the struct, so the generic class pass saw structs without methods and
 * every method as a free function (`run`, `load` — colliding across types).
 * Here:
 *
 * - each method of `impl X { … }` / `impl Trait for X { … }` belongs to `X`:
 *   the struct's (or enum's) own ClassInfo when this file declares it, else a
 *   stub ClassInfo carrying this file's methods; `impl Trait for X` adds
 *   `Trait` to X's `implements`. A blanket impl (`impl<T: Bound> Trait for T`)
 *   names no type and attaches nothing.
 * - traits are interfaces (nominal: implemented by `impl Trait for X` only),
 *   their signatures and default methods are their methods.
 * - a generic parameter bounded by ONE trait (`struct Svc<R: UserRepo>`,
 *   `where R: UserRepo`, `fn h<R: UserRepo>(r: &R)`, `impl<R: UserRepo>`)
 *   stands for that trait in field, parameter and local types — a call on it
 *   can only reach the trait's methods. `Self` in a method stands for the
 *   impl's type.
 * - a one-line struct body (`struct S { repo: PgRepo }`) has its fields read.
 */
export function extractRustClasses(lines: string[], fns: FunctionInfo[], spec: RegexLangSpec): ClassInfo[] {
  const classes = extractClassesWithSpec(lines, spec);
  for (const cls of classes) {
    if (cls.kind === "interface") continue;
    if (cls.line === cls.endLine && cls.properties.length === 0) readInlineFields(lines[cls.line - 1] ?? "", cls, spec);
    const bounds = genericBounds(declarationHead(lines, cls.line - 1));
    if (bounds.size > 0) for (const p of cls.properties) if (p.type) p.type = substitute(p.type, bounds);
  }

  const owners = new Map<string, ClassInfo>();
  for (const cls of classes) if (!owners.has(cls.name)) owners.set(cls.name, cls);
  const stubs = new Map<string, ClassInfo>();
  const attached = new Set<FunctionInfo>();
  const sorted = [...fns].sort((a, b) => a.line - b.line);

  for (let i = 0; i < lines.length; i++) {
    if (!IMPL_RE.test(lines[i]!)) continue;
    const head = declarationHead(lines, i);
    const impl = parseImplHead(head);
    const endLine = blockEndLine(lines, i, spec);
    if (impl) {
      const owner = owners.get(impl.type) ?? stubs.get(impl.type) ?? newStub(impl.type, i + 1, endLine, stubs);
      if (impl.trait && !owner.implements.includes(impl.trait)) owner.implements.push(impl.trait);
      if (stubs.get(impl.type) === owner) owner.endLine = Math.max(owner.endLine, endLine);
      // Direct members only: a fn nested in a method body stays where it is.
      let coveredTo = 0;
      for (let k = firstAfter(sorted, i + 1); k < sorted.length && sorted[k]!.line <= endLine; k++) {
        const fn = sorted[k]!;
        if (fn.line <= coveredTo || attached.has(fn)) continue;
        coveredTo = fn.endLine;
        attached.add(fn);
        owner.methods.push(fn);
        resolveGenerics(fn, lines, impl.bounds, impl.type);
      }
    }
  }
  for (const fn of fns) if (!attached.has(fn)) resolveGenerics(fn, lines, new Map(), null);
  for (const cls of classes) {
    if (cls.kind !== "interface") continue;
    const bounds = genericBounds(declarationHead(lines, cls.line - 1));
    for (const m of cls.methods) resolveGenerics(m, lines, bounds, null);
  }
  for (const cls of [...classes, ...stubs.values()]) cls.methods.sort((a, b) => a.line - b.line);
  return [...classes, ...stubs.values()].sort((a, b) => a.line - b.line);
}

const IMPL_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?impl\b/;

/** Index of the first function (sorted by line) declared after `line`. */
function firstAfter(sorted: FunctionInfo[], line: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]!.line <= line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function newStub(name: string, line: number, endLine: number, stubs: Map<string, ClassInfo>): ClassInfo {
  const stub: ClassInfo = {
    name,
    extends: null,
    implements: [],
    decorators: [],
    methods: [],
    properties: [],
    isExported: true,
    line,
    endLine,
  };
  stubs.set(name, stub);
  return stub;
}

/**
 * A declaration's head — from line `i` up to the `{` that opens its body (or
 * a `;`), joined across lines, so a wrapped `where` clause is included.
 */
function declarationHead(lines: string[], i: number): string {
  let text = "";
  for (let j = i; j < Math.min(lines.length, i + 10); j++) {
    const line = lines[j]!.replace(/\/\/.*$/, "");
    let angle = 0;
    for (let k = 0; k < line.length; k++) {
      const c = line[k]!;
      if (c === "<") angle++;
      else if (c === ">" && line[k - 1] !== "-" && line[k - 1] !== "=") angle = Math.max(0, angle - 1);
      else if ((c === "{" || c === ";") && angle === 0) return text + line.slice(0, k);
    }
    text += line + " ";
  }
  return text;
}

interface ImplHead { type: string; trait: string | null; bounds: Map<string, string> }

/** `impl<R: Repo> Trait<X> for Svc<R> where R: Send` → type `Svc`, trait `Trait<X>`, bounds. */
function parseImplHead(head: string): ImplHead | null {
  let rest = head.replace(IMPL_RE, "").trim();
  let generics = "";
  if (rest.startsWith("<")) {
    const close = closeAngle(rest, 0);
    if (close < 0) return null;
    generics = rest.slice(1, close);
    rest = rest.slice(close + 1).trim();
  }
  const whereAt = topLevelWord(rest, "where");
  const where = whereAt >= 0 ? rest.slice(whereAt + 5) : "";
  if (whereAt >= 0) rest = rest.slice(0, whereAt).trim();
  const forAt = topLevelWord(rest, "for");
  let trait: string | null = null;
  let self = rest;
  if (forAt >= 0) {
    trait = rest.slice(0, forAt).trim();
    self = rest.slice(forAt + 3).trim();
    if (trait.startsWith("!")) trait = null; // negative impl: implements nothing
  }
  const params = new Set(splitTopLevel(generics).map((g) => g.trim().split(/[\s:=]/)[0]!).filter(Boolean));
  const name = selfTypeName(self);
  if (!name || params.has(name)) return null; // blanket impl over a type parameter
  return { type: name, trait: trait || null, bounds: genericBounds(`<${generics}> where ${where}`) };
}

/** `&'a mut crate::svc::Svc<R>` / `dyn Trait` → `Svc` / `Trait`; null for tuples, slices, fn types. */
function selfTypeName(text: string): string | null {
  const t = text.replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, "").replace(/^dyn\s+/, "").trim();
  const path = /^((?:[A-Za-z_]\w*::)*[A-Za-z_]\w*)/.exec(t);
  if (!path || path[1]!.length === 0) return null;
  return path[1]!.split("::").pop()!;
}

function closeAngle(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "<") depth++;
    else if (text[i] === ">" && text[i - 1] !== "-" && --depth === 0) return i;
  }
  return -1;
}

/** Index of `word` as a whole word outside `<…>`/`(…)`, or -1. */
function topLevelWord(text: string, word: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "<" || c === "(" || c === "[") depth++;
    else if ((c === ">" && text[i - 1] !== "-") || c === ")" || c === "]") depth--;
    else if (depth === 0 && text.startsWith(word, i) && !/\w/.test(text[i - 1] ?? "") && !/\w/.test(text[i + word.length] ?? "")) return i;
  }
  return -1;
}

/** Bounds every generic in a `<…>` list or `where` clause carries in `head`. */
function genericBounds(head: string): Map<string, string> {
  const raw = new Map<string, string[]>();
  const add = (param: string, bound: string) => {
    if (!/^[A-Z]\w*$/.test(param)) return;
    let list = raw.get(param);
    if (!list) raw.set(param, (list = []));
    list.push(...splitBounds(bound));
  };
  const open = head.indexOf("<");
  const whereAt = topLevelWord(head, "where");
  if (open >= 0 && (whereAt < 0 || open < whereAt)) {
    const close = closeAngle(head, open);
    if (close > open) {
      for (const g of splitTopLevel(head.slice(open + 1, close))) {
        const m = /^\s*([A-Za-z_]\w*)\s*:(?!:)\s*(.+)$/s.exec(g);
        if (m && !/^\s*const\b/.test(g)) add(m[1]!, m[2]!);
        else if (/^\s*[A-Z]\w*\s*$/.test(g)) add(g.trim(), "");
      }
    }
  }
  if (whereAt >= 0) {
    for (const clause of splitTopLevel(head.slice(whereAt + 5))) {
      const m = /^\s*([A-Za-z_]\w*)\s*:(?!:)\s*(.+)$/s.exec(clause);
      if (m) add(m[1]!, m[2]!);
    }
  }
  const out = new Map<string, string>();
  for (const [param, bounds] of raw) {
    const traits = [...new Set(bounds)].filter((b) => !MARKER_BOUNDS.has(b.replace(/<.*$/s, "").split("::").pop()!));
    if (traits.length === 1) out.set(param, traits[0]!);
  }
  return out;
}

function splitBounds(bound: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= bound.length; i++) {
    const c = bound[i];
    if (c === "<" || c === "(") depth++;
    else if ((c === ">" && bound[i - 1] !== "-") || c === ")") depth--;
    else if ((c === "+" && depth === 0) || i === bound.length) {
      const b = bound.slice(start, i).trim().replace(/^\?/, "");
      if (b && !b.startsWith("'")) out.push(b);
      start = i + 1;
    }
  }
  return out;
}

/** Bounds that say what a type IS able to do in general, never which methods a call reaches. */
const MARKER_BOUNDS: ReadonlySet<string> = new Set([
  "Send", "Sync", "Sized", "Unpin", "Copy", "Clone", "Debug", "Display", "Default",
  "PartialEq", "Eq", "PartialOrd", "Ord", "Hash", "Serialize", "Deserialize",
]);

/** `type` with every bounded generic parameter replaced by its bound, and `Self` by the impl type. */
function substitute(type: string, bounds: ReadonlyMap<string, string>, selfType: string | null = null): string {
  return type.replace(/(?<![\w:.])([A-Z]\w*)(?![\w:])/g, (m, name: string) => {
    if (name === "Self") return selfType ?? m;
    return bounds.get(name) ?? m;
  });
}

/** Resolve generic parameters and `Self` in a function's parameter and local types. */
function resolveGenerics(fn: FunctionInfo, lines: string[], outer: ReadonlyMap<string, string>, selfType: string | null): void {
  const own = genericBounds(fnHead(lines, fn));
  const bounds = own.size > 0 ? new Map([...outer, ...own]) : outer;
  if (bounds.size === 0 && !selfType) return;
  for (const p of fn.params) if (p.type) p.type = substitute(p.type, bounds, selfType);
  for (const l of fn.localTypes ?? []) l.type = substitute(l.type, bounds, selfType);
}

/**
 * The part of a function's head that declares generics: the `<…>` list right
 * after its name and its `where` clause (a `<` inside the parameter list or
 * the return type is not a generic list).
 */
function fnHead(lines: string[], fn: FunctionInfo): string {
  const head = declarationHead(lines, fn.line - 1);
  const at = head.search(new RegExp(`\\bfn\\s+${fn.name}\\b`));
  if (at < 0) return "";
  const after = head.slice(at).replace(/^fn\s+\w+\s*/, "");
  if (after.startsWith("<")) return after;
  const whereAt = topLevelWord(after, "where");
  return whereAt >= 0 ? after.slice(whereAt) : "";
}

/** Fields of a struct whose body is on its declaration line: `struct S { repo: PgRepo, n: u8 }`. */
function readInlineFields(line: string, cls: ClassInfo, spec: RegexLangSpec): void {
  const open = line.indexOf("{");
  const close = line.lastIndexOf("}");
  if (open < 0 || close <= open) return;
  for (const part of splitTopLevel(line.slice(open + 1, close))) {
    for (const pp of spec.propertyPatterns ?? []) {
      const text = ` ${part.trim()}`;
      const m = text.match(pp.pattern);
      const prop = m ? pp.build(m, text) : null;
      if (prop) { cls.properties.push(prop); break; }
    }
  }
}
