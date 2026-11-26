import type { FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { EffectsCollector } from "../shared/member-effects-kit.js";
import { extractRustImports } from "./imports.js";

const STATIC_MUT_RE = /^\s*(?:pub(?:\([^)]*\))?\s+)?static\s+mut\s+([A-Z_][A-Z0-9_]*)\s*:/;
const OP = String.raw`(?:<<|>>|[-+*/%^&|])?`;
const ELEMENT = String.raw`(?:\[[^\]\n]*\])?`;
/** A statement that starts with an lvalue: the start of the line, after `;`, `{`, `}` or a match arm's `=>`. */
const START = String.raw`(?:^|[;{}]|=>)\s*`;
const END = String.raw`${ELEMENT}\s*${OP}=(?![=>])`;
/** A deref of the lvalue (`*self.count += 1`): the write is of the place the field points to, so of the field. */
const DEREF = String.raw`\*?\s*`;
/** What reaches into a shared cell before the field is named: `.borrow_mut()`, `.lock().unwrap()`, `.write().expect("…")`. */
const CELL = String.raw`(?:\.borrow_mut\(\)|\.(?:lock|write)\(\)\??(?:\.(?:unwrap|expect)\([^()]*\))?)`;
const SELF_RE = new RegExp(String.raw`${START}${DEREF}self\.([A-Za-z_]\w*)${END}`, "g");
const SELF_FIELD_RE = new RegExp(String.raw`${START}${DEREF}self\.([A-Za-z_]\w*)(?:${CELL})?\.([A-Za-z_]\w*)${END}`, "g");
const TYPED_RE = new RegExp(String.raw`${START}${DEREF}([a-z_]\w*)(?:${CELL})?\.([A-Za-z_]\w*)${END}`, "g");
const BARE_RE = new RegExp(String.raw`${START}([A-Z_][A-Z0-9_]*)${END}`, "g");
/** A `static mut` written through its module path: `crate::stats::TOTAL += 1`, `stats::TOTAL = 0`. */
const QUALIFIED_RE = new RegExp(String.raw`${START}((?:[a-z_]\w*::)+)([A-Z_][A-Z0-9_]*)${END}`, "g");

/** The `static mut NAME: T` items of a file (`FileAnalysis.packageVariables`), with the line. */
export function rustStaticMuts(lines: readonly string[]): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = STATIC_MUT_RE.exec(lines[i] ?? "");
    if (m) out.push({ name: m[1]!, line: i + 1 });
  }
  return out;
}

const importsOfLines = new WeakMap<readonly string[], ReturnType<typeof extractRustImports>>();

/**
 * The module path a name written in this file stands for: the leading segment of `stats::TOTAL` is expanded through the
 * `use` that binds it (`use crate::stats;` → `crate::stats`); `crate`, `self` and `super` stand for themselves, and a
 * name no `use` binds is left as written (a child module of the file's own).
 */
function expandModulePath(lines: readonly string[], path: string): string {
  const segs = path.split("::");
  if (/^(?:crate|self|super)$/.test(segs[0]!)) return path;
  let imports = importsOfLines.get(lines);
  if (!imports) importsOfLines.set(lines, (imports = extractRustImports(lines as string[])));
  for (const imp of imports) {
    if (!imp.specifiers.includes(segs[0]!)) continue;
    return [imp.source, imp.aliases?.[segs[0]!] ?? segs[0]!, ...segs.slice(1)].join("::");
  }
  return path;
}

/** The module path of the `use` that brings `name` in by itself (`use crate::stats::TOTAL;` → `crate::stats`), or null. */
function importedFrom(lines: readonly string[], name: string): string | null {
  let imports = importsOfLines.get(lines);
  if (!imports) importsOfLines.set(lines, (imports = extractRustImports(lines as string[])));
  const imp = imports.find((i) => i.source !== "self" && i.specifiers.includes(name) && (i.aliases?.[name] ?? name) === name);
  return imp?.source ?? null;
}

/**
 * What a Rust function assigns (`FunctionInfo.fieldWrites`): a field of `self` (`self.name = n`, `self.score += 1`, an
 * element `self.items[i] = x`), of a field's struct (`self.stats.goals += 1` → `this.stats`), of a typed parameter or
 * local (`club.name = n`), and a `static mut` written bare (`COUNT += 1`: `package`, which core accepts only where this file
 * declares it). A deref of the place (`*self.n += 1`) writes the field it points to, and a field reached through a shared
 * cell — `self.stats.borrow_mut().goals += 1`, `club.lock().unwrap().name = n` — is the written field of the cell's
 * content (core reads `RefCell`/`Mutex`/`RwLock` as transparent wrappers of a declared type). A `static mut` written
 * through its module (`crate::stats::TOTAL += 1`, `stats::TOTAL = 0` after `use crate::stats;`) or bare after
 * `use crate::stats::TOTAL;` carries the module path as `receiver`, which core resolves to the declaring file. A closure
 * body's statements count for the function holding it, as does a nested `fn`'s. A statement starting with `let`, a
 * tuple field (`self.0 = x`) and a method call that mutates (`self.items.push`) state nothing. Rust has no exceptions: a returned
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
    if (code.includes("::")) for (const m of code.matchAll(QUALIFIED_RE)) out.addWrite(expandModulePath(lines, m[1]!.slice(0, -2)), m[2]!, ln, undefined, true);
    for (const m of code.matchAll(BARE_RE)) {
      if (statics.has(m[1]!)) continue;
      const from = importedFrom(lines, m[1]!);
      if (from) out.addWrite(from, m[1]!, ln, undefined, true);
    }
  }
  const result = out.result();
  return result?.fieldWrites ? { fieldWrites: result.fieldWrites } : null;
}
