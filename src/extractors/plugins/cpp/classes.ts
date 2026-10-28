import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import {
  blankStringLiterals,
  extractClassesWithSpec,
  extractParamsFromDeclaration,
  isControlFlowKeyword,
  type RegexLangSpec,
} from "../shared/regex-base.js";

/**
 * C++ classes as the linker needs them: a method belongs to its class wherever
 * its body is written.
 *
 * - A definition outside the class body (`std::string User::displayName() const {`
 *   in User.cpp) is attached to a ClassInfo for `User` in THAT file — the
 *   class's own ClassInfo when the file declares it, else a stub carrying only
 *   the file's definitions. Core finds `User.displayName` beside the header's
 *   class (same directory, or a file of the sub-project declaring the same
 *   class) and merges a stub's members with the declaration's. Without this
 *   the definition was a free function `displayName`, so two classes' bodies
 *   collided by name and a call through a `const User&` reached neither.
 * - A pure virtual declaration (`virtual Repo* find(int id) = 0;`) is the only
 *   body that method has: it becomes a method of the class (name + line, no
 *   calls). Other body-less declarations are NOT methods here — their
 *   definition lives in a .cpp, and a header declaration of the same
 *   `Class.method` would be found first and take the call away from it.
 *
 * Owners of out-of-line definitions are only trusted when they can be told
 * from a namespace (`void app::helper() {` defines a FREE function): a class
 * declared in the file, a constructor/destructor (`X::X`, `X::~X`), or a
 * capitalized name the file does not open as a namespace.
 */
export function extractCppClasses(lines: string[], fns: FunctionInfo[], spec: RegexLangSpec): ClassInfo[] {
  // `class Slice;` only says a class exists: its declaration is the header defining it, which a forward declaration
  // in every header that names it must not stand in for.
  const classes = extractClassesWithSpec(lines, spec).filter((cls) => !FORWARD_DECLARATION.test(lines[cls.line - 1] ?? ""));
  for (const cls of classes) addPureVirtualMethods(lines, cls, spec);

  const namespaces = declaredNamespaces(lines);
  qualifyNestedClasses(lines, classes, namespaces);
  const declared = new Map<string, ClassInfo>();
  for (const cls of classes) if (!declared.has(cls.name)) declared.set(cls.name, cls);
  const stubs = new Map<string, ClassInfo>();

  const nsAt = namespacesByLine(lines);
  for (const fn of fns) {
    const ns = nsAt[fn.line - 1];
    if (ns) fn.namespace = ns;
  }
  for (const fn of fns) {
    const path = outOfLineOwner(lines[fn.line - 1] ?? "", fn.name);
    if (!path) continue;
    // `league::Paddock::Iterator::Next`: the namespaces in front name no class.
    const segments = path.split("::");
    while (segments.length > 0 && (namespaces.has(segments[0]!) || (/^[a-z_]/.test(segments[0]!) && !declared.has(segments[0]!))) && segments.length > 1) segments.shift();
    const owner = segments.join("::");
    const last = segments.at(-1)!;
    const own = declared.get(owner);
    const isClass = own !== undefined || fn.name === last || fn.name === `~${last}` ||
      (/^[A-Z]/.test(last) && !namespaces.has(last));
    if (!isClass) {
      // `std::string league::util::to_hex(int x) {`: a free function of that namespace.
      if (path.split("::").every((seg) => /^[a-z_]/.test(seg) && !declared.has(seg))) fn.namespace = [fn.namespace, path].filter(Boolean).join("::");
      continue;
    }
    // A body inside the class's own braces is already one of its methods.
    if (own && fn.line > own.line && fn.line <= own.endLine) continue;
    const target = own ?? stubs.get(owner) ?? newStub(owner, fn, stubs);
    target.methods.push(fn);
    // A stub spans its definitions — unless a free function sits between them (`static void Release(…)`
    // among `Table::` bodies): a span over it would make it one of the class's methods.
    if (target !== own && !fns.some((g) => g.line > target.endLine && g.line < fn.line && !outOfLineOwner(lines[g.line - 1] ?? "", g.name))) {
      target.endLine = Math.max(target.endLine, fn.endLine);
    }
  }
  const all = [...classes, ...stubs.values()].sort((a, b) => a.line - b.line);
  scopeNestedTypeNames(all, fns, lines);
  return all;
}

/**
 * Inside `Paddock` (its body or an out-of-line `Paddock::Insert`), a type written `Iterator` is the
 * nested `Paddock::Iterator` when the file declares one — as the compiler looks the name up in the
 * class first. Parameters, locals, return types and fields are rewritten so — on the class's methods
 * and on the file's functions read inside its body, which a parser's reading of them replaces.
 */
