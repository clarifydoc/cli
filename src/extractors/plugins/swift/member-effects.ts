import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { EffectsCollector } from "../shared/member-effects-kit.js";

const OP = String.raw`(?:<<|>>|&[-+*]|[-+*/%&|^])?`;
/** A statement that starts with an lvalue: the start of the line, after `;` or `{`, or after a closure's `in`. */
const START = String.raw`(?:^|[;{]|\bin\s)\s*`;
const END = String.raw`(?:\[[^\]\n]*\])?\s*${OP}=(?!=)`;
const SELF = String.raw`self[?!]?\.`;
const SELF_RE = new RegExp(String.raw`${START}${SELF}([A-Za-z_]\w*)${END}`, "g");
const SELF_FIELD_RE = new RegExp(String.raw`${START}${SELF}([A-Za-z_]\w*)[?!]?\.([A-Za-z_]\w*)${END}`, "g");
const NAMED_RE = new RegExp(String.raw`${START}([a-z_]\w*)[?!]?\.([A-Za-z_]\w*)${END}`, "g");
const BARE_RE = new RegExp(String.raw`${START}([A-Za-z_]\w*)${END}`, "g");
/** `throw ClubError.closed`, `throw ClubError.missing(id)`, `throw ClubClosed()`, `throw League.Failure(…)`; `throw error` and `throw .closed` name no type. */
const THROW_RE = /\bthrow\s+([A-Z]\w*(?:\.[A-Z]\w*)*)(\s*\()?(?=\.[a-z_]\w*|\s*$|\s*[;}]|(?<=\())/g;
/** The type a `throw` names: `ClubError.Closed` with no call is a case (or a static) of `ClubError`, only a construction names a nested type. */
const thrownType = (name: string, called: boolean): string => (called || !name.includes(".") ? name : name.slice(0, name.lastIndexOf(".")));
/** Swift 6 typed throws on a signature: `func load() throws(ClubError) -> Club`. */
const TYPED_THROWS_RE = /\bthrows\s*\(\s*([A-Z]\w*(?:\.[A-Z]\w*)*)\s*\)/;
/** A local the body binds (`let n = …`, `var n: Int`, `if let n`, `for n in`, a closure's `{ n in`), which a bare write then names, not a field. */
const LOCAL_RES = [
  /\b(?:let|var)\s+([A-Za-z_]\w*)/g,
  /\b(?:let|var)\s*\(([^)]*)\)/g,
  /\bfor\s+(?:case\s+(?:let|var)\s+)?([A-Za-z_]\w*)\s+in\b/g,
  /\{\s*(?:\[[^\]]*\]\s*)?\(?\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*\)?\s+in\b/g,
];
/** A stored or computed member the type's body declares at its own depth. */
const MEMBER_RE = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:private|public|internal|fileprivate|open|package)(?:\(set\))?\s+|(?:static|class|lazy|weak|unowned(?:\((?:safe|unsafe)\))?|final|override|nonisolated|dynamic)\s+)*(?:let|var)\s+([A-Za-z_]\w*)/;
const EXTENSION_RE = /^\s*(?:(?:public|package|internal|private|fileprivate)\s+)?extension\b/;
const KEYWORDS = new Set(["self", "super", "return", "throw", "try", "await", "else", "case", "let", "var", "in", "is", "as", "if", "guard", "while", "switch", "where", "default"]);

/** A function's own local names, parameters included. */
function localNames(lines: readonly string[], fn: FunctionInfo, codeAt: (ln: number) => string): Set<string> {
  const own = new Set<string>(fn.params.map((p) => p.name));
  const last = Math.min(fn.endLine, lines.length);
  for (let ln = fn.line; ln <= last; ln++) {
    const code = codeAt(ln);
    for (const re of LOCAL_RES) {
      for (const m of code.matchAll(re)) for (const n of m[1]!.split(",")) {
        const name = n.trim().replace(/^(?:let|var)\s+/, "");
        if (/^[A-Za-z_]\w*$/.test(name) && !KEYWORDS.has(name)) own.add(name);
      }
    }
  }
  return own;
}

