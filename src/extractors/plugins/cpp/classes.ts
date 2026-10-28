import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import {
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
  const classes = extractClassesWithSpec(lines, spec);
  for (const cls of classes) addPureVirtualMethods(lines, cls, spec);

  const namespaces = declaredNamespaces(lines);
  const declared = new Map<string, ClassInfo>();
  for (const cls of classes) if (!declared.has(cls.name)) declared.set(cls.name, cls);
  const stubs = new Map<string, ClassInfo>();

  for (const fn of fns) {
    const owner = outOfLineOwner(lines[fn.line - 1] ?? "", fn.name);
    if (!owner) continue;
    const own = declared.get(owner);
    const isClass = own !== undefined || fn.name === owner || fn.name === `~${owner}` ||
      (/^[A-Z]/.test(owner) && !namespaces.has(owner));
    if (!isClass) continue;
    // A body inside the class's own braces is already one of its methods.
    if (own && fn.line > own.line && fn.line <= own.endLine) continue;
    const target = own ?? stubs.get(owner) ?? newStub(owner, fn, stubs);
    target.methods.push(fn);
    if (target !== own) target.endLine = Math.max(target.endLine, fn.endLine);
  }
  return [...classes, ...stubs.values()].sort((a, b) => a.line - b.line);
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
  };
  stubs.set(name, stub);
  return stub;
}

/**
 * The class qualifying the definition of `name` on its declaration line —
 * `User` in `std::string User::displayName() const {`, `Inner` in
 * `Outer::Inner::run(`, `Stack` in `Stack<T>::push(` — or null for a plain
 * function.
 */
export function outOfLineOwner(line: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\~]/g, "\\$&");
  const m = new RegExp(`(?:^|[^\\w:])((?:[A-Za-z_]\\w*(?:<[^<>;()]*>)?\\s*::\\s*)+)${escaped}\\s*\\(`).exec(line);
  if (!m) return null;
  const segments = m[1]!.split("::").map((s) => s.replace(/<.*$/s, "").trim()).filter(Boolean);
  return segments[segments.length - 1] ?? null;
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
