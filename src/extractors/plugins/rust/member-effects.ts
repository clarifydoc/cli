import type { FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { EffectsCollector } from "../shared/member-effects-kit.js";

const STATIC_MUT_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?static\s+mut\s+([A-Z_][A-Z0-9_]*)\s*:/;
const OP = String.raw`(?:<<|>>|[-+*/%^&|])?`;
const ELEMENT = String.raw`(?:\[[^\]\n]*\])?`;
/** A statement that starts with an lvalue: the start of the line, after `;`, `{`, `}` or a match arm's `=>`. */
const START = String.raw`(?:^|[;{}]|=>)\s*`;
const END = String.raw`${ELEMENT}\s*${OP}=(?![=>])`;
const SELF_RE = new RegExp(String.raw`${START}self\.([A-Za-z_]\w*)${END}`, "g");
const SELF_FIELD_RE = new RegExp(String.raw`${START}self\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)${END}`, "g");
const TYPED_RE = new RegExp(String.raw`${START}([a-z_]\w*)\.([A-Za-z_]\w*)${END}`, "g");
const BARE_RE = new RegExp(String.raw`${START}([A-Z_][A-Z0-9_]*)${END}`, "g");

/** The `static mut NAME: T` items of a file (`FileAnalysis.packageVariables`), with the line. */
export function rustStaticMuts(lines: readonly string[]): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = STATIC_MUT_RE.exec(lines[i] ?? "");
    if (m) out.push({ name: m[1]!, line: i + 1 });
  }
  return out;
}

/**
 * What a Rust function assigns (`FunctionInfo.fieldWrites`): a field of `self` (`self.name = n`, `self.score += 1`, an
 * element `self.items[i] = x`), of a field's struct (`self.stats.goals += 1` → `this.stats`), of a typed parameter or
 * local (`club.name = n`), and a `static mut` of the file written bare (`COUNT += 1`: `package`, which core accepts only
 * where this file declares it). A closure body's statements count for the function holding it, as does a nested `fn`'s. A statement starting with `let`, a deref (`*self.n += 1`), a tuple field
 * (`self.0 = x`) and a method call that mutates (`self.items.push`) state nothing. Rust has no exceptions: a returned
 * `Err` and a `panic!` are no thrown type, so a function states none.
 */
export function rustMemberEffects(lines: readonly string[], fn: FunctionInfo, statics: ReadonlySet<string>): Pick<FunctionInfo, "fieldWrites"> | null {
  const out = new EffectsCollector();
  const typed = new Set<string>();
  for (const p of fn.params) if (p.type && p.name !== "self") typed.add(p.name);
  for (const l of fn.localTypes ?? []) if (l.type && !l.soft && l.choice === undefined && l.name !== "self") typed.add(l.name);
  const last = Math.min(fn.endLine, lines.length);
  for (let ln = fn.line; ln <= last; ln++) {
    const raw = lines[ln - 1] ?? "";
    if (!raw.includes("=")) continue;
    const code = blankStringLiterals(raw, ["//"]);
    if (!code.includes("=")) continue;
    for (const m of code.matchAll(SELF_RE)) out.addWrite("this", m[1]!, ln);
    for (const m of code.matchAll(SELF_FIELD_RE)) out.addWrite(`this.${m[1]}`, m[2]!, ln);
    for (const m of code.matchAll(TYPED_RE)) if (typed.has(m[1]!)) out.addWrite(m[1]!, m[2]!, ln);
    if (statics.size > 0) for (const m of code.matchAll(BARE_RE)) if (statics.has(m[1]!)) out.addWrite("", m[1]!, ln, undefined, true);
  }
  const result = out.result();
  return result?.fieldWrites ? { fieldWrites: result.fieldWrites } : null;
}
