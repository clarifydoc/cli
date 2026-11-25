import type { FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { EffectsCollector } from "../shared/member-effects-kit.js";

const OP = String.raw`(?:\?\?|<<|>>>?|~\/|[-+*/%&|^])?`;
/** A statement that starts with an lvalue: the start of the line, after `;`, `{`, `}` or `=>`. */
const START = String.raw`(?:^|[;{}]|=>)\s*`;
const END = String.raw`(?:\[[^\]\n]*\])?\s*${OP}=(?![=>])`;
const THIS_RE = new RegExp(String.raw`${START}this\.([A-Za-z_$][\w$]*)${END}`, "g");
const THIS_FIELD_RE = new RegExp(String.raw`${START}this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)${END}`, "g");
const NAMED_RE = new RegExp(String.raw`${START}([a-z_$][\w$]*)\.([A-Za-z_$][\w$]*)${END}`, "g");
const BARE_RE = new RegExp(String.raw`${START}([A-Za-z_$][\w$]*)${END}`, "g");
/** `count++`, `this.count--`, `++count`. */
const STEP_RE = new RegExp(String.raw`${START}(?:(?:\+\+|--)\s*)?(this\.)?([A-Za-z_$][\w$]*)\s*(?:\+\+|--)?(?=\s*;)`, "g");
/** `throw ClubException(…)`, `throw const Missing()`, `throw new Missing()`, a named constructor (`throw Missing.id(…)`). */
const THROW_RE = /\bthrow\s+(?:const\s+|new\s+)?([A-Z][\w$]*)(?:\.[A-Za-z_$][\w$]*)?\s*(?:<[^>()]*>)?\s*\(/g;
/** A local the body declares (`var n = …`, `final Club c = …`, `int n;`), which a bare write then names, not a field. */
const LOCAL_RE = /\b(?:var|final|const|late|[A-Za-z_$][\w$]*(?:<[^>()]*>)?\??)\s+([a-z_$][\w$]*)\s*(?:=(?!=)|;|\bin\b)/g;
const KEYWORDS = new Set(["return", "throw", "await", "yield", "else", "case", "new", "const", "final", "var", "late", "is", "as", "in"]);

/**
 * What a Dart function assigns (`FunctionInfo.fieldWrites`) and the exception types it throws (`throws`): a field of
 * `this` (`this.score = s`, `this.score += 1`, `this.score++`), of a field's object (`this.stats.goals = 0` →
 * `this.stats`), of a typed parameter or local (`club.name = n`), and — in a method, where `fields` are its class's — a
 * bare field (`_count = 0`) the body does not declare as a local. A constructor states no writes (it initializes).
 * Throws are the constructions after `throw`; `rethrow` and a thrown variable state nothing.
 */
export function dartMemberEffects(lines: readonly string[], fn: FunctionInfo, fields: ReadonlySet<string> | null, isConstructor: boolean): Pick<FunctionInfo, "fieldWrites" | "throws"> | null {
  const out = new EffectsCollector();
  const typed = new Set<string>();
  for (const p of fn.params) if (p.type) typed.add(p.name);
  for (const l of fn.localTypes ?? []) if (l.type && !l.soft && l.choice === undefined) typed.add(l.name);
  const own = new Set<string>(fn.params.map((p) => p.name));
  const last = Math.min(fn.endLine, lines.length);
  const codeAt = (ln: number) => blankStringLiterals(lines[ln - 1] ?? "", ["//"]);
  if (fields && !isConstructor) {
    for (let ln = fn.line; ln <= last; ln++) for (const m of codeAt(ln).matchAll(LOCAL_RE)) if (!KEYWORDS.has(m[1]!)) own.add(m[1]!);
  }
  for (let ln = fn.line; ln <= last; ln++) {
    const code = codeAt(ln);
    if (code.includes("throw")) for (const m of code.matchAll(THROW_RE)) out.addThrow(m[1]!, ln);
    if (isConstructor || (!code.includes("=") && !code.includes("++") && !code.includes("--"))) continue;
    for (const m of code.matchAll(THIS_RE)) out.addWrite("this", m[1]!, ln);
    for (const m of code.matchAll(THIS_FIELD_RE)) out.addWrite(`this.${m[1]}`, m[2]!, ln);
    for (const m of code.matchAll(NAMED_RE)) if (typed.has(m[1]!) && m[1] !== "this") out.addWrite(m[1]!, m[2]!, ln);
    if (fields) {
      for (const m of code.matchAll(BARE_RE)) if (fields.has(m[1]!) && !own.has(m[1]!)) out.addWrite("", m[1]!, ln);
      if (code.includes("++") || code.includes("--")) {
        for (const m of code.matchAll(STEP_RE)) {
          if (!/(?:\+\+|--)/.test(m[0])) continue;
          if (m[1]) out.addWrite("this", m[2]!, ln);
          else if (fields.has(m[2]!) && !own.has(m[2]!)) out.addWrite("", m[2]!, ln);
        }
      }
    }
  }
  return out.result();
}
