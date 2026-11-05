import type { FileAnalysis, FunctionInfo } from "../../../types/analysis.js";

/**
 * Scala 3 extension methods:
 *
 * ```scala
 * extension (club: Club)
 *   def promote(): Unit = …      // club.promote()
 * extension [T](c: Car) { def tune(): Unit = … }
 * extension (c: Car) def wash(): Unit = …
 * ```
 *
 * The plugin reads each `def` as a free function; this pass gives every `def` an extension header owns the block's
 * parameter as its receiver (`isReceiver`, as Kotlin's `fun Club.promote()`), which is what lets the linker resolve
 * `club.promote()` on the type of `club`. The parameter stays a typed local of the body (`club.save()` inside it).
 */
const HEADER_RE = /^(\s*)extension\s*(?:\[[^\]]*\]\s*)?\(\s*(?:using\s+)?([A-Za-z_]\w*)\s*:\s*([^)]+?)\s*\)/;

export function applyScalaExtensions(analysis: FileAnalysis, raw: string): void {
  if (!raw.includes("extension")) return;
  const lines = raw.split(/\r?\n/);
  const indentOf = (s: string): number => s.length - s.trimStart().length;
  for (let i = 0; i < lines.length; i++) {
    const header = HEADER_RE.exec(lines[i]!);
    if (!header) continue;
    const [whole, lead, name, type] = header as unknown as [string, string, string, string];
    const rest = lines[i]!.slice(whole.length);
    let from = i + 1;
    let to = i + 1; // 1-based inclusive range of owned lines
    if (/\S/.test(rest.replace(/\/\/.*$/, ""))) {
      // `extension (c: Car) def wash() = …` or `extension (c: Car) { def a… }` on one line: the rest of this line,
      // and for a brace opened here the lines up to its match.
      to = from = i + 1;
      if (/\{\s*$/.test(rest.trim()) || rest.trim() === "{") to = braceEnd(lines, i);
    } else {
      let j = i + 1;
      while (j < lines.length && lines[j]!.trim() === "") j++;
      if (j >= lines.length) continue;
      if (lines[j]!.trim().startsWith("{")) {
        from = j + 1;
        to = braceEnd(lines, j);
      } else {
        const base = indentOf(lead);
        let k = j;
        while (k + 1 < lines.length && (lines[k + 1]!.trim() === "" || indentOf(lines[k + 1]!) > base)) k++;
        from = i + 2;
        to = k + 1;
      }
    }
    const owned: FunctionInfo[] = analysis.functions.filter((f) => f.line >= from && f.line <= to && !f.params.some((p) => p.isReceiver));
    if (owned.length === 0) continue;
    // Only the block's own members: a `def` nested in an extension method is a local one.
    const top = Math.min(...owned.map((f) => indentOf(lines[f.line - 1] ?? "")));
    for (const fn of owned) {
      if (indentOf(lines[fn.line - 1] ?? "") !== top && fn.line !== i + 1) continue;
      fn.params.unshift({ name: "this", type: type.trim(), defaultValue: null, isReceiver: true });
      (fn.localTypes ??= []).push({ name, type: type.trim() });
    }
  }
}

/** The 1-based line holding the `}` that closes the first `{` at or after line `start` (0-based). */
function braceEnd(lines: string[], start: number): number {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const c of lines[i]!.replace(/\/\/.*$/, "")) {
      if (c === "{") {
        depth++;
        opened = true;
      } else if (c === "}") depth--;
    }
    if (opened && depth <= 0) return i + 1;
  }
  return lines.length;
}
