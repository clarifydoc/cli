import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import {
  blankStringLiterals,
  extractClassesWithSpec,
  extractParamsFromDeclaration,
  isControlFlowKeyword,
  type RegexLangSpec,
} from "../shared/regex-base.js";
import { stripAngleGroups } from "../shared/path-utils.js";

/**
 * What may stand between `class` and the class's name: an all-caps export macro (`CLUB_API`, `Q_DECL_EXPORT`),
 * `__declspec(…)`, `__attribute__((…))`, `alignas(…)`, `[[…]]` — each only when a name follows it, so `class URL {`
 * is still `URL`.
 */
const CLASS_ATTRIBUTES = String.raw`(?:(?:[A-Z][A-Z0-9_]+(?:\s*\([^()]*\))?|__declspec\s*\([^()]*\)|__attribute__\s*\(\((?:[^()]|\([^()]*\))*\)\)|alignas\s*\([^()]*\)|\[\[[^\]]*\]\])\s+(?=[A-Za-z_]\w*\s*(?:final\b|[:{;]|$)))*`;

/** A `class` or `struct` head. An export or attribute macro may stand before the name: `class CLUB_API Kit {`, `struct __declspec(dllexport) Car`. */
export const CLASS_PATTERN = new RegExp(String.raw`^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+${CLASS_ATTRIBUTES}([A-Za-z_]\w*)(?:\s*:\s*(?:public|private|protected)?\s*([\w:]+))?\s*\{?`);

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
export function extractCppClasses(sourceLines: string[], fns: FunctionInfo[], spec: RegexLangSpec): ClassInfo[] {
  // `namespace league { struct Club { … }; }` on one line: the class pass reads the line without its wrapper.
  const { lines, opened } = unwrapOneLineNamespaces(sourceLines);
  // `class Slice;` only says a class exists: its declaration is the header defining it, which a forward declaration
  // in every header that names it must not stand in for.
  const classes = extractClassesWithSpec(lines, spec).filter((cls) => !FORWARD_DECLARATION.test(lines[cls.line - 1] ?? "") && !USES_A_TYPE.test(lines[cls.line - 1] ?? ""));
  for (const cls of classes) addPureVirtualMethods(lines, cls, spec);

  const namespaces = declaredNamespaces(sourceLines);
  const anonymousAt: boolean[] = [];
  const nsAt = namespacesByLine(sourceLines, anonymousAt);
  for (const [row, names] of opened) {
    nsAt[row] = joinNamespaces(nsAt[row], names);
    if (names.includes("")) anonymousAt[row] = true;
  }
  qualifyNestedClasses(lines, classes, namespaces, nsAt);
  for (const cls of classes) {
    const head = lines[cls.line - 1] ?? "";
    if (cls.kind === "enum" || /\b(?:enum|typedef)\b/.test(head)) {
      // The class pattern leaves its bases to this pass; a head this pass skips keeps what its own line says.
      if (cls.kind !== "enum" && CLASS_PATTERN.test(head)) {
        const own = cppBases([head], 0);
        cls.extends = own.extends;
        cls.implements = own.implements;
      }
      continue;
    }
    const bases = cppBases(lines, cls.line - 1);
    cls.extends = bases.extends;
    cls.implements = bases.implements;
  }
  const declared = new Map<string, ClassInfo>();
  for (const cls of classes) if (!declared.has(cls.name)) declared.set(cls.name, cls);
  const stubs = new Map<string, ClassInfo>();

  for (const fn of fns) {
    const ns = nsAt[fn.line - 1];
    if (ns) fn.namespace = ns;
  }
  for (const fn of fns) {
    const path = outOfLineOwner(lines[fn.line - 1] ?? "", fn.name);
    if (!path) continue;
    // `league::Paddock::Iterator::Next`: the namespaces in front name no class.
    const segments = path.split("::");
    const scopes: string[] = [];
    while (segments.length > 0 && (namespaces.has(segments[0]!) || (/^[a-z_]/.test(segments[0]!) && !declared.has(segments[0]!))) && segments.length > 1) scopes.push(segments.shift()!);
    const owner = segments.join("::");
    const last = segments.at(-1)!;
    // The namespace the class is a member of: the one the definition sits in, then the ones its name is written through.
    const namespace = [nsAt[fn.line - 1], ...scopes].filter(Boolean).join("::") || undefined;
    const named = declared.get(owner);
    // The file's own class of that name, unless it is plainly another namespace's (one inside an anonymous
    // namespace has none to compare).
    const own = named && (!named.namespace || !namespace || named.namespace === namespace) ? named : undefined;
    const isClass = own !== undefined || fn.name === last || fn.name === `~${last}` ||
      (/^[A-Z]/.test(last) && !namespaces.has(last));
    if (!isClass) {
      // `std::string league::util::to_hex(int x) {`: a free function of that namespace.
      if (path.split("::").every((seg) => /^[a-z_]/.test(seg) && !declared.has(seg))) fn.namespace = [fn.namespace, path].filter(Boolean).join("::");
      continue;
    }
    // A body inside the class's own braces is already one of its methods.
    if (own && fn.line > own.line && fn.line <= own.endLine) continue;
    const target = own ?? stubs.get(`${namespace ?? ""}\0${owner}`) ?? newStub(owner, namespace, fn, stubs);
    target.methods.push(fn);
    // A stub spans its definitions — unless a free function sits between them (`static void Release(…)`
    // among `Table::` bodies): a span over it would make it one of the class's methods.
    if (target !== own && !fns.some((g) => g.line > target.endLine && g.line < fn.line && !outOfLineOwner(lines[g.line - 1] ?? "", g.name))) {
      target.endLine = Math.max(target.endLine, fn.endLine);
    }
  }
  const all = [...classes, ...stubs.values()].sort((a, b) => a.line - b.line);
  // A class inside an anonymous namespace has internal linkage: no other file's `Worker` is it.
  for (const cls of all) if (anonymousAt[cls.line - 1]) cls.fileLocal = true;
  nameTwinsByPath([...stubs.values()]);
  scopeNestedTypeNames(all, fns, lines);
  untypeTemplateParameters(all, fns, lines);
  return all;
}

