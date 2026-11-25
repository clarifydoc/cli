import type { FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { EffectsCollector } from "../shared/member-effects-kit.js";

const OP = String.raw`(?:<<|>>|[-+*/%&|^])?`;
/** A statement that starts with an lvalue: the start of the line, after `;`, `{`, `}` or `)` (`if (c) x = 1;`), or after `else`/`do`. */
const START = String.raw`(?:^|[;{})]|\b(?:else|do)\b)\s*`;
const END = String.raw`(?:\[[^\]\n]*\])?\s*${OP}=(?!=)`;
const ID = String.raw`[A-Za-z_]\w*`;
const ACCESS = String.raw`\s*(?:\.|->)\s*`;
const THIS_RE = new RegExp(String.raw`${START}this\s*->\s*(${ID})${END}`, "g");
const THIS_FIELD_RE = new RegExp(String.raw`${START}this\s*->\s*(${ID})${ACCESS}(${ID})${END}`, "g");
const NAMED_RE = new RegExp(String.raw`${START}(${ID})${ACCESS}(${ID})${END}`, "g");
const BARE_RE = new RegExp(String.raw`${START}(${ID})${END}`, "g");
/** `x++`, `++x`, `this->x--`, `club.x++` as a statement of its own. */
const STEP_RE = new RegExp(String.raw`${START}(?:(\+\+|--)\s*)?(this\s*->\s*|${ID}${ACCESS})?(${ID})\s*(\+\+|--)?\s*(?=;)`, "g");
/** `throw ClubClosed("x")`, `throw std::runtime_error(…)`, `throw ClubClosed{…}`; `throw;` and `throw e;` name no type. */
const THROW_RE = new RegExp(String.raw`\bthrow\s+(?:new\s+)?((?:${ID}::)*${ID})\s*(?:<[^<>;()]*>)?\s*[({]`, "g");
/** A local the body declares (`int old = …`, `auto& p = …`, `Club other("x");`, `for (auto& p : list)`), which a bare write then names, not a field. */
const LOCAL_RE = new RegExp(String.raw`(?:^|[;{(,])\s*(?:(?:const|static|constexpr|volatile|unsigned|signed|long|short|struct|class|enum)\s+)*(auto|${ID}(?:::${ID})*)(?:\s*<[^;()]*>)?\s*[*&]*\s+[*&]*(${ID})\s*(?:=|;|\(|\{|\[|:(?!:))`, "g");
const NOT_TYPES = new Set(["return", "delete", "throw", "case", "goto", "else", "new", "co_return", "co_yield", "co_await", "sizeof", "using", "typedef", "namespace", "operator", "template", "typename", "public", "private", "protected"]);
const KEYWORDS = new Set(["this", "return", "throw", "delete", "new", "case", "default", "if", "while", "for", "switch", "else", "do", "goto", "break", "continue", "sizeof", "co_return", "co_yield", "co_await"]);

/** A function's own local names, parameters included. */
function localNames(fn: FunctionInfo, codeAt: (ln: number) => string, last: number): Set<string> {
  const own = new Set<string>(fn.params.map((p) => p.name));
  for (let ln = fn.line; ln <= last; ln++) {
    const code = codeAt(ln);
    for (const m of code.matchAll(LOCAL_RE)) if (!NOT_TYPES.has(m[1]!) && !KEYWORDS.has(m[2]!)) own.add(m[2]!);
  }
  return own;
}

/**
 * What a C++ function assigns (`FunctionInfo.fieldWrites`) and the types it throws (`throws`): a member of `this`
 * (`this->points += 3`, `this->points++`), of a member's object (`this->stats.goals = 0` → `this.stats`), of a typed
 * parameter or local (`club.name = n`, `stats->goals += 1`), and — in a method (`method` true, inline or out of line) —
 * a bare name (`visits++`) the body does not declare as a local, which core keeps only where the class or a base
 * declares it. A constructor states no writes (it initializes). Throws are the types after `throw` (qualifier kept);
 * `throw;` and a thrown variable state nothing.
 */
export function cppMemberEffects(lines: readonly string[], fn: FunctionInfo, method: boolean, isConstructor: boolean): Pick<FunctionInfo, "fieldWrites" | "throws"> | null {
  const out = new EffectsCollector();
  const typed = new Set<string>();
  for (const p of fn.params) if (p.type) typed.add(p.name);
  for (const l of fn.localTypes ?? []) if (l.type && !l.soft && l.choice === undefined) typed.add(l.name);
  const last = Math.min(fn.endLine, lines.length);
  const codeAt = (ln: number) => blankStringLiterals(lines[ln - 1] ?? "", ["//"]);
  const own = method && !isConstructor ? localNames(fn, codeAt, last) : null;
  for (let ln = fn.line; ln <= last; ln++) {
    const code = codeAt(ln);
    if (code.includes("throw")) for (const m of code.matchAll(THROW_RE)) out.addThrow(m[1]!, ln);
    if (isConstructor || (!code.includes("=") && !code.includes("++") && !code.includes("--"))) continue;
    for (const m of code.matchAll(THIS_RE)) out.addWrite("this", m[1]!, ln);
    for (const m of code.matchAll(THIS_FIELD_RE)) out.addWrite(`this.${m[1]}`, m[2]!, ln);
    for (const m of code.matchAll(NAMED_RE)) if (m[1] !== "this" && typed.has(m[1]!)) out.addWrite(m[1]!, m[2]!, ln);
    if (own) for (const m of code.matchAll(BARE_RE)) if (!own.has(m[1]!) && !KEYWORDS.has(m[1]!)) out.addWrite("", m[1]!, ln);
    if (code.includes("++") || code.includes("--")) {
      for (const m of code.matchAll(STEP_RE)) {
        if (!m[1] === !m[4]) continue; // exactly one of a prefix or a postfix step
        const via = m[2]?.replace(/\s+/g, "");
        const member = m[3]!;
        if (via === "this->") out.addWrite("this", member, ln);
        else if (via) {
          const recv = via.replace(/(?:\.|->)$/, "");
          if (recv !== "this" && typed.has(recv)) out.addWrite(recv, member, ln);
        } else if (own && !own.has(member) && !KEYWORDS.has(member)) out.addWrite("", member, ln);
      }
    }
  }
  return out.result();
}