function scopeNestedTypeNames(classes: readonly ClassInfo[], fns: readonly FunctionInfo[], lines: readonly string[]): void {
  const known = new Set(classes.map((c) => c.name).filter((n) => n.includes("::")));
  if (known.size === 0) return;
  const rewrite = (owner: string, fn: FunctionInfo): void => {
    const text = lines.slice(fn.line - 1, fn.endLine).join("\n");
    for (const p of fn.params) p.type = scopedType(p.type, owner, known, text);
    fn.returnType = scopedType(fn.returnType, owner, known, text);
    for (const l of fn.localTypes ?? []) l.type = scopedType(l.type, owner, known, text) ?? l.type;
  };
  for (const cls of classes) {
    const text = lines.slice(cls.line - 1, cls.endLine).join("\n");
    for (const prop of cls.properties) prop.type = scopedType(prop.type, cls.name, known, text);
    for (const m of cls.methods) rewrite(cls.name, m);
  }
  const bodies = classes.filter((c) => !c.extension);
  for (const fn of fns) {
    let owner: ClassInfo | null = null;
    for (const c of bodies) if (c.line < fn.line && fn.endLine <= c.endLine && (!owner || c.line > owner.line)) owner = c;
    if (owner && !owner.methods.includes(fn)) rewrite(owner.name, fn);
  }
}

/**
 * `T` as class `owner` (or a class around it) sees it: its nested `owner::T` when the file declares one,
 * unless the text spells the name through a namespace (`log::Writer log(file);` is that namespace's).
 */
function scopedType(type: string | null, owner: string, known: ReadonlySet<string>, text: string): string | null {
  const m = type ? /^([A-Z]\w*)(?!\w|::)/.exec(type) : null;
  if (!m || new RegExp(String.raw`\b[a-z_]\w*\s*::\s*${m[1]}\b`).test(text)) return type;
  for (let scope = owner; scope; scope = scope.includes("::") ? scope.slice(0, scope.lastIndexOf("::")) : "") {
    const q = `${scope}::${m[1]}`;
    if (known.has(q)) return q + type!.slice(m[1]!.length);
  }
  return type;
}

function newStub(name: string, first: FunctionInfo, stubs: Map<string, ClassInfo>): ClassInfo {
  const stub: ClassInfo = {
    name,
    extends: null,
    implements: [],
    decorators: [],
    methods: [],
    properties: [],
    isExported: true,
    line: first.line,
    endLine: first.endLine,
    // The bodies of a class the file does not declare: a part of the class its header declares.
    extension: true,
  };
  stubs.set(name, stub);
  return stub;
}

/**
 * The scope qualifying the definition of `name` on its declaration line, template
 * arguments left off — `User` in `std::string User::displayName() const {`,
 * `Outer::Inner` in `Outer::Inner::run(`, `Stack` in `Stack<T>::push(` — or null
 * for a plain function. Namespaces in front stay: the caller knows which they are.
 */
export function outOfLineOwner(line: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\~]/g, "\\$&");
  const m = new RegExp(`(?:^|[^\\w:])((?:[A-Za-z_]\\w*(?:<[^<>;()]*>)?\\s*::\\s*)+)${escaped}\\s*\\(`).exec(line);
  if (!m) return null;
  const segments = m[1]!.split("::").map((s) => s.replace(/<.*$/s, "").trim()).filter(Boolean);
  return segments.length > 0 ? segments.join("::") : null;
}

/** `class Season::FixtureIterator : public Iterator {`, `struct Paddock<K, C>::Node {`: a nested class defined outside its owner. */
const QUALIFIED_CLASS_HEAD = /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:[A-Z][A-Z0-9_]+\s+)?((?:[A-Za-z_]\w*(?:\s*<[^<>{};]*>)?\s*::\s*)+)([A-Za-z_]\w*)\s*(?:final\s*)?(?::(?!:)\s*(?:virtual\s+)?(?:public|private|protected)?\s*(?:virtual\s+)?([\w:]+))?/;

/**
 * A class declared inside another is named by its path, `Paddock::Iterator`, as
 * the code outside names it — a bare `Iterator` would be every other header's
 * `Iterator` too. Read from the class's head when it says so (`class
 * Season::Helper {`), else from the class whose braces hold it. A namespace in
 * front is no class's name.
 */
function qualifyNestedClasses(lines: readonly string[], classes: ClassInfo[], namespaces: ReadonlySet<string>): void {
  const byLine = [...classes].sort((a, b) => a.line - b.line || b.endLine - a.endLine);
  for (const cls of byLine) {
    const head = QUALIFIED_CLASS_HEAD.exec(lines[cls.line - 1] ?? "");
    if (head) {
      const outer = head[1]!.split("::").map((s) => s.replace(/<.*$/s, "").trim()).filter(Boolean);
      while (outer.length > 0 && (namespaces.has(outer[0]!) || /^[a-z_]/.test(outer[0]!))) outer.shift();
      cls.name = [...outer, head[2]!].join("::");
      cls.extends = head[3] ? head[3].replace(/.*::/, "") : null;
      continue;
    }
    // The innermost class whose body holds this one (already named, being earlier).
    let holder: ClassInfo | null = null;
    for (const o of byLine) {
      if (o === cls || o.line >= cls.line || o.endLine < cls.endLine || o.kind === "enum") continue;
      if (!holder || o.line > holder.line) holder = o;
    }
    if (holder) cls.name = `${holder.name}::${cls.name}`;
  }
}