/** The type-parameter names of a template head's `<…>` text: `class Player, typename... Ts, int N` → Player, Ts. */
export function templateParameterNames(params: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const c of params) {
    if (c === "<" || c === "(") depth++;
    else if ((c === ">" || c === ")") && depth > 0) depth--;
    if (c === "," && depth === 0) { parts.push(current); current = ""; } else current += c;
  }
  parts.push(current);
  // Only the name each parameter declares — never a `class X` inside a default argument; a template template parameter's own head is skipped.
  return parts.flatMap((part) => {
    const m = /^\s*(?:template\s*<(?:[^<>]|<[^<>]*>)*>\s*)?(?:typename|class)\s*(?:\.\.\.)?\s*(\w+)/.exec(part);
    return m ? [m[1]!] : [];
  });
}

/** The wrappers a type passes through to what it holds: a pointer's pointee, a container's element, a pair's members. */
const TRANSPARENT_WRAPPER = /^(?:::)?(?:std::)?(?:unique_ptr|shared_ptr|weak_ptr|optional|vector|list|deque|array|set|multiset|unordered_set|initializer_list|reference_wrapper|atomic|map|multimap|unordered_map|pair|tuple|queue|stack|priority_queue|forward_list|variant)$|^(?:::)?std::span$/;

/**
 * Whether a type IS a template parameter, or reaches one through a transparent wrapper: judged on the type's head
 * (`const T&`, `T*`, `T::value_type`, `unique_ptr<T>`, `vector<T>`), never on a mere mention — `Fixture<T>` and
 * `Table<K, V>` are classes of the project, and a call on one is a call on that class.
 */
export function namesTemplateParameter(type: string, names: readonly string[], declaresClass?: (name: string) => boolean): boolean {
  const t = type.replace(/\b(?:const|volatile|typename|struct|class)\b/g, " ").replace(/[&*]+|\.\.\.|\[[^\]]*\]/g, " ").trim();
  const open = t.indexOf("<");
  const head = (open < 0 ? t : t.slice(0, open)).replace(/\s+/g, "");
  // `Ledger<M>::Row`: a name written after a template-argument list that mentions a parameter depends on it
  // (the specialization may declare anything under that name), whatever class `Ledger` is.
  if (open >= 0) {
    let depth = 0;
    for (let i = open; i < t.length; i++) {
      if (t[i] === "<") depth++;
      else if (t[i] === ">" && --depth === 0) {
        if (/^\s*::\s*\w/.test(t.slice(i + 1)) && names.some((n) => new RegExp(String.raw`(?<![\w:.])${n}(?!\w)`).test(t.slice(open, i)))) return true;
        break;
      }
    }
  }
  // A wrapper's name the file declares as its own class (`template<class T> struct queue`) is that class, not the standard one.
  if (open >= 0 && TRANSPARENT_WRAPPER.test(head) && !declaresClass?.(head.replace(/^::/, "").split("::").pop()!)) {
    let depth = 0;
    let current = "";
    const args: string[] = [];
    for (let i = open + 1; i < t.length; i++) {
      const c = t[i]!;
      if (c === "<" || c === "(") depth++;
      else if ((c === ">" || c === ")") && depth-- === 0) break;
      if (c === "," && depth === 0) { args.push(current); current = ""; } else current += c;
    }
    args.push(current);
    return args.some((a) => namesTemplateParameter(a, names, declaresClass));
  }
  return names.includes(head.replace(/^::/, "").split("::")[0]!);
}

