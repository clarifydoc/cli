import type { FunctionInfo } from "../../../types/analysis.js";
import { BodyText, EffectsCollector, ownNames, statedTypeNames } from "../shared/member-effects-kit.js";
import { blocksOf } from "./receivers.js";

const OP = String.raw`(?:<<|>>|[-+*/%&|^])?`;
/** A statement that starts with an lvalue: the start of the line, after `;`, `{`, `}` or `)` (`if (c) x = 1;`), or after `else`/`do`. */
const START = String.raw`(?:^|[;{})]|\b(?:else|do)\b)\s*`;
const END = String.raw`(?:\[[^\]\n]*\])?\s*${OP}=(?!=)`;
const ID = String.raw`[A-Za-z_]\w*`;
const ACCESS = String.raw`\s*(?:\.|->)\s*`;
const SELF_RE = new RegExp(String.raw`${START}self${ACCESS}(${ID})${END}`, "g");
const SELF_FIELD_RE = new RegExp(String.raw`${START}self${ACCESS}(${ID})${ACCESS}(${ID})${END}`, "g");
const NAMED_RE = new RegExp(String.raw`${START}(${ID})${ACCESS}(${ID})${END}`, "g");
const BARE_RE = new RegExp(String.raw`${START}(${ID})${END}`, "g");
/** `count++`, `++_count`, `self.count--`, `club.count++` as a statement of its own. */
const STEP_RE = new RegExp(String.raw`${START}(?:(\+\+|--)\s*)?(${ID}${ACCESS})?(${ID})\s*(\+\+|--)?\s*(?=;)`, "g");
/** `@throw [ClubClosed exceptionWithName:…]`, `@throw [[ClubClosed alloc] initWith…]`, `@throw [ClubClosed new]`. */
const THROW_RE = /@throw\s+\[\s*(?:\[\s*)?([A-Z]\w*)\b/g;
/** `@throw failure;` — the type its local is declared with. */
const THROW_LOCAL_RE = /@throw\s+([a-z_]\w*)\s*;/g;
/** `[NSException raise:…]`, `[ClubClosed raise:format:…]`. */
const RAISE_RE = /\[\s*([A-Z]\w*)\s+raise\s*:/g;
/** A local the body declares (`NSInteger old = …`, `Club *c;`, `for (Club *p in list)`), which a bare write then names, not an instance variable. */
const LOCAL_RE = new RegExp(String.raw`(?:^|[;{(,])\s*(?:(?:const|static|__block|__weak|__strong|__unsafe_unretained|volatile|unsigned|signed|long|short|struct|enum|register)\s+)*(${ID})(?:\s*<[^;()]*>)?[\s*]*?(?:\s*(?:_Nullable|_Nonnull|const|__weak|__strong)\s*)*[\s*]+(${ID})\s*(?:=|;|\[|,|\bin\b|:)`, "g");
const NOT_TYPES = new Set(["return", "throw", "case", "goto", "else", "do", "if", "while", "for", "switch", "new", "sizeof", "default", "break", "continue", "self", "super"]);
const KEYWORDS = new Set(["self", "super", "return", "throw", "case", "default", "if", "while", "for", "switch", "else", "do", "goto", "break", "continue", "sizeof", "nil", "NULL", "YES", "NO"]);
const PROPERTY_RE = /^\s*@property\b[^;]*?([A-Za-z_]\w*)\s*(?:;|$)/;
const IVAR_RE = /^\s*(?:@(?:private|protected|public|package)\s+)?[A-Za-z_][\w<>,\s]*?[\s*]+([A-Za-z_]\w*)\s*(?::\s*\d+\s*)?;/;
/** `init`, `initWithName`, `initialize` is no initializer. */
const INIT_RE = /^init(?:[A-Z]\w*)?$/;

/** The names a body line binds. */
const readLocals = (code: string, add: (name: string) => void): void => {
  for (const m of code.matchAll(LOCAL_RE)) if (!NOT_TYPES.has(m[1]!) && !KEYWORDS.has(m[2]!)) add(m[2]!);
};

/**
 * The members the file's `@interface`/`@implementation` blocks of each class declare — a `@property` (of any type,
 * with the `_name` it synthesizes) and an instance variable between the braces — with the line of each: a primitive
 * property (`NSInteger count`) is no `ClassInfo.properties` entry, so a method writing it states the declaration.
 */
export function objcDeclaredMembers(lines: readonly string[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const b of blocksOf(lines as string[])) {
    if (b.kind === "protocol") continue;
    const members = out.get(b.name) ?? new Map<string, number>();
    out.set(b.name, members);
    // The instance variables are the braces that open the block (`@implementation X {`); a method body's braces are none.
    let depth = 0;
    let braces = true;
    for (let ln = b.line; ln < b.endLine; ln++) {
      const code = (lines[ln - 1] ?? "").replace(/\/\/.*$/, "");
      if (depth === 0 && ln > b.line && /^\s*(?:[-+]\s*\(|@property\b)/.test(code)) braces = false;
      const prop = PROPERTY_RE.exec(code);
      if (prop) {
        if (!members.has(prop[1]!)) members.set(prop[1]!, ln);
        if (!members.has(`_${prop[1]}`)) members.set(`_${prop[1]}`, ln);
        continue;
      }
      if (!braces) continue;
      for (const ch of code) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      const ivar = depth > 0 ? IVAR_RE.exec(code) : null;
      if (ivar && !members.has(ivar[1]!)) members.set(ivar[1]!, ln);
    }
  }
  return out;
}

/**
 * What an Objective-C function assigns (`FunctionInfo.fieldWrites`) and the types it throws (`throws`): a property or
 * instance variable of `self` (`self.points = 3`, `self->_points += 3`, `_points = 0`), of a member's object
 * (`self.stats.goals = 0` → `this.stats`), of a typed parameter or local (`club.name = n`), and — in a method — a bare
 * name (`_visits++`) the body does not declare as a local, which core keeps only where the class declares it. Where
 * the file declares members of the class, a write to one is also stated once as an `init` declaration. An `init…`
 * method states no writes (it initializes). Throws are the classes `@throw [X …]` and `[X raise:…]` name, and the
 * declared type of a thrown local; a thrown parameter or `@throw;` states nothing.
 */
export function objcMemberEffects(
  lines: readonly string[],
  fn: FunctionInfo,
  method: { members: ReadonlyMap<string, number> | null } | null,
): Pick<FunctionInfo, "fieldWrites" | "throws"> | null {
  const out = new EffectsCollector();
  const isInit = method !== null && INIT_RE.test(fn.name);
  const typed = statedTypeNames(fn);
  const body = new BodyText(lines, fn, ["//"]);
  const own = method ? ownNames(body, readLocals) : null;
  const declare = (member: string): void => out.declareOnce(member, method?.members?.get(member));
  const bare = (name: string): boolean => own !== null && !KEYWORDS.has(name) && !own().has(name);
  const localType = (name: string): string | null => {
    const types = (fn.localTypes ?? []).filter((l) => l.name === name);
    return types.length === 1 && types[0]!.type && !types[0]!.soft && types[0]!.choice === undefined ? types[0]!.type : null;
  };
  for (let ln = fn.line; ln <= body.last; ln++) {
    const raw = body.raw(ln);
    const throws = raw.includes("@throw") || raw.includes("raise");
    const steps = !isInit && (raw.includes("++") || raw.includes("--"));
    const writes = !isInit && raw.includes("=");
    if (!throws && !steps && !writes) continue;
    const code = body.code(ln);
    if (throws) {
      for (const m of code.matchAll(THROW_RE)) out.addThrow(m[1]!, ln);
      for (const m of code.matchAll(RAISE_RE)) out.addThrow(m[1]!, ln);
      for (const m of code.matchAll(THROW_LOCAL_RE)) {
        const type = localType(m[1]!);
        if (type && /^[A-Z]/.test(type)) out.addThrow(type, ln);
      }
    }
    if (writes) {
      for (const m of code.matchAll(SELF_RE)) {
        declare(m[1]!);
        out.addWrite("this", m[1]!, ln);
      }
      for (const m of code.matchAll(SELF_FIELD_RE)) out.addWrite(`this.${m[1]}`, m[2]!, ln);
      for (const m of code.matchAll(NAMED_RE)) if (m[1] !== "self" && typed.has(m[1]!)) out.addWrite(m[1]!, m[2]!, ln);
      for (const m of code.matchAll(BARE_RE)) {
        if (!bare(m[1]!)) continue;
        declare(m[1]!);
        out.addWrite("", m[1]!, ln);
      }
    }
    if (!steps) continue;
    for (const m of code.matchAll(STEP_RE)) {
      if (!m[1] === !m[4]) continue; // exactly one of a prefix or a postfix step
      const via = m[2]?.replace(/\s+/g, "").replace(/(?:\.|->)$/, "");
      const member = m[3]!;
      if (via === "self") {
        declare(member);
        out.addWrite("this", member, ln);
      } else if (via) {
        if (typed.has(via)) out.addWrite(via, member, ln);
      } else if (bare(member)) {
        declare(member);
        out.addWrite("", member, ln);
      }
    }
  }
  return out.result();
}
