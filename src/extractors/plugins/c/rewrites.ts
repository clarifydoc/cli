/**
 * Rewrites of a C source the reader tries when the file as written does not parse: text the grammar cannot read and
 * the analysis does not need, blanked with lines and columns kept.
 */
import { codeMask } from "../shared/code-mask.js";

const ASM = /\b(?:__asm__|__asm|asm)\b/g;
const ASM_QUALIFIER = /^\s*(?:volatile|__volatile__|__volatile|inline|__inline__|goto)\b/;

/**
 * GNU `asm` statements (`asm volatile("" ::: "memory");`, `__asm__ ("…" : "=a"(r) : "m"(*p));`) with their operands:
 * the template strings are often built from macros (`NGX_SMP_LOCK "cmpxchgl %3, %1;"`), which no grammar of C reads.
 * An assembler template calls nothing, so the statement becomes spaces and its `;` an empty statement.
 */
export function blankAsm(text: string): string {
  if (!/\b(?:__asm__|__asm|asm)\b/.test(text)) return text;
  const mask = codeMask(text);
  const out = text.split("");
  let changed = false;
  for (const m of text.matchAll(ASM)) {
    const start = m.index!;
    if (!mask[start]) continue;
    let at = start + m[0].length;
    for (let q = ASM_QUALIFIER.exec(text.slice(at)); q; q = ASM_QUALIFIER.exec(text.slice(at))) at += q[0].length;
    while (at < text.length && /\s/.test(text[at]!)) at++;
    if (text[at] !== "(") continue;
    // The balanced `)`, past strings and characters.
    let depth = 0;
    let end = -1;
    for (let i = at; i < text.length; i++) {
      const c = text[i]!;
      if (c === '"' || c === "'") {
        for (i++; i < text.length && text[i] !== c && text[i] !== "\n"; i += text[i] === "\\" ? 2 : 1);
      } else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    for (let i = start; i <= end; i++) if (text[i] !== "\n") out[i] = " ";
    changed = true;
  }
  return changed ? out.join("") : text;
}