/**
 * The `Class::Member` types a text writes through template arguments that mention a parameter
 * (`typename Ledger<M>::Row`): parameter and local types are kept without the arguments (`Ledger::Row`), so the
 * dependent ones are found here, in the text they were read from.
 */
function dependentTypes(text: string, names: readonly string[], ownerName?: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![\w:.])(?:[A-Za-z_]\w*\s*::\s*)*([A-Za-z_]\w*)\s*<((?:[^<>;{}()]|<[^<>;{}()]*>)*)>\s*::\s*([A-Za-z_]\w*)/g)) {
    // The class's own name with its own parameters (`Squad<K, C>::Slot` inside `Squad<K, C>::Find`, or in its
    // body) is the class being defined: its nested types are not dependent.
    const own = m[1] === ownerName || (m[2]!.replace(/\s+/g, "") === names.join(",") && new RegExp(String.raw`(?<![\w:.])${m[1]}\s*<[^;{}()]*>\s*::\s*~?\w+\s*\(`).test(text));
    if (m[1] !== "template" && !own && names.some((n) => new RegExp(String.raw`(?<![\w:.])${n}(?!\w)`).test(m[2]!))) found.add(`${m[1]}::${m[3]}`);
  }
  return found;
}

/** `typename Ledger::Row*` → `Ledger::Row`: the class and the name under it, as `dependentTypes` writes them. */
function scopedTail(type: string): string {
  return type.replace(/\b(?:const|volatile|typename|struct|class)\b|[&*\s]/g, "").split("::").slice(-2).join("::");
}

/** The template heads a file writes: where each ends, and the type parameters it binds. */
interface TemplateHead { line: number; endLine: number; rest: string; names: string[] }

function templateHeads(lines: readonly string[]): TemplateHead[] {
  const heads: TemplateHead[] = [];
  for (let i = 0; i < lines.length; i++) {
    const start = /^\s*(?:export\s+)?template\s*</.exec(lines[i]!);
    if (!start) continue;
    let depth = 0;
    // A `>` inside parentheses compares (`int N = (A > B)`); it never closes the head.
    let parens = 0;
    let text = "";
    for (let k = i; k < Math.min(lines.length, i + 16); k++) {
      const line = k === i ? lines[k]!.slice(start[0].length - 1) : lines[k]!;
      let closed = -1;
      for (let c = 0; c < line.length && closed < 0; c++) {
        if (line[c] === "(") parens++;
        else if (line[c] === ")") parens = Math.max(0, parens - 1);
        else if (parens > 0) continue;
        else if (line[c] === "<") depth++;
        else if (line[c] === ">" && line[c - 1] !== "-" && --depth === 0) closed = c;
      }
      if (closed < 0) {
        text += line.replace(/\/\/.*$/, "") + " ";
        continue;
      }
      text += line.slice(0, closed + 1);
      const names = templateParameterNames(text.slice(1, -1));
      if (names.length > 0) heads.push({ line: i + 1, endLine: k + 1, rest: line.slice(closed + 1), names });
      i = k;
      break;
    }
  }
  return heads;
}

/**
 * A template's type parameters are no classes: in `template<class Player> void Run(Player& x)` or
 * `template<class T> struct Box { void f(T& t); }` (and `template<class T> void Box<T>::f(T& t)`) the name stands
 * for whatever the caller passes, never for a class of the file or the project that happens to share it. A
 * parameter, local, return type or field whose type names one is left untyped, in the function the head
 * precedes and in every function and field of the class it precedes. An explicit specialization
 * (`template<> void Run<Player>(Player& x)`) binds nothing, and a name the head does not bind stays a class.
 */
