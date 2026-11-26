import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import { BodyText, EffectsCollector, addBindingNames, membersAtOwnDepth, ownNames, statedTypeNames } from "../shared/member-effects-kit.js";

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

/** The names a body line binds. */
const readLocals = (code: string, add: (name: string) => void): void => addBindingNames(code, LOCAL_RES, /^(?:let|var)\s+/, KEYWORDS, add);

/**
 * The members a type's body declares at its own depth (`var points = 0`, `private let repo: Repo`), outside its
 * methods and the types nested in it, with the line of each — the untyped ones are no `ClassInfo.properties` entry.
 */
export function swiftDeclaredMembers(lines: readonly string[], cls: ClassInfo, nested: readonly ClassInfo[]): Map<string, number> {
  return membersAtOwnDepth(lines, cls, nested, MEMBER_RE);
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
  const typed = statedTypeNames(fn);
  const body = new BodyText(lines, fn, ["//"]);
  const signature = TYPED_THROWS_RE.exec(body.code(fn.line));
  if (signature) out.addThrow(signature[1]!, fn.line, true);
  const own = method ? ownNames(body, readLocals) : null;
  const declare = (member: string): void => out.declareOnce(member, method?.members?.get(member));
  for (let ln = fn.line; ln <= body.last; ln++) {
    const raw = body.raw(ln);
    const throws = raw.includes("throw");
    const writes = !isInit && raw.includes("=");
    if (!throws && !writes) continue;
    const code = body.code(ln);
    if (throws) for (const m of code.matchAll(THROW_RE)) out.addThrow(thrownType(m[1]!, m[2] !== undefined), ln);
    if (!writes) continue;
    for (const m of code.matchAll(SELF_RE)) {
      declare(m[1]!);
      out.addWrite("this", m[1]!, ln);
    }
    for (const m of code.matchAll(SELF_FIELD_RE)) out.addWrite(`this.${m[1]}`, m[2]!, ln);
    for (const m of code.matchAll(NAMED_RE)) if (typed.has(m[1]!)) out.addWrite(m[1]!, m[2]!, ln);
    if (!method || !own) continue;
    for (const m of code.matchAll(BARE_RE)) {
      const name = m[1]!;
      if (KEYWORDS.has(name) || (method.members && !method.members.has(name)) || own().has(name)) continue;
      declare(name);
      out.addWrite("", name, ln);
    }
  }
  return out.result();
}
