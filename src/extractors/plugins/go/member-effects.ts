import type { FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { bracketDelta, splitGoTopLevel, stripGoComment } from "./syntax.js";

type Write = NonNullable<FunctionInfo["fieldWrites"]>[number];

const MAX_WRITES = 40;
const LVALUE = String.raw`\*?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*(?:\[[^\]]*\])?`;
/** An assignment statement: a list of lvalues, then `=`, a compound `op=`, `++` or `--` (never `:=`, `==`, `<=`, `!=`). */
const ASSIGN_RE = new RegExp(String.raw`^\s*(${LVALUE}(?:\s*,\s*${LVALUE})*)\s*(?:(?:<<|>>|&\^|[-+*/%&|^])?=(?!=)|\+\+|--)`);

/** The names `var` declarations in `lines` bind (`var a, b T`, a `var ( … )` block at its own depth), with the line; `indented` also reads those inside a body. */
function varNames(lines: readonly string[], indented: boolean): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  const seen = new Set<string>();
  const add = (names: string, line: number): void => {
    for (const n of names.split(",").map((s) => s.trim())) if (n && n !== "_" && !seen.has(n)) { seen.add(n); out.push({ name: n, line }); }
  };
  const lead = indented ? String.raw`\s*` : "";
  const blockOpen = new RegExp(String.raw`^${lead}var\s*\(\s*$`);
  const single = new RegExp(String.raw`^${lead}var\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)(?=\s|$|=)`);
  let block = false;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const code = blankStringLiterals(stripGoComment(lines[i] ?? ""));
    if (block) {
      if (depth === 0 && /^\s*\)/.test(code)) { block = false; continue; }
      // A name opens a spec only at the block's own depth: a struct body or a literal's lines are not specs.
      const m = depth === 0 ? /^\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)(?=\s|$|=)/.exec(code) : null;
      if (m) add(m[1]!, i + 1);
      depth += bracketDelta(code);
      continue;
    }
    if (blockOpen.test(code)) { block = true; depth = 0; continue; }
    const m = single.exec(code);
    if (m) add(m[1]!, i + 1);
  }
  return out;
}

/** The name in a Go file's package clause: the first statement after the comments (`package club_test`). */
export function goPackageClause(lines: readonly string[]): string | null {
  let inBlock = false;
  for (const line of lines) {
    const text = line.trim();
    if (inBlock) {
      if (text.includes("*/")) inBlock = false;
      continue;
    }
    if (text === "" || text.startsWith("//")) continue;
    if (text.startsWith("/*")) {
      inBlock = !text.includes("*/");
      continue;
    }
    return /^package\s+([A-Za-z_]\w*)/.exec(text)?.[1] ?? null;
  }
  return null;
}

/** The names a file declares with `var` at its top level (`FileAnalysis.packageVariables`), typed or not, with the line. */
export function goPackageVariableNames(lines: readonly string[]): Array<{ name: string; line: number }> {
  return varNames(lines, false);
}

/**
 * What a Go function assigns (`FunctionInfo.fieldWrites`): a field of the receiver (`c.Name = n` → `this`; `c.Stats.Goals = 0`
 * → `this.Stats`), of a typed parameter or local (`p.Score += 1`), and a bare name the function does not bind itself —
 * a candidate package variable (`clubCount = 0`, `cache[id] = c`, `total++`: `package`), which core accepts only where a
 * file of the package declares one. A name the function declares, takes as a parameter, receives or names in its
 * signature, and a deref (`*p = …`), state nothing. Go has no exceptions: a `panic` and a returned `error` are no throw.
 */
export function goMemberEffects(
  lines: readonly string[],
  fn: Pick<FunctionInfo, "line" | "endLine" | "params" | "localTypes">,
  body: readonly string[],
  bodyFirstLine: number,
  receiverName: string | null,
  bound: ReadonlySet<string>,
): Write[] {
  const out: Write[] = [];
  // The whole signature, through the line that opens the body: parameters and named results may span lines.
  let signature = "";
  for (let ln = fn.line; ln <= Math.min(fn.endLine, fn.line + 20); ln++) {
    const code = stripGoComment(lines[ln - 1] ?? "");
    signature += `${code}\n`;
    if (/\{\s*$/.test(code)) break;
  }
  const declaredVars = new Set(varNames(body, true).map((v) => v.name));
  const named = (name: string): boolean => new RegExp(String.raw`(?<![\w.])${name}(?!\w)`).test(signature);
  const typed = new Set<string>();
  for (const p of fn.params) if (p.type && p.name !== "_" && !p.isReceiver) typed.add(p.name);
  for (const l of fn.localTypes ?? []) if (l.type && !l.soft && l.choice === undefined && l.name !== receiverName) typed.add(l.name);
  const own = receiverName && receiverName !== "_" && !bound.has(receiverName) ? receiverName : null;
  const add = (member: string, receiver: string, line: number, pkg?: true): void => {
    if (out.length >= MAX_WRITES || out.some((w) => w.member === member && w.receiver === receiver && w.line === line)) return;
    out.push({ member, receiver, line, ...(pkg ? { package: pkg } : {}) });
  };
  for (let i = 0; i < body.length; i++) {
    const code = blankStringLiterals(stripGoComment(body[i] ?? ""));
    if (!/[=+\-]/.test(code)) continue;
    const line = bodyFirstLine + i;
    for (const piece of code.split(/[;{}]/)) {
      const m = ASSIGN_RE.exec(piece);
      if (!m) continue;
      for (const target of splitGoTopLevel(m[1]!)) {
        const parts = target.replace(/\[[^\]]*\]$/, "").split(".");
        if (target.startsWith("*") || parts.some((p) => p === "")) continue;
        const head = parts[0]!;
        if (parts.length === 1) {
          if (!bound.has(head) && !declaredVars.has(head) && !typed.has(head) && head !== receiverName && !named(head)) add(head, "", line, true);
        } else if (parts.length === 2) {
          if (head === own) add(parts[1]!, "this", line);
          else if (typed.has(head) && head !== receiverName && !(bound.has(head) && fn.params.some((p) => p.name === head))) add(parts[1]!, head, line);
        } else if (parts.length === 3 && head === own) add(parts[2]!, `this.${parts[1]}`, line);
      }
    }
  }
  return out;
}