/**
 * The members a type's body declares at its own depth (`var points = 0`, `private let repo: Repo`), outside its
 * methods and the types nested in it, with the line of each — the untyped ones are no `ClassInfo.properties` entry.
 */
export function swiftDeclaredMembers(lines: readonly string[], cls: ClassInfo, nested: readonly ClassInfo[]): Map<string, number> {
  const out = new Map<string, number>();
  const inside = (ln: number, spans: readonly { line: number; endLine: number }[]) => spans.some((s) => ln >= s.line && ln <= s.endLine);
  const inner = nested.filter((c) => c !== cls && c.line > cls.line && c.endLine <= cls.endLine);
  for (let ln = cls.line + 1; ln < Math.min(cls.endLine, lines.length + 1); ln++) {
    if (inside(ln, cls.methods) || inside(ln, inner)) continue;
    const m = MEMBER_RE.exec(lines[ln - 1] ?? "");
    if (m && !out.has(m[1]!)) out.set(m[1]!, ln);
  }
  return out;
}

/** Whether `cls` is an `extension` of a type declared elsewhere (its stored members are the type's, not its own). */
export function isSwiftExtension(lines: readonly string[], cls: ClassInfo): boolean {
  return EXTENSION_RE.test(lines[cls.line - 1] ?? "");
}

/**
 * What a Swift function assigns (`FunctionInfo.fieldWrites`) and the types it throws (`throws`): a member of `self`
 * (`self.points += 3`, `self?.name = n`), of a member's object (`self.stats.goals = 0` → `self.stats`), of a typed
 * parameter or local (`club.name = n`), and — in a method — a bare member (`visits += 1`) the body does not bind as a
 * local: where `members` are the type's own declarations, only those, each stated once as an `init` declaration so an
 * untyped `var visits = 0` is known to core; in an extension (`members` null), any bare name, which core keeps only
 * where the extended type declares it. An initializer states no writes (it initializes). Throws are the types after
 * `throw` and a signature's `throws(T)` (declared); a thrown variable or `.case` states nothing.
 */
export function swiftMemberEffects(
  lines: readonly string[],
  fn: FunctionInfo,
  method: { members: ReadonlyMap<string, number> | null } | null,
): Pick<FunctionInfo, "fieldWrites" | "throws"> | null {
  const out = new EffectsCollector();
  const isInit = method !== null && /^init[?!]?$/.test(fn.name);
  const typed = new Set<string>();
  for (const p of fn.params) if (p.type) typed.add(p.name);
  for (const l of fn.localTypes ?? []) if (l.type && !l.soft && l.choice === undefined) typed.add(l.name);
  const last = Math.min(fn.endLine, lines.length);
  const codeAt = (ln: number) => blankStringLiterals(lines[ln - 1] ?? "", ["//"]);
  const signature = TYPED_THROWS_RE.exec(codeAt(fn.line));
  if (signature) out.addThrow(signature[1]!, fn.line, true);
  const own = method ? localNames(lines, fn, codeAt) : null;
  const declared = new Set<string>();
  const declare = (member: string): void => {
    const at = method?.members?.get(member);
    if (at === undefined || declared.has(member)) return;
    declared.add(member);
    out.addWrite("this", member, at, true);
  };
  for (let ln = fn.line; ln <= last; ln++) {
    const code = codeAt(ln);
    if (code.includes("throw")) for (const m of code.matchAll(THROW_RE)) out.addThrow(thrownType(m[1]!, m[2] !== undefined), ln);
    if (isInit || !code.includes("=")) continue;
    for (const m of code.matchAll(SELF_RE)) {
      declare(m[1]!);
      out.addWrite("this", m[1]!, ln);
    }
    for (const m of code.matchAll(SELF_FIELD_RE)) out.addWrite(`this.${m[1]}`, m[2]!, ln);
    for (const m of code.matchAll(NAMED_RE)) if (typed.has(m[1]!)) out.addWrite(m[1]!, m[2]!, ln);
    if (!method || !own) continue;
    for (const m of code.matchAll(BARE_RE)) {
      const name = m[1]!;
      if (own.has(name) || KEYWORDS.has(name)) continue;
      if (method.members && !method.members.has(name)) continue;
      declare(name);
      out.addWrite("", name, ln);
    }
  }
  return out.result();
}
