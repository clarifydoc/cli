import type { ClassInfo, FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { EffectsCollector } from "../shared/member-effects-kit.js";

const OP = String.raw`(?:<<|>>>?|[-+*/%&|^])?`;
/** A statement that starts with an lvalue: the start of the line, after `;`, `{` or `=>`, or after Scala 3's `then`/`else`/`do`. */
const START = String.raw`(?:^|[;{]|=>|\b(?:then|else|do)\s)\s*`;
const END = String.raw`\s*${OP}=(?![=>])`;
const THIS_RE = new RegExp(String.raw`${START}this\.([A-Za-z_]\w*)${END}`, "g");
const THIS_FIELD_RE = new RegExp(String.raw`${START}this\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)${END}`, "g");
const NAMED_RE = new RegExp(String.raw`${START}([a-z_]\w*)\.([A-Za-z_]\w*)${END}`, "g");
const BARE_RE = new RegExp(String.raw`${START}([A-Za-z_]\w*)${END}`, "g");
/** `throw new ClubClosed(…)`, `throw new java.io.IOException(…)`, `throw Missing(id)` (a case class); `throw e` names no type. */
const THROW_RE = /\bthrow\s+(?:new\s+)?((?:[a-z_]\w*\.)*[A-Z]\w*(?:\.[A-Z]\w*)*)/g;
/** `@throws[ClubClosed]`, `@throws(classOf[ClubClosed])` on a declaration. */
const DECLARED_RE = /@throws\s*(?:\[\s*([\w.]+)|\(\s*classOf\s*\[\s*([\w.]+))/g;
/** A local the body binds (`val n`, `var n`, `val (a, b)`, `x <- xs`, a lambda's or case's `x =>`), which a bare write then names, not a field. */
const LOCAL_RES = [
  /\b(?:val|var)\s+([A-Za-z_]\w*)/g,
  /\b(?:val|var)\s*\(([^)]*)\)/g,
  /\b([A-Za-z_]\w*)\s*<-/g,
  /\(([^()]*)\)\s*=>/g,
  /(?:^|[{(,\s])([A-Za-z_]\w*)\s*=>/g,
];
/** A member the type's body declares at its own depth (`var points = 0`, `private val repo: Repo`). */
const MEMBER_RE = /^\s*(?:@[\w.]+(?:\([^)]*\)|\[[^\]]*\])?\s+)*(?:(?:private|protected)(?:\[\w+\])?\s+|(?:override|final|lazy|implicit|sealed)\s+)*(?:val|var)\s+([A-Za-z_]\w*)/;
const KEYWORDS = new Set(["this", "super", "return", "throw", "new", "case", "val", "var", "def", "if", "else", "then", "do", "while", "match", "yield", "type", "import", "_"]);

/** A function's own local names, parameters included. */
function localNames(fn: FunctionInfo, codeAt: (ln: number) => string, last: number): Set<string> {
  const own = new Set<string>(fn.params.map((p) => p.name));
  for (let ln = fn.line; ln <= last; ln++) {
    const code = codeAt(ln);
    for (const re of LOCAL_RES) {
      for (const m of code.matchAll(re)) for (const part of m[1]!.split(",")) {
        const name = part.trim().replace(/^(?:val|var)\s+/, "").replace(/\s*:.*$/, "");
        if (/^[A-Za-z_]\w*$/.test(name) && !KEYWORDS.has(name)) own.add(name);
      }
    }
  }
  return own;
}

/**
 * The members a type's body declares at its own depth (`var points = 0`, `private val repo: Repo`), outside its methods
 * and the types nested in it, with the line of each (0 for a `ClassInfo.properties` entry, which core knows; the untyped
 * ones are none).
 */
export function scalaDeclaredMembers(lines: readonly string[], cls: ClassInfo, all: readonly ClassInfo[]): Map<string, number> {
  const out = new Map<string, number>();
  // A declared property core knows already (line 0: no declaration to state).
  for (const p of cls.properties) out.set(p.name, 0);
  const inside = (ln: number, spans: readonly { line: number; endLine: number }[]) => spans.some((s) => ln >= s.line && ln <= s.endLine);
  const inner = all.filter((c) => c !== cls && c.line > cls.line && c.endLine <= cls.endLine);
  for (let ln = cls.line + 1; ln < Math.min(cls.endLine, lines.length + 1); ln++) {
    if (inside(ln, cls.methods) || inside(ln, inner)) continue;
    const m = MEMBER_RE.exec(lines[ln - 1] ?? "");
    if (m && !out.has(m[1]!)) out.set(m[1]!, ln);
  }
  return out;
}

/** A line that is one argument of a call written over several lines (`name = n,` below `copy(`): a named argument, not an assignment. */
function namedArgumentLine(codeAt: (ln: number) => string, ln: number, first: number): boolean {
  if (/,\s*$/.test(codeAt(ln))) return true;
  for (let up = ln - 1; up >= first; up--) {
    const prev = codeAt(up).trim();
    if (prev === "") continue;
    return /[(,]$/.test(prev);
  }
  return false;
}

/**
 * What a Scala function assigns (`FunctionInfo.fieldWrites`) and the types it throws (`throws`): a member of `this`
 * (`this.points += 3`), of a member's object (`this.stats.goals = 0` → `this.stats`), of a typed parameter or local
 * (`club.name = n`, a `var` or setter), and — in a method — a bare member (`visits += 1`) the body does not bind as a
 * local, only one the type's body (or its primary constructor) declares, each stated once as an `init` declaration so
 * an untyped `var visits = 0` is known to core. A named argument on its own line (`name = n,`) is no write, and an
 * auxiliary constructor (`def this(…)`) states none. Throws are the types after `throw` (as written, qualifier kept) and
 * a `@throws[T]` annotation (declared); a thrown variable states nothing.
 */
export function scalaMemberEffects(
  lines: readonly string[],
  fn: FunctionInfo,
  members: ReadonlyMap<string, number> | null,
  owner: string | null,
): Pick<FunctionInfo, "fieldWrites" | "throws"> | null {
  const out = new EffectsCollector();
  const isCtor = owner !== null && (fn.name === "this" || fn.name === owner);
  const typed = new Set<string>();
  for (const p of fn.params) if (p.type) typed.add(p.name);
  for (const l of fn.localTypes ?? []) if (l.type && !l.soft && l.choice === undefined) typed.add(l.name);
  const last = Math.min(fn.endLine, lines.length);
  const codeAt = (ln: number) => blankStringLiterals(lines[ln - 1] ?? "", ["//"]);
  // Annotations on the lines above the `def` (and on its own line).
  for (let ln = fn.line; ln >= Math.max(1, fn.line - 6); ln--) {
    const code = codeAt(ln);
    if (ln < fn.line && !/^\s*@/.test(code)) break;
    for (const m of code.matchAll(DECLARED_RE)) out.addThrow((m[1] ?? m[2])!, ln, true);
  }
  const own = members ? localNames(fn, codeAt, last) : null;
  const declared = new Set<string>();
  const declare = (member: string): void => {
    const at = members?.get(member);
    if (at === undefined || declared.has(member)) return;
    declared.add(member);
    if (at === 0) return;
    out.addWrite("this", member, at, true);
  };
  for (let ln = fn.line; ln <= last; ln++) {
    const code = codeAt(ln);
    if (code.includes("throw")) for (const m of code.matchAll(THROW_RE)) out.addThrow(m[1]!, ln);
    if (isCtor || !code.includes("=")) continue;
    for (const m of code.matchAll(THIS_RE)) {
      declare(m[1]!);
      out.addWrite("this", m[1]!, ln);
    }
    for (const m of code.matchAll(THIS_FIELD_RE)) out.addWrite(`this.${m[1]}`, m[2]!, ln);
    for (const m of code.matchAll(NAMED_RE)) if (typed.has(m[1]!)) out.addWrite(m[1]!, m[2]!, ln);
    if (!members || !own) continue;
    for (const m of code.matchAll(BARE_RE)) {
      const name = m[1]!;
      if (own.has(name) || KEYWORDS.has(name) || !members.has(name)) continue;
      if (/^\s*$/.test(code.slice(0, m.index)) && namedArgumentLine(codeAt, ln, fn.line)) continue;
      declare(name);
      out.addWrite("", name, ln);
    }
  }
  return out.result();
}