function untypeTemplateParameters(classes: readonly ClassInfo[], fns: readonly FunctionInfo[], lines: readonly string[]): void {
  const heads = templateHeads(lines);
  if (heads.length === 0) return;
  const declaresClass = (name: string): boolean => classes.some((c) => c.name === name);
  const all = [...new Set([...fns, ...classes.flatMap((c) => c.methods)])].sort((a, b) => a.line - b.line);
  const bodies = [...classes].sort((a, b) => a.line - b.line);
  // Nothing but the declaration's own words stands between a head and what it binds: no `;`, `{` or `}`.
  const bound = (head: TemplateHead, line: number, stop: RegExp): boolean => {
    let text = head.endLine === line ? "" : head.rest + " ";
    for (let k = head.endLine; k < line - 1; k++) text += lines[k]! + " ";
    const at = head.endLine === line ? head.rest : lines[line - 1] ?? "";
    const cut = at.search(stop);
    text += cut < 0 ? at : at.slice(0, cut);
    return !/[;{}]/.test(text.replace(/\/\/.*$/gm, ""));
  };
  // What the head's names type becomes untyped, and the call on it an unknown type's: the linker's unique-name guess
  // must not pick the namesake class's member either.
  const untype = (names: readonly string[], fn: FunctionInfo, fields: readonly string[] = [], scopeText = ""): void => {
    const dependent = dependentTypes(`${scopeText}\n${lines.slice(fn.line - 1, Math.max(fn.line, fn.endLine)).join("\n")}`, names);
    const word = { test: (type: string) => namesTemplateParameter(type, names, declaresClass) || (dependent.size > 0 && dependent.has(scopedTail(type))) };
    const untyped = new Set(fn.untypedLocals);
    for (const p of fn.params) {
      if (p.type && word.test(p.type)) {
        p.type = null;
        untyped.add(p.name);
      }
    }
    if (fn.returnType && word.test(fn.returnType)) fn.returnType = null;
    for (const l of fn.localTypes ?? []) {
      if (l.type && word.test(l.type)) {
        l.type = "";
        untyped.add(l.name);
      }
    }
    // A field of the class template the function does not shadow.
    for (const f of fields) if (!fn.params.some((p) => p.name === f) && !(fn.localTypes ?? []).some((l) => l.name === f)) untyped.add(f);
    if (untyped.size > (fn.untypedLocals?.length ?? 0)) fn.untypedLocals = [...untyped];
  };
  for (const head of heads) {
    const owner = bodies.find((c) => c.line >= head.endLine && /\b(?:class|struct)\b/.test(lines[c.line - 1] ?? "") && bound(head, c.line, /\b(?:class|struct)\b/));
    if (owner) {
      const bodyText = lines.slice(owner.line - 1, owner.endLine).join("\n");
      const dependent = dependentTypes(bodyText, head.names, owner.name);
      const word = { test: (type: string) => namesTemplateParameter(type, head.names, declaresClass) || (dependent.size > 0 && dependent.has(scopedTail(type))) };
      const fields: string[] = [];
      for (const c of bodies) {
        if (c.line < head.line || c.line > owner.endLine) continue;
        for (const prop of c.properties) {
          if (prop.type && word.test(prop.type)) {
            prop.type = null;
            fields.push(prop.name);
          }
        }
      }
      // A one-line body states its fields on no line of their own: read `T value;` off the text between members.
      const text = lines.slice(owner.line - 1, owner.endLine).join("\n");
      for (const m of text.matchAll(new RegExp(String.raw`(?<![\w:])(?:${head.names.join("|")})(?:\s*<[^;{}()]*>)?[\s*&]+(\w+)\s*(?:;|=[^;(){}]*;)`, "g"))) fields.push(m[1]!);
      for (const fn of all) if (fn.line >= head.line && fn.line <= owner.endLine) untype(head.names, fn, fields, bodyText);
      continue;
    }
    const fn = all.find((f) => f.line >= head.endLine);
    if (fn && bound(head, fn.line, /\(/)) untype(head.names, fn);
  }
}

/**
 * `namespace league { struct Club { void Play() {} }; }` written on one line: the class patterns are anchored at the
 * line's start, so the line is read without its `namespace x {` openers and the `}` that close them (blanked, so
 * every column stays), and `opened` says which namespaces enclose what is left (by 0-based row; an anonymous one is
 * the empty name).
 */
function unwrapOneLineNamespaces(source: readonly string[]): { lines: string[]; opened: Map<number, string[]> } {
  const opened = new Map<number, string[]>();
  let lines: string[] | undefined;
  for (let i = 0; i < source.length; i++) {
    let line = source[i]!;
    if (!line.includes("namespace")) continue;
    const names: string[] = [];
    for (let m: RegExpExecArray | null; (m = /^\s*(?:inline\s+)?namespace\s*([A-Za-z_][\w:]*)?\s*\{(?=\s*[^\s}])/.exec(line)); ) {
      names.push(m[1] ?? "");
      line = " ".repeat(m[0].length) + line.slice(m[0].length);
    }
    if (names.length === 0) continue;
    // Each opener's `}` is the one the rest of the line leaves unmatched.
    const code = blankStringLiterals(line, ["//"]);
    let depth = 0;
    let unmatched = 0;
    const chars = line.split("");
    for (let k = 0; k < code.length && unmatched < names.length; k++) {
      if (code[k] === "{") depth++;
      else if (code[k] === "}") {
        if (depth > 0) depth--;
        else { chars[k] = " "; unmatched++; }
      }
    }
    lines ??= [...source];
    lines[i] = chars.join("");
    opened.set(i, names);
  }
  return { lines: lines ?? (source as string[]), opened };
}

/** The namespace `outer` (the one at the line's start) and the one-line wrappers `names` make together. */
function joinNamespaces(outer: string | undefined, names: readonly string[]): string | undefined {
  if (names.includes("")) return undefined;
  const all = [...(outer ? outer.split("::") : []), ...names.flatMap((n) => n.split("::"))];
  return all.length > 0 && all[0] !== "std" ? all.join("::") : undefined;
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

function newStub(name: string, namespace: string | undefined, first: FunctionInfo, stubs: Map<string, ClassInfo>): ClassInfo {
  const stub: ClassInfo = {
    name,
    ...(namespace ? { namespace } : {}),
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
  stubs.set(`${namespace ?? ""}\0${name}`, stub);
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


/**
 * Every base of a class head, read from its header line and the lines a wrapped head continues over, up to the
 * `{` (never into the body): `class Sedan : public Chassis, protected virtual Tyre<int>, Plugin {`. Access keywords,
 * `virtual` and template arguments are dropped, a base that is the class template's own parameter (`template <class T>
 * class Crtp : public T`) names no class. The first is `extends`; the others are `implements`, as a Python class's
 * bases are. A protoc server base keeps its qualifier in `implements` — it names the service.
 */
export function cppBases(lines: readonly string[], index: number): { extends: string | null; implements: string[] } {
  let text = (lines[index] ?? "").replace(/\/\/.*$/, "");
  for (let k = 1; k < 8 && !/[{;]/.test(text) && index + k < lines.length; k++) text += " " + lines[index + k]!.replace(/\/\/.*$/, "");
  const end = text.search(/[{;]/);
  if (end >= 0) text = text.slice(0, end);
  // No colon, no base clause: skip the template and keyword reading.
  if (!text.includes(":")) return { extends: null, implements: [] };
  // A class template's parameter list may stand on the line above.
  if (index > 0 && /^\s*template\b[^;{]*>\s*$/.test(lines[index - 1] ?? "")) text = lines[index - 1]! + " " + text;
  const header = /^\s*template\s*<((?:[^<>]|<[^<>]*>)*)>/.exec(text);
  const templateParams = new Set([...(header?.[1] ?? "").matchAll(/(?:typename|class|\bint|\bbool|\bsize_t)\s*(?:\.\.\.)?\s*(\w+)/g)].map((m) => m[1]!));
  const keyword = /\b(?:class|struct)\b/.exec(text.slice(header?.[0].length ?? 0));
  if (!keyword) return { extends: null, implements: [] };
  const after = text.slice((header?.[0].length ?? 0) + keyword.index + keyword[0].length);
  let depth = 0;
  let colon = -1;
  for (let i = 0; i < after.length && colon < 0; i++) {
    const c = after[i]!;
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0) {
      if (after[i + 1] === ":") i++;
      else colon = i;
    }
  }
  if (colon < 0) return { extends: null, implements: [] };
  const clause = after.slice(colon + 1);
  const parts: string[] = [];
  let current = "";
  depth = 0;
  for (const c of clause) {
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth = Math.max(0, depth - 1);
    if (c === "," && depth === 0) { parts.push(current); current = ""; } else current += c;
  }
  parts.push(current);
  const bases: string[] = [];
  const services: string[] = [];
  for (const part of parts) {
    let p = part.replace(/\b(?:public|private|protected|virtual)\b/g, " ").replace(/\.\.\./g, " ").trim();
    p = stripAngleGroups(p);
    const name = /^(?:::)?((?:\w+\s*::\s*)*\w+)\s*$/.exec(p)?.[1]?.replace(/\s+/g, "");
    if (!name || templateParams.has(name)) continue;
    const leaf = name.replace(/.*::/, "");
    bases.push(leaf);
    if (name.endsWith("::Service")) services.push(name);
  }
  const rest = bases.slice(1).filter((b) => b !== bases[0]);
  return { extends: bases[0] ?? null, implements: [...new Set([...services, ...rest])] };
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
function qualifyNestedClasses(
  lines: readonly string[],
  classes: ClassInfo[],
  namespaces: ReadonlySet<string>,
  nsAt: ReadonlyArray<string | undefined>,
): void {
  const byLine = [...classes].sort((a, b) => a.line - b.line || b.endLine - a.endLine);
  for (const cls of byLine) {
    // `namespace Home { class Club {…} }` is `Club` of namespace `Home`: another namespace's `Club` is another class.
    const ns = nsAt[cls.line - 1];
    if (ns) cls.namespace = ns;
    const head = QUALIFIED_CLASS_HEAD.exec(lines[cls.line - 1] ?? "");
    if (head) {
      const outer = head[1]!.split("::").map((s) => s.replace(/<.*$/s, "").trim()).filter(Boolean);
      const scopes: string[] = [];
      while (outer.length > 0 && (namespaces.has(outer[0]!) || /^[a-z_]/.test(outer[0]!))) scopes.push(outer.shift()!);
      if (scopes.length > 0) cls.namespace = [ns, ...scopes].filter(Boolean).join("::");
      cls.name = [...outer, head[2]!].join("::");
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
  // One file, two classes of one name in different namespaces (`namespace Home { class Club … } namespace Away { class
  // Club … }`): the linker keys a class by file and name, so each is named by its path, `Home::Club`.
  nameTwinsByPath(classes);
}

/**
 * Classes of one name in different namespaces of one file, each named by its path (`Home::Club`). Run over the
 * header's declarations and over the stubs a source file's out-of-line definitions make, so a header and the file
 * defining its methods name a class alike when both hold the twins.
 */
function nameTwinsByPath(classes: readonly ClassInfo[]): void {
  const byName = new Map<string, ClassInfo[]>();
  for (const cls of classes) (byName.get(cls.name) ?? byName.set(cls.name, []).get(cls.name)!).push(cls);
  for (const same of byName.values()) {
    if (same.length < 2 || new Set(same.map((c) => c.namespace ?? "")).size < 2) continue;
    for (const cls of same) if (cls.namespace) cls.name = `${cls.namespace}::${cls.name}`;
  }
}

/**
 * A line that names a struct as the TYPE of something and declares no type: a prototype returning a pointer
 * (`struct car *car_new(int wheels);`), a function returning one by value, a variable (`struct car spare;`).
 */
const USES_A_TYPE = /^\s*(?:class|struct)\s+[A-Za-z_]\w*\s*(?:[*&]|\s[A-Za-z_]\w*\s*[(;=[,)])/;

/** `class Slice;`, `struct CLUB_API Car;`, `template <typename T> class Box;` — a declaration with no body. */
const FORWARD_DECLARATION = /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:[A-Za-z_][\w()"\s]*\s)?[A-Za-z_]\w*\s*;\s*(?:\/\/.*)?$/;

/**
 * The named namespace each line sits in, `league::util` for a line inside `namespace league { namespace util {`
 * (or `namespace league::util {`), `undefined` outside any. An anonymous namespace's functions are the file's own:
 * their lines name none, so no other file reaches them by a namespace; `anonymous`, when given, is filled with the
 * lines inside one. `std` is no project namespace.
 */
export function namespacesByLine(lines: readonly string[], anonymous?: boolean[]): Array<string | undefined> {
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
    if (anonymous && stack.includes("")) anonymous[i] = true;
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
