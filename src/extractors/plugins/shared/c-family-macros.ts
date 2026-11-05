import type { FileAnalysis, MacroInfo } from "../../../types/analysis.js";
import { conditionalBlocks } from "./preprocessor-branches.js";
import { blankStringLiterals } from "./regex-base.js";

/** `#define for_each_club(c, l)`: a name with its parameter list touching it (a space makes it an object-like macro). */
const FUNCTION_LIKE = /^\s*#\s*define\s+([A-Za-z_]\w*)\(([^)]*)\)/;
const UNDEF = /^\s*#\s*undef\s+([A-Za-z_]\w*)/;

/**
 * The function-like macros a C or C++ file defines, for a call of one to link to its `#define`
 * (`for_each_club(c, list) { … }` reads as a call; its definition is a header's line).
 *
 *  - Object-like macros (`#define MAX_CLUBS 20`) are not symbols.
 *  - A `#define` inside a function body is skipped: it is local to what that function writes, and its calls are
 *    already the function's (`defineCalls`).
 *  - A `#define` in a block comment or in a branch no compiler takes (`#if 0`) is skipped.
 *  - A name `#undef`'d later in the same file is `fileScoped`: it means the macro in its own file only.
 *  - A name defined twice (one per `#if` arm) is its first definition.
 */
export function extractCFamilyMacros(lines: readonly string[], analysis: FileAnalysis, cplusplus: boolean): MacroInfo[] {
  if (!lines.some((l) => l.includes("define"))) return [];
  const bodies = [...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)].map((f) => [f.line, f.endLine] as const);
  const dead = new Set<number>();
  for (const block of conditionalBlocks(lines, cplusplus)) {
    for (let i = block.start + 1; i < block.end; i++) if (!block.arms.some(([a, b]) => i >= a && i <= b)) dead.add(i);
  }
  const out = new Map<string, MacroInfo>();
  const undefined_ = new Set<string>();
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    if (comment) {
      const end = line.indexOf("*/");
      if (end < 0) continue;
      line = " ".repeat(end + 2) + line.slice(end + 2);
      comment = false;
    }
    line = line.replace(/\/\*.*?\*\//g, (c) => " ".repeat(c.length));
    const open = line.indexOf("/*");
    if (open >= 0) {
      // A `/*` inside a line comment or a string opens nothing.
      const masked = blankStringLiterals(line, ["//"]);
      if (masked.indexOf("/*") === open) { line = line.slice(0, open); comment = true; }
    }
    if (!line.includes("#") || dead.has(i)) continue;
    const m = FUNCTION_LIKE.exec(line);
    const u = m ? null : UNDEF.exec(line);
    let end = i;
    // A directive continues while its line ends in `\`.
    while (lines[end]!.trimEnd().endsWith("\\") && end + 1 < lines.length) end++;
    if (u) {
      if (out.has(u[1]!)) undefined_.add(u[1]!);
    } else if (m && !out.has(m[1]!) && !bodies.some(([a, b]) => i + 1 > a && i + 1 <= b)) {
      const params = m[2]!.split(",").map((p) => p.trim()).filter(Boolean);
      out.set(m[1]!, { name: m[1]!, params, line: i + 1, endLine: end + 1 });
    }
    i = end;
  }
  for (const name of undefined_) out.get(name)!.fileScoped = true;
  return [...out.values()];
}