/** `class Slice;`, `struct CLUB_API Car;`, `template <typename T> class Box;` — a declaration with no body. */
const FORWARD_DECLARATION = /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:[A-Za-z_][\w()"\s]*\s)?[A-Za-z_]\w*\s*;\s*(?:\/\/.*)?$/;

/**
 * The named namespace each line sits in, `league::util` for a line inside `namespace league { namespace util {`
 * (or `namespace league::util {`), `undefined` outside any. An anonymous namespace's functions are the file's own:
 * their lines name none, so no other file reaches them by a namespace. `std` is no project namespace.
 */
export function namespacesByLine(lines: readonly string[]): Array<string | undefined> {
  const out: Array<string | undefined> = new Array(lines.length);
  if (!lines.some((l) => /\bnamespace\b/.test(l))) return out;
  const stack: Array<string | null> = [];
  let pending: string | null | undefined;
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (comment) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = " ".repeat(end + 2) + line.slice(end + 2);
      comment = false;
    }
    line = blankStringLiterals(line.replace(/\/\*.*?\*\//g, (c) => " ".repeat(c.length)), ["//"]);
    const open = line.indexOf("/*");
    if (open >= 0) { line = line.slice(0, open); comment = true; }
    const names = stack.filter((n): n is string => n !== null && n !== "");
    if (!stack.includes("")) out[i] = names.length > 0 && names[0] !== "std" ? names.join("::") : undefined;
    const head = /^\s*(?:inline\s+)?namespace\s*([A-Za-z_][\w:]*)?\s*(\{)?/.exec(line);
    let at = 0;
    if (head && !/=/.test(line)) {
      pending = head[1] ?? "";
      at = head.index + head[0].length - (head[2] ? 1 : 0);
    }
    for (let k = at; k < line.length; k++) {
      const ch = line[k];
      if (ch === "{") {
        stack.push(pending === undefined ? null : pending);
        pending = undefined;
      } else if (ch === "}") stack.pop();
      else if (ch === ";" && pending !== undefined) pending = undefined;
    }
  }
  return out;
}

/** `namespace app {` / `namespace app::detail {` — names that qualify free functions. */
export function declaredNamespaces(lines: string[]): Set<string> {
  const out = new Set<string>();
  for (const line of lines) {
    const m = /^\s*(?:inline\s+)?namespace\s+([\w:]+)/.exec(line);
    if (m) for (const seg of m[1]!.split("::")) if (seg) out.add(seg);
  }
  return out;
}

/** `virtual T name(params) [const] [noexcept] [override] = 0;` (possibly wrapped over a few lines). */
const PURE_VIRTUAL_RE =
  /^\s*virtual\s+[\w:<>,*&\s]+?[\s*&>](~?[A-Za-z_]\w*)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:noexcept(?:\s*\([^)]*\))?\s*)?(?:override\s*|final\s*)*=\s*0\s*;\s*(?:\/\/.*)?$/;

/**
 * Pure virtual member declarations at the class body's own depth — the
 * contract an abstract base declares and nobody defines. Wrapped parameter
 * lists are joined (up to six lines) before matching.
 */
function addPureVirtualMethods(lines: string[], cls: ClassInfo, spec: RegexLangSpec): void {
  const have = new Set(cls.methods.map((m) => m.name));
  let depth = 0;
  let opened = false;
  for (let i = cls.line - 1; i < Math.min(cls.endLine, lines.length); i++) {
    const line = lines[i]!;
    if (opened && depth === 1 && /^\s*virtual\b/.test(line)) {
      let text = line;
      let end = i;
      while (!/;\s*(?:\/\/.*)?$/.test(text) && end < i + 5 && end + 1 < lines.length && !text.includes("{")) {
        end++;
        text += " " + lines[end]!.trim();
      }
      const m = PURE_VIRTUAL_RE.exec(text);
      if (m && !isControlFlowKeyword(m[1]!) && !have.has(m[1]!)) {
        have.add(m[1]!);
        cls.methods.push({
          name: m[1]!,
          params: extractParamsFromDeclaration(lines, i, m[1]!, spec.parseParam),
          returnType: spec.parseReturnType?.(line.replace(/^\s*virtual\s+/, "")) ?? null,
          isAsync: false,
          isExported: true,
          decorators: [],
          calls: [],
          line: i + 1,
          endLine: end + 1,
        });
      }
    }
    for (const ch of line) {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) break;
  }
  cls.methods.sort((a, b) => a.line - b.line);
}
